import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EVENT_TYPES, PAYLOAD_KEYS, NODE_FLOOR, openLedger } from '../scripts/factory/ledger.mjs'
import { openRun } from '../scripts/factory/emit.mjs'
import {
  composeLayout, SEAT_DEFAULTS, DEFAULT_ROLES, ROLE_ORDER, transportFor, assertCapabilities, resolveAdapters, resolveWorkerBin, docOpenArgs,
  resolveTier, resolveSeatModels, seatReadySignal, assertSeats, phaseForStage, emitAdapter,
  waitForEnvelope, WAIT_POLL_MS, LIVENESS_PROBE_MS, LIVENESS_MISSES_TO_DIE,
} from './crew.mjs'
import { driveTask } from './drive.mjs'
import { seatCommand, capabilitiesFor, modelString as claudeModelString } from './adapters/adapter-claude.mjs'
import { seatCommand as piSeatCommand, capabilitiesFor as piCapabilitiesFor, modelString as piModelString, translateDeny } from './adapters/adapter-pi.mjs'

const roster = JSON.parse(readFileSync(new URL('./roster.json', import.meta.url), 'utf8'))

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
  assert.deepEqual({ ...claudePane }, { prompt_file: true, tool_deny: true, unattended: true, effort: true, interjection: 'none', abort: 'none', session_resume: false, durable_cursor: 'none', reassign: true })
  assert.ok(Object.isFrozen(claudePane))
  const claudeHeadless = capabilitiesFor({ transport: 'headless-json' })
  assert.deepEqual({ ...claudeHeadless }, { prompt_file: true, tool_deny: true, unattended: true, effort: true, interjection: 'turn', abort: 'signal', session_resume: true, durable_cursor: 'none', reassign: false })
  assert.ok(Object.isFrozen(claudeHeadless))
  const piPane = piCapabilitiesFor({ transport: 'pane' })
  // #131: drive.mjs bounce paths reassign a settled pane seat.
  assert.deepEqual({ ...piPane }, { prompt_file: true, tool_deny: true, unattended: true, effort: true, interjection: 'none', abort: 'none', session_resume: false, durable_cursor: 'none', reassign: true })
  assert.ok(Object.isFrozen(piPane))
  const piHeadless = piCapabilitiesFor({ transport: 'headless-rpc' })
  // #148: reassign captured live (captures/pi-b11-reassign.jsonl) — a settled
  // session takes a further assignment same-process and cross-process.
  assert.deepEqual({ ...piHeadless }, { prompt_file: true, tool_deny: true, unattended: true, effort: true, interjection: 'boundary', abort: 'command', session_resume: true, durable_cursor: 'entry_id', reassign: true })
  assert.ok(Object.isFrozen(piHeadless))
})

test('unshipped capability pairs and absent transports throw naming adapter and transport', () => {
  for (const [adapter, name, transport] of [[capabilitiesFor, 'claude', 'headless-rpc'], [piCapabilitiesFor, 'pi', 'headless-json']]) {
    assert.throws(() => adapter({ transport }), (err) => err.message.includes(name) && err.message.includes(transport))
    assert.throws(() => adapter({ transport: 'unknown' }), (err) => err.message.includes(name) && err.message.includes('unknown'))
    assert.throws(() => adapter({}), (err) => err.message.includes(name) && err.message.includes('undefined'))
  }
})

test('transportFor selects headless-json only for explicitly named roles', () => {
  assert.equal(transportFor('builder', { headless: 'builder' }), 'headless-json')
  assert.equal(transportFor('lead', { headless: 'builder' }), 'pane')
  assert.equal(transportFor('builder', {}), 'pane')
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

test('resolveAdapters boots headless claude and refuses the unshipped pi pair', async () => {
  const r = await resolveAdapters(['builder'], { headless: 'builder' })
  assert.equal(r.builder.transport, 'headless-json')
  await assert.rejects(() => resolveAdapters(['builder'], { headless: 'builder', 'agent-builder': 'pi' }), /adapter-pi.*headless-json/)
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
  assert.deepEqual(r.seats.builder, { agent: 'pi', effort: 'high', provider: 'openai', id: 'gpt-5.6-luna', model: null })
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
  assert.equal(out.b.model, 'already-set')
  assert.equal(out.c.model, 'bare-fallback')
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
    checks: [{ total: 3, failed: 3, errored: 0 }], violations: [],
  })
  assert.equal(calls.events.filter((event) => event.type === 'log').length, 2)
  assert.ok(calls.events.some((event) => event.type === 'log' && event.payload.level === 'warn'))
})

const floorMajor = Number.parseInt(NODE_FLOOR, 10)
const nodeMeetsLedgerFloor = Number.parseInt(process.versions.node, 10) >= floorMajor

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
