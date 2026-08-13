import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  composeLayout, SEAT_DEFAULTS, DEFAULT_ROLES, ROLE_ORDER, assertCapabilities, resolveAdapters, docOpenArgs,
  resolveTier, resolveSeatModels, seatReadySignal, assertSeats,
} from './crew.mjs'
import { seatCommand, capabilities, modelString as claudeModelString } from './adapters/adapter-claude.mjs'
import { seatCommand as piSeatCommand, capabilities as piCapabilities, modelString as piModelString, translateDeny } from './adapters/adapter-pi.mjs'

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

test('every seat declares an agent; the claude adapter declares full, frozen capabilities', () => {
  for (const [role, seat] of Object.entries(SEAT_DEFAULTS)) assert.equal(seat.agent, 'claude', `${role} has no agent`)
  assert.ok(Object.isFrozen(capabilities))
  assert.equal(capabilities.tool_deny, true)
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

const PI_SAMPLE = {
  role: 'builder', model: 'google/gemini-3-pro', promptFile: '/tmp/crew-task/role-builder.md',
  tools: 'Read,Edit,Write,Glob,Grep,Bash', deny: 'Task,Agent', taskDir: '/tmp/crew-task',
  bootBrief: 'Crew for task demo. Task dir /tmp/crew-task. Read your role in the system prompt, reply exactly ready: your-role, then wait.',
}

// assertCapabilities gates seat boot on these exact keys — a lie here silently unlocks seats the adapter cannot actually enforce.
test('the pi adapter declares honest, frozen capabilities', () => {
  assert.ok(Object.isFrozen(piCapabilities))
  assert.deepEqual({ ...piCapabilities }, { prompt_file: true, tool_deny: true, unattended: true, session_resume: true, effort: true })
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
