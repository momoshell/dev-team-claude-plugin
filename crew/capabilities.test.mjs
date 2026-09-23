import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, dirname, resolve as resolvePath } from 'node:path'
import {
  CAPABILITY_ADAPTERS, CAPABILITY_CLASSES, CAPABILITY_DELIVERY, CAPABILITY_PROBES,
  CAPABILITY_REFUSALS, AGENT_AVAILABILITY_STATES, AGENT_AVAILABILITY_REASONS, EMPTY_GRANTS, REGISTER_ROOT, ACP_TRANSPORT_PROFILE, assertGrantsBacked,
  agentAvailability, agentRegisterEntry, assertAgentProvider, assertAgentTransport, assertAgentAdapter, assertAgentRefusals,
  declaredCapabilities, effectiveCapabilities, grantsFor, loadCapabilities, probeCapability, validateRosterAgents,
  refuse, seatableLocalProviderNames, validateCapabilities, vendorRoots,
} from './capabilities.mjs'
import { seatCommand as claudeSeatCommand, capabilitiesFor, skillsPluginDir, writeSeatSkills } from './adapters/adapter-claude.mjs'
import { seatCommand as piSeatCommand, capabilitiesFor as piCapabilitiesFor, PI_FIRST_PARTY_EXTENSION_TOOLS, PI_BUILTIN_TOOLS, PI_PROVIDERS } from './adapters/adapter-pi.mjs'
import { scratchDir } from '../test/helpers.mjs'
import { NARRATION_BACKSTOP_SECONDS, NARRATION_CONNECT_TIMEOUT_SECONDS, NARRATION_MIN_BYTES_PER_SECOND, NARRATION_STALL_SECONDS, narratorCommand } from './drive.mjs'

test('G1T freezes the exhaustive first-party extension declaration table and matches registrars', () => {
  const expected = {
    'crew/pi/extensions/advisor.ts': [],
    'crew/pi/extensions/builderloop.ts': [],
    'crew/pi/extensions/readgate.ts': [],
    'crew/pi/extensions/lab.ts': ['lab'],
    'crew/pi/extensions/skeletonread.ts': ['retrieve'],
    'crew/pi/extensions/subagent.ts': ['agent'],
    'crew/pi/extensions/fff.ts': ['fff_grep', 'fff_find', 'fff_multi_grep'],
  }
  assert.deepEqual(PI_FIRST_PARTY_EXTENSION_TOOLS, expected)
  assert.equal(Object.isFrozen(PI_FIRST_PARTY_EXTENSION_TOOLS), true)
  for (const value of Object.values(PI_FIRST_PARTY_EXTENSION_TOOLS)) assert.equal(Object.isFrozen(value), true)

  const source = (name) => readFileSync(new URL(`./pi/extensions/${name}.ts`, import.meta.url), 'utf8')
  const subagent = source('subagent')
  const skeletonread = source('skeletonread')
  const lab = source('lab')
  assert.match(subagent, /AGENT_TOOL_NAME = 'agent'/)
  assert.match(subagent, /registerTool\(createAgentTool\(\)\)/)
  assert.match(skeletonread, /RETRIEVE_TOOL_NAME = 'retrieve'/)
  assert.match(skeletonread, /registerTool\(skeleton\.retrieve\)/)
  assert.match(lab, /LAB_TOOL_NAME = 'lab'/)
  assert.match(lab, /registerTool\(createLabTool\(\)\)/)
  for (const name of ['advisor', 'builderloop', 'readgate']) assert.doesNotMatch(source(name), /registerTool\s*\(/)
})

function capabilityRegister(overrides = {}) {
  const grant = (extra = {}) => ({ tools: [], extensions: [], agents: [], skills: [], advisor: false, requires: [], mcp_servers: [], ...extra })
  const base = {
    schema_version: 1,
    updated_at: '2026-08-17',
    roles: {
      lead: grant(), planner: grant({ requires: ['subagents'] }), builder: grant(),
      reviewer: grant(), 'tech-lead': grant(),
    },
    local_providers: {},
    coding_agents: {
      pi: { providers: ['openai', 'anthropic', 'llama-swap'], transports: ['pane', 'headless-rpc'], adapter: 'crew/adapters/adapter-pi.mjs', refuses: ['mcp_servers'], display_name: 'Pi', binary: 'pi', install_hint: 'Install Pi and ensure the pi binary is on PATH.', availability: 'executable', availability_reason: 'executable' },
      claude: { providers: ['anthropic'], transports: ['pane', 'headless-json'], adapter: 'crew/adapters/adapter-claude.mjs', refuses: ['extensions', 'local_provider'], display_name: 'Claude Code', binary: 'claude', install_hint: 'Install Claude Code and ensure the claude binary is on PATH.', availability: 'executable', availability_reason: 'executable' },
    },
  }
  const local_providers = { ...base.local_providers, ...(overrides.local_providers || {}) }
  const coding_agents = { ...base.coding_agents, ...(overrides.coding_agents || {}) }
  if (!overrides.coding_agents?.pi && Object.keys(local_providers).length) {
    coding_agents.pi = { ...coding_agents.pi, providers: [...new Set([...coding_agents.pi.providers, ...Object.keys(local_providers)])] }
  }
  return { ...base, ...overrides, local_providers, coding_agents, roles: { ...base.roles, ...(overrides.roles || {}) } }
}

test('MCP register definitions are closed and require exactly one command or URL', () => {
  const schema = JSON.parse(readFileSync(new URL('./capabilities.schema.json', import.meta.url), 'utf8'))
  const command = { name: 'search', command: { bin: '/opt/mcp-search', args: ['--stdio'] }, url: null }
  const http = { name: 'remote', command: null, url: 'https://mcp.example.test/api' }
  const valid = capabilityRegister({ roles: { builder: { ...capabilityRegister().roles.builder, mcp_servers: [command, http] } } })
  assert.deepEqual(validateCapabilities(schema, valid), [])
  for (const mutate of [
    (register) => { register.roles.builder.mcp_servers[0].unexpected = true },
    (register) => { register.roles.builder.mcp_servers[0].name = 'not valid' },
    (register) => { register.roles.builder.mcp_servers[0].command.bin = '   ' },
    (register) => { register.roles.builder.mcp_servers[0].command.args = [1] },
    (register) => { register.roles.builder.mcp_servers[0].url = 'ftp://mcp.example.test' },
  ]) {
    const invalid = JSON.parse(JSON.stringify(valid))
    mutate(invalid)
    assert.ok(validateCapabilities(schema, invalid).length > 0)
    assert.throws(() => loadCapabilities({ register: invalid }), (err) => err.reason === 'register-invalid')
  }
  for (const mcp_servers of [
    [{ name: 'both', command: { bin: '/opt/mcp', args: [] }, url: 'https://mcp.example.test' }],
    [{ name: 'neither', command: null, url: null }],
  ]) {
    const invalid = capabilityRegister({ roles: { builder: { ...capabilityRegister().roles.builder, mcp_servers } } })
    assert.deepEqual(validateCapabilities(schema, invalid), [])
    assert.throws(() => loadCapabilities({ register: invalid }), (err) => err.reason === 'register-invalid' && /exactly one/.test(err.message))
  }
})

test('MCP adapter overlays replace by name and remain register-backed', () => {
  const baseServer = { name: 'search', command: { bin: '/opt/base-search', args: [] }, url: null }
  const overlayServer = { name: 'search', command: null, url: 'https://mcp.example.test/search' }
  const extraServer = { name: 'metrics', command: { bin: '/opt/metrics', args: ['--stdio'] }, url: null }
  const base = capabilityRegister()
  const register = capabilityRegister({ roles: {
    planner: {
      ...base.roles.planner,
      mcp_servers: [baseServer],
      by_agent: { pi: { mcp_servers: [overlayServer, extraServer] } },
    },
  } })
  const loaded = loadCapabilities({ register })
  assert.deepEqual(grantsFor(loaded, 'planner').mcp_servers, [baseServer])
  assert.deepEqual(grantsFor(loaded, 'planner', { agent: 'pi' }).mcp_servers, [overlayServer, extraServer])
})

test('MCP duplicate names refuse independently at role and overlay boundaries', () => {
  const base = capabilityRegister()
  const duplicate = { name: 'search', command: { bin: '/opt/mcp', args: [] }, url: null }
  const roleDuplicate = capabilityRegister({ roles: {
    builder: { ...base.roles.builder, mcp_servers: [duplicate, { ...duplicate, command: { bin: '/opt/other', args: [] } }] },
  } })
  assert.throws(() => loadCapabilities({ register: roleDuplicate }), (err) => err.reason === 'register-invalid' && /roles\.builder/.test(err.message))
  const overlayDuplicate = capabilityRegister({ roles: {
    builder: { ...base.roles.builder, by_agent: { pi: { mcp_servers: [duplicate, duplicate] } } },
  } })
  assert.throws(() => loadCapabilities({ register: overlayDuplicate }), (err) => err.reason === 'register-invalid' && /roles\.builder\.by_agent\.pi/.test(err.message))
})

test('resolved MCP arrays and definitions are frozen, and backing rejects forged values', () => {
  const server = { name: 'search', command: { bin: '/opt/mcp-search', args: ['--stdio'] }, url: null }
  const register = capabilityRegister({ roles: { builder: { ...capabilityRegister().roles.builder, mcp_servers: [server] } } })
  const loaded = loadCapabilities({ register })
  const grants = grantsFor(loaded, 'builder')
  assert.equal(Object.isFrozen(EMPTY_GRANTS.mcp_servers), true)
  assert.equal(Object.isFrozen(grants.mcp_servers), true)
  assert.equal(Object.isFrozen(grants.mcp_servers[0]), true)
  assert.equal(Object.isFrozen(grants.mcp_servers[0].command), true)
  assert.equal(Object.isFrozen(grants.mcp_servers[0].command.args), true)
  assert.doesNotThrow(() => assertGrantsBacked('builder', grants, loaded))
  const forged = (mcp) => ({ ...grants, mcp_servers: [mcp] })
  assert.throws(() => assertGrantsBacked('builder', forged({ ...server, name: 'forged' }), loaded), (err) => err.reason === 'unknown-grant')
  assert.throws(() => assertGrantsBacked('builder', forged({ ...server, command: { bin: '/opt/changed', args: ['--stdio'] } }), loaded), (err) => err.reason === 'unknown-grant')
})

test('A1 coding agent register validates as a closed schema', () => {
  const schema = JSON.parse(readFileSync(new URL('./capabilities.schema.json', import.meta.url), 'utf8'))
  const shipped = JSON.parse(readFileSync(new URL('./capabilities.json', import.meta.url), 'utf8'))
  assert.deepEqual(validateCapabilities(schema, shipped), [])
  for (const mutate of [
    (value) => { delete value.coding_agents.pi.providers },
    (value) => { value.coding_agents.pi.providers = [] },
    (value) => { value.coding_agents.pi.transports = ['unknown'] },
    (value) => { value.coding_agents.pi.refuses = ['unknown'] },
    (value) => { value.coding_agents.pi.extra = true },
    (value) => { delete value.coding_agents.pi.display_name },
    (value) => { delete value.coding_agents.pi.binary },
    (value) => { delete value.coding_agents.pi.install_hint },
    (value) => { delete value.coding_agents.pi.availability },
    (value) => { value.coding_agents.pi.availability = 'invented-state' },
    (value) => { delete value.coding_agents.pi.availability_reason },
    (value) => { value.coding_agents.pi.availability_reason = 'invented-reason' },
    (value) => { value.coding_agents.pi.display_name = '   ' },
    (value) => { value.coding_agents.pi.binary = 'pi --version' },
    (value) => { value.coding_agents.pi.install_hint = '' },
    (value) => { value.coding_agents.pi.config = ['   '] },
    (value) => { delete value.coding_agents.pi.adapter },
    (value) => { delete value.coding_agents },
  ]) {
    const invalid = structuredClone(shipped)
    mutate(invalid)
    assert.ok(validateCapabilities(schema, invalid).length > 0)
    assert.throws(() => loadCapabilities({ register: invalid }), (err) => err.reason === 'register-invalid')
  }
})

test('coding agent duplicate inventory values refuse at their register paths', () => {
  const shipped = JSON.parse(readFileSync(new URL('./capabilities.json', import.meta.url), 'utf8'))
  for (const mutate of [
    (value) => { value.coding_agents.pi.providers.push('openai') },
    (value) => { value.coding_agents.pi.transports.push('pane') },
    (value) => { value.coding_agents.pi.refuses.push('mcp_servers') },
  ]) {
    const invalid = structuredClone(shipped)
    mutate(invalid)
    assert.deepEqual(validateCapabilities(JSON.parse(readFileSync(new URL('./capabilities.schema.json', import.meta.url), 'utf8')), invalid), [])
    assert.throws(() => loadCapabilities({ register: invalid }), (err) => err.reason === 'register-invalid' && /coding_agents\.pi/.test(err.message))
  }
})

test('B1A coding agent names and adapter paths derive from shipped adapters', () => {
  const shipped = loadCapabilities()
  const names = readdirSync(join(REGISTER_ROOT, 'crew', 'adapters'))
    .filter((file) => /^adapter-.+\.mjs$/.test(file))
    .map((file) => file.slice('adapter-'.length, -'.mjs'.length))
    .sort()
  assert.deepEqual(Object.keys(shipped.coding_agents).sort(), names)
  for (const name of names) assert.equal(shipped.coding_agents[name].adapter, `crew/adapters/adapter-${name}.mjs`)
  assert.doesNotThrow(() => assertAgentAdapter(shipped, 'pi', '/checkout/crew/adapters/adapter-pi.mjs', { role: 'builder' }))
  assert.throws(() => assertAgentAdapter(shipped, 'pi', 'crew/adapters/adapter-claude.mjs', { role: 'builder' }), (err) => err.reason === 'register-invalid' && /coding_agents\.pi\.adapter/.test(err.message))
})

test('B1P coding agent providers derive from shipped adapters and roster cells', () => {
  const shipped = loadCapabilities()
  const roster = JSON.parse(readFileSync(new URL('./roster.json', import.meta.url), 'utf8'))
  const piProviders = [...Object.keys(PI_PROVIDERS), ...seatableLocalProviderNames(shipped)]
  const claudeProviders = new Set()
  const visit = (cell) => {
    if (!cell || typeof cell !== 'object') return
    if (cell.agent === 'claude') claudeProviders.add(cell.provider)
    for (const fallback of cell.fallback || []) visit(fallback)
  }
  for (const cells of Object.values(roster.tiers || {})) {
    for (const cell of Object.values(cells || {})) visit(cell)
  }
  assert.deepEqual(shipped.coding_agents.pi.providers, piProviders)
  assert.deepEqual(shipped.coding_agents.claude.providers, [...claudeProviders])
  assert.equal(capabilitiesFor({ transport: 'pane' }).local_provider, false)
})

test('B1 narrator is not a provider pi can seat', () => {
  const shipped = loadCapabilities()
  const piProviders = [...Object.keys(PI_PROVIDERS), ...seatableLocalProviderNames(shipped)]
  assert.equal(piProviders.includes('narrator'), false)
  assert.equal(shipped.coding_agents.pi.providers.includes('narrator'), false)
})

test('C1 every non-seat root declaration stays outside the seat provider set', () => {
  const entry = {
    settings: 'crew/pi/settings.json', pi_provider: 'local-pi',
    base_url: 'http://127.0.0.1:11434/v1', model: 'Qwen/Qwen3-Coder:latest',
  }
  const register = capabilityRegister({ narrator: entry, metrics: entry })
  assert.deepEqual(seatableLocalProviderNames(register), [])
})

test('D1 a local seat provider is included in the seat provider set', () => {
  const entry = {
    settings: 'crew/pi/settings.json', pi_provider: 'local-pi',
    base_url: 'http://127.0.0.1:11434/v1', model: 'Qwen/Qwen3-Coder:latest',
  }
  const register = capabilityRegister({ local_providers: { 'distinctive-seat': entry } })
  assert.deepEqual(seatableLocalProviderNames(register), ['distinctive-seat'])
})

test('A1 stale narrator local provider is refused by its closed reason', () => {
  const entry = {
    settings: 'crew/pi/settings.json', pi_provider: 'local-pi',
    base_url: 'http://127.0.0.1:11434/v1', model: 'Qwen/Qwen3-Coder:latest',
  }
  const register = capabilityRegister({ local_providers: { narrator: entry } })
  assert.throws(() => loadCapabilities({ register }), (err) => err.reason === 'local-provider-reserved')
})

test('B1 stale narrator refusal names its top-level declaration path', () => {
  const entry = {
    settings: 'crew/pi/settings.json', pi_provider: 'local-pi',
    base_url: 'http://127.0.0.1:11434/v1', model: 'Qwen/Qwen3-Coder:latest',
  }
  const register = capabilityRegister({ local_providers: { narrator: entry } })
  assert.throws(
    () => loadCapabilities({ register }),
    (err) => err.reason === 'local-provider-reserved' && /\$\.narrator/.test(err.message),
  )
})

test('C1 reserved non-seat provider refusal is schema-derived', () => {
  const entry = {
    settings: 'crew/pi/settings.json', pi_provider: 'local-pi',
    base_url: 'http://127.0.0.1:11434/v1', model: 'Qwen/Qwen3-Coder:latest',
  }
  const schema = structuredClone(JSON.parse(readFileSync(new URL('./capabilities.schema.json', import.meta.url), 'utf8')))
  schema.properties.metrics = { ...schema.properties.narrator }
  const schemaRoot = scratchDir('crew-capabilities-c1-')
  const schemaPath = join(schemaRoot, 'capabilities.schema.json')
  writeFileSync(schemaPath, JSON.stringify(schema))
  try {
    const register = capabilityRegister({ metrics: entry, local_providers: { metrics: entry } })
    assert.throws(
      () => loadCapabilities({ register, schemaPath }),
      (err) => err.reason === 'local-provider-reserved' && /\$\.metrics/.test(err.message),
    )
  } finally { rmSync(schemaRoot, { recursive: true, force: true }) }
})

test('D1 genuine local seat provider remains admitted', () => {
  const entry = {
    settings: 'crew/pi/settings.json', pi_provider: 'local-pi',
    base_url: 'http://127.0.0.1:11434/v1', model: 'Qwen/Qwen3-Coder:latest',
  }
  const loaded = loadCapabilities({ register: capabilityRegister({ local_providers: { 'distinctive-seat': entry } }) })
  assert.equal(seatableLocalProviderNames(loaded).includes('distinctive-seat'), true)
  assert.equal(loaded.coding_agents.pi.providers.includes('distinctive-seat'), true)
})

test('B1T coding agent transports derive from shipped adapters', () => {
  const shipped = loadCapabilities()
  const transports = ['pane', 'headless-json', 'headless-rpc']
  const supported = (adapter) => transports.filter((transport) => {
    try { adapter({ transport }); return true } catch { return false }
  })
  assert.deepEqual(shipped.coding_agents.pi.transports, supported(piCapabilitiesFor))
  assert.deepEqual(shipped.coding_agents.claude.transports, supported(capabilitiesFor))
})

test('D1P llama-swap is declared for pi', () => {
  const shipped = loadCapabilities()
  assert.equal(shipped.coding_agents.pi.providers.includes('llama-swap'), true)
  assert.equal(Object.hasOwn(shipped.local_providers, 'llama-swap'), true)
})

test('D1C llama-swap is not declared for claude', () => {
  assert.equal(loadCapabilities().coding_agents.claude.providers.includes('llama-swap'), false)
})

test('E1 subagent grant agents retain their existing meaning', () => {
  const shipped = loadCapabilities()
  assert.deepEqual(shipped.roles.planner.by_agent.pi.agents, [{ name: 'scout', def: 'crew/pi/agents/scout.json' }])
  assert.deepEqual(shipped.roles.planner.by_agent.pi.agents[0], { name: 'scout', def: 'crew/pi/agents/scout.json' })
})

function availabilityFixtureAgent(name, {
  config, displayName = name, availability = 'executable', availabilityReason = availability,
} = {}) {
  return {
    providers: ['openai'],
    transports: ['pane'],
    adapter: `crew/adapters/adapter-${name}.mjs`,
    refuses: [],
    display_name: displayName,
    binary: name,
    install_hint: `Install ${name}.`,
    availability,
    availability_reason: availabilityReason,
    ...(config === undefined ? {} : { config }),
  }
}

test('B1 schema refuses every contradictory availability state and reason pair', () => {
  const schema = JSON.parse(readFileSync(new URL('./capabilities.schema.json', import.meta.url), 'utf8'))
  const allowed = {
    executable: ['executable'],
    'proposal-stub': ['proposal-stub', 'adapter-import-failed'],
    'discovered-unavailable': ['discovered-unavailable', 'shim-not-binary', 'version-spawn-failed', 'version-interrupted'],
    'installed-unconfigured': ['installed-unconfigured', 'transport-refused'],
  }
  const reasons = [...AGENT_AVAILABILITY_REASONS]
  for (const state of AGENT_AVAILABILITY_STATES) {
    for (const reason of reasons) {
      const register = capabilityRegister({ coding_agents: {
        'fixture-matrix': availabilityFixtureAgent('fixture-matrix', { availability: state, availabilityReason: reason }),
      } })
      const accepted = allowed[state].includes(reason)
      if (accepted) assert.doesNotThrow(() => loadCapabilities({ register }), `${state}/${reason} should be accepted`)
      else assert.throws(() => loadCapabilities({ register }), (error) => error.reason === 'register-invalid', `${state}/${reason} should be rejected`)
    }
  }

  const overlapping = {
    oneOf: [
      { type: 'object', properties: { value: { type: 'string' } } },
      { type: 'object', properties: { value: { type: 'string' } } },
    ],
  }
  assert.ok(validateCapabilities(overlapping, { value: 'matches-both' }).length > 0)
})

test('C1 persisted availability reason is independent from availability state', () => {
  const register = loadCapabilities({ register: capabilityRegister({ coding_agents: {
    'fixture-persisted': availabilityFixtureAgent('fixture-persisted', {
      availability: 'discovered-unavailable',
      availabilityReason: 'version-spawn-failed',
    }),
  } }) })
  assert.deepEqual(agentAvailability(register, 'fixture-persisted'), {
    agent: 'fixture-persisted',
    state: 'discovered-unavailable',
    reason: 'version-spawn-failed',
    display_name: 'fixture-persisted',
    install_hint: 'Install fixture-persisted.',
  })
})

test('D1 roster validation refuses each non-executable persisted state', () => {
  for (const state of AGENT_AVAILABILITY_STATES) {
    const register = loadCapabilities({ register: capabilityRegister({ coding_agents: {
      'fixture-roster': availabilityFixtureAgent('fixture-roster', { availability: state }),
    } }) })
    const primary = { tiers: { build: { builder: { agent: 'fixture-roster' } } } }
    const fallback = { tiers: { build: { builder: { agent: 'pi', fallback: [{ agent: 'fixture-roster' }] } } } }
    for (const roster of [primary, fallback]) {
      if (state === 'executable') assert.doesNotThrow(() => validateRosterAgents(roster, register))
      else assert.throws(
        () => validateRosterAgents(roster, register),
        (error) => error.reason === 'agent-unavailable' && error.state === state && error.availability_reason === state,
      )
    }
  }
})

test('A1 agentAvailability reaches all four closed states', () => {
  const register = loadCapabilities({ register: capabilityRegister({ coding_agents: {
    'fixture-stub': availabilityFixtureAgent('fixture-stub'),
    'fixture-binary': availabilityFixtureAgent('fixture-binary'),
    'fixture-config': availabilityFixtureAgent('fixture-config', { config: ['~/fixture-config.json'] }),
    'fixture-executable': availabilityFixtureAgent('fixture-executable', { config: ['/fixture/config-executable'] }),
  } }) })
  const existing = new Set([
    join(REGISTER_ROOT, 'crew/adapters/adapter-fixture-binary.mjs'),
    join(REGISTER_ROOT, 'crew/adapters/adapter-fixture-config.mjs'),
    join(REGISTER_ROOT, 'crew/adapters/adapter-fixture-executable.mjs'),
    '/fixture/config-executable',
  ])
  const probe = {
    exists: (path) => existing.has(path),
    which: (binary) => binary === 'fixture-binary' ? null : `/bin/${binary}`,
    home: '/fixture-home',
  }
  const expected = {
    'fixture-stub': 'proposal-stub',
    'fixture-binary': 'discovered-unavailable',
    'fixture-config': 'installed-unconfigured',
    'fixture-executable': 'executable',
  }
  assert.deepEqual([...AGENT_AVAILABILITY_STATES], ['executable', 'discovered-unavailable', 'installed-unconfigured', 'proposal-stub'])
  assert.equal(Object.isFrozen(AGENT_AVAILABILITY_STATES), true)
  for (const [agent, state] of Object.entries(expected)) {
    const result = agentAvailability(register, agent, probe)
    assert.deepEqual(Object.keys(result), ['agent', 'state', 'reason', 'display_name', 'install_hint'])
    assert.equal(Object.isFrozen(result), true)
    assert.equal(result.agent, agent)
    assert.equal(result.state, state)
    assert.equal(result.reason, state)
  }

  assert.deepEqual([...AGENT_AVAILABILITY_REASONS], [
    'executable', 'proposal-stub', 'adapter-import-failed', 'discovered-unavailable',
    'shim-not-binary', 'version-spawn-failed', 'version-interrupted',
    'installed-unconfigured', 'transport-refused',
  ])
  assert.equal(Object.isFrozen(AGENT_AVAILABILITY_REASONS), true)
  const present = { exists: () => true, which: () => '/bin/fixture', home: '/fixture-home' }
  const evidence = (extra = {}) => agentAvailability(register, 'fixture-executable', {
    ...present, version: { status: 0, signal: null, error: null, stdout: '' }, ...extra,
  })
  const cases = [
    ['adapter import failure', { adapterLoadError: new Error('broken import') }, 'proposal-stub', 'adapter-import-failed'],
    ['missing binary', { which: () => null }, 'discovered-unavailable', 'discovered-unavailable'],
    ['version spawn error', { version: { status: null, signal: null, error: new Error('EPERM'), stdout: '' } }, 'discovered-unavailable', 'version-spawn-failed'],
    ['version interruption', { version: { status: null, signal: 'SIGTERM', error: null, stdout: '' } }, 'discovered-unavailable', 'version-interrupted'],
    ['shim is not binary', { version: { status: 1, signal: null, error: null, stdout: 'shim' } }, 'discovered-unavailable', 'shim-not-binary'],
    ['transport refusal', { transportRefusals: [{ transport: 'pane', message: 'refused' }] }, 'installed-unconfigured', 'transport-refused'],
  ]
  for (const [label, extra, state, reason] of cases) {
    const result = evidence(extra)
    assert.equal(result.state, state, label)
    assert.equal(result.reason, reason, label)
    assert.equal(AGENT_AVAILABILITY_REASONS.includes(result.reason), true, label)
  }
  assert.equal(evidence().state, 'executable')
  assert.equal(evidence().reason, 'executable')
  assert.deepEqual(agentAvailability(register, 'fixture-executable'), {
    agent: 'fixture-executable', state: 'executable', reason: 'executable',
    display_name: 'fixture-executable', install_hint: 'Install fixture-executable.',
  })
  const precedence = agentAvailability(register, 'fixture-config', {
    ...present,
    exists: (path) => path.endsWith('adapter-fixture-config.mjs'),
    version: { status: 2, signal: 'SIGTERM', error: new Error('spawn'), stdout: '' },
    adapterLoadError: new Error('import'),
    transportRefusals: [{ transport: 'pane', message: 'refused' }],
    which: () => '/bin/fixture-config',
  })
  assert.deepEqual({ state: precedence.state, reason: precedence.reason }, { state: 'proposal-stub', reason: 'adapter-import-failed' })
  const missingAdapter = agentAvailability(register, 'fixture-stub', {
    exists: () => false,
    adapterLoadError: new Error('import'),
    which: () => '/bin/fixture-stub',
  })
  assert.deepEqual({ state: missingAdapter.state, reason: missingAdapter.reason }, { state: 'proposal-stub', reason: 'proposal-stub' })
})

test('B1 proposal stubs are legal declarations but cannot resolve for boot', () => {
  const register = loadCapabilities({ register: capabilityRegister({ coding_agents: {
    'fixture-proposal': availabilityFixtureAgent('fixture-proposal', { availability: 'proposal-stub' }),
  } }) })
  assert.equal(Object.hasOwn(register.coding_agents, 'fixture-proposal'), true)
  const injected = { exists: () => false, which: () => '/bin/fixture-proposal', home: '/fixture-home' }
  for (const options of [
    { role: 'builder', probe: injected },
    { role: 'builder' },
  ]) {
    assert.throws(
      () => agentRegisterEntry(register, 'fixture-proposal', options),
      (err) => err.reason === 'agent-unavailable'
        && err.state === 'proposal-stub'
        && err.availability_reason === 'proposal-stub'
        && /builder/.test(err.message)
        && /fixture-proposal/.test(err.message)
        && /state proposal-stub/.test(err.message)
        && /reason proposal-stub/.test(err.message),
    )
  }
})

test('C1 roster agent validation rejects unavailable primary and fallback cells', () => {
  const register = loadCapabilities({ register: capabilityRegister({ coding_agents: {
    'fixture-unavailable': availabilityFixtureAgent('fixture-unavailable'),
  } }) })
  const probe = {
    exists: (path) => path.endsWith('adapter-fixture-unavailable.mjs') || path.endsWith('adapter-pi.mjs') || path.endsWith('adapter-claude.mjs'),
    which: (binary) => binary === 'fixture-unavailable' ? null : '/fixture/bin/agent',
    home: '/fixture-home',
  }
  const cases = [
    ['tiers.build.builder', { tiers: { build: { builder: { agent: 'fixture-unavailable' } } } }],
    ['tiers.build.builder.fallback[0]', { tiers: { build: { builder: { agent: 'pi', fallback: [{ agent: 'fixture-unavailable' }] } } } }],
    ['assurances.standard.builder', { assurances: { standard: { builder: { agent: 'fixture-unavailable' } } } }],
    ['assurances.standard.builder.fallback[0]', { assurances: { standard: { builder: { agent: 'pi', fallback: [{ agent: 'fixture-unavailable' }] } } } }],
  ]
  for (const [location, roster] of cases) {
    assert.throws(
      () => validateRosterAgents(roster, register, probe),
      (err) => err.reason === 'agent-unavailable'
        && err.state === 'discovered-unavailable'
        && err.availability_reason === 'discovered-unavailable'
        && err.message.includes(`roster cell ${location}`)
        && err.message.includes('fixture-unavailable'),
    )
  }
  assert.throws(
    () => validateRosterAgents({ tiers: { build: { builder: { agent: 'missing-agent' } } } }, register, probe),
    (err) => err.reason === 'agent-unresolved'
      && err.message.includes('roster cell tiers.build.builder')
      && err.message.includes('coding_agents.missing-agent'),
  )
})

test('D1 shipped agent availability follows only the injected probe', () => {
  const register = loadCapabilities()
  const adapterPresent = (path) => path.endsWith('adapter-pi.mjs') || path.endsWith('adapter-claude.mjs')
  for (const agent of ['pi', 'claude']) {
    assert.equal(agentAvailability(register, agent, { exists: adapterPresent, which: () => '/fixture/bin/agent', home: '/empty-home' }).state, 'executable')
    assert.equal(agentAvailability(register, agent, { exists: adapterPresent, which: () => null, home: '/empty-home' }).state, 'discovered-unavailable')
  }
})

test('E1 shipped agent metadata preserves existing boot contracts', () => {
  const raw = JSON.parse(readFileSync(new URL('./capabilities.json', import.meta.url), 'utf8'))
  assert.deepEqual(raw.coding_agents.pi.display_name, 'Pi')
  assert.deepEqual(raw.coding_agents.pi.binary, 'pi')
  assert.deepEqual(raw.coding_agents.pi.install_hint, 'Install Pi and ensure the pi binary is on PATH.')
  assert.deepEqual(raw.coding_agents.claude.display_name, 'Claude Code')
  assert.deepEqual(raw.coding_agents.claude.binary, 'claude')
  assert.deepEqual(raw.coding_agents.claude.install_hint, 'Install Claude Code and ensure the claude binary is on PATH.')
  assert.equal(Object.hasOwn(raw.coding_agents.pi, 'config'), false)
  assert.equal(Object.hasOwn(raw.coding_agents.claude, 'config'), false)
  const register = loadCapabilities({ register: raw })
  for (const agent of ['pi', 'claude']) {
    assert.equal(agentAvailability(register, agent).state, 'executable')
    assert.equal(agentRegisterEntry(register, agent).binary, agent)
  }
})

test('F1A unknown coding agent refuses by closed name', () => {
  assert.throws(
    () => agentRegisterEntry(loadCapabilities(), 'missing', { role: 'builder' }),
    (err) => err.reason === 'agent-unresolved' && /seat builder/.test(err.message) && /coding_agents\.missing/.test(err.message),
  )
})

test('F1O prototype coding agent name refuses by closed name', () => {
  assert.throws(
    () => agentRegisterEntry(loadCapabilities(), 'constructor', { role: 'builder' }),
    (err) => err.reason === 'agent-unresolved' && /constructor/.test(err.message) && /coding_agents\.constructor/.test(err.message),
  )
})

test('F1P unknown coding agent provider refuses by closed name', () => {
  assert.throws(
    () => assertAgentProvider(loadCapabilities(), 'pi', 'google', { role: 'builder' }),
    (err) => err.reason === 'agent-provider-unsupported' && /seat builder/.test(err.message) && /coding_agents\.pi\.providers/.test(err.message),
  )
  assert.doesNotThrow(() => assertAgentProvider(loadCapabilities(), 'pi', 'openai', { role: 'builder' }))
})

function capabilityFixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'crew-capability-'))
  mkdirSync(join(root, 'crew', 'pi', 'skills'), { recursive: true })
  writeFileSync(join(root, 'crew', 'pi', 'fanout.js'), '// extension\n')
  writeFileSync(join(root, 'crew', 'pi', 'skills', 'scout.md'), '# skill\n')
  writeFileSync(join(root, 'crew', 'pi', 'explore.json'), JSON.stringify({ name: 'Explore', prompt: 'scout' }))
  return root
}

function vendorFixtureRoot({
  entries = ['./lib/other.ts', './lib/second.ts'],
  missing = [],
  packageName = '@crew-fixture/pi-thing',
} = {}) {
  const scratch = scratchDir('crew-vendor-')
  const packageDir = join(scratch, 'node_modules', ...packageName.split('/'))
  mkdirSync(join(packageDir, 'lib'), { recursive: true })
  mkdirSync(join(packageDir, 'src'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: packageName, version: '0.0.0', type: 'module', pi: { extensions: entries },
  }, null, 2))
  for (const relative of entries) {
    if (missing.includes(relative)) continue
    const entry = join(packageDir, relative)
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(entry, `// fixture entry ${relative}\n`)
  }
  writeFileSync(join(packageDir, 'src', 'index.ts'), '// decoy entry\n')
  return {
    scratch,
    root: join(scratch, 'node_modules'),
    packageDir,
    entries: entries.map((relative) => join(packageDir, relative)),
    decoy: join(packageDir, 'src', 'index.ts'),
  }
}

function vendorRegister({ role = 'planner', overlay = false, packageName = '@crew-fixture/pi-thing', tools = ['ffgrep', 'fffind'], optional } = {}) {
  const base = capabilityRegister()
  const grant = { package: packageName, tools: [...tools] }
  if (optional !== undefined) grant.optional = optional
  const roleGrant = { ...base.roles[role] }
  if (overlay) roleGrant.by_agent = { pi: { vendor_extensions: [grant] } }
  else roleGrant.vendor_extensions = [grant]
  return capabilityRegister({ roles: { [role]: roleGrant } })
}

test('a grant not present in the register refuses to reach an adapter', () => {
  const crewSource = readFileSync(new URL('./crew.mjs', import.meta.url), 'utf8')
  assert.match(crewSource, /assertGrantsBacked\(role, grants, registry, \{ agent: name \}\)/)
  assert.match(crewSource, /grantsFor\(registry, role, \{ root, exists, agent: name \}\)/)
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

test('the shipped planner pi overlay resolves its checkout-pinned bundle', () => {
  const loaded = loadCapabilities()
  const expected = [
    join(REGISTER_ROOT, 'crew/pi/extensions/subagent.ts'),
    join(REGISTER_ROOT, 'crew/pi/extensions/lab.ts'),
    join(REGISTER_ROOT, 'crew/pi/extensions/readgate.ts'),
  ]
  const grants = grantsFor(loaded, 'planner', { agent: 'pi' })
  assert.deepEqual(grants.extensions, expected)
  for (const path of expected) assert.equal(existsSync(path), true)
  assert.doesNotThrow(() => assertGrantsBacked('planner', grants, loaded, { agent: 'pi' }))
  assert.deepEqual(grants.agents, [{ name: 'scout', def: join(REGISTER_ROOT, 'crew/pi/agents/scout.json') }])
})

test('the shipped register grants lean-build to every role on both agents', () => {
  const loaded = loadCapabilities()
  const expectedSkills = [join(REGISTER_ROOT, 'skills/lean-build/SKILL.md')]
  for (const role of ['lead', 'planner', 'builder', 'reviewer', 'tech-lead']) {
    for (const agent of ['pi', 'claude']) {
      const grants = grantsFor(loaded, role, { agent })
      assert.deepEqual(grants.skills, expectedSkills)
      assert.doesNotThrow(() => assertGrantsBacked(role, grants, loaded, { agent }))
    }
  }
})

test('shipped claude reviewer and lead seats compose their session plugin dir with the granted skill', () => {
  const loaded = loadCapabilities()
  for (const role of ['reviewer', 'lead']) {
    const grants = grantsFor(loaded, role, { agent: 'claude' })
    assert.deepEqual(grants.skills, [join(REGISTER_ROOT, 'skills/lean-build/SKILL.md')])
    assert.doesNotThrow(() => assertGrantsBacked(role, grants, loaded, { agent: 'claude' }))
    const taskDir = scratchDir(`crew-shipped-claude-${role}-`)
    try {
      writeSeatSkills({ taskDir, role, grants })
      const pluginDir = skillsPluginDir({ taskDir, role })
      assert.equal(
        readFileSync(join(pluginDir, 'skills', 'lean-build', 'SKILL.md'), 'utf8'),
        readFileSync(join(REGISTER_ROOT, 'skills/lean-build/SKILL.md'), 'utf8'),
      )
      const command = claudeSeatCommand({
        role, model: 'claude-fable-5', promptFile: join(taskDir, `role-${role}.md`),
        tools: 'Read,Glob,Grep,Bash', deny: 'Edit,NotebookEdit', taskDir, bootBrief: 'boot', grants,
      })
      assert.equal(command.includes(`--plugin-dir "${pluginDir}"`), true)
    } finally {
      rmSync(taskDir, { recursive: true, force: true })
    }
  }
})

test('the shipped builder pi overlay resolves its checkout-pinned extensions', () => {
  const loaded = loadCapabilities()
  const expected = [
    join(REGISTER_ROOT, 'crew/pi/extensions/builderloop.ts'),
    join(REGISTER_ROOT, 'crew/pi/extensions/readgate.ts'),
    join(REGISTER_ROOT, 'crew/pi/extensions/skeletonread.ts'),
    join(REGISTER_ROOT, 'crew/pi/extensions/fff.ts'),
  ]
  const expectedSkills = [join(REGISTER_ROOT, 'skills/lean-build/SKILL.md')]
  const pi = grantsFor(loaded, 'builder', { agent: 'pi' })
  assert.deepEqual(pi.extensions, expected)
  assert.deepEqual(pi.skills, expectedSkills)
  for (const path of [...expected, ...expectedSkills]) assert.equal(existsSync(path), true)
  assert.doesNotThrow(() => assertGrantsBacked('builder', pi, loaded, { agent: 'pi' }))
  const claude = grantsFor(loaded, 'builder', { agent: 'claude' })
  assert.deepEqual(claude.extensions, [])
  assert.deepEqual(claude.skills, expectedSkills)
  assert.doesNotThrow(() => assertGrantsBacked('builder', claude, loaded, { agent: 'claude' }))
  const forged = { ...pi, extensions: [...pi.extensions, join(REGISTER_ROOT, 'crew/pi/extensions/forged.ts')] }
  assert.throws(
    () => assertGrantsBacked('builder', forged, loaded, { agent: 'pi' }),
    (err) => err.reason === 'unknown-grant',
  )
})

test('GR1', () => {
  const loaded = loadCapabilities()
  const skeleton = join(REGISTER_ROOT, 'crew/pi/extensions/skeletonread.ts')
  const builder = grantsFor(loaded, 'builder', { agent: 'pi' })
  assert.ok(builder.extensions.includes(skeleton))
  assert.equal(existsSync(skeleton), true)
  assert.doesNotThrow(() => assertGrantsBacked('builder', builder, loaded, { agent: 'pi' }))
  assert.equal(grantsFor(loaded, 'builder', { agent: 'claude' }).extensions.includes(skeleton), false)
  assert.equal(grantsFor(loaded, 'planner', { agent: 'pi' }).extensions.includes(skeleton), false)
  assert.equal(grantsFor(loaded, 'tech-lead', { agent: 'pi' }).extensions.includes(skeleton), false)
})

test('the shipped tech-lead pi overlay resolves its checkout-pinned read gate only', () => {
  const loaded = loadCapabilities()
  const expected = [join(REGISTER_ROOT, 'crew/pi/extensions/readgate.ts')]
  const pi = grantsFor(loaded, 'tech-lead', { agent: 'pi' })
  assert.deepEqual(pi.extensions, expected)
  assert.equal(existsSync(expected[0]), true)
  assert.doesNotThrow(() => assertGrantsBacked('tech-lead', pi, loaded, { agent: 'pi' }))
  assert.deepEqual(grantsFor(loaded, 'tech-lead', { agent: 'claude' }).extensions, [])
})

test('the read gate is absent from lead and reviewer pi and all claude overlays', () => {
  const loaded = loadCapabilities()
  for (const role of ['lead', 'reviewer']) {
    const pi = grantsFor(loaded, role, { agent: 'pi' })
    assert.equal(pi.extensions.some((path) => path.endsWith('/crew/pi/extensions/readgate.ts')), false)
  }
  for (const role of ['planner', 'builder', 'tech-lead']) {
    const claude = grantsFor(loaded, role, { agent: 'claude' })
    assert.equal(claude.extensions.some((path) => path.endsWith('/crew/pi/extensions/readgate.ts')), false)
  }
})

test('an adapter without an overlay gets exactly the role-level grant', () => {
  const base = capabilityRegister()
  const shipped = loadCapabilities({ register: capabilityRegister({ roles: {
    planner: { ...base.roles.planner, by_agent: { pi: { skills: ['skills/lean-build/SKILL.md'] } } },
  } }) })
  const roleLevel = grantsFor(shipped, 'planner')
  assert.deepEqual(grantsFor(shipped, 'planner', { agent: 'pi' }).skills, [join(REGISTER_ROOT, 'skills/lean-build/SKILL.md')])
  const claude = grantsFor(shipped, 'planner', { agent: 'claude' })
  assert.deepEqual(claude, roleLevel)
  assert.deepEqual(claude.extensions, [])
  assert.deepEqual(claude.agents, [])
  assert.deepEqual(Object.keys(claude), ['tools', 'extensions', 'vendor_extensions', 'vendor_withheld', 'agents', 'skills', 'advisor', 'requires', 'mcp_servers'])
})

test('adapter-scoped grants are backed only when the adapter is named', () => {
  const root = capabilityFixtureRoot()
  try {
    const base = capabilityRegister()
    const register = capabilityRegister({ roles: {
      planner: { ...base.roles.planner, by_agent: {
        pi: { extensions: ['crew/pi/fanout.js'], agents: [{ name: 'Explore', def: 'crew/pi/explore.json' }] },
      } },
    } })
    const grants = grantsFor(register, 'planner', { root, agent: 'pi' })
    assert.doesNotThrow(() => assertGrantsBacked('planner', grants, register, { agent: 'pi' }))
    assert.throws(() => assertGrantsBacked('planner', grants, register), (err) => err.reason === 'unknown-grant')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('adapter-scoped paths fail closed with the same refusal reasons', () => {
  const root = capabilityFixtureRoot()
  try {
    const cases = [
      ['extension-missing', { extensions: ['crew/pi/nope.js'] }],
      ['unknown-skill', { skills: ['crew/pi/skills/nope.md'] }],
      ['agent-def-invalid', { agents: [{ name: 'Explore', def: 'crew/pi/nope.json' }] }],
    ]
    for (const [reason, overlay] of cases) {
      const base = capabilityRegister()
      const register = capabilityRegister({ roles: {
        builder: { ...base.roles.builder, by_agent: { pi: overlay } },
      } })
      assert.throws(() => grantsFor(register, 'builder', { root, agent: 'pi' }), (err) => err.reason === reason)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('overlay schema decisions refuse unknown keys but ignore unknown adapters', () => {
  const shipped = JSON.parse(readFileSync(new URL('./capabilities.json', import.meta.url), 'utf8'))
  for (const key of ['sneaky', 'tools', 'advisor', 'requires']) {
    const bad = JSON.parse(JSON.stringify(shipped))
    bad.roles.planner.by_agent.pi[key] = key === 'sneaky' ? true : []
    assert.throws(() => loadCapabilities({ register: bad }), (err) => err.reason === 'register-invalid')
  }
  const variant = JSON.parse(JSON.stringify(shipped))
  variant.roles.planner.by_agent.zz = { extensions: ['crew/pi/extensions/advisor.ts'] }
  const baseline = loadCapabilities({ register: shipped })
  const unknownAdapter = loadCapabilities({ register: variant })
  for (const agent of ['pi', 'claude']) {
    assert.deepEqual(
      grantsFor(unknownAdapter, 'planner', { agent }),
      grantsFor(baseline, 'planner', { agent }),
    )
  }
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

test('E1 the local provider frozen inventory rejects an unexpected provider', () => {
  const schema = JSON.parse(readFileSync(new URL('./capabilities.schema.json', import.meta.url), 'utf8'))
  const shipped = JSON.parse(readFileSync(new URL('./capabilities.json', import.meta.url), 'utf8'))
  const providers = shipped.local_providers
  assert.deepEqual(Object.keys(providers), ['llama-swap'])
  assert.deepEqual(Object.keys(shipped.narrator).sort(), ['base_url', 'model', 'pi_provider', 'settings'])
  assert.deepEqual(shipped.narrator, {
    settings: 'crew/pi/settings.json',
    pi_provider: 'llama-swap',
    base_url: 'http://10.112.20.20:8080/v1',
    model: 'qwen3.8-27b',
  })
  assert.deepEqual(Object.keys(providers['llama-swap']).sort(), ['base_url', 'pi_provider', 'settings'])
  assert.deepEqual(providers['llama-swap'], {
    settings: 'crew/pi/settings.json',
    pi_provider: 'llama-swap',
    base_url: 'http://10.112.20.20:8080/v1',
  })
  assert.deepEqual(validateCapabilities(schema, shipped), [])

  const settingsPath = join(REGISTER_ROOT, providers['llama-swap'].settings)
  assert.equal(existsSync(settingsPath), true)
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
  assert.equal(settings && typeof settings === 'object' && !Array.isArray(settings), true)
  assert.deepEqual(settings, {})

  for (const field of ['settings', 'pi_provider', 'base_url']) {
    const malformed = JSON.parse(JSON.stringify(shipped))
    delete malformed.local_providers['llama-swap'][field]
    assert.throws(
      () => loadCapabilities({ register: malformed }),
      (err) => err.reason === 'register-invalid',
      `missing local provider field ${field} must refuse`,
    )
  }
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

test('a vendor grant resolves every package-declared entry and reaches the pi command', () => {
  const fixture = vendorFixtureRoot()
  try {
    const register = vendorRegister()
    const grants = grantsFor(loadCapabilities({ register }), 'planner', {
      root: fixture.scratch, vendorRoots: [fixture.root],
    })
    assert.deepEqual(grants.vendor_extensions[0].entries, fixture.entries)
    assert.deepEqual(grants.extensions, fixture.entries)
    assert.equal(grants.extensions.includes(fixture.decoy), false)
    assert.deepEqual(grants.tools, ['ffgrep', 'fffind'])

    const command = piSeatCommand({
      role: 'planner', model: 'sonnet', promptFile: '/tmp/role.md', tools: 'Read', deny: '',
      taskDir: '/tmp', bootBrief: 'boot', grants,
    })
    const activator = command.match(/--tools "([^"]*)"/)?.[1]
    assert.ok(activator?.split(',').includes('ffgrep'))
    assert.ok(activator?.split(',').includes('fffind'))
    for (const builtin of PI_BUILTIN_TOOLS) assert.ok(activator?.split(',').includes(builtin))
    assert.equal(command.includes(fixture.decoy), false)
    assert.match(command, /--no-extensions/)
    const first = command.indexOf(`-e "${fixture.entries[0]}"`)
    const second = command.indexOf(`-e "${fixture.entries[1]}"`)
    assert.ok(first >= 0)
    assert.ok(second > first)
  } finally { rmSync(fixture.scratch, { recursive: true, force: true }) }
})

test('an optional vendor grant whose package is absent boots the seat without those tools', () => {
  const scratch = scratchDir('crew-vendor-optional-absent-')
  try {
    const register = vendorRegister({ role: 'builder', overlay: true, packageName: '@crew-fixture/never-installed', optional: true })
    const grants = grantsFor(loadCapabilities({ register }), 'builder', {
      root: scratch, vendorRoots: [join(scratch, 'node_modules')], agent: 'pi',
    })
    assert.deepEqual(grants.tools, [])
    assert.deepEqual(grants.extensions, [])
    assert.deepEqual(grants.vendor_extensions, [])
    const command = piSeatCommand({
      role: 'builder', model: 'sonnet', promptFile: '/tmp/role-builder.md', tools: 'Read', deny: '',
      taskDir: '/tmp', bootBrief: 'boot', grants,
    })
    assert.match(command, /--no-extensions/)
    assert.doesNotMatch(command, /ffgrep|fffind|never-installed/)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})

test('a withheld optional vendor grant is recorded with its own reason', () => {
  const absent = scratchDir('crew-vendor-optional-record-')
  const fixture = vendorFixtureRoot()
  try {
    const absentRegister = vendorRegister({ role: 'builder', overlay: true, packageName: '@crew-fixture/never-installed', optional: true })
    const absentGrants = grantsFor(loadCapabilities({ register: absentRegister }), 'builder', {
      root: absent, vendorRoots: [join(absent, 'node_modules')], agent: 'pi',
    })
    assert.equal(Object.hasOwn(absentGrants, 'vendor_withheld'), true)
    assert.equal(absentGrants.vendor_withheld.length, 1)
    assert.deepEqual(absentGrants.vendor_withheld[0], {
      package: '@crew-fixture/never-installed', tools: ['ffgrep', 'fffind'],
      reason: 'vendor-extension-missing', detail: absentGrants.vendor_withheld[0].detail,
    })
    assert.match(absentGrants.vendor_withheld[0].detail, /never-installed/)

    const resolvedRegister = vendorRegister({ role: 'builder', overlay: true, optional: true })
    const resolved = grantsFor(loadCapabilities({ register: resolvedRegister }), 'builder', {
      root: fixture.scratch, vendorRoots: [fixture.root], agent: 'pi',
    })
    assert.deepEqual(resolved.vendor_withheld, [])
    assert.deepEqual(EMPTY_GRANTS.vendor_withheld, [])
  } finally {
    rmSync(absent, { recursive: true, force: true })
    rmSync(fixture.scratch, { recursive: true, force: true })
  }
})

test('an optional vendor grant on a partial package withholds and records rather than refusing', () => {
  const fixture = vendorFixtureRoot({ missing: ['./lib/second.ts'] })
  try {
    const register = vendorRegister({ role: 'builder', overlay: true, optional: true })
    const grants = grantsFor(loadCapabilities({ register }), 'builder', {
      root: fixture.scratch, vendorRoots: [fixture.root], agent: 'pi',
    })
    assert.deepEqual(grants.tools, [])
    assert.deepEqual(grants.extensions, [])
    assert.equal(grants.vendor_extensions.length, 0)
    assert.equal(grants.vendor_withheld.length, 1)
    assert.deepEqual(grants.vendor_withheld[0].tools, ['ffgrep', 'fffind'])
    assert.equal(grants.vendor_withheld[0].reason, 'vendor-extension-missing')
    assert.match(grants.vendor_withheld[0].detail, /second\.ts/)
  } finally { rmSync(fixture.scratch, { recursive: true, force: true }) }
})

test('a required vendor grant whose package is absent still refuses', () => {
  const scratch = scratchDir('crew-vendor-required-absent-')
  try {
    for (const optional of [undefined, false]) {
      const options = { role: 'builder', overlay: true, packageName: '@crew-fixture/never-installed' }
      if (optional !== undefined) options.optional = optional
      const register = vendorRegister(options)
      assert.throws(
        () => grantsFor(loadCapabilities({ register }), 'builder', {
          root: scratch, vendorRoots: [join(scratch, 'node_modules')], agent: 'pi',
        }),
        (err) => err.reason === 'vendor-extension-missing',
      )
    }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})

test('an optional vendor grant that resolves composes the same pi bundle', () => {
  const fixture = vendorFixtureRoot()
  try {
    const optional = vendorRegister({ role: 'builder', overlay: true, optional: true })
    const required = vendorRegister({ role: 'builder', overlay: true })
    const resolve = (register) => grantsFor(loadCapabilities({ register }), 'builder', {
      root: fixture.scratch, vendorRoots: [fixture.root], agent: 'pi',
    })
    const optionalGrants = resolve(optional)
    const requiredGrants = resolve(required)
    assert.deepEqual(optionalGrants, requiredGrants)
    assert.deepEqual(optionalGrants.tools, ['ffgrep', 'fffind'])
    assert.deepEqual(optionalGrants.extensions, fixture.entries)
    const command = piSeatCommand({
      role: 'builder', model: 'sonnet', promptFile: '/tmp/role-builder.md', tools: 'Read', deny: '',
      taskDir: '/tmp', bootBrief: 'boot', grants: optionalGrants,
    })
    const activator = command.match(/--tools "([^"]*)"/)?.[1]?.split(',') || []
    assert.ok(activator.includes('ffgrep'))
    assert.ok(activator.includes('fffind'))
    assert.ok(command.indexOf(`-e "${fixture.entries[0]}"`) < command.indexOf(`-e "${fixture.entries[1]}"`))
  } finally { rmSync(fixture.scratch, { recursive: true, force: true }) }
})

test('a pi-scoped optional vendor grant leaves the claude seat at baseline', () => {
  const fixture = vendorFixtureRoot()
  try {
    const scoped = vendorRegister({ role: 'planner', overlay: true, optional: true })
    const baseline = capabilityRegister()
    const options = { root: fixture.scratch, vendorRoots: [fixture.root], agent: 'claude' }
    const scopedGrants = grantsFor(loadCapabilities({ register: scoped }), 'planner', options)
    const baselineGrants = grantsFor(loadCapabilities({ register: baseline }), 'planner', options)
    assert.deepEqual(scopedGrants, baselineGrants)
    const shape = {
      role: 'planner', model: 'opus', promptFile: '/tmp/role-planner.md', tools: 'Read', deny: '',
      taskDir: '/tmp', bootBrief: 'boot',
    }
    assert.equal(
      claudeSeatCommand({ ...shape, grants: scopedGrants }),
      claudeSeatCommand({ ...shape, grants: baselineGrants }),
    )
  } finally { rmSync(fixture.scratch, { recursive: true, force: true }) }
})

test('the schema admits optional as a boolean and nothing else', () => {
  const accepted = vendorRegister({ role: 'builder', overlay: true, optional: true })
  assert.doesNotThrow(() => loadCapabilities({ register: accepted }))
  const nonBoolean = vendorRegister({ role: 'builder', overlay: true, optional: 'yes' })
  assert.throws(() => loadCapabilities({ register: nonBoolean }), (err) => err.reason === 'register-invalid')
  const unknown = vendorRegister({ role: 'builder', overlay: true, optional: true })
  unknown.roles.builder.by_agent.pi.vendor_extensions[0].unexpected = true
  assert.throws(() => loadCapabilities({ register: unknown }), (err) => err.reason === 'register-invalid')
})

test('an optional absent vendor grant passes the grantsFor and assertGrantsBacked boot pair', () => {
  const scratch = scratchDir('crew-vendor-optional-backed-')
  try {
    const register = vendorRegister({ role: 'builder', overlay: true, packageName: '@crew-fixture/never-installed', optional: true })
    const loaded = loadCapabilities({ register })
    const backing = { root: scratch, vendorRoots: [join(scratch, 'node_modules')], agent: 'pi' }
    const grants = grantsFor(loaded, 'builder', backing)
    assert.doesNotThrow(() => assertGrantsBacked('builder', grants, loaded, backing))
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})

test('an uninstalled vendor package refuses by its own reason', () => {
  const scratch = scratchDir('crew-vendor-missing-')
  try {
    const register = vendorRegister({ packageName: '@crew-fixture/never-installed' })
    const loaded = loadCapabilities({ register })
    assert.throws(
      () => grantsFor(loaded, 'planner', { root: scratch, vendorRoots: [join(scratch, 'node_modules')] }),
      (err) => err.reason === 'vendor-extension-missing' && err.reason !== 'extension-missing',
    )
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})

test('vendor grants require at least one tool name at load', () => {
  const complete = vendorRegister({ tools: ['ffgrep'] })
  assert.doesNotThrow(() => loadCapabilities({ register: complete }))
  const empty = vendorRegister({ tools: [] })
  assert.throws(() => loadCapabilities({ register: empty }), (err) => err.reason === 'register-invalid')
})

test('validateCapabilities enforces minItems directly', () => {
  const schema = { type: 'array', minItems: 1, items: { type: 'string' } }
  assert.ok(validateCapabilities(schema, []).length > 0)
  assert.deepEqual(validateCapabilities(schema, ['tool']), [])
})

test('RV1-1 vendor TOOL barrier rejects a forged bundle tool', () => {
  const fixture = vendorFixtureRoot()
  try {
    const register = vendorRegister({ role: 'builder', tools: ['ffgrep', 'fffind'] })
    const loaded = loadCapabilities({ register })
    const backing = { vendorRoots: [fixture.root] }
    const honest = grantsFor(loaded, 'builder', { root: fixture.scratch, vendorRoots: [fixture.root] })
    assert.doesNotThrow(() => assertGrantsBacked('builder', honest, loaded, backing))

    // Skip-sets built from the register's own re-resolution — never the
    // caller's bundle — make each of these four barriers independently true.
    assert.throws(() => assertGrantsBacked('builder', {
      tools: ['ffgrep'], extensions: fixture.entries, agents: [], skills: [], advisor: false, requires: [],
      vendor_extensions: [{ package: '@crew-fixture/not-declared', tools: ['ffgrep'], entries: fixture.entries }],
    }, loaded, backing), (err) => err.reason === 'unknown-grant')

    assert.throws(() => assertGrantsBacked('builder', {
      tools: ['forged-tool'], extensions: fixture.entries, agents: [], skills: [], advisor: false, requires: [],
      vendor_extensions: [{ package: '@crew-fixture/pi-thing', tools: [], entries: fixture.entries }],
    }, loaded, backing), (err) => err.reason === 'unknown-grant' && /forged-tool/.test(err.message))

    // The vendor TOOL barrier on its own: a forged bundle naming a DECLARED
    // package cannot launder an undeclared tool name into the skip-set,
    // because vendorTools is seeded from the register's own re-resolution
    // and only after each supplied name is checked against it.
    assert.throws(() => assertGrantsBacked('builder', {
      tools: ['forged-tool'], extensions: fixture.entries, agents: [], skills: [], advisor: false, requires: [],
      vendor_extensions: [{ package: '@crew-fixture/pi-thing', tools: ['forged-tool'], entries: fixture.entries }],
    }, loaded, backing), (err) => err.reason === 'unknown-grant' && /unregistered vendor tool grant/.test(err.message))

    const laundered = join(fixture.scratch, 'arbitrary', 'evil.ts')
    mkdirSync(dirname(laundered), { recursive: true })
    writeFileSync(laundered, '// exists but is not declared by the package\n')
    assert.throws(() => assertGrantsBacked('builder', {
      tools: ['ffgrep'], extensions: fixture.entries, agents: [], skills: [], advisor: false, requires: [],
      vendor_extensions: [{ package: '@crew-fixture/pi-thing', tools: ['ffgrep'], entries: [...fixture.entries, laundered] }],
    }, loaded, backing), (err) => err.reason === 'unknown-grant' && err.message.includes(laundered))

    assert.throws(() => assertGrantsBacked('builder', {
      tools: ['ffgrep'], extensions: [...fixture.entries, laundered], agents: [], skills: [], advisor: false, requires: [],
      vendor_extensions: [{ package: '@crew-fixture/pi-thing', tools: ['ffgrep'], entries: fixture.entries }],
    }, loaded, backing), (err) => err.reason === 'unknown-grant' && err.message.includes(laundered))
  } finally { rmSync(fixture.scratch, { recursive: true, force: true }) }
})

test('a partial vendor package refuses the missing declared entry', () => {
  const fixture = vendorFixtureRoot({ missing: ['./lib/second.ts'] })
  try {
    const register = vendorRegister()
    assert.throws(
      () => grantsFor(loadCapabilities({ register }), 'planner', { root: fixture.scratch, vendorRoots: [fixture.root] }),
      (err) => err.reason === 'vendor-extension-missing' && err.message.includes(fixture.entries[1]),
    )
  } finally { rmSync(fixture.scratch, { recursive: true, force: true }) }
})

test('vendorRoots uses the explicit, configured, then default precedence arms', () => {
  const explicit = vendorRoots({
    env: { CREW_PI_VENDOR_ROOT: 'relative-vendor-root', PI_CODING_AGENT_DIR: '/configured/pi' },
    home: '/home/operator',
  })
  assert.equal(explicit[0], resolvePath('relative-vendor-root'))
  assert.equal(isAbsolute(explicit[0]), true)

  const configured = vendorRoots({ env: { PI_CODING_AGENT_DIR: '/configured/pi' }, home: '/home/operator' })
  assert.deepEqual(configured, ['/configured/pi/npm/node_modules'])
  assert.equal(isAbsolute(configured[0]), true)

  const fallback = vendorRoots({ env: {}, home: '/home/operator' })
  assert.deepEqual(fallback, ['/home/operator/.pi/agent/npm/node_modules'])
  assert.equal(isAbsolute(fallback[0]), true)
})

test('loadCapabilities refuses duplicate vendor packages at each declaration boundary', () => {
  const base = capabilityRegister()
  const duplicate = { package: '@crew-fixture/pi-thing', tools: ['ffgrep'] }
  const bad = capabilityRegister({ roles: {
    builder: { ...base.roles.builder, vendor_extensions: [duplicate, { ...duplicate, tools: ['fffind'] }] },
  } })
  assert.throws(
    () => loadCapabilities({ register: bad }),
    (err) => err.reason === 'register-invalid' && /@crew-fixture\/pi-thing/.test(err.message) && /roles\.builder/.test(err.message),
  )
  const good = capabilityRegister({ roles: {
    builder: { ...base.roles.builder, vendor_extensions: [duplicate] },
  } })
  assert.doesNotThrow(() => loadCapabilities({ register: good }))
})

test('overlay vendor packages override once, while duplicate overlays refuse and unknown adapters do nothing', () => {
  const base = capabilityRegister()
  const duplicate = { package: '@crew-fixture/pi-thing', tools: ['ffgrep'] }
  const duplicateOverlay = capabilityRegister({ roles: {
    planner: { ...base.roles.planner, by_agent: { pi: { vendor_extensions: [duplicate, duplicate] } } },
  } })
  assert.throws(
    () => loadCapabilities({ register: duplicateOverlay }),
    (err) => err.reason === 'register-invalid' && /roles\.planner\.by_agent\.pi/.test(err.message),
  )

  const fixture = vendorFixtureRoot()
  try {
    const register = capabilityRegister({ roles: {
      planner: {
        ...base.roles.planner,
        vendor_extensions: [{ package: '@crew-fixture/pi-thing', tools: ['base-tool'] }],
        by_agent: {
          pi: { vendor_extensions: [{ package: '@crew-fixture/pi-thing', tools: ['overlay-tool'] }] },
          zz: { vendor_extensions: [{ package: '@crew-fixture/pi-thing', tools: ['unknown-tool'] }] },
        },
      },
    } })
    const loaded = loadCapabilities({ register })
    const pi = grantsFor(loaded, 'planner', { root: fixture.scratch, vendorRoots: [fixture.root], agent: 'pi' })
    assert.deepEqual(pi.vendor_extensions.map((grant) => grant.tools), [['overlay-tool']])
    assert.deepEqual(pi.tools, ['overlay-tool'])
    const claude = grantsFor(loaded, 'planner', { root: fixture.scratch, vendorRoots: [fixture.root], agent: 'claude' })
    assert.deepEqual(claude.vendor_extensions.map((grant) => grant.tools), [['base-tool']])
    assert.deepEqual(claude.tools, ['base-tool'])
  } finally { rmSync(fixture.scratch, { recursive: true, force: true }) }
})

test('vendor extension entries preserve trailing whitespace and reject blank declarations', () => {
  const spaced = vendorFixtureRoot({ entries: ['./lib/spaced.ts '] })
  try {
    const register = vendorRegister()
    const grants = grantsFor(loadCapabilities({ register }), 'planner', {
      root: spaced.scratch, vendorRoots: [spaced.root],
    })
    assert.equal(grants.extensions[0].endsWith('spaced.ts '), true)
  } finally { rmSync(spaced.scratch, { recursive: true, force: true }) }

  const blank = vendorFixtureRoot({ entries: ['   '], missing: ['   '] })
  try {
    assert.throws(
      () => grantsFor(loadCapabilities({ register: vendorRegister() }), 'planner', {
        root: blank.scratch, vendorRoots: [blank.root],
      }),
      (err) => err.reason === 'vendor-extension-missing',
    )
  } finally { rmSync(blank.scratch, { recursive: true, force: true }) }
})

test('claude refuses a vendor grant while pi composes the same resolved grant', () => {
  const fixture = vendorFixtureRoot()
  try {
    const grants = grantsFor(loadCapabilities({ register: vendorRegister({ role: 'builder' }) }), 'builder', {
      root: fixture.scratch, vendorRoots: [fixture.root],
    })
    const shape = {
      role: 'builder', model: 'sonnet', promptFile: '/tmp/role.md', tools: 'Read', deny: '',
      taskDir: '/tmp', bootBrief: 'boot', grants,
    }
    assert.throws(
      () => claudeSeatCommand(shape),
      (err) => err.reason === 'grant-unsupported',
    )
    assert.doesNotThrow(() => piSeatCommand(shape))
  } finally { rmSync(fixture.scratch, { recursive: true, force: true }) }
})

test('capability refusal reasons are closed and EMPTY_GRANTS is frozen', () => {
  assert.equal(Object.isFrozen(CAPABILITY_REFUSALS), true)
  assert.deepEqual([...CAPABILITY_REFUSALS], ['register-invalid', 'capability-shortfall', 'unknown-grant', 'grant-unsupported', 'extension-missing', 'unknown-skill', 'agent-def-invalid', 'local-settings-missing', 'local-provider-undeclared', 'local-endpoint-dead', 'grant-contradicts-deny', 'vendor-extension-missing', 'agent-unresolved', 'agent-provider-unsupported', 'agent-unavailable', 'local-provider-reserved'])
  assert.throws(() => refuse('not-a-capability-reason', 'bad'))
  assert.throws(
    () => claudeSeatCommand({ role: 'builder', model: 'sonnet', promptFile: '/tmp/role.md', tools: 'Read', deny: 'Task,Agent', taskDir: '/tmp', bootBrief: 'boot', grants: { tools: [], extensions: ['/tmp/ext.js'], skills: [], agents: [], advisor: false } }),
    (err) => err.reason === 'grant-unsupported' && /grant-unsupported/.test(err.message),
  )
  assert.deepEqual(EMPTY_GRANTS, { tools: [], extensions: [], vendor_extensions: [], vendor_withheld: [], agents: [], skills: [], advisor: false, requires: [], mcp_servers: [] })
  assert.equal(Object.isFrozen(EMPTY_GRANTS), true)
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

test('every declared capability is classified with a recorded reason', async () => {
  const adapters = readdirSync(join(REGISTER_ROOT, 'crew', 'adapters'))
    .filter((file) => /^adapter-.+\.mjs$/.test(file) && !file.endsWith('.test.mjs'))
    .map((file) => file.slice('adapter-'.length, -'.mjs'.length))
    .sort()
  assert.deepEqual([...CAPABILITY_ADAPTERS].sort(), adapters)

  const shipped = loadCapabilities()
  const declared = declaredCapabilities(shipped)
  assert.deepEqual(declared, ['advisor', 'agents', 'extensions', 'mcp_servers', 'skills', 'subagents@claude', 'subagents@pi', 'vendor_extensions'])
  assert.deepEqual(Object.keys(CAPABILITY_PROBES).sort(), declared)

  const injected = JSON.parse(readFileSync(new URL('./capabilities.json', import.meta.url), 'utf8'))
  injected.roles.builder.requires = ['telemetry']
  const injectedDeclared = declaredCapabilities(injected)
  assert.equal(injectedDeclared.includes('telemetry@claude'), true)
  assert.equal(injectedDeclared.includes('telemetry@pi'), true)
  assert.equal(Object.hasOwn(CAPABILITY_PROBES, 'telemetry@claude'), false)
  assert.equal(Object.hasOwn(CAPABILITY_PROBES, 'telemetry@pi'), false)

  for (const [key, entry] of Object.entries(CAPABILITY_PROBES)) {
    assert.equal(CAPABILITY_CLASSES.includes(entry.class), true)
    assert.equal(typeof entry.reason, 'string')
    assert.equal(entry.reason.trim().length >= 40, true)
    if (key === 'subagents@pi') assert.equal(entry.class, 'probe')
    else assert.notEqual(entry.class, 'probe')
  }

  const advisor = await probeCapability('advisor')
  assert.equal(advisor.probed, false)
  assert.equal(advisor.ok, true)
  assert.equal(advisor.reason, CAPABILITY_PROBES.advisor.reason)
  const claude = await probeCapability('subagents@claude')
  assert.equal(claude.probed, false)
  assert.equal(claude.ok, true)
  assert.equal(claude.reason, CAPABILITY_PROBES['subagents@claude'].reason)
  for (const unknown of ['not-a-declared-capability', 'constructor', 'toString', '__proto__']) {
    await assert.rejects(() => probeCapability(unknown), Error)
  }
})

test('the pi subagents probe exercises the granted fan-out bundle', async () => {
  const hadAgents = Object.hasOwn(process.env, 'CREW_PI_AGENTS')
  const beforeAgents = process.env.CREW_PI_AGENTS
  const result = await probeCapability('subagents@pi')
  assert.deepEqual(result.failures, [])
  assert.equal(result.ok, true)
  assert.equal(result.probed, true)

  const finding = (name) => result.findings.find((one) => one.name === name)
  assert.deepEqual(finding('tool-enum')?.value, ['scout'])
  assert.equal(finding('registered-tool')?.value, PI_FIRST_PARTY_EXTENSION_TOOLS['crew/pi/extensions/subagent.ts'][0])
  const argv = finding('child-args')?.value || []
  assert.equal(argv[argv.indexOf('--tools') + 1], 'read,grep,find,ls')
  assert.equal(argv[argv.indexOf('--exclude-tools') + 1], 'edit,write,bash')
  assert.equal(argv[argv.indexOf('--tools') + 1].includes('edit'), false)
  assert.equal(argv[argv.indexOf('--tools') + 1].includes('write'), false)
  assert.equal(argv[argv.indexOf('--tools') + 1].includes('bash'), false)
  assert.deepEqual(finding('extensions-loaded')?.value, ['subagent.ts', 'lab.ts', 'readgate.ts'])
  assert.equal(Object.hasOwn(process.env, 'CREW_PI_AGENTS'), hadAgents)
  assert.equal(process.env.CREW_PI_AGENTS, beforeAgents)
})

test('the ACP transport profile matches the pane transport shape', () => {
  const profile = ACP_TRANSPORT_PROFILE
  const want = { interjection: 'turn', abort: 'cancel', session_resume: true, durable_cursor: 'protocol', reassign: false }
  assert.deepEqual({ ...profile }, want)
  assert.equal(Object.isFrozen(profile), true)
  const before = profile.abort
  try { profile.abort = 'signal' } catch {}
  assert.equal(profile.abort, before)
  const pane = capabilitiesFor({ transport: 'pane' })
  const transportKeys = ['interjection', 'abort', 'session_resume', 'durable_cursor', 'reassign']
  assert.deepEqual(Object.keys(profile).sort(), Object.keys(pane).filter((key) => transportKeys.includes(key)).sort())
})

test('the pi subagents probe goes red when the register stops being true', async () => {
  const source = readFileSync(new URL('./capabilities.json', import.meta.url), 'utf8')
  const mutatedRegister = (mutate) => {
    const raw = JSON.parse(source)
    mutate(raw)
    return loadCapabilities({ register: raw })
  }

  const missingDefinition = await probeCapability('subagents@pi', {
    register: mutatedRegister((raw) => {
      raw.roles.planner.by_agent.pi.agents = [{ name: 'scout', def: 'crew/pi/agents/nope.json' }]
    }),
  })
  assert.equal(missingDefinition.ok, false)
  assert.equal(missingDefinition.failures.some((failure) => failure.includes('crew/pi/agents/nope.json')), true)

  const wrongName = await probeCapability('subagents@pi', {
    register: mutatedRegister((raw) => {
      raw.roles.planner.by_agent.pi.agents = [{ name: 'wanderer', def: 'crew/pi/agents/scout.json' }]
    }),
  })
  assert.equal(wrongName.ok, false)
  assert.equal(wrongName.failures.length > 0, true)

  const missingExtensions = await probeCapability('subagents@pi', {
    register: mutatedRegister((raw) => { raw.roles.planner.by_agent.pi.extensions = [] }),
  })
  assert.equal(missingExtensions.ok, false)
  assert.equal(missingExtensions.failures.some((failure) => failure.includes('extensions')), true)

  const builderClaim = mutatedRegister((raw) => { raw.roles.builder.requires = ['subagents'] })
  const builderDeclared = declaredCapabilities(builderClaim)
  assert.equal(builderDeclared.includes('subagents@claude'), true)
  assert.equal(builderDeclared.includes('subagents@pi'), true)
  assert.equal(Object.hasOwn(CAPABILITY_PROBES, 'subagents@claude'), true)
  assert.equal(Object.hasOwn(CAPABILITY_PROBES, 'subagents@pi'), true)
  const plannerProbe = await probeCapability('subagents@pi', { register: builderClaim })
  assert.equal(plannerProbe.ok, true)
})

test('B1R coding agent refusals derive from shipped adapters', () => {
  const shipped = loadCapabilities()
  const piPane = piCapabilitiesFor({ transport: 'pane' })
  assert.equal(Object.hasOwn(piPane, 'mcp_servers'), false)
  assert.deepEqual(shipped.coding_agents.pi.refuses, ['mcp_servers'])

  const seat = { role: 'builder', model: 'model', promptFile: '/tmp/role.md', tools: 'Read', deny: '', taskDir: '/tmp', bootBrief: 'boot' }
  const adapterRefusals = []
  for (const [dimension, grants] of [
    ['extensions', { ...EMPTY_GRANTS, extensions: ['/tmp/ext'] }],
    ['local_provider', { ...seat, configDir: '/tmp/config' }],
  ]) {
    try {
      claudeSeatCommand(dimension === 'local_provider' ? grants : { ...seat, grants })
    } catch (err) {
      if (err.reason === 'grant-unsupported') adapterRefusals.push(dimension)
    }
  }
  assert.deepEqual(adapterRefusals, ['extensions', 'local_provider'])
  assert.equal(capabilitiesFor({ transport: 'pane' }).local_provider, false)
  assert.deepEqual(shipped.coding_agents.claude.refuses, adapterRefusals)
  assert.throws(
    () => assertAgentRefusals(shipped, 'claude', adapterRefusals, { role: 'builder' }),
    (err) => err.reason === 'grant-unsupported' && /coding_agents\.claude\.refuses/.test(err.message),
  )
  assert.doesNotThrow(() => assertAgentRefusals(shipped, 'claude', ['skills'], { role: 'builder' }))
})

// A vendor grant carries its OWN tool names and they are backed against the
// package's declared tools, never against the role's list — so repeating a name
// under `tools` grants nothing. It is refused rather than absorbed: the fold in
// grantsFor concatenates, so absorbing it would hand a frozen contract a list
// with duplicates. Both adapters dedupe today, which is exactly why this would
// otherwise stay invisible until a consumer counted instead of setting.
test('a vendor tool also listed under tools is refused as a redundant declaration', () => {
  const fixture = vendorFixtureRoot()

  // MUTATION: drop the duplicate check in grantsFor and this returns
  // ['ffgrep','fffind','ffgrep','fffind'] instead of refusing.
  const doubled = vendorRegister({ role: 'builder' })
  doubled.roles.builder.tools = ['ffgrep', 'fffind']
  assert.throws(
    () => grantsFor(loadCapabilities({ register: doubled }), 'builder', { root: fixture.scratch, vendorRoots: [fixture.root], agent: 'pi' }),
    (err) => err.reason === 'unknown-grant' && /also lists it under tools/.test(err.message),
  )

  // One duplicate is enough; the rest of the list is irrelevant to the refusal.
  const one = vendorRegister({ role: 'builder' })
  one.roles.builder.tools = ['fffind']
  assert.throws(() => grantsFor(loadCapabilities({ register: one }), 'builder', { root: fixture.scratch, vendorRoots: [fixture.root], agent: 'pi' }), (err) => err.reason === 'unknown-grant')

  // MUTATION: make the check refuse any non-empty tools list and this fails —
  // an unrelated role tool beside a vendor grant is legitimate and composes.
  const beside = vendorRegister({ role: 'builder' })
  beside.roles.builder.tools = ['Task']
  assert.deepEqual(grantsFor(loadCapabilities({ register: beside }), 'builder', { root: fixture.scratch, vendorRoots: [fixture.root], agent: 'pi' }).tools, ['Task', 'ffgrep', 'fffind'])

  // MUTATION R1: an absent optional package must still refuse a duplicate tool.
  const absent = scratchDir('crew-vendor-duplicate-absent-')
  try {
    const absentRegister = vendorRegister({ role: 'builder', overlay: true, optional: true })
    absentRegister.roles.builder.tools = ['ffgrep']
    assert.throws(
      () => grantsFor(loadCapabilities({ register: absentRegister }), 'builder', {
        root: absent, vendorRoots: [join(absent, 'node_modules')], agent: 'pi',
      }),
      (err) => err.reason === 'unknown-grant' && /also lists it under tools/.test(err.message),
    )
  } finally { rmSync(absent, { recursive: true, force: true }) }

  // The ordinary vendor-only grant is unchanged and carries no duplicate.
  const plain = vendorRegister({ role: 'builder' })
  assert.deepEqual(grantsFor(loadCapabilities({ register: plain }), 'builder', { root: fixture.scratch, vendorRoots: [fixture.root], agent: 'pi' }).tools, ['ffgrep', 'fffind'])
})

test('unexpected root capability declarations remain closed outside seatability checks', () => {
  const schema = JSON.parse(readFileSync(new URL('./capabilities.schema.json', import.meta.url), 'utf8'))
  const entry = {
    settings: 'crew/pi/settings.json', pi_provider: 'local-pi',
    base_url: 'http://127.0.0.1:11434/v1', model: 'Qwen/Qwen3-Coder:latest',
  }
  const invalid = capabilityRegister({ narrator: entry, unexpected_root: entry })
  assert.ok(validateCapabilities(schema, invalid).length > 0)
  assert.throws(() => loadCapabilities({ register: invalid }), (err) => err.reason === 'register-invalid')
})

test('F1 narrator model description and command share the measured streaming policy', () => {
  const schema = JSON.parse(readFileSync(new URL('./capabilities.schema.json', import.meta.url), 'utf8'))
  const description = schema.$defs.localprovider.properties.model.description
  assert.deepEqual({ connect: NARRATION_CONNECT_TIMEOUT_SECONDS, minimum: NARRATION_MIN_BYTES_PER_SECOND, stall: NARRATION_STALL_SECONDS, backstop: NARRATION_BACKSTOP_SECONDS }, {
    connect: 10, minimum: 1, stall: 60, backstop: 300,
  })
  for (const phrase of [
    /streams completion progress/, /1 byte per second/, /60 seconds/, /10-second connection timeout/, /300-second absolute backstop/,
    /28\.345s/, /29\.305s/, /6\.6s/, /12\.6s/, /35\.2s warm \/ 44\.0s cold/, /continued progress rather than total duration governs acceptance/,
  ]) assert.match(description, phrase)
  assert.doesNotMatch(description, /30-second wall|cold model loading occurs inside it/)
  const command = narratorCommand({ root: 'http://127.0.0.1:11434/v1', model: 'qwen3.8-27b', prompt: 'hello' })
  for (const [flag, value] of [['--connect-timeout', NARRATION_CONNECT_TIMEOUT_SECONDS], ['--speed-limit', NARRATION_MIN_BYTES_PER_SECOND], ['--speed-time', NARRATION_STALL_SECONDS], ['--max-time', NARRATION_BACKSTOP_SECONDS]]) {
    assert.match(command, new RegExp(`${flag} ${value}(?:\\s|$)`))
  }
  assert.match(command, /"stream":true/)
})

test('G1 local provider schema remains closed', () => {
  const schema = JSON.parse(readFileSync(new URL('./capabilities.schema.json', import.meta.url), 'utf8'))
  const localProviderRef = schema.properties.local_providers.patternProperties['^[a-z0-9-]+$']
  const localProvider = schema.$defs.localprovider
  const expectedRef = { $ref: '#/$defs/localprovider' }
  assert.deepEqual(localProviderRef, expectedRef)
  assert.deepEqual(schema.properties.narrator, expectedRef)
  const entry = {
    settings: 'crew/pi/settings.json', pi_provider: 'local-pi',
    base_url: 'http://127.0.0.1:11434/v1', model: 'Qwen/Qwen3-Coder:latest',
  }
  const narratorRegister = capabilityRegister({ narrator: entry })
  const seatRegister = capabilityRegister({ local_providers: { 'generic-seat': entry } })
  assert.equal(localProvider.additionalProperties, false)
  assert.deepEqual(validateCapabilities(schema, narratorRegister), [])
  assert.deepEqual(validateCapabilities(schema, seatRegister), [])
  assert.doesNotThrow(() => loadCapabilities({ register: narratorRegister }))
  assert.doesNotThrow(() => loadCapabilities({ register: seatRegister }))

  const invalidNarrator = structuredClone(narratorRegister)
  invalidNarrator.narrator.unexpected = true
  assert.ok(validateCapabilities(schema, invalidNarrator).length > 0)
  assert.throws(() => loadCapabilities({ register: invalidNarrator }), (err) => err.reason === 'register-invalid')
  const invalidSeat = structuredClone(seatRegister)
  invalidSeat.local_providers['generic-seat'].unexpected = true
  assert.ok(validateCapabilities(schema, invalidSeat).length > 0)
  assert.throws(() => loadCapabilities({ register: invalidSeat }), (err) => err.reason === 'register-invalid')
})

test('G2 local provider schema still requires settings pi_provider and base_url', () => {
  const schema = JSON.parse(readFileSync(new URL('./capabilities.schema.json', import.meta.url), 'utf8'))
  const localProvider = schema.$defs.localprovider
  assert.deepEqual(localProvider.required, ['settings', 'pi_provider', 'base_url'])
  assert.equal(localProvider.properties.model.type, 'string')

  const baseEntry = {
    settings: 'crew/pi/settings.json', pi_provider: 'local-pi',
    base_url: 'http://127.0.0.1:11434/v1', model: 'Qwen/Qwen3-Coder:latest',
  }
  const registerFor = (entry) => capabilityRegister({ narrator: entry })
  const complete = registerFor(baseEntry)
  assert.deepEqual(validateCapabilities(schema, complete), [])
  assert.doesNotThrow(() => loadCapabilities({ register: complete }))
  const genericSeat = capabilityRegister({ local_providers: { 'generic-seat': baseEntry } })
  assert.deepEqual(validateCapabilities(schema, genericSeat), [])
  assert.doesNotThrow(() => loadCapabilities({ register: genericSeat }))

  for (const field of ['settings', 'pi_provider', 'base_url']) {
    const malformed = structuredClone(complete)
    delete malformed.narrator[field]
    assert.ok(validateCapabilities(schema, malformed).length > 0, `missing ${field} must fail validation`)
    assert.throws(() => loadCapabilities({ register: malformed }), (err) => err.reason === 'register-invalid', `missing ${field} must refuse at load`)
  }

  for (const model of ['A', 'Z'.repeat(128), 'A/B:C_1-2.3']) {
    const valid = registerFor({ ...baseEntry, model })
    assert.deepEqual(validateCapabilities(schema, valid), [], `safe model ${model}`)
    assert.doesNotThrow(() => loadCapabilities({ register: valid }), `safe model ${model}`)
  }
  for (const model of [null, '', '!model', ' model', 'model;echo pwn', 'm' + 'a'.repeat(128)]) {
    const invalid = registerFor({ ...baseEntry, model })
    assert.ok(validateCapabilities(schema, invalid).length > 0, `unsafe model ${JSON.stringify(model)} must fail validation`)
    assert.throws(() => loadCapabilities({ register: invalid }), (err) => err.reason === 'register-invalid', `unsafe model ${JSON.stringify(model)} must refuse`)
  }

  const absent = registerFor({ ...baseEntry })
  delete absent.narrator.model
  assert.deepEqual(validateCapabilities(schema, absent), [])
})
