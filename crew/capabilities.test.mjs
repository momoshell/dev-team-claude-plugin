import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CAPABILITY_ADAPTERS, CAPABILITY_CLASSES, CAPABILITY_DELIVERY, CAPABILITY_PROBES,
  CAPABILITY_REFUSALS, EMPTY_GRANTS, REGISTER_ROOT, assertGrantsBacked,
  declaredCapabilities, effectiveCapabilities, grantsFor, loadCapabilities, probeCapability,
  refuse, validateCapabilities,
} from './capabilities.mjs'
import { seatCommand, capabilitiesFor } from './adapters/adapter-claude.mjs'
import { capabilitiesFor as piCapabilitiesFor, PI_SUBAGENT_TOOL } from './adapters/adapter-pi.mjs'

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
  const grants = grantsFor(loadCapabilities(), 'planner', { agent: 'pi' })
  assert.deepEqual(grants.extensions, [
    join(REGISTER_ROOT, 'crew/pi/extensions/subagent.ts'),
    join(REGISTER_ROOT, 'crew/pi/extensions/lab.ts'),
  ])
  assert.deepEqual(grants.agents, [{ name: 'scout', def: join(REGISTER_ROOT, 'crew/pi/agents/scout.json') }])
})

test('an adapter without an overlay gets exactly the role-level grant', () => {
  const shipped = loadCapabilities()
  const roleLevel = grantsFor(shipped, 'planner')
  const claude = grantsFor(shipped, 'planner', { agent: 'claude' })
  assert.deepEqual(claude, roleLevel)
  assert.deepEqual(claude.extensions, [])
  assert.deepEqual(claude.agents, [])
  assert.deepEqual(Object.keys(claude), ['tools', 'extensions', 'agents', 'skills', 'advisor', 'requires'])
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
  assert.deepEqual([...CAPABILITY_REFUSALS], ['register-invalid', 'capability-shortfall', 'unknown-grant', 'grant-unsupported', 'extension-missing', 'unknown-skill', 'agent-def-invalid', 'local-settings-missing', 'local-endpoint-dead', 'grant-contradicts-deny'])
  assert.throws(() => refuse('not-a-capability-reason', 'bad'))
  assert.throws(
    () => seatCommand({ role: 'builder', model: 'sonnet', promptFile: '/tmp/role.md', tools: 'Read', deny: 'Task,Agent', taskDir: '/tmp', bootBrief: 'boot', grants: { tools: [], extensions: ['/tmp/ext.js'], skills: [], agents: [], advisor: false } }),
    (err) => err.reason === 'grant-unsupported' && /grant-unsupported/.test(err.message),
  )
  assert.deepEqual(EMPTY_GRANTS, { tools: [], extensions: [], agents: [], skills: [], advisor: false, requires: [] })
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
  assert.deepEqual(declared, ['advisor', 'agents', 'extensions', 'skills', 'subagents@claude', 'subagents@pi'])
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
  assert.equal(finding('registered-tool')?.value, PI_SUBAGENT_TOOL)
  const argv = finding('child-args')?.value || []
  assert.equal(argv[argv.indexOf('--tools') + 1], 'read,grep,find,ls')
  assert.equal(argv[argv.indexOf('--exclude-tools') + 1], 'edit,write,bash')
  assert.equal(argv[argv.indexOf('--tools') + 1].includes('edit'), false)
  assert.equal(argv[argv.indexOf('--tools') + 1].includes('write'), false)
  assert.equal(argv[argv.indexOf('--tools') + 1].includes('bash'), false)
  assert.deepEqual(finding('extensions-loaded')?.value, ['subagent.ts', 'lab.ts'])
  assert.equal(Object.hasOwn(process.env, 'CREW_PI_AGENTS'), hadAgents)
  assert.equal(process.env.CREW_PI_AGENTS, beforeAgents)
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
