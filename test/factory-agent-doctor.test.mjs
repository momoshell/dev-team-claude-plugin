import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, writeFileSync as fsWriteFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_AVAILABILITY_STATE_PATH, main, probeReport, renderReadout } from '../scripts/factory/agent-doctor.mjs'
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
    ...(config ? { config } : {}),
  }
}

function fixtureRegister(names) {
  const coding_agents = {}
  for (const [name, options] of names) coding_agents[name] = fixtureEntry(name, options)
  return { coding_agents }
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
  assert.equal(AGENT_AVAILABILITY_STATE_PATH(SCRATCH_HOME), join(SCRATCH_HOME, '.crew', 'agent-availability.json'))
  assert.equal(readCalls.length, 1)
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

test('C1 default and --write modes print proposals without mutating absent or existing targets', async () => {
  const register = fixtureRegister([['executable', { transports: ['pane'] }]])
  const statePath = join(SCRATCH_HOME, 'agent-doctor-state.json')
  const calls = { write: 0, mkdir: 0, rename: 0, unlink: 0 }
  let existing = null
  const stdout = []
  const stderr = []
  const deps = doctorDeps(register, {
    home: () => SCRATCH_HOME,
    readFile: async (path) => {
      if (path === statePath && existing !== null) return existing
      throw missing()
    },
    stdout: (value) => stdout.push(String(value)),
    stderr: (value) => stderr.push(String(value)),
    writeFileSync: (path, value) => { calls.write += 1; fsWriteFileSync(path, value) },
    mkdirSync: () => { calls.mkdir += 1 },
    renameSync: () => { calls.rename += 1 },
    unlinkSync: () => { calls.unlink += 1 },
  })
  assert.equal(await main(['--unknown'], deps), 2)
  assert.equal(await main(['--state'], deps), 2)
  assert.equal(await main(['operand'], deps), 2)
  stderr.length = 0
  assert.equal(await main([], deps), 0)
  assert.equal(stdout.join(''), '1 agents probed, 1 executable, 0 unavailable\n')
  stdout.length = 0
  assert.equal(await main(['--write', '--state', statePath], deps), 0)
  assert.equal(existing, null)
  assert.throws(() => readFileSync(statePath, 'utf8'), { code: 'ENOENT' })
  assert.match(stdout.join(''), /--- \/dev\/null/)
  assert.equal(stdout.join('').includes(`+++ ${statePath}`), true)

  existing = '{"old":true}\n'
  fsWriteFileSync(statePath, existing)
  stdout.length = 0
  assert.equal(await main(['--write', '--state', statePath], deps), 0)
  assert.equal(readFileSync(statePath, 'utf8'), existing)
  assert.equal(stdout.join('').includes(`--- ${statePath}`), true)
  assert.doesNotMatch(stdout.join(''), /--- \/dev\/null/)
  assert.equal(calls.write, 0)
  assert.equal(calls.mkdir, 0)
  assert.equal(calls.rename, 0)
  assert.equal(calls.unlink, 0)
  assert.deepEqual(stderr, [])
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
  ].sort())
  const source = readFileSync(join(ROOT, 'scripts/factory/agent-doctor.mjs'), 'utf8')
  const specifiers = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((match) => match[1])
  assert.ok(specifiers.length > 0)
  assert.equal(specifiers.every((specifier) => specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../')), true)
})
