import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, realpathSync, statSync, symlinkSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { createServer, connect } from 'node:net'
import { spawn, spawn as spawnProcess, spawnSync } from 'node:child_process'
import { gitGrepHits } from '../scripts/factory/absence.mjs'
import { parseCliArgs, pluginWriteMode, pluginWriteTargetMode, sameOrigin, hostGuard, ROUTE_PARAMS, ServerUsageError, startServer as startVisualizerServer, writeGuard } from '../visualizer/server/server.mjs'
import { createJournalSource } from '../visualizer/server/journal-source.mjs'
import * as webApi from '../visualizer/web/src/lib/api.js'
import { createAgentsSource, proposeAgent, proposePrompt, proposeSkills } from '../visualizer/server/agents-source.mjs'
import { normalizeSkillsPage } from '../visualizer/web/src/lib/agents.js'
import { ROOT, rawRequest, scratchDir, treeDigest } from './helpers.mjs'
const require = createRequire(import.meta.url)
const SKIP = false
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

test('RO1', () => {
  // MUTATION: invert the no-.git decision; this fake no-git checkout must refuse.
  const root = '/tmp/work', home = '/tmp/home'
  assert.deepEqual(pluginWriteMode({ pluginRoot:root, home, existsSync:() => false, realpathSync:(path) => path }), {
    writable:false, reason:'installed-plugin-read-only', basis:'no-git-work-tree', plugin_root:root,
  })
  assert.deepEqual(pluginWriteMode({ pluginRoot:`${home}/.claude/plugins/cache/pkg`, home, existsSync:() => true, realpathSync:(path) => path }), {
    writable:false, reason:'installed-plugin-read-only', basis:'under-claude-plugins-dir', plugin_root:`${home}/.claude/plugins/cache/pkg`,
  })
})
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
function serverRosterFixture() {
  const cell = (provider, id, agent, effort) => ({ provider, id, agent, effort })
  return {
    schema_version: 1,
    updated_at: '2026-08-30',
    tiers: {
      mechanical: {
        lead: null,
        planner: cell('anthropic', 'claude-opus-5-5', 'claude', 'medium'),
        builder: cell('openai', 'gpt-6-luna', 'pi', 'max'),
        reviewer: cell('openai', 'gpt-6.1-sol', 'pi', 'medium'),
      },
      build: {
        lead: cell('anthropic', 'claude-opus-5-5', 'claude', 'medium'),
        planner: cell('anthropic', 'claude-opus-5-5', 'claude', 'medium'),
        builder: cell('openai', 'gpt-6-luna', 'pi', 'max'),
        reviewer: cell('openai', 'gpt-6.1-sol', 'pi', 'high'),
      },
      judge: {
        lead: cell('anthropic', 'claude-opus-5-5', 'claude', 'high'),
        planner: cell('anthropic', 'claude-opus-5-5', 'claude', 'high'),
        builder: cell('openai', 'gpt-6-luna', 'pi', 'max'),
        reviewer: cell('anthropic', 'claude-opus-5-5', 'claude', 'xhigh'),
        'tech-lead': cell('openai', 'gpt-6.1-sol', 'pi', 'xhigh'),
      },
    },
    models: {
      'anthropic/claude-sonnet-5-5': { cost_in_per_mtok: 2, cost_out_per_mtok: 10, context: 1000000, tags: ['reasoning'], source: 'models.dev', last_verified: '2026-08-13' },
      'anthropic/claude-haiku-4-5': { cost_in_per_mtok: 1, cost_out_per_mtok: 5, context: 200000, tags: ['cheap'], source: 'models.dev', last_verified: '2026-08-13' },
      'anthropic/claude-opus-5-5': { cost_in_per_mtok: 5, cost_out_per_mtok: 25, context: 1000000, tags: ['reasoning'], source: 'models.dev', last_verified: '2026-08-13' },
      'openai/gpt-6.1-sol': { cost_in_per_mtok: 4, cost_out_per_mtok: 20, context: 1050000, tags: ['reasoning'], source: 'models.dev', last_verified: '2026-08-30' },
      'openai/gpt-5.6-terra': { cost_in_per_mtok: 2, cost_out_per_mtok: 12, context: 1050000, tags: ['review'], source: 'models.dev', last_verified: '2026-08-13' },
      'openai/gpt-6-luna': { cost_in_per_mtok: 0.2, cost_out_per_mtok: 1.2, context: 1050000, tags: ['coding'], source: 'models.dev', last_verified: '2026-08-13' },
      'anthropic/claude-fable-5': { cost_in_per_mtok: 10, cost_out_per_mtok: 50, context: 1000000, tags: ['override-only'], source: 'models.dev', last_verified: '2026-08-13' },
    },
  }
}
function agentsFixture(prefix = 'visualizer-agents-') {
  const dir = scratchDir(prefix)
  const checkout = join(dir, 'checkout'), crewRoot = join(dir, 'crew-root')
  mkdirSync(join(checkout, 'crew', 'roles'), { recursive: true })
  mkdirSync(join(checkout, 'skills'), { recursive: true })
  const capabilities = {
    schema_version: 1,
    updated_at: '2026-09-15',
    coding_agents: {
      pi: {
        providers: ['openai'], transports: ['pane', 'headless-rpc'], adapter: 'crew/adapters/adapter-pi.mjs', refuses: ['mcp_servers'],
        display_name: 'Pi', binary: 'pi', install_hint: 'Install Pi.', availability: 'discovered-unavailable', availability_reason: 'version-spawn-failed',
      },
      claude: {
        providers: ['anthropic'], transports: ['pane', 'headless-json'], adapter: 'crew/adapters/adapter-claude.mjs', refuses: ['skills'],
        display_name: 'Claude Code', binary: 'claude', install_hint: 'Install Claude Code.', availability: 'executable', availability_reason: 'executable',
      },
    },
    roles: Object.fromEntries(['lead', 'planner', 'builder', 'reviewer', 'tech-lead'].map((role) => [role, { tools: [], extensions: [], agents: [], skills: [], advisor: false, requires: [], mcp_servers: [] }])),
    local_providers: {},
  }
  const capabilitiesPath = join(checkout, 'crew', 'capabilities.json')
  writeFileSync(capabilitiesPath, JSON.stringify(capabilities, null, 2) + '\n')
  const skillNames = ['backend-node', 'crew-dispatch', 'crew-onboard', 'crew-recovery', 'devops', 'frontend-svelte', 'pr-review', 'qa-test-writing', 'ui-design']
  for (const name of skillNames) { mkdirSync(join(checkout, 'skills', name), { recursive: true }); writeFileSync(join(checkout, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture description for ${name}.\n---\n\n# ${name}\n`) }
  for (const role of ['_shared', 'lead', 'planner', 'builder', 'reviewer', 'tech-lead']) writeFileSync(join(checkout, 'crew', 'roles', `${role}.md`), `# ${role}\nFixture charter for ${role}.\n`)
  const lane = join(crewRoot, 'dt-agents-fixture', 'fixture-task'), task = join(lane, 'task')
  mkdirSync(join(task, 'headless', 'builder'), { recursive: true })
  mkdirSync(join(task, 'headless-rpc', 'builder'), { recursive: true })
  mkdirSync(join(task, 'headless-json', 'planner'), { recursive: true })
  const oldCommand = join(task, 'headless', 'builder', 'cmd.json')
  const newCommand = join(task, 'headless-rpc', 'builder', 'cmd.json')
  writeFileSync(oldCommand, JSON.stringify({ args: ['pi', '--skill', 'skills/old-skill/SKILL.md'] }))
  writeFileSync(newCommand, JSON.stringify({ args: ['pi', '--skill', 'skills/frontend-svelte/SKILL.md'] }))
  utimesSync(oldCommand, new Date(1000), new Date(1000)); utimesSync(newCommand, new Date(2000), new Date(2000))
  writeFileSync(join(task, 'headless-json', 'planner', 'cmd.json'), JSON.stringify({ command: 'pi --skill skills/ui-design/SKILL.md' }))
  writeFileSync(join(lane, 'journal.jsonl'), [
    JSON.stringify({ at: '2026-09-14T00:00:00.000Z', event: 'boot', charter_bytes: { builder: 10, planner: 11 } }),
    JSON.stringify({ at: '2026-09-15T00:00:00.000Z', event: 'boot', charter_bytes: { builder: 20, planner: 21 } }),
  ].join('\n') + '\n')
  writeFileSync(join(task, 'role-builder.md'), '# compiled builder\n')
  writeFileSync(join(task, 'role-planner.md'), '# compiled planner\n')
  return { dir, checkout, crewRoot, capabilitiesPath, lane, task, skillNames }
}

function rawStatus(response) {
  return Number((response.text.match(/^HTTP\/1\.1 (\d{3})/) || [])[1] || 0)
}
function rawJson(response) {
  const [, body = ''] = response.text.split('\r\n\r\n', 2)
  return JSON.parse(body)
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

test('raw request targets are refused without killing the visualizer', { skip: SKIP }, async () => {
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

test('raw Host values are refused without killing the visualizer', { skip: SKIP }, async () => {
  for (const hostValue of [']bad[', 'a:b:c', '%', 'ho st', '[::1', '@', 'x:99999999', 'a b']) {
    const dir = mkdtempSync(join(tmpdir(), 'visualizer-raw-host-'))
    let server
    try {
      server = await startServer(join(dir, 'ledger.db'), join(dir, 'visualizer.db'))
      const port = Number(new URL(server.base).port)
      const hostile = await rawRequest({ port, requestLine: 'GET /api/health HTTP/1.1', headers: [`Host: ${hostValue}`, 'connection: close'] })
      assert.equal(rawStatus(hostile), 400)
      const after = await rawRequest({ port, requestLine: 'GET /api/health HTTP/1.1', headers: [`Host: 127.0.0.1:${port}`, 'connection: close'] })
      assert.equal(rawStatus(after), 200)
      assert.equal(server.child.exitCode, null)
    } finally {
      if (server) await stopServer(server.child)
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

const WRITE_ROUTES = [
  { path: '/api/agents/propose', body: JSON.stringify({ name: 'future-agent', entry: {} }) },
  { path: '/api/skills/propose', body: JSON.stringify({ role: 'builder', skills: [] }) },
  { path: '/api/prompts/propose', body: JSON.stringify({ role: 'builder', text: 'proposal' }) },
]

test('state-writing routes refuse CORS simple requests before reading the body', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-cors-simple-'))
  const checkout = join(dir, 'checkout')
  mkdirSync(checkout, { recursive: true })
  let server
  try {
    server = await startServer(join(dir, 'ledger.db'), join(dir, 'visualizer.db'), null, null, { DEVTEAM_INTAKE_CHECKOUT: checkout })
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

test('state-writing routes refuse foreign JSON origins before writing state', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visualizer-cors-origin-'))
  const checkout = join(dir, 'checkout')
  mkdirSync(checkout, { recursive: true })
  let server
  try {
    server = await startServer(join(dir, 'ledger.db'), join(dir, 'visualizer.db'), null, null, { DEVTEAM_INTAKE_CHECKOUT: checkout })
    const port = Number(new URL(server.base).port)
    for (const route of WRITE_ROUTES) {
      const response = await rawRequest({
        port,
        requestLine: `POST ${route.path} HTTP/1.1`,
        headers: [`Host: 127.0.0.1:${port}`, 'content-type: application/json', 'Origin: https://evil.example', `content-length: ${Buffer.byteLength(route.body)}`, 'connection: close'],
        body: route.body,
      })
      assert.equal(rawStatus(response), 403)
    }
    assert.equal(existsSync(join(checkout, '.factory', 'STOP')), false)
  } finally {
    if (server) await stopServer(server.child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('B1 agents page proposal endpoints are diff-only', async () => {
  const fixture = agentsFixture('visualizer-agents-proposals-')
  const source = createAgentsSource({ checkout: fixture.checkout, crewRoot: fixture.crewRoot })
  const checkoutBefore = treeDigest(fixture.checkout), crewBefore = treeDigest(fixture.crewRoot)
  let server
  try {
    server = await startInProcess({}, { checkout: fixture.checkout, crewRoot: fixture.crewRoot, agents: source, ledgerDb: join(fixture.dir, 'ledger.db'), triageDb: join(fixture.dir, 'triage.db') })
    const view = await json(server.base, '/api/agents')
    assert.equal(view.status, 200)
    assert.equal(view.json.agents.length, 2)
    assert.equal(view.json.agents.find((agent) => agent.name === 'pi').availability.value, 'discovered-unavailable')
    assert.equal(view.json.agents.find((agent) => agent.name === 'pi').install_hint.value, 'Install Pi.')
    assert.equal(view.json.skills.length, 9)
    assert.equal(view.json.roles.length, 5)
    assert.equal(view.json.prompts.length, 6)
    assert.equal(view.json.roles.find((row) => row.role === 'builder').cells['frontend-svelte'].last_seat_delivery, true)
    const post = (path, body) => json(server.base, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const agent = await post('/api/agents/propose', { name: 'future-agent', entry: { providers: ['openai'], transports: ['pane'], adapter: 'crew/adapters/adapter-future-agent.mjs', refuses: [], availability: 'proposal-stub' } })
    assert.equal(agent.status, 200); assert.equal(agent.json.ok, true); assert.ok(agent.json.diff); assert.deepEqual(agent.json.refusals, []); assert.equal(Object.hasOwn(agent.json, 'target_path'), false); assert.equal(Object.hasOwn(agent.json, 'after_text'), false)
    const skills = await post('/api/skills/propose', { role: 'builder', skills: ['frontend-svelte'] })
    assert.equal(skills.status, 200); assert.equal(skills.json.ok, true); assert.match(skills.json.diff, /crew\/capabilities\.json/); assert.deepEqual(skills.json.refusals, [])
    const prompt = await post('/api/prompts/propose', { role: 'builder', text: '# replacement charter\n' })
    assert.equal(prompt.status, 200); assert.equal(prompt.json.ok, true); assert.match(prompt.json.diff, /crew\/roles\/builder\.md/); assert.deepEqual(prompt.json.refusals, []); assert.deepEqual(prompt.json.labels, ['protected: prompt-surface'])
    assert.equal(treeDigest(fixture.checkout), checkoutBefore)
    assert.equal(treeDigest(fixture.crewRoot), crewBefore)
    for (const [path, body] of [['/api/agents/propose', '{ not json'], ['/api/skills/propose', JSON.stringify({ role: 'builder', skills: 'frontend-svelte' })], ['/api/prompts/propose', JSON.stringify({ role: 'builder' })]]) {
      const response = await json(server.base, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      assert.equal(response.status, 400, path)
    }
    assert.equal((await json(server.base, '/api/agents/propose?unknown=1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400)
    const deniedError = Object.assign(new Error('permission denied'), { code: 'EPERM' })
    const denied = proposeAgent({ checkout: fixture.checkout, name: 'denied', entry: {}, readFileSync: () => { throw deniedError } })
    assert.equal(denied.ok, false); assert.ok(denied.refusals[0].message)
    const empty = proposeSkills({ checkout: fixture.checkout, role: 'builder', skills: [], readFileSync: () => '', readdirSync: () => [] })
    assert.equal(empty.ok, false); assert.ok(empty.refusals[0].message)
  } finally {
    if (server) await stopInProcess(server)
  }
})

test('skills-page:A1', async () => {
  const fixture = agentsFixture('visualizer-skills-inventory-')
  const source = createAgentsSource({ checkout: fixture.checkout, crewRoot: fixture.crewRoot })
  let server
  try {
    server = await startInProcess({}, { checkout: fixture.checkout, crewRoot: fixture.crewRoot, agents: source, ledgerDb: join(fixture.dir, 'ledger.db'), triageDb: join(fixture.dir, 'triage.db') })
    const response = await json(server.base, '/api/agents')
    assert.equal(response.status, 200)
    const expected = fixture.skillNames.map((name) => ({
      name,
      description: `Fixture description for ${name}.`,
      content: readFileSync(join(fixture.checkout, 'skills', name, 'SKILL.md'), 'utf8'),
    }))
    assert.deepEqual(response.json.skills.map(({ name, description, content }) => ({ name, description, content })), expected)
    const page = normalizeSkillsPage(response.json)
    assert.deepEqual(page.rows.map(({ name, description, content }) => ({ name, description, content })), expected)
  } finally {
    if (server) await stopInProcess(server)
  }
})

test('skills-page:B1', () => {
  const fixture = agentsFixture('visualizer-skills-holders-')
  const capabilities = JSON.parse(readFileSync(fixture.capabilitiesPath, 'utf8'))
  delete capabilities.roles
  writeFileSync(fixture.capabilitiesPath, `${JSON.stringify(capabilities, null, 2)}\n`)
  const source = createAgentsSource({ checkout: fixture.checkout, crewRoot: fixture.crewRoot })
  const page = normalizeSkillsPage(source.read())
  assert.equal(page.rows.length, fixture.skillNames.length)
  for (const row of page.rows) {
    assert.equal(row.holders.measured, false)
    assert.equal(row.holders.value, null)
    assert.equal(typeof row.holders.reason, 'string')
    assert.ok(row.holders.reason.length > 0)
    assert.notDeepEqual(row.holders.value, [])
  }
})

test('skills-page:C1', async () => {
  const fixture = agentsFixture('visualizer-skills-proposal-')
  const source = createAgentsSource({ checkout: fixture.checkout, crewRoot: fixture.crewRoot })
  const checkoutBefore = treeDigest(fixture.checkout), crewBefore = treeDigest(fixture.crewRoot)
  let server
  try {
    server = await startInProcess({}, { checkout: fixture.checkout, crewRoot: fixture.crewRoot, agents: source, ledgerDb: join(fixture.dir, 'ledger.db'), triageDb: join(fixture.dir, 'triage.db') })
    const response = await json(server.base, '/api/skills/propose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'builder', skills: ['frontend-svelte'] }) })
    assert.equal(response.status, 200)
    assert.equal(response.json.ok, true)
    assert.match(response.json.diff, /capabilities\.json/)
    assert.equal(Object.hasOwn(response.json, 'target_path'), false)
    assert.equal(Object.hasOwn(response.json, 'after_text'), false)
    assert.equal(treeDigest(fixture.checkout), checkoutBefore)
    assert.equal(treeDigest(fixture.crewRoot), crewBefore)
  } finally {
    if (server) await stopInProcess(server)
  }
})

test('prompts-page:C1', async () => {
  const fixture = agentsFixture('visualizer-prompts-page-')
  const source = createAgentsSource({ checkout: fixture.checkout, crewRoot: fixture.crewRoot })
  const checkoutBefore = treeDigest(fixture.checkout), crewBefore = treeDigest(fixture.crewRoot)
  let server
  try {
    server = await startInProcess({}, { checkout: fixture.checkout, crewRoot: fixture.crewRoot, agents: source, ledgerDb: join(fixture.dir, 'ledger.db'), triageDb: join(fixture.dir, 'triage.db') })
    const view = await json(server.base, '/api/agents')
    assert.equal(view.status, 200)
    assert.deepEqual(view.json.prompts.map((prompt) => prompt.role), ['_shared', 'lead', 'planner', 'builder', 'reviewer', 'tech-lead'])
    assert.equal(view.json.prompts.length, 6)
    for (const prompt of view.json.prompts) {
      if (prompt.recipients === null) {
        assert.equal(typeof prompt.recipients_reason, 'string')
        assert.ok(prompt.recipients_reason.trim().length > 0)
      } else {
        assert.ok(Array.isArray(prompt.recipients) && prompt.recipients.length > 0 && prompt.recipients.every((recipient) => typeof recipient === 'string' && recipient.trim()))
        assert.equal(prompt.recipients_reason, null)
      }
    }
    const response = await json(server.base, '/api/prompts/propose', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'builder', text: '# replacement charter\\n' }),
    })
    assert.equal(response.status, 200)
    assert.equal(response.json.ok, true)
    assert.match(response.json.diff, /crew\/roles\/builder\.md/)
    assert.deepEqual(response.json.labels, ['protected: prompt-surface'])
    assert.equal(treeDigest(fixture.checkout), checkoutBefore)
    assert.equal(treeDigest(fixture.crewRoot), crewBefore)
    for (const body of ['{ not json', JSON.stringify({ role: 'builder' })]) {
      const malformed = await json(server.base, '/api/prompts/propose', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      assert.equal(malformed.status, 400)
    }
  } finally {
    if (server) await stopInProcess(server)
  }
})

test('D1 agents page labels prompt proposals protected', async () => {
  const fixture = agentsFixture('visualizer-agents-prompts-')
  const source = createAgentsSource({ checkout: fixture.checkout, crewRoot: fixture.crewRoot })
  const before = treeDigest(fixture.checkout)
  let server
  try {
    server = await startInProcess({}, { checkout: fixture.checkout, crewRoot: fixture.crewRoot, agents: source, ledgerDb: join(fixture.dir, 'ledger.db'), triageDb: join(fixture.dir, 'triage.db') })
    const response = await json(server.base, '/api/prompts/propose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'builder', text: '# changed\n' }) })
    assert.equal(response.status, 200)
    assert.deepEqual(response.json.labels, ['protected: prompt-surface'])
    assert.match(response.json.diff, /^--- a\/crew\/roles\/builder\.md$/m)
    assert.match(response.json.diff, /^\+\+\+ b\/crew\/roles\/builder\.md$/m)
    assert.equal(treeDigest(fixture.checkout), before)
  } finally {
    if (server) await stopInProcess(server)
  }
})

test('the visualizer CLI announces a port through a symlinked repository path', { skip: SKIP }, async () => {
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

test('the deleted usage absence cause is absent from visualizer and present in scripts', () => {
  const needle = 'predates per-agent token measurement'
  const visualizer = gitGrepHits({ needle, paths: ['visualizer/'], cwd: ROOT })
  const scripts = gitGrepHits({ needle, paths: ['scripts/'], cwd: ROOT })
  assert.equal(visualizer.count, 0)
  assert.ok(scripts.count > 0)
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
    const result = runServerCli(['--port', String(port)])
    assert.equal(result.status, 1, result.stderr || result.error?.message)
  } finally {
    await new Promise((resolve) => blocker.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('D1a OpenRouter failure serves AA-only rows with absence', async () => {
  let handles
  try {
    handles = await startInProcess({}, {
      openRouterCatalog: { get:async () => ({ configured:true, source:'OpenRouter', source_url:'https://openrouter.ai/api/v1/models', models:null, absent:'OpenRouter unavailable' }) },
      modelCatalog: { get:async () => ({ configured:true, credential_source:'environment', source:'Artificial Analysis', source_url:'https://artificialanalysis.ai/', models:[{ source_id:'aa-only', name:'AA Only', slug:'aa-only', family_name:'AA Only', family_slug:'aa-only', creator:'Example', creator_id:'example', provider_hint:'example', runtime_id_hint:'aa/runtime', intelligence:73, coding:null, agentic:null, price_input:4, price_output:8, context_window_tokens:32768 }], absent:null }) },
    })
    const result = await json(handles.base, '/api/model-catalog')
    assert.equal(result.status, 200)
    assert.deepEqual(result.json.join, { matched:0, total:0 })
    assert.equal(result.json.absent, 'OpenRouter unavailable')
    assert.equal(result.json.models.length, 1)
    assert.equal(result.json.models[0].runtime_id, null)
    assert.equal(result.json.models[0].intelligence, 73)
    assert.equal(result.json.models[0].score_absent_reason, 'no-runtime-listing')
  } finally {
    if (handles) await stopInProcess(handles.server)
  }
})

test('D1b absent AA key serves OpenRouter rows as aa-unconfigured', async () => {
  let handles
  try {
    handles = await startInProcess({}, {
      openRouterCatalog: { get:async () => ({ configured:true, source:'OpenRouter', source_url:'https://openrouter.ai/api/v1/models', models:[{ source_id:'meta/muse-spark-1.3', runtime_id:'meta/muse-spark-1.3', name:'Muse Spark 1.3', slug:'muse-spark-1.3', family_name:'Muse Spark 1.3', family_slug:'muse-spark-1.3', creator:'Meta', creator_id:'meta', provider_hint:'meta', price_input:0.1, price_output:0.2, context_length:131072, context_window_tokens:131072 }], absent:null }) },
      modelCatalog: { get:async () => ({ configured:false, credential_source:null, source:'Artificial Analysis', source_url:'https://artificialanalysis.ai/', models:null, absent:'Add an Artificial Analysis API key to load current benchmark data.' }) },
    })
    const result = await json(handles.base, '/api/model-catalog')
    assert.equal(result.status, 200)
    assert.deepEqual(result.json.join, { matched:0, total:1 })
    assert.equal(result.json.models.length, 1)
    assert.equal(result.json.models[0].runtime_id, 'meta/muse-spark-1.3')
    assert.equal(result.json.models[0].intelligence, null)
    assert.equal(result.json.models[0].score_absent_reason, 'aa-unconfigured')
    assert.equal(result.json.absent, 'Add an Artificial Analysis API key to load current benchmark data.')
  } finally {
    if (handles) await stopInProcess(handles.server)
  }
})

test('the model catalog endpoint persists a key only when explicitly requested', async () => {
  const dir = scratchDir('visualizer-catalog-env-')
  const envFile = join(dir, '.env.local')
  let handles
  try {
    handles = await startInProcess({}, {
      envFile,
      fetchImpl:async () => new Response(JSON.stringify({ tier:'free', intelligence_index_version:4.1, pagination:{ has_more:false }, data:[] }), { status:200, headers:{ 'content-type':'application/json' } }),
      openRouterCatalog:{ get:async () => ({ configured:true, source:'OpenRouter', source_url:'https://openrouter.ai/api/v1/models', models:[], absent:null }) },
    })
    const saved = await json(handles.base, '/api/model-catalog/key', {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ api_key:'saved-catalog-secret', persist:true }),
    })
    assert.equal(saved.status, 200)
    assert.equal(saved.json.persisted, true)
    assert.equal(saved.json.credential_source, 'environment')
    assert.doesNotMatch(saved.body, /saved-catalog-secret/)
    assert.match(readFileSync(envFile, 'utf8'), /^ARTIFICIAL_ANALYSIS_API_KEY="saved-catalog-secret"\n$/)

    const temporary = await json(handles.base, '/api/model-catalog/key', {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ api_key:'temporary-catalog-secret', persist:false }),
    })
    assert.equal(temporary.json.persisted, false)
    assert.equal(temporary.json.credential_source, 'session')
    assert.doesNotMatch(temporary.body, /temporary-catalog-secret/)
    assert.doesNotMatch(readFileSync(envFile, 'utf8'), /temporary-catalog-secret/)

    const restored = await json(handles.base, '/api/model-catalog/key', {
      method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ api_key:null }),
    })
    assert.equal(restored.json.credential_source, 'environment')
  } finally {
    if (handles) await stopInProcess(handles.server)
    rmSync(dir, { recursive:true, force:true })
  }
})

test('static responses refuse symlinks that leave web/dist', { skip: SKIP }, async () => {
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
test('V1 agents resources come from the plugin root for a foreign checkout', async () => {
  const root = scratchDir('visualizer-foreign-agents-')
  let server
  try {
    assert.equal(spawnSync('git', ['init', root], { encoding: 'utf8' }).status, 0)
    server = await startInProcess({ close() {} }, { checkout: root, ledgerDb: join(root, 'ledger.db'), triageDb: join(root, 'triage.db'), crewRoot: join(root, 'runtime') })
    const agents = await json(server.base, '/api/agents')
    // Mutation: omit pluginRoot from the agents-source construction.
    assert.ok(agents.json.agents.length > 0)
    assert.ok(agents.json.skills.some((skill) => skill.path === 'skills/code-less/SKILL.md'))
    assert.equal(agents.json.plugin_root, ROOT)
    assert.equal(agents.json.checkout, root)
    assert.equal(agents.json.prompts.find((prompt) => prompt.role === 'builder')?.path, 'crew/roles/builder.md')
    assert.equal(agents.json.reasons.some((reason) => reason.includes(root)), false)
  } finally {
    if (server) await stopInProcess(server)
  }
})

test('V4 prompt proposal reads the target checkout, not plugin resources', async () => {
  const root = scratchDir('visualizer-foreign-prompt-')
  let server
  try {
    assert.equal(spawnSync('git', ['init', root], { encoding: 'utf8' }).status, 0)
    server = await startInProcess({ close() {} }, { checkout: root, ledgerDb: join(root, 'ledger.db'), triageDb: join(root, 'triage.db'), crewRoot: join(root, 'runtime') })
    // Mutation: change only the prompt proposal wrapper to checkout: resourcesRoot.
    const prompt = await json(server.base, '/api/prompts/propose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'builder', text: '# replacement\n' }) })
    assert.equal(prompt.status, 200)
    assert.equal(prompt.json.ok, false)
    assert.equal(prompt.json.refusals[0].code, 'read-unavailable')
    assert.ok(prompt.json.refusals[0].message.includes(join(root, 'crew', 'roles', 'builder.md')))
  } finally {
    if (server) await stopInProcess(server)
  }
})

test('agents source separates plugin reads from target proposals compatibly', () => {
  const target = agentsFixture('visualizer-agents-target-root-')
  const plugin = agentsFixture('visualizer-agents-plugin-root-')
  const path = require('node:path')
  const fs = require('node:fs')
  try {
    const checkoutOnly = createAgentsSource({ checkout: target.checkout, crewRoot: target.crewRoot }).read()
    assert.equal(checkoutOnly.plugin_root, path.resolve(target.checkout))
    assert.equal(checkoutOnly.checkout, path.resolve(target.checkout))
    assert.equal(checkoutOnly.prompts.find((row) => row.role === 'builder').text, '# builder\nFixture charter for builder.\n')

    writeFileSync(join(plugin.checkout, 'crew', 'roles', 'builder.md'), '# PLUGIN-ONLY builder charter\n')
    const pluginCapabilities = JSON.parse(readFileSync(join(plugin.checkout, 'crew', 'capabilities.json'), 'utf8'))
    pluginCapabilities.coding_agents.pi.adapter = 'crew/adapters/PLUGIN-ONLY-pi.mjs'
    writeFileSync(join(plugin.checkout, 'crew', 'capabilities.json'), `${JSON.stringify(pluginCapabilities, null, 2)}\n`)
    mkdirSync(join(plugin.checkout, 'skills', 'plugin-only-skill'), { recursive: true })
    writeFileSync(join(plugin.checkout, 'skills', 'plugin-only-skill', 'SKILL.md'), '---\nname: plugin-only-skill\ndescription: Plugin-only skill.\n---\n\nPLUGIN-ONLY skill body\n')
    const source = createAgentsSource({ checkout: target.checkout, pluginRoot: plugin.checkout, crewRoot: target.crewRoot })
    const read = source.read()
    assert.equal(read.agents.find((agent) => agent.name === 'pi').adapter, 'crew/adapters/PLUGIN-ONLY-pi.mjs')
    assert.ok(read.skills.some((skill) => skill.path === 'skills/plugin-only-skill/SKILL.md' && skill.content.includes('PLUGIN-ONLY skill body')))
    assert.equal(read.prompts.find((row) => row.role === 'builder').text, '# PLUGIN-ONLY builder charter\n')
    assert.equal(read.prompts.find((row) => row.role === 'builder').path, 'crew/roles/builder.md')
    assert.equal(read.checkout, path.resolve(target.checkout))
    assert.equal(read.plugin_root, path.resolve(plugin.checkout))
    assert.equal(read.crew_root, path.resolve(target.crewRoot))

    const prompt = source.proposePrompt({ role: 'builder', text: '# proposed target charter\n' })
    assert.equal(prompt.ok, true)
    assert.equal(prompt.target_path, join(target.checkout, 'crew', 'roles', 'builder.md'))
    assert.match(prompt.diff, /Fixture charter for builder/)
    assert.doesNotMatch(prompt.diff, /PLUGIN-ONLY builder charter/)
    const agent = source.proposeAgent({ name: 'future-agent', entry: { providers: ['openai'], transports: ['pane'], adapter: 'crew/adapters/adapter-future-agent.mjs', refuses: [], availability: 'proposal-stub' } })
    assert.equal(agent.ok, true)
    assert.equal(agent.target_path, join(target.checkout, 'crew', 'capabilities.json'))
    assert.equal(JSON.parse(agent.after_text).coding_agents.pi.display_name, 'Pi')
    const skills = source.proposeSkills({ role: 'builder', skills: ['frontend-svelte'] })
    assert.equal(skills.ok, true)
    assert.equal(skills.target_path, join(target.checkout, 'crew', 'capabilities.json'))
    assert.deepEqual(JSON.parse(skills.after_text).roles.builder.skills, ['frontend-svelte'])
    assert.equal(fs.existsSync(join(target.checkout, 'skills', 'plugin-only-skill')), false)
  } finally {
    rmSync(target.dir, { recursive: true, force: true })
    rmSync(plugin.dir, { recursive: true, force: true })
  }
})

test('RO1 symlinked plugins dir', () => {
  const dir = realpathSync(scratchDir('visualizer-plugin-symlink-'))
  try {
    const home = join(dir, 'home'), store = join(dir, 'store'), installed = join(store, 'cache', 'dev-team', '1.0.0')
    mkdirSync(join(installed, '.git'), { recursive:true })
    mkdirSync(join(home, '.claude'), { recursive:true })
    symlinkSync(store, join(home, '.claude', 'plugins'), 'dir')
    assert.deepEqual(pluginWriteMode({ pluginRoot:join(home, '.claude', 'plugins', 'cache', 'dev-team', '1.0.0'), home }), {
      writable:false, reason:'installed-plugin-read-only', basis:'under-claude-plugins-dir', plugin_root:installed,
    })
  } finally { rmSync(dir, { recursive:true, force:true }) }
})

function pluginWriteServerFixture(prefix) {
  const dir = realpathSync(scratchDir(prefix))
  const pluginRoot = join(dir, 'plugin'), home = join(dir, 'home'), rosterPath = join(dir, 'roster.json'), envFile = join(dir, '.env.local')
  mkdirSync(pluginRoot, { recursive:true })
  mkdirSync(home, { recursive:true })
  writeFileSync(rosterPath, JSON.stringify(serverRosterFixture(), null, 2))
  const reviewer = serverRosterFixture().tiers.build.reviewer
  const move = { tier:'build', role:'reviewer', cell:{ ...reviewer, effort:reviewer.effort === 'high' ? 'xhigh' : 'high' } }
  const options = {
    pluginRoot, home, rosterPath, envFile, ledgerDb:join(dir, 'ledger.db'), triageDb:join(dir, 'triage.db'), crewRoot:dir,
    fetchImpl:async () => new Response(JSON.stringify({ tier:'free', intelligence_index_version:4.1, pagination:{ has_more:false }, data:[] }), { status:200, headers:{ 'content-type':'application/json' } }),
    openRouterCatalog:{ get:async () => ({ configured:true, source:'OpenRouter', source_url:'https://openrouter.ai/api/v1/models', models:[], absent:null }) },
  }
  const refusal = { schema:2, error:'This plugin runs from an installed, version-pinned copy whose edits the next plugin update would overwrite.', reason:'installed-plugin-read-only', basis:'no-git-work-tree', plugin_root:pluginRoot }
  return { dir, rosterPath, envFile, move, options, refusal }
}
const postJson = (input) => ({ method:'POST', headers:{ 'content-type':'application/json' }, body:typeof input === 'string' ? input : JSON.stringify(input) })

// MUTATION: delete the ladder/apply `if (!writeMode.writable) return json(res, 409, pluginWriteRefusal)` guard;
// the apply then reaches the roster writer (or the body parser) and this test reddens.
test('RO4 installed plugin refuses a persistent catalog key and keeps session and null-clear keys', async () => {
  const { dir, envFile, options, refusal } = pluginWriteServerFixture('visualizer-plugin-key-')
  let handles
  try {
    handles = await startInProcess({}, options)
    const persisted = await json(handles.base, '/api/model-catalog/key', postJson({ api_key:'installed-catalog-secret', persist:true }))
    assert.deepEqual({ status:persisted.status, ...persisted.json }, { status:409, ...refusal })
    assert.equal(existsSync(envFile), false)
    const session = await json(handles.base, '/api/model-catalog/key', postJson({ api_key:'installed-catalog-secret', persist:false }))
    assert.equal(session.status, 200)
    assert.equal(session.json.persisted, false)
    const cleared = await json(handles.base, '/api/model-catalog/key', postJson({ api_key:null, persist:true }))
    assert.equal(cleared.status, 200)
    assert.equal(existsSync(envFile), false)
  } finally {
    if (handles) await stopInProcess(handles.server)
    rmSync(dir, { recursive:true, force:true })
  }
})

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

test('RO1 filesystem root link target refuses writes', () => {
  const home = '/tmp/root-home'
  const cache = join(home, '.claude', 'plugins', 'cache')
  const dirs = new Map([[cache, ['m']], [join(cache, 'm'), ['p']], [join(cache, 'm', 'p'), ['1.0.0']], [join(cache, 'm', 'p', '1.0.0'), ['.claude-plugin-link']]])
  const marker = JSON.stringify({target: '/'})
  const fakeReaddir = (p) => { if (dirs.has(p)) return dirs.get(p); const err = new Error('ENOENT ' + p); err.code = 'ENOENT'; throw err }
  const fakeRead = (p) => { if (String(p).endsWith('.claude-plugin-link')) return marker; throw new Error('ENOENT ' + p) }
  const fakeExists = () => true
  const fakeRealpath = (p) => p
  assert.deepEqual(pluginWriteMode({pluginRoot: '/tmp/checkout', home, existsSync: fakeExists, realpathSync: fakeRealpath, readdirSync: fakeReaddir, readFileSync: fakeRead}), {
    writable: false, reason: 'installed-plugin-read-only', basis: 'link-mode-install-target', plugin_root: '/tmp/checkout'
  })
})

test('RO1 malformed link marker fails closed', () => {
  const home = '/tmp/malformed-home'
  const cache = join(home, '.claude', 'plugins', 'cache')
  const dirs = new Map([[cache, ['m']], [join(cache, 'm'), ['p']], [join(cache, 'm', 'p'), ['1.0.0']], [join(cache, 'm', 'p', '1.0.0'), ['.claude-plugin-link']]])
  const marker = '{bad json'
  const fakeReaddir = (p) => { if (dirs.has(p)) return dirs.get(p); const err = new Error('ENOENT ' + p); err.code = 'ENOENT'; throw err }
  const fakeRead = (p) => { if (String(p).endsWith('.claude-plugin-link')) return marker; throw new Error('ENOENT ' + p) }
  const fakeExists = () => true
  const fakeRealpath = (p) => p
  assert.deepEqual(pluginWriteMode({pluginRoot: '/tmp/checkout', home, existsSync: fakeExists, realpathSync: fakeRealpath, readdirSync: fakeReaddir, readFileSync: fakeRead}), {
    writable: false, reason: 'installed-plugin-read-only', basis: 'link-mode-marker-unreadable', plugin_root: '/tmp/checkout'
  })
})

test('RO1 unresolvable link target fails closed', () => {
  const home = '/tmp/unresolvable-home'
  const cache = join(home, '.claude', 'plugins', 'cache')
  const dirs = new Map([[cache, ['m']], [join(cache, 'm'), ['p']], [join(cache, 'm', 'p'), ['1.0.0']], [join(cache, 'm', 'p', '1.0.0'), ['.claude-plugin-link']]])
  const marker = JSON.stringify({target: '/tmp/unresolvable-target'})
  const fakeReaddir = (p) => { if (dirs.has(p)) return dirs.get(p); const err = new Error('ENOENT ' + p); err.code = 'ENOENT'; throw err }
  const fakeRead = (p) => { if (String(p).endsWith('.claude-plugin-link')) return marker; throw new Error('ENOENT ' + p) }
  const fakeExists = () => true
  const fakeRealpath = (p) => { if (p === '/tmp/unresolvable-target') { const err = new Error('ENOENT ' + p); err.code = 'ENOENT'; throw err } return p }
  assert.deepEqual(pluginWriteMode({pluginRoot: '/tmp/checkout', home, existsSync: fakeExists, realpathSync: fakeRealpath, readdirSync: fakeReaddir, readFileSync: fakeRead}), {
    writable: false, reason: 'installed-plugin-read-only', basis: 'link-mode-marker-unreadable', plugin_root: '/tmp/checkout'
  })
})

test('RO1 marker-absent checkout stays writable', () => {
  const home = '/tmp/clean-home'
  const fakeReaddir = (p) => { const err = new Error('ENOENT ' + p); err.code = 'ENOENT'; throw err }
  const fakeRead = (p) => { throw new Error('ENOENT ' + p) }
  const fakeExists = () => true
  const fakeRealpath = (p) => p
  assert.deepEqual(pluginWriteMode({pluginRoot: '/tmp/checkout', home, existsSync: fakeExists, realpathSync: fakeRealpath, readdirSync: fakeReaddir, readFileSync: fakeRead}), {
    writable: true, reason: null, basis: null, plugin_root: '/tmp/checkout'
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

test('pluginWriteTargetMode resolves a missing-parent symlink ancestor into the plugin cache', () => {
  const home = '/tmp/ancestor-home'
  const cacheTarget = join(home, '.claude', 'plugins', 'cache', 'm', 'p', '1')
  const fakeRealpath = (p) => {
    if (p === '/work/cache-alias') return cacheTarget
    if (p === '/work/cache-alias/new' || p === '/work/cache-alias/new/.env.local') { const err = new Error('ENOENT ' + p); err.code = 'ENOENT'; throw err }
    return p
  }
  const fakeReaddir = (p) => { const err = new Error('ENOENT ' + p); err.code = 'ENOENT'; throw err }
  const fakeRead = (p) => { throw new Error('ENOENT ' + p) }
  const fakeExists = () => true
  const resolved = pluginWriteTargetMode({target: '/work/cache-alias/new/.env.local', home, existsSync: fakeExists, realpathSync: fakeRealpath, readdirSync: fakeReaddir, readFileSync: fakeRead})
  assert.equal(resolved.writable, false)
  assert.equal(resolved.basis, 'under-claude-plugins-dir')
  assert.equal(resolved.plugin_root, join(cacheTarget, 'new', '.env.local'))
})

test('writeGuard allows loopback Host spellings with matching port', () => {
  const goodLoopback = writeGuard({headers: {'content-type': 'application/json', host: '127.0.0.1:4488'}, socket: {localPort: 4488, remoteAddress: '127.0.0.1'}})
  assert.equal(goodLoopback, null)
  const goodBracket = writeGuard({headers: {'content-type': 'application/json', host: '[::1]:4488'}, socket: {localPort: 4488, remoteAddress: '::1'}})
  assert.equal(goodBracket, null)
  const goodLocal = writeGuard({headers: {'content-type': 'application/json', host: 'localhost:4488'}, socket: {localPort: 4488, remoteAddress: '127.0.0.1'}})
  assert.equal(goodLocal, null)
  const badPort = writeGuard({headers: {'content-type': 'application/json', host: 'localhost:9999'}, socket: {localPort: 4488, remoteAddress: '127.0.0.1'}})
  assert.equal(badPort.status, 403)
  assert.equal(badPort.error.includes('localhost:9999'), true)
  const evil = writeGuard({headers: {'content-type': 'application/json', origin: 'http://evil.example:4488', host: 'evil.example:4488'}, socket: {localPort: 4488, remoteAddress: '127.0.0.1'}})
  assert.equal(evil.status, 403)
  assert.equal(evil.error.includes('evil.example'), true)
  const missing = writeGuard({headers: {'content-type': 'application/json'}, socket: {localPort: 4488, remoteAddress: '127.0.0.1'}})
  assert.equal(missing.status, 403)
})

test('writeGuard treats the implicit HTTP port as 80, not a wildcard', () => {
  const bare80 = writeGuard({headers: {'content-type': 'application/json', host: 'localhost'}, socket: {localPort: 80, remoteAddress: '127.0.0.1'}})
  assert.equal(bare80, null)
  const explicit80 = writeGuard({headers: {'content-type': 'application/json', host: 'localhost:80'}, socket: {localPort: 80, remoteAddress: '127.0.0.1'}})
  assert.equal(explicit80, null)
  const wrongExplicit = writeGuard({headers: {'content-type': 'application/json', host: 'localhost:8080'}, socket: {localPort: 80, remoteAddress: '127.0.0.1'}})
  assert.equal(wrongExplicit.status, 403)
  assert.equal(wrongExplicit.error, 'write host refused: localhost:8080')
  const bareNon80 = writeGuard({headers: {'content-type': 'application/json', host: 'localhost'}, socket: {localPort: 4488, remoteAddress: '127.0.0.1'}})
  assert.equal(bareNon80.status, 403)
  assert.equal(bareNon80.error, 'write host refused: localhost')
  assert.equal(sameOrigin('http://localhost', 'localhost'), true)
  const sameOriginPair = writeGuard({headers: {'content-type': 'application/json', host: 'localhost', origin: 'http://localhost'}, socket: {localPort: 80, remoteAddress: '127.0.0.1'}})
  assert.equal(sameOriginPair, null)
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

test('GR1', { skip: SKIP }, async () => {
  // MUTATION GR1: limiting the shared API guard to /api/journal leaks other route data.
  const dir = scratchDir('visualizer-api-host-guard-')
  let server
  try {
    server = await startServer(join(dir, 'ledger.db'), join(dir, 'visualizer.db'))
    const port = Number(new URL(server.base).port)
    const host = `evil.example:${port}`
    for (const path of Object.keys(ROUTE_PARAMS)) {
      const response = await rawRequest({ port, requestLine: `GET ${path} HTTP/1.1`, headers: [`Host: ${host}`, 'connection: close'], timeoutMs: 30000 })
      assert.equal(rawStatus(response), 403, path)
      assert.deepEqual(rawJson(response), { schema: 2, error: `read host refused: ${host}` }, path)
    }
    for (const path of ['/api/not-registered', '/api/health?unknown=1']) {
      const response = await rawRequest({ port, requestLine: `GET ${path} HTTP/1.1`, headers: [`Host: ${host}`, 'connection: close'], timeoutMs: 30000 })
      assert.equal(rawStatus(response), 403, path)
      assert.deepEqual(rawJson(response), { schema: 2, error: `read host refused: ${host}` }, path)
    }
    for (const hostname of ['localhost', '127.0.0.1']) {
      const response = await rawRequest({ port, requestLine: 'GET /api/health HTTP/1.1', headers: [`Host: ${hostname}:${port}`, 'connection: close'] })
      assert.equal(rawStatus(response), 200, hostname)
    }
    const wrongPort = await rawRequest({ port, requestLine: 'GET /api/health HTTP/1.1', headers: ['Host: localhost:8080', 'connection: close'] })
    assert.equal(rawStatus(wrongPort), 403)
    assert.deepEqual(rawJson(wrongPort), { schema: 2, error: 'read host refused: localhost:8080' })
  } finally {
    if (server) await stopServer(server.child)
  }
})

test('GR2', () => {
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

test('GR3', { skip: SKIP }, async () => {
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

test('GR4', () => {
  // MUTATION GR4: flipping changeOrigin to false removes the Vite proxy's Host rewriting.
  const source = readFileSync(join(ROOT, 'visualizer/web/vite.config.mjs'), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/^export default /m, 'module.exports = ')
  const module = { exports: {} }
  runInNewContext(source, { defineConfig: (config) => config, svelte: () => ({}), module })
  const proxy = module.exports.server.proxy['/api']
  assert.equal(proxy.target, 'http://127.0.0.1:4488')
  assert.equal(proxy.changeOrigin, true)
})

// MUTATION VP1: flip originHost === host to !== and the dev page origin is no longer rewritten. MUTATION VP2: drop the originHost === host guard and a foreign origin is rewritten too.
test('vite dev proxy rewrites same-origin requests and leaves foreign origins untouched', () => {
  const source = readFileSync(join(ROOT, 'visualizer/web/vite.config.mjs'), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/^export default /m, 'module.exports = ')
  const module = { exports: {} }
  runInNewContext(source, { defineConfig: (config) => config, svelte: () => ({}), module, URL })
  const proxy = module.exports.server.proxy['/api']
  assert.equal(proxy.target, 'http://127.0.0.1:4488')
  assert.equal(proxy.changeOrigin, true)
  const run = (headers) => {
    let handler = null
    proxy.configure({ on: (event, fn) => { if (event === 'proxyReq') handler = fn } })
    const proxyReq = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v } }
    handler(proxyReq, { headers })
    return proxyReq.headers
  }
  const own = run({ origin: 'http://localhost:5173', host: 'localhost:5173' })
  assert.equal(own.origin, 'http://127.0.0.1:4488')
  assert.equal(sameOrigin(own.origin, '127.0.0.1:4488'), true)
  const foreign = run({ origin: 'http://evil.example', host: 'localhost:5173' })
  assert.deepEqual(foreign, {})
  assert.equal(sameOrigin('http://evil.example', '127.0.0.1:4488'), false)
})

// MUTATION LH1: disable IPv4 interface equality on the normalization return.
test('LH1', () => {
  let calls = 0
  let address = '192.0.2.23'
  const source = () => { calls++; return { ethernet: [{ address, family: 'IPv4' }], inactive: undefined } }
  const before = hostGuard({ headers: { host: '192.0.2.23:4488' }, socket: { localPort: 4488 } }, 'read', source)
  address = '192.0.2.24'
  const old = hostGuard({ headers: { host: '192.0.2.23:4488' }, socket: { localPort: 4488 } }, 'read', source)
  const current = hostGuard({ headers: { host: '192.0.2.24:4488' }, socket: { localPort: 4488 } }, 'read', source)
  assert.deepEqual([before, old, current], [null, { status: 403, error: 'read host refused: 192.0.2.23:4488' }, null])
  assert.equal(calls, 3)
})

// MUTATION LH2: disable IPv6 interface equality on the normalization return.
test('LH2', () => {
  const source = () => ({ ethernet: [{ address: '2001:0DB8:0000:0000:0000:0000:0000:0023', family: 'IPv6' }] })
  const results = ['[2001:db8::23]:4488', '[2001:DB8:0:0:0:0:0:23]:4488'].map(host =>
    hostGuard({ headers: { host }, socket: { localPort: 4488 } }, 'read', source))
  assert.deepEqual(results, [null, null])
})

// MUTATION LH3: neutralize the final refusal decision across the complete matrix.
test('LH3', () => {
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

// MUTATION LH4: widening the read-only label condition admits writes on local literals.
test('LH4', () => {
  let calls = 0
  const source = () => { calls++; return { ethernet: [{ address: '192.0.2.23' }, { address: '2001:db8::23' }] } }
  const hosts = ['192.0.2.23:4488', '[2001:db8::23]:4488']
  const refusal = host => ({ status: 403, error: `write host refused: ${host}` })
  const request = host => ({ headers: { host, 'content-type': 'application/json' }, socket: { localPort: 4488, remoteAddress: '127.0.0.1' } })
  const actual = hosts.flatMap(host => [
    hostGuard(request(host), 'write', source),
    writeGuard(request(host)),
  ])
  const expected = hosts.flatMap(host => [refusal(host), refusal(host)])
  assert.deepEqual(actual, expected)
  assert.equal(calls, 0)
})

// ---- b1410: the visualizer no longer reads the ledger or any old-path module ----
const DROPPED_ROUTES = ['/api/roster', '/api/roster/pick', '/api/roster/propose', '/api/roster/agent/propose', '/api/roster/ladder', '/api/roster/ladder/stage', '/api/roster/ladder/compose', '/api/roster/ladder/apply',
  '/api/workflows', '/api/workflows/propose', '/api/workflows/editor', '/api/workflows/save', '/api/workflows/library', '/api/workflows/preview', '/api/prepared-tasks', '/api/assurances', '/api/assurances/preview', '/api/assurances/propose',
  '/api/prompt-library', '/api/prompt-library/preview', '/api/prompt-library/save', '/api/cell-health', '/api/run-set', '/api/intake', '/api/intake/brake', '/api/seat-teardowns', '/api/cell-attribution', '/api/triage']

function leanLane(crewRoot, id) {
  const laneDir = join(crewRoot, `dt-${id}`, id)
  mkdirSync(join(laneDir, 'task'), { recursive: true })
  writeFileSync(join(laneDir, 'crew.json'), JSON.stringify({ members: { planner: { agent: 'pi' }, builder: { agent: 'pi' } } }))
  writeFileSync(join(laneDir, 'task', 'lean.json'), JSON.stringify({ id, tier: 'build' }))
  writeFileSync(join(laneDir, 'task', 'journal.jsonl'), [JSON.stringify({ event: 'run-start', at: Date.now() }), JSON.stringify({ event: 'stage-start', stage: 'plan' })].join('\n') + '\n')
}

test('VC2 the route table holds no ledger ops-pane, roster, ladder, workflow, prepared-task, assurance or prompt-library route', () => {
  for (const route of DROPPED_ROUTES) assert.equal(Object.hasOwn(ROUTE_PARAMS, route), false, `${route} must not be in ROUTE_PARAMS`)
  for (const route of ['/api/sessions', '/api/events', '/api/returns', '/api/journal', '/api/seat-sessions', '/api/agents', '/api/agents/propose', '/api/agent-library', '/api/skill-library', '/api/model-catalog', '/api/health', '/api/plugin-write-mode']) assert.ok(Object.hasOwn(ROUTE_PARAMS, route), `${route} stays`)
})

test('VC2 a dropped route answers 404 on GET and 405 on POST, never a handler', async () => {
  const crewRoot = scratchDir('visualizer-dropped-routes-')
  let started
  try {
    started = await startInProcess({}, { crewRoot })
    for (const route of DROPPED_ROUTES) {
      const get = await json(started.base, route)
      assert.equal(get.status, 404, `GET ${route}`)
      const post = await json(started.base, route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      assert.equal(post.status, 405, `POST ${route}`)
    }
  } finally {
    await stopInProcess(started?.server)
    rmSync(crewRoot, { recursive: true, force: true })
  }
})

test('VC3 /api/sessions lists a lean lane from its journal with no ledger present', async () => {
  const crewRoot = scratchDir('visualizer-lean-sessions-')
  let started
  try {
    leanLane(crewRoot, 'vc3lane')
    started = await startInProcess({}, { crewRoot, home: crewRoot, checkout: crewRoot })
    const response = await json(started.base, '/api/sessions')
    assert.equal(response.status, 200)
    const run = response.json.runs.find((candidate) => candidate.adw_id === 'lean:vc3lane')
    assert.ok(run, 'the lean lane is listed')
    assert.equal(run.source, 'lean')
    assert.deepEqual(response.json.sources, { lean: { readable: true, absent: null, runs: response.json.runs.length } })
    assert.equal(response.json.degraded, false)
    assert.equal(Object.hasOwn(response.json.sources, 'ledger'), false)
  } finally {
    await stopInProcess(started?.server)
    rmSync(crewRoot, { recursive: true, force: true })
  }
})

test('VC3 a failed lean read is unreadable with a null run count, never zero lanes', async () => {
  let started
  try {
    started = await startInProcess({}, { lean: { listRuns: () => { throw new Error('crew root unreadable') } } })
    const response = await json(started.base, '/api/sessions')
    assert.equal(response.status, 200)
    assert.deepEqual(response.json.runs, [])
    assert.deepEqual(response.json.sources, { lean: { readable: false, absent: 'crew root unreadable', runs: null } })
    assert.equal(response.json.degraded, true)
  } finally {
    await stopInProcess(started?.server)
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

test('/api/health reports the removed ledger as unreadable with a reason, not a probe or a zero', async () => {
  let started
  try {
    started = await startInProcess({})
    const response = await json(started.base, '/api/health')
    assert.equal(response.status, 200)
    assert.equal(response.json.ledger.readable, false)
    assert.match(response.json.ledger.absent, /ledger source removed/)
    assert.equal(response.json.returns_readonly, true)
  } finally {
    await stopInProcess(started?.server)
  }
})

test('VC1 no module under visualizer/server imports crew/ or scripts/ except protocols and agents', () => {
  const allowed = new Set(['crew/protocols.mjs', 'crew/agents.mjs'])
  const bad = []
  for (const name of readdirSync(join(ROOT, 'visualizer/server')).filter((file) => file.endsWith('.mjs'))) {
    const source = readFileSync(join(ROOT, 'visualizer/server', name), 'utf8')
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      const target = join('visualizer/server', match[1]).split('\\').join('/')
      if ((target.startsWith('crew/') || target.startsWith('scripts/')) && !allowed.has(target)) bad.push(`${name} -> ${match[1]}`)
    }
  }
  assert.deepEqual(bad, [])
})

test('api.js has no client for a route the server no longer serves', () => {
  const api = readFileSync(join(ROOT, 'visualizer/web/src/lib/api.js'), 'utf8')
  const served = new Set(Object.keys(ROUTE_PARAMS))
  const refs = [...new Set([...api.matchAll(/\/api\/[a-z0-9/_-]+/gi)].map((match) => match[0].replace(/\/$/, '')))]
  assert.deepEqual(refs.filter((route) => !served.has(route)), [])
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
    assert.equal(readFileSync(agentFile, 'utf8'), agentText)
    // The register-entry proposal shares the endpoint and is untouched.
    assert.equal((await post({ name: 'future-agent', entry: 7 })).status, 400)
  } finally {
    await stopInProcess(server)
    rmSync(dir, { recursive: true, force: true })
  }
})
