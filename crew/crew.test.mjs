import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { EVENT_TYPES, PAYLOAD_KEYS, NODE_FLOOR, openLedger } from '../scripts/factory/ledger.mjs'
import { openRun } from '../scripts/factory/emit.mjs'
import {
  composeLayout, SEAT_DEFAULTS, DEFAULT_ROLES, ROLE_ORDER, transportFor, seatTransport, HEADLESS_TRANSPORTS, assertCapabilities, resolveAdapters, bootAllocation, resolveWorkerBin, docOpenArgs,
  resolveTier, resolveSeatModels, seatReadySignal, assertSeats, phaseForStage, emitAdapter,
  waitForEnvelope, WAIT_POLL_MS, LIVENESS_PROBE_MS, LIVENESS_MISSES_TO_DIE,
  parkSeats, parkOnOutcome, escalationAttention, bootCmd, seatLiveness, awaitSeatsReady, teardownCore,
  MEMORY_ROLES, memoryConfig,
} from './crew.mjs'
import { driveTask } from './drive.mjs'
import { reclaimStore } from './reclaim.mjs'
import { seatCommand, capabilitiesFor, modelString as claudeModelString } from './adapters/adapter-claude.mjs'
import { seatCommand as piSeatCommand, capabilitiesFor as piCapabilitiesFor, modelString as piModelString, translateDeny } from './adapters/adapter-pi.mjs'
import { realIo } from './realio.mjs'
import { testCheckout } from '../test/fixtures.mjs'

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
      assert.match(seat.deny, /Task/), assert.match(seat.deny, /Agent/)
      assert.doesNotMatch(seat.deny, /Edit/, 'the builder is the one seat that MUST keep Edit')
    } else {
      assert.match(seat.deny, /Edit/, `${role} must be tool-denied Edit, not just un-allowed`)
      assert.match(seat.deny, /NotebookEdit/)
    }
  }
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
  assert.deepEqual({ ...claudePane }, { prompt_file: true, tool_deny: true, unattended: true, subagents: true, effort: true, interjection: 'none', abort: 'none', session_resume: false, durable_cursor: 'none', reassign: true })
  assert.ok(Object.isFrozen(claudePane))
  const claudeHeadless = capabilitiesFor({ transport: 'headless-json' })
  assert.deepEqual({ ...claudeHeadless }, { prompt_file: true, tool_deny: true, unattended: true, subagents: true, effort: true, interjection: 'turn', abort: 'signal', session_resume: true, durable_cursor: 'none', reassign: false })
  assert.ok(Object.isFrozen(claudeHeadless))
  const piPane = piCapabilitiesFor({ transport: 'pane' })
  // #131: drive.mjs bounce paths reassign a settled pane seat.
  assert.deepEqual({ ...piPane }, { prompt_file: true, tool_deny: true, unattended: true, subagents: false, effort: true, interjection: 'none', abort: 'none', session_resume: false, durable_cursor: 'none', reassign: true })
  assert.ok(Object.isFrozen(piPane))
  const piHeadless = piCapabilitiesFor({ transport: 'headless-rpc' })
  // #148: reassign captured live (captures/pi-b11-reassign.jsonl) — a settled
  // session takes a further assignment same-process and cross-process.
  assert.deepEqual({ ...piHeadless }, { prompt_file: true, tool_deny: true, unattended: true, subagents: false, effort: true, interjection: 'boundary', abort: 'command', session_resume: true, durable_cursor: 'entry_id', reassign: true })
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

function testCrewDir(home, checkout, task) { return join(home, '.crew', basename(checkout), task) }

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

test('mixed boot still creates a workspace, seats panes, and leaves the headless seat unsurfaced', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-mixed-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-mixed-checkout-')
  const task = 'mixed'
  const cmuxCalls = []
  const cmux = (verb, argv) => { cmuxCalls.push([verb, argv]); return { ok: true, stdout: '' } }
  let treeCalls = 0
  const paneRoles = ['lead', 'planner', 'reviewer']
  const tree = () => {
    treeCalls += 1
    if (treeCalls === 1) return { windows: [] }
    return { windows: [{ id: 'window-1', workspaces: [{ id: 'workspace-1', name: `crew-${task}`, panes: paneRoles.map((role) => ({ id: `pane-${role}`, surfaces: [{ id: `surface-${role}`, name: role }] })) }] }] }
  }
  const renameTab = callCounter()
  try {
    await withHome(home, () => bootCmd(
      { task, checkout, roles: 'lead,planner,builder,reviewer', headless: 'builder', 'claude-bin': process.execPath },
      { cmux, tree, renameTab },
    ))
    const crew = JSON.parse(readFileSync(join(testCrewDir(home, checkout, task), 'crew.json'), 'utf8'))
    assert.equal(crew.workspace_id, 'workspace-1')
    assert.equal(crew.window_id, 'window-1')
    assert.ok(cmuxCalls.some(([verb]) => verb === 'new-workspace'))
    assert.deepEqual(crew.members.lead, { pane_id: 'pane-lead', surface_id: 'surface-lead', transport: 'pane', model: 'opus', agent: 'claude', tools: SEAT_DEFAULTS.lead.tools, deny: SEAT_DEFAULTS.lead.deny })
    assert.equal(crew.members.builder.transport, 'headless-json')
    assert.equal(crew.members.builder.pane_id, null)
    assert.equal(crew.members.builder.surface_id, null)
    assert.equal(renameTab.calls.length, paneRoles.length)
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
    const archived = teardownCore(paths, { workspace_id: null, members: { builder: { surface_id: null } } }, { closeSurface, closeWorkspace })
    assert.equal(existsSync(archived), true)
    assert.equal(closeSurface.calls.length, 0)
    assert.equal(closeWorkspace.calls.length, 0)

    const paned = join(parent, 'paned')
    mkdirSync(paned, { recursive: true })
    const second = teardownCore({ dir: paned }, { workspace_id: 'workspace-1', members: { lead: { surface_id: null } } }, { closeSurface, closeWorkspace })
    assert.equal(existsSync(second), true)
    assert.equal(closeWorkspace.calls.length, 1)
    assert.deepEqual(closeWorkspace.calls[0], ['workspace-1'])
  } finally { rmSync(parent, { recursive: true, force: true }) }
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
    'plan:r1': 'planning', 'check:r1': 'planning', 'gate-baseline': 'build', 'gate-repair:1': 'build',
    'gate-reverify:1': 'build', 'scope-gate:r1': 'build', 'lane:r1': 'build', 'gate:r1': 'build',
    'review:pass': 'review', suite: 'finish', commit: 'finish', done: 'done', 'escalate:lane': 'escalation',
    'future:stage': 'build',
  }
  for (const [label, phase] of Object.entries(table)) assert.equal(phaseForStage(label), phase, label)
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
