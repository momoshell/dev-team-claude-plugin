import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CAPABILITY_DELIVERY, CAPABILITY_REFUSALS, EMPTY_GRANTS, REGISTER_ROOT, assertGrantsBacked,
  effectiveCapabilities, grantsFor, loadCapabilities, refuse, validateCapabilities,
} from './capabilities.mjs'
import { seatCommand, capabilitiesFor } from './adapters/adapter-claude.mjs'
import { capabilitiesFor as piCapabilitiesFor } from './adapters/adapter-pi.mjs'

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
