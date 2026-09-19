import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mcpConfigDocument, SEAT_DEFAULTS, FANOUT_TOOLS, DEFAULT_ROLES, ROLE_ORDER, transportFor, seatTransport, HEADLESS_TRANSPORTS, assertCapabilities, resolveAdapters, bootAllocation, resolveTier, resolveSeatModels, loadLadder, shadowPickBoot, bootCmd, CAPABILITY_REFUSALS, loadCapabilities, EMPTY_GRANTS } from './crew.mjs'
import { seatCommand, headlessCommand as claudeHeadlessCommand, capabilitiesFor, modelString as claudeModelString, mcpConfigPath, paneUsageRecords, skillsPluginDir, skillDirName, seatSkillFiles, writeSeatSkills, assertSkillsMaterialised } from './adapters/adapter-claude.mjs'
import { capabilitiesFor as piCapabilitiesFor, translateDeny } from './adapters/adapter-pi.mjs'
import { testCheckout } from '../test/fixtures.mjs'
import { ROOT, scratchDir } from '../test/helpers.mjs'
import { shippedRoster, roster, withHome, testCrewDir, capabilityRegister, capabilityFixtureRoot } from './crew-test-helpers.mjs'

// Keep lexical import reach visible before byte-pinned regex test bodies.
void [test, assert, readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, tmpdir, join, dirname, fileURLToPath, mcpConfigDocument, SEAT_DEFAULTS, FANOUT_TOOLS, DEFAULT_ROLES, ROLE_ORDER, transportFor, seatTransport, HEADLESS_TRANSPORTS, assertCapabilities, resolveAdapters, bootAllocation, resolveTier, resolveSeatModels, loadLadder, shadowPickBoot, bootCmd, CAPABILITY_REFUSALS, loadCapabilities, EMPTY_GRANTS, seatCommand, claudeHeadlessCommand, capabilitiesFor, claudeModelString, mcpConfigPath, paneUsageRecords, skillsPluginDir, skillDirName, seatSkillFiles, writeSeatSkills, assertSkillsMaterialised, piCapabilitiesFor, translateDeny, testCheckout, ROOT, scratchDir, shippedRoster, roster, withHome, testCrewDir, capabilityRegister, capabilityFixtureRoot]

const CLAUDE_USAGE_SETTINGS = fileURLToPath(new URL('./adapters/claude-usage.settings.json', import.meta.url))
// Hoisted: tests both above and below this point branch on it. Below the
// ledger's Node floor the emitter degrades to JSONL and writes no database,
// so a real-row assertion there would assert the absence of a feature.

const admissionSeat = ({ agent = 'claude', provider = 'anthropic', id = 'claude-opus-5', fallback } = {}) => ({
  agent, provider, id, effort: 'medium', model: null, ...(fallback ? { fallback } : {}),
})


const admissionRegistry = ({ local = false, claudeProviders = null, piProviders = null, roles = {} } = {}) => {
  const base = capabilityRegister()
  const local_providers = local
    ? { 'local-pi': { settings: 'crew/pi/settings.json', pi_provider: 'local-pi', base_url: 'http://127.0.0.1:11434/v1' } }
    : {}
  const coding_agents = {
    ...base.coding_agents,
    pi: { ...base.coding_agents.pi, ...(piProviders ? { providers: piProviders } : {}) },
    claude: { ...base.coding_agents.claude, ...(claudeProviders ? { providers: claudeProviders } : {}) },
  }
  return capabilityRegister({ local_providers, coding_agents, roles })
}


function assertAdapterPathMismatch(agent, adapter) {
  const base = capabilityRegister()
  const register = capabilityRegister({ coding_agents: {
    [agent]: { ...base.coding_agents[agent], adapter },
  } })
  assert.throws(
    () => loadCapabilities({ register }),
    (err) => err.reason === 'register-invalid'
      && err.message.includes(`coding_agents.${agent}.adapter`),
  )
}


function shadowAdmission({ candidate, registry = loadCapabilities(), transport = 'pane', ladder = loadLadder(), root = ROOT } = {}) {
  const rosterFor = { schema_version: 1, tiers: { build: { builder: candidate } } }
  const seen = []
  return {
    roster: rosterFor,
    seats: rosterFor.tiers.build,
    sources: { builder: { model: 'roster' } },
    adapters: { builder: { transport } },
    registry, ladder, root, seen,
    existsSync: (path) => { seen.push(path); return existsSync(path) },
  }
}


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

test('adapter-claude.seatCommand pins the pane command with the per-seat usage settings path', () => {
  const SAMPLE = {
    role: 'builder', model: 'sonnet', promptFile: '/tmp/crew-task/role-builder.md',
    tools: 'Read,Edit,Write,Glob,Grep,Bash', deny: 'Task,Agent', taskDir: '/tmp/crew-task',
    bootBrief: 'Crew for task demo. Task dir /tmp/crew-task. Read your role in the system prompt, reply exactly ready: your-role, then wait.',
  }
  // Captured from main BEFORE the adapter refactor — do not regenerate this
  // from the new code; it is the compatibility bar, now including the
  // independently derived per-seat usage settings path.
  const EXPECTED = `env DEVTEAM_WORKER=1 CREW_ROLE=builder CREW_TASK_DIR="/tmp/crew-task" CREW_FFF=0 CREW_FFF_NODE="" CREW_FFF_HOOK="" claude --model sonnet --permission-mode bypassPermissions --strict-mcp-config --mcp-config "/tmp/crew-task/mcp/builder.json" --settings "${CLAUDE_USAGE_SETTINGS}" --allowedTools "Read,Edit,Write,Glob,Grep,Bash" --disallowedTools "Task,Agent,mcp__*" --append-system-prompt-file "/tmp/crew-task/role-builder.md" "Crew for task demo. Task dir /tmp/crew-task. Read your role in the system prompt, reply exactly ready: your-role, then wait."`
  assert.equal(seatCommand(SAMPLE), EXPECTED)
})

test('claude pane usage settings and reader stay pinned to the same side-channel path', () => {
  const settings = JSON.parse(readFileSync(CLAUDE_USAGE_SETTINGS, 'utf8'))
  assert.ok(settings.hooks && Array.isArray(settings.hooks.SessionStart))
  assert.ok(settings.hooks && Array.isArray(settings.hooks.Stop))
  const commandFor = (event) => settings.hooks[event][0]?.hooks?.[0]?.command || ''
  for (const event of ['SessionStart', 'Stop']) {
    assert.match(commandFor(event), /\$CREW_TASK_DIR\/usage\/\$CREW_ROLE\.jsonl/)
  }
  const taskDir = mkdtempSync(join(tmpdir(), 'claude-pane-usage-'))
  try {
    const usageDir = join(taskDir, 'usage')
    mkdirSync(usageDir, { recursive: true })
    const first = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    writeFileSync(join(usageDir, 'planner.jsonl'), [
      JSON.stringify({ session_id: first, transcript_path: '/tmp/first.jsonl', hook_event_name: 'SessionStart' }),
      '',
      '{truncated',
      JSON.stringify({ session_id: 'd1', transcript_path: '/tmp/bad.jsonl' }),
      JSON.stringify({ session_id: second, transcript_path: 'relative.jsonl' }),
      JSON.stringify({ session_id: second, transcript_path: '/tmp/second.jsonl' }),
      JSON.stringify({ session_id: first, transcript_path: '/tmp/first-again.jsonl' }),
    ].join('\n'))
    assert.deepEqual(paneUsageRecords({ taskDir, role: 'planner' }), [
      { session_id: first, transcript_path: '/tmp/first.jsonl' },
      { session_id: second, transcript_path: '/tmp/second.jsonl' },
    ])
    assert.deepEqual(paneUsageRecords({ taskDir, role: 'missing' }), [])
  } finally {
    rmSync(taskDir, { recursive: true, force: true })
  }
})

test('A1', () => {
  const taskDir = scratchDir('crew-mcp-a1-')
  const config = mcpConfigPath({ taskDir, role: 'builder' })
  const grants = EMPTY_GRANTS
  const headless = claudeHeadlessCommand({
    role: 'builder', model: 'sonnet', promptFile: '/tmp/role-builder.md', tools: 'Read', deny: 'Task,Agent',
    taskDir, prompt: 'go', sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', bin: '/usr/local/bin/claude', grants,
  })
  const pane = seatCommand({
    role: 'builder', model: 'sonnet', promptFile: '/tmp/role-builder.md', tools: 'Read', deny: 'Task,Agent',
    taskDir, bootBrief: 'boot', grants,
  })
  assert.equal(headless.args.filter((arg) => arg === '--strict-mcp-config').length, 1)
  assert.equal(headless.args[headless.args.indexOf('--mcp-config') + 1], config)
  assert.equal((pane.match(/--strict-mcp-config/g) || []).length, 1)
  assert.equal(pane.includes(`--mcp-config "${config}"`), true)
  assert.deepEqual(mcpConfigDocument(grants), { mcpServers: {} })
})

test('B1', () => {
  const command = { name: 'search', command: { bin: '/opt/mcp-search', args: ['--stdio'] }, url: null }
  const http = { name: 'remote', command: null, url: 'https://mcp.example.test/api' }
  assert.deepEqual(mcpConfigDocument({ mcp_servers: [command, http] }), {
    mcpServers: {
      search: { command: '/opt/mcp-search', args: ['--stdio'] },
      remote: { type: 'http', url: 'https://mcp.example.test/api' },
    },
  })
})

test('C1', () => {
  const taskDir = scratchDir('crew-mcp-c1-')
  const base = {
    role: 'builder', model: 'sonnet', promptFile: '/tmp/role-builder.md', tools: 'Read', deny: 'Task,Agent,Task',
    taskDir, bootBrief: 'boot', prompt: 'go', sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', bin: '/usr/local/bin/claude',
  }
  const emptyPane = seatCommand({ ...base })
  const emptyHeadless = claudeHeadlessCommand({ ...base, grants: EMPTY_GRANTS })
  assert.match(emptyPane, /--disallowedTools "Task,Agent,mcp__\*"/)
  assert.equal((emptyPane.match(/mcp__\*/g) || []).length, 1)
  assert.deepEqual(emptyHeadless.args.slice(emptyHeadless.args.indexOf('--disallowedTools'), emptyHeadless.args.indexOf('--append-system-prompt-file')), ['--disallowedTools', 'Task,Agent,mcp__*'])

  const granted = { mcp_servers: [{ name: 'search', command: { bin: '/opt/mcp-search', args: [] }, url: null }] }
  const grantedPane = seatCommand({ ...base, grants: granted })
  const grantedHeadless = claudeHeadlessCommand({ ...base, grants: granted })
  assert.doesNotMatch(grantedPane, /mcp__\*/)
  assert.doesNotMatch(grantedHeadless.args.join(' '), /mcp__\*/)
})

test('E1', async () => {
  const home = scratchDir('crew-mcp-e1-home-')
  const { root: checkoutRoot, checkout } = testCheckout('crew-mcp-e1-checkout-')
  const task = 'mcp-pi-refusal'
  const server = { name: 'search', command: { bin: '/opt/mcp-search', args: [] }, url: null }
  const base = capabilityRegister()
  const register = capabilityRegister({ roles: {
    builder: { ...base.roles.builder, mcp_servers: [server] },
  } })
  let workspaceCalls = 0
  try {
    await withHome(home, () => assert.rejects(
      () => bootCmd(
        { task, checkout, roles: 'builder', 'agent-builder': 'pi', 'headless-all': true, 'claude-bin': process.execPath },
        { register, cmux: () => { workspaceCalls += 1 } },
      ),
      (err) => err.reason === 'grant-unsupported' && /builder/.test(err.message) && /pi/.test(err.message),
    ))
    assert.equal(workspaceCalls, 0)
    assert.equal(existsSync(join(testCrewDir(home, checkout, task), 'crew.json')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('every shipped capability profile is exact, complete, and frozen', async () => {
  for (const [role, seat] of Object.entries(SEAT_DEFAULTS)) assert.equal(seat.agent, 'claude', `${role} has no agent`)
  const claudeMod = await import('./adapters/adapter-claude.mjs')
  const piMod = await import('./adapters/adapter-pi.mjs')
  assert.equal(claudeMod.capabilities, undefined)
  assert.equal(piMod.capabilities, undefined)

  const claudePane = capabilitiesFor({ transport: 'pane' })
  // #131: drive.mjs bounce paths reassign a settled pane seat.
  assert.deepEqual({ ...claudePane }, { prompt_file: true, tool_deny: true, unattended: true, subagents: true, effort: true, local_provider: false, mcp_servers: true, interjection: 'none', abort: 'none', session_resume: false, durable_cursor: 'none', reassign: true })
  assert.ok(Object.isFrozen(claudePane))
  const claudeHeadless = capabilitiesFor({ transport: 'headless-json' })
  assert.deepEqual({ ...claudeHeadless }, { prompt_file: true, tool_deny: true, unattended: true, subagents: true, effort: true, local_provider: false, mcp_servers: true, interjection: 'turn', abort: 'signal', session_resume: true, durable_cursor: 'none', reassign: false })
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

test('resolveAdapters rejects an unknown --agent-<role>; role-wide skills on claude resolve while extensions still refuse', async () => {
  await assert.rejects(
    () => resolveAdapters(['builder'], { 'agent-builder': 'nope' }, null, { register: capabilityRegister() }),
    (error) => error.reason === 'agent-unresolved'
      && /seat builder/.test(error.message)
      && /coding_agents\.nope/.test(error.message),
  )
  // The shipped register grants lean-build under pi overlays; claude seats hold
  // no skill grant under it, so both claude authoring seats resolve without one.
  const shipped = JSON.parse(readFileSync(new URL('./capabilities.json', import.meta.url), 'utf8'))
  const withoutPiSkills = JSON.parse(JSON.stringify(shipped))
  for (const role of ['planner', 'builder']) delete withoutPiSkills.roles[role].by_agent.pi.skills
  const claudeArgs = { 'agent-builder': 'claude', 'agent-reviewer': 'claude' }
  const before = await resolveAdapters(['builder', 'reviewer'], claudeArgs, null, { register: shipped })
  const after = await resolveAdapters(['builder', 'reviewer'], claudeArgs, null, { register: withoutPiSkills })
  for (const role of ['builder', 'reviewer']) {
    const seat = {
      role, model: 'sonnet', promptFile: `/tmp/crew-task/role-${role}.md`,
      tools: SEAT_DEFAULTS[role].tools, deny: SEAT_DEFAULTS[role].deny,
      taskDir: '/tmp/crew-task', bootBrief: 'boot',
    }
    assert.equal(
      seatCommand({ ...seat, grants: before[role].grants }),
      seatCommand({ ...seat, grants: after[role].grants }),
    )
  }
  // A register that grants skills role-wide now resolves on claude and delivers
  // via the seat plugin dir; role-wide extensions still refuse.
  const roleWide = JSON.parse(readFileSync(new URL('./capabilities.json', import.meta.url), 'utf8'))
  roleWide.roles.builder.skills = ['skills/lean-build/SKILL.md']
  const resolved = await resolveAdapters(['builder'], {}, null, { register: roleWide })
  assert.equal(resolved.builder.grants.skills.length, 1)
  const roleWideDir = scratchDir('b860-role-wide-skills-')
  try {
    writeSeatSkills({ taskDir: roleWideDir, role: 'builder', grants: resolved.builder.grants })
    assert.equal(
      readFileSync(join(roleWideDir, 'claude-skills', 'builder', 'skills', 'lean-build', 'SKILL.md'), 'utf8'),
      readFileSync(join(ROOT, 'skills/lean-build/SKILL.md'), 'utf8'),
    )
    assert.match(seatCommand({
      role: 'builder', model: 'sonnet', promptFile: `/tmp/crew-task/role-builder.md`,
      tools: SEAT_DEFAULTS.builder.tools, deny: SEAT_DEFAULTS.builder.deny,
      taskDir: roleWideDir, bootBrief: 'boot', grants: resolved.builder.grants,
    }), /--plugin-dir/)
  } finally {
    rmSync(roleWideDir, { recursive: true, force: true })
  }
  const extWide = JSON.parse(readFileSync(new URL('./capabilities.json', import.meta.url), 'utf8'))
  extWide.roles.builder.extensions = ['crew/pi/extensions/builderloop.ts']
  await assert.rejects(
    () => resolveAdapters(['builder'], {}, null, { register: extWide }),
    (error) => error.reason === 'grant-unsupported'
      && error.message.includes('builder')
      && error.message.includes('extensions'),
  )
})

test('a claude seat with a skill grant resolves, materialises, and composes --plugin-dir on pane and headless argv', async () => {
  const shipped = JSON.parse(readFileSync(new URL('./capabilities.json', import.meta.url), 'utf8'))
  const register = JSON.parse(JSON.stringify(shipped))
  register.roles.builder.by_agent = {
    ...(register.roles.builder.by_agent || {}),
    claude: { skills: ['skills/lean-build/SKILL.md'] },
  }
  const resolved = await resolveAdapters(['builder'], { 'agent-builder': 'claude' }, null, { register })
  const grants = resolved.builder.grants
  assert.equal(grants.skills.length, 1)
  assert.equal(grants.skills[0].endsWith('skills/lean-build/SKILL.md'), true)
  const taskDir = scratchDir('b860-claude-skill-delivery-')
  try {
    const seat = {
      role: 'builder', model: 'sonnet', promptFile: join(taskDir, 'role-builder.md'),
      tools: '', deny: '', taskDir, bootBrief: 'boot', grants,
    }
    const headlessSeat = {
      ...seat, prompt: 'hi', sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', bin: '/bin/claude',
    }
    assert.throws(() => seatCommand(seat), (err) => err.reason === 'grant-unsupported')
    assert.throws(() => claudeHeadlessCommand(headlessSeat), (err) => err.reason === 'grant-unsupported')
    writeSeatSkills({ taskDir, role: 'builder', grants })
    const dir = skillsPluginDir({ taskDir, role: 'builder' })
    assert.deepEqual(seatSkillFiles({ taskDir, role: 'builder', grants }), [join(dir, 'skills', 'lean-build', 'SKILL.md')])
    assert.equal(skillDirName(grants.skills[0]), 'lean-build')
    assert.equal(
      readFileSync(join(dir, 'skills', 'lean-build', 'SKILL.md'), 'utf8'),
      readFileSync(join(ROOT, 'skills/lean-build/SKILL.md'), 'utf8'),
    )
    assert.doesNotThrow(() => assertSkillsMaterialised({ taskDir, role: 'builder', grants }))
    assert.equal(seatCommand(seat).includes(`--plugin-dir "${dir}"`), true)
    const head = claudeHeadlessCommand(headlessSeat)
    assert.equal(head.args.includes('--plugin-dir'), true)
    assert.equal(head.args.includes(dir), true)
  } finally {
    rmSync(taskDir, { recursive: true, force: true })
  }
})

test('bootCmd materialises the claude skills dir for a claude skill grant', async () => {
  const home = scratchDir('b860-claude-skills-boot-home-')
  const { root: checkoutRoot, checkout } = testCheckout('b860-claude-skills-boot-checkout-')
  const task = 'b860-claude-skills-boot'
  const shipped = JSON.parse(readFileSync(new URL('./capabilities.json', import.meta.url), 'utf8'))
  const register = JSON.parse(JSON.stringify(shipped))
  register.roles.builder.by_agent = {
    ...(register.roles.builder.by_agent || {}),
    claude: { skills: ['skills/lean-build/SKILL.md'] },
  }
  let workspaceCalls = 0
  try {
    await withHome(home, () => bootCmd(
      { task, checkout, roles: 'builder', 'agent-builder': 'claude', 'headless-all': true, 'claude-bin': process.execPath },
      { register, cmux: () => { workspaceCalls += 1; return {} }, awaitSeatsReady: async () => {} },
    ))
    assert.equal(workspaceCalls, 0)
    assert.equal(
      readFileSync(join(testCrewDir(home, checkout, task), 'task', 'claude-skills', 'builder', 'skills', 'lean-build', 'SKILL.md'), 'utf8'),
      readFileSync(join(ROOT, 'skills/lean-build/SKILL.md'), 'utf8'),
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('mixed-agent boot keeps the pi planner skill grant while materialising the claude builder plugin root', async () => {
  const home = scratchDir('b860-mixed-skills-boot-home-')
  const { root: checkoutRoot, checkout } = testCheckout('b860-mixed-skills-boot-checkout-')
  const task = 'b860-mixed-skills-boot'
  const shipped = JSON.parse(readFileSync(new URL('./capabilities.json', import.meta.url), 'utf8'))
  const register = JSON.parse(JSON.stringify(shipped))
  register.roles.builder.by_agent = {
    ...(register.roles.builder.by_agent || {}),
    claude: { skills: ['skills/lean-build/SKILL.md'] },
  }
  const args = { 'agent-planner': 'pi', 'agent-builder': 'claude' }
  const resolved = await resolveAdapters(['planner', 'builder'], args, null, { register })
  assert.equal(resolved.planner.grants.skills.length, 1)
  assert.equal(resolved.planner.grants.skills[0].endsWith('skills/lean-build/SKILL.md'), true)
  assert.equal(resolved.builder.grants.skills.length, 1)
  assert.equal(resolved.builder.grants.skills[0].endsWith('skills/lean-build/SKILL.md'), true)
  let workspaceCalls = 0
  try {
    await withHome(home, () => bootCmd(
      { task, checkout, roles: 'planner,builder', ...args, 'headless-all': true, 'claude-bin': process.execPath },
      { register, cmux: () => { workspaceCalls += 1; return {} }, awaitSeatsReady: async () => {} },
    ))
    assert.equal(workspaceCalls, 0)
    assert.equal(
      readFileSync(join(testCrewDir(home, checkout, task), 'task', 'claude-skills', 'builder', 'skills', 'lean-build', 'SKILL.md'), 'utf8'),
      readFileSync(join(ROOT, 'skills/lean-build/SKILL.md'), 'utf8'),
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('writeSeatSkills replaces the role plugin root from scratch on rewrite', () => {
  const taskDir = scratchDir('b860-claude-skills-reboot-')
  try {
    const fixture = scratchDir('b860-claude-skills-reboot-src-')
    try {
      for (const name of ['alpha', 'beta']) {
        mkdirSync(join(fixture, name), { recursive: true })
        writeFileSync(join(fixture, name, 'SKILL.md'), `# ${name}\n`)
      }
      const both = { skills: [join(fixture, 'alpha', 'SKILL.md'), join(fixture, 'beta', 'SKILL.md')] }
      writeSeatSkills({ taskDir, role: 'builder', grants: both })
      assert.equal(readFileSync(join(taskDir, 'claude-skills', 'builder', 'skills', 'alpha', 'SKILL.md'), 'utf8'), '# alpha\n')
      assert.equal(readFileSync(join(taskDir, 'claude-skills', 'builder', 'skills', 'beta', 'SKILL.md'), 'utf8'), '# beta\n')
      writeSeatSkills({ taskDir, role: 'builder', grants: { skills: [join(fixture, 'alpha', 'SKILL.md')] } })
      assert.equal(readFileSync(join(taskDir, 'claude-skills', 'builder', 'skills', 'alpha', 'SKILL.md'), 'utf8'), '# alpha\n')
      assert.equal(existsSync(join(taskDir, 'claude-skills', 'builder', 'skills', 'beta')), false)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  } finally {
    rmSync(taskDir, { recursive: true, force: true })
  }
})

test('writeSeatSkills refuses colliding skill names without writing', () => {
  const taskDir = scratchDir('b860-claude-skills-collision-')
  try {
    const fixture = scratchDir('b860-claude-skills-collision-src-')
    try {
      for (const side of ['left', 'right']) {
        mkdirSync(join(fixture, side, 'dup'), { recursive: true })
        writeFileSync(join(fixture, side, 'dup', 'SKILL.md'), `# ${side}\n`)
      }
      const grants = { skills: [join(fixture, 'left', 'dup', 'SKILL.md'), join(fixture, 'right', 'dup', 'SKILL.md')] }
      assert.throws(
        () => writeSeatSkills({ taskDir, role: 'builder', grants }),
        (err) => err.reason === 'grant-unsupported' && /duplicate skill name/.test(err.message),
      )
      assert.equal(existsSync(skillsPluginDir({ taskDir, role: 'builder' })), false)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  } finally {
    rmSync(taskDir, { recursive: true, force: true })
  }
})

test('resolveAdapters refuses a recorded proposal stub before checking its adapter path', async () => {
  const base = capabilityRegister()
  const register = capabilityRegister({ coding_agents: {
    stub: {
      ...base.coding_agents.pi,
      adapter: 'crew/adapters/adapter-stub.mjs',
      display_name: 'Stub',
      binary: 'stub',
      install_hint: 'Install Stub.',
      availability: 'proposal-stub',
      availability_reason: 'proposal-stub',
    },
  } })
  let existsCalls = 0
  await assert.rejects(
    () => resolveAdapters(['lead'], { 'agent-lead': 'stub' }, null, {
      register,
      exists: () => { existsCalls += 1; return false },
    }),
    (err) => err.reason === 'agent-unavailable'
      && err.state === 'proposal-stub'
      && err.availability_reason === 'proposal-stub'
      && /seat lead/.test(err.message)
      && /stub/.test(err.message)
      && /state proposal-stub/.test(err.message)
      && /reason proposal-stub/.test(err.message),
  )
  assert.equal(existsCalls, 0)
})

test('bootCmd refuses an unavailable selected roster cell before workspace creation', async () => {
  const home = scratchDir('crew-roster-admission-home-')
  const { root: checkoutRoot, checkout } = testCheckout('crew-roster-admission-checkout-')
  const task = 'crew-roster-admission'
  const rawRoster = JSON.parse(readFileSync(new URL('./roster.json', import.meta.url), 'utf8'))
  const base = capabilityRegister()
  const register = capabilityRegister({ coding_agents: {
    pi: { ...base.coding_agents.pi, availability: 'discovered-unavailable', availability_reason: 'discovered-unavailable' },
  } })
  let workspaceCalls = 0
  try {
    await withHome(home, () => assert.rejects(
      () => bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        {
          register,
          readRosterFile: () => JSON.stringify(rawRoster),
          cmux: () => { workspaceCalls += 1 },
        },
      ),
      (err) => err.reason === 'agent-unavailable'
        && err.state === 'discovered-unavailable'
        && err.availability_reason === 'discovered-unavailable'
        && /roster cell tiers\.build\.planner/.test(err.message)
        && /pi/.test(err.message),
    ))
    assert.equal(workspaceCalls, 0)
    assert.equal(existsSync(join(testCrewDir(home, checkout, task), 'crew.json')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('RV1-2 bootCmd admits selected cells despite unavailable unselected roster cells', async () => {
  const home = scratchDir('crew-selected-roster-admission-home-')
  const { root: checkoutRoot, checkout } = testCheckout('crew-selected-roster-admission-checkout-')
  const task = 'crew-selected-roster-admission'
  const rawRoster = JSON.parse(readFileSync(new URL('./roster.json', import.meta.url), 'utf8'))
  rawRoster.tiers.build.planner = { ...rawRoster.tiers.build.planner, provider: 'anthropic', id: 'claude-opus-5', agent: 'claude' }
  rawRoster.tiers.build.builder = { ...rawRoster.tiers.build.builder, provider: 'anthropic', id: 'claude-opus-5', agent: 'claude' }
  const base = capabilityRegister()
  const register = capabilityRegister({ coding_agents: {
    pi: { ...base.coding_agents.pi, availability: 'discovered-unavailable', availability_reason: 'discovered-unavailable' },
  } })
  let workspaceCalls = 0
  try {
    await withHome(home, () => assert.doesNotReject(
      () => bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'allow-shortfall-planner': 'subagents', 'claude-bin': process.execPath },
        {
          register,
          readRosterFile: () => JSON.stringify(rawRoster),
          cmux: () => { workspaceCalls += 1 },
          awaitSeatsReady: async () => {},
        },
      ),
    ))
    assert.equal(workspaceCalls, 0)
    const crew = JSON.parse(readFileSync(join(testCrewDir(home, checkout, task), 'crew.json'), 'utf8'))
    assert.equal(Object.keys(crew.members).length, 4)
    for (const member of Object.values(crew.members)) assert.equal(member.agent, 'claude')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
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
  const register = capabilityRegister()
  const r = await resolveAdapters(['builder'], { headless: 'builder' }, null, { register })
  assert.equal(r.builder.transport, 'headless-json')
  await assert.rejects(
    () => resolveAdapters(['builder'], { headless: 'builder', 'agent-builder': 'pi' }, null, { register }),
    (err) => err.reason === 'capability-shortfall'
      && /headless-json/.test(err.message)
      && /coding_agents\.pi\.transports/.test(err.message),
  )
})

test('seat requirements deliver pi scouts, preserve genuine shortfalls, and reject malformed overrides', async () => {
  const resolvedPlanner = await resolveAdapters(['planner'], { 'agent-planner': 'pi' })
  assert.equal(resolvedPlanner.planner.name, 'pi')
  assert.deepEqual(resolvedPlanner.planner.grants.extensions, [
    join(process.cwd(), 'crew/pi/extensions/subagent.ts'),
    join(process.cwd(), 'crew/pi/extensions/lab.ts'),
    join(process.cwd(), 'crew/pi/extensions/readgate.ts'),
  ])
  assert.deepEqual(resolvedPlanner.planner.grants.agents, [{ name: 'scout', def: join(process.cwd(), 'crew/pi/agents/scout.json') }])
  const headlessPlanner = await resolveAdapters(['planner'], { 'agent-planner': 'pi', 'headless-rpc': 'planner' })
  assert.equal(headlessPlanner.planner.transport, 'headless-rpc')
  assert.deepEqual(headlessPlanner.planner.grants.agents, [{ name: 'scout', def: join(process.cwd(), 'crew/pi/agents/scout.json') }])
  assert.equal(headlessPlanner.planner.adapter.capabilitiesFor({ transport: 'headless-rpc', grants: headlessPlanner.planner.grants }).subagents, true)
  // The reviewer is deliberately NOT subject to this: its charter names no
  // fan-out, so the requirement belongs to the CHARTER, not the seat: today's
  // shipped pi reviewers at build/mechanical lack `subagents`, and requiring it
  // would make those two tiers unbootable. Pinned against "symmetry" reintroduction.
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
  const shortfallRoot = capabilityFixtureRoot()
  try {
    await assert.rejects(
      () => resolveAdapters(
        ['planner'],
        { 'agent-planner': 'pi', 'headless-rpc': 'planner', 'allow-shortfall-planner': 'tool_deny' },
        null,
        { register: capabilityRegister(), root: shortfallRoot },
      ),
      (err) => /planner/.test(err.message)
        && /subagents/.test(err.message)
        && /pi/.test(err.message),
    )
  } finally { rmSync(shortfallRoot, { recursive: true, force: true }) }
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
  const roster = shippedRoster()
  for (const tier of ['mechanical', 'build', 'judge']) assert.equal(roster.tiers[tier]?.builder?.agent, 'pi', `${tier} builder must remain pi`)
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
  await assert.rejects(
    () => resolveAdapters(['builder'], { 'headless-rpc': 'builder' }, null, { register: capabilityRegister() }),
    /claude.*headless-rpc/,
  )
})

test('the pane profiles satisfy boot capability checks while missing tool denial is refused', () => {
  assert.doesNotThrow(() => assertCapabilities('builder', 'claude', capabilitiesFor({ transport: 'pane' })))
  assert.doesNotThrow(() => assertCapabilities('builder', 'pi', piCapabilitiesFor({ transport: 'pane' })))
  assert.throws(
    () => assertCapabilities('builder', 'x', { prompt_file: true, unattended: true, effort: true, tool_deny: undefined }),
    (err) => /builder/.test(err.message) && /x/.test(err.message) && /tool_deny/.test(err.message),
  )
})

test('translateDeny covers every SEAT_DEFAULTS deny value, dedupes, and drops unknown names', () => {
  assert.deepEqual(translateDeny('Edit,NotebookEdit,Task,Agent'), ['edit'])
  assert.deepEqual(translateDeny('Edit,NotebookEdit'), ['edit'])
  assert.deepEqual(translateDeny('Task,Agent'), [])
  assert.deepEqual(translateDeny('Edit,Edit,NotebookEdit'), ['edit'])
  assert.deepEqual(translateDeny('Frobnicate'), [])
})

test('ROLE_ORDER is key-identical to SEAT_DEFAULTS — one truth for seating order and layout order', () => {
  assert.deepEqual([...ROLE_ORDER], Object.keys(SEAT_DEFAULTS))
})

test('C1 unsupported primary roster pair refuses before boot state exists', async () => {
  const seen = []
  const probed = []
  const seat = admissionSeat({ agent: 'claude', provider: 'openai', id: 'gpt-5.6-luna' })
  await assert.rejects(
    () => resolveAdapters(['builder'], {}, { builder: seat }, {
      register: capabilityRegister(),
      exists: (path) => { seen.push(path); return existsSync(path) },
      probeEndpoint: async (url) => { probed.push(url); return true },
    }),
    (err) => err.reason === 'agent-provider-unsupported'
      && /seat builder/.test(err.message)
      && /coding_agents\.claude\.providers/.test(err.message),
  )
  assert.deepEqual(seen, [])
  assert.deepEqual(probed, [])
})

test('C1F unsupported fallback roster pair refuses before boot state exists', async () => {
  const seen = []
  const probed = []
  const seat = admissionSeat({
    agent: 'claude', provider: 'anthropic', id: 'claude-opus-5',
    fallback: [{ agent: 'claude', provider: 'openai', id: 'gpt-5.6-luna', effort: 'medium' }],
  })
  await assert.rejects(
    () => resolveAdapters(['builder'], {}, { builder: seat }, {
      register: capabilityRegister(),
      exists: (path) => { seen.push(path); return existsSync(path) },
      probeEndpoint: async (url) => { probed.push(url); return true },
    }),
    (err) => err.reason === 'agent-provider-unsupported'
      && /seat builder/.test(err.message)
      && /coding_agents\.claude\.providers/.test(err.message)
      && /openai/.test(err.message),
  )
  assert.deepEqual(seen, [])
  assert.deepEqual(probed, [])
})

test('C1O raw model override discards its roster fallback admission checks', async () => {
  const seen = []
  const seat = {
    agent: 'claude', provider: 'openai', id: 'ignored-by-override', model: 'raw-claude-model', effort: 'medium',
    fallback: [{ agent: 'claude', provider: 'openai', id: 'gpt-5.6-luna', effort: 'medium' }],
  }
  await assert.doesNotReject(
    () => resolveAdapters(['builder'], {}, { builder: seat }, {
      register: capabilityRegister(),
      exists: (path) => { seen.push(path); return existsSync(path) },
      probeEndpoint: async () => { throw new Error('raw override must not probe a fallback') },
    }),
  )
  assert.equal(seen.some((path) => /adapters\/adapter-claude/.test(path)), true)
})

test('C1R declared grant shortfalls refuse before adapter import; a claude skill grant is admitted', async () => {
  const server = { name: 'search', command: { bin: '/opt/mcp-search', args: [] }, url: null }
  const cases = [
    { label: 'extension', agent: 'claude', grant: { extensions: ['crew/pi/extensions/builderloop.ts'] } },
    { label: 'MCP', agent: 'pi', grant: { by_agent: { pi: { mcp_servers: [server] } } } },
  ]
  for (const { agent, grant } of cases) {
    const root = capabilityFixtureRoot()
    try {
      const base = capabilityRegister()
      const role = { ...base.roles.builder, ...grant }
      const register = capabilityRegister({ roles: { builder: role } })
      const seat = admissionSeat({ agent, provider: agent === 'pi' ? 'openai' : 'anthropic', id: agent === 'pi' ? 'gpt-5.6-luna' : 'claude-opus-5' })
      const seen = []
      await assert.rejects(
        () => resolveAdapters(['builder'], {}, { builder: seat }, {
          register, root,
          exists: (path) => { seen.push(path); return existsSync(path) },
          probeEndpoint: async () => { throw new Error('must not probe') },
        }),
        (err) => err.reason === 'grant-unsupported'
          && /coding_agents\.(claude|pi)\.refuses/.test(err.message),
      )
      assert.equal(seen.some((path) => /adapters\/adapter-/.test(path)), false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
  // The skills arm left the claude refusal: a skill grant resolves, imports the
  // adapter, and delivers through the seat plugin dir once materialised.
  const skillRoot = capabilityFixtureRoot()
  try {
    const base = capabilityRegister()
    const register = capabilityRegister({ roles: { builder: { ...base.roles.builder, skills: ['crew/pi/skills/scout.md'] } },
      coding_agents: { ...base.coding_agents, claude: { ...base.coding_agents.claude, refuses: ['extensions', 'local_provider'] } } })
    const seat = admissionSeat({ agent: 'claude', provider: 'anthropic', id: 'claude-opus-5' })
    const seen = []
    const resolved = await resolveAdapters(['builder'], {}, { builder: seat }, {
      register, root: skillRoot,
      exists: (path) => { seen.push(path); return existsSync(path) },
      probeEndpoint: async () => { throw new Error('must not probe') },
    })
    assert.equal(seen.some((path) => /adapters\/adapter-/.test(path)), true)
    assert.deepEqual(resolved.builder.grants.skills, [join(skillRoot, 'crew/pi/skills/scout.md')])
    const taskDir = scratchDir('b860-c1r-skill-')
    try {
      writeSeatSkills({ taskDir, role: 'builder', grants: resolved.builder.grants })
      assert.equal(readFileSync(join(taskDir, 'claude-skills', 'builder', 'skills', 'scout', 'SKILL.md'), 'utf8'), '# skill\n')
      assert.match(seatCommand({
        role: 'builder', model: 'sonnet', promptFile: '/tmp/role-builder.md',
        tools: SEAT_DEFAULTS.builder.tools, deny: SEAT_DEFAULTS.builder.deny,
        taskDir, bootBrief: 'boot', grants: resolved.builder.grants,
      }), /--plugin-dir/)
    } finally { rmSync(taskDir, { recursive: true, force: true }) }
  } finally { rmSync(skillRoot, { recursive: true, force: true }) }
})

test('C1RLP primary local-provider shortfall refuses before adapter import', async () => {
  const base = admissionRegistry({ local: true, claudeProviders: ['anthropic', 'local-pi'] })
  const seat = admissionSeat({ agent: 'claude', provider: 'local-pi', id: 'qwen3-coder' })
  const seen = []
  const probed = []
  await assert.rejects(
    () => resolveAdapters(['builder'], {}, { builder: seat }, {
      register: base,
      exists: (path) => { seen.push(path); return existsSync(path) },
      probeEndpoint: async (url) => { probed.push(url); return true },
    }),
    (err) => err.reason === 'grant-unsupported'
      && /coding_agents\.claude\.refuses/.test(err.message)
      && /primary cell provider "local-pi"/.test(err.message)
      && !/fallback cell provider "local-pi"/.test(err.message),
  )
  assert.equal(seen.some((path) => /adapters\/adapter-/.test(path)), false)
  assert.deepEqual(probed, [])
})

test('C1RLF fallback local-provider shortfall refuses before adapter import', async () => {
  const register = admissionRegistry({ local: true, claudeProviders: ['anthropic', 'local-pi'] })
  const seat = admissionSeat({
    agent: 'claude', provider: 'anthropic', id: 'claude-opus-5',
    fallback: [{ agent: 'claude', provider: 'local-pi', id: 'qwen3-coder', effort: 'medium' }],
  })
  const seen = []
  const probed = []
  await assert.rejects(
    () => resolveAdapters(['builder'], {}, { builder: seat }, {
      register,
      exists: (path) => { seen.push(path); return existsSync(path) },
      probeEndpoint: async (url) => { probed.push(url); return true },
    }),
    (err) => err.reason === 'grant-unsupported'
      && /coding_agents\.claude\.refuses/.test(err.message)
      && /fallback cell provider "local-pi"/.test(err.message)
      && !/primary cell provider "local-pi"/.test(err.message),
  )
  assert.equal(seen.some((path) => /adapters\/adapter-/.test(path)), false)
  assert.deepEqual(probed, [])
})

test('G1M primary adapter model disagreement refuses', async () => {
  const base = capabilityRegister()
  const register = capabilityRegister({ coding_agents: {
    pi: { ...base.coding_agents.pi, providers: ['openai', 'anthropic', 'llama-swap', 'google'] },
  } })
  const seat = admissionSeat({ agent: 'pi', provider: 'google', id: 'gemini-3-pro' })
  await assert.rejects(
    () => resolveAdapters(['builder'], { 'agent-builder': 'pi' }, { builder: seat }, { register }),
    (err) => err.reason === 'agent-provider-unsupported'
      && /google/.test(err.message) && /coding_agents\.pi\.providers/.test(err.message),
  )
})

test('G1MF fallback adapter model disagreement refuses', async () => {
  const base = capabilityRegister()
  const register = capabilityRegister({ coding_agents: {
    pi: { ...base.coding_agents.pi, providers: ['openai', 'anthropic', 'llama-swap', 'google'] },
  } })
  const seat = admissionSeat({
    agent: 'pi', provider: 'openai', id: 'gpt-5.6-luna',
    fallback: [{ agent: 'pi', provider: 'google', id: 'gemini-3-pro', effort: 'medium' }],
  })
  await assert.rejects(
    () => resolveAdapters(['builder'], { 'agent-builder': 'pi' }, { builder: seat }, { register }),
    (err) => err.reason === 'agent-provider-unsupported'
      && /google/.test(err.message) && /coding_agents\.pi\.providers/.test(err.message),
  )
})

test('G1A adapter path disagreement refuses', () => {
  assertAdapterPathMismatch('pi', 'crew/adapters/adapter-claude.mjs')
})

test('RV1-1 loader rejects coding-agent adapter key/path drift', () => {
  assertAdapterPathMismatch('claude', 'crew/adapters/adapter-pi.mjs')
})

test('G1T adapter transport disagreement refuses', async () => {
  const base = capabilityRegister()
  const register = capabilityRegister({ coding_agents: {
    pi: { ...base.coding_agents.pi, transports: ['pane'] },
  } })
  const seat = admissionSeat({ agent: 'pi', provider: 'openai', id: 'gpt-5.6-luna' })
  await assert.rejects(
    () => resolveAdapters(['builder'], { 'agent-builder': 'pi', 'headless-rpc': 'builder' }, { builder: seat }, { register }),
    (err) => err.reason === 'capability-shortfall' && /coding_agents\.pi\.transports/.test(err.message),
  )
})

test('G1TR inverse transport drift is a closed register-invalid refusal', async () => {
  const base = capabilityRegister()
  const register = capabilityRegister({ coding_agents: {
    claude: { ...base.coding_agents.claude, transports: ['pane', 'headless-json', 'headless-rpc'] },
  } })
  const seat = admissionSeat({ agent: 'claude', provider: 'anthropic', id: 'claude-opus-5' })
  await assert.rejects(
    () => resolveAdapters(['builder'], { 'headless-rpc': 'builder' }, { builder: seat }, { register }),
    (err) => err.reason === 'register-invalid'
      && /adapter refusal/.test(err.message)
      && /coding_agents\.claude\.transports/.test(err.message)
      && /headless-rpc/.test(err.message),
  )
})

test('RV1-1/RV1-2 shadow fit admits a shipped roster candidate through post-import checks', async () => {
  const candidate = { provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'max' }
  const input = shadowAdmission({ candidate })
  const record = await shadowPickBoot({ ...input, dbPath: join(tmpdir(), 'shadow-rv1-admit-no-ledger.db') })
  assert.equal(record.seats.builder.candidates[0].excluded_by, null)
})

test('H1A shadow missing agent exclusion names the register entry', async () => {
  const candidate = { provider: 'openai', id: 'gpt-5.6-luna', agent: 'missing-shadow-agent', effort: 'max' }
  const input = shadowAdmission({ candidate })
  const record = await shadowPickBoot({ ...input, dbPath: join(tmpdir(), 'shadow-h1a-no-ledger.db') })
  const result = record.seats.builder.candidates[0]
  assert.equal(result.excluded_by.reason, 'agent-unresolved')
  assert.match(result.excluded_by.detail, /coding_agents\.missing-shadow-agent/)
  assert.equal(input.seen.some((path) => /adapters\/adapter-missing-shadow-agent/.test(path)), false)
})

test('H1P shadow provider exclusion names the register entry', async () => {
  const candidate = { provider: 'openai', id: 'gpt-5.6-luna', agent: 'claude', effort: 'max' }
  const input = shadowAdmission({ candidate })
  const record = await shadowPickBoot({ ...input, dbPath: join(tmpdir(), 'shadow-h1p-no-ledger.db') })
  const result = record.seats.builder.candidates[0]
  assert.equal(result.excluded_by.reason, 'capability-shortfall')
  assert.match(result.excluded_by.detail, /coding_agents\.claude\.providers/)
  assert.equal(input.seen.some((path) => /adapters\/adapter-claude/.test(path)), false)
})

test('H1T shadow transport exclusion names the register entry', async () => {
  const candidate = { provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'max' }
  const input = shadowAdmission({ candidate, transport: 'headless-json' })
  const record = await shadowPickBoot({ ...input, dbPath: join(tmpdir(), 'shadow-h1t-no-ledger.db') })
  const result = record.seats.builder.candidates[0]
  assert.equal(result.excluded_by.reason, 'capability-shortfall')
  assert.match(result.excluded_by.detail, /coding_agents\.pi\.transports/)
  assert.equal(input.seen.some((path) => /adapters\/adapter-pi/.test(path)), false)
})

test('H1RG shadow grant capability refusal names the register entry', async () => {
  const server = { name: 'search', command: { bin: '/opt/mcp-search', args: [] }, url: null }
  const cases = [
    { agent: 'claude', provider: 'anthropic', id: 'claude-opus-5', extension: 'crew/pi/extensions/builderloop.ts' },
    { agent: 'claude', provider: 'anthropic', id: 'claude-opus-5', skill: 'crew/pi/skills/scout.md' },
    { agent: 'pi', provider: 'openai', id: 'gpt-5.6-luna', mcp_servers: [server] },
  ]
  for (const grant of cases) {
    const root = capabilityFixtureRoot()
    try {
      const base = capabilityRegister()
      const register = capabilityRegister({ roles: {
        builder: { ...base.roles.builder, ...(grant.extension ? { extensions: [grant.extension] } : {}), ...(grant.skill ? { skills: [grant.skill] } : {}), ...(grant.mcp_servers ? { mcp_servers: grant.mcp_servers } : {}) },
      } })
      const candidate = { provider: grant.provider, id: grant.id, agent: grant.agent, effort: 'max' }
      const input = shadowAdmission({ candidate, registry: loadCapabilities({ register }), root })
      const record = await shadowPickBoot({ ...input, dbPath: join(tmpdir(), 'shadow-h1rg-no-ledger.db') })
      const result = record.seats.builder.candidates[0]
      assert.equal(result.excluded_by.reason, 'capability-shortfall')
      assert.match(result.excluded_by.detail, /coding_agents\.(claude|pi)\.refuses/)
      assert.equal(input.seen.some((path) => /adapters\/adapter-(claude|pi)/.test(path)), false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('H1RL shadow local-provider refusal names the register entry', async () => {
  const raw = JSON.parse(readFileSync(new URL('./capabilities.json', import.meta.url), 'utf8'))
  raw.coding_agents.claude.providers.push('llama-swap')
  const registry = loadCapabilities({ register: raw })
  const ladder = loadLadder()
  ladder.members = new Map(ladder.members)
  ladder.members.set('llama-swap/qwen3.8-27b', 'utility')
  const candidate = { provider: 'llama-swap', id: 'qwen3.8-27b', agent: 'claude', effort: 'max' }
  const input = shadowAdmission({ candidate, registry, ladder })
  const record = await shadowPickBoot({ ...input, dbPath: join(tmpdir(), 'shadow-h1rl-no-ledger.db') })
  const result = record.seats.builder.candidates[0]
  assert.equal(result.excluded_by.reason, 'capability-shortfall')
  assert.match(result.excluded_by.detail, /coding_agents\.claude\.refuses/)
  assert.equal(input.seen.some((path) => /adapters\/adapter-claude/.test(path)), false)
})

test('a charter requirement unmet by adapter and register refuses to boot from the closed reason set', async () => {
  const root = capabilityFixtureRoot()
  try {
    // "from the closed reason set" — the set itself, matching the honest
    // neighbour a few tests down (crew/crew.test.mjs:4459).
    const CLOSED_REASONS = ['register-invalid', 'capability-shortfall', 'unknown-grant', 'grant-unsupported',
      'extension-missing', 'unknown-skill', 'agent-def-invalid', 'local-settings-missing', 'local-provider-undeclared',
      'local-endpoint-dead', 'grant-contradicts-deny', 'vendor-extension-missing',
      'agent-unresolved', 'agent-provider-unsupported', 'agent-unavailable', 'local-provider-reserved']
    await assert.rejects(
      () => resolveAdapters(['planner'], { 'agent-planner': 'pi' }, null, { register: capabilityRegister(), root }),
      (err) => {
        assert.equal(err.reason, 'capability-shortfall')
        assert.ok(CAPABILITY_REFUSALS.includes(err.reason))
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
    assert.deepEqual([...CAPABILITY_REFUSALS], CLOSED_REASONS)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a register-backed pi fan-out bundle resolves to absolute definitions and reaches the command', async () => {
  const root = capabilityFixtureRoot()
  try {
    const base = capabilityRegister()
    const register = capabilityRegister({ roles: {
      // RV1-1: an agents grant must be backed by the extension that REGISTERS the
      // agent tool. Granting builderloop.ts alone left fan-out silently dead; it now
      // refuses at composition time, so this register grants subagent.ts too.
      planner: { ...base.roles.planner, extensions: ['crew/pi/extensions/builderloop.ts', 'crew/pi/extensions/subagent.ts'], agents: [{ name: 'Explore', def: 'crew/pi/explore.json' }] },
    } })
    const resolved = await resolveAdapters(['planner'], { 'agent-planner': 'pi' }, null, { register, root })
    assert.equal(resolved.planner.name, 'pi')
    assert.equal(resolved.planner.grants.extensions[0], join(root, 'crew/pi/extensions/builderloop.ts'))
    assert.equal(resolved.planner.grants.agents[0].def, join(root, 'crew/pi/explore.json'))
    assert.equal(resolved.planner.grants.agents[0].name, 'Explore')
    assert.equal(resolved.planner.adapter.capabilitiesFor({ transport: 'pane', grants: resolved.planner.grants }).subagents, true)
    const command = resolved.planner.adapter.seatCommand({
      role: 'planner', model: 'openai-codex/gpt-5.6-luna', promptFile: '/tmp/role-planner.md',
      tools: SEAT_DEFAULTS.planner.tools, deny: SEAT_DEFAULTS.planner.deny, taskDir: '/tmp', bootBrief: 'boot', grants: resolved.planner.grants,
    })
    assert.ok(command.includes(`-e "${join(root, 'crew/pi/extensions/builderloop.ts')}"`))
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
    writeFileSync(join(dirname(settings), 'models.json'), JSON.stringify({ providers: { 'local-pi': null } }))
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

test('A1 raw local override resolves its config directory', async () => {
  const root = scratchDir('crew-raw-local-a1-')
  try {
    const settings = join(root, 'crew/pi/settings.json')
    mkdirSync(dirname(settings), { recursive: true })
    writeFileSync(settings, '{}')
    writeFileSync(join(dirname(settings), 'models.json'), JSON.stringify({ providers: { 'local-pi': null } }))
    const register = capabilityRegister({ local_providers: {
      'local-pi': { settings: 'crew/pi/settings.json', pi_provider: 'local-pi', base_url: 'http://127.0.0.1:11434/v1' },
    } })
    const adapters = await resolveAdapters(['builder'], { 'model-builder': 'local-pi/qwen3-coder', 'agent-builder': 'pi' }, null, {
      register, root, probeEndpoint: async () => true,
    })
    assert.equal(adapters.builder.configDir, dirname(settings))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('B1 raw local override passes PI_CODING_AGENT_DIR to its seat command', async () => {
  const root = scratchDir('crew-raw-local-b1-')
  try {
    const settings = join(root, 'crew/pi/settings.json')
    mkdirSync(dirname(settings), { recursive: true })
    writeFileSync(settings, '{}')
    writeFileSync(join(dirname(settings), 'models.json'), JSON.stringify({ providers: { 'local-pi': null } }))
    const register = capabilityRegister({ local_providers: {
      'local-pi': { settings: 'crew/pi/settings.json', pi_provider: 'local-pi', base_url: 'http://127.0.0.1:11434/v1' },
    } })
    const adapters = await resolveAdapters(['builder'], { 'model-builder': 'local-pi/qwen3-coder', 'agent-builder': 'pi' }, null, {
      register, root, probeEndpoint: async () => true,
    })
    const command = adapters.builder.adapter.seatCommand({
      role: 'builder', model: 'local-pi/qwen3-coder', promptFile: '/tmp/role-builder.md',
      tools: SEAT_DEFAULTS.builder.tools, deny: SEAT_DEFAULTS.builder.deny, taskDir: root,
      bootBrief: 'boot', effort: 'max', grants: adapters.builder.grants, configDir: adapters.builder.configDir,
    })
    assert.equal(command.match(/PI_CODING_AGENT_DIR=/g)?.length, 1)
    assert.ok(command.includes(`PI_CODING_AGENT_DIR="${dirname(settings)}"`))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('C1 hosted raw override carries no PI_CODING_AGENT_DIR', async () => {
  const root = scratchDir('crew-raw-hosted-c1-')
  try {
    const probed = []
    const register = capabilityRegister({ local_providers: {
      'local-pi': { settings: 'crew/pi/missing-settings.json', pi_provider: 'local-pi', base_url: 'http://127.0.0.1:11434/v1' },
    } })
    const adapters = await resolveAdapters(['builder'], { 'model-builder': 'openai/gpt-5.6-luna', 'agent-builder': 'pi' }, null, {
      register, root, probeEndpoint: async (url) => { probed.push(url); return true },
    })
    assert.equal(adapters.builder.configDir, null)
    assert.deepEqual(probed, [])
    const command = adapters.builder.adapter.seatCommand({
      role: 'builder', model: 'openai/gpt-5.6-luna', promptFile: '/tmp/role-builder.md',
      tools: SEAT_DEFAULTS.builder.tools, deny: SEAT_DEFAULTS.builder.deny, taskDir: root,
      bootBrief: 'boot', effort: 'max', grants: adapters.builder.grants, configDir: adapters.builder.configDir,
    })
    assert.equal(command.includes('PI_CODING_AGENT_DIR='), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('D1 raw local override enforces the models declaration guard', async () => {
  const root = scratchDir('crew-raw-local-d1-')
  try {
    const settings = join(root, 'crew/pi/settings.json')
    mkdirSync(dirname(settings), { recursive: true })
    writeFileSync(settings, '{}')
    const register = capabilityRegister({ local_providers: {
      'local-pi': { settings: 'crew/pi/settings.json', pi_provider: 'local-pi', base_url: 'http://127.0.0.1:11434/v1' },
    } })
    await assert.rejects(
      () => resolveAdapters(['builder'], { 'model-builder': 'local-pi/qwen3-coder', 'agent-builder': 'pi' }, null, {
        register, root, probeEndpoint: async () => { throw new Error('declaration refusal must precede probe') },
      }),
      (err) => err.reason === 'local-provider-undeclared' && CAPABILITY_REFUSALS.includes(err.reason),
    )
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('E1 raw local override enforces the endpoint probe', async () => {
  const root = scratchDir('crew-raw-local-e1-')
  try {
    const settings = join(root, 'crew/pi/settings.json')
    const baseUrl = 'http://127.0.0.1:11434/v1'
    mkdirSync(dirname(settings), { recursive: true })
    writeFileSync(settings, '{}')
    writeFileSync(join(dirname(settings), 'models.json'), JSON.stringify({ providers: { 'local-pi': null } }))
    const register = capabilityRegister({ local_providers: {
      'local-pi': { settings: 'crew/pi/settings.json', pi_provider: 'local-pi', base_url: baseUrl },
    } })
    const probed = []
    await assert.rejects(
      () => resolveAdapters(['builder'], { 'model-builder': 'local-pi/qwen3-coder', 'agent-builder': 'pi' }, null, {
        register, root, probeEndpoint: async (url) => { probed.push(url); return false },
      }),
      (err) => err.reason === 'local-endpoint-dead' && CAPABILITY_REFUSALS.includes(err.reason),
    )
    assert.deepEqual(probed, [baseUrl])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('F1 unknown qualified raw provider refuses by a closed reason', async () => {
  const root = scratchDir('crew-raw-unknown-f1-')
  try {
    const probed = []
    const register = capabilityRegister()
    await assert.rejects(
      () => resolveAdapters(['builder'], { 'model-builder': 'unknown-provider/qwen3-coder', 'agent-builder': 'pi' }, null, {
        register, root, probeEndpoint: async (url) => { probed.push(url); return true },
      }),
      (err) => err.reason === 'agent-provider-unsupported' && CAPABILITY_REFUSALS.includes(err.reason),
    )
    assert.deepEqual(probed, [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('F1b resolved raw local provider unsupported by the agent refuses by a closed reason', async () => {
  const root = scratchDir('crew-raw-resolved-local-f1b-')
  try {
    const settings = join(root, 'crew/pi/settings.json')
    const baseUrl = 'http://127.0.0.1:11434/v1'
    mkdirSync(dirname(settings), { recursive: true })
    writeFileSync(settings, '{}')
    writeFileSync(join(dirname(settings), 'models.json'), JSON.stringify({ providers: { 'llama-swap': null } }))
    const base = capabilityRegister()
    const register = capabilityRegister({
      local_providers: {
        'lan-box': { settings: 'crew/pi/settings.json', pi_provider: 'llama-swap', base_url: baseUrl },
      },
      coding_agents: {
        pi: { ...base.coding_agents.pi, providers: ['openai', 'anthropic'] },
      },
    })
    const probed = []
    await assert.rejects(
      () => resolveAdapters(['builder'], { 'model-builder': 'llama-swap/qwen3-coder', 'agent-builder': 'pi' }, null, {
        register, root, probeEndpoint: async (url) => { probed.push(url); return true },
      }),
      (err) => err.reason === 'agent-provider-unsupported'
        && CAPABILITY_REFUSALS.includes(err.reason)
        && /coding_agents\.pi\.providers/.test(err.message),
    )
    assert.deepEqual(probed, [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('G1 ordinary hosted raw provider remains unchanged', async () => {
  const root = scratchDir('crew-raw-hosted-g1-')
  try {
    const probed = []
    const register = capabilityRegister({ local_providers: {
      'local-pi': { settings: 'crew/pi/missing-settings.json', pi_provider: 'local-pi', base_url: 'http://127.0.0.1:11434/v1' },
    } })
    const adapters = await resolveAdapters(['builder'], { 'model-builder': 'anthropic/claude-opus-5', 'agent-builder': 'pi' }, null, {
      register, root, probeEndpoint: async (url) => { probed.push(url); return true },
    })
    assert.equal(adapters.builder.configDir, null)
    assert.deepEqual(probed, [])
    const command = adapters.builder.adapter.seatCommand({
      role: 'builder', model: 'anthropic/claude-opus-5', promptFile: '/tmp/role-builder.md',
      tools: SEAT_DEFAULTS.builder.tools, deny: SEAT_DEFAULTS.builder.deny, taskDir: root,
      bootBrief: 'boot', effort: 'max', grants: adapters.builder.grants, configDir: adapters.builder.configDir,
    })
    assert.match(command, /--model anthropic\/claude-opus-5/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('A1 raw slash provider resolves across every split point', async () => {
  const root = scratchDir('crew-raw-slash-a1-')
  const raw = 'openrouter/meta/muse-spark-1.3-contributor'
  try {
    const base = capabilityRegister()
    const register = capabilityRegister({ coding_agents: {
      pi: { ...base.coding_agents.pi, providers: ['openai', 'anthropic', 'meta', 'llama-swap'] },
    } })
    const probed = []
    const adapters = await resolveAdapters(['planner'], {
      'model-planner': raw, 'agent-planner': 'pi', 'allow-shortfall-planner': 'subagents',
    }, null, { register, root, probeEndpoint: async (url) => { probed.push(url); return true } })
    assert.equal(adapters.planner.configDir, null)
    const command = adapters.planner.adapter.seatCommand({
      role: 'planner', model: raw, promptFile: '/tmp/role-planner.md',
      tools: SEAT_DEFAULTS.planner.tools, deny: SEAT_DEFAULTS.planner.deny, taskDir: root,
      bootBrief: 'boot', effort: 'high', grants: adapters.planner.grants, configDir: adapters.planner.configDir,
    })
    assert.ok(command.includes('--model openrouter/meta/muse-spark-1.3-contributor'))
    assert.deepEqual(probed, [])
    await assert.rejects(
      () => resolveAdapters(['planner'], {
        'model-planner': raw, 'agent-planner': 'pi', 'allow-shortfall-planner': 'subagents',
      }, null, { register: capabilityRegister(), root, probeEndpoint: async () => true }),
      (err) => err.reason === 'agent-provider-unsupported',
    )
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('B1 raw single-slash provider remains hosted', async () => {
  const root = scratchDir('crew-raw-single-slash-b1-')
  const raw = 'openai-codex/gpt-5.6-luna'
  try {
    const probed = []
    const adapters = await resolveAdapters(['builder'], {
      'model-builder': raw, 'agent-builder': 'pi',
    }, null, { register: capabilityRegister(), root, probeEndpoint: async (url) => { probed.push(url); return true } })
    assert.equal(adapters.builder.configDir, null)
    const command = adapters.builder.adapter.seatCommand({
      role: 'builder', model: raw, promptFile: '/tmp/role-builder.md',
      tools: SEAT_DEFAULTS.builder.tools, deny: SEAT_DEFAULTS.builder.deny, taskDir: root,
      bootBrief: 'boot', effort: 'max', grants: adapters.builder.grants, configDir: adapters.builder.configDir,
    })
    assert.ok(command.includes('--model openai-codex/gpt-5.6-luna'))
    assert.deepEqual(probed, [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('C1 raw unknown provider refuses before probing', async () => {
  const root = scratchDir('crew-raw-unknown-c1-')
  try {
    const probed = []
    await assert.rejects(
      () => resolveAdapters(['builder'], {
        'model-builder': 'unknown-provider/qwen3-coder', 'agent-builder': 'pi',
      }, null, { register: capabilityRegister(), root, probeEndpoint: async (url) => { probed.push(url); return true } }),
      (err) => err.reason === 'agent-provider-unsupported' && CAPABILITY_REFUSALS.includes(err.reason),
    )
    assert.deepEqual(probed, [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('D1 raw matching providers refuse ambiguity', async () => {
  const root = scratchDir('crew-raw-dual-match-d1-')
  try {
    const base = capabilityRegister()
    const local = () => ({ settings: 'crew/pi/settings.json', pi_provider: 'anthropic', base_url: 'http://127.0.0.1:11434/v1' })
    const register = capabilityRegister({
      local_providers: { 'a-box': local(), 'b-box': local() },
      coding_agents: { pi: { ...base.coding_agents.pi, providers: ['openai', 'a-box', 'b-box'] } },
    })
    const probed = []
    await assert.rejects(
      () => resolveAdapters(['builder'], {
        'model-builder': 'anthropic/dual-match-model', 'agent-builder': 'pi',
      }, null, { register, root, probeEndpoint: async (url) => { probed.push(url); return true } }),
      (err) => err.reason === 'agent-provider-unsupported',
    )
    assert.deepEqual(probed, [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('E2 raw trailing slash refuses without probing', async () => {
  const root = scratchDir('crew-raw-trailing-slash-e2-')
  try {
    const base = capabilityRegister()
    const register = capabilityRegister({ coding_agents: {
      pi: { ...base.coding_agents.pi, providers: ['openai', 'anthropic', 'meta', 'llama-swap'] },
    } })
    const probed = []
    await assert.rejects(
      () => resolveAdapters(['planner'], {
        'model-planner': 'openrouter/meta/', 'agent-planner': 'pi', 'allow-shortfall-planner': 'subagents',
      }, null, { register, root, probeEndpoint: async (url) => { probed.push(url); return true } }),
      (err) => err.reason === 'agent-provider-unsupported',
    )
    assert.deepEqual(probed, [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('H1 roster local provider path remains unchanged', async () => {
  const root = scratchDir('crew-roster-local-h1-')
  try {
    const settings = join(root, 'crew/pi/settings.json')
    const baseUrl = 'http://127.0.0.1:11434/v1'
    mkdirSync(dirname(settings), { recursive: true })
    writeFileSync(settings, '{}')
    writeFileSync(join(dirname(settings), 'models.json'), JSON.stringify({ providers: { 'local-pi': null } }))
    const register = capabilityRegister({ local_providers: {
      'local-pi': { settings: 'crew/pi/settings.json', pi_provider: 'local-pi', base_url: baseUrl },
    } })
    const probed = []
    const seats = { builder: { agent: 'pi', effort: 'max', provider: 'local-pi', id: 'qwen3-coder', model: null } }
    const adapters = await resolveAdapters(['builder'], {}, seats, {
      register, root, probeEndpoint: async (url) => { probed.push(url); return true },
    })
    assert.equal(adapters.builder.configDir, dirname(settings))
    assert.deepEqual(probed, [baseUrl])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('RV1-1 raw adapter namespace resolves a divergent local provider', async () => {
  const root = scratchDir('crew-raw-divergent-rv1-1-')
  try {
    const settings = join(root, 'crew/pi/settings.json')
    const baseUrl = 'http://127.0.0.1:11434/v1'
    mkdirSync(dirname(settings), { recursive: true })
    writeFileSync(settings, '{}')
    writeFileSync(join(dirname(settings), 'models.json'), JSON.stringify({ providers: { 'llama-swap': null } }))
    const base = capabilityRegister()
    const register = capabilityRegister({
      local_providers: {
        'lan-box': { settings: 'crew/pi/settings.json', pi_provider: 'llama-swap', base_url: baseUrl },
      },
      coding_agents: {
        pi: { ...base.coding_agents.pi, providers: ['openai', 'anthropic', 'lan-box'] },
      },
    })
    const probed = []
    const adapters = await resolveAdapters(['builder'], { 'model-builder': 'llama-swap/qwen3-coder', 'agent-builder': 'pi' }, null, {
      register, root, probeEndpoint: async (url) => { probed.push(url); return true },
    })
    assert.equal(adapters.builder.configDir, dirname(settings))
    assert.deepEqual(probed, [baseUrl])
    probed.length = 0
    await assert.rejects(
      () => resolveAdapters(['builder'], { 'model-builder': 'lan-box/qwen3-coder', 'agent-builder': 'pi' }, null, {
        register, root, probeEndpoint: async (url) => { probed.push(url); return true },
      }),
      (err) => err.reason === 'agent-provider-unsupported'
        && CAPABILITY_REFUSALS.includes(err.reason)
        && /coding_agents\.pi\.providers/.test(err.message),
    )
    assert.deepEqual(probed, [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('RV1-2 raw roster-key spelling refuses without an adapter match', async () => {
  const root = scratchDir('crew-raw-divergent-rv1-2-')
  try {
    const settings = join(root, 'crew/pi/settings.json')
    mkdirSync(dirname(settings), { recursive: true })
    writeFileSync(settings, '{}')
    writeFileSync(join(dirname(settings), 'models.json'), JSON.stringify({ providers: { 'llama-swap': null } }))
    const base = capabilityRegister()
    const register = capabilityRegister({
      local_providers: {
        'lan-box': { settings: 'crew/pi/settings.json', pi_provider: 'llama-swap', base_url: 'http://127.0.0.1:11434/v1' },
      },
      coding_agents: {
        pi: { ...base.coding_agents.pi, providers: ['openai', 'anthropic', 'lan-box'] },
      },
    })
    const probed = []
    await assert.rejects(
      () => resolveAdapters(['builder'], { 'model-builder': 'lan-box/qwen3-coder', 'agent-builder': 'pi' }, null, {
        register, root, probeEndpoint: async (url) => { probed.push(url); return true },
      }),
      (err) => err.reason === 'agent-provider-unsupported'
        && CAPABILITY_REFUSALS.includes(err.reason)
        && /coding_agents\.pi\.providers/.test(err.message)
        && /llama-swap\/qwen3-coder/.test(err.message),
    )
    assert.deepEqual(probed, [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('RV1-3 bare raw override keeps roster local checks', async () => {
  const root = scratchDir('crew-raw-bare-rv1-3-')
  try {
    const settings = join(root, 'crew/pi/settings.json')
    const baseUrl = 'http://127.0.0.1:11434/v1'
    mkdirSync(dirname(settings), { recursive: true })
    writeFileSync(settings, '{}')
    writeFileSync(join(dirname(settings), 'models.json'), JSON.stringify({ providers: { 'llama-swap': null } }))
    const register = capabilityRegister({ local_providers: {
      'llama-swap': { settings: 'crew/pi/settings.json', pi_provider: 'llama-swap', base_url: baseUrl },
    } })
    const seats = { builder: { agent: 'pi', effort: 'max', provider: 'llama-swap', id: 'gpt-oss-20b', model: null } }
    const probed = []
    const adapters = await resolveAdapters(['builder'], { 'model-builder': 'gpt-oss-20b', 'agent-builder': 'pi' }, seats, {
      register, root, probeEndpoint: async (url) => { probed.push(url); return true },
    })
    assert.equal(adapters.builder.configDir, dirname(settings))
    assert.deepEqual(probed, [baseUrl])
    probed.length = 0
    await assert.rejects(
      () => resolveAdapters(['builder'], { 'model-builder': 'gpt-oss-20b', 'agent-builder': 'pi' }, seats, {
        register, root, probeEndpoint: async (url) => { probed.push(url); return false },
      }),
      (err) => err.reason === 'local-endpoint-dead' && CAPABILITY_REFUSALS.includes(err.reason),
    )
    assert.deepEqual(probed, [baseUrl])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('A1 local provider without models.json refuses by closed declaration reason', async () => {
  const root = scratchDir('crew-local-provider-a1-')
  try {
    const settings = join(root, 'crew/pi/settings.json')
    mkdirSync(dirname(settings), { recursive: true })
    writeFileSync(settings, '{}')
    const register = capabilityRegister({ local_providers: {
      'local-pi': { settings: 'crew/pi/settings.json', pi_provider: 'local-pi', base_url: 'http://127.0.0.1:11434/v1' },
    } })
    const seats = { builder: { agent: 'pi', effort: 'max', provider: 'local-pi', id: 'qwen3-coder', model: null } }
    await assert.rejects(
      () => resolveAdapters(['builder'], {}, seats, { register, root, probeEndpoint: async () => true }),
      (err) => err.reason === 'local-provider-undeclared' && CAPABILITY_REFUSALS.includes(err.reason),
    )
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('B1 local provider omitted from models.json refuses by closed declaration reason', async () => {
  const root = scratchDir('crew-local-provider-b1-')
  try {
    const settings = join(root, 'crew/pi/settings.json')
    mkdirSync(dirname(settings), { recursive: true })
    writeFileSync(settings, '{}')
    writeFileSync(join(dirname(settings), 'models.json'), JSON.stringify({ providers: { other: null } }))
    const register = capabilityRegister({ local_providers: {
      'local-pi': { settings: 'crew/pi/settings.json', pi_provider: 'local-pi', base_url: 'http://127.0.0.1:11434/v1' },
    } })
    const seats = { builder: { agent: 'pi', effort: 'max', provider: 'local-pi', id: 'qwen3-coder', model: null } }
    await assert.rejects(
      () => resolveAdapters(['builder'], {}, seats, { register, root, probeEndpoint: async () => true }),
      (err) => err.reason === 'local-provider-undeclared',
    )
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('C1 local provider declared in models.json boots', async () => {
  const root = scratchDir('crew-local-provider-c1-')
  try {
    const settings = join(root, 'crew/pi/settings.json')
    mkdirSync(dirname(settings), { recursive: true })
    writeFileSync(settings, 'settings contents are not read')
    writeFileSync(join(dirname(settings), 'models.json'), JSON.stringify({ providers: { 'local-pi': null } }))
    const register = capabilityRegister({ local_providers: {
      'local-pi': { settings: 'crew/pi/settings.json', pi_provider: 'local-pi', base_url: 'http://127.0.0.1:11434/v1' },
    } })
    const seats = { builder: { agent: 'pi', effort: 'max', provider: 'local-pi', id: 'qwen3-coder', model: null } }
    const adapters = await resolveAdapters(['builder'], {}, seats, { register, root, probeEndpoint: async () => true })
    assert.equal(adapters.builder.configDir, dirname(settings))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('D1 empty settings.json with declared models provider boots', async () => {
  const root = scratchDir('crew-local-provider-d1-')
  try {
    const settings = join(root, 'crew/pi/settings.json')
    mkdirSync(dirname(settings), { recursive: true })
    writeFileSync(settings, '{}')
    writeFileSync(join(dirname(settings), 'models.json'), JSON.stringify({ providers: { 'local-pi': null } }))
    const register = capabilityRegister({ local_providers: {
      'local-pi': { settings: 'crew/pi/settings.json', pi_provider: 'local-pi', base_url: 'http://127.0.0.1:11434/v1' },
    } })
    const seats = { builder: { agent: 'pi', effort: 'max', provider: 'local-pi', id: 'qwen3-coder', model: null } }
    await assert.doesNotReject(
      () => resolveAdapters(['builder'], {}, seats, { register, root, probeEndpoint: async () => true }),
    )
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('E1 undeclared local provider refusal names models file and pi provider', async () => {
  const root = scratchDir('crew-local-provider-e1-')
  try {
    const settings = join(root, 'crew/pi/settings.json')
    const models = join(dirname(settings), 'models.json')
    mkdirSync(dirname(settings), { recursive: true })
    writeFileSync(settings, '{}')
    writeFileSync(models, JSON.stringify({ providers: { other: null } }))
    const provider = 'registered-provider'
    const piProvider = 'configured-pi'
    const register = capabilityRegister({ local_providers: {
      [provider]: { settings: 'crew/pi/settings.json', pi_provider: piProvider, base_url: 'http://127.0.0.1:11434/v1' },
    } })
    const seats = { builder: { agent: 'pi', effort: 'max', provider, id: 'qwen3-coder', model: null } }
    await assert.rejects(
      () => resolveAdapters(['builder'], {}, seats, { register, root, probeEndpoint: async () => true }),
      (err) => err.reason === 'local-provider-undeclared'
        && err.message.includes(models)
        && err.message.includes(piProvider)
        && err.message.includes(`providers.${piProvider}`),
    )
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('F1 absent local settings keeps distinct local-settings-missing reason', async () => {
  const root = scratchDir('crew-local-provider-f1-')
  try {
    const register = capabilityRegister({ local_providers: {
      'local-pi': { settings: 'crew/pi/no-settings.json', pi_provider: 'local-pi', base_url: 'http://127.0.0.1:11434/v1' },
    } })
    const seats = { builder: { agent: 'pi', effort: 'max', provider: 'local-pi', id: 'qwen3-coder', model: null } }
    await assert.rejects(
      () => resolveAdapters(['builder'], {}, seats, { register, root, probeEndpoint: async () => true }),
      (err) => err.reason === 'local-settings-missing' && err.reason !== 'local-provider-undeclared',
    )
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('G1 local provider boot refuses an unreachable base_url by name', async () => {
  const root = capabilityFixtureRoot()
  try {
    const settings = join(root, 'crew/pi/settings.json')
    writeFileSync(settings, '{}\n')
    writeFileSync(join(dirname(settings), 'models.json'), JSON.stringify({ providers: { 'llama-swap': null } }))
    const register = capabilityRegister({ local_providers: {
      'llama-swap': { settings: 'crew/pi/settings.json', pi_provider: 'llama-swap', base_url: 'http://192.0.2.1:9/v1' },
    } })
    const seats = { builder: { agent: 'pi', effort: 'max', provider: 'llama-swap', id: 'qwen3.8-27b', model: null } }
    const unreachableProbe = async () => false
    await assert.rejects(
      () => resolveAdapters(['builder'], {}, seats, { register, root, probeEndpoint: unreachableProbe }),
      (err) => err.reason === 'local-endpoint-dead' && err.message.includes('http://192.0.2.1:9/v1'),
    )
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('resolveAdapters refuses a granted definition local-provider cell without parent fallback', async () => {
  const root = scratchDir('crew-def-local-')
  const definition = join(root, 'crew/pi/agents/scout.json')
  const extension = join(root, 'crew/pi/extensions/subagent.ts')
  mkdirSync(dirname(definition), { recursive: true })
  mkdirSync(dirname(extension), { recursive: true })
  writeFileSync(definition, JSON.stringify({ name: 'scout', prompt: 'p', tools: ['read'], model: { provider: 'local-pi', id: 'qwen3-coder' } }))
  writeFileSync(extension, '// extension\n')
  const base = capabilityRegister()
  const register = capabilityRegister({
    local_providers: {
      'local-pi': { settings: 'crew/pi/settings.json', pi_provider: 'local-pi', base_url: 'http://127.0.0.1:11434/v1' },
    },
    roles: {
      planner: { ...base.roles.planner, extensions: ['crew/pi/extensions/subagent.ts'], agents: [{ name: 'scout', def: 'crew/pi/agents/scout.json' }] },
    },
  })
  const seats = { planner: { agent: 'pi', effort: 'medium', provider: 'anthropic', id: 'claude-opus-5', model: null } }
  await assert.rejects(
    () => resolveAdapters(['planner'], {}, seats, { register, root, probeEndpoint: async () => true }),
    (err) => err.reason === 'local-settings-missing' && /agent definition scout local provider local-pi settings/.test(err.message),
  )
  writeFileSync(join(root, 'crew/pi/settings.json'), '{}')
  await assert.rejects(
    () => resolveAdapters(['planner'], {}, seats, { register, root, probeEndpoint: async () => false }),
    (err) => err.reason === 'local-endpoint-dead' && /agent definition scout local provider local-pi endpoint/.test(err.message),
  )
})

test('resolveAdapters refuses a claude-seated local-provider cell before any seat spawns', async () => {
  const root = capabilityFixtureRoot()
  try {
    const settings = join(root, 'crew/pi/settings.json')
    writeFileSync(settings, '{}')
    const base = capabilityRegister()
    const register = capabilityRegister({
      local_providers: {
        'local-pi': { settings: 'crew/pi/settings.json', pi_provider: 'local-pi', base_url: 'http://127.0.0.1:11434/v1' },
      },
      coding_agents: {
        claude: { ...base.coding_agents.claude, providers: ['anthropic', 'local-pi'] },
      },
      // A grant path nothing else in the fixture carries: if the resolver ever
      // reaches the NEXT seat, this path is the unambiguous evidence.
      roles: { planner: { ...base.roles.planner, requires: [], extensions: ['crew/pi/planner-marker.js'] } },
    })
    const seats = {
      builder: { agent: 'claude', effort: 'max', provider: 'local-pi', id: 'qwen3-coder', model: null },
      planner: { agent: 'claude', effort: 'max', provider: null, id: 'claude-opus-5', model: null },
    }
    const probed = []
    const seen = []
    await assert.rejects(
      () => resolveAdapters(['builder', 'planner'], {}, seats, {
        register, root,
        probeEndpoint: async (url) => { probed.push(url); return true },
        exists: (p) => { seen.push(p); return existsSync(p) },
      }),
      (err) => err.reason === 'grant-unsupported'
        && /builder/.test(err.message) && /claude/.test(err.message) && /local-pi/.test(err.message),
    )
    // The register refusal is consumed before endpoint probing or adapter
    // resolution, so neither side effect is reached.
    assert.deepEqual(probed, [])
    assert.deepEqual(seen, [])
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

test('adapter-claude inline MCP grants rely on strict config without wildcard denial', () => {
  const grants = {
    tools: [], extensions: [], agents: [], skills: [], advisor: false,
    mcp_servers: [{ name: 'search', command: { bin: '/opt/mcp-search', args: ['--stdio'] }, url: null }],
  }
  const seat = {
    role: 'builder', model: 'sonnet', promptFile: '/tmp/role-builder.md', tools: 'Read', deny: 'Task,Agent',
    taskDir: '/tmp/task', bootBrief: 'boot', grants,
  }
  const pane = seatCommand(seat)
  assert.match(pane, /--allowedTools "Read"/)
  assert.match(pane, /--disallowedTools "Task,Agent"/)
  assert.doesNotMatch(pane, /mcp__\*/)
  assert.match(pane, /--strict-mcp-config/)
  assert.match(pane, /--mcp-config "\/tmp\/task\/mcp\/builder\.json"/)

  const headless = claudeHeadlessCommand({
    ...seat, prompt: 'go', sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', bin: '/usr/local/bin/claude',
  })
  const args = headless.args.join(' ')
  assert.match(args, /--allowedTools Read/)
  assert.match(args, /--disallowedTools Task,Agent/)
  assert.doesNotMatch(args, /mcp__\*/)
  assert.deepEqual(mcpConfigDocument(grants), { mcpServers: { search: { command: '/opt/mcp-search', args: ['--stdio'] } } })
})

// Sol's three reproductions on #1426, each silent before this: a symlinked plugin parent
// wrote OUTSIDE the task dir and deleted what stood there; a granted path that is a
// DIRECTORY named SKILL.md passed every existence check and booted a seat whose skill the
// CLI would not load; and on a case-insensitive filesystem two names differing only in
// case became one destination, so the second copy replaced the first without a word.
// Mutation killed: dropping the containment check, the file check, or lowercasing the
// collision key.
test('RV1 writeSeatSkills refuses to write outside the task dir, to take a non-file, or to collapse two names into one', () => {
  const fixture = scratchDir('b860-rv1-src-')
  const skill = (name, body = '# skill\n') => {
    mkdirSync(join(fixture, name), { recursive: true })
    writeFileSync(join(fixture, name, 'SKILL.md'), body)
    return join(fixture, name, 'SKILL.md')
  }

  // 1. The plugin parent is a symlink out of the task dir, with something already there.
  const escapeTask = scratchDir('b860-rv1-task-')
  const outside = scratchDir('b860-rv1-outside-')
  const sentinel = join(outside, 'do-not-delete.txt')
  writeFileSync(sentinel, 'operator bytes\n')
  const pluginRoot = skillsPluginDir({ taskDir: escapeTask, role: 'builder' })
  mkdirSync(dirname(pluginRoot), { recursive: true })
  symlinkSync(outside, pluginRoot)
  assert.throws(
    () => writeSeatSkills({ taskDir: escapeTask, role: 'builder', grants: { skills: [skill('alpha')] } }),
    (err) => err.reason === 'grant-unsupported' && /outside the task dir/.test(err.message),
  )
  assert.equal(existsSync(sentinel), true, 'the bytes outside the task dir are untouched')
  assert.equal(readFileSync(sentinel, 'utf8'), 'operator bytes\n')

  // 2. A granted path that is a directory named SKILL.md.
  const dirTask = scratchDir('b860-rv1-dirtask-')
  mkdirSync(join(fixture, 'bad', 'SKILL.md'), { recursive: true })
  assert.throws(
    () => writeSeatSkills({ taskDir: dirTask, role: 'builder', grants: { skills: [join(fixture, 'bad', 'SKILL.md')] } }),
    (err) => err.reason === 'grant-unsupported' && /is not a file/.test(err.message),
  )
  assert.equal(existsSync(skillsPluginDir({ taskDir: dirTask, role: 'builder' })), false, 'nothing was written')

  // 3. Two names differing only in case.
  const caseTask = scratchDir('b860-rv1-casetask-')
  assert.throws(
    () => writeSeatSkills({ taskDir: caseTask, role: 'builder', grants: { skills: [skill('Foo'), skill('foo')] } }),
    (err) => err.reason === 'grant-unsupported' && /differs only in case/.test(err.message),
  )
  assert.equal(existsSync(skillsPluginDir({ taskDir: caseTask, role: 'builder' })), false, 'nothing was written')

  // And the honest path still works: one skill, inside the task dir, is materialised.
  const goodTask = scratchDir('b860-rv1-good-')
  writeSeatSkills({ taskDir: goodTask, role: 'builder', grants: { skills: [skill('gamma')] } })
  assert.equal(existsSync(join(skillsPluginDir({ taskDir: goodTask, role: 'builder' }), 'skills', 'gamma', 'SKILL.md')), true)
})
