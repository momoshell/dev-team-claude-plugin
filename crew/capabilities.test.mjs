import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, dirname, resolve as resolvePath } from 'node:path'
import {
  CAPABILITY_ADAPTERS, CAPABILITY_CLASSES, CAPABILITY_DELIVERY, CAPABILITY_PROBES,
  CAPABILITY_REFUSALS, EMPTY_GRANTS, REGISTER_ROOT, ACP_TRANSPORT_PROFILE, assertGrantsBacked,
  declaredCapabilities, effectiveCapabilities, grantsFor, loadCapabilities, probeCapability,
  refuse, validateCapabilities, vendorRoots,
} from './capabilities.mjs'
import { seatCommand as claudeSeatCommand, capabilitiesFor } from './adapters/adapter-claude.mjs'
import { seatCommand as piSeatCommand, capabilitiesFor as piCapabilitiesFor, PI_SUBAGENT_TOOL, PI_BUILTIN_TOOLS } from './adapters/adapter-pi.mjs'
import { scratchDir } from '../test/helpers.mjs'

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

function vendorRegister({ role = 'planner', overlay = false, packageName = '@crew-fixture/pi-thing', tools = ['ffgrep', 'fffind'] } = {}) {
  const base = capabilityRegister()
  const grant = { package: packageName, tools: [...tools] }
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
  assert.deepEqual(Object.keys(claude), ['tools', 'extensions', 'vendor_extensions', 'agents', 'skills', 'advisor', 'requires'])
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
  assert.deepEqual([...CAPABILITY_REFUSALS], ['register-invalid', 'capability-shortfall', 'unknown-grant', 'grant-unsupported', 'extension-missing', 'unknown-skill', 'agent-def-invalid', 'local-settings-missing', 'local-endpoint-dead', 'grant-contradicts-deny', 'vendor-extension-missing'])
  assert.throws(() => refuse('not-a-capability-reason', 'bad'))
  assert.throws(
    () => claudeSeatCommand({ role: 'builder', model: 'sonnet', promptFile: '/tmp/role.md', tools: 'Read', deny: 'Task,Agent', taskDir: '/tmp', bootBrief: 'boot', grants: { tools: [], extensions: ['/tmp/ext.js'], skills: [], agents: [], advisor: false } }),
    (err) => err.reason === 'grant-unsupported' && /grant-unsupported/.test(err.message),
  )
  assert.deepEqual(EMPTY_GRANTS, { tools: [], extensions: [], vendor_extensions: [], agents: [], skills: [], advisor: false, requires: [] })
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
  assert.deepEqual(declared, ['advisor', 'agents', 'extensions', 'skills', 'subagents@claude', 'subagents@pi', 'vendor_extensions'])
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
