import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composeLayout, SEAT_DEFAULTS, DEFAULT_ROLES, assertCapabilities, resolveAdapters, docOpenArgs } from './crew.mjs'
import { seatCommand, capabilities } from './adapters/adapter-claude.mjs'
import { seatCommand as piSeatCommand, capabilities as piCapabilities } from './adapters/adapter-pi.mjs'

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
  assert.deepEqual({ ...piCapabilities }, { prompt_file: true, tool_deny: true, unattended: true, session_resume: true })
})

// A crew seat is a persistent pane: --print exits after the boot brief and --no-session drops the session, so their absence is load-bearing.
test('adapter-pi.seatCommand carries every crew-supplied field and neither interactive-killing flag', () => {
  const cmd = piSeatCommand(PI_SAMPLE)
  assert.match(cmd, /DEVTEAM_WORKER=1/)
  assert.match(cmd, /CREW_ROLE=builder/)
  assert.match(cmd, /CREW_TASK_DIR="\/tmp\/crew-task"/)
  assert.match(cmd, /--exclude-tools "Task,Agent"/)
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
