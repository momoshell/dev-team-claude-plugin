import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync as fsMkdirSync, readFileSync, renameSync as fsRenameSync, rmSync, unlinkSync as fsUnlinkSync, writeFileSync as fsWriteFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_AVAILABILITY_STATE_PATH, main, probeReport, renderReadout } from '../scripts/factory/agent-doctor.mjs'
import { agentAvailability, loadCapabilities } from '../crew/capabilities.mjs'
import { createAgentsSource } from '../visualizer/server/agents-source.mjs'
import { ROOT, scratchDir } from './helpers.mjs'

const SCRATCH_HOME = process.env.CREW_AGENT_DOCTOR_TEST_HOME || scratchDir('factory-agent-doctor-home-')
const FIXED_NOW = Date.parse('2026-09-15T12:00:00.000Z')

function missing(message = 'missing') {
  const error = new Error(message)
  error.code = 'ENOENT'
  return error
}

function fixtureEntry(name, { transports = ['pane'], config, binary = `${name}-binary` } = {}) {
  return {
    providers: ['fixture'],
    transports,
    adapter: `crew/adapters/adapter-${name}.mjs`,
    refuses: [],
    display_name: name,
    binary,
    install_hint: `Install ${name}.`,
    availability: 'executable',
    availability_reason: 'executable',
    ...(config ? { config } : {}),
  }
}

function fixtureRegister(names) {
  const coding_agents = {}
  for (const [name, options] of names) coding_agents[name] = fixtureEntry(name, options)
  const grant = () => ({ tools: [], extensions: [], agents: [], skills: [], advisor: false, requires: [], mcp_servers: [] })
  return {
    schema_version: 1,
    updated_at: '2026-09-15',
    coding_agents,
    roles: { lead: grant(), planner: grant(), builder: grant(), reviewer: grant(), 'tech-lead': grant() },
    local_providers: {},
  }
}

function adapterName(url) {
  return String(url).split('/').pop().replace(/^adapter-/, '').replace(/\.mjs$/, '')
}

function doctorDeps(register, {
  which = () => '/fixture/bin/agent',
  spawn = () => ({ status: 0, signal: null, error: null, stdout: 'fixture 1.0\n' }),
  importAdapter = async () => ({ capabilitiesFor: () => ({}) }),
  readFile = async () => { throw missing() },
  home = () => SCRATCH_HOME,
  now = () => FIXED_NOW,
  stdout = () => {},
  stderr = () => {},
  ...extra
} = {}) {
  return {
    register, which, spawn, importAdapter, readFile, home, now, stdout, stderr, ...extra,
  }
}

function resultMap(results) {
  return Object.fromEntries(results.map((result) => [result.agent, result]))
}

test('A1 doctor probes every registered agent, transport, state, and closed reason', async () => {
  const register = fixtureRegister([
    ['stub', { transports: ['pane', 'headless-rpc'] }],
    ['import', { transports: ['pane'] }],
    ['which', { transports: ['pane'] }],
    ['spawn', { transports: ['pane'] }],
    ['interrupt', { transports: ['pane'] }],
    ['shim', { transports: ['pane'] }],
    ['config', { transports: ['pane'], config: ['~/fixture-config.json'] }],
    ['transport', { transports: ['pane', 'headless-rpc'] }],
    ['executable', { transports: ['pane', 'headless-rpc'] }],
  ])
  const adapterCalls = []
  const whichCalls = []
  const spawnCalls = []
  const readCalls = []
  const deps = doctorDeps(register, {
    which: (binary) => {
      whichCalls.push(binary)
      return binary === 'which-binary' ? null : `/fixture/bin/${binary}`
    },
    spawn: (binary, args) => {
      spawnCalls.push({ binary, args })
      if (binary.endsWith('/spawn-binary')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      if (binary.endsWith('/interrupt-binary')) return { status: null, signal: 'SIGTERM', error: null, stdout: '' }
      if (binary.endsWith('/shim-binary')) return { status: 1, signal: null, error: null, stdout: 'shim\n' }
      if (binary.endsWith('/config-binary')) return { status: 0, signal: null, error: null, stdout: '' }
      if (binary.endsWith('/transport-binary')) return { status: 0, signal: null, error: null, stdout: 'transport 1.0\n' }
      if (binary.endsWith('/executable-binary')) return { status: 0, signal: null, error: null, stdout: '  executable 2.4.6  \nsecond line\n' }
      return { status: 0, signal: null, error: null, stdout: 'fixture 1.0\n' }
    },
    importAdapter: async (url) => {
      const name = adapterName(url)
      adapterCalls.push(name)
      if (name === 'stub') throw Object.assign(new Error('adapter absent'), { code: 'ERR_MODULE_NOT_FOUND' })
      if (name === 'import') throw Object.assign(new Error('adapter syntax failure'), { code: 'ERR_BAD_MODULE' })
      return {
        capabilitiesFor: ({ transport }) => {
          if (name === 'transport' && transport === 'headless-rpc') throw new Error('transport refused')
          return { transport }
        },
      }
    },
    readFile: async (path) => {
      readCalls.push(path)
      throw missing()
    },
  })
  const probed = await probeReport(register, deps)
  const byAgent = resultMap(probed.results)
  assert.deepEqual(probed.results.map(({ agent }) => agent), Object.keys(register.coding_agents))
  assert.deepEqual(Object.fromEntries(probed.results.map(({ agent, state, reason }) => [agent, { state, reason }])), {
    stub: { state: 'proposal-stub', reason: 'proposal-stub' },
    import: { state: 'proposal-stub', reason: 'adapter-import-failed' },
    which: { state: 'discovered-unavailable', reason: 'discovered-unavailable' },
    spawn: { state: 'discovered-unavailable', reason: 'version-spawn-failed' },
    interrupt: { state: 'discovered-unavailable', reason: 'version-interrupted' },
    shim: { state: 'discovered-unavailable', reason: 'shim-not-binary' },
    config: { state: 'installed-unconfigured', reason: 'installed-unconfigured' },
    transport: { state: 'installed-unconfigured', reason: 'transport-refused' },
    executable: { state: 'executable', reason: 'executable' },
  })
  assert.equal(byAgent.executable.version, 'executable 2.4.6')
  assert.equal(byAgent.config.version, null)
  assert.equal(adapterCalls.length, 9)
  assert.deepEqual(whichCalls, Object.values(register.coding_agents).map(({ binary }) => binary))
  assert.equal(spawnCalls.length, 8)
  assert.ok(spawnCalls.every(({ args }) => args.length === 1 && args[0] === '--version'))
  assert.deepEqual(byAgent.transport.transports, { pane: 'ok', 'headless-rpc': 'refused' })
  for (const result of probed.results) {
    assert.deepEqual(Object.keys(result.transports), register.coding_agents[result.agent].transports)
    assert.deepEqual(Object.keys(result), ['agent', 'state', 'reason', 'binary', 'version', 'transports'])
  }
  assert.deepEqual(Object.keys(probed.value), ['schema_version', 'probed_at', 'agents'])
  assert.equal(probed.value.probed_at, '2026-09-15T12:00:00.000Z')
  assert.deepEqual(Object.keys(probed.value.agents), Object.keys(register.coding_agents))
  assert.match(probed.proposedText, /"schema_version": 1/)
  assert.equal(probed.proposedText.endsWith('\n'), true)
  assert.equal(AGENT_AVAILABILITY_STATE_PATH(), join(ROOT, 'crew', 'capabilities.json'))
  assert.equal(readCalls.length, 1)
})

test('A1 doctor persists availability in the capability register consumed by boot and visualizer', async () => {
  assert.equal(AGENT_AVAILABILITY_STATE_PATH(), join(ROOT, 'crew', 'capabilities.json'))
  const root = scratchDir('factory-agent-doctor-register-')
  const checkout = join(root, 'checkout')
  const home = join(root, 'home')
  const statePath = join(checkout, 'crew', 'capabilities.json')
  const target = fixtureRegister([['target', { transports: ['pane'], config: ['~/target-config.json'], binary: 'target-binary' }]])
  fsMkdirSync(join(checkout, 'crew'), { recursive: true })
  fsWriteFileSync(statePath, `${JSON.stringify(target, null, 2)}\n`)
  const injected = fixtureRegister([['injected', { transports: ['pane'], binary: 'injected-binary', config: ['~/injected-config.json'] }]])
  const calls = { which: [], spawn: [], imports: [], reads: [], write: 0, rename: 0 }
  const stdout = []
  const stderr = []
  try {
    const code = await main(['--write', '--state', statePath], doctorDeps(injected, {
      home: () => home,
      readFile: async (path, encoding) => {
        calls.reads.push(path)
        if (path === statePath) return readFileSync(path, encoding)
        throw missing()
      },
      which: (binary) => {
        calls.which.push(binary)
        return binary === 'target-binary' ? '/fixture/target-binary' : null
      },
      spawn: (binary, args) => {
        calls.spawn.push({ binary, args })
        throw Object.assign(new Error('version probe denied'), { code: 'EPERM' })
      },
      importAdapter: async (url) => {
        calls.imports.push(url)
        return { capabilitiesFor: () => ({}) }
      },
      stdout: (value) => stdout.push(String(value)),
      stderr: (value) => stderr.push(String(value)),
      writeFileSync: (path, value, options) => { calls.write += 1; return fsWriteFileSync(path, value, options) },
      renameSync: (from, to) => { calls.rename += 1; return fsRenameSync(from, to) },
    }))
    assert.equal(code, 0)
    assert.deepEqual(calls.which, ['target-binary'])
    assert.deepEqual(calls.spawn, [{ binary: '/fixture/target-binary', args: ['--version'] }])
    assert.equal(calls.imports.length, 1)
    assert.match(calls.imports[0], /adapter-target\.mjs$/)
    assert.ok(calls.reads.includes(statePath))
    assert.ok(calls.reads.includes(join(home, 'target-config.json')))
    assert.equal(calls.write, 1)
    assert.equal(calls.rename, 1)
    assert.deepEqual(stderr, [])
    assert.match(stdout.join(''), /1 agents probed, 0 executable, 1 unavailable/)

    const before = target.coding_agents.target
    const persisted = JSON.parse(readFileSync(statePath, 'utf8'))
    const after = persisted.coding_agents.target
    assert.equal(after.availability, 'discovered-unavailable')
    assert.equal(after.availability_reason, 'version-spawn-failed')
    for (const key of ['providers', 'transports', 'adapter', 'refuses', 'display_name', 'binary', 'install_hint', 'config']) {
      assert.deepEqual(after[key], before[key], key)
    }

    const loaded = loadCapabilities({ path: statePath })
    assert.deepEqual(
      { state: agentAvailability(loaded, 'target').state, reason: agentAvailability(loaded, 'target').reason },
      { state: 'discovered-unavailable', reason: 'version-spawn-failed' },
    )
    const view = createAgentsSource({ checkout }).read()
    const visualizerAgent = view.agents.find((agent) => agent.name === 'target')
    assert.equal(visualizerAgent.availability.value, 'discovered-unavailable')
    assert.equal(visualizerAgent.install_hint.value, 'Install target.')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TL5 doctor validates exactly one selected target snapshot', async () => {
  const root = scratchDir('factory-agent-doctor-one-snapshot-')
  const statePath = join(root, 'capabilities.json')
  const target = fixtureRegister([['snapshot', { transports: ['pane'] }]])
  const reads = []
  const stderr = []
  try {
    const code = await main(['--write', '--state', statePath], doctorDeps(fixtureRegister([['injected', { transports: ['pane'] }]]), {
      readFile: async (path) => {
        reads.push(path)
        if (path === statePath) return `${JSON.stringify(target, null, 2)}\n`
        throw missing(`unexpected read ${path}`)
      },
      which: () => '/fixture/snapshot-binary',
      spawn: () => ({ status: 0, signal: null, error: null, stdout: 'snapshot 1.0\n' }),
      importAdapter: async () => ({ capabilitiesFor: () => ({}) }),
      mkdirSync: () => {},
      writeFileSync: () => {},
      renameSync: () => {},
      unlinkSync: () => {},
      stdout: () => {},
      stderr: (value) => stderr.push(String(value)),
    }))
    assert.equal(code, 0)
    assert.deepEqual(reads, [statePath])
    assert.deepEqual(stderr, [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('A1 doctor refuses a parseable schema-invalid register before probing or writing', async () => {
  const root = scratchDir('factory-agent-doctor-invalid-register-')
  const statePath = join(root, 'capabilities.json')
  const target = fixtureRegister([['target', { transports: ['pane'] }]])
  target.coding_agents.target.availability_reason = 'transport-refused'
  const old = `${JSON.stringify(target, null, 2)}\n`
  fsWriteFileSync(statePath, old)
  const calls = { probe: 0, write: 0, rename: 0 }
  const stderr = []
  try {
    const code = await main(['--write', '--state', statePath], doctorDeps(fixtureRegister([['injected', { transports: ['pane'] }]]), {
      readFile: async (path, encoding) => readFileSync(path, encoding),
      which: () => { calls.probe += 1; return '/fixture/agent' },
      spawn: () => { calls.probe += 1; return { status: 0, signal: null, error: null, stdout: 'ok\\n' } },
      importAdapter: async () => { calls.probe += 1; return { capabilitiesFor: () => ({}) } },
      writeFileSync: () => { calls.write += 1 },
      renameSync: () => { calls.rename += 1 },
      stderr: (value) => stderr.push(String(value)),
    }))
    assert.equal(code, 2)
    assert.match(stderr.join(''), /\[reason: state-read-failed\]/)
    assert.deepEqual(calls, { probe: 0, write: 0, rename: 0 })
    assert.equal(readFileSync(statePath, 'utf8'), old)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('B1 a resolved shim whose version exits nonzero is unavailable, never executable', async () => {
  const register = fixtureRegister([['shim', { transports: ['pane'] }]])
  const probed = await probeReport(register, doctorDeps(register, {
    which: () => '/fixture/bin/shim-binary',
    spawn: () => ({ status: 7, signal: null, error: null, stdout: 'not a binary\n' }),
  }))
  assert.deepEqual(probed.results[0], {
    agent: 'shim', state: 'discovered-unavailable', reason: 'shim-not-binary',
    binary: '/fixture/bin/shim-binary', version: null, transports: { pane: 'ok' },
  })
  assert.notEqual(probed.results[0].state, 'executable')
})

test('C1 default and --write modes print and persist proposals atomically', async () => {
  const register = fixtureRegister([['executable', { transports: ['pane'] }]])
  register.coding_agents.executable.availability = 'discovered-unavailable'
  register.coding_agents.executable.availability_reason = 'discovered-unavailable'
  const statePath = join(SCRATCH_HOME, 'agent-doctor-state', 'capabilities.json')
  fsMkdirSync(join(SCRATCH_HOME, 'agent-doctor-state'), { recursive: true })
  fsWriteFileSync(statePath, `${JSON.stringify(register, null, 2)}\n`)
  const calls = { write: 0, mkdir: 0, rename: 0, unlink: 0 }
  const stdout = []
  const stderr = []
  const deps = doctorDeps(register, {
    home: () => SCRATCH_HOME,
    readFile: async (path, encoding) => readFileSync(path, encoding),
    stdout: (value) => stdout.push(String(value)),
    stderr: (value) => stderr.push(String(value)),
    writeFileSync: (path, value, options) => { calls.write += 1; return fsWriteFileSync(path, value, options) },
    mkdirSync: (path, options) => { calls.mkdir += 1; return fsMkdirSync(path, options) },
    renameSync: (from, to) => { calls.rename += 1; return fsRenameSync(from, to) },
    unlinkSync: (path) => { calls.unlink += 1; return fsUnlinkSync(path) },
  })
  assert.equal(await main(['--unknown'], deps), 2)
  assert.equal(await main(['--state'], deps), 2)
  assert.equal(await main(['operand'], deps), 2)
  stderr.length = 0
  assert.equal(await main([], deps), 0)
  assert.equal(stdout.join(''), '1 agents probed, 1 executable, 0 unavailable\n')
  stdout.length = 0
  assert.equal(await main(['--write', '--state', statePath], deps), 0)
  const persisted = readFileSync(statePath, 'utf8')
  const persistedValue = JSON.parse(persisted)
  assert.equal(persistedValue.coding_agents.executable.availability, 'executable')
  assert.equal(persistedValue.coding_agents.executable.availability_reason, 'executable')
  assert.equal(persisted.endsWith('\n'), true)
  assert.ok(stdout.join('').includes(`--- ${statePath}`))
  assert.equal(stdout.join('').includes(`+++ ${statePath}`), true)
  assert.equal(calls.write, 1)
  assert.equal(calls.mkdir, 1)
  assert.equal(calls.rename, 1)
  assert.equal(calls.unlink, 0)

  stdout.length = 0
  assert.equal(await main(['--write', '--state', statePath], deps), 0)
  assert.equal(readFileSync(statePath, 'utf8'), persisted)
  assert.equal(stdout.join('').includes(`--- ${statePath}`), false)
  assert.equal(calls.write, 1)
  assert.equal(calls.mkdir, 1)
  assert.equal(calls.rename, 1)
  assert.equal(calls.unlink, 0)

  const changed = JSON.parse(persisted)
  changed.coding_agents.executable.availability = 'discovered-unavailable'
  changed.coding_agents.executable.availability_reason = 'discovered-unavailable'
  fsWriteFileSync(statePath, `${JSON.stringify(changed, null, 2)}\n`)
  stdout.length = 0
  assert.equal(await main(['--write', '--state', statePath], deps), 0)
  const refreshed = JSON.parse(readFileSync(statePath, 'utf8'))
  assert.equal(refreshed.coding_agents.executable.availability, 'executable')
  assert.equal(refreshed.coding_agents.executable.availability_reason, 'executable')
  assert.equal(stdout.join('').includes(`--- ${statePath}`), true)
  assert.doesNotMatch(stdout.join(''), /--- \/dev\/null/)
  assert.equal(calls.write, 2)
  assert.equal(calls.mkdir, 2)
  assert.equal(calls.rename, 2)
  assert.equal(calls.unlink, 0)
  assert.deepEqual(stderr, [])
})

test('C1F mkdir, write, and rename failures return state-write-failed and preserve old data', async () => {
  const failures = [
    ['mkdir', { mkdirSync: () => { throw Object.assign(new Error('mkdir denied'), { code: 'EPERM' }) } }],
    ['write', { writeFileSync: () => { throw Object.assign(new Error('write denied'), { code: 'EPERM' }) } }],
    ['rename', { renameSync: () => { throw Object.assign(new Error('rename denied'), { code: 'EPERM' }) } }],
  ]
  for (const [label, injected] of failures) {
    const root = scratchDir(`factory-agent-doctor-${label}-`)
    const statePath = join(root, 'capabilities.json')
    const register = fixtureRegister([['executable', { transports: ['pane'] }]])
    register.coding_agents.executable.availability = 'discovered-unavailable'
    register.coding_agents.executable.availability_reason = 'discovered-unavailable'
    const old = `${JSON.stringify(register, null, 2)}\n`
    fsWriteFileSync(statePath, old)
    const stderr = []
    try {
      const code = await main(['--write', '--state', statePath], doctorDeps(register, {
        home: () => root,
        readFile: async (path, encoding) => readFileSync(path, encoding),
        stderr: (value) => stderr.push(String(value)),
        ...injected,
      }))
      assert.equal(code, 2, label)
      assert.match(stderr.join(''), /\[reason: state-write-failed\]/, label)
      assert.equal(readFileSync(statePath, 'utf8'), old, label)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('A1 doctor refuses denied, unknown, empty, and malformed state reads before probing', async () => {
  const cases = [
    ['denied', async () => { throw Object.assign(new Error('read denied'), { code: 'EPERM' }) }],
    ['unknown', async () => undefined],
    ['empty', async () => ''],
    ['malformed', async () => '{ not-json'],
  ]
  for (const [label, readState] of cases) {
    const root = scratchDir(`factory-agent-doctor-state-${label}-`)
    const statePath = join(root, 'capabilities.json')
    const calls = { probe: 0, write: 0, rename: 0 }
    const stderr = []
    try {
      const code = await main(['--write', '--state', statePath], doctorDeps(fixtureRegister([['injected', { transports: ['pane'] }]]), {
        readFile: async (path, encoding) => path === statePath ? readState(path, encoding) : readFileSync(path, encoding),
        which: () => { calls.probe += 1; return '/fixture/agent' },
        spawn: () => { calls.probe += 1; return { status: 0, signal: null, error: null, stdout: 'ok\\n' } },
        importAdapter: async () => { calls.probe += 1; return { capabilitiesFor: () => ({}) } },
        writeFileSync: () => { calls.write += 1 },
        renameSync: () => { calls.rename += 1 },
        stderr: (value) => stderr.push(String(value)),
      }))
      assert.equal(code, 2, label)
      assert.match(stderr.join(''), /\[reason: state-read-failed\]/, label)
      assert.deepEqual(calls, { probe: 0, write: 0, rename: 0 }, label)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('D1 readout reports the exact probed/executable/unavailable denominator and every reason', async () => {
  const register = fixtureRegister([
    ['good', { transports: ['pane'] }],
    ['missing', { transports: ['pane'] }],
    ['shim', { transports: ['pane'] }],
  ])
  const output = []
  const probed = await probeReport(register, doctorDeps(register, {
    which: (binary) => binary === 'missing-binary' ? null : `/fixture/bin/${binary}`,
    spawn: (binary) => binary.endsWith('/shim-binary')
      ? { status: 1, signal: null, error: null, stdout: '' }
      : { status: 0, signal: null, error: null, stdout: 'ok\n' },
  }))
  output.push(renderReadout(probed.results))
  assert.equal(output[0], [
    '3 agents probed, 1 executable, 2 unavailable',
    'missing: discovered-unavailable',
    'shim: shim-not-binary',
  ].join('\n'))
})

test('E1 package and production import contracts contain only the doctor script addition', () => {
  const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(packageJson.scripts['agent:doctor'], 'node scripts/factory/agent-doctor.mjs')
  assert.equal(Object.hasOwn(packageJson, 'dependencies'), false)
  const intended = { ...packageJson.scripts }
  delete intended['agent:doctor']
  assert.deepEqual(Object.keys(intended).sort(), [
    'crew:reap', 'crew:watch', 'ledger:eligible-tasks', 'ledger:gate-review-gap',
    'ledger:phases', 'ledger:procs', 'ledger:run-set', 'ledger:sessions', 'ledger:tail',
    'crew:review', 'ledger:task', 'test', 'viz:build', 'viz:dev', 'viz:serve',
    'model:reeval',
  ].sort())
  const source = readFileSync(join(ROOT, 'scripts/factory/agent-doctor.mjs'), 'utf8')
  const specifiers = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((match) => match[1])
  assert.ok(specifiers.length > 0)
  assert.equal(specifiers.every((specifier) => specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../')), true)
})
