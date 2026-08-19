import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, basename, dirname } from 'node:path'
import { EVENT_TYPES, PAYLOAD_KEYS, NODE_FLOOR, openLedger } from '../scripts/factory/ledger.mjs'
import { openRun } from '../scripts/factory/emit.mjs'
import {
  composeLayout, SEAT_DEFAULTS, FANOUT_TOOLS, DEFAULT_ROLES, ROLE_ORDER, transportFor, seatTransport, HEADLESS_TRANSPORTS, assertCapabilities, resolveAdapters, bootAllocation, resolveWorkerBin, docOpenArgs,
  resolveTier, resolveSeatModels, seatReadySignal, assertSeats, phaseForStage, emitAdapter,
  waitForEnvelope, WAIT_POLL_MS, LIVENESS_PROBE_MS, LIVENESS_MISSES_TO_DIE,
  parkSeats, parkOnOutcome, escalationAttention, bootCmd, runCmd, resolveVariant, resolveFilesInScope, resolveLaneFence, seatLiveness, awaitSeatsReady, teardownCore, teardownCmd,
  MEMORY_ROLES, memoryConfig, CAPABILITY_REFUSALS, validateCapabilities, loadCapabilities,
  grantsFor, assertGrantsBacked, EMPTY_GRANTS, probeLocalEndpoint, refuse,
  CAPABILITY_DELIVERY, effectiveCapabilities, effectiveTools, LOAD_ENV, loadPolicy, hostLoad, assertHostQuiet,
} from './crew.mjs'
import { runChild } from './child.mjs'
import { driveTask, LIMITS, VARIANTS, VARIANT_NAMES, DEFAULT_VARIANT, PROTECTED_PATHS, validateScopeEntries } from './drive.mjs'
import { LIMIT_REFUSALS, PLAN_ROUNDS_MAX, limitsRecord, resolvePlanRounds } from './limits.mjs'
import { reclaimStore } from './reclaim.mjs'
import { seatCommand, headlessCommand as claudeHeadlessCommand, capabilitiesFor, modelString as claudeModelString } from './adapters/adapter-claude.mjs'
import { seatCommand as piSeatCommand, capabilitiesFor as piCapabilitiesFor, modelString as piModelString, translateDeny, PI_BUILTIN_TOOLS } from './adapters/adapter-pi.mjs'
import { realIo, VARIANT_STAGE_PHASES, paneTeardownRows, PANE_SETTLE_POLLS, PANE_SETTLE_MS } from './realio.mjs'
import { testCheckout } from '../test/fixtures.mjs'
import { probeRepo } from '../scripts/factory/probe-repo.mjs'

const roster = JSON.parse(readFileSync(new URL('./roster.json', import.meta.url), 'utf8'))
// Hoisted: tests both above and below this point branch on it. Below the
// ledger's Node floor the emitter degrades to JSONL and writes no database,
// so a real-row assertion there would assert the absence of a feature.
const floorMajor = Number.parseInt(NODE_FLOOR, 10)
const nodeMeetsLedgerFloor = Number.parseInt(process.versions.node, 10) >= floorMajor

const PARK_CREW = {
  roles: ['lead', 'planner', 'builder', 'reviewer'],
  members: {
    lead: { surface_id: 'surface-lead', pane_id: 'pane-lead', transport: 'pane' },
    planner: { surface_id: null, pane_id: 'pane-planner', transport: 'pane' },
    builder: { surface_id: null, pane_id: null, transport: 'headless' },
    reviewer: { surface_id: 'surface-reviewer', pane_id: 'pane-reviewer', transport: 'pane' },
  },
}

test('parkSeats maps seated members, prefers surfaces, falls back for headless seats, and marks warm panes', () => {
  const seats = parkSeats(PARK_CREW)
  assert.deepEqual(seats, [
    { role: 'lead', sessionId: 'surface-lead', warm: true },
    { role: 'planner', sessionId: 'pane-planner', warm: false },
    { role: 'builder', sessionId: 'headless:builder', warm: false },
    { role: 'reviewer', sessionId: 'surface-reviewer', warm: true },
  ])
  assert.equal(new Set(seats.map((seat) => seat.sessionId)).size, seats.length)
})

test('parkOnOutcome escalation mints a parked/null park with the crew seats', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-park-mint-'))
  try {
    const result = parkOnOutcome({ status: 'escalation' }, { crew: PARK_CREW, runId: 'run-park', dir, reason: 'lane red' })
    assert.equal(typeof result.park_id, 'string')
    assert.ok(result.park_id.trim())
    assert.equal(result.error, null)
    const path = join(dir, 'parks', `${result.park_id}.json`)
    assert.equal(existsSync(path), true)
    const park = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(park.state, 'parked')
    assert.equal(park.launch_state, null)
    assert.equal(park.run_id, 'run-park')
    assert.deepEqual(park.seats, parkSeats(PARK_CREW))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('parkOnOutcome done mints nothing and does not create a store directory', () => {
  const parent = mkdtempSync(join(tmpdir(), 'crew-park-done-'))
  const dir = join(parent, 'reclaim')
  try {
    assert.deepEqual(parkOnOutcome({ status: 'done' }, { crew: PARK_CREW, runId: 'run-done', dir, reason: 'green' }), { park_id: null, error: null })
    assert.equal(existsSync(dir), false)
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

test('park recordAnswer and claim round trip succeeds against the minted park', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-park-roundtrip-'))
  try {
    const minted = parkOnOutcome({ status: 'escalation' }, { crew: PARK_CREW, runId: 'run-roundtrip', dir, reason: 'suite red' })
    assert.ok(minted.park_id)
    const store = reclaimStore({ dir, actor: 'test' })
    assert.equal(store.recordAnswer(minted.park_id, { decision_id: 'decision-1', actor: 'human', answer: 'resume' }).ok, true)
    const claimed = store.claim(minted.park_id, {
      decision_id: 'decision-1', successor_run_id: 'run-successor', enqueue: () => true, successorState: () => 'absent',
    })
    assert.equal(claimed.ok, true)
    assert.equal(claimed.park.state, 'claimed')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('parkOnOutcome reports mint failures without throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-park-failure-'))
  try {
    const failed = parkOnOutcome({ status: 'escalation' }, {
      crew: PARK_CREW, runId: 'run-failed', dir, reason: 'x',
      openStore: () => ({ mintPark: () => ({ ok: false, reason: 'unresolvable' }) }),
    })
    assert.equal(failed.park_id, null)
    assert.equal(typeof failed.error, 'string')
    assert.ok(failed.error.trim())
    const thrown = parkOnOutcome({ status: 'escalation' }, {
      crew: PARK_CREW, runId: 'run-thrown', dir, reason: 'x', openStore: () => { throw new Error('store is gone') },
    })
    assert.equal(thrown.park_id, null)
    assert.equal(typeof thrown.error, 'string')
    assert.ok(thrown.error.trim())
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('escalationAttention returns the canonical keys and preserves a null park_id', () => {
  const event = escalationAttention({ task: 'task', park_id: 'park-1', why: 'lane red', artifacts: ['/journal'] })
  assert.deepEqual(Object.keys(event).sort(), ['artifacts', 'kind', 'moment', 'park_id', 'task', 'why'])
  assert.equal(event.kind, 'attention')
  assert.equal(event.moment, 'escalation')
  assert.equal(event.park_id, 'park-1')
  const unminted = escalationAttention({ task: 'task', park_id: null, why: 'mint failed' })
  assert.equal(Object.hasOwn(unminted, 'park_id'), true)
  assert.equal(unminted.park_id, null)
})

// cmux build-102 rejects layouts whose split nodes are not strictly binary
// and whose single-pane trees are anything but a bare leaf ("Invalid
// layout"). composeLayout exists to satisfy exactly that grammar, so these
// pins are load-bearing: a refactor to n-ary children boots nothing.

const mk = (role) => `run-${role}`

function assertBinary(node) {
  if (node.pane) {
    assert.equal(node.pane.surfaces.length, 1)
    return 1
  }
  assert.ok(['horizontal', 'vertical'].includes(node.direction))
  assert.equal(node.children.length, 2, 'split nodes must be strictly binary')
  return node.children.reduce((n, c) => n + assertBinary(c), 0)
}

test('single role composes a bare leaf, not a wrapped split', () => {
  const layout = composeLayout(['lead'], mk)
  assert.ok(layout.pane, 'one pane must be a bare leaf')
  assert.equal(layout.pane.surfaces[0].name, 'lead')
  assert.equal(layout.pane.surfaces[0].command, 'run-lead')
})

test('multi-role layout is strictly binary with every seat present once', () => {
  for (const roles of [DEFAULT_ROLES, [...DEFAULT_ROLES, 'tech-lead'], ['lead', 'builder']]) {
    const layout = composeLayout([...roles], mk)
    assert.equal(assertBinary(layout), roles.length)
  }
})

test('lead takes the left half; members stack vertically on the right', () => {
  const layout = composeLayout([...DEFAULT_ROLES], mk)
  assert.equal(layout.direction, 'horizontal')
  assert.equal(layout.children[0].pane.surfaces[0].name, 'lead')
  let right = layout.children[1]
  const names = []
  while (right.children) {
    assert.equal(right.direction, 'vertical')
    names.push(right.children[0].pane.surfaces[0].name)
    right = right.children[1]
  }
  names.push(right.pane.surfaces[0].name)
  assert.deepEqual(names, ['planner', 'builder', 'reviewer'])
})

test('every default role has a seat definition; builder is the only Edit seat and carries no Task', () => {
  for (const r of DEFAULT_ROLES) assert.ok(SEAT_DEFAULTS[r], `missing seat: ${r}`)
  for (const [role, seat] of Object.entries(SEAT_DEFAULTS)) {
    if (role === 'builder') {
      assert.match(seat.tools, /Edit/)
      assert.doesNotMatch(seat.tools, /Task/, 'builder must stay subagent-free (transcript reducer relies on it)')
    } else {
      assert.doesNotMatch(seat.tools, /Edit/, `${role} must not write the repo`)
    }
  }
})

test('seat deny lists are the ENFORCED boundary: only the builder may Edit, the builder never gets subagents', () => {
  // --allowedTools is inert under bypassPermissions (verified live); the
  // --disallowedTools deny list is what actually holds. These pins keep the
  // charter real: drop a deny entry and the posture in README becomes a lie.
  for (const [role, seat] of Object.entries(SEAT_DEFAULTS)) {
    assert.ok(seat.deny, `${role} has no deny list — under bypassPermissions it would be unconstrained`)
    if (role === 'builder') {
      for (const tool of FANOUT_TOOLS) assert.match(seat.deny, new RegExp(tool))
      assert.doesNotMatch(seat.deny, /Edit/, 'the builder is the one seat that MUST keep Edit')
    } else {
      assert.match(seat.deny, /Edit/, `${role} must be tool-denied Edit, not just un-allowed`)
      assert.match(seat.deny, /NotebookEdit/)
    }
  }
})

test('FANOUT_TOOLS names every fan-out path once, and every denying seat withholds all of them', () => {
  assert.deepEqual([...FANOUT_TOOLS], ['Task', 'Agent', 'Workflow'])
  assert.ok(Object.isFrozen(FANOUT_TOOLS))
  const names = (deny) => String(deny).split(',').map((s) => s.trim())
  for (const role of ['lead', 'builder', 'tech-lead']) {
    for (const tool of FANOUT_TOOLS) assert.ok(names(SEAT_DEFAULTS[role].deny).includes(tool), `${role} must deny ${tool}`)
  }
  // The other direction, pinned by VALUE not by exclusion: closing the hole
  // must not revoke a granted seat's fan-out — nor widen it in any other way.
  for (const role of ['planner', 'reviewer']) assert.equal(SEAT_DEFAULTS[role].deny, 'Edit,NotebookEdit')
})

test('adapter-claude.seatCommand is byte-identical to the pre-refactor paneCommand output', () => {
  const SAMPLE = {
    role: 'builder', model: 'sonnet', promptFile: '/tmp/crew-task/role-builder.md',
    tools: 'Read,Edit,Write,Glob,Grep,Bash', deny: 'Task,Agent', taskDir: '/tmp/crew-task',
    bootBrief: 'Crew for task demo. Task dir /tmp/crew-task. Read your role in the system prompt, reply exactly ready: your-role, then wait.',
  }
  // Captured from main BEFORE the adapter refactor — do not regenerate this
  // from the new code; it is the compatibility bar.
  const EXPECTED = 'env DEVTEAM_WORKER=1 CREW_ROLE=builder CREW_TASK_DIR="/tmp/crew-task" claude --model sonnet --permission-mode bypassPermissions --allowedTools "Read,Edit,Write,Glob,Grep,Bash" --disallowedTools "Task,Agent" --append-system-prompt-file "/tmp/crew-task/role-builder.md" "Crew for task demo. Task dir /tmp/crew-task. Read your role in the system prompt, reply exactly ready: your-role, then wait."'
  assert.equal(seatCommand(SAMPLE), EXPECTED)
})

test('every shipped capability profile is exact, complete, and frozen', async () => {
  for (const [role, seat] of Object.entries(SEAT_DEFAULTS)) assert.equal(seat.agent, 'claude', `${role} has no agent`)
  const claudeMod = await import('./adapters/adapter-claude.mjs')
  const piMod = await import('./adapters/adapter-pi.mjs')
  assert.equal(claudeMod.capabilities, undefined)
  assert.equal(piMod.capabilities, undefined)

  const claudePane = capabilitiesFor({ transport: 'pane' })
  // #131: drive.mjs bounce paths reassign a settled pane seat.
  assert.deepEqual({ ...claudePane }, { prompt_file: true, tool_deny: true, unattended: true, subagents: true, effort: true, local_provider: false, interjection: 'none', abort: 'none', session_resume: false, durable_cursor: 'none', reassign: true })
  assert.ok(Object.isFrozen(claudePane))
  const claudeHeadless = capabilitiesFor({ transport: 'headless-json' })
  assert.deepEqual({ ...claudeHeadless }, { prompt_file: true, tool_deny: true, unattended: true, subagents: true, effort: true, local_provider: false, interjection: 'turn', abort: 'signal', session_resume: true, durable_cursor: 'none', reassign: false })
  assert.ok(Object.isFrozen(claudeHeadless))
  const piPane = piCapabilitiesFor({ transport: 'pane' })
  // #131: drive.mjs bounce paths reassign a settled pane seat.
  assert.deepEqual({ ...piPane }, { prompt_file: true, tool_deny: true, unattended: true, subagents: false, effort: true, local_provider: true, interjection: 'none', abort: 'none', session_resume: false, durable_cursor: 'none', reassign: true })
  assert.ok(Object.isFrozen(piPane))
  const piHeadless = piCapabilitiesFor({ transport: 'headless-rpc' })
  // #148: reassign captured live (captures/pi-b11-reassign.jsonl) — a settled
  // session takes a further assignment same-process and cross-process.
  assert.deepEqual({ ...piHeadless }, { prompt_file: true, tool_deny: true, unattended: true, subagents: false, effort: true, local_provider: true, interjection: 'boundary', abort: 'command', session_resume: true, durable_cursor: 'entry_id', reassign: true })
  assert.ok(Object.isFrozen(piHeadless))
})

test('unshipped capability pairs and absent transports throw naming adapter and transport', () => {
  for (const [adapter, name, transport] of [[capabilitiesFor, 'claude', 'headless-rpc'], [piCapabilitiesFor, 'pi', 'headless-json']]) {
    assert.throws(() => adapter({ transport }), (err) => err.message.includes(name) && err.message.includes(transport))
    assert.throws(() => adapter({ transport: 'unknown' }), (err) => err.message.includes(name) && err.message.includes('unknown'))
    assert.throws(() => adapter({}), (err) => err.message.includes(name) && err.message.includes('undefined'))
  }
})

test('transportFor selects each named transport and rejects an ambiguous seat', () => {
  assert.equal(transportFor('builder', { headless: 'builder' }), 'headless-json')
  assert.equal(transportFor('builder', { 'headless-rpc': 'builder' }), 'headless-rpc')
  assert.equal(transportFor('lead', { 'headless-rpc': 'builder' }), 'pane')
  assert.equal(transportFor('builder', {}), 'pane')
  assert.throws(() => transportFor('builder', { headless: 'builder', 'headless-rpc': 'builder' }), /builder.*headless.*headless-rpc/)
})

test('seatTransport resolves each real adapter under --headless-all through its capabilities probe', () => {
  assert.deepEqual([...HEADLESS_TRANSPORTS], ['headless-json', 'headless-rpc'])
  assert.equal(seatTransport({ role: 'lead', args: { 'headless-all': true }, adapter: { capabilitiesFor }, agentName: 'claude' }), 'headless-json')
  assert.equal(seatTransport({ role: 'builder', args: { 'headless-all': 'true' }, adapter: { capabilitiesFor: piCapabilitiesFor }, agentName: 'pi' }), 'headless-rpc')
})

test('seatTransport keeps explicit transports ahead of --headless-all and defaults to pane', () => {
  let probes = 0
  const adapter = { capabilitiesFor() { probes += 1; throw new Error('must not probe') } }
  assert.equal(seatTransport({ role: 'builder', args: { 'headless-all': true, 'headless-rpc': 'builder' }, adapter, agentName: 'stub' }), 'headless-rpc')
  assert.equal(seatTransport({ role: 'builder', args: {}, adapter, agentName: 'stub' }), 'pane')
  assert.equal(probes, 0)
})

test('seatTransport names the seat, agent, and every refusal when no headless pair is shipped', () => {
  const adapter = { capabilitiesFor({ transport }) { throw new Error(`stub refusal for ${transport}`) } }
  assert.throws(
    () => seatTransport({ role: 'builder', args: { 'headless-all': true }, adapter, agentName: 'stub-agent' }),
    (err) => ['builder', 'stub-agent', 'headless-json', 'headless-rpc', 'stub refusal for headless-rpc'].every((part) => err.message.includes(part)),
  )
})

test('seatTransport rejects a value supplied to the boolean-only --headless-all flag', () => {
  assert.throws(
    () => seatTransport({ role: 'builder', args: { 'headless-all': 'builder' }, adapter: { capabilitiesFor }, agentName: 'claude' }),
    /--headless-all takes no value/,
  )
})

test('assertCapabilities rejects an adapter that cannot enforce tool denial, naming seat + adapter + capability', () => {
  assert.throws(
    () => assertCapabilities('builder', 'weakling', { tool_deny: false }),
    (err) => /builder/.test(err.message) && /weakling/.test(err.message) && /tool_deny/.test(err.message),
  )
  assert.doesNotThrow(() => assertCapabilities('builder', 'claude', { tool_deny: true }))
})

test('resolveAdapters rejects an unknown --agent-<role> naming the missing file, resolves the default claude adapter otherwise', async () => {
  await assert.rejects(
    () => resolveAdapters(['builder'], { 'agent-builder': 'nope' }),
    /adapter-nope\.mjs/,
  )
  const r = await resolveAdapters(['builder'], {})
  assert.equal(r.builder.name, 'claude')
})

test('resolveAdapters tags a refusal with the role and roster cell it rejected', async () => {
  const cell = { agent: 'nope', provider: 'vendor', id: 'model-id', effort: 'high', model: null }
  await assert.rejects(
    () => resolveAdapters(['builder'], { 'agent-builder': 'nope' }, { builder: cell }),
    (err) => {
      assert.equal(err.role, 'builder')
      assert.deepEqual(err.cell, cell)
      return true
    },
  )
})

test('resolveAdapters boots headless claude and refuses the unshipped pi pair', async () => {
  const r = await resolveAdapters(['builder'], { headless: 'builder' })
  assert.equal(r.builder.transport, 'headless-json')
  await assert.rejects(() => resolveAdapters(['builder'], { headless: 'builder', 'agent-builder': 'pi' }), /adapter-pi.*headless-json/)
})

test('seat requirements refuse pi scouts, allow a named shortfall, and reject malformed overrides', async () => {
  await assert.rejects(
    () => resolveAdapters(['planner'], { 'agent-planner': 'pi' }),
    (err) => /planner/.test(err.message) && /subagents/.test(err.message) && /pi/.test(err.message),
  )
  // The reviewer is deliberately NOT subject to this: the roster seats
  // pi/terra on review at build/mechanical under the ratified review-vendor
  // rule, so requiring subagents there would make two of three tiers
  // unbootable. Pinned so a later "symmetry" tidy-up cannot reintroduce it.
  const reviewer = await resolveAdapters(['reviewer'], { 'agent-reviewer': 'pi' })
  assert.equal(reviewer.reviewer.name, 'pi')
  const builder = await resolveAdapters(['builder'], { 'agent-builder': 'pi' })
  assert.equal(builder.builder.name, 'pi')
  const planner = await resolveAdapters(['planner'], { 'agent-planner': 'pi', 'allow-shortfall-planner': 'subagents' })
  assert.equal(planner.planner.name, 'pi')
  await assert.rejects(
    () => resolveAdapters(['planner'], { 'agent-planner': 'pi', 'allow-shortfall-planner': 'tool_deny' }),
    (err) => /planner/.test(err.message) && /subagents/.test(err.message) && /pi/.test(err.message),
  )
  await assert.rejects(
    () => resolveAdapters(['planner'], { 'agent-planner': 'pi', 'allow-shortfall-planner': true }),
    /--allow-shortfall-planner needs a capability name/,
  )
  await assert.rejects(
    () => resolveAdapters(['planner'], { 'allow-shortfall-nosuchrole': 'subagents' }),
    /--allow-shortfall-nosuchrole given but crew seats no nosuchrole/,
  )
})

test('bootAllocation records only declared shortfalls and preserves tier provenance', () => {
  assert.deepEqual(
    bootAllocation(['planner'], { 'allow-shortfall-planner': 'subagents' }),
    { planner: { shortfall: ['subagents'] } },
  )
  assert.deepEqual(
    bootAllocation(['planner', 'builder'], {}, { planner: { agent: 'roster' }, builder: { model: 'roster' } }),
    { planner: { agent: 'roster' }, builder: { model: 'roster' } },
  )
  assert.equal(bootAllocation(['planner', 'builder'], {}), null)
})

test('SEAT_DEFAULTS requires subagents for the planner ALONE — the scout-commander seat', () => {
  assert.deepEqual(SEAT_DEFAULTS.planner.requires, ['subagents'])
  // Not the reviewer: its charter names no fan-out, and the roster seats
  // pi/terra on review at build/mechanical by ratified policy. A requirement
  // here makes two of three tiers unbootable — measured, not theorised.
  for (const role of ['lead', 'builder', 'reviewer', 'tech-lead']) assert.deepEqual(SEAT_DEFAULTS[role].requires, [])
})

test('every roster tier still boots its seats — the requirement cannot strand a shipped tier', async () => {
  const roster = JSON.parse(readFileSync(new URL('./roster.json', import.meta.url), 'utf8'))
  for (const tier of Object.keys(roster.tiers)) {
    const { roles, seats } = resolveTier(roster, tier, {})
    await assert.doesNotReject(
      () => resolveAdapters(roles, {}, seats),
      `tier "${tier}" must boot with no shortfall override`,
    )
  }
})

test('resolveAdapters boots pi headless-rpc and refuses claude on that transport', async () => {
  const r = await resolveAdapters(['builder'], { 'headless-rpc': 'builder', 'agent-builder': 'pi' })
  assert.equal(r.builder.transport, 'headless-rpc')
  await assert.rejects(() => resolveAdapters(['builder'], { 'headless-rpc': 'builder' }), /claude.*headless-rpc/)
})

test('resolveWorkerBin prefers an explicit existing path over the environment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-bin-'))
  const explicit = join(dir, 'explicit'); const env = join(dir, 'env')
  writeFileSync(explicit, ''); writeFileSync(env, '')
  const old = process.env.CREW_CLAUDE_BIN
  process.env.CREW_CLAUDE_BIN = env
  try { assert.equal(resolveWorkerBin({ 'claude-bin': explicit }), explicit) }
  finally { if (old === undefined) delete process.env.CREW_CLAUDE_BIN; else process.env.CREW_CLAUDE_BIN = old; rmSync(dir, { recursive: true, force: true }) }
})

async function withHome(home, fn) {
  const previous = process.env.HOME
  process.env.HOME = home
  try { return await fn() }
  finally { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous }
}

async function withoutMemoryEnv(fn) {
  const previous = Object.fromEntries(['CREW_MEMORY_DIR', 'CREW_MEMORY_BACKEND', 'CREW_MEMORY_BUDGET_BYTES']
    .map((key) => [key, process.env[key]]))
  for (const key of Object.keys(previous)) delete process.env[key]
  try { return await fn() }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  }
}

async function withBreakerEnv(values, fn) {
  const keys = ['CREW_BREAKER_THRESHOLD', 'CREW_BREAKER_WINDOW_MS', 'CREW_LOAD_THRESHOLD', ...Object.keys(values)]
  const previous = Object.fromEntries([...new Set(keys)].map((key) => [key, process.env[key]]))
  for (const key of Object.keys(previous)) {
    if (Object.hasOwn(values, key)) {
      if (values[key] === undefined) delete process.env[key]; else process.env[key] = String(values[key])
    } else delete process.env[key]
  }
  try { return await fn() }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  }
}

function testCrewDir(home, checkout, task) { return join(home, '.crew', basename(checkout), task) }

function protectedProfile(factoryRoot, checkout, cell) {
  const repoKey = probeRepo({ checkout }).repo_key
  const path = join(factoryRoot, 'profiles', `${repoKey}.json`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({
    schema: 1, profile_version: 1, repo_key: repoKey, fields: { protected_paths_candidates: cell }, meta: {},
  }))
  return path
}

function memoryFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'crew-boot-memory-'))
  writeFileSync(join(dir, 'MEMORY.md'), '- [Alpha](alpha.md) — first hook\n- [Beta](beta.md) — second hook\n')
  writeFileSync(join(dir, 'alpha.md'), `---\nname: alpha\n---\n\n${'A'.repeat(80)}\n`)
  writeFileSync(join(dir, 'beta.md'), `---\nname: beta\n---\n\n${'B'.repeat(80)}\n`)
  return dir
}

function bootRecord(dir) {
  return readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line)).find((event) => event.event === 'boot')
}

function callCounter() {
  const calls = []
  const fn = (...args) => { calls.push(args); return { ok: true, stdout: '' } }
  fn.calls = calls
  return fn
}

function breakerRow(over = {}) {
  return {
    provider: 'openai', model_id: 'gpt-5.6-luna', agent: 'pi', effort: 'max', role: 'builder', kind: 'timeout',
    failures: 1, first_at: '2026-08-16T00:00:00.000Z', last_at: '2026-08-16T01:00:00.000Z', run_less: 0, ...over,
  }
}

function fakeBreakerLedger(rows, { degraded = false } = {}) {
  const calls = []
  const open = (options) => {
    calls.push(options)
    return {
      get degraded() { return degraded },
      cellFailures: () => rows,
      stats: () => ({ mirror_errors: 0 }),
      close() {},
    }
  }
  open.calls = calls
  return open
}

test('bootAllocation carries resolved transports alongside tier provenance', () => {
  assert.deepEqual(
    bootAllocation(['lead', 'builder'], {}, { lead: { model: 'roster' }, builder: { agent: 'roster' } }, { lead: 'headless-json', builder: 'headless-rpc' }),
    { lead: { model: 'roster', transport: 'headless-json' }, builder: { agent: 'roster', transport: 'headless-rpc' } },
  )
})

test('boot refusal records a run-less boot-refusal row naming the rejected cell', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-boot-refusal-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-boot-refusal-checkout-')
  const dbPath = join(home, 'ledger.db')
  const previous = process.env.DEVTEAM_LEDGER_DB
  process.env.DEVTEAM_LEDGER_DB = dbPath
  try {
    await withHome(home, () => assert.rejects(
      () => bootCmd({ task: 'boot-refusal', checkout, roles: 'lead,planner,builder,reviewer', 'agent-reviewer': 'no-such-agent' }, {
        cmux: callCounter(), tree: callCounter(), renameTab: callCounter(),
      }),
      /unknown agent adapter/,
    ))
    const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
    const row = ledger.dumpTable('cell_failures').find((candidate) => candidate.kind === 'boot-refusal')
    ledger.close()
    if (!nodeMeetsLedgerFloor) {
      // Below the floor the emitter records JSONL only and writes no database.
      // The refusal itself (asserted above) is the behaviour that must hold on
      // every runtime; a recorded row is a capability of Node >= NODE_FLOOR.
      assert.equal(row, undefined)
      return
    }
    assert.ok(row)
    assert.equal(row.role, 'reviewer')
    assert.equal(row.adw_id, null)
    assert.equal(row.task_slug, 'boot-refusal')
  } finally {
    if (previous === undefined) delete process.env.DEVTEAM_LEDGER_DB; else process.env.DEVTEAM_LEDGER_DB = previous
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('resolveVariant defaults to the driver default and round-trips every driver name', () => {
  assert.equal(resolveVariant({}), DEFAULT_VARIANT)
  for (const name of VARIANT_NAMES) assert.equal(resolveVariant({ variant: name }), name)
})

test('resolveVariant refuses unknown and valueless forms with the complete closed set', () => {
  const assertClosedSet = (err) => {
    assert.match(err.message, /variant/)
    for (const name of VARIANT_NAMES) assert.match(err.message, new RegExp(name))
    return true
  }
  assert.throws(() => resolveVariant({ variant: 'no-such-shape' }), assertClosedSet)
  assert.throws(() => resolveVariant({ variant: true }), assertClosedSet)
})

test('resolveFilesInScope parses a comma list, handles neutral shapes, and refuses a valueless flag', () => {
  const inherited = VARIANT_NAMES.find((name) => VARIANTS[name]?.sources?.scope === 'inherited')
  const plain = VARIANT_NAMES.find((name) => VARIANTS[name]?.sources?.scope !== 'inherited')
  assert.deepEqual(resolveFilesInScope({ 'files-in-scope': ' a.mjs, , b.mjs ' }, inherited, '/missing/task.json'), ['a.mjs', 'b.mjs'])
  assert.equal(resolveFilesInScope({}, plain, '/missing/task.json'), null)
  assert.throws(() => resolveFilesInScope({ 'files-in-scope': true }, plain, '/missing/task.json'), /needs a comma-separated list/)
})

test('resolveFilesInScope inherits the preferred or fallback list and names every unreadable envelope', () => {
  const inherited = VARIANT_NAMES.find((name) => VARIANTS[name]?.sources?.scope === 'inherited')
  const dir = mkdtempSync(join(tmpdir(), 'crew-scope-envelope-'))
  const preferred = join(dir, 'preferred.json')
  const fallback = join(dir, 'fallback.json')
  const malformed = join(dir, 'malformed.json')
  try {
    writeFileSync(preferred, JSON.stringify({ details: { files_in_scope: ['lib/a.mjs'], files_committed: ['lib/b.mjs'] } }))
    writeFileSync(fallback, JSON.stringify({ details: { files_committed: ['lib/b.mjs'] } }))
    writeFileSync(malformed, '{not-json')
    assert.deepEqual(resolveFilesInScope({}, inherited, preferred), ['lib/a.mjs'])
    assert.deepEqual(resolveFilesInScope({}, inherited, fallback), ['lib/b.mjs'])
    for (const [path, deps] of [
      [join(dir, 'missing.json'), {}],
      [preferred, { existsSync: () => true, readFileSync: () => { throw new Error('denied') } }],
      [malformed, {}],
    ]) {
      assert.throws(() => resolveFilesInScope({}, inherited, path, deps), (err) => err.message.includes(path))
    }
    for (const [index, details] of [{ files_in_scope: 'lib/a.mjs' }, { files_in_scope: [] }, {}].entries()) {
      const path = join(dir, `bad-${index}.json`)
      writeFileSync(path, JSON.stringify({ details }))
      assert.throws(() => resolveFilesInScope({}, inherited, path), (err) => err.message.includes(path))
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('resolveFilesInScope refuses every entry the gate rejects', () => {
  const plain = VARIANT_NAMES.find((name) => VARIANTS[name]?.sources?.scope !== 'inherited')
  for (const entry of ['lib/*.mjs', '/abs/path.mjs', '../up.mjs', 'crew/', '']) {
    const defects = validateScopeEntries([entry])
    assert.equal(defects.length, 1)
    assert.throws(() => resolveFilesInScope({ 'files-in-scope': entry }, plain, '/missing/task.json'), (err) => err.message.includes(JSON.stringify(entry)))
  }
})

test('resolveLaneFence takes both flags or neither', () => {
  assert.equal(resolveLaneFence({}), null)
  assert.throws(() => resolveLaneFence({ lane: 'a' }), /given together or not at all/)
  assert.throws(() => resolveLaneFence({ fences: '/missing/fences.json' }), /given together or not at all/)
  const dir = mkdtempSync(join(tmpdir(), 'crew-fence-resolver-'))
  const register = join(dir, 'fences.json')
  try {
    writeFileSync(register, JSON.stringify({ lanes: [
      { lane: 'b', files: ['z.mjs', 'y.mjs'] },
      { lane: 'a', files: ['x.mjs'] },
    ] }))
    assert.deepEqual(resolveLaneFence({ fences: register, lane: 'a' }), {
      lane: 'a', fence: [{ lane: 'b', files: ['y.mjs', 'z.mjs'] }],
    })
    assert.throws(() => resolveLaneFence({ fences: register, lane: 'unknown' }), (err) => err.reason === 'unknown-lane')
    writeFileSync(register, '{not json')
    assert.throws(() => resolveLaneFence({ fences: register, lane: 'a' }), (err) => err.reason === 'bad-fences')
    const source = readFileSync(new URL('./crew.mjs', import.meta.url), 'utf8')
    assert.match(source, /--fences/)
    assert.match(source, /--lane/)
    assert.match(source, /paired: both or neither/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('resolvePlanRounds resolves absent and valid values and refuses invalid budgets closed', () => {
  assert.equal(resolvePlanRounds(undefined), null)
  assert.equal(resolvePlanRounds(null), null)
  assert.equal(resolvePlanRounds(''), null)
  assert.equal(resolvePlanRounds('6'), 6)
  assert.equal(resolvePlanRounds(6), 6)
  assert.equal(resolvePlanRounds(' 3 '), 3)
  for (const raw of [true, 'abc', '2.5', 2.5, 0, -1, '0x4', [], PLAN_ROUNDS_MAX + 1]) {
    assert.throws(() => resolvePlanRounds(raw), (err) => {
      assert.equal(err.reason, 'invalid-plan-rounds')
      assert.ok(LIMIT_REFUSALS.includes(err.reason))
      return true
    })
  }
})

test('limitsRecord records the effective default or flagged plan-round budget', () => {
  assert.deepEqual(limitsRecord(null, LIMITS), { plan_rounds: LIMITS.plan_rounds, source: 'default' })
  assert.deepEqual(limitsRecord(6, LIMITS), { plan_rounds: 6, source: 'flag' })
})

test('run refuses an invalid plan-round budget before reading crew state', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-plan-rounds-refusal-home-'))
  let drove = 0
  try {
    await withHome(home, () => {
      assert.throws(
        () => runCmd({ task: 'invalid-plan-rounds-run', checkout: process.cwd(), 'brief-file': join(home, 'missing.md'), 'plan-rounds': '2.5' }, { drive: () => { drove += 1 } }),
        (err) => err.reason === 'invalid-plan-rounds',
      )
      assert.equal(existsSync(join(home, '.crew')), false)
    })
    assert.equal(drove, 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('run plumbs a flagged budget, records defaults when absent, and the driver honors the override', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-plan-rounds-run-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-plan-rounds-run-home-'))
  const task = 'plan-rounds-run'
  execSync('git init -q', { cwd: checkout })
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# plan-rounds brief\n')
  const previousLedger = process.env.DEVTEAM_LEDGER_DB
  process.env.DEVTEAM_LEDGER_DB = join(home, 'ledger.db')
  const seen = []
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      const capture = (ctx) => { seen.push(ctx); return done }
      runCmd({ task, checkout, 'brief-file': brief, 'plan-rounds': '4', keep: true }, { drive: capture })
      runCmd({ task, checkout, 'brief-file': brief, keep: true }, { drive: capture })

      assert.deepEqual(seen[0].limits, { plan_rounds: 4 })
      assert.equal(Object.prototype.hasOwnProperty.call(seen[1], 'limits'), false)
      const rows = readFileSync(seen[0].journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
        .filter((row) => row.event === 'limits')
      assert.equal(rows.length, 2)
      assert.deepEqual({ plan_rounds: rows[0].plan_rounds, source: rows[0].source }, { plan_rounds: 4, source: 'flag' })
      assert.deepEqual({ plan_rounds: rows[1].plan_rounds, source: rows[1].source }, { plan_rounds: LIMITS.plan_rounds, source: 'default' })

      const stages = []
      const io = {
        assign: ({ role }) => ({ id: role, returnPath: role }),
        wait: (returnPath) => returnPath === 'planner'
          ? { status: 'insufficient', role: 'planner', summary: 'the brief leaves a gap', artifacts: [], details: {} }
          : { status: 'done', role: 'lead', summary: '', artifacts: [], details: { decision: 'bounce', reason: 'because', guidance: 'close the gap' } },
        writeFile: () => {}, readFile: () => null, run: () => ({ ok: true, output: '' }),
        changedFiles: () => [], commit: () => 'abc1234',
        log: (row) => { if (row && typeof row.stage === 'string') stages.push(row.stage) }, now: () => 0,
      }
      const result = driveTask(seen[0], io)
      assert.equal(stages.filter((stage) => stage.startsWith('plan:r')).length, 4)
      assert.match(result.details.escalation.why, /within 4 rounds/)
    })
  } finally {
    if (previousLedger === undefined) delete process.env.DEVTEAM_LEDGER_DB
    else process.env.DEVTEAM_LEDGER_DB = previousLedger
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('child entrypoint plumbs, journals, and refuses the plan-round budget', () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-plan-rounds-child-'))
  const crewDir = join(root, 'crew')
  const checkout = join(root, 'checkout')
  mkdirSync(crewDir, { recursive: true })
  mkdirSync(checkout, { recursive: true })
  mkdirSync(join(crewDir, 'returns'), { recursive: true })
  const brief = join(crewDir, 'brief.md')
  writeFileSync(brief, '# child plan-rounds brief\n')
  writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({
    schema_version: 3, task: 'child-plan-rounds', checkout,
    roles: ['lead', 'planner', 'builder', 'reviewer'],
    members: Object.fromEntries(['lead', 'planner', 'builder', 'reviewer'].map((role) => [role, {
      surface_id: null, pane_id: null, transport: 'headless-json', model: 'sonnet', agent: 'claude',
    }])),
    task_return: join('returns', 'task.json'),
  }))
  const makeRun = (plan_rounds) => {
    const rows = []
    let seen = null
    let drove = 0
    const io = {
      log: (row) => rows.push(row), assign: () => ({ id: 'x', returnPath: 'x' }), wait: () => null,
      writeFile: () => {}, readFile: () => null, run: () => ({ ok: true, output: '' }),
      changedFiles: () => [], commit: () => 'abc1234', now: () => 0,
    }
    const spec = { crew_dir: crewDir, task: 'child-plan-rounds', brief_file: brief, checkout, ...(plan_rounds === undefined ? {} : { plan_rounds }) }
    runChild(spec, {
      preflight: false, realIo: () => io,
      driveTask: (ctx) => { drove += 1; seen = ctx; return { status: 'done', summary: '', artifacts: [], details: {} } },
      env: { DEVTEAM_LEDGER_DB: join(crewDir, 'ledger.db') },
    })
    return { rows, seen, drove }
  }
  try {
    const flagged = makeRun(4)
    assert.deepEqual(flagged.seen.limits, { plan_rounds: 4 })
    assert.deepEqual({ plan_rounds: flagged.rows.find((row) => row.event === 'limits').plan_rounds, source: flagged.rows.find((row) => row.event === 'limits').source }, { plan_rounds: 4, source: 'flag' })
    const plain = makeRun(undefined)
    assert.equal(Object.prototype.hasOwnProperty.call(plain.seen, 'limits'), false)
    const plainRow = plain.rows.find((row) => row.event === 'limits')
    assert.deepEqual({ plan_rounds: plainRow.plan_rounds, source: plainRow.source }, { plan_rounds: LIMITS.plan_rounds, source: 'default' })
    let drove = 0
    assert.throws(() => runChild(
      { crew_dir: crewDir, task: 'child-plan-rounds', brief_file: brief, checkout, plan_rounds: '2.5' },
      { preflight: false, realIo: () => ({ log: () => {} }), driveTask: () => { drove += 1 }, env: { DEVTEAM_LEDGER_DB: join(crewDir, 'ledger.db') } },
    ), (err) => err.reason === 'invalid-plan-rounds')
    assert.equal(drove, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('crew CLI usage documents the per-run plan-round budget flag', () => {
  assert.match(readFileSync(new URL('./crew.mjs', import.meta.url), 'utf8'), /--plan-rounds/)
})

test('run refuses an inherited shape with no declared scope before driving', async () => {
  const inherited = VARIANT_NAMES.find((name) => VARIANTS[name]?.sources?.scope === 'inherited')
  const { root: checkoutRoot, checkout } = testCheckout('crew-scope-refusal-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-scope-refusal-home-'))
  const task = 'scope-refusal'
  execSync('git init -q', { cwd: checkout })
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# scope brief\n')
  let drove = 0
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      assert.throws(() => runCmd({ task, checkout, 'brief-file': brief, variant: inherited, keep: true }, { drive: () => { drove += 1 } }), (err) => err.message.includes('task.json'))
    })
    assert.equal(drove, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('run places explicit scope on ctx and omits it for a neutral shape', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-scope-ctx-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-scope-ctx-home-'))
  const task = 'scope-ctx'
  execSync('git init -q', { cwd: checkout })
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# scope brief\n')
  const previousLedger = process.env.DEVTEAM_LEDGER_DB
  process.env.DEVTEAM_LEDGER_DB = join(home, 'ledger.db')
  const seen = []
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  const inherited = VARIANT_NAMES.find((name) => VARIANTS[name]?.sources?.scope === 'inherited')
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      const capture = (ctx) => { seen.push(ctx); return done }
      runCmd({ task, checkout, 'brief-file': brief, variant: inherited, 'files-in-scope': 'a.mjs, a.test.mjs', keep: true }, { drive: capture })
      runCmd({ task, checkout, 'brief-file': brief, keep: true }, { drive: capture })
    })
    assert.deepEqual(seen[0].files_in_scope, ['a.mjs', 'a.test.mjs'])
    assert.equal(Object.prototype.hasOwnProperty.call(seen[1], 'files_in_scope'), false)
  } finally {
    if (previousLedger === undefined) delete process.env.DEVTEAM_LEDGER_DB
    else process.env.DEVTEAM_LEDGER_DB = previousLedger
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('run inheritance reaches the repair stage and planner assignment', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-scope-e2e-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-scope-e2e-home-'))
  const task = 'scope-e2e'
  execSync('git init -q', { cwd: checkout })
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# scope brief\n')
  const inherited = VARIANT_NAMES.find((name) => VARIANTS[name]?.sources?.scope === 'inherited')
  const filesInScope = ['a.mjs', 'a.test.mjs']
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      const crewDir = testCrewDir(home, checkout, task)
      writeFileSync(join(crewDir, 'returns', 'task.json'), JSON.stringify({ status: 'escalation', details: { files_in_scope: filesInScope } }))
      let seen
      runCmd({ task, checkout, 'brief-file': brief, variant: inherited, lane: 'lane-cmd', keep: true }, {
        drive: (ctx) => { seen = ctx; return { status: 'done', summary: '', artifacts: [], details: {} } },
      })
      const assigned = []
      const stages = []
      const io = {
        assign: ({ role }) => { assigned.push(role); return { id: role, returnPath: `${role}:1` } },
        wait: () => null, writeFile: () => {}, readFile: () => null,
        run: () => ({ ok: true, output: '' }), changedFiles: () => [], commit: () => 'abc1234',
        log: (entry) => { if (entry && typeof entry.stage === 'string') stages.push(entry.stage) }, now: () => 0,
      }
      try { driveTask(seen, io) } catch { /* stage and assignment labels are the evidence */ }
      assert.equal(stages[0], `${inherited}:r1`)
      assert.equal(assigned[0], 'planner')
    })
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }) }
})

test('run refuses an unknown variant before reading or writing crew state', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-variant-refusal-home-'))
  let drove = 0
  try {
    await withHome(home, () => {
      assert.throws(
        () => runCmd(
          { task: 'variant-never-booted', checkout: process.cwd(), 'brief-file': join(home, 'missing.md'), variant: 'no-such-shape' },
          { drive: () => { drove += 1 } },
        ),
        (err) => {
          assert.match(err.message, /unknown variant/)
          for (const name of VARIANT_NAMES) assert.match(err.message, new RegExp(name))
          return true
        },
      )
      assert.equal(drove, 0)
      assert.equal(existsSync(join(home, '.crew')), false)
    })
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('run passes a selected driver variant through ctx', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-variant-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-variant-home-'))
  const task = 'variant-selected'
  const variant = VARIANT_NAMES.find((name) => name !== DEFAULT_VARIANT)
  assert.ok(variant)
  execSync('git init -q', { cwd: checkout })
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# variant brief\n')
  const previousLedger = process.env.DEVTEAM_LEDGER_DB
  process.env.DEVTEAM_LEDGER_DB = join(home, 'ledger.db')
  let seen
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      runCmd(
        { task, checkout, 'brief-file': brief, variant, keep: true },
        { drive: (ctx) => { seen = ctx; return done } },
      )
    })
    const crew = JSON.parse(readFileSync(join(testCrewDir(home, checkout, task), 'crew.json'), 'utf8'))
    assert.equal(seen.variant, variant)
    assert.equal(seen.task, task)
    assert.equal(seen.checkout, checkout)
    assert.equal(seen.briefFile, brief)
    assert.deepEqual(seen.roles, crew.roles)
  } finally {
    if (previousLedger === undefined) delete process.env.DEVTEAM_LEDGER_DB
    else process.env.DEVTEAM_LEDGER_DB = previousLedger
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('run without a variant captures the same ctx as an explicit default', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-variant-default-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-variant-default-home-'))
  const task = 'variant-default'
  execSync('git init -q', { cwd: checkout })
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# variant brief\n')
  const previousLedger = process.env.DEVTEAM_LEDGER_DB
  process.env.DEVTEAM_LEDGER_DB = join(home, 'ledger.db')
  const seen = []
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      const capture = (ctx) => { seen.push(ctx); return done }
      runCmd({ task, checkout, 'brief-file': brief, variant: DEFAULT_VARIANT, keep: true }, { drive: capture })
      runCmd({ task, checkout, 'brief-file': brief, keep: true }, { drive: capture })
    })
    assert.equal(seen.length, 2)
    assert.equal(seen[1].variant, DEFAULT_VARIANT)
    assert.deepEqual(seen[1], seen[0])
  } finally {
    if (previousLedger === undefined) delete process.env.DEVTEAM_LEDGER_DB
    else process.env.DEVTEAM_LEDGER_DB = previousLedger
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('run resolves the repo protected paths and journals the basis', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-protected-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-protected-home-'))
  const factoryRoot = join(home, 'factory')
  const task = 'protected-run'
  const cell = {
    status: 'ratified', value: ['db/migrations/'], source: 'human',
    ratified_by: 'human', ratified_at: '2026-08-16T00:00:00.000Z',
  }
  execSync('git init -q', { cwd: checkout })
  protectedProfile(factoryRoot, checkout, cell)
  const previousFactory = process.env.DEVTEAM_FACTORY_DIR
  process.env.DEVTEAM_FACTORY_DIR = factoryRoot
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# brief\n')
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  let seen
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      runCmd({ task, checkout, 'brief-file': brief, keep: true }, { drive: (ctx) => { seen = ctx; return done } })
    })
    assert.ok(seen.protectedPaths.includes('db/migrations/'))
    for (const path of PROTECTED_PATHS) assert.ok(seen.protectedPaths.includes(path), `${path} missing from ctx`)
    const rows = readFileSync(seen.journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      .filter((row) => row.event === 'protected-paths')
    assert.equal(rows.length, 1)
    assert.match(rows[0].basis, /protected_paths_candidates/)
    assert.equal(rows[0].count, seen.protectedPaths.length)
  } finally {
    if (previousFactory === undefined) delete process.env.DEVTEAM_FACTORY_DIR
    else process.env.DEVTEAM_FACTORY_DIR = previousFactory
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('boot persists the fence and run rides it into ctx beside the protected paths', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-fence-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-fence-home-'))
  const register = join(home, 'fences.json')
  const brief = join(home, 'brief.md')
  const task = 'fence-slice1'
  const fenceArgs = {
    fences: register, lane: 'fence-slice1',
  }
  writeFileSync(register, JSON.stringify({ lanes: [
    { lane: 'intake-loop', files: ['scripts/factory/intake.mjs'] },
    { lane: 'fence-slice1', files: ['crew/crew.mjs', 'crew/crew.test.mjs'] },
  ] }))
  writeFileSync(brief, '# brief\n')
  execSync('git init -q', { cwd: checkout })
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  const seen = []
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath, ...fenceArgs },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      runCmd({ task, checkout, 'brief-file': brief, keep: true }, { drive: (ctx) => { seen.push(ctx); return done } })
      await bootCmd(
        { task: 'fence-plain', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      runCmd({ task: 'fence-plain', checkout, 'brief-file': brief, keep: true }, { drive: (ctx) => { seen.push(ctx); return done } })
    })
    const fencedDir = testCrewDir(home, checkout, task)
    const fencedCrew = JSON.parse(readFileSync(join(fencedDir, 'crew.json'), 'utf8'))
    assert.equal(fencedCrew.lane_name, 'fence-slice1')
    assert.deepEqual(fencedCrew.lane_fence, [{ lane: 'intake-loop', files: ['scripts/factory/intake.mjs'] }])
    assert.deepEqual(seen[0].laneFence, fencedCrew.lane_fence)
    assert.equal(seen[0].laneName, 'fence-slice1')
    for (const path of PROTECTED_PATHS) assert.ok(seen[0].protectedPaths.includes(path), `${path} missing from ctx`)
    const rows = readFileSync(seen[0].journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      .filter((row) => row.event === 'lane-fence')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].lane_name, 'fence-slice1')
    assert.equal(rows[0].lanes, 1)
    assert.equal(rows[0].files, 1)
    const plainCrew = JSON.parse(readFileSync(join(testCrewDir(home, checkout, 'fence-plain'), 'crew.json'), 'utf8'))
    assert.equal(Object.prototype.hasOwnProperty.call(plainCrew, 'lane_fence'), false)
    assert.equal(seen[1].laneFence, undefined)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('run refuses an unusable ratified protected-path cell before driving', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-protected-refusal-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-protected-refusal-home-'))
  const factoryRoot = join(home, 'factory')
  const task = 'protected-refusal'
  execSync('git init -q', { cwd: checkout })
  protectedProfile(factoryRoot, checkout, { status: 'ratified', value: ['db/migrations/'], source: 'human' })
  const previousFactory = process.env.DEVTEAM_FACTORY_DIR
  process.env.DEVTEAM_FACTORY_DIR = factoryRoot
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# brief\n')
  let drove = 0
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      assert.throws(
        () => runCmd({ task, checkout, 'brief-file': brief, keep: true }, { drive: () => { drove += 1 } }),
        (err) => err.reason === 'protected-paths-invalid' && err.message.includes('protected-paths-invalid'),
      )
    })
    assert.equal(drove, 0)
  } finally {
    if (previousFactory === undefined) delete process.env.DEVTEAM_FACTORY_DIR
    else process.env.DEVTEAM_FACTORY_DIR = previousFactory
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('crew CLI reads the closed variant set from drive.mjs without quoted shape literals', () => {
  const source = readFileSync(new URL('./crew.mjs', import.meta.url), 'utf8')
  for (const name of VARIANT_NAMES) {
    assert.doesNotMatch(source, new RegExp("(['\"`])" + name + "\\1"))
  }
  assert.match(source, /import\s*\{[^}]*VARIANT_NAMES[^}]*DEFAULT_VARIANT[^}]*\}\s*from '\.\/drive\.mjs'/)
})

test('all-headless tier boot makes no cmux calls and records daemon-acceptable seats', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-headless-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-headless-checkout-')
  const task = 'all-headless'
  const cmux = callCounter(); const tree = callCounter(); const renameTab = callCounter()
  try {
    await withHome(home, () => bootCmd(
      { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
      { cmux, tree, renameTab },
    ))
    assert.equal(cmux.calls.length, 0)
    assert.equal(tree.calls.length, 0)
    assert.equal(renameTab.calls.length, 0)
    const dir = testCrewDir(home, checkout, task)
    const crew = JSON.parse(readFileSync(join(dir, 'crew.json'), 'utf8'))
    assert.equal(crew.workspace_id, null)
    assert.equal(crew.window_id, null)
    const expected = { lead: 'headless-json', planner: 'headless-json', builder: 'headless-rpc', reviewer: 'headless-rpc' }
    assert.deepEqual(Object.fromEntries(crew.roles.map((role) => [role, crew.members[role].transport])), expected)
    for (const role of crew.roles) {
      assert.equal(crew.members[role].pane_id, null)
      assert.equal(crew.members[role].surface_id, null)
      assert.equal(existsSync(join(dir, 'task', `role-${role}.md`)), true)
      assert.ok(crew.members[role].transport && crew.members[role].transport !== 'pane')
    }
    const boot = readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).find((event) => event.event === 'boot')
    assert.deepEqual(Object.fromEntries(crew.roles.map((role) => [role, boot.allocation[role].transport])), expected)
    assert.equal(boot.allocation.lead.model, 'roster')

    // crew/daemon.mjs's paneSeat() is the consumer and must keep refusing pane transport.
    const daemonSource = readFileSync(new URL('./daemon.mjs', import.meta.url), 'utf8')
    assert.match(daemonSource, /daemon run refuses pane transport/)
    assert.match(daemonSource, /paneSeat/)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('tier boot with no breaker policy reads no ledger and omits breaker journal data', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-breaker-plain-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-breaker-plain-checkout-')
  const dbPath = join(home, 'ledger.db')
  const openLedger = callCounter()
  try {
    await withBreakerEnv({ DEVTEAM_LEDGER_DB: dbPath }, () => withHome(home, () => bootCmd(
      { task: 'breaker-plain', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), openLedger },
    )))
    const dir = testCrewDir(home, checkout, 'breaker-plain')
    assert.equal(existsSync(join(dir, 'crew.json')), true)
    assert.equal(openLedger.calls.length, 0)
    assert.equal(Object.hasOwn(bootRecord(dir), 'breaker'), false)
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }) }
})

test('a configured boot can pin a nonexistent ledger and skip an injected opener', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-breaker-missing-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-breaker-missing-checkout-')
  const dbPath = join(home, 'missing-ledger.db')
  const openLedger = fakeBreakerLedger([breakerRow({ failures: 1 })])
  try {
    await withBreakerEnv({ CREW_BREAKER_THRESHOLD: '1', DEVTEAM_LEDGER_DB: dbPath }, () => withHome(home, () => bootCmd(
      { task: 'breaker-missing', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), openLedger, existsSync: () => false },
    )))
    const breaker = bootRecord(testCrewDir(home, checkout, 'breaker-missing')).breaker
    assert.equal(breaker.verdict, 'closed')
    assert.equal(openLedger.calls.length, 0)
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }) }
})

test('an injected opener without existsSync reads rows and refuses before state or cmux seats exist', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-breaker-open-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-breaker-open-checkout-')
  const dbPath = join(home, 'ledger.db')
  writeFileSync(dbPath, 'fake ledger')
  const openLedger = fakeBreakerLedger([breakerRow({ failures: 3 })])
  const cmux = callCounter(); const tree = callCounter(); const renameTab = callCounter()
  try {
    const dir = testCrewDir(home, checkout, 'breaker-open')
    await withBreakerEnv({ CREW_BREAKER_THRESHOLD: '2', DEVTEAM_LEDGER_DB: dbPath }, () => withHome(home, () => assert.rejects(
      () => bootCmd(
        { task: 'breaker-open', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux, tree, renameTab, openLedger },
      ),
      (error) => {
        assert.equal(error.code, 'breaker-open')
        for (const value of ['gpt-5.6-luna', '--model-', '--agent-', '--tier']) assert.ok(error.message.includes(value), `missing ${value}`)
        return true
      },
    )))
    assert.equal(existsSync(dir), false)
    assert.equal(cmux.calls.length, 0)
    assert.equal(tree.calls.length, 0)
    assert.equal(renameTab.calls.length, 0)
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }) }
})

test('an unreadable breaker ledger refuses distinctly from an open cell', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-breaker-degraded-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-breaker-degraded-checkout-')
  const dbPath = join(home, 'ledger.db')
  writeFileSync(dbPath, 'fake ledger')
  const openLedger = fakeBreakerLedger([], { degraded: true })
  try {
    let error
    await withBreakerEnv({ CREW_BREAKER_THRESHOLD: '2', DEVTEAM_LEDGER_DB: dbPath }, () => withHome(home, () => assert.rejects(
      () => bootCmd(
        { task: 'breaker-degraded', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), openLedger },
      ),
      (candidate) => { error = candidate; return candidate.code === 'breaker-unmeasurable' },
    )))
    assert.equal(error.code, 'breaker-unmeasurable')
    assert.doesNotMatch(error.message, /breaker-open/)
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }) }
})

test('a below-threshold breaker verdict is journaled alongside allocation', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-breaker-healthy-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-breaker-healthy-checkout-')
  const dbPath = join(home, 'ledger.db')
  writeFileSync(dbPath, 'fake ledger')
  const openLedger = fakeBreakerLedger([breakerRow({ failures: 1 })])
  try {
    await withBreakerEnv({ CREW_BREAKER_THRESHOLD: '5', CREW_BREAKER_WINDOW_MS: '3600000', DEVTEAM_LEDGER_DB: dbPath }, () => withHome(home, () => bootCmd(
      { task: 'breaker-healthy', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), openLedger },
    )))
    const breaker = bootRecord(testCrewDir(home, checkout, 'breaker-healthy')).breaker
    assert.equal(breaker.verdict, 'degraded')
    assert.equal(breaker.threshold, 5)
    assert.equal(breaker.window_ms, 3600000)
    assert.ok(breaker.since)
    assert.ok(bootRecord(testCrewDir(home, checkout, 'breaker-healthy')).allocation)
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }) }
})

test('a breaker refusal records no cell failure of its own', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-breaker-self-feed-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-breaker-self-feed-checkout-')
  const dbPath = join(home, 'ledger.db')
  const seeded = openLedger({ dbPath, stderr: { write: () => {} } })
  seeded.cellFailures({ since: null })
  seeded.close()
  const fake = fakeBreakerLedger([breakerRow({ failures: 3 })])
  try {
    await withBreakerEnv({ CREW_BREAKER_THRESHOLD: '2', DEVTEAM_LEDGER_DB: dbPath }, () => withHome(home, () => assert.rejects(
      () => bootCmd(
        { task: 'breaker-self-feed', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), openLedger: fake },
      ),
      (error) => error.code === 'breaker-open',
    )))
    if (!nodeMeetsLedgerFloor) return
    const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
    assert.deepEqual(ledger.dumpTable('cell_failures'), [])
    ledger.close()
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }) }
})

// This replaces the transitional pin introduced with --headless-all, which
// recorded the mixed shape before the two modes were separated (#249 / ADR-033).
test('a mixed boot refuses with mixed-transport before any workspace or state dir exists', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-mixed-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-mixed-checkout-')
  const task = 'mixed'
  const cmux = callCounter()
  const paneRoles = ['lead', 'planner', 'reviewer']
  let treeCalls = 0
  const tree = (...args) => {
    tree.calls.push(args)
    treeCalls += 1
    if (treeCalls === 1) return { windows: [] }
    return { windows: [{ id: 'window-1', workspaces: [{ id: 'workspace-1', name: `crew-${task}`, panes: paneRoles.map((role) => ({ id: `pane-${role}`, surfaces: [{ id: `surface-${role}`, name: role }] })) }] }] }
  }
  tree.calls = []
  const renameTab = callCounter()
  try {
    await withHome(home, () => assert.rejects(
      () => bootCmd(
        { task, checkout, roles: 'lead,planner,builder,reviewer', headless: 'builder', 'claude-bin': process.execPath },
        { cmux, tree, renameTab },
      ),
      (err) => {
        assert.equal(err.code, 'mixed-transport')
        assert.match(err.message, /builder/)
        assert.match(err.message, /headless-json/)
        assert.match(err.message, /--headless-all/)
        assert.match(err.message, /\bpanes?\b/)
        return true
      },
    ))
    assert.equal(cmux.calls.length, 0)
    assert.equal(tree.calls.length, 0)
    assert.equal(existsSync(testCrewDir(home, checkout, task)), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('--headless-all with a per-seat transport flag still boots — no workspace, nothing to be invisible inside', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-mode-factory-seat-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-mode-factory-seat-checkout-')
  const task = 'mode-factory-seat'
  const cmux = callCounter()
  try {
    await withHome(home, () => bootCmd(
      { task, checkout, tier: 'build', 'headless-all': true, 'headless-rpc': 'builder', 'claude-bin': process.execPath },
      { cmux, tree: callCounter(), renameTab: callCounter() },
    ))
    const crew = JSON.parse(readFileSync(join(testCrewDir(home, checkout, task), 'crew.json'), 'utf8'))
    assert.equal(crew.workspace_id, null)
    assert.equal(crew.members.builder.transport, 'headless-rpc')
    for (const member of Object.values(crew.members)) assert.notEqual(member.transport, 'pane')
    assert.equal(cmux.calls.length, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('a missing memory budget value falls back to the default and records invalid-budget', () => {
  const cfg = memoryConfig({ 'memory-dir': '/tmp/crew-memory-fixture', 'memory-budget-bytes': true })
  assert.equal(cfg.budgetBytes, 8000)
  assert.equal(cfg.reason, 'invalid-budget')
})

test('unconfigured boot keeps every merged prompt byte-identical and omits memory journal data', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-memory-plain-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-memory-plain-checkout-')
  try {
    await withoutMemoryEnv(() => withHome(home, () => bootCmd(
      { task: 'memory-plain', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
    )))
    const dir = testCrewDir(home, checkout, 'memory-plain')
    const shared = readFileSync(new URL('./roles/_shared.md', import.meta.url), 'utf8')
    for (const role of ['lead', 'planner', 'builder', 'reviewer']) {
      const card = readFileSync(new URL(`./roles/${role}.md`, import.meta.url), 'utf8')
      assert.equal(readFileSync(join(dir, 'task', `role-${role}.md`), 'utf8'), `${shared}\n\n${card}`)
    }
    assert.equal(Object.hasOwn(bootRecord(dir), 'memory'), false)
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }) }
})

test('configured boot injects memory into lead and planner while builder and reviewer stay lean', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-memory-configured-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-memory-configured-checkout-')
  const fixture = memoryFixture()
  try {
    await withoutMemoryEnv(() => withHome(home, async () => {
      const base = { checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath }
      await bootCmd({ ...base, task: 'memory-plain' }, { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() })
      await bootCmd({ ...base, task: 'memory-armed', 'memory-dir': fixture }, { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() })
    }))
    const plain = testCrewDir(home, checkout, 'memory-plain')
    const armed = testCrewDir(home, checkout, 'memory-armed')
    for (const role of ['lead', 'planner']) {
      const prompt = readFileSync(join(armed, 'task', `role-${role}.md`), 'utf8')
      assert.match(prompt, /## Team memory/)
      assert.match(prompt, /first hook/)
    }
    for (const role of ['builder', 'reviewer']) {
      assert.equal(
        readFileSync(join(armed, 'task', `role-${role}.md`), 'utf8'),
        readFileSync(join(plain, 'task', `role-${role}.md`), 'utf8'),
      )
    }
    assert.deepEqual([...MEMORY_ROLES], ['lead', 'planner'])
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }); rmSync(fixture, { recursive: true, force: true }) }
})

test('configured boot with a missing memory directory succeeds and records no-dir', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-memory-missing-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-memory-missing-checkout-')
  const missing = join(home, 'not-present')
  try {
    await withoutMemoryEnv(() => withHome(home, () => bootCmd(
      { task: 'memory-missing', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath, 'memory-dir': missing },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
    )))
    const dir = testCrewDir(home, checkout, 'memory-missing')
    const shared = readFileSync(new URL('./roles/_shared.md', import.meta.url), 'utf8')
    for (const role of ['lead', 'planner', 'builder', 'reviewer']) {
      const card = readFileSync(new URL(`./roles/${role}.md`, import.meta.url), 'utf8')
      assert.equal(readFileSync(join(dir, 'task', `role-${role}.md`), 'utf8'), `${shared}\n\n${card}`)
    }
    assert.equal(bootRecord(dir).memory.reason, 'no-dir')
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }) }
})

test('unknown memory backend cannot fail boot and records its error', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-memory-backend-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-memory-backend-checkout-')
  const fixture = memoryFixture()
  try {
    await withoutMemoryEnv(() => withHome(home, () => bootCmd(
      { task: 'memory-backend', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath, 'memory-dir': fixture, 'memory-backend': 'no-such-backend' },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
    )))
    const dir = testCrewDir(home, checkout, 'memory-backend')
    const shared = readFileSync(new URL('./roles/_shared.md', import.meta.url), 'utf8')
    for (const role of ['lead', 'planner']) {
      const card = readFileSync(new URL(`./roles/${role}.md`, import.meta.url), 'utf8')
      assert.equal(readFileSync(join(dir, 'task', `role-${role}.md`), 'utf8'), `${shared}\n\n${card}`)
    }
    assert.match(bootRecord(dir).memory.error, /no-such-backend/)
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }); rmSync(fixture, { recursive: true, force: true }) }
})

test('configured boot journal records memory byte and inclusion/drop counts', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-memory-record-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-memory-record-checkout-')
  const fixture = memoryFixture()
  try {
    await withoutMemoryEnv(() => withHome(home, () => bootCmd(
      { task: 'memory-record', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath, 'memory-dir': fixture },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
    )))
    const record = bootRecord(testCrewDir(home, checkout, 'memory-record')).memory
    assert.equal(typeof record.bytes, 'number')
    assert.ok(record.bytes > 0)
    assert.equal(typeof record.included, 'number')
    assert.equal(typeof record.dropped, 'number')
    assert.deepEqual(record.injected, ['lead', 'planner'])
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }); rmSync(fixture, { recursive: true, force: true }) }
})

test('a tiny memory budget records dropped extracts even when no section is injected', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-memory-budget-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-memory-budget-checkout-')
  const fixture = memoryFixture()
  try {
    await withoutMemoryEnv(() => withHome(home, () => bootCmd(
      { task: 'memory-budget', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath, 'memory-dir': fixture, 'memory-budget-bytes': '1' },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
    )))
    const record = bootRecord(testCrewDir(home, checkout, 'memory-budget')).memory
    assert.deepEqual(record.injected, [])
    assert.equal(record.bytes, 0)
    assert.ok(record.dropped > 0)
    assert.equal(record.reason, null)
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }); rmSync(fixture, { recursive: true, force: true }) }
})

test('source tripwire names crew/daemon.mjs paneSeat and its pane refusal', () => {
  const daemonSource = readFileSync(new URL('./daemon.mjs', import.meta.url), 'utf8')
  assert.match(daemonSource, /daemon run refuses pane transport/)
  assert.match(daemonSource, /function paneSeat/)
  const testSource = readFileSync(new URL('./crew.test.mjs', import.meta.url), 'utf8')
  assert.match(testSource, /daemon\.mjs/)
  assert.match(testSource, /paneSeat/)
})

test('teardownCore skips all cmux closes without a workspace and still closes a real workspace', () => {
  const parent = mkdtempSync(join(tmpdir(), 'crew-teardown-'))
  const closeSurface = callCounter(); const closeWorkspace = callCounter()
  try {
    const dir = join(parent, 'headless')
    mkdirSync(dir, { recursive: true })
    const paths = { dir }
    const { archived } = teardownCore(paths, { workspace_id: null, members: { builder: { surface_id: null } } }, { closeSurface, closeWorkspace })
    assert.equal(existsSync(archived), true)
    assert.equal(closeSurface.calls.length, 0)
    assert.equal(closeWorkspace.calls.length, 0)

    const paned = join(parent, 'paned')
    mkdirSync(paned, { recursive: true })
    const { archived: second } = teardownCore({ dir: paned }, { workspace_id: 'workspace-1', members: { lead: { surface_id: null } } }, { closeSurface, closeWorkspace })
    assert.equal(existsSync(second), true)
    assert.equal(closeWorkspace.calls.length, 1)
    assert.deepEqual(closeWorkspace.calls[0], ['workspace-1'])
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

test('paneTeardownRows maps only positive death evidence to proven', () => {
  const crew = { members: {
    planner: { surface_id: 's-planner', transport: 'pane' },
    builder: { surface_id: 's-builder', transport: 'pane' },
    reviewer: { surface_id: 's-reviewer', transport: 'pane' },
    lead: { surface_id: null, transport: 'headless-rpc' },
  } }
  const probes = { 's-planner': false, 's-builder': true, 's-reviewer': null }
  const rows = paneTeardownRows(crew, { probe: (id) => probes[id], sleep: () => {} })
  assert.deepEqual(rows, [
    { role: 'planner', transport: 'pane', outcome: 'proven', reason: 'probe-dead', forced: false },
    { role: 'builder', transport: 'pane', outcome: 'failed', reason: 'probe-alive', forced: false },
    { role: 'reviewer', transport: 'pane', outcome: 'unproven', reason: 'probe-unknown', forced: false },
  ])
  assert.equal(rows.some((row) => row.role === 'lead'), false)
})

test('paneTeardownRows probes through the real paneAlive by default', () => {
  const live = paneTeardownRows({ members: { builder: { surface_id: 's-builder', transport: 'pane' } } }, {
    tree: () => ({ windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: 's-builder' }] }] }] }] }),
    locate: (_tree, id) => id === 's-builder' ? { id } : null,
    sleep: () => {}, polls: 2, intervalMs: 0,
  })
  assert.deepEqual(live[0], { role: 'builder', transport: 'pane', outcome: 'failed', reason: 'probe-alive', forced: false })

  const blind = paneTeardownRows({ members: { builder: { surface_id: 's-builder', transport: 'pane' } } }, {
    tree: () => { throw new Error('cmux unavailable') }, sleep: () => {}, polls: 2, intervalMs: 0,
  })
  assert.deepEqual(blind[0], { role: 'builder', transport: 'pane', outcome: 'unproven', reason: 'probe-unknown', forced: false })

  const gone = paneTeardownRows({ members: { builder: { surface_id: 's-builder', transport: 'pane' } } }, {
    tree: () => ({ windows: [] }), locate: () => null, sleep: () => {}, polls: 2, intervalMs: 0,
  })
  assert.deepEqual(gone[0], { role: 'builder', transport: 'pane', outcome: 'proven', reason: 'probe-dead', forced: false })
})

test('paneTeardownRows re-probes a bounded window before calling a seat failed', () => {
  const sequence = [true, false]
  let calls = 0
  const waits = []
  const settled = paneTeardownRows({ members: { builder: { surface_id: 's-builder', transport: 'pane' } } }, {
    probe: () => { calls += 1; return sequence.shift() }, sleep: (ms) => waits.push(ms),
  })
  assert.equal(settled[0].outcome, 'proven')
  assert.equal(calls, 2)
  assert.deepEqual(waits, [PANE_SETTLE_MS])

  let stubborn = 0
  const stubbornWaits = []
  const alive = paneTeardownRows({ members: { builder: { surface_id: 's-builder', transport: 'pane' } } }, {
    probe: () => { stubborn += 1; return true }, sleep: (ms) => stubbornWaits.push(ms),
  })
  assert.equal(alive[0].outcome, 'failed')
  assert.equal(stubborn, PANE_SETTLE_POLLS)
  assert.deepEqual(stubbornWaits, Array(PANE_SETTLE_POLLS - 1).fill(PANE_SETTLE_MS))
})

test('teardownCore records one seat_teardowns row per pane seat it closed', () => {
  const parent = mkdtempSync(join(tmpdir(), 'crew-teardown-record-'))
  const dir = join(parent, 'crew')
  mkdirSync(dir, { recursive: true })
  const emitted = []
  const journal = []
  try {
    const record = teardownCore({ dir }, { members: {
      planner: { surface_id: 's-planner', transport: 'pane' },
      builder: { surface_id: 's-builder', transport: 'pane' },
    } }, {
      closeSurface: () => true, closeWorkspace: () => true, renameSync: () => {},
      probe: () => false, sleep: () => {},
      io: { log: (row) => journal.push(row), emit: (event) => { emitted.push(event); return true } },
    })
    assert.deepEqual({ seats: record.seats.seats, proven: record.seats.proven, recorded: record.seats.recorded, record_failed: record.seats.record_failed }, { seats: 2, proven: 2, recorded: 2, record_failed: 0 })
    assert.deepEqual(emitted.map((event) => event.kind), ['seat-teardown', 'seat-teardown'])
    assert.deepEqual(emitted.map((event) => event.role).sort(), ['builder', 'planner'])
    assert.equal(journal.filter((row) => row.event === 'seat-teardown').length, 2)
    assert.equal(journal.filter((row) => row.event === 'seat-teardown-sweep').length, 1)
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

test('teardownCore probes after every close and before the archive', () => {
  const order = []
  const record = teardownCore({ dir: join(tmpdir(), 'crew-teardown-order-unused') }, { members: {
    planner: { surface_id: 's-planner', transport: 'pane' },
    builder: { surface_id: 's-builder', transport: 'pane' },
  } }, {
    closeSurface: (id) => { order.push(`close:${id}`) }, closeWorkspace: () => {},
    probe: (id) => { order.push(`probe:${id}`); return false }, sleep: () => {},
    renameSync: () => { order.push('rename') }, io: { log: () => {}, emit: () => true },
  })
  assert.equal(typeof record.archived, 'string')
  const probes = order.map((entry, index) => [entry, index]).filter(([entry]) => entry.startsWith('probe:')).map(([, index]) => index)
  const closes = order.map((entry, index) => [entry, index]).filter(([entry]) => entry.startsWith('close:')).map(([, index]) => index)
  assert.equal(probes.length, 2)
  assert.equal(closes.length, 2)
  assert.ok(Math.max(...closes) < Math.min(...probes))
  assert.ok(order.indexOf('rename') > Math.max(...probes))
})

test('teardownCore reports no pane sweep for a crew with no pane seat', () => {
  const parent = mkdtempSync(join(tmpdir(), 'crew-teardown-headless-'))
  const dir = join(parent, 'crew')
  mkdirSync(dir, { recursive: true })
  const journal = []
  try {
    const record = teardownCore({ dir }, { members: {
      builder: { surface_id: null, transport: 'headless-rpc' },
    } }, {
      closeSurface: () => true, closeWorkspace: () => {}, renameSync: () => {},
      probe: () => { throw new Error('surface-less seat must not be probed') },
      io: { log: (row) => journal.push(row), emit: () => true },
    })
    assert.equal(record.seats, null)
    assert.equal(journal.some((row) => row.event === 'seat-teardown-sweep'), false)
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

test('teardownCmd records every pane seat in the ledger and exits 0', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-teardown-ledger-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-teardown-ledger-checkout-')
  const task = 'teardown-ledger'
  const dir = testCrewDir(home, checkout, task)
  mkdirSync(join(dir, 'returns'), { recursive: true })
  mkdirSync(join(dir, 'task'), { recursive: true })
  writeFileSync(join(dir, 'crew.json'), JSON.stringify({
    schema_version: 3, task, checkout, workspace_id: null, roles: ['planner', 'builder'],
    members: {
      planner: { surface_id: 's-planner', transport: 'pane' },
      builder: { surface_id: 's-builder', transport: 'pane' },
    }, task_return: join(dir, 'returns', 'task.json'),
  }, null, 2))
  const dbPath = join(home, 'ledger.db')
  const previousDb = process.env.DEVTEAM_LEDGER_DB
  const savedExit = process.exitCode
  try {
    process.env.DEVTEAM_LEDGER_DB = dbPath
    process.exitCode = undefined
    let record
    await withHome(home, () => {
      record = teardownCmd({ task, checkout }, {
        closeSurface: () => true, closeWorkspace: () => true, probe: () => false, sleep: () => {},
      })
    })
    assert.deepEqual({ seats: record.seats.seats, proven: record.seats.proven, recorded: record.seats.recorded }, { seats: 2, proven: 2, recorded: 2 })
    assert.equal(process.exitCode, undefined)
    assert.equal(existsSync(record.archived), true)
    const sidecar = JSON.parse(readFileSync(join(record.archived, 'ledger', 'run.json'), 'utf8'))
    if (nodeMeetsLedgerFloor) {
      const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
      let rows
      try { rows = ledger.dumpTable('seat_teardowns') } finally { ledger.close() }
      assert.equal(rows.length, 2)
      assert.ok(rows.every((row) => row.adw_id === sidecar.adw_id && row.outcome === 'proven' && row.transport === 'pane'))
    }
  } finally {
    process.exitCode = savedExit
    if (previousDb === undefined) delete process.env.DEVTEAM_LEDGER_DB; else process.env.DEVTEAM_LEDGER_DB = previousDb
    rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('teardownCmd exits non-zero without proof of death or without a positive receipt', async () => {
  const branches = [
    { label: 'unproven', probe: () => null, key: 'unproven', expectedProven: 0, io: null },
    { label: 'failed', probe: () => true, key: 'failed', expectedProven: 0, io: null },
    { label: 'record-failed', probe: () => false, key: 'proven', expectedProven: 2, io: { log: () => {}, emit: () => false } },
  ]
  for (const branch of branches) {
    const home = mkdtempSync(join(tmpdir(), `crew-teardown-${branch.label}-home-`))
    const { root: checkoutRoot, checkout } = testCheckout(`crew-teardown-${branch.label}-checkout-`)
    const task = `teardown-${branch.label}`
    const dir = testCrewDir(home, checkout, task)
    mkdirSync(join(dir, 'returns'), { recursive: true })
    mkdirSync(join(dir, 'task'), { recursive: true })
    writeFileSync(join(dir, 'crew.json'), JSON.stringify({
      schema_version: 3, task, checkout, workspace_id: null, roles: ['planner', 'builder'],
      members: {
        planner: { surface_id: 's-planner', transport: 'pane' },
        builder: { surface_id: 's-builder', transport: 'pane' },
      }, task_return: join(dir, 'returns', 'task.json'),
    }, null, 2))
    const previousDb = process.env.DEVTEAM_LEDGER_DB
    const savedExit = process.exitCode
    try {
      process.env.DEVTEAM_LEDGER_DB = join(home, 'ledger.db')
      process.exitCode = 0
      let record
      await withHome(home, () => {
        const options = { closeSurface: () => true, closeWorkspace: () => true, probe: branch.probe, sleep: () => {} }
        if (branch.io) options.io = branch.io
        record = teardownCmd({ task, checkout }, options)
      })
      assert.equal(record.seats[branch.key], 2)
      assert.equal(record.seats.proven, branch.expectedProven)
      if (branch.io) {
        assert.equal(record.seats.recorded, 0)
        assert.equal(record.seats.record_failed, 2)
      } else assert.equal(record.seats.recorded, 2)
      assert.equal(process.exitCode, 1)
    } finally {
      process.exitCode = savedExit
      if (previousDb === undefined) delete process.env.DEVTEAM_LEDGER_DB; else process.env.DEVTEAM_LEDGER_DB = previousDb
      rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true })
    }
  }
})

test('awaitSeatsReady returns immediately without probing an all-headless crew', () => {
  const cmux = callCounter()
  awaitSeatsReady({ members: { lead: { surface_id: null }, builder: { surface_id: null } } }, 1, null, { cmux })
  assert.equal(cmux.calls.length, 0)
})

test('awaitSeatsReady tags every seat still pending when readiness times out', () => {
  let clock = 0
  assert.throws(
    () => awaitSeatsReady({ members: { builder: { surface_id: 'surface-builder' }, reviewer: { surface_id: 'surface-reviewer' } } }, 0, null, {
      cmux: () => ({ ok: false, stdout: '' }), now: () => ++clock, sleep: () => {},
    }),
    (err) => {
      assert.deepEqual(err.roles, ['builder', 'reviewer'])
      return true
    },
  )
})

test('seatLiveness reports headless and preserves pane probe values', () => {
  const probed = []
  const crew = { members: {
    lead: { surface_id: 'surface-lead' }, planner: { surface_id: 'surface-planner' }, builder: { surface_id: null },
  } }
  const alive = seatLiveness(crew, (surface) => { probed.push(surface); return surface === 'surface-lead' ? true : null })
  assert.deepEqual(alive, { lead: true, planner: null, builder: 'headless' })
  assert.deepEqual(probed, ['surface-lead', 'surface-planner'])
})

test('realIo status and showDoc make no cmux calls without a workspace and status still works with one', () => {
  const parent = mkdtempSync(join(tmpdir(), 'crew-realio-'))
  const paths = { dir: parent, taskDir: parent, returnsDir: join(parent, 'returns') }
  mkdirSync(paths.returnsDir, { recursive: true })
  const cmuxHeadless = callCounter()
  try {
    const headless = realIo({ workspace_id: null, window_id: null, members: { builder: { surface_id: null } } }, paths, parent, null, null, {}, { cmux: cmuxHeadless, tree: () => ({ windows: [] }) })
    headless.status('build')
    headless.showDoc(join(parent, 'plan.md'))
    assert.equal(cmuxHeadless.calls.length, 0)

    const cmuxPanes = callCounter()
    const paned = realIo({ workspace_id: 'workspace-1', window_id: 'window-1', members: { lead: { surface_id: 'surface-lead' } } }, paths, parent, null, null, {}, { cmux: cmuxPanes, tree: () => ({ windows: [] }) })
    paned.status('build')
    assert.equal(cmuxPanes.calls.length, 1)
    assert.equal(cmuxPanes.calls[0][0], 'set-status')
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

test('parkOnOutcome escalation parks a workspace-less crew with transport-role fallback keys', () => {
  const calls = []
  const crew = { roles: ['builder'], workspace_id: null, members: { builder: { pane_id: null, surface_id: null, transport: 'headless-rpc' } } }
  const result = parkOnOutcome({ status: 'escalation' }, {
    crew, runId: 'run-headless', dir: '/tmp/reclaim', reason: 'needs human',
    openStore: () => ({ mintPark: (spec) => { calls.push(spec); return { ok: true, park: { park_id: 'park-headless' } } } }),
  })
  assert.equal(result.park_id, 'park-headless')
  assert.equal(result.error, null)
  assert.deepEqual(calls[0].seats, [{ role: 'builder', sessionId: 'headless-rpc:builder', warm: false }])
})

const PI_SAMPLE = {
  role: 'builder', model: 'google/gemini-3-pro', promptFile: '/tmp/crew-task/role-builder.md',
  tools: 'Read,Edit,Write,Glob,Grep,Bash', deny: 'Task,Agent', taskDir: '/tmp/crew-task',
  bootBrief: 'Crew for task demo. Task dir /tmp/crew-task. Read your role in the system prompt, reply exactly ready: your-role, then wait.',
}

// assertCapabilities gates seat boot on these exact keys — a lie here silently unlocks seats the adapter cannot actually enforce.
test('the pane profiles satisfy boot capability checks while missing tool denial is refused', () => {
  assert.doesNotThrow(() => assertCapabilities('builder', 'claude', capabilitiesFor({ transport: 'pane' })))
  assert.doesNotThrow(() => assertCapabilities('builder', 'pi', piCapabilitiesFor({ transport: 'pane' })))
  assert.throws(
    () => assertCapabilities('builder', 'x', { prompt_file: true, unattended: true, effort: true, tool_deny: undefined }),
    (err) => /builder/.test(err.message) && /x/.test(err.message) && /tool_deny/.test(err.message),
  )
})

// Effort is an OPTIONAL, separate dimension on both adapters: absent it must
// change NOTHING (the claude byte-identity pin above already proves that
// side), and present it maps to each agent's own flag — never the pi
// ':<level>' model-string shorthand, which would entangle model id and
// effort in one unauditable string.
test('effort maps to claude --effort and pi --thinking; absent effort leaves both commands untouched', () => {
  const withEffort = seatCommand({ ...PI_SAMPLE, effort: 'xhigh' })
  assert.match(withEffort, /--effort "xhigh"/)
  assert.doesNotMatch(seatCommand(PI_SAMPLE), /--effort/)

  const piWith = piSeatCommand({ ...PI_SAMPLE, effort: 'high' })
  assert.match(piWith, /--thinking high/)
  assert.match(piWith, /--model google\/gemini-3-pro(\s|$)/, 'model id must stay untouched by effort')
  assert.doesNotMatch(piSeatCommand(PI_SAMPLE), /--thinking/)
})

// A crew seat is a persistent pane: --print exits after the boot brief and --no-session drops the session, so their absence is load-bearing.
test('adapter-pi.seatCommand carries every crew-supplied field and neither interactive-killing flag', () => {
  const cmd = piSeatCommand(PI_SAMPLE)
  assert.match(cmd, /DEVTEAM_WORKER=1/)
  assert.match(cmd, /CREW_ROLE=builder/)
  assert.match(cmd, /CREW_TASK_DIR="\/tmp\/crew-task"/)
  // deny "Task,Agent" translates to an empty pi tool list — pi has no
  // subagent tool at all, so the flag is omitted rather than sent empty.
  assert.doesNotMatch(cmd, /--exclude-tools/)
  assert.match(cmd, /--append-system-prompt "\/tmp\/crew-task\/role-builder\.md"/)
  // Pins the binary itself — nothing else in this suite fails if a copy-paste swaps 'pi' for another executable.
  assert.match(cmd, /(^|\s)pi(\s|$)/)
  // Anchored to the end and requires the closing quote: an unquoted or repositioned brief still needs to fail this.
  assert.match(cmd, /"Crew for task demo\..*wait\."$/)
  // Word-boundary regexes are mandatory here — a naive includes('-p ') matches --append-system-prompt and would fail a correct adapter.
  assert.doesNotMatch(cmd, /(^|\s)--print(\s|$)/)
  assert.doesNotMatch(cmd, /(^|\s)-p(\s|$)/)
  assert.doesNotMatch(cmd, /(^|\s)--no-session(\s|$)/)
})

test('adapter-pi.seatCommand translates a claude deny list into pi tool names', () => {
  const cmd = piSeatCommand({ ...PI_SAMPLE, role: 'planner', deny: 'Edit,NotebookEdit' })
  assert.match(cmd, /--exclude-tools "edit"/)
})

// --provider is never passed, qualified or bare: a real "Model not found" error on a bare miss beats a --provider google
// fallback silently narrowing the search and synthesizing a phantom google model that only warns, then dies on first message.
test('a provider-qualified model is passed through whole; a bare id is never narrowed to a provider', () => {
  const qualified = piSeatCommand({ ...PI_SAMPLE, model: 'google/gemini-3-pro' })
  assert.match(qualified, /--model google\/gemini-3-pro(\s|$)/)
  assert.doesNotMatch(qualified, /(^|\s)--provider(\s|$)/)

  const bare = piSeatCommand({ ...PI_SAMPLE, model: 'sonnet' })
  assert.doesNotMatch(bare, /(^|\s)--provider(\s|$)/)
  assert.match(bare, /--model sonnet(\s|$)/)
})

test('the plan viewer mounts window-scoped and never steals focus', () => {
  const args = docOpenArgs({ path: '/tmp/t/plan.md', workspaceId: 'ws-1', windowId: 'win-1' })
  assert.deepEqual(args, ['open', '/tmp/t/plan.md', '--workspace', 'ws-1', '--window', 'win-1', '--direction', 'down', '--focus', 'false'])
})

// --- roster tier resolution ---------------------------------------------------

test('resolveTier(mechanical) seats no lead and carries the builder cell verbatim', () => {
  const r = resolveTier(roster, 'mechanical', {})
  assert.deepEqual(r.roles, ['planner', 'builder', 'reviewer'])
  assert.equal(r.seats.lead, undefined)
  assert.deepEqual(r.seats.builder, { agent: 'pi', effort: 'max', provider: 'openai', id: 'gpt-5.6-luna', model: null })
})

test('resolveTier(judge) seats every role in canonical order, tech-lead last', () => {
  const r = resolveTier(roster, 'judge', {})
  assert.deepEqual(r.roles, ['lead', 'planner', 'builder', 'reviewer', 'tech-lead'])
})

test('resolveTier: per-seat flags override the roster cell and stay distinguishable from roster values', () => {
  const r = resolveTier(roster, 'build', { 'model-builder': 'raw-id', 'agent-builder': 'claude', 'effort-builder': 'max' })
  assert.equal(r.seats.builder.model, 'raw-id')
  assert.equal(r.seats.builder.agent, 'claude')
  assert.equal(r.seats.builder.effort, 'max')
  assert.deepEqual(r.sources.builder, { agent: 'override', model: 'override', effort: 'override' })
  assert.equal(r.sources.planner.model, 'roster')
})

test('resolveTier: an unknown tier throws naming the bad tier and the valid ones', () => {
  assert.throws(
    () => resolveTier(roster, 'nope', {}),
    (err) => /nope/.test(err.message) && ['mechanical', 'build', 'judge'].every((t) => err.message.includes(t)),
  )
})

test('resolveTier: an override naming a role the tier does not seat throws, naming the flag and the tier', () => {
  assert.throws(
    () => resolveTier(roster, 'mechanical', { 'model-lead': 'x' }),
    (err) => /model-lead/.test(err.message) && /mechanical/.test(err.message),
  )
})

test('modelString: claude passes the id through; pi namespaces by provider and refuses an unmapped one', () => {
  assert.equal(claudeModelString({ provider: 'anthropic', id: 'claude-opus-5' }), 'claude-opus-5')
  assert.equal(piModelString({ provider: 'openai', id: 'gpt-5.6-luna' }), 'openai-codex/gpt-5.6-luna')
  assert.equal(piModelString({ provider: 'anthropic', id: 'claude-opus-5' }), 'anthropic/claude-opus-5')
  assert.throws(
    () => piModelString({ provider: 'google', id: 'gemini-3-pro' }),
    (err) => /pi/.test(err.message) && /google/.test(err.message),
  )
})

test('resolveSeatModels: a fake adapters map proves translation, raw passthrough, and the no-modelString fallback', () => {
  const seats = {
    a: { agent: 'claude', effort: 'low', provider: 'anthropic', id: 'claude-opus-5', model: null },
    b: { agent: 'claude', effort: 'low', provider: 'anthropic', id: 'raw-passthrough', model: 'already-set' },
    c: { agent: 'claude', effort: 'low', provider: 'anthropic', id: 'bare-fallback', model: null },
  }
  const adapters = {
    a: { name: 'claude', adapter: { modelString: () => 'translated' } },
    b: { name: 'claude', adapter: { modelString: () => { throw new Error('must not be called on an override') } } },
    c: { name: 'claude', adapter: {} }, // no modelString
  }
  const out = resolveSeatModels(seats, adapters)
  assert.equal(out.a.model, 'translated')
  assert.equal(out.a.provider, 'anthropic')
  assert.equal(out.a.id, 'claude-opus-5')
  assert.equal(out.b.model, 'already-set')
  assert.equal(out.b.provider, null)
  assert.equal(out.b.id, null)
  assert.equal(out.c.model, 'bare-fallback')
})

test('resolveSeatModels: a --model-<role> override clears the roster cell it replaced and never guesses a provider (#161)', async () => {
  const claudeMod = await import('./adapters/adapter-claude.mjs')
  const piMod = await import('./adapters/adapter-pi.mjs')
  const resolved = resolveTier(roster, 'build', { 'agent-reviewer': 'claude', 'model-reviewer': 'opus' })
  const adapters = {
    lead: { name: 'claude', adapter: claudeMod },
    planner: { name: 'claude', adapter: claudeMod },
    builder: { name: 'pi', adapter: piMod },
    reviewer: { name: 'claude', adapter: claudeMod },
  }
  const out = resolveSeatModels(resolved.seats, adapters)
  // Effort is read from the roster cell, not pinned as a literal: these tests
  // are about what an OVERRIDE does, and a roster effort change is a policy
  // decision that must not read as a broken override contract.
  assert.deepEqual(out.reviewer, { agent: 'claude', effort: roster.tiers.build.reviewer.effort, provider: null, id: null, model: 'opus' })
  assert.equal(resolved.sources.reviewer.model, 'override')
})

test('resolveSeatModels: an agent-only override keeps the roster cell and translates it (#161)', async () => {
  const claudeMod = await import('./adapters/adapter-claude.mjs')
  const piMod = await import('./adapters/adapter-pi.mjs')
  const resolved = resolveTier(roster, 'build', { 'agent-reviewer': 'claude' })
  const adapters = {
    lead: { name: 'claude', adapter: claudeMod },
    planner: { name: 'claude', adapter: claudeMod },
    builder: { name: 'pi', adapter: piMod },
    reviewer: { name: 'claude', adapter: claudeMod },
  }
  const out = resolveSeatModels(resolved.seats, adapters)
  assert.deepEqual(out.reviewer, {
    agent: 'claude',
    effort: roster.tiers.build.reviewer.effort,
    provider: 'openai',
    id: 'gpt-5.6-terra',
    model: 'gpt-5.6-terra',
  })
})

test('resolveSeatModels end to end through the REAL adapters, on the real roster', async () => {
  const claudeMod = await import('./adapters/adapter-claude.mjs')
  const piMod = await import('./adapters/adapter-pi.mjs')
  const { seats } = resolveTier(roster, 'mechanical', {})
  const adapters = {
    planner: { name: 'claude', adapter: claudeMod },
    builder: { name: 'pi', adapter: piMod },
    reviewer: { name: 'pi', adapter: piMod },
  }
  const out = resolveSeatModels(seats, adapters)
  assert.equal(out.builder.model, 'openai-codex/gpt-5.6-luna')
  assert.equal(out.reviewer.model, 'openai-codex/gpt-5.6-terra')
  // Tracks the LIVE roster cell (planning floor, ratified 2026-08-13: the
  // planner seat is opus-grade at EVERY tier — never sonnet/haiku/luna).
  assert.equal(out.planner.model, 'claude-opus-5')
})

test('translateDeny covers every SEAT_DEFAULTS deny value, dedupes, and drops unknown names', () => {
  assert.deepEqual(translateDeny('Edit,NotebookEdit,Task,Agent'), ['edit'])
  assert.deepEqual(translateDeny('Edit,NotebookEdit'), ['edit'])
  assert.deepEqual(translateDeny('Task,Agent'), [])
  assert.deepEqual(translateDeny('Edit,Edit,NotebookEdit'), ['edit'])
  assert.deepEqual(translateDeny('Frobnicate'), [])
})

test('seatReadySignal: ready-reply beats chrome, chrome is a real fallback, and the echoed brief never fakes a ready reply', () => {
  assert.equal(seatReadySignal('ready: builder', 'builder'), 'ready-reply')
  assert.equal(seatReadySignal('$0.000 (sub)  gpt-5.6-luna • high', 'builder'), 'chrome')
  assert.equal(seatReadySignal('  ⏵⏵ bypass permissions on', 'lead'), 'chrome')
  assert.equal(seatReadySignal('x@host ~/repo %\n', 'lead'), null)
  const brief = 'Crew for task demo. Task dir /tmp. Read your role in the system prompt, reply exactly ready: your-role, then wait.'
  assert.equal(seatReadySignal(brief, 'builder'), null)
})

test('waitForEnvelope returns an envelope after polling and times out for a live seat', () => {
  let t = 0
  const now = () => t
  const sleep = (ms) => { t += ms }
  let polls = 0
  const env = waitForEnvelope({
    returnPath: '/tmp/return.json', timeoutS: 60, role: 'builder',
    readEnvelope: () => (++polls >= 3 ? { status: 'done' } : null),
    probeSeat: () => true, now, sleep,
  })
  assert.deepEqual(env, { status: 'done' })
  t = 0
  assert.equal(waitForEnvelope({
    returnPath: '/tmp/return.json', timeoutS: 15, role: 'builder',
    readEnvelope: () => null, probeSeat: () => true, now, sleep,
  }), null)
})

test('waitForEnvelope fast-fails after consecutive gone probes, but indeterminate probes time out', () => {
  let t = 0
  const now = () => t
  const sleep = (ms) => { t += ms }
  assert.throws(() => waitForEnvelope({
    returnPath: '/tmp/return.json', timeoutS: 1200, role: 'builder',
    readEnvelope: () => null, probeSeat: () => false, now, sleep,
  }), (err) => err.stage === 'seat-died' && /seat died: builder/.test(err.message) && t < 1200 * 1000)
  t = 0
  assert.equal(waitForEnvelope({
    returnPath: '/tmp/return.json', timeoutS: 60, role: 'builder',
    readEnvelope: () => null, probeSeat: () => null, now, sleep,
  }), null)
})

test('waitForEnvelope envelope wins at death time and liveness constants are integer exports', () => {
  let t = 0
  let probes = 0
  const env = waitForEnvelope({
    returnPath: '/tmp/return.json', timeoutS: 1200, role: 'builder',
    readEnvelope: () => (probes >= LIVENESS_MISSES_TO_DIE ? { status: 'done' } : null),
    probeSeat: () => { probes += 1; return false }, now: () => t, sleep: (ms) => { t += ms },
  })
  assert.deepEqual(env, { status: 'done' })
  assert.equal(probes, LIVENESS_MISSES_TO_DIE)
  for (const value of [WAIT_POLL_MS, LIVENESS_PROBE_MS, LIVENESS_MISSES_TO_DIE]) assert.equal(Number.isInteger(value), true)
})

test('assertSeats: a lead-less crew passes; a seated-but-missing lead or missing reviewer throws', () => {
  assert.doesNotThrow(() => assertSeats({ roles: ['planner', 'builder', 'reviewer'], members: { planner: {}, builder: {}, reviewer: {} } }))
  assert.throws(() => assertSeats({ roles: ['lead', 'planner', 'builder', 'reviewer'], members: { planner: {}, builder: {}, reviewer: {} } }))
  assert.throws(() => assertSeats({ roles: ['planner', 'builder'], members: { planner: {}, builder: {} } }))
})

test('a lead-less layout is still strictly binary, with the first seated role on the left', () => {
  const layout = composeLayout(['planner', 'builder', 'reviewer'], mk)
  assert.equal(assertBinary(layout), 3)
  assert.equal(layout.children[0].pane.surfaces[0].name, 'planner')
})

test('ROLE_ORDER is key-identical to SEAT_DEFAULTS — one truth for seating order and layout order', () => {
  assert.deepEqual([...ROLE_ORDER], Object.keys(SEAT_DEFAULTS))
})

test('phaseForStage maps every driver stage and defaults unknown labels to build', () => {
  const table = {
    'plan:r1': 'planning', 'check:r1': 'planning', 'scout:r1': 'planning', 'repair:r1': 'planning', 'envelope-accept': 'finish',
    'gate-baseline': 'build', 'gate-repair:1': 'build',
    'gate-reverify:1': 'build', 'scope-gate:r1': 'build', 'lane:r1': 'build', 'gate:r1': 'build',
    'review:pass': 'review', suite: 'finish', commit: 'finish', done: 'done', 'escalate:lane': 'escalation',
    'future:stage': 'build',
  }
  for (const [label, phase] of Object.entries(table)) assert.equal(phaseForStage(label), phase, label)
})

test('variant stage phase map stays aligned with the closed driver enum', () => {
  assert.equal(Object.isFrozen(VARIANT_STAGE_PHASES), true)
  const declaredHeads = new Set(Object.values(VARIANTS).flatMap((shape) => shape.stages))
  for (const key of Object.keys(VARIANT_STAGE_PHASES)) {
    assert.equal(VARIANT_NAMES.includes(key) || declaredHeads.has(key), true, key)
  }
  for (const name of VARIANT_NAMES) {
    if (name !== DEFAULT_VARIANT) assert.equal(typeof VARIANT_STAGE_PHASES[name], 'string', name)
  }
  assert.equal(phaseForStage('toString:r1'), 'build')
})

function adapterEvents() {
  return [
    { kind: 'stage', label: 'plan:r1' },
    { kind: 'assign', id: 'd1', role: 'planner', brief: '/tmp/brief' },
    { kind: 'envelope', id: 'd1', role: 'planner', status: 'done' },
    { kind: 'decision', decided: 'accept', why: 'green' },
    { kind: 'dissent', from: 'reviewer', recommendation: 'escalate', lead_decision: 'accept' },
    { kind: 'gate', name: 'gate:r1', attempt: 1, ok: false, cmd: 'gate-cmd', summary: { total: 3, failed: 3, errored: 0 } },
    { kind: 'attention', moment: 'gate', park_id: null, task: 'task', why: 'exhausted', artifacts: [] },
  ]
}

test('emitAdapter maps drive events to closed ledger vocabulary with explicit sequence', () => {
  let seq = 100
  const calls = { phases: [], events: [], gates: [] }
  const emitter = {
    adwId: 'adw-test',
    phaseTransition: (phase) => calls.phases.push(phase),
    emit: (fn) => fn({
      recordEvent: (event) => calls.events.push(event),
      recordGateResult: (event) => calls.gates.push(event),
    }, () => ++seq),
  }
  const adapter = emitAdapter(emitter)
  for (const event of adapterEvents()) adapter(event)
  adapter(null)
  adapter({ kind: 'unknown' })
  assert.ok(calls.phases.length >= 1)
  assert.ok(calls.events.length >= 5)
  for (const event of calls.events) {
    assert.ok(EVENT_TYPES.includes(event.type))
    assert.ok(Object.keys(event.payload).every((key) => PAYLOAD_KEYS[event.type].includes(key)))
    assert.equal(event.adw_id, 'adw-test')
    assert.equal(typeof event.seq, 'number')
  }
  assert.equal(calls.gates.length, 1)
  assert.deepEqual(calls.gates[0], {
    adw_id: 'adw-test', phase_id: null, gate_name: 'gate:r1', attempt: 1, ok: false,
    checks: [{ total: 3, failed: 3, errored: 0 }], violations: [], gate_generation: null, pristine: false,
  })
  assert.equal(calls.events.filter((event) => event.type === 'log').length, 2)
  assert.ok(calls.events.some((event) => event.type === 'log' && event.payload.level === 'warn'))
})


test('emitAdapter maps cell-failure events to the booted crew cell, with a null-cell fallback', () => {
  const calls = []
  const emitter = {
    adwId: 'adw-cell',
    phaseTransition: () => ({ phase_id: 9 }),
    emit: (fn) => fn({ recordEvent() {}, recordCellFailure: (row) => calls.push(row) }, () => 1),
  }
  const crew = {
    task: 'measure',
    members: { builder: { agent: 'claude', provider: 'anthropic', id: 'sonnet-id', model: 'sonnet', effort: 'high', transport: 'pane' } },
  }
  const adapter = emitAdapter(emitter, crew)
  adapter({ kind: 'stage', label: 'build:r1' })
  adapter({ kind: 'cell-failure', role: 'builder', id: 'd4', failure: 'seat-died', stage: 'seat-died', detail: 'pane gone' })
  assert.deepEqual(calls[0], {
    adw_id: 'adw-cell', task_slug: 'measure', phase_id: 9, dispatch_id: 'd4', role: 'builder',
    agent: 'claude', provider: 'anthropic', model_id: 'sonnet-id', model: 'sonnet', effort: 'high', transport: 'pane',
    kind: 'seat-died', stage: 'seat-died', detail: 'pane gone',
  })

  emitAdapter(emitter)({ kind: 'cell-failure', role: 'reviewer', failure: 'timeout' })
  assert.deepEqual(calls[1], {
    adw_id: 'adw-cell', task_slug: null, phase_id: null, dispatch_id: null, role: 'reviewer',
    agent: null, provider: null, model_id: null, model: null, effort: null, transport: null,
    kind: 'timeout', stage: null, detail: null,
  })
})

test('emitAdapter maps modifier attempts with transport and from/to cells, including null crew', () => {
  const calls = []
  const emitter = {
    adwId: 'adw-modifier',
    phaseTransition: () => ({ phase_id: 12 }),
    emit: (fn) => fn({ recordEvent() {}, recordModifierAttempt: (row) => calls.push(row) }, () => 1),
  }
  const crew = {
    task: 'modifier-task',
    members: { builder: { agent: 'pi', provider: 'openai', id: 'luna', model: 'gpt-luna', effort: 'max', transport: 'headless-rpc' } },
  }
  const adapter = emitAdapter(emitter, crew)
  adapter({ kind: 'stage', label: 'build:r1' })
  adapter({
    kind: 'modifier', modifier: 'failure-upgrade', bounce: 'lane', role: 'builder', outcome: 'applied',
    why: null, rung: 'mechanical→build', from: { provider: 'anthropic', id: 'old', model: 'sonnet', agent: 'claude', effort: 'high' },
    to: { provider: 'openai', id: 'new', model: 'gpt-new', agent: 'pi', effort: 'max' },
  })
  assert.deepEqual(calls[0], {
    adw_id: 'adw-modifier', task_slug: 'modifier-task', phase_id: 12, role: 'builder', modifier: 'failure-upgrade',
    bounce: 'lane', outcome: 'applied', why: null, rung: 'mechanical→build', transport: 'headless-rpc',
    from_provider: 'anthropic', from_model_id: 'old', from_model: 'sonnet', from_agent: 'claude', from_effort: 'high',
    to_provider: 'openai', to_model_id: 'new', to_model: 'gpt-new', to_agent: 'pi', to_effort: 'max',
  })
  assert.doesNotThrow(() => emitAdapter(emitter)({
    kind: 'modifier', modifier: 'failure-upgrade', bounce: 'gate', role: 'reviewer', outcome: 'transport',
  }))
  assert.deepEqual(calls[1], {
    adw_id: 'adw-modifier', task_slug: null, phase_id: null, role: 'reviewer', modifier: 'failure-upgrade',
    bounce: 'gate', outcome: 'transport', why: null, rung: null, transport: null,
    from_provider: null, from_model_id: null, from_model: null, from_agent: null, from_effort: null,
    to_provider: null, to_model_id: null, to_model: null, to_agent: null, to_effort: null,
  })
})

test('emitAdapter routes discrimination triples, review outcomes, and typed accept decisions', () => {
  const calls = { gates: [], discriminations: [], reviews: [], accepts: [], events: [] }
  const emitter = {
    adwId: 'adw-outcomes',
    phaseTransition: () => ({ phase_id: 9 }),
    emit: (fn) => fn({
      recordEvent: (event) => calls.events.push(event),
      recordGateResult: (event) => calls.gates.push(event),
      recordGateDiscrimination: (event) => calls.discriminations.push(event),
      recordReviewOutcome: (event) => calls.reviews.push(event),
      recordAcceptDecision: (event) => calls.accepts.push(event),
    }, () => 1),
  }
  const adapter = emitAdapter(emitter)
  adapter({ kind: 'stage', label: 'build:r1' })
  adapter({ kind: 'gate', name: 'gate:r1', attempt: 1, ok: true, generation: 2, pristine: true, summary: { total: 5, failed: 0, errored: 0 } })
  adapter({ kind: 'discrimination', generation: 2, verdict: 'proven', summary: { total: 5, failed: 5, errored: 0 }, note: 'proof' })
  adapter({ kind: 'envelope', id: 'reviewer1', role: 'reviewer', status: 'done', review: { verdict: 'changes-needed', must_fix: 2, should_fix: 1, consider: 0 } })
  adapter({ kind: 'envelope', id: 'builder1', role: 'builder', status: 'done' })
  adapter({
    kind: 'accept-decision', where: 'review-exhausted', outcome: 'escalated', findings_total: 2,
    residuals: [{ id: 'RV1-2', type: 'cosmetic', severity: 'should-fix' }],
    refuted: [{ id: 'RV1-1' }], unverified: [], errors: [{ id: 'RV1-1', why: 'bad decision' }],
  })

  assert.deepEqual(calls.gates[0], {
    adw_id: 'adw-outcomes', phase_id: 9, gate_name: 'gate:r1', attempt: 1, ok: true,
    checks: [{ total: 5, failed: 0, errored: 0 }], violations: [], gate_generation: 2, pristine: true,
  })
  assert.deepEqual(calls.discriminations[0], {
    adw_id: 'adw-outcomes', phase_id: 9, gate_generation: 2, verdict: 'proven',
    checks_total: 5, checks_failed: 5, checks_errored: 0, note: 'proof',
  })
  assert.deepEqual(calls.reviews, [{
    adw_id: 'adw-outcomes', phase_id: 9, dispatch_id: 'reviewer1', role: 'reviewer',
    verdict: 'changes-needed', must_fix: 2, should_fix: 1, consider: 0,
  }])
  assert.deepEqual(calls.accepts, [{
    adw_id: 'adw-outcomes', phase_id: 9, where: 'review-exhausted', outcome: 'escalated',
    findings_total: 2, residual_count: 1, refuted_count: 1, cosmetic_count: 1,
    unverified_count: 0, invalid_reasons: 'RV1-1: bad decision',
  }])
})

test('emitAdapter carries the phase cursor onto events and fails malformed cursors closed', () => {
  let seq = 0
  const events = []
  const emitter = {
    adwId: 'adw-phase-test',
    phaseTransition: () => ({ phase_id: 7 }),
    emit: (fn) => fn({ recordEvent: (event) => events.push(event) }, () => ++seq),
  }
  const adapter = emitAdapter(emitter)
  adapter({ kind: 'assign', id: 'before', role: 'planner' })
  adapter({ kind: 'stage', label: 'plan:r1' })
  adapter({ kind: 'assign', id: 'after', role: 'planner' })
  assert.equal(events[0].phase_id, null)
  assert.equal(events[1].phase_id, 7)

  const malformed = {
    adwId: 'adw-malformed-phase',
    phaseTransition: () => 42,
    emit: (fn) => fn({ recordEvent: (event) => events.push(event) }, () => ++seq),
  }
  assert.doesNotThrow(() => emitAdapter(malformed)({ kind: 'stage', label: 'build:r1' }))
  assert.equal(events.at(-1).phase_id, null)
})

test('real ledger agent events reference their distinct planning and build phases', { skip: !nodeMeetsLedgerFloor }, () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-phase-state-'))
  const dbPath = join(stateDir, 'ledger.db')
  try {
    const emitter = openRun({ stateDir, repoSlug: 'repo', taskSlug: 'phase-task', dbPath })
    emitter.startRun()
    const adapter = emitAdapter(emitter)
    for (const event of [
      { kind: 'stage', label: 'plan:r1' },
      { kind: 'assign', id: 'p1', role: 'planner' },
      { kind: 'envelope', id: 'p1', role: 'planner', status: 'done' },
      { kind: 'stage', label: 'build:r1' },
      { kind: 'assign', id: 'b1', role: 'builder' },
      { kind: 'envelope', id: 'b1', role: 'builder', status: 'done' },
    ]) adapter(event)
    emitter.endRun({ status: 'ok' })
    const ledger = openLedger({ dbPath })
    const rows = ledger.listEvents({ adw_id: emitter.adwId, limit: 100 })
    const phaseIds = new Set(ledger.dumpTable('phases').filter((row) => row.adw_id === emitter.adwId).map((row) => row.id))
    const agents = rows.filter((row) => row.type === 'agent_start' || row.type === 'agent_end')
    assert.equal(agents.length, 4)
    assert.ok(agents.every((row) => row.phase_id !== null && phaseIds.has(row.phase_id)))
    const planner = agents.find((row) => JSON.parse(row.payload_json).role === 'planner')
    const builder = agents.find((row) => JSON.parse(row.payload_json).role === 'builder')
    assert.notEqual(planner.phase_id, builder.phase_id)
    assert.equal(emitter.stats().dropped, 0)
    ledger.close()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a real ledger round trip mirrors the complete drive event set', { skip: !nodeMeetsLedgerFloor }, () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-emit-state-'))
  const dbPath = join(stateDir, 'ledger.db')
  try {
    const emitter = openRun({ stateDir, repoSlug: 'repo', taskSlug: 'task', dbPath })
    emitter.startRun()
    const adapter = emitAdapter(emitter)
    for (const event of adapterEvents()) adapter(event)
    emitter.endRun({ status: 'ok' })
    const ledger = openLedger({ dbPath })
    const rows = ledger.listEvents({ adw_id: emitter.adwId, limit: 100 })
    assert.ok(rows.length >= 4)
    assert.ok(ledger.dumpTable('phases').length >= 1)
    assert.equal(ledger.getSession(emitter.adwId).status, 'ok')
    assert.equal(emitter.stats().dropped, 0)
    ledger.close()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a real ledger round trip mirrors drive gate verdicts into distinct gate_results rows', { skip: !nodeMeetsLedgerFloor }, () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-gate-state-'))
  const dbPath = join(stateDir, 'ledger.db')
  try {
    const emitter = openRun({ stateDir, repoSlug: 'repo', taskSlug: 'gate-task', dbPath })
    emitter.startRun()
    const adapter = emitAdapter(emitter)
    const counts = {}
    const envelopes = {
      'planner:1': {
        status: 'done', role: 'planner', details: {
          plan_path: '/tmp/gate-task/plan.md', files_in_scope: ['a.mjs'],
          validation_lane: 'lane-cmd', gate_cmd: 'gate-cmd',
        },
      },
      'builder:1': { status: 'done', role: 'builder', details: { files_changed: ['a.mjs'], commit_message: 'feat: gate' } },
      'builder:2': { status: 'done', role: 'builder', details: { files_changed: ['a.mjs'], commit_message: 'feat: gate' } },
      'reviewer:1': { status: 'done', role: 'reviewer', details: { verdict: 'pass' } },
    }
    const io = {
      emit: adapter,
      assign({ role }) {
        counts[role] = (counts[role] || 0) + 1
        return { id: `${role}:${counts[role]}`, returnPath: `${role}:${counts[role]}` }
      },
      wait(path) { return envelopes[path] || null },
      writeFile() {}, readFile() { return null },
      run(cmd) {
        counts[cmd] = (counts[cmd] || 0) + 1
        if (cmd === 'gate-cmd') {
          return counts[cmd] === 1
            ? { ok: false, output: 'baseline\nGATE-SUMMARY {"total":3,"failed":3,"errored":0}' }
            : counts[cmd] === 2 ? { ok: false, output: 'red' } : { ok: true, output: 'green' }
        }
        return { ok: true, output: '' }
      },
      changedFiles() { return ['a.mjs'] },
      commit() { return 'abc1234' },
      log() {}, status() {}, now() { return 0 },
    }
    const ctx = {
      task: 'gate-task', briefFile: '/tmp/brief.md', taskDir: '/tmp/gate-task', checkout: '/tmp/repo',
      roles: ['lead', 'planner', 'builder', 'reviewer'], lane: null, suite: 'suite-cmd',
    }
    const result = driveTask({ ...ctx, limits: { gate_fails_to_triage: 3 } }, io)
    assert.equal(result.status, 'done')
    emitter.endRun({ status: 'ok' })
    const ledger = openLedger({ dbPath })
    const rows = ledger.dumpTable('gate_results').filter((row) => row.adw_id === emitter.adwId)
    assert.equal(rows.length, 3)
    assert.equal(new Set(rows.map((row) => `${row.gate_name}:${row.attempt}`)).size, 3)
    assert.equal(emitter.stats().dropped, 0)
    ledger.close()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a degraded emitter is inert for the adapter and drive', () => {
  const parent = mkdtempSync(join(tmpdir(), 'crew-emit-degraded-'))
  const stateFile = join(parent, 'not-a-dir')
  writeFileSync(stateFile, 'file')
  try {
    const emitter = openRun({ stateDir: stateFile, repoSlug: 'repo', taskSlug: 'task', dbPath: join(stateFile, 'ledger.db') })
    const adapter = emitAdapter(emitter)
    assert.doesNotThrow(() => adapterEvents().forEach((event) => adapter(event)))
    assert.ok(emitter.stats().dropped >= 0)

    const ctx = {
      task: 'degraded', briefFile: '/tmp/brief.md', taskDir: '/tmp/degraded-task', checkout: '/tmp/repo',
      roles: ['lead', 'planner', 'builder', 'reviewer'], lane: null, suite: 'suite-cmd',
    }
    const envelopes = {
      'planner:1': { status: 'done', role: 'planner', details: { plan_path: '/tmp/degraded-task/plan.md', files_in_scope: ['a.mjs', 'a.test.mjs'] } },
      'builder:1': { status: 'done', role: 'builder', details: { files_changed: ['a.mjs', 'a.test.mjs'], commit_message: 'feat: degraded' } },
      'reviewer:1': { status: 'done', role: 'reviewer', details: { verdict: 'pass' } },
    }
    const makeIo = (emit) => {
      const counts = {}
      const io = {
        assign({ role }) {
          counts[role] = (counts[role] || 0) + 1
          return { id: `${role}${counts[role]}`, returnPath: `${role}:${counts[role]}` }
        },
        wait(path) { return envelopes[path] || null },
        writeFile() {}, readFile() { return null },
        run() { return { ok: true, output: '' } },
        changedFiles() { return ['a.mjs', 'a.test.mjs'] },
        commit() { return 'abc1234' },
        log() {}, now() { return 0 },
      }
      if (emit) io.emit = emit
      return io
    }
    const plain = driveTask(ctx, makeIo())
    const degraded = driveTask(ctx, makeIo(adapter))
    assert.deepEqual(degraded, plain)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('package, crew, child, and CI test lanes stay identical and bounded', () => {
  const packagePath = new URL('../package.json', import.meta.url)
  const crewPath = new URL('./crew.mjs', import.meta.url)
  const childPath = new URL('./child.mjs', import.meta.url)
  const workflowPath = new URL('../.github/workflows/test.yml', import.meta.url)
  const packageLane = JSON.parse(readFileSync(packagePath, 'utf8')).scripts?.test
  const crewMatch = readFileSync(crewPath, 'utf8').match(/suite:\s*args\.suite\s*\|\|\s*'([^']*)'/)
  const childMatch = readFileSync(childPath, 'utf8').match(/suite:\s*spec\.suite\s*\|\|\s*'([^']*)'/)
  const workflowRuns = [...readFileSync(workflowPath, 'utf8').matchAll(/^\s*-\s*run:\s*(.+?)\s*$/gm)].map((match) => match[1])
  const agreement = 'package.json scripts.test, crew/crew.mjs default, crew/child.mjs default, and .github/workflows/test.yml CI lane must be changed together'

  assert.ok(crewMatch, `expected the crew.mjs default suite in ${crewPath}`)
  assert.ok(childMatch, `expected the child.mjs default suite in ${childPath}`)
  assert.equal(crewMatch[1], packageLane, agreement)
  assert.equal(childMatch[1], packageLane, agreement)
  assert.ok(workflowRuns.some((run) => /^npm (run )?test$/.test(run)), `expected npm test in ${workflowPath}`)
  assert.ok(!workflowRuns.some((run) => /^node\s+--test\b/.test(run)), `CI must not invoke raw node --test in ${workflowPath}`)

  const timeout = packageLane?.match(/--test-timeout=(\d+)/)
  assert.ok(timeout, `expected --test-timeout in package.json scripts.test at ${packagePath}`)
  assert.ok(Number(timeout[1]) >= 30000, `expected package.json scripts.test timeout >= 30000ms at ${packagePath}`)
})

// --- capability register ----------------------------------------------------

function capabilityRegister(overrides = {}) {
  const grant = (extra = {}) => ({ tools: [], extensions: [], agents: [], skills: [], advisor: false, requires: [], ...extra })
  const base = {
    schema_version: 1,
    updated_at: '2026-08-17',
    roles: {
      lead: grant(), planner: grant({ requires: ['subagents'] }), builder: grant(),
      reviewer: grant(), 'tech-lead': grant(),
    },
    local_providers: {},
  }
  return { ...base, ...overrides, roles: { ...base.roles, ...(overrides.roles || {}) } }
}

function capabilityFixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'crew-capability-'))
  mkdirSync(join(root, 'crew', 'pi', 'skills'), { recursive: true })
  writeFileSync(join(root, 'crew', 'pi', 'fanout.js'), '// extension\n')
  writeFileSync(join(root, 'crew', 'pi', 'skills', 'scout.md'), '# skill\n')
  writeFileSync(join(root, 'crew', 'pi', 'explore.json'), JSON.stringify({ name: 'Explore', prompt: 'scout' }))
  return root
}

test('a charter requirement unmet by adapter and register refuses to boot from the closed reason set', async () => {
  const root = capabilityFixtureRoot()
  try {
    await assert.rejects(
      () => resolveAdapters(['planner'], { 'agent-planner': 'pi' }, null, { register: capabilityRegister(), root }),
      (err) => {
        assert.equal(err.reason, 'capability-shortfall')
        assert.match(err.message, /planner/)
        assert.match(err.message, /subagents/)
        assert.match(err.message, /pi/)
        return true
      },
    )
    const builderRequires = capabilityRegister({ roles: { builder: { ...capabilityRegister().roles.builder, requires: ['subagents'] } } })
    await assert.rejects(
      () => resolveAdapters(['builder'], { 'agent-builder': 'pi' }, null, { register: builderRequires, root }),
      (err) => err.reason === 'capability-shortfall' && /builder/.test(err.message) && /subagents/.test(err.message) && /pi/.test(err.message),
    )
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a grant not present in the register refuses to reach an adapter', () => {
  assert.match(readFileSync(new URL('./crew.mjs', import.meta.url), 'utf8'), /assertGrantsBacked\(role, grants, registry\)/)
  const register = capabilityRegister()
  const smuggled = {
    tools: ['task'], extensions: [], agents: [{ name: 'Explore', def: 'crew/pi/explore.json' }],
    skills: [], advisor: false, requires: [],
  }
  assert.throws(
    () => assertGrantsBacked('planner', smuggled, register),
    (err) => err.reason === 'unknown-grant' && /planner/.test(err.message) && /task/.test(err.message),
  )
  const backed = capabilityRegister({ roles: {
    planner: { ...register.roles.planner, tools: ['task'], agents: [{ name: 'Explore', def: 'crew/pi/explore.json' }] },
  } })
  assert.doesNotThrow(() => assertGrantsBacked('planner', smuggled, backed))
})

test('a register-backed pi fan-out bundle resolves to absolute definitions and reaches the command', async () => {
  const root = capabilityFixtureRoot()
  try {
    const base = capabilityRegister()
    const register = capabilityRegister({ roles: {
      planner: { ...base.roles.planner, extensions: ['crew/pi/fanout.js'], agents: [{ name: 'Explore', def: 'crew/pi/explore.json' }] },
    } })
    const resolved = await resolveAdapters(['planner'], { 'agent-planner': 'pi' }, null, { register, root })
    assert.equal(resolved.planner.name, 'pi')
    assert.equal(resolved.planner.grants.extensions[0], join(root, 'crew/pi/fanout.js'))
    assert.equal(resolved.planner.grants.agents[0].def, join(root, 'crew/pi/explore.json'))
    assert.equal(resolved.planner.grants.agents[0].name, 'Explore')
    assert.equal(resolved.planner.adapter.capabilitiesFor({ transport: 'pane', grants: resolved.planner.grants }).subagents, true)
    const command = resolved.planner.adapter.seatCommand({
      role: 'planner', model: 'openai-codex/gpt-5.6-luna', promptFile: '/tmp/role-planner.md',
      tools: SEAT_DEFAULTS.planner.tools, deny: SEAT_DEFAULTS.planner.deny, taskDir: '/tmp', bootBrief: 'boot', grants: resolved.planner.grants,
    })
    assert.ok(command.includes(`-e "${join(root, 'crew/pi/fanout.js')}"`))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('capabilitiesFor remains pinned without grants and derives pi subagents only from agent grants', async () => {
  const piPane = piCapabilitiesFor({ transport: 'pane' })
  assert.deepEqual({ ...piPane }, { prompt_file: true, tool_deny: true, unattended: true, subagents: false, effort: true, local_provider: true, interjection: 'none', abort: 'none', session_resume: false, durable_cursor: 'none', reassign: true })
  assert.equal(Object.isFrozen(piPane), true)
  assert.equal(piCapabilitiesFor({ transport: 'pane', grants: { agents: [{ name: 'Explore', def: '/tmp/explore.json' }] } }).subagents, true)
})

test('capability register validation is closed, non-vacuous, and enforced at load', () => {
  const schema = JSON.parse(readFileSync(new URL('./capabilities.schema.json', import.meta.url), 'utf8'))
  const shipped = JSON.parse(readFileSync(new URL('./capabilities.json', import.meta.url), 'utf8'))
  assert.deepEqual(validateCapabilities(schema, shipped), [])
  const negative = JSON.parse(JSON.stringify(shipped))
  delete negative.roles.builder
  assert.ok(validateCapabilities(schema, negative).length > 0)
  for (const mutate of [
    (value) => { value.roles.planner.sneaky = true },
    (value) => { value.sneaky = true },
    (value) => { value.schema_version = 99 },
    (value) => { delete value.roles.builder },
  ]) {
    const bad = JSON.parse(JSON.stringify(shipped))
    mutate(bad)
    assert.throws(() => loadCapabilities({ register: bad }), (err) => err.reason === 'register-invalid' && /register-invalid/.test(err.message))
  }
  const loaded = loadCapabilities()
  assert.equal(Object.isFrozen(loaded), true)
  assert.equal(Object.isFrozen(loaded.roles.planner), true)
})

test('grantsFor fails closed for missing paths and invalid definitions, and resolves valid grants', () => {
  const root = capabilityFixtureRoot()
  try {
    writeFileSync(join(root, 'crew', 'pi', 'bad-json.json'), '{not-json')
    writeFileSync(join(root, 'crew', 'pi', 'wrong-name.json'), JSON.stringify({ name: 'Other', prompt: 'x' }))
    writeFileSync(join(root, 'crew', 'pi', 'no-prompt.json'), JSON.stringify({ name: 'Explore' }))
    const cases = [
      ['extension-missing', (register) => { register.roles.builder.extensions = ['crew/pi/nope.js'] }],
      ['unknown-skill', (register) => { register.roles.builder.skills = ['crew/pi/skills/nope.md'] }],
      ['agent-def-invalid', (register) => { register.roles.builder.agents = [{ name: 'Explore', def: 'crew/pi/nope.json' }] }],
      ['agent-def-invalid', (register) => { register.roles.builder.agents = [{ name: 'Explore', def: 'crew/pi/bad-json.json' }] }],
      ['agent-def-invalid', (register) => { register.roles.builder.agents = [{ name: 'Explore', def: 'crew/pi/wrong-name.json' }] }],
      ['agent-def-invalid', (register) => { register.roles.builder.agents = [{ name: 'Explore', def: 'crew/pi/no-prompt.json' }] }],
    ]
    for (const [reason, mutate] of cases) {
      const register = capabilityRegister()
      mutate(register)
      assert.throws(() => grantsFor(register, 'builder', { root }), (err) => err.reason === reason && /at /.test(err.message))
    }
    const valid = capabilityRegister({ roles: {
      builder: { ...capabilityRegister().roles.builder,
        extensions: ['crew/pi/fanout.js'], skills: ['crew/pi/skills/scout.md'],
        agents: [{ name: 'Explore', def: 'crew/pi/explore.json' }],
      },
    } })
    const grants = grantsFor(valid, 'builder', { root })
    assert.deepEqual(grants.extensions, [join(root, 'crew/pi/fanout.js')])
    assert.deepEqual(grants.skills, [join(root, 'crew/pi/skills/scout.md')])
    assert.deepEqual(grants.agents, [{ name: 'Explore', def: join(root, 'crew/pi/explore.json') }])
    assert.equal(Object.isFrozen(grants), true)
    assert.equal(Object.isFrozen(grants.extensions), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('capability refusal reasons are closed and EMPTY_GRANTS is frozen', () => {
  assert.equal(Object.isFrozen(CAPABILITY_REFUSALS), true)
  assert.deepEqual([...CAPABILITY_REFUSALS], ['register-invalid', 'capability-shortfall', 'unknown-grant', 'grant-unsupported', 'extension-missing', 'unknown-skill', 'agent-def-invalid', 'local-settings-missing', 'local-endpoint-dead'])
  assert.throws(() => refuse('not-a-capability-reason', 'bad'))
  assert.throws(
    () => seatCommand({ role: 'builder', model: 'sonnet', promptFile: '/tmp/role.md', tools: 'Read', deny: 'Task,Agent', taskDir: '/tmp', bootBrief: 'boot', grants: { tools: [], extensions: ['/tmp/ext.js'], skills: [], agents: [], advisor: false } }),
    (err) => err.reason === 'grant-unsupported' && /grant-unsupported/.test(err.message),
  )
  assert.deepEqual(EMPTY_GRANTS, { tools: [], extensions: [], agents: [], skills: [], advisor: false, requires: [] })
  assert.equal(Object.isFrozen(EMPTY_GRANTS), true)
})

test('checkout-pinned local providers require live endpoints and expose their settings directory', async () => {
  const root = capabilityFixtureRoot()
  try {
    const settings = join(root, 'crew/pi/settings.json')
    writeFileSync(settings, '{}')
    const register = capabilityRegister({ local_providers: {
      'local-pi': { settings: 'crew/pi/settings.json', pi_provider: 'local-pi', base_url: 'http://127.0.0.1:11434/v1' },
    } })
    const seats = { builder: { agent: 'pi', effort: 'max', provider: 'local-pi', id: 'qwen3-coder', model: null } }
    await assert.rejects(
      () => resolveAdapters(['builder'], {}, seats, { register, root, probeEndpoint: async () => false }),
      (err) => err.reason === 'local-endpoint-dead' && /local-pi/.test(err.message),
    )
    const adapters = await resolveAdapters(['builder'], {}, seats, { register, root, probeEndpoint: async () => true })
    assert.equal(adapters.builder.configDir, dirname(settings))
    assert.equal(resolveSeatModels(seats, adapters, register.local_providers).builder.model, 'local-pi/qwen3-coder')

    const missing = capabilityRegister({ local_providers: {
      'local-pi': { settings: 'crew/pi/no-settings.json', pi_provider: 'local-pi', base_url: 'http://127.0.0.1:11434/v1' },
    } })
    await assert.rejects(
      () => resolveAdapters(['builder'], {}, seats, { register: missing, root, probeEndpoint: async () => true }),
      (err) => err.reason === 'local-settings-missing' && /no-settings/.test(err.message),
    )
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('resolveAdapters refuses a claude-seated local-provider cell before any seat spawns', async () => {
  const root = capabilityFixtureRoot()
  try {
    const settings = join(root, 'crew/pi/settings.json')
    writeFileSync(settings, '{}')
    const register = capabilityRegister({ local_providers: {
      'local-pi': { settings: 'crew/pi/settings.json', pi_provider: 'local-pi', base_url: 'http://127.0.0.1:11434/v1' },
    } })
    const seats = { builder: { agent: 'claude', effort: 'max', provider: 'local-pi', id: 'qwen3-coder', model: null } }
    await assert.rejects(
      () => resolveAdapters(['builder'], {}, seats, { register, root, probeEndpoint: async () => true }),
      (err) => err.reason === 'grant-unsupported'
        && /builder/.test(err.message) && /local-pi/.test(err.message) && /claude/.test(err.message),
    )
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('adapter-claude refuses local-provider model and config seams while preserving normal cells', () => {
  const localProviders = { 'local-pi': { pi_provider: 'local-pi' } }
  assert.throws(
    () => claudeModelString({ provider: 'local-pi', id: 'qwen3-coder', localProviders }),
    (err) => err.reason === 'grant-unsupported' && /local-pi/.test(err.message),
  )
  assert.equal(claudeModelString({ provider: 'anthropic', id: 'claude-opus-5', localProviders }), 'claude-opus-5')

  const seat = {
    role: 'builder', model: 'sonnet', promptFile: '/tmp/role-builder.md', tools: 'Read', deny: 'Task,Agent',
    taskDir: '/tmp/task', bootBrief: 'boot',
  }
  const refusal = (err) => err.reason === 'grant-unsupported' && /\/checkout\/crew\/pi/.test(err.message)
  assert.throws(() => seatCommand({ ...seat, configDir: '/checkout/crew/pi' }), refusal)
  assert.throws(() => claudeHeadlessCommand({
    ...seat, prompt: 'go', sessionId: 's1', bin: '/usr/local/bin/claude', configDir: '/checkout/crew/pi',
  }), refusal)
})

test('adapter-claude grant tools merge into allowedTools without widening disallowedTools', () => {
  const grants = { tools: ['mcp__search'], extensions: [], agents: [], skills: [], advisor: false }
  const seat = {
    role: 'builder', model: 'sonnet', promptFile: '/tmp/role-builder.md', tools: 'Read', deny: 'Task,Agent',
    taskDir: '/tmp/task', bootBrief: 'boot', grants,
  }
  const pane = seatCommand(seat)
  assert.match(pane, /--allowedTools "Read,mcp__search"/)
  assert.match(pane, /--disallowedTools "Task,Agent"/)
  assert.doesNotMatch(pane, /--disallowedTools "[^"]*mcp__search/)

  const headless = claudeHeadlessCommand({
    ...seat, prompt: 'go', sessionId: 's1', bin: '/usr/local/bin/claude',
  })
  const args = headless.args.join(' ')
  assert.match(args, /--allowedTools Read,mcp__search/)
  assert.match(args, /--disallowedTools Task,Agent/)
  assert.doesNotMatch(args, /--disallowedTools [^ ]*mcp__search/)
})

test('register-backed grants flow into one emitted pi command', () => {
  const root = capabilityFixtureRoot()
  try {
    const register = capabilityRegister({ roles: {
      builder: { ...capabilityRegister().roles.builder,
        tools: ['task'], extensions: ['crew/pi/fanout.js'], skills: ['crew/pi/skills/scout.md'],
      },
    } })
    const grants = grantsFor(register, 'builder', { root })
    const command = piSeatCommand({ ...PI_SAMPLE, grants })
    assert.match(command, /--tools "[^"]*,task"/)
    assert.ok(command.includes(`-e "${join(root, 'crew/pi/fanout.js')}"`))
    assert.ok(command.includes(`--skill "${join(root, 'crew/pi/skills/scout.md')}"`))
    assert.doesNotMatch(command, /--no-skills/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('probeLocalEndpoint never throws and rejects only failures and 5xx responses', async () => {
  assert.equal(await probeLocalEndpoint('http://injected/ok', { fetchFn: async () => ({ status: 200 }) }), true)
  assert.equal(await probeLocalEndpoint('http://injected/client-error', { fetchFn: async () => ({ status: 404 }) }), true)
  assert.equal(await probeLocalEndpoint('http://injected/server-error', { fetchFn: async () => ({ status: 503 }) }), false)
  assert.equal(await probeLocalEndpoint('http://injected/throw', { fetchFn: async () => { throw new Error('offline') } }), false)
})

test('the shipped register is where the fan-out grant lives', async () => {
  const register = loadCapabilities()
  assert.deepEqual(Object.keys(register.roles), ROLE_ORDER)
  for (const role of ROLE_ORDER) {
    assert.deepEqual(register.roles[role].requires, SEAT_DEFAULTS[role].requires)
    assert.deepEqual(register.roles[role].tools, ['planner', 'reviewer'].includes(role) ? ['Task'] : [])
    assert.deepEqual(register.roles[role].extensions, [])
    assert.deepEqual(register.roles[role].agents, [])
    assert.deepEqual(register.roles[role].skills, [])
    assert.equal(register.roles[role].advisor, false)
  }
  for (const tier of Object.keys(roster.tiers)) {
    const { roles, seats } = resolveTier(roster, tier, {})
    await assert.doesNotReject(() => resolveAdapters(roles, {}, seats), `tier ${tier} must boot with shipped capabilities`)
  }
})

test('SEAT_DEFAULTS leaves fan-out grants to the register while preserving denials and requirements', () => {
  assert.doesNotMatch(SEAT_DEFAULTS.planner.tools, /Task/)
  assert.doesNotMatch(SEAT_DEFAULTS.reviewer.tools, /Task/)
  for (const role of ['lead', 'builder', 'tech-lead']) {
    for (const tool of FANOUT_TOOLS) assert.match(SEAT_DEFAULTS[role].deny, new RegExp(tool))
  }
  assert.deepEqual(SEAT_DEFAULTS.planner.requires, ['subagents'])
  for (const role of ['lead', 'builder', 'reviewer', 'tech-lead']) assert.deepEqual(SEAT_DEFAULTS[role].requires, [])
})

test('effectiveCapabilities keys subagent delivery on the command line in both adapters', () => {
  const claudeBare = capabilitiesFor({ transport: 'pane', grants: EMPTY_GRANTS })
  const claudeTaskGrants = { tools: ['Task'], agents: [], extensions: [] }
  const claudeTask = effectiveCapabilities({
    bare: claudeBare, declared: capabilitiesFor({ transport: 'pane', grants: claudeTaskGrants }), grants: claudeTaskGrants,
  })
  assert.equal(claudeTask.subagents, true)

  const claudeAgentsOnlyGrants = { tools: [], agents: [{ name: 'Explore', def: '/tmp/explore.json' }], extensions: [] }
  const claudeAgentsOnly = effectiveCapabilities({
    bare: claudeBare, declared: capabilitiesFor({ transport: 'pane', grants: claudeAgentsOnlyGrants }), grants: claudeAgentsOnlyGrants,
  })
  assert.equal(claudeAgentsOnly.subagents, false)

  const piBare = piCapabilitiesFor({ transport: 'pane', grants: EMPTY_GRANTS })
  const piBundleGrants = { tools: [], extensions: ['crew/pi/fanout.js'], agents: [{ name: 'Explore', def: '/tmp/explore.json' }] }
  const piBundle = effectiveCapabilities({
    bare: piBare, declared: piCapabilitiesFor({ transport: 'pane', grants: piBundleGrants }), grants: piBundleGrants,
  })
  assert.equal(piBundle.subagents, true)

  const piAgentsOnlyGrants = { tools: [], extensions: [], agents: [{ name: 'Explore', def: '/tmp/explore.json' }] }
  const piAgentsOnly = effectiveCapabilities({
    bare: piBare, declared: piCapabilitiesFor({ transport: 'pane', grants: piAgentsOnlyGrants }), grants: piAgentsOnlyGrants,
  })
  assert.equal(piAgentsOnly.subagents, false)

  const piTaskOnlyGrants = { tools: ['Task'], extensions: [], agents: [] }
  const piTaskOnly = effectiveCapabilities({
    bare: piBare, declared: piCapabilitiesFor({ transport: 'pane', grants: piTaskOnlyGrants }), grants: piTaskOnlyGrants,
  })
  assert.equal(piTaskOnly.subagents, false)
  assert.equal(effectiveCapabilities({ bare: piBare, declared: piBare, grants: EMPTY_GRANTS }).subagents, false)

  const untouched = effectiveCapabilities({
    bare: { effort: false, local_provider: true, tool_deny: false },
    declared: { effort: false, local_provider: true, tool_deny: false },
    grants: piBundleGrants,
  })
  assert.deepEqual(untouched, { effort: false, local_provider: true, tool_deny: false })
  assert.equal(Object.isFrozen(piBundle), true)
  assert.deepEqual(Object.keys(CAPABILITY_DELIVERY), ['subagents'])
})

test('withheld register grants refuse planners with the closed capability-shortfall reason', async () => {
  const root = capabilityFixtureRoot()
  try {
    const base = capabilityRegister()
    const agentsOnly = capabilityRegister({ roles: {
      planner: { ...base.roles.planner, agents: [{ name: 'Explore', def: 'crew/pi/explore.json' }] },
    } })
    const assertWithheld = async (args, register) => assert.rejects(
      () => resolveAdapters(['planner'], args, null, { register, root }),
      (err) => {
        assert.equal(err.reason, 'capability-shortfall')
        assert.equal(err.role, 'planner')
        assert.match(err.message, /planner/)
        assert.match(err.message, /subagents/)
        assert.match(err.message, /crew\/capabilities\.json/)
        assert.doesNotMatch(err.message, /agent adapter/)
        return true
      },
    )
    await assertWithheld({}, base)
    await assertWithheld({}, agentsOnly)
    await assertWithheld({ 'agent-planner': 'pi' }, agentsOnly)
    assert.deepEqual([...CAPABILITY_REFUSALS], ['register-invalid', 'capability-shortfall', 'unknown-grant', 'grant-unsupported', 'extension-missing', 'unknown-skill', 'agent-def-invalid', 'local-settings-missing', 'local-endpoint-dead'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a granted register boots and a shortfall waiver still boots degraded', async () => {
  const base = capabilityRegister()
  const granted = capabilityRegister({ roles: {
    planner: { ...base.roles.planner, tools: ['Task'] },
  } })
  const resolved = await resolveAdapters(['planner'], {}, null, { register: granted })
  assert.deepEqual(resolved.planner.grants.tools, ['Task'])
  const degraded = await resolveAdapters(['planner'], { 'allow-shortfall-planner': 'subagents' }, null, { register: base })
  assert.deepEqual(degraded.planner.grants.tools, [])
})

test('effectiveTools and the composed planner command preserve the effective allowlist', () => {
  const register = loadCapabilities()
  const grants = grantsFor(register, 'planner')
  assert.equal(effectiveTools('planner', grants), 'Read,Glob,Grep,Bash,Write,Task')
  const command = seatCommand({
    role: 'planner', model: 'opus', promptFile: '/tmp/role-planner.md', tools: SEAT_DEFAULTS.planner.tools,
    deny: SEAT_DEFAULTS.planner.deny, taskDir: '/tmp', bootBrief: 'boot', grants,
  })
  assert.match(command, /--allowedTools "Read,Glob,Grep,Bash,Write,Task"/)
})

test('headless boot records effective planner and reviewer allowlists', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-effective-tools-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-effective-tools-checkout-')
  try {
    await withBreakerEnv({}, () => withHome(home, () => bootCmd(
      { task: 'effective-tools', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
    )))
    const members = JSON.parse(readFileSync(join(testCrewDir(home, checkout, 'effective-tools'), 'crew.json'), 'utf8')).members
    assert.match(members.planner.tools, /(^|,)Task(,|$)/)
    assert.match(members.reviewer.tools, /(^|,)Task(,|$)/)
    assert.doesNotMatch(members.builder.tools, /(^|,)Task(,|$)/)
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }) }
})

test('a pi review seat keeps its built-in activator and deny boundary with register tools', () => {
  const base = capabilityRegister()
  const register = capabilityRegister({ roles: {
    reviewer: { ...base.roles.reviewer, tools: ['Task'] },
  } })
  const grants = grantsFor(register, 'reviewer')
  const command = piSeatCommand({
    ...PI_SAMPLE, role: 'reviewer', tools: SEAT_DEFAULTS.reviewer.tools, deny: SEAT_DEFAULTS.reviewer.deny, grants,
  })
  for (const name of PI_BUILTIN_TOOLS) assert.ok(command.includes(name), `missing pi built-in tool ${name}`)
  assert.match(command, /--tools "read,bash,edit,write,grep,find,ls,Task"/)
  assert.match(command, /--exclude-tools "edit"/)
  assert.doesNotMatch(command, /--exclude-tools "[^"]*Task/)
})

test('loadPolicy is opt-in and strictly validates a positive finite threshold', () => {
  assert.deepEqual(LOAD_ENV, { threshold: 'CREW_LOAD_THRESHOLD' })
  assert.equal(loadPolicy({}), null)
  assert.equal(loadPolicy({ CREW_LOAD_THRESHOLD: '' }), null)
  assert.deepEqual(loadPolicy({ CREW_LOAD_THRESHOLD: '1.5' }), { threshold: 1.5 })
  for (const value of ['abc', '0', '-1', 'NaN', 'Infinity']) {
    assert.throws(() => loadPolicy({ CREW_LOAD_THRESHOLD: value }), (err) => {
      assert.match(err.message, /CREW_LOAD_THRESHOLD/)
      assert.match(err.message, new RegExp(value.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')))
      return true
    })
  }
})

test('hostLoad measures only with a policy and uses a strict per-core threshold edge', () => {
  let loadCalls = 0
  let cpuCalls = 0
  const none = hostLoad({ policy: null, loadavg: () => { loadCalls += 1; return [1] }, cpus: () => { cpuCalls += 1; return [{}] } })
  assert.equal(none, null)
  assert.equal(loadCalls, 0)
  assert.equal(cpuCalls, 0)
  const quiet = hostLoad({ policy: { threshold: 2 }, loadavg: () => [4, 0, 0], cpus: () => new Array(8).fill({}), platform: 'darwin' })
  assert.deepEqual(quiet, {
    configured: true, threshold: 2, basis: 'os.loadavg()[0] / os.cpus().length',
    load_1m: 4, cores: 8, per_core: 0.5, verdict: 'quiet', why: null,
  })
  const edge = hostLoad({ policy: { threshold: 2 }, loadavg: () => [16, 0, 0], cpus: () => new Array(8).fill({}), platform: 'darwin' })
  assert.equal(edge.verdict, 'quiet')
  const saturated = hostLoad({ policy: { threshold: 2 }, loadavg: () => [291, 0, 0], cpus: () => new Array(10).fill({}), platform: 'darwin' })
  assert.equal(saturated.verdict, 'saturated')
  assert.equal(saturated.load_1m, 291)
  assert.equal(saturated.cores, 10)
})

test('every unmeasurable host-load mode refuses without inventing a measurement', () => {
  const cases = [
    { loadavg: () => { throw new Error('no loadavg') }, cpus: () => new Array(8).fill({}), platform: 'darwin' },
    { loadavg: () => [Number.NaN, 0, 0], cpus: () => new Array(8).fill({}), platform: 'darwin' },
    { loadavg: () => [1, 1, 1], cpus: () => { throw new Error('no cpus') }, platform: 'darwin' },
    { loadavg: () => [1, 1, 1], cpus: () => [], platform: 'darwin' },
    { loadavg: () => [0, 0, 0], cpus: () => new Array(8).fill({}), platform: 'win32' },
  ]
  const saturated = hostLoad({ policy: { threshold: 1 }, loadavg: () => [3, 0, 0], cpus: () => [{}], platform: 'darwin' })
  let saturatedMessage
  assert.throws(() => assertHostQuiet(saturated), (err) => { saturatedMessage = err.message; return err.code === 'host-load-open' })
  for (const deps of cases) {
    const record = hostLoad({ policy: { threshold: 1 }, ...deps })
    assert.equal(record.verdict, 'unmeasurable')
    assert.equal(record.load_1m, null)
    assert.equal(record.cores, null)
    assert.equal(record.per_core, null)
    assert.ok(record.why)
    assert.throws(() => assertHostQuiet(record), (err) => {
      assert.equal(err.code, 'host-load-unmeasurable')
      assert.notEqual(err.message, saturatedMessage)
      assert.doesNotMatch(err.message, /per core/)
      return true
    })
  }
})

test('saturated host refusal names measured load, basis, threshold, and remediation', () => {
  const quiet = hostLoad({ policy: { threshold: 2 }, loadavg: () => [1, 0, 0], cpus: () => new Array(8).fill({}), platform: 'darwin' })
  assert.doesNotThrow(() => assertHostQuiet(null))
  assert.doesNotThrow(() => assertHostQuiet(quiet))
  const hot = hostLoad({ policy: { threshold: 1.5 }, loadavg: () => [291, 0, 0], cpus: () => new Array(10).fill({}), platform: 'darwin' })
  assert.throws(() => assertHostQuiet(hot), (err) => {
    assert.equal(err.code, 'host-load-open')
    for (const value of ['291', '10', '1.5', 'CREW_LOAD_THRESHOLD', 'os.loadavg()[0] / os.cpus().length']) assert.ok(err.message.includes(value), `refusal omitted ${value}`)
    assert.match(err.message, /wait for the host|seat fewer roles|unset CREW_LOAD_THRESHOLD/)
    return true
  })
})

test('saturated boot refuses before state, workspace, or seat creation for tier and roles', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-load-order-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-load-order-checkout-')
  try {
    await withBreakerEnv({ CREW_LOAD_THRESHOLD: '1' }, () => withHome(home, async () => {
      for (const [task, extra] of [['load-tier', { tier: 'build', 'headless-all': true }], ['load-roles', { roles: 'lead,builder' }]]) {
        const cmux = callCounter(); const tree = callCounter(); const renameTab = callCounter()
        await assert.rejects(
          () => bootCmd({ task, checkout, ...extra, 'claude-bin': process.execPath }, { cmux, tree, renameTab, loadavg: () => [999, 0, 0], cpus: () => new Array(4).fill({}) }),
          (err) => err.code === 'host-load-open',
        )
        assert.equal(existsSync(testCrewDir(home, checkout, task)), false)
        assert.equal(cmux.calls.length, 0)
        assert.equal(tree.calls.length, 0)
        assert.equal(renameTab.calls.length, 0)
      }
    }))
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }) }
})

test('a host-load refusal records no cell failure of its own', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-load-self-feed-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-load-self-feed-checkout-')
  const dbPath = join(home, 'ledger.db')
  const seeded = openLedger({ dbPath, stderr: { write: () => {} } })
  seeded.cellFailures({ since: null })
  seeded.close()
  try {
    await withBreakerEnv({ CREW_LOAD_THRESHOLD: '2', DEVTEAM_LEDGER_DB: dbPath }, () => withHome(home, () => assert.rejects(
      () => bootCmd(
        { task: 'load-self-feed', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), loadavg: () => [999, 0, 0], cpus: () => new Array(4).fill({}) },
      ),
      (err) => err.code === 'host-load-open',
    )))
    if (!nodeMeetsLedgerFloor) return
    const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
    assert.deepEqual(ledger.dumpTable('cell_failures'), [])
    ledger.close()
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }) }
})

test('quiet host boots and journals measured load while unconfigured boot omits it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-load-journal-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-load-journal-checkout-')
  try {
    let quietLoadCalls = 0; let quietCpuCalls = 0
    await withBreakerEnv({ CREW_LOAD_THRESHOLD: '2' }, () => withHome(home, () => bootCmd(
      { task: 'load-quiet', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
      {
        cmux: callCounter(), tree: callCounter(), renameTab: callCounter(),
        loadavg: () => { quietLoadCalls += 1; return [4, 0, 0] },
        cpus: () => { quietCpuCalls += 1; return new Array(8).fill({}) },
      },
    )))
    const measured = bootRecord(testCrewDir(home, checkout, 'load-quiet')).load
    assert.equal(measured.verdict, 'quiet')
    assert.equal(measured.threshold, 2)
    assert.equal(measured.basis, 'os.loadavg()[0] / os.cpus().length')
    assert.equal(measured.load_1m, 4)
    assert.equal(measured.cores, 8)
    assert.equal(quietLoadCalls, 1)
    assert.equal(quietCpuCalls, 1)

    let plainLoadCalls = 0; let plainCpuCalls = 0
    await withBreakerEnv({}, () => withHome(home, () => bootCmd(
      { task: 'load-plain', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
      {
        cmux: callCounter(), tree: callCounter(), renameTab: callCounter(),
        loadavg: () => { plainLoadCalls += 1; return [0, 0, 0] },
        cpus: () => { plainCpuCalls += 1; return [{}] },
      },
    )))
    assert.equal(Object.hasOwn(bootRecord(testCrewDir(home, checkout, 'load-plain')), 'load'), false)
    assert.equal(plainLoadCalls, 0)
    assert.equal(plainCpuCalls, 0)
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }) }
})
