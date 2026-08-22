import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { execSync, spawn, spawnSync } from 'node:child_process'
import { tmpdir, homedir } from 'node:os'
import { join, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EVENT_TYPES, PAYLOAD_KEYS, NODE_FLOOR, openLedger } from '../scripts/factory/ledger.mjs'
import { openRun, _resetNoticeGuardsForTest } from '../scripts/factory/emit.mjs'
import {
  composeLayout, SEAT_DEFAULTS, FANOUT_TOOLS, DEFAULT_ROLES, ROLE_ORDER, transportFor, seatTransport, HEADLESS_TRANSPORTS, assertCapabilities, resolveAdapters, bootAllocation, resolveWorkerBin, docOpenArgs,
  resolveTier, resolveSeatModels, loadLadder, assertBandFloors, grantedDefModels, assertDefBandFloors, refuseBandFloor, seatModelKey, bandForMember, bandForRaw, seatBand, LADDER_PATH, BAND_FLOOR_REFUSALS, seatReadySignal, assertSeats, phaseForStage, emitAdapter,
  waitForEnvelope, WAIT_POLL_MS, LIVENESS_PROBE_MS, LIVENESS_MISSES_TO_DIE,
  parkSeats, parkOnOutcome, escalationAttention, bootCmd, runCmd, runExitCode, RUN_EXIT_CODES, RUN_EXIT_UNEXPECTED, resolveVariant, resolveFilesInScope, resolveLaneFence, resolveValidationLane, VALIDATION_LANE_REFUSAL, assertCtxSources, seatLiveness, awaitSeatsReady, teardownCore, teardownCmd,
  UsageError, KNOWN_FLAGS, ROLE_FLAG_PREFIXES, REQUIRED_FLAGS, BOOT_ONLY_FLAGS, assertUsage,
  BOOT_DESCENDANT_REFUSALS, descendantRefusal, refuseStaleDescendants,
  MEMORY_ROLES, memoryConfig, CAPABILITY_REFUSALS, loadCapabilities,
  grantsFor, assertGrantsBacked, assertFanoutCoherent, deniedFanout, EMPTY_GRANTS, probeLocalEndpoint,
  effectiveTools, ADVISOR_CONFIG_VERSION, ADVISOR_BOOT_REFUSALS, SAFE_MODEL, classifyAdvisorCell,
  advisorManifest, assertAdvisorManifest,
} from './crew.mjs'
import { runChild, resolveValidationLane as resolveChildValidationLane } from './child.mjs'
import { daemon } from './daemon.mjs'
import { driveTask, LIMITS, VARIANTS, VARIANT_NAMES, DEFAULT_VARIANT, PROTECTED_PATHS, validateScopeEntries } from './drive.mjs'
import {
  LIMIT_REFUSALS, PLAN_ROUNDS_MAX, BUILD_ROUNDS_MAX, REVIEW_ROUNDS_MAX,
  limitsCtx, limitsRecord, resolveBuildRounds, resolveLimits, resolvePlanRounds, resolveReviewRounds,
} from './limits.mjs'
import { reclaimStore } from './reclaim.mjs'
import { seatCommand, headlessCommand as claudeHeadlessCommand, capabilitiesFor, modelString as claudeModelString } from './adapters/adapter-claude.mjs'
import { seatCommand as piSeatCommand, capabilitiesFor as piCapabilitiesFor, modelString as piModelString, translateDeny, PI_BUILTIN_TOOLS } from './adapters/adapter-pi.mjs'
import { seatIo, VARIANT_STAGE_PHASES, paneTeardownRows, PANE_SETTLE_POLLS, PANE_SETTLE_MS } from './seat-io.mjs'
import { testCheckout } from '../test/fixtures.mjs'
import { probeRepo } from '../scripts/factory/probe-repo.mjs'

// Ledger sandbox (#432): every ledger writer this file drives resolves its db
// through DEVTEAM_LEDGER_DIR (scripts/factory/ledger.mjs:2903), so this
// module-scope assignment — set before any test runs, not per call — is what
// keeps the operator's ~/.dev-team/factory/ledger.db out of reach. Restored,
// and the directory removed, in after().
const LEDGER_SANDBOX = mkdtempSync(join(tmpdir(), 'b117-ledger-sandbox-'))
const LEDGER_SANDBOX_PREVIOUS = process.env.DEVTEAM_LEDGER_DIR
process.env.DEVTEAM_LEDGER_DIR = LEDGER_SANDBOX
after(() => {
  if (LEDGER_SANDBOX_PREVIOUS === undefined) delete process.env.DEVTEAM_LEDGER_DIR
  else process.env.DEVTEAM_LEDGER_DIR = LEDGER_SANDBOX_PREVIOUS
  rmSync(LEDGER_SANDBOX, { recursive: true, force: true })
})

const roster = JSON.parse(readFileSync(new URL('./roster.json', import.meta.url), 'utf8'))
const rosterLadder = JSON.parse(readFileSync(new URL('./model-ladder.json', import.meta.url), 'utf8'))
// Hoisted: tests both above and below this point branch on it. Below the
// ledger's Node floor the emitter degrades to JSONL and writes no database,
// so a real-row assertion there would assert the absence of a feature.
const floorMajor = Number.parseInt(NODE_FLOOR, 10)
const nodeMeetsLedgerFloor = Number.parseInt(process.versions.node, 10) >= floorMajor

const CLI_REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLI_PROBE_TASK = 'b120-usage-probe'
const CLI_PROBE_BRIEF = join(tmpdir(), 'b120-usage-probe-brief.md')
const CLI_ENV = { ...process.env, NO_COLOR: '1' }
delete CLI_ENV.FORCE_COLOR
delete CLI_ENV.CLICOLOR_FORCE
const ANSI_CODES = /\u001b\[[0-9;]*m/g
const cliEntry = (...argv) => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./crew.mjs', import.meta.url)), ...argv], {
    cwd: CLI_REPO_ROOT, encoding: 'utf8', env: CLI_ENV,
  })
  return { ...result, output: `${result.stdout || ''}${result.stderr || ''}`.replace(ANSI_CODES, '') }
}

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

// #412 — the PERMANENT pin for the guarantee #403/#411 rests on. The task gate
// that first proved it (G6) died with its run; nothing in the suite pinned the
// claude planner's composed pane command. These two tests are that pin: they
// compose through the REAL shipped register (loadCapabilities/grantsFor/
// assertGrantsBacked — the boot path of resolveAdapters, crew.mjs:807-809) and
// assert the whole command STRING, not that a flag was present.
// A synthetic register root keeps resolved grant paths machine-independent.
const PIN_SEAT = Object.freeze({
  role: 'planner', promptFile: '/tmp/crew-task/role-planner.md',
  tools: SEAT_DEFAULTS.planner.tools, deny: SEAT_DEFAULTS.planner.deny, taskDir: '/tmp/crew-task',
  bootBrief: 'Crew for task demo. Task dir /tmp/crew-task. Read your role in the system prompt, reply exactly ready: your-role, then wait.',
})
const PIN_ROOT = { root: '/repo', exists: () => true, readFile: () => JSON.stringify({ name: 'scout', prompt: 'pinned stub' }) }
const pinnedGrants = (register, agent) =>
  assertGrantsBacked('planner', grantsFor(register, 'planner', { ...PIN_ROOT, agent }), register, { agent })

test('the default claude planner pane command is pinned byte for byte across the granted and ungranted paths', () => {
  const register = loadCapabilities()
  // GRANTED: the register's role-level `tools: ["Task"]` reaches --allowedTools
  // through adapter-claude's allowedTools() merge. Byte-for-byte, no exceptions.
  assert.equal(
    seatCommand({ ...PIN_SEAT, model: 'opus', grants: pinnedGrants(register, 'claude') }),
    'env DEVTEAM_WORKER=1 CREW_ROLE=planner CREW_TASK_DIR="/tmp/crew-task" claude --model opus --permission-mode bypassPermissions --allowedTools "Read,Glob,Grep,Bash,Write,Task" --disallowedTools "Edit,NotebookEdit" --append-system-prompt-file "/tmp/crew-task/role-planner.md" "Crew for task demo. Task dir /tmp/crew-task. Read your role in the system prompt, reply exactly ready: your-role, then wait."',
  )
  // UNGRANTED: the same seat with no grants at all composes a DIFFERENT command
  // (no Task), so the granted assertion above is not vacuous.
  assert.equal(
    seatCommand({ ...PIN_SEAT, model: 'opus', grants: EMPTY_GRANTS }),
    'env DEVTEAM_WORKER=1 CREW_ROLE=planner CREW_TASK_DIR="/tmp/crew-task" claude --model opus --permission-mode bypassPermissions --allowedTools "Read,Glob,Grep,Bash,Write" --disallowedTools "Edit,NotebookEdit" --append-system-prompt-file "/tmp/crew-task/role-planner.md" "Crew for task demo. Task dir /tmp/crew-task. Read your role in the system prompt, reply exactly ready: your-role, then wait."',
  )
  // The load-bearing constraint of #403: the by_agent overlay never reaches the
  // claude planner, so stripping it from the register moves NOTHING.
  const stripped = JSON.parse(JSON.stringify(register))
  delete stripped.roles.planner.by_agent
  assert.equal(
    seatCommand({ ...PIN_SEAT, model: 'opus', grants: pinnedGrants(loadCapabilities({ register: stripped }), 'claude') }),
    seatCommand({ ...PIN_SEAT, model: 'opus', grants: pinnedGrants(register, 'claude') }),
  )
})

test('the granted pi planner pane command is pinned byte for byte so by_agent delivery reaches argv', () => {
  const register = loadCapabilities()
  // The by_agent overlay's extension and agent grant must reach ARGV: -e, the
  // CREW_PI_AGENTS allowlist, and the `agent` activator in --tools.
  assert.equal(
    piSeatCommand({ ...PIN_SEAT, model: 'openai-codex/gpt-5.6', grants: pinnedGrants(register, 'pi') }),
    'env DEVTEAM_WORKER=1 CREW_ROLE=planner CREW_TASK_DIR="/tmp/crew-task" CREW_PI_AGENTS=\'[{"name":"scout","def":"/repo/crew/pi/agents/scout.json"}]\' pi --model openai-codex/gpt-5.6 --tools "read,bash,edit,write,grep,find,ls,Task,agent" --exclude-tools "edit" --no-extensions -e "/repo/crew/pi/extensions/subagent.ts" --no-skills --append-system-prompt "/tmp/crew-task/role-planner.md" "Crew for task demo. Task dir /tmp/crew-task. Read your role in the system prompt, reply exactly ready: your-role, then wait."',
  )
  // Ungranted: the same pi seat with no grants loses exactly the delivery.
  assert.equal(
    piSeatCommand({ ...PIN_SEAT, model: 'openai-codex/gpt-5.6', grants: EMPTY_GRANTS }),
    'env DEVTEAM_WORKER=1 CREW_ROLE=planner CREW_TASK_DIR="/tmp/crew-task" pi --model openai-codex/gpt-5.6 --tools "read,bash,edit,write,grep,find,ls" --exclude-tools "edit" --no-extensions --no-skills --append-system-prompt "/tmp/crew-task/role-planner.md" "Crew for task demo. Task dir /tmp/crew-task. Read your role in the system prompt, reply exactly ready: your-role, then wait."',
  )
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

test('seat requirements deliver pi scouts, preserve genuine shortfalls, and reject malformed overrides', async () => {
  const resolvedPlanner = await resolveAdapters(['planner'], { 'agent-planner': 'pi' })
  assert.equal(resolvedPlanner.planner.name, 'pi')
  assert.deepEqual(resolvedPlanner.planner.grants.extensions, [join(process.cwd(), 'crew/pi/extensions/subagent.ts')])
  assert.deepEqual(resolvedPlanner.planner.grants.agents, [{ name: 'scout', def: join(process.cwd(), 'crew/pi/agents/scout.json') }])
  await assert.rejects(
    () => resolveAdapters(['planner'], { 'agent-planner': 'pi', 'headless-rpc': 'planner' }),
    (err) => err.reason === 'capability-shortfall'
      && err.message === 'seat planner requires capability "subagents" but agent adapter "pi" declares subagents: false — refusing to boot a weaker seat (pass --allow-shortfall-planner subagents to boot it degraded on purpose)',
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
  const degradedPlanner = await resolveAdapters(['planner'], {
    'agent-planner': 'pi', 'headless-rpc': 'planner', 'allow-shortfall-planner': 'subagents',
  })
  assert.equal(degradedPlanner.planner.name, 'pi')
  await assert.rejects(
    () => resolveAdapters(['planner'], { 'agent-planner': 'pi', 'headless-rpc': 'planner', 'allow-shortfall-planner': 'tool_deny' }),
    (err) => /planner/.test(err.message) && /subagents/.test(err.message) && /pi/.test(err.message),
  )
  await assert.rejects(
    () => resolveAdapters(['planner'], { 'agent-planner': 'pi', 'headless-rpc': 'planner', 'allow-shortfall-planner': true }),
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

function writeDescendantRecord(taskDir, overrides = {}) {
  const dir = join(taskDir, 'descendants')
  mkdirSync(dir, { recursive: true })
  const key = overrides.key || 'headless__d1__seat-1'
  const record = {
    reservation_id: overrides.reservation_id || 'record-seat-1', key, phase: 'running',
    owner: { pid: process.pid, startedAt: Date.now() }, transport: 'headless-json', role: 'builder',
    seat_id: 'd1', seat_reservation_id: 'seat-1', marker_owner_pid: process.pid,
    captures: 3, missed_snapshots: 0, discovery_failures: 0,
    root_pid: 999999, root_pgid: 999999, root_start: 'old-root', groups: [],
    root_settled: null, swept_at: null, sweep_id: null, ...overrides,
  }
  const path = join(dir, `.${key}.active.json`)
  writeFileSync(path, JSON.stringify(record))
  return path
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

// #419: boot's own-task descendant sweep — closed-set refusals and the record it leaves.
test('boot reclaims this task\'s provably dead descendants and proceeds', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-boot-descendant-dead-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-boot-descendant-dead-checkout-')
  const task = 'descendant-dead'
  const recordPath = writeDescendantRecord(join(testCrewDir(home, checkout, task), 'task'), {
    groups: [{ pgid: 42, anchors: [{ pid: 43, pgid: 42, start: 'child' }] }],
  })
  const kill = (pid) => {
    if (pid === -42) {
      const error = new Error('ESRCH')
      error.code = 'ESRCH'
      throw error
    }
    return true
  }
  try {
    await withBreakerEnv({ DEVTEAM_LEDGER_DB: undefined }, () => withHome(home, () => bootCmd(
      { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), descendantDeps: { kill, snapshot: () => ({ ok: true, rows: new Map() }), sleep: () => {} } },
    )))
    assert.equal(existsSync(join(testCrewDir(home, checkout, task), 'crew.json')), true)
    assert.ok(JSON.parse(readFileSync(recordPath, 'utf8')).swept_at)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('boot refuses when a reclaimed descendant lacks a durable stamp', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-boot-descendant-stamp-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-boot-descendant-stamp-checkout-')
  const task = 'descendant-stamp'
  const recordPath = writeDescendantRecord(join(testCrewDir(home, checkout, task), 'task'), {
    groups: [{ pgid: 42, anchors: [{ pid: 43, pgid: 42, start: 'child' }] }],
  })
  const reclaimDescendants = () => ({
    records: 1, swept: 1, skipped: 0, retryable: 0, reclaimed: 1, live: 0,
    probe_unknown: 0, identity_refused: 0, record_failed: 0, snapshot_ok: true,
  })
  let error
  try {
    await withBreakerEnv({ DEVTEAM_LEDGER_DB: undefined }, () => withHome(home, () => assert.rejects(
      () => bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), reclaimDescendants },
      ),
      (candidate) => { error = candidate; return candidate.reason === 'descendants-unreclaimed' },
    )))
    assert.equal(error.code, 'stale-descendants')
    assert.equal(existsSync(join(testCrewDir(home, checkout, task), 'crew.json')), false)
    assert.equal(JSON.parse(readFileSync(recordPath, 'utf8')).swept_at, null)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('boot refuses when this task\'s records show a live descendant', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-boot-descendant-live-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-boot-descendant-live-checkout-')
  const task = 'descendant-live'
  const recordPath = writeDescendantRecord(join(testCrewDir(home, checkout, task), 'task'), {
    root_pid: 5000, root_pgid: 5000, root_start: 'live-root',
  })
  const liveSnapshot = () => ({ ok: true, rows: new Map([[5000, { pid: 5000, pgid: 5000, start: 'live-root', stat: 'Ss' }]]) })
  let error
  try {
    await withBreakerEnv({ DEVTEAM_LEDGER_DB: undefined }, () => withHome(home, () => assert.rejects(
      () => bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), descendantDeps: { kill: () => true, snapshot: liveSnapshot, sleep: () => {} } },
      ),
      (candidate) => { error = candidate; return candidate.reason === 'descendants-alive' },
    )))
    assert.equal(error.code, 'stale-descendants')
    assert.match(error.message, /crew:reap/)
    assert.equal(JSON.parse(readFileSync(recordPath, 'utf8')).swept_at, null)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('boot refuses an unmeasurable descendant probe', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-boot-descendant-unknown-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-boot-descendant-unknown-checkout-')
  const task = 'descendant-unknown'
  writeDescendantRecord(join(testCrewDir(home, checkout, task), 'task'))
  try {
    await withBreakerEnv({ DEVTEAM_LEDGER_DB: undefined }, () => withHome(home, () => assert.rejects(
      () => bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), descendantDeps: { kill: () => true, snapshot: () => ({ ok: false, rows: null }), sleep: () => {} } },
      ),
      (candidate) => candidate.reason === 'descendants-unknown',
    )))
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('a refused boot creates no seat, no workspace and no crew.json', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-boot-descendant-no-state-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-boot-descendant-no-state-checkout-')
  const task = 'descendant-no-state'
  const dir = testCrewDir(home, checkout, task)
  writeDescendantRecord(join(dir, 'task'), { root_pid: 5000, root_pgid: 5000, root_start: 'live-root' })
  const cmux = callCounter(); const tree = callCounter()
  try {
    await withBreakerEnv({ DEVTEAM_LEDGER_DB: undefined }, () => withHome(home, () => assert.rejects(
      () => bootCmd(
        { task, checkout, roles: 'lead,planner,builder,reviewer' },
        { cmux, tree, renameTab: callCounter(), descendantDeps: { kill: () => true, snapshot: () => ({ ok: true, rows: new Map([[5000, { pid: 5000, pgid: 5000, start: 'live-root', stat: 'Ss' }]]) }), sleep: () => {} } },
      ),
      (error) => error.reason === 'descendants-alive',
    )))
    assert.equal(cmux.calls.length, 0)
    assert.equal(tree.calls.length, 0)
    assert.equal(existsSync(join(dir, 'crew.json')), false)
    assert.equal(existsSync(join(dir, 'task', 'role-lead.md')), false)
    assert.equal(existsSync(join(dir, 'returns')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('the boot sweep touches only the booting task\'s own records', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-boot-descendant-own-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-boot-descendant-own-checkout-')
  const first = 'descendant-own-a'; const second = 'descendant-own-b'
  const firstPath = writeDescendantRecord(join(testCrewDir(home, checkout, first), 'task'), {
    groups: [{ pgid: 42, anchors: [{ pid: 43, pgid: 42, start: 'child' }] }],
  })
  const secondPath = writeDescendantRecord(join(testCrewDir(home, checkout, second), 'task'), {
    key: 'headless__d1__seat-2', reservation_id: 'record-seat-2',
    groups: [{ pgid: 42, anchors: [{ pid: 43, pgid: 42, start: 'child' }] }],
  })
  const beforeSecond = readFileSync(secondPath, 'utf8')
  const kill = (pid) => {
    if (pid === -42) {
      const error = new Error('ESRCH')
      error.code = 'ESRCH'
      throw error
    }
    return true
  }
  try {
    await withBreakerEnv({ DEVTEAM_LEDGER_DB: undefined }, () => withHome(home, () => bootCmd(
      { task: first, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), descendantDeps: { kill, snapshot: () => ({ ok: true, rows: new Map() }), sleep: () => {} } },
    )))
    assert.ok(JSON.parse(readFileSync(firstPath, 'utf8')).swept_at)
    assert.equal(readFileSync(secondPath, 'utf8'), beforeSecond)
    assert.equal(JSON.parse(readFileSync(secondPath, 'utf8')).swept_at, null)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('a boot with no records is silent, proceeds, and still records the check', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-boot-descendant-empty-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-boot-descendant-empty-checkout-')
  const task = 'descendant-empty'
  try {
    await withBreakerEnv({ DEVTEAM_LEDGER_DB: undefined }, () => withHome(home, () => bootCmd(
      { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
    )))
    const rows = readFileSync(join(testCrewDir(home, checkout, task), 'journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    const sweeps = rows.filter((row) => row.event === 'boot-descendant-sweep')
    assert.equal(sweeps.length, 1)
    assert.equal(sweeps[0].records, 0)
    assert.equal(sweeps[0].refusal, null)
    assert.equal(existsSync(join(testCrewDir(home, checkout, task), 'crew.json')), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('a second boot over swept records reports nothing rather than erroring', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-boot-descendant-second-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-boot-descendant-second-checkout-')
  const task = 'descendant-second'
  const recordPath = writeDescendantRecord(join(testCrewDir(home, checkout, task), 'task'), {
    groups: [{ pgid: 42, anchors: [{ pid: 43, pgid: 42, start: 'child' }] }],
  })
  const kill = (pid) => {
    if (pid === -42) {
      const error = new Error('ESRCH')
      error.code = 'ESRCH'
      throw error
    }
    return true
  }
  const deps = { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), descendantDeps: { kill, snapshot: () => ({ ok: true, rows: new Map() }), sleep: () => {} } }
  try {
    const args = { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath }
    await withBreakerEnv({ DEVTEAM_LEDGER_DB: undefined }, () => withHome(home, async () => {
      await bootCmd(args, deps)
      await bootCmd(args, deps)
    }))
    assert.ok(JSON.parse(readFileSync(recordPath, 'utf8')).swept_at)
    const rows = readFileSync(join(testCrewDir(home, checkout, task), 'journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      .filter((row) => row.event === 'boot-descendant-sweep')
    assert.equal(rows.length, 2)
    assert.equal(rows[1].records, 0)
    assert.equal(rows[1].skipped, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('the sweep runs before any seat state exists', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-boot-descendant-order-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-boot-descendant-order-checkout-')
  const task = 'descendant-order'
  const dir = testCrewDir(home, checkout, task)
  const calls = []
  const reclaimDescendants = (options) => {
    calls.push(options)
    assert.equal(existsSync(join(dir, 'task')), false)
    assert.equal(existsSync(join(dir, 'crew.json')), false)
    return { records: 0, swept: 0, skipped: 0, retryable: 0, reclaimed: 0, live: 0, probe_unknown: 0, identity_refused: 0, snapshot_ok: true }
  }
  try {
    await withBreakerEnv({ DEVTEAM_LEDGER_DB: undefined }, () => withHome(home, () => bootCmd(
      { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), reclaimDescendants },
    )))
    assert.equal(calls.length, 1)
    assert.equal(calls[0].taskDir, join(dir, 'task'))
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('a sweep that throws refuses rather than booting', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-boot-descendant-error-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-boot-descendant-error-checkout-')
  const task = 'descendant-error'
  const dir = testCrewDir(home, checkout, task)
  try {
    await withBreakerEnv({ DEVTEAM_LEDGER_DB: undefined }, () => withHome(home, () => assert.rejects(
      () => bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), reclaimDescendants: () => { throw new Error('ps exploded') } },
      ),
      (error) => error.reason === 'descendants-sweep-failed',
    )))
    assert.equal(existsSync(join(dir, 'crew.json')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('the boot descendant refusal set is frozen and closed', () => {
  assert.equal(Object.isFrozen(BOOT_DESCENDANT_REFUSALS), true)
  assert.throws(() => refuseStaleDescendants('anything-else', { task: 't' }))
})

test('descendantRefusal applies alive before unknown before mismatch', () => {
  const row = (overrides) => ({ event: 'descendant-reclaim', ...overrides })
  const clean = { retryable: 0, record_failed: 0, snapshot_ok: true }
  assert.equal(descendantRefusal([row({ reason: 'evidence-mismatch', identity_refused: 1 }), row({ reason: 'probe-unknown', probe_unknown: 1 }), row({ reason: 'root-alive' })], clean), 'descendants-alive')
  assert.equal(descendantRefusal([row({ reason: 'evidence-mismatch', identity_refused: 1 }), row({ reason: 'probe-unknown', probe_unknown: 1 })], clean), 'descendants-unknown')
  assert.equal(descendantRefusal([row({ reason: 'evidence-mismatch', identity_refused: 1 })], clean), 'descendants-evidence-mismatch')
  assert.equal(descendantRefusal([], clean), null)
  assert.equal(descendantRefusal([], { ...clean, retryable: 1 }), 'descendants-unreclaimed')
  assert.equal(descendantRefusal([], { ...clean, snapshot_ok: false }), 'descendants-unreclaimed')
})

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

test('attended and child entrypoints resolve validation lanes identically', () => {
  const table = [
    [{}, { lane: null, source: 'none' }],
    [{ lane: null }, { lane: null, source: 'none' }],
    [{ validationLane: null }, { lane: null, source: 'none' }],
    [{ validationLane: '  node --test  ' }, { lane: 'node --test', source: 'validation-lane' }],
    [{ lane: '  npm test  ' }, { lane: 'npm test', source: 'lane' }],
    [{ lane: 'fence-register-name', fences: 'register.json' }, { lane: null, source: 'none' }],
    [{ validationLane: '  validation-command  ', lane: 'fence-register-name', fences: 'register.json' }, { lane: 'validation-command', source: 'validation-lane' }],
  ]
  for (const resolver of [resolveValidationLane, resolveChildValidationLane]) {
    for (const [args, expected] of table) assert.deepEqual(resolver(args), expected)
    for (const raw of [true, '   ', 42]) {
      assert.throws(() => resolver({ validationLane: raw }), (err) => {
        assert.equal(err.reason, 'invalid-validation-lane')
        assert.match(err.message, /--validation-lane/)
        assert.match(err.message, /\[invalid-validation-lane\]/)
        return true
      })
      assert.throws(() => resolver({ lane: raw }), (err) => err.reason === 'invalid-validation-lane')
    }
  }
})

// The resolver's absence rule pinned against the value the DAEMON actually
// sends: enqueue normalises a missing lane to null (crew/daemon.mjs:1091) and
// childSpecFor forwards it unconditionally (:948). Calling the resolver
// directly is what the shared table above does and what hid #438, so this
// fixture goes through the fork seam instead.
test('daemon enqueue without a lane forwards null and the child resolves it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-daemon-null-lane-'))
  const crewDir = join(dir, 'crew')
  const returnsDir = join(crewDir, 'returns')
  mkdirSync(join(crewDir, 'task'), { recursive: true })
  mkdirSync(returnsDir, { recursive: true })
  const roles = ['planner', 'builder', 'reviewer']
  const brief = join(dir, 'brief.md')
  writeFileSync(brief, '# daemon null lane brief\n')
  writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({
    schema_version: 3, task: 'daemon-null-lane', checkout: dir, roles,
    members: Object.fromEntries(roles.map((role) => [role, {
      surface_id: null, pane_id: null, transport: 'headless-json', model: 'sonnet', agent: 'claude',
    }])),
    task_return: join(returnsDir, 'task.json'),
  }))
  writeFileSync(join(crewDir, 'journal.jsonl'), '')
  const forks = []
  let clock = 1
  const d = daemon({
    root: join(dir, 'daemon'),
    deps: {
      pid: 700, now: () => clock++, uuid: (() => { let n = 0; return () => `run-${++n}` })(),
      fork(...args) { forks.push(args); return { pid: 900, on() {}, kill() {}, unref() {}, disconnect() {} } },
      kill: () => true, setInterval: () => null, clearInterval: () => {},
    },
  })
  try {
    d.enqueue({ crew_dir: crewDir, task: 'daemon-null-lane', checkout: dir, brief_file: brief })
    assert.equal(forks.length, 1)
    const spec = JSON.parse(forks[0][1][1])
    assert.equal(spec.lane, null, 'the daemon normalises an absent lane to null')
    let seen = null
    let drove = 0
    const rows = []
    runChild(spec, {
      preflight: false,
      seatIo: () => ({ log: (row) => rows.push(row) }),
      driveTask: (ctx) => { drove += 1; seen = ctx; return { status: 'done', summary: '', artifacts: [], details: {} } },
      env: { DEVTEAM_LEDGER_DB: join(dir, 'ledger.db') },
    })
    assert.equal(drove, 1)
    assert.equal(seen.lane, null)
    const row = rows.find((entry) => entry.event === 'validation-lane')
    assert.deepEqual(row, { at: row.at, event: 'validation-lane', lane: null, source: 'none' })
  } finally {
    await d.stop()
    rmSync(dir, { recursive: true, force: true })
  }
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

test('resolveBuildRounds and resolveReviewRounds resolve absent and valid values and refuse invalid budgets closed', () => {
  for (const [resolve, reason, max] of [
    [resolveBuildRounds, 'invalid-build-rounds', BUILD_ROUNDS_MAX],
    [resolveReviewRounds, 'invalid-review-rounds', REVIEW_ROUNDS_MAX],
  ]) {
    assert.equal(resolve(undefined), null)
    assert.equal(resolve(null), null)
    assert.equal(resolve(''), null)
    assert.equal(resolve('3'), 3)
    assert.equal(resolve(3), 3)
    assert.equal(resolve(' 3 '), 3)
    for (const raw of [true, 'abc', '2.5', 2.5, 0, -1, '0x4', [], max + 1]) {
      assert.throws(() => resolve(raw), (err) => {
        assert.equal(err.reason, reason)
        assert.ok(LIMIT_REFUSALS.includes(err.reason))
        return true
      })
    }
  }
})

test('resolveLimits and limitsCtx overlay only the flagged keys', () => {
  const none = resolveLimits({})
  assert.deepEqual(none, { plan_rounds: null, build_rounds: null, review_rounds: null })
  assert.equal(limitsCtx(none), null)
  assert.deepEqual(limitsCtx(resolveLimits({ build_rounds: 4 })), { build_rounds: 4 })
})

test('limitsRecord records all effective round budgets with per-key sources', () => {
  assert.deepEqual(limitsRecord(resolveLimits({}), LIMITS), {
    plan_rounds: LIMITS.plan_rounds, build_rounds: LIMITS.build_rounds, review_rounds: LIMITS.review_rounds,
    source: { plan_rounds: 'default', build_rounds: 'default', review_rounds: 'default' },
  })
  assert.deepEqual(limitsRecord(resolveLimits({ build_rounds: 6, review_rounds: 1 }), LIMITS), {
    plan_rounds: LIMITS.plan_rounds, build_rounds: 6, review_rounds: 1,
    source: { plan_rounds: 'default', build_rounds: 'flag', review_rounds: 'flag' },
  })
})

test('run refuses an invalid round budget before reading crew state', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-rounds-refusal-home-'))
  let drove = 0
  try {
    await withHome(home, () => {
      for (const [flag, reason] of [
        ['plan-rounds', 'invalid-plan-rounds'],
        ['build-rounds', 'invalid-build-rounds'],
        ['review-rounds', 'invalid-review-rounds'],
      ]) {
        assert.throws(
          () => runCmd({ task: 'invalid-rounds-run', checkout: process.cwd(), 'brief-file': join(home, 'missing.md'), [flag]: '2.5' }, { drive: () => { drove += 1 } }),
          (err) => err.reason === reason,
        )
      }
      assert.equal(existsSync(join(home, '.crew')), false)
    })
    assert.equal(drove, 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('run plumbs flagged budgets, records defaults when absent, and preserves driver overrides', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-rounds-run-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-rounds-run-home-'))
  const task = 'rounds-run'
  execSync('git init -q', { cwd: checkout })
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# rounds brief\n')
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
      runCmd({ task, checkout, 'brief-file': brief, 'build-rounds': '5', 'review-rounds': '1', keep: true }, { drive: capture })
      runCmd({ task, checkout, 'brief-file': brief, keep: true }, { drive: capture })

      assert.deepEqual(seen[0].limits, { plan_rounds: 4 })
      assert.deepEqual(seen[1].limits, { build_rounds: 5, review_rounds: 1 })
      assert.equal(Object.prototype.hasOwnProperty.call(seen[2], 'limits'), false)
      const rows = readFileSync(seen[0].journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
        .filter((row) => row.event === 'limits')
      assert.equal(rows.length, 3)
      assert.deepEqual(rows[0], {
        at: rows[0].at, event: 'limits', plan_rounds: 4, build_rounds: LIMITS.build_rounds, review_rounds: LIMITS.review_rounds,
        source: { plan_rounds: 'flag', build_rounds: 'default', review_rounds: 'default' },
      })
      assert.deepEqual(rows[1], {
        at: rows[1].at, event: 'limits', plan_rounds: LIMITS.plan_rounds, build_rounds: 5, review_rounds: 1,
        source: { plan_rounds: 'default', build_rounds: 'flag', review_rounds: 'flag' },
      })
      assert.deepEqual(rows[2], {
        at: rows[2].at, event: 'limits', plan_rounds: LIMITS.plan_rounds, build_rounds: LIMITS.build_rounds, review_rounds: LIMITS.review_rounds,
        source: { plan_rounds: 'default', build_rounds: 'default', review_rounds: 'default' },
      })

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

test('run resolves, threads, and journals validation lanes without overloading fence names', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-validation-lane-run-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-validation-lane-run-home-'))
  const register = join(home, 'fences.json')
  const brief = join(home, 'brief.md')
  const task = 'validation-lane-run'
  writeFileSync(register, JSON.stringify({ lanes: [{ lane: 'fence-name', files: ['crew/crew.mjs'] }] }))
  writeFileSync(brief, '# validation lane brief\n')
  execSync('git init -q', { cwd: checkout })
  const seen = []
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      const capture = (ctx) => { seen.push(ctx); return done }
      runCmd({ task, checkout, 'brief-file': brief, 'validation-lane': '  npm test  ', keep: true }, { drive: capture })
      runCmd({ task, checkout, 'brief-file': brief, fences: register, lane: 'fence-name', keep: true }, { drive: capture })
      runCmd({ task, checkout, 'brief-file': brief, lane: '  ci-repair lane  ', keep: true }, { drive: capture })
    })
    assert.deepEqual(seen.map((ctx) => ctx.lane), ['npm test', null, 'ci-repair lane'])
    const rows = readFileSync(seen[0].journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      .filter((row) => row.event === 'validation-lane')
    assert.deepEqual(rows.map(({ lane, source }) => ({ lane, source })), [
      { lane: 'npm test', source: 'validation-lane' },
      { lane: null, source: 'none' },
      { lane: 'ci-repair lane', source: 'lane' },
    ])
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('run wires the compiled brief into the session row', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-proposal-run-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-proposal-run-home-'))
  const task = 'proposal-run'
  execSync('git init -q', { cwd: checkout })
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# proposal brief\n```proposal\n{"shape":"mechanical","strength":"workhorse"}\n```\n')
  const dbPath = join(home, 'ledger.db')
  const previousLedger = process.env.DEVTEAM_LEDGER_DB
  process.env.DEVTEAM_LEDGER_DB = dbPath
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      runCmd({ task, checkout, 'brief-file': brief, keep: true }, { drive: () => done })
    })
    if (!nodeMeetsLedgerFloor) return
    const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
    try {
      const row = ledger.dumpTable('sessions').find((candidate) => candidate.task_slug === task)
      assert.ok(row)
      assert.equal(row.proposed_shape, 'mechanical')
      assert.equal(row.proposed_strength, 'workhorse')
    } finally { ledger.close() }
  } finally {
    if (previousLedger === undefined) delete process.env.DEVTEAM_LEDGER_DB
    else process.env.DEVTEAM_LEDGER_DB = previousLedger
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('run keeps a blockless brief unmeasured and distinguishable from a compiler proposal', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-proposal-blockless-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-proposal-blockless-home-'))
  const task = 'proposal-blockless'
  execSync('git init -q', { cwd: checkout })
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# blockless brief\nno compiler proposal here\n')
  const dbPath = join(home, 'ledger.db')
  const previousLedger = process.env.DEVTEAM_LEDGER_DB
  process.env.DEVTEAM_LEDGER_DB = dbPath
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      runCmd({ task, checkout, 'brief-file': brief, keep: true }, { drive: () => done })
    })
    if (!nodeMeetsLedgerFloor) return
    const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
    try {
      const row = ledger.dumpTable('sessions').find((candidate) => candidate.task_slug === task)
      assert.ok(row)
      assert.equal(row.proposed_shape, null)
      assert.equal(row.proposed_strength, null)
      assert.notDeepEqual(
        { shape: row.proposed_shape, strength: row.proposed_strength },
        { shape: 'mechanical', strength: 'workhorse' },
      )
    } finally { ledger.close() }
  } finally {
    if (previousLedger === undefined) delete process.env.DEVTEAM_LEDGER_DB
    else process.env.DEVTEAM_LEDGER_DB = previousLedger
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('run leaves a malformed proposal unmeasured and completes the driver', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-proposal-malformed-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-proposal-malformed-home-'))
  const task = 'proposal-malformed'
  execSync('git init -q', { cwd: checkout })
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# malformed brief\n```proposal\n{ not json\n```\n')
  const dbPath = join(home, 'ledger.db')
  const previousLedger = process.env.DEVTEAM_LEDGER_DB
  process.env.DEVTEAM_LEDGER_DB = dbPath
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  const stderrSeen = []
  const previousStderrWrite = process.stderr.write
  let drove = 0
  let threw = null
  _resetNoticeGuardsForTest()
  try {
    process.stderr.write = (chunk) => { stderrSeen.push(String(chunk)); return true }
    try {
      await withHome(home, async () => {
        await bootCmd(
          { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
          { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
        )
        try {
          runCmd({ task, checkout, 'brief-file': brief, keep: true }, {
            drive: () => { drove += 1; return done },
          })
        } catch (err) { threw = err }
      })
    } finally { process.stderr.write = previousStderrWrite }
    assert.equal(threw, null)
    assert.equal(drove, 1)
    if (!nodeMeetsLedgerFloor) return
    const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
    try {
      const row = ledger.dumpTable('sessions').find((candidate) => candidate.task_slug === task)
      assert.ok(row)
      assert.equal(row.proposed_shape, null)
      assert.equal(row.proposed_strength, null)
    } finally { ledger.close() }
    assert.match(stderrSeen.join(''), /no readable compiler proposal/)
  } finally {
    process.stderr.write = previousStderrWrite
    if (previousLedger === undefined) delete process.env.DEVTEAM_LEDGER_DB
    else process.env.DEVTEAM_LEDGER_DB = previousLedger
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('run does not backfill historical session proposals', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-proposal-backfill-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-proposal-backfill-home-'))
  const task = 'proposal-backfill'
  const historical = 'historical-proposal-row'
  execSync('git init -q', { cwd: checkout })
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# proposal brief\n```proposal\n{"shape":"mechanical","strength":"workhorse"}\n```\n')
  const dbPath = join(home, 'ledger.db')
  const previousLedger = process.env.DEVTEAM_LEDGER_DB
  process.env.DEVTEAM_LEDGER_DB = dbPath
  const seeded = openLedger({ dbPath, stderr: { write: () => {} } })
  try {
    seeded.startSession({ adw_id: historical, repo_slug: 'r', task_slug: historical })
  } finally { seeded.close() }
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      runCmd({ task, checkout, 'brief-file': brief, keep: true }, { drive: () => done })
    })
    if (!nodeMeetsLedgerFloor) return
    const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
    try {
      const rows = ledger.dumpTable('sessions')
      const oldRow = rows.find((candidate) => candidate.adw_id === historical)
      const newRow = rows.find((candidate) => candidate.task_slug === task)
      assert.ok(oldRow)
      assert.ok(newRow)
      assert.equal(oldRow.proposed_shape, null)
      assert.equal(oldRow.proposed_strength, null)
      assert.equal(newRow.proposed_shape, 'mechanical')
      assert.equal(newRow.proposed_strength, 'workhorse')
      const proposedRows = rows.filter((row) => row.proposed_shape !== null || row.proposed_strength !== null)
      assert.equal(proposedRows.length, 1)
      assert.equal(proposedRows[0].adw_id, newRow.adw_id)
    } finally { ledger.close() }
  } finally {
    if (previousLedger === undefined) delete process.env.DEVTEAM_LEDGER_DB
    else process.env.DEVTEAM_LEDGER_DB = previousLedger
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('daemon path records the brief proposal with or without the crew.json brief_file', () => {
  const proposal = '# proposal brief\n```proposal\n{"shape":"mechanical","strength":"workhorse"}\n```\n'
  const daemonRun = (task, includeBriefFile) => {
    const root = mkdtempSync(join(tmpdir(), `crew-proposal-daemon-${task}-`))
    const crewDir = join(root, 'crew')
    const checkout = join(root, 'checkout')
    mkdirSync(crewDir, { recursive: true })
    mkdirSync(checkout, { recursive: true })
    mkdirSync(join(crewDir, 'returns'), { recursive: true })
    const brief = join(crewDir, 'brief.md')
    writeFileSync(brief, proposal)
    writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({
      schema_version: 3, task, checkout,
      roles: ['lead', 'planner', 'builder', 'reviewer'],
      members: Object.fromEntries(['lead', 'planner', 'builder', 'reviewer'].map((role) => [role, {
        surface_id: null, pane_id: null, transport: 'headless-json', model: 'sonnet', agent: 'claude',
      }])),
      task_return: join('returns', 'task.json'),
      ...(includeBriefFile ? { brief_file: brief } : {}),
    }))
    const dbPath = join(crewDir, 'ledger.db')
    try {
      runChild({ crew_dir: crewDir, task, brief_file: brief, checkout }, {
        preflight: false,
        seatIo: () => ({
          log: () => {}, assign: () => ({ id: 'x', returnPath: 'x' }), wait: () => null,
          writeFile: () => {}, readFile: () => null, run: () => ({ ok: true, output: '' }),
          changedFiles: () => [], commit: () => 'abc1234', now: () => 0,
        }),
        driveTask: () => ({ status: 'done', summary: '', artifacts: [], details: {} }),
        env: { DEVTEAM_LEDGER_DB: dbPath },
      })
      if (!nodeMeetsLedgerFloor) return null
      const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
      try { return ledger.dumpTable('sessions').find((row) => row.task_slug === task) } finally { ledger.close() }
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
  if (!nodeMeetsLedgerFloor) {
    daemonRun('proposal-daemon-key', true)
    daemonRun('proposal-daemon-nokey', false)
    return
  }
  const withKey = daemonRun('proposal-daemon-key', true)
  const withoutKey = daemonRun('proposal-daemon-nokey', false)
  assert.ok(withKey)
  assert.equal(withKey.proposed_shape, 'mechanical')
  assert.equal(withKey.proposed_strength, 'workhorse')
  assert.ok(withoutKey)
  assert.equal(withoutKey.proposed_shape, 'mechanical')
  assert.equal(withoutKey.proposed_strength, 'workhorse')
})

function childSignalFixture() {
  const root = mkdtempSync(join(tmpdir(), 'crew-child-signal-'))
  const crewDir = join(root, 'crew')
  const returnsDir = join(crewDir, 'returns')
  mkdirSync(join(crewDir, 'task'), { recursive: true })
  mkdirSync(returnsDir, { recursive: true })
  const taskReturn = join(returnsDir, 'task.json')
  const brief = join(crewDir, 'brief.md')
  writeFileSync(brief, '# child signal brief\n')
  writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({
    schema_version: 3, task: 'child-signal', checkout: root,
    roles: ['planner', 'builder', 'reviewer'],
    members: Object.fromEntries(['planner', 'builder', 'reviewer'].map((role) => [role, {
      surface_id: null, pane_id: null, transport: 'headless-json', model: 'sonnet', agent: 'claude',
    }])),
    task_return: taskReturn,
  }))
  writeFileSync(join(crewDir, 'journal.jsonl'), '')
  return { root, crewDir, taskReturn, brief, ledger: join(root, 'ledger.db') }
}

// A real signal to a real child is the only proof that survives the 2026-08-11
// convention: send SIGTERM while the child is blocked inside one named stretch of
// runChild and read how it died. Default disposition is `signal: 'SIGTERM'`; a
// handler armed across a turn-free stretch can never dispatch but still
// suppresses that disposition, so an armed child instead runs the block out and
// exits 0. Measured on this checkout: unarmed windows die in 1-2ms.
const SIGNAL_BLOCK_MS = 3000
const SIGNAL_KILL_BOUND_MS = 1000

async function sigtermWhileBlocked(f, body) {
  const harness = join(f.root, 'signal-harness.mjs')
  writeFileSync(harness, `import { runChild } from ${JSON.stringify(new URL('./child.mjs', import.meta.url).href)}
import { writeFileSync as realWrite } from 'node:fs'
const taskReturn = ${JSON.stringify(f.taskReturn)}
const spec = { crew_dir: ${JSON.stringify(f.crewDir)}, task: 'child-signal',
  brief_file: ${JSON.stringify(f.brief)}, checkout: ${JSON.stringify(f.root)},
  ledger_db: ${JSON.stringify(f.ledger)} }
const env = { DEVTEAM_LEDGER_DB: ${JSON.stringify(f.ledger)} }
const block = () => { process.stdout.write('mark\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${SIGNAL_BLOCK_MS}) }
${body}
`)
  let child
  try {
    child = spawn(process.execPath, [harness], { stdio: ['ignore', 'pipe', 'pipe'] })
    return await new Promise((resolve, reject) => {
      let marked = false
      let sentAt = null
      let settled = false
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, 15000)
      const finish = (value, failed = false) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (failed) reject(value)
        else resolve(value)
      }
      child.once('error', (err) => finish(err, true))
      child.stdout.on('data', (chunk) => {
        if (marked || !String(chunk).includes('mark')) return
        marked = true
        sentAt = Date.now()
        child.kill('SIGTERM')
      })
      child.stderr.on('data', () => {})
      child.once('exit', (code, signal) => finish({ marked, code, signal, elapsed: sentAt == null ? null : Date.now() - sentAt }))
    })
  } finally {
    if (child && child.exitCode == null && child.signalCode == null) child.kill('SIGKILL')
  }
}

function assertKilledBySigterm(outcome, where) {
  assert.equal(outcome.marked, true, `the child never reached ${where}`)
  assert.equal(outcome.signal, 'SIGTERM', `${where}: expected death by SIGTERM, got exit code ${outcome.code}`)
  assert.ok(outcome.elapsed < SIGNAL_KILL_BOUND_MS, `${where}: expected death within ${SIGNAL_KILL_BOUND_MS}ms, took ${outcome.elapsed}ms`)
}

test('the settle path writes the envelope before its teardown and only once', () => {
  const f = childSignalFixture()
  const order = []
  try {
    const result = runChild({ crew_dir: f.crewDir, task: 'child-signal', brief_file: f.brief, checkout: f.root, ledger_db: f.ledger }, {
      preflight: false,
      env: { DEVTEAM_LEDGER_DB: f.ledger },
      writeFileSync: (path, data, options) => {
        if (String(path) === f.taskReturn) order.push('envelope')
        writeFileSync(path, data, options)
      },
      seatIo: () => ({ teardown: () => { order.push('teardown'); return [] } }),
      driveTask: () => ({ status: 'done', summary: 'done', artifacts: [], details: {} }),
    })
    assert.equal(result.status, 'done')
    assert.deepEqual(order, ['envelope', 'teardown'])
    assert.equal(JSON.parse(readFileSync(f.taskReturn, 'utf8')).status, 'done')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('the child arms no teardown signal handler at any point in a run', () => {
  const f = childSignalFixture()
  // The 2026-08-11 convention's own prescription: INSTRUMENT the OS-level
  // listener count through the code path rather than reading that a
  // registration happened. Every stretch a daemon reap can land in is sampled.
  const counts = () => ['SIGTERM', 'SIGINT'].map((signal) => process.listenerCount(signal))
  const before = counts()
  const seen = {}
  try {
    runChild({ crew_dir: f.crewDir, task: 'child-signal', brief_file: f.brief, checkout: f.root, ledger_db: f.ledger }, {
      preflight: false,
      env: { DEVTEAM_LEDGER_DB: f.ledger },
      // The FIRST call after seatIo and the FIRST call inside settle are both
      // sampled: a listener armed only across one of them would be invisible to
      // a probe that watched just the later log and teardown callbacks.
      checkoutProtectedPaths: () => {
        seen['protected-paths checkout'] = counts()
        return { paths: [], used: false, reason: 'test-double', basis: 'test double' }
      },
      writeFileSync: (path, data, options) => {
        if (String(path) === f.taskReturn) seen['settlement envelope write'] ??= counts()
        writeFileSync(path, data, options)
      },
      seatIo: () => ({
        log: () => { seen['post-seatIo preflight'] ??= counts() },
        teardown: () => { seen['settlement teardown'] = counts(); return [] },
      }),
      driveTask: () => { seen.drive = counts(); return { status: 'done', summary: 'done', artifacts: [], details: {} } },
    })
    seen.after = counts()
    for (const where of [
      'protected-paths checkout', 'post-seatIo preflight', 'drive',
      'settlement envelope write', 'settlement teardown', 'after',
    ]) {
      assert.deepEqual(seen[where], before, where)
    }
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a real SIGTERM still kills a child mid-drive without waiting for the drive', async () => {
  const f = childSignalFixture()
  try {
    const outcome = await sigtermWhileBlocked(f, `runChild(spec, { preflight: false, env,
  seatIo: () => ({ teardown: () => [] }),
  driveTask: () => { block(); return { status: 'done', summary: 'late', artifacts: [], details: {} } },
})`)
    assertKilledBySigterm(outcome, 'the drive')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a real SIGTERM during synchronous preflight keeps the default disposition', async () => {
  const f = childSignalFixture()
  try {
    const outcome = await sigtermWhileBlocked(f, `runChild(spec, { env,
  execSync: () => { block(); return '' },
  seatIo: () => ({ teardown: () => [] }),
  driveTask: () => ({ status: 'done', summary: 'late', artifacts: [], details: {} }),
})`)
    assertKilledBySigterm(outcome, 'preflight')
    // A reap before settle() leaves no envelope. That residual is covered by the
    // daemon's settleSignalled, never by the child (crew/daemon.mjs).
    assert.equal(existsSync(f.taskReturn), false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a real SIGTERM in the post-seatIo preflight window keeps the default disposition', async () => {
  const f = childSignalFixture()
  try {
    const outcome = await sigtermWhileBlocked(f, `runChild(spec, { preflight: false, env,
  checkoutProtectedPaths: () => { block(); return { paths: [], used: false, reason: 'test-double', basis: 'test double' } },
  seatIo: () => ({ log: () => {}, teardown: () => [] }),
  driveTask: () => ({ status: 'done', summary: 'late', artifacts: [], details: {} }),
})`)
    assertKilledBySigterm(outcome, 'the post-seatIo preflight window')
    assert.equal(existsSync(f.taskReturn), false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a real SIGTERM during settlement keeps the default disposition', async () => {
  const f = childSignalFixture()
  try {
    const outcome = await sigtermWhileBlocked(f, `runChild(spec, { preflight: false, env,
  writeFileSync: (path, data, options) => { realWrite(path, data, options); if (String(path) === taskReturn) block() },
  seatIo: () => ({ log: () => {}, teardown: () => [] }),
  driveTask: () => ({ status: 'done', summary: 'ok', artifacts: [], details: {} }),
})`)
    assertKilledBySigterm(outcome, 'the settlement window')
    // The signal lands inside settle's OWN envelope write, the first thing it
    // does, and the bytes are already on disk when it does: a reap anywhere in
    // this window loses the teardown sweep that follows, never the run's record.
    assert.equal(existsSync(f.taskReturn), true)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('CLI refuses run fences before reading crew state', () => {
  const result = cliEntry('run', '--task', CLI_PROBE_TASK, '--brief-file', CLI_PROBE_BRIEF, '--fences', 'F')
  assert.equal(result.status, 2)
  assert.match(result.output, /--fences/)
  assert.match(result.output, /crew\.mjs boot/)
})

test('CLI explains that paired fences suppresses the requested run lane', () => {
  const result = cliEntry('run', '--task', CLI_PROBE_TASK, '--brief-file', CLI_PROBE_BRIEF, '--lane', 'L', '--fences', 'F')
  assert.equal(result.status, 2)
  assert.match(result.output, /--fences/)
  assert.match(result.output, /crew\.mjs boot/)
  assert.match(result.output, /--lane/)
  assert.match(result.output, /SUPPRESSING the --lane you asked for/)
})

test('run accepts bare lane and validation-lane flags and reaches crew state', () => {
  const bareLane = cliEntry('run', '--task', CLI_PROBE_TASK, '--brief-file', CLI_PROBE_BRIEF, '--lane', 'npm test')
  assert.notEqual(bareLane.status, 2)
  assert.match(bareLane.output, /no crew booted/)
  const validationLane = cliEntry('run', '--task', CLI_PROBE_TASK, '--brief-file', CLI_PROBE_BRIEF, '--validation-lane', 'npm test')
  assert.notEqual(validationLane.status, 2)
  assert.match(validationLane.output, /no crew booted/)
  assert.deepEqual(resolveValidationLane({ lane: 'npm test' }), { lane: 'npm test', source: 'lane' })
  assert.doesNotThrow(() => assertUsage('run', { task: 't', 'brief-file': 'brief.md', lane: 'npm test' }))
})

test('CLI reports missing task as usage for every task-bearing verb', () => {
  for (const argv of [
    ['boot'],
    ['run', '--brief-file', CLI_PROBE_BRIEF],
    ['handoff', '--brief-file', CLI_PROBE_BRIEF],
    ['teardown'],
  ]) {
    const result = cliEntry(...argv)
    assert.equal(result.status, 2, argv.join(' '))
    assert.match(result.output, /--task/, argv.join(' '))
  }
})

test('CLI reports missing run brief as usage', () => {
  const result = cliEntry('run', '--task', CLI_PROBE_TASK)
  assert.equal(result.status, 2)
  assert.match(result.output, /--brief-file/)
})

test('CLI refuses unknown flags and preserves unexpected-error exit 1', () => {
  const unknown = cliEntry('status', '--task', CLI_PROBE_TASK, '--bogus-flag')
  assert.equal(unknown.status, 2)
  assert.match(unknown.output, /--bogus-flag/)
  const internal = cliEntry('status', '--task', CLI_PROBE_TASK)
  assert.equal(internal.status, 1)
  assert.match(internal.output, /no crew booted/)
})

test('CLI process pins retain direct spawnSync entrypoint coverage', () => {
  const entry = fileURLToPath(new URL('./crew.mjs', import.meta.url))
  const options = { cwd: CLI_REPO_ROOT, encoding: 'utf8', env: CLI_ENV }
  const missingTask = spawnSync(process.execPath, [entry, 'boot'], options)
  const unexpected = spawnSync(process.execPath, [entry, 'status', '--task', CLI_PROBE_TASK], options)
  assert.equal(missingTask.status, 2)
  assert.equal(unexpected.status, 1)
})

test('CLI refusal probes do not create crew state', () => {
  const probeDir = join(homedir(), '.crew', basename(CLI_REPO_ROOT), CLI_PROBE_TASK)
  assert.equal(existsSync(probeDir), false)
})

test('flag contracts accept known flags, role prefixes, and reject malformed usage', () => {
  const valueFor = (flag) => flag === 'task' ? 't' : flag === 'brief-file' ? 'brief.md' : 'value'
  for (const [verb, flags] of Object.entries(KNOWN_FLAGS)) {
    const args = { _: [] }
    for (const flag of flags) args[flag] = valueFor(flag)
    assert.doesNotThrow(() => assertUsage(verb, args), `${verb} known flags`)
  }
  for (const prefix of ROLE_FLAG_PREFIXES) {
    assert.doesNotThrow(() => assertUsage('boot', { task: 't', [`${prefix}planner`]: 'value' }), prefix)
  }
  assert.doesNotThrow(() => assertUsage('boot', { task: 't', 'allow-shortfall-nosuchrole': 'value' }))
  assert.doesNotThrow(() => assertUsage('boot', { task: 't', fences: 'register.json' }))
  assert.throws(
    () => assertUsage('run', { task: 't', 'brief-file': 'brief.md', fences: 'register.json' }),
    (err) => err instanceof UsageError && err.usage === true && /crew\.mjs boot/.test(err.message),
  )
  assert.throws(
    () => assertUsage('status', { task: 't', lane: 'L' }),
    (err) => err instanceof UsageError && err.usage === true && /BOOT-time/.test(err.message) && /crew\.mjs boot/.test(err.message),
  )
  for (const [verb, flags] of Object.entries(REQUIRED_FLAGS)) {
    for (const flag of flags) {
      const valid = { task: 't' }
      if (flags.includes('brief-file')) valid['brief-file'] = 'brief.md'
      valid[flag] = true
      assert.throws(() => assertUsage(verb, valid), `${verb} valueless ${flag}`)
      valid[flag] = '   '
      assert.throws(() => assertUsage(verb, valid), `${verb} empty ${flag}`)
    }
  }
  assert.deepEqual(BOOT_ONLY_FLAGS, ['fences', 'lane'])
})

test('run exit constants preserve done, escalation, and unexpected meanings', () => {
  assert.deepEqual(RUN_EXIT_CODES, { done: 0, escalation: 3 })
  assert.equal(RUN_EXIT_UNEXPECTED, 1)
  assert.equal(runExitCode({ status: 'anything-else' }), RUN_EXIT_UNEXPECTED)
})

test('run exits 3 on an escalation, 0 on done, and 1 on anything else', () => {
  for (const [result, expected] of [
    [{ status: 'done' }, 0], [{ status: 'escalation' }, 3], [{ status: 'blocked' }, 1],
    [{ status: 'converge' }, 1], [{}, 1], [null, 1],
  ]) assert.equal(runExitCode(result), expected)
})

test('run derives its process exit code from the envelope status', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-exit-code-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-exit-code-home-'))
  const task = 'exit-code-run'
  execSync('git init -q', { cwd: checkout })
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# exit code brief\n')
  const envelopes = [
    [{ status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }, 0],
    [{ status: 'escalation', summary: 'needs a human', artifacts: [], details: { escalation: { why: 'review' } } }, 3],
    [{ status: 'blocked', summary: 'blocked', artifacts: [], details: {} }, 1],
  ]
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      for (const [envelope, expected] of envelopes) {
        const previous = process.exitCode
        try {
          process.exitCode = undefined
          runCmd({ task, checkout, 'brief-file': brief, keep: true }, { drive: () => envelope })
          assert.equal(process.exitCode, expected)
        } finally { process.exitCode = previous }
      }
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('child entrypoint plumbs, journals, and refuses round budgets', () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-rounds-child-'))
  const crewDir = join(root, 'crew')
  const checkout = join(root, 'checkout')
  mkdirSync(crewDir, { recursive: true })
  mkdirSync(checkout, { recursive: true })
  mkdirSync(join(crewDir, 'returns'), { recursive: true })
  const brief = join(crewDir, 'brief.md')
  writeFileSync(brief, '# child rounds brief\n')
  writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({
    schema_version: 3, task: 'child-rounds', checkout,
    roles: ['lead', 'planner', 'builder', 'reviewer'],
    members: Object.fromEntries(['lead', 'planner', 'builder', 'reviewer'].map((role) => [role, {
      surface_id: null, pane_id: null, transport: 'headless-json', model: 'sonnet', agent: 'claude',
    }])),
    task_return: join('returns', 'task.json'),
  }))
  const makeRun = (budget = {}) => {
    const rows = []
    let seen = null
    let drove = 0
    const io = {
      log: (row) => rows.push(row), assign: () => ({ id: 'x', returnPath: 'x' }), wait: () => null,
      writeFile: () => {}, readFile: () => null, run: () => ({ ok: true, output: '' }),
      changedFiles: () => [], commit: () => 'abc1234', now: () => 0,
    }
    const spec = { crew_dir: crewDir, task: 'child-rounds', brief_file: brief, checkout, ...budget }
    runChild(spec, {
      preflight: false, seatIo: () => io,
      driveTask: (ctx) => { drove += 1; seen = ctx; return { status: 'done', summary: '', artifacts: [], details: {} } },
      env: { DEVTEAM_LEDGER_DB: join(crewDir, 'ledger.db') },
    })
    return { rows, seen, drove }
  }
  try {
    const flagged = makeRun({ build_rounds: 4, review_rounds: 1 })
    assert.deepEqual(flagged.seen.limits, { build_rounds: 4, review_rounds: 1 })
    assert.deepEqual(flagged.rows.find((row) => row.event === 'limits'), {
      at: flagged.rows.find((row) => row.event === 'limits').at, event: 'limits',
      plan_rounds: LIMITS.plan_rounds, build_rounds: 4, review_rounds: 1,
      source: { plan_rounds: 'default', build_rounds: 'flag', review_rounds: 'flag' },
    })
    const plain = makeRun()
    assert.equal(Object.prototype.hasOwnProperty.call(plain.seen, 'limits'), false)
    const plainRow = plain.rows.find((row) => row.event === 'limits')
    assert.deepEqual(plainRow, {
      at: plainRow.at, event: 'limits',
      plan_rounds: LIMITS.plan_rounds, build_rounds: LIMITS.build_rounds, review_rounds: LIMITS.review_rounds,
      source: { plan_rounds: 'default', build_rounds: 'default', review_rounds: 'default' },
    })
    for (const [budget, reason] of [
      [{ build_rounds: '2.5' }, 'invalid-build-rounds'],
      [{ review_rounds: 0 }, 'invalid-review-rounds'],
    ]) {
      let drove = 0
      assert.throws(() => runChild(
        { crew_dir: crewDir, task: 'child-rounds', brief_file: brief, checkout, ...budget },
        { preflight: false, seatIo: () => ({ log: () => {} }), driveTask: () => { drove += 1 }, env: { DEVTEAM_LEDGER_DB: join(crewDir, 'ledger.db') } },
      ), (err) => err.reason === reason)
      assert.equal(drove, 0)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('child entrypoint resolves both validation lane spellings, journals them, and refuses malformed specs', () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-validation-lane-child-'))
  const crewDir = join(root, 'crew')
  const checkout = join(root, 'checkout')
  mkdirSync(crewDir, { recursive: true })
  mkdirSync(checkout, { recursive: true })
  mkdirSync(join(crewDir, 'returns'), { recursive: true })
  const brief = join(crewDir, 'brief.md')
  writeFileSync(brief, '# child validation lane brief\n')
  writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({
    schema_version: 3, task: 'child-validation-lane', checkout,
    roles: ['lead', 'planner', 'builder', 'reviewer'],
    members: Object.fromEntries(['lead', 'planner', 'builder', 'reviewer'].map((role) => [role, {
      surface_id: null, pane_id: null, transport: 'headless-json', model: 'sonnet', agent: 'claude',
    }])),
    task_return: join('returns', 'task.json'),
  }))
  const base = { crew_dir: crewDir, task: 'child-validation-lane', brief_file: brief, checkout }
  const makeRun = (laneSpec) => {
    const rows = []
    let seen = null
    let drove = 0
    const io = {
      log: (row) => rows.push(row), assign: () => ({ id: 'x', returnPath: 'x' }), wait: () => null,
      writeFile: () => {}, readFile: () => null, run: () => ({ ok: true, output: '' }),
      changedFiles: () => [], commit: () => 'abc1234', now: () => 0,
    }
    runChild({ ...base, ...laneSpec }, {
      preflight: false, seatIo: () => io,
      driveTask: (ctx) => { drove += 1; seen = ctx; return { status: 'done', summary: '', artifacts: [], details: {} } },
      env: { DEVTEAM_LEDGER_DB: join(crewDir, 'ledger.db') },
    })
    return { rows, seen, drove }
  }
  try {
    for (const [laneSpec, expected] of [
      [{ validation_lane: '  node --test  ' }, { lane: 'node --test', source: 'validation-lane' }],
      [{ lane: '  daemon repair lane  ' }, { lane: 'daemon repair lane', source: 'lane' }],
    ]) {
      const result = makeRun(laneSpec)
      assert.equal(result.seen.lane, expected.lane)
      assert.deepEqual(result.rows.find((row) => row.event === 'validation-lane'), {
        at: result.rows.find((row) => row.event === 'validation-lane').at, event: 'validation-lane', ...expected,
      })
    }
    let drove = 0
    assert.throws(() => runChild(
      { ...base, validation_lane: true },
      { preflight: false, seatIo: () => ({ log: () => {} }), driveTask: () => { drove += 1 }, env: { DEVTEAM_LEDGER_DB: join(crewDir, 'ledger.db') } },
    ), (err) => err.reason === 'invalid-validation-lane')
    assert.equal(drove, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('child preflight uses the scout shape seats and keeps the default tier guard', () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-scout-child-'))
  const crewDir = join(root, 'crew')
  const checkout = join(root, 'checkout')
  mkdirSync(crewDir, { recursive: true })
  mkdirSync(checkout, { recursive: true })
  mkdirSync(join(crewDir, 'returns'), { recursive: true })
  const brief = join(crewDir, 'brief.md')
  writeFileSync(brief, '# scout brief\n')
  writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({
    schema_version: 3, task: 'scout-child', checkout,
    roles: ['planner'],
    members: { planner: { surface_id: null, pane_id: null, transport: 'headless-json', model: 'sonnet', agent: 'claude' } },
    task_return: join('returns', 'task.json'),
  }))
  execSync('git init -q', { cwd: checkout })
  const base = { crew_dir: crewDir, task: 'scout-child', brief_file: brief, checkout }
  let drove = 0
  let seen = null
  const io = { log: () => {} }
  try {
    runChild({ ...base, variant: 'scout' }, {
      seatIo: () => io,
      driveTask: (ctx) => { drove += 1; seen = ctx; return { status: 'done', summary: '', artifacts: [], details: {} } },
      env: { DEVTEAM_LEDGER_DB: join(crewDir, 'ledger.db') },
    })
    assert.deepEqual(seen.roles, ['planner'])
    assert.equal(drove, 1)
    assert.throws(() => runChild(base, {
      seatIo: () => io,
      driveTask: () => { drove += 1 },
      env: { DEVTEAM_LEDGER_DB: join(crewDir, 'ledger.db') },
    }), /requires a builder seat/)
    assert.equal(drove, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('repair lane absence remains the current triage refusal', () => {
  const result = driveTask({
    task: 'repair-lane-refusal', briefFile: '/tmp/brief.md', taskDir: '/tmp/repair-lane-refusal',
    checkout: '/tmp/repo', journal: '/tmp/repair-lane-refusal/journal.jsonl',
    files_in_scope: ['crew/crew.mjs'], lane: null, variant: 'repair',
  }, { log: () => {}, now: () => 0 })
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'triage')
  assert.match(result.details.escalation.why, /takes its validation lane from the failing run \(--lane\) and ctx carries none/)
})

test('crew CLI usage documents all per-run round budget flags', () => {
  const source = readFileSync(new URL('./crew.mjs', import.meta.url), 'utf8')
  assert.match(source, /--plan-rounds/)
  assert.match(source, /--build-rounds/)
  assert.match(source, /--review-rounds/)
  assert.match(source, /--validation-lane/)
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
      assert.throws(() => runCmd({ task, checkout, 'brief-file': brief, variant: inherited, lane: 'lane-cmd', keep: true }, { drive: () => { drove += 1 } }), (err) => err.message.includes('task.json'))
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
      runCmd({ task, checkout, 'brief-file': brief, variant: inherited, lane: 'lane-cmd', 'files-in-scope': 'a.mjs, a.test.mjs', keep: true }, { drive: capture })
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

test('directed dispatch without a validation lane refuses before crew state or seats', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-directed-lane-refusal-home-'))
  let drove = 0
  try {
    await withHome(home, () => {
      assert.throws(
        () => runCmd(
          { task: 'directed-never-booted', checkout: process.cwd(), 'brief-file': join(home, 'missing.md'), variant: 'directed' },
          { drive: () => { drove += 1 } },
        ),
        (err) => err.reason === VALIDATION_LANE_REFUSAL,
      )
      assert.equal(drove, 0)
      assert.equal(existsSync(join(home, '.crew')), false)
    })
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('ctx source validation permits supplied lanes and neutral full dispatches', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-ctx-source-pass-home-'))
  try {
    await withHome(home, () => {
      assert.throws(
        () => runCmd({ task: 'directed-with-lane', checkout: process.cwd(), 'brief-file': join(home, 'missing.md'), variant: 'directed', 'validation-lane': 'node --test' }),
        /no crew booted/,
      )
      assert.throws(
        () => runCmd({ task: 'full-without-lane', checkout: process.cwd(), 'brief-file': join(home, 'missing.md'), variant: 'full' }),
        /no crew booted/,
      )
    })
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('assertCtxSources follows every variant declaration without restating shape names', () => {
  for (const name of VARIANT_NAMES) {
    const needsLane = VARIANTS[name]?.sources?.lane === 'ctx'
    if (needsLane) {
      assert.throws(() => assertCtxSources(name), (err) => err.reason === VALIDATION_LANE_REFUSAL)
    } else {
      assert.doesNotThrow(() => assertCtxSources(name))
    }
  }
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

test('boot wiring places the definition band check before the breaker', () => {
  const source = readFileSync(new URL('./crew.mjs', import.meta.url), 'utf8')
  const seatFloors = source.indexOf('assertBandFloors(seats, tierName,')
  const breaker = source.indexOf('assertCellsClosed(breaker)')
  assert.ok(seatFloors >= 0)
  assert.ok(breaker > seatFloors)
  const sites = [...source.matchAll(/assertDefBandFloors\(/g)].map((match) => match.index)
  assert.equal(sites.filter((index) => index > seatFloors && index < breaker).length, 1)
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

test('seatIo status and showDoc make no cmux calls without a workspace and status still works with one', () => {
  const parent = mkdtempSync(join(tmpdir(), 'crew-seat-io-'))
  const paths = { dir: parent, taskDir: parent, returnsDir: join(parent, 'returns') }
  mkdirSync(paths.returnsDir, { recursive: true })
  const cmuxHeadless = callCounter()
  try {
    const headless = seatIo({ workspace_id: null, window_id: null, members: { builder: { surface_id: null } } }, paths, parent, null, null, {}, { cmux: cmuxHeadless, tree: () => ({ windows: [] }) })
    headless.status('build')
    headless.showDoc(join(parent, 'plan.md'))
    assert.equal(cmuxHeadless.calls.length, 0)

    const cmuxPanes = callCounter()
    const paned = seatIo({ workspace_id: 'workspace-1', window_id: 'window-1', members: { lead: { surface_id: 'surface-lead' } } }, paths, parent, null, null, {}, { cmux: cmuxPanes, tree: () => ({ windows: [] }) })
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

test('grantedDefModels reads only pinned defs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-def-models-'))
  const pinned = join(dir, 'pinned.json')
  const bare = join(dir, 'bare.json')
  try {
    writeFileSync(pinned, JSON.stringify({ name: 'pinner', prompt: 'p', model: 'anthropic/claude-opus-5' }))
    writeFileSync(bare, JSON.stringify({ name: 'bare', prompt: 'p' }))
    const adapters = {
      planner: { grants: { agents: [{ name: 'pinner', def: pinned }, { name: 'bare', def: bare }] } },
      builder: { grants: { agents: [] } },
    }
    assert.deepEqual(grantedDefModels(adapters), [{
      role: 'planner', agent: 'pinner', path: pinned, model: 'anthropic/claude-opus-5',
    }])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('assertDefBandFloors refuses below-floor and unknown pinned models', () => {
  const ladder = loadLadder()
  const adapters = { planner: { adapter: { modelString: piModelString } } }
  const defs = (model) => [{ role: 'planner', agent: 'scout', path: '/tmp/scout.json', model }]
  assert.throws(
    () => assertDefBandFloors(defs('anthropic/claude-haiku-4-5'), 'build', ladder, { adapters }),
    (err) => err.reason === 'band-below-floor' && BAND_FLOOR_REFUSALS.includes(err.reason),
  )
  assert.throws(
    () => assertDefBandFloors(defs('anthropic/no-such-model'), 'build', ladder, { adapters }),
    (err) => err.reason === 'band-unknown' && BAND_FLOOR_REFUSALS.includes(err.reason),
  )
  assert.doesNotThrow(() => assertDefBandFloors(defs('anthropic/claude-opus-5'), 'build', ladder, { adapters }))
  assert.doesNotThrow(() => assertDefBandFloors([], 'not-a-tier', ladder, { adapters }))
})

test('loadLadder reads the ratified bands and tier floors through the runtime seam', () => {
  const ladder = loadLadder()
  assert.equal(ladder.path, LADDER_PATH)
  assert.deepEqual(Object.fromEntries(ladder.ranks), { frontier: 3, workhorse: 2, utility: 1, basement: 0 })
  assert.deepEqual(ladder.floors, { mechanical: 'utility', build: 'utility', judge: 'utility' })
})

test('loadLadder refuses every malformed artifact shape as ladder-unreadable', () => {
  const fixture = (mutate) => {
    const value = structuredClone(rosterLadder)
    mutate(value)
    return { path: '/ignored/model-ladder.json', readFile: () => JSON.stringify(value) }
  }
  const cases = [
    ['missing path', { path: '/no/such/dir/model-ladder.json' }],
    ['unparseable JSON', { path: '/ignored', readFile: () => 'not json' }],
    ['non-object', { path: '/ignored', readFile: () => '[]' }],
    ['missing bands and floors', { path: '/ignored', readFile: () => '{"schema_version":1}' }],
    ['schema version', fixture((l) => { l.schema_version = 2 })],
    ['ratified_at', fixture((l) => { delete l.ratified_at })],
    ['blank ratified_by', fixture((l) => { l.ratified_by = '' })],
    ['empty bands', fixture((l) => { l.bands = [] })],
    ['missing rank', fixture((l) => { delete l.bands[0].rank })],
    ['missing floor reference', fixture((l) => { delete l.bands[1].floor_reference_score })],
    ['duplicate band', fixture((l) => { l.bands[1].band = l.bands[0].band })],
    ['null member', fixture((l) => { l.bands[0].members.push(null) })],
    ['object member', fixture((l) => { l.bands[0].members.push({ id: 'x' }) })],
    ['blank member', fixture((l) => { l.bands[0].members.push('') })],
    ['bare member', fixture((l) => { l.bands[0].members.push('claude-sonnet-5') })],
    ['duplicate member', fixture((l) => { l.bands[1].members.push(l.bands[0].members[0]) })],
    ['missing build floor', fixture((l) => { delete l.tier_floors.build })],
    ['unknown build floor', fixture((l) => { l.tier_floors.build = 'no-such-band' })],
    ['missing cost ceilings', fixture((l) => { delete l.cost_ceilings })],
    ['negative build ceiling', fixture((l) => { l.cost_ceilings.build = -1 })],
  ]
  for (const [name, options] of cases) {
    assert.throws(() => loadLadder(options), (err) => err.reason === 'ladder-unreadable', name)
  }
})

test('assertBandFloors distinguishes a violated floor from ladder-unreadable', () => {
  const ladder = loadLadder()
  assert.throws(
    () => assertBandFloors({ builder: { provider: 'anthropic', id: 'claude-haiku-4-5', model: 'claude-haiku-4-5' } }, 'build', ladder),
    (err) => err.reason === 'band-below-floor' && err.reason !== 'ladder-unreadable',
  )
})

test('a below-floor roster seat refuses with its band and tier floor in the message', () => {
  const ladder = loadLadder()
  assert.throws(
    () => assertBandFloors({ builder: { provider: 'anthropic', id: 'claude-haiku-4-5' } }, 'build', ladder),
    (err) => err.reason === 'band-below-floor'
      && ['builder', 'claude-haiku-4-5', 'basement', 'utility'].every((word) => err.message.includes(word)),
  )
})

test('every ratified roster tier still passes its ratified band floor', () => {
  const ladder = loadLadder()
  for (const tier of Object.keys(roster.tiers)) {
    const { seats } = resolveTier(roster, tier, {})
    assert.doesNotThrow(() => assertBandFloors(seats, tier, ladder), tier)
  }
})

test('raw overrides resolve through the pi adapter namespace and never by textual equality', () => {
  const ladder = loadLadder()
  const adapter = { modelString: piModelString }
  const ctx = { adapters: { builder: { adapter } } }
  const raw = (model) => ({ builder: { provider: null, id: null, model } })
  assert.equal(seatModelKey(raw('openai-codex/gpt-5.6-luna').builder), 'openai-codex/gpt-5.6-luna')
  assert.deepEqual(bandForMember(ladder, 'openai/gpt-5.6-luna'), { member: 'openai/gpt-5.6-luna', band: 'utility' })
  assert.deepEqual(bandForRaw(ladder, 'openai-codex/gpt-5.6-luna', adapter), { member: 'openai/gpt-5.6-luna', band: 'utility' })
  assert.deepEqual(seatBand(ladder, raw('openai-codex/gpt-5.6-luna').builder, { adapter }), { member: 'openai/gpt-5.6-luna', band: 'utility' })
  assert.doesNotThrow(() => assertBandFloors(raw('openai-codex/gpt-5.6-luna'), 'build', ladder, ctx))
  assert.throws(() => assertBandFloors(raw('anthropic/claude-haiku-4-5'), 'build', ladder, ctx), (err) => err.reason === 'band-below-floor' && err.message.includes('anthropic/claude-haiku-4-5'))
  assert.throws(() => assertBandFloors(raw('openai/gpt-5.6-luna'), 'build', ladder, ctx), (err) => err.reason === 'band-unknown')
})

test('raw overrides use the claude adapter namespace and unknown adapters prove nothing', () => {
  const ladder = loadLadder()
  const claude = { modelString: claudeModelString }
  const ctx = { adapters: { builder: { adapter: claude } } }
  const raw = (model) => ({ builder: { provider: null, id: null, model } })
  assert.throws(() => assertBandFloors(raw('claude-haiku-4-5'), 'build', ladder, ctx), (err) => err.reason === 'band-below-floor')
  assert.throws(() => assertBandFloors(raw('anthropic/claude-haiku-4-5'), 'build', ladder, ctx), (err) => err.reason === 'band-unknown')
  assert.throws(() => assertBandFloors(raw('opus'), 'build', ladder, ctx), (err) => err.reason === 'band-unknown')
  assert.throws(() => assertBandFloors(raw('claude-haiku-4-5'), 'build', ladder, { adapters: { builder: { adapter: {} } } }), (err) => err.reason === 'band-unknown')
})

test('an unresolvable roster cell is band-unknown and never passes', () => {
  const ladder = loadLadder()
  assert.throws(
    () => assertBandFloors({ builder: { provider: 'acme', id: 'no-such-model' } }, 'build', ladder),
    (err) => err.reason === 'band-unknown' && err.message.includes('acme/no-such-model'),
  )
})

test('a tier with no ratified floor refuses floor-unratified', () => {
  const ladder = { path: '/hand-built', ranks: new Map([['utility', 1]]), members: new Map(), floors: {} }
  assert.throws(() => assertBandFloors({}, 'build', ladder), (err) => err.reason === 'floor-unratified')
})

test('the band-floor refusal reason set is frozen and closed', () => {
  assert.equal(Object.isFrozen(BAND_FLOOR_REFUSALS), true)
  assert.throws(() => refuseBandFloor('anything-else', 'x'))
})

test('bootCmd refuses a below-floor raw override before state or driver side effects', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-band-floor-refusal-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-band-floor-refusal-checkout-')
  const task = 'band-floor-refusal'
  const cmux = callCounter(); const tree = callCounter(); const renameTab = callCounter()
  try {
    await withBreakerEnv({}, () => withHome(home, () => assert.rejects(
      () => bootCmd({ task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath, 'model-builder': 'anthropic/claude-haiku-4-5' }, { cmux, tree, renameTab }),
      (err) => {
        assert.equal(err.reason, 'band-below-floor')
        assert.match(err.message, /builder/)
        return true
      },
    )))
    assert.equal(cmux.calls.length, 0)
    assert.equal(tree.calls.length, 0)
    assert.equal(renameTab.calls.length, 0)
    assert.equal(existsSync(testCrewDir(home, checkout, task)), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('bootCmd accepts an at-floor raw override and preserves its untranslated record', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-band-floor-accept-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-band-floor-accept-checkout-')
  const task = 'band-floor-accepted'
  try {
    await withBreakerEnv({}, () => withHome(home, () => bootCmd(
      { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath, 'model-builder': 'openai-codex/gpt-5.6-luna' },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
    )))
    const record = JSON.parse(readFileSync(join(testCrewDir(home, checkout, task), 'crew.json'), 'utf8'))
    assert.equal(record.members.builder.provider, null)
    assert.equal(record.members.builder.id, null)
    assert.equal(record.members.builder.model, 'openai-codex/gpt-5.6-luna')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
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

test('assertSeats reads declared envelope seats and keeps the lead rule', () => {
  const plannerOnlyCrew = { roles: ['lead', 'planner'], members: { lead: {}, planner: {} } }
  assert.doesNotThrow(() => assertSeats(plannerOnlyCrew, 'scout'))
  assert.throws(() => assertSeats(plannerOnlyCrew, 'full'), /requires a builder seat/)
  assert.throws(() => assertSeats({ roles: ['lead', 'planner'], members: { planner: {} } }, 'scout'), /requires a lead seat/)
  assert.throws(() => assertSeats(plannerOnlyCrew), /requires a builder seat/)
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
    kind: 'seat-died', stage: 'seat-died', detail: 'pane gone', attribution: null,
  })

  emitAdapter(emitter)({ kind: 'cell-failure', role: 'reviewer', failure: 'timeout' })
  assert.deepEqual(calls[1], {
    adw_id: 'adw-cell', task_slug: null, phase_id: null, dispatch_id: null, role: 'reviewer',
    agent: null, provider: null, model_id: null, model: null, effort: null, transport: null,
    kind: 'timeout', stage: null, detail: null, attribution: null,
  })

  emitAdapter(emitter)({ kind: 'cell-failure', role: 'builder', id: 'd5', failure: 'timeout', attribution: 'host' })
  assert.equal(calls[2].attribution, 'host')
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
    assert.deepEqual([...CAPABILITY_REFUSALS], ['register-invalid', 'capability-shortfall', 'unknown-grant', 'grant-unsupported', 'extension-missing', 'unknown-skill', 'agent-def-invalid', 'local-settings-missing', 'local-endpoint-dead', 'grant-contradicts-deny'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a register granting fan-out to a seat whose defaults withhold it refuses at boot', async () => {
  const root = capabilityFixtureRoot()
  try {
    const base = capabilityRegister()
    const bundle = { tools: [], extensions: ['crew/pi/fanout.js'], agents: [{ name: 'Explore', def: 'crew/pi/explore.json' }], skills: [], advisor: false, requires: [] }
    // The contradiction is register-vs-charter, so it refuses on EVERY adapter.
    for (const role of ['lead', 'builder', 'tech-lead']) {
      assert.deepEqual(deniedFanout(role), [...FANOUT_TOOLS])
      const register = capabilityRegister({ roles: { [role]: { ...base.roles[role], ...bundle } } })
      for (const args of [{}, { [`agent-${role}`]: 'pi' }]) {
        await assert.rejects(
          () => resolveAdapters([role], args, null, { register, root }),
          (err) => {
            assert.equal(err.reason, 'grant-contradicts-deny')
            assert.ok(CAPABILITY_REFUSALS.includes(err.reason))
            assert.equal(err.role, role)
            assert.match(err.message, new RegExp(role))
            assert.match(err.message, /Task,Agent,Workflow/)
            assert.match(err.message, /Explore/)
            return true
          },
        )
      }
    }
    // The other direction: a role that legitimately fans out is untouched.
    assert.deepEqual(deniedFanout('planner'), [])
    assert.deepEqual(deniedFanout('reviewer'), [])
    const planner = capabilityRegister({ roles: { planner: { ...base.roles.planner, ...bundle, requires: ['subagents'] } } })
    const resolved = await resolveAdapters(['planner'], { 'agent-planner': 'pi' }, null, { register: planner, root })
    assert.equal(resolved.planner.grants.agents.length, 1)
    assert.deepEqual(assertFanoutCoherent('planner', resolved.planner.grants), resolved.planner.grants)
    // An agents-free grant to a denying seat is no contradiction.
    assert.deepEqual(assertFanoutCoherent('builder', EMPTY_GRANTS), EMPTY_GRANTS)
    // The refusal is wired into the boot seam, not merely exported.
    assert.match(readFileSync(new URL('./crew.mjs', import.meta.url), 'utf8'), /assertFanoutCoherent\(role, grants\)/)
    // translateDeny is UNCHANGED: it still drops every name it cannot map, which
    // is why the boundary has to live at boot.
    assert.deepEqual(translateDeny(SEAT_DEFAULTS.builder.deny), [])
    assert.deepEqual(translateDeny(SEAT_DEFAULTS.lead.deny), ['edit'])
    assert.deepEqual(translateDeny('Edit,NoSuchTool,Task'), ['edit'])
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

test('advisor boot and manifest contracts stay closed and fail closed', () => {
  assert.equal(ADVISOR_CONFIG_VERSION, 1)
  assert.ok(Object.isFrozen(ADVISOR_BOOT_REFUSALS))
  assert.ok(ADVISOR_BOOT_REFUSALS.includes('adapter-unsupported'))
  assert.equal(String(SAFE_MODEL), '/^[A-Za-z0-9][A-Za-z0-9._:\\\/-]{0,127}$/')
  assert.deepEqual(classifyAdvisorCell({ endpoint: 'http://127.0.0.1/v1', model: 'qwen3-coder' }), { endpoint: 'http://127.0.0.1/v1', model: 'qwen3-coder' })
  const brief = 'tripwire tests:\n- crew/crew.mjs · bootCmd\nbroad keys (not used):\n'
  const manifest = advisorManifest({ briefText: brief, task: 'b69', runStartedAt: 1 })
  assert.deepEqual(manifest.tripwires, ['crew/crew.mjs'])
  assert.throws(() => assertAdvisorManifest({ granted: ['builder'], manifest: null, written: false }), /manifest/)
  assert.doesNotThrow(() => assertAdvisorManifest({ granted: [], manifest: null, written: false }))
})
