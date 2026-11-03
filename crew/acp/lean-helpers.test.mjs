import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import {
  CAPABILITY_REFUSALS, PI_AGENT_DIR_ENV, REGISTER_ROOT, SUBAGENT_EXTENSION, armGrants,
  grantsFor, loadCapabilities, mergeMcpServers, pathExists, pathMessage, refuse,
  resolvedGrantPath, validateCapabilities,
} from './grants.mjs'
import { parseAgent } from '../protocols.mjs'
import { BriefUsageError, exportEntries } from './export-entries.mjs'
import * as grants from './grants.mjs'

const role = (over = {}) => ({ tools: ['Read'], extensions: [], agents: [], skills: [], advisor: false, requires: [], mcp_servers: [], ...over })
const never = () => { throw new Error('unreadable') }

test('refuse stamps a closed reason and rejects an unknown one', () => {
  const err = refuse('unknown-grant', 'nope')
  assert.equal(err.reason, 'unknown-grant')
  assert.equal(err.message, 'nope [unknown-grant]')
  assert.equal(Object.isFrozen(CAPABILITY_REFUSALS), true)
  assert.throws(() => refuse('not-a-capability-reason', 'bad'), /unknown capability refusal reason/)
})

test('loadCapabilities reads the shipped register and refuses an invalid injected one', () => {
  const register = loadCapabilities()
  assert.deepEqual(Object.keys(register.roles), ['lead', 'planner', 'builder', 'reviewer', 'tech-lead'])
  assert.equal(Object.isFrozen(register), true)
  assert.equal(isAbsolute(REGISTER_ROOT), true)
  assert.throws(() => loadCapabilities({ register: { roles: 'nope' } }), (err) => err.reason === 'register-invalid')
  assert.throws(() => loadCapabilities({ path: '/nonexistent/register.json' }), (err) => err.reason === 'register-invalid')
})

// MUTATION: put "pane" back in the transports enum and the injected register loads.
test('the shipped register declares only the acp transport and the schema refuses a retired one', () => {
  const shipped = loadCapabilities()
  const source = JSON.parse(readFileSync(join(REGISTER_ROOT, 'crew/capabilities.json'), 'utf8'))
  const schema = JSON.parse(readFileSync(join(REGISTER_ROOT, 'crew/capabilities.schema.json'), 'utf8'))
  assert.deepEqual(schema.$defs.codingagent.properties.default_transport.enum, ['acp'])
  for (const agent of ['pi', 'claude']) {
    assert.deepEqual(shipped.coding_agents[agent].transports, ['acp'])
    for (const transport of ['pane', 'headless-json', 'headless-rpc']) {
      for (const field of ['transports', 'default_transport']) {
        const register = structuredClone(source)
        register.coding_agents[agent][field] = field === 'transports' ? [transport] : transport
        assert.throws(() => loadCapabilities({ register }), (error) => error.reason === 'register-invalid')
      }
    }
  }
})

test('validateCapabilities reports type, required and enum errors', () => {
  const schema = { type: 'object', required: ['a'], properties: { a: { type: 'integer' }, b: { enum: ['x'] } }, additionalProperties: false }
  assert.deepEqual(validateCapabilities(schema, { a: 1, b: 'x' }), [])
  const errors = validateCapabilities(schema, { b: 'y', c: 1 })
  assert.equal(errors.length, 3)
  assert.match(errors.join('\n'), /missing required property "a"/)
  assert.match(errors.join('\n'), /not in enum/)
  assert.match(errors.join('\n'), /additional property "c"/)
})

test('path helpers resolve, probe and phrase refusals', () => {
  assert.equal(resolvedGrantPath('/root', 'crew/x.js'), resolvePath('/root/crew/x.js'))
  assert.equal(pathExists(() => true, '/x'), true)
  assert.equal(pathExists(() => '', '/x'), false)
  assert.equal(pathExists(never, '/x'), false)
  const err = pathMessage('extension-missing', 'builder', 'extension grant', 'a path', 'missing', '/p')
  assert.equal(err.reason, 'extension-missing')
  assert.equal(err.message, 'seat builder extension grant expected a path, found missing, at /p [extension-missing]')
})

// MUTATION: restore local_providers in the schema.
test('the register declares no local provider or narrator and the schema refuses both', () => {
  const source = JSON.parse(readFileSync(join(REGISTER_ROOT, 'crew/capabilities.json'), 'utf8'))
  const shipped = loadCapabilities()
  for (const key of ['local_providers', 'narrator']) assert.equal(Object.hasOwn(shipped, key), false)
  assert.equal(shipped.coding_agents.pi.providers.includes('llama-swap'), false)
  for (const [key, value] of [['local_providers', {}], ['narrator', { settings: 'x', pi_provider: 'p', base_url: 'http://x' }]]) {
    const register = structuredClone(source)
    register[key] = value
    assert.throws(() => loadCapabilities({ register }), { reason: 'register-invalid' })
  }
})

// MUTATION: restore vendor_extensions in the grant schema.
test('loadCapabilities refuses every vendor extension declaration on a role or an overlay', () => {
  const source = JSON.parse(readFileSync(join(REGISTER_ROOT, 'crew/capabilities.json'), 'utf8'))
  const grant = { package: 'vendor', tools: ['t'] }
  for (const [overlay, duplicate] of [[false, false], [false, true], [true, false], [true, true]]) {
    const register = structuredClone(source)
    const target = overlay ? ((register.roles.builder.by_agent ??= {}).pi ??= {}) : register.roles.builder
    target.vendor_extensions = duplicate ? [grant, grant] : [grant]
    assert.throws(() => loadCapabilities({ register }), { reason: 'register-invalid' })
  }
  const schema = JSON.parse(readFileSync(join(REGISTER_ROOT, 'crew/capabilities.schema.json'), 'utf8'))
  assert.equal(schema.$defs.vendorgrant, undefined)
})

// MUTATION: restore vendorRoots.
test('the seat path ships no vendor grants, grant backing check, assignment parser or log helper', () => {
  for (const name of ['assertGrantsBacked', 'resolveVendorExtension', 'vendorRoots', 'VENDOR_ROOT_ENV']) assert.equal(name in grants, false)
  for (const value of [grants.armGrants({ role: 'builder', agent: 'pi', extensions: [] }, { root: REGISTER_ROOT, exists: () => true }), grants.EMPTY_GRANTS])
    for (const key of ['vendor_extensions', 'vendor_withheld']) assert.equal(Object.hasOwn(value, key), false)
  for (const name of ['assignment.mjs', 'log.mjs']) assert.equal(existsSync(join(REGISTER_ROOT, 'crew/acp', name)), false)
  assert.equal(PI_AGENT_DIR_ENV, 'PI_CODING_AGENT_DIR')
})

test('mergeMcpServers lets the overlay replace by name', () => {
  const a = { name: 'a', command: null, url: 'u1' }
  const b = { name: 'b', command: null, url: 'u2' }
  assert.deepEqual(mergeMcpServers([a, b], [{ ...a, url: 'u3' }]), [{ ...a, url: 'u3' }, b])
  assert.deepEqual(mergeMcpServers(), [])
})

test('grantsFor resolves valid grants and fails closed on missing paths', () => {
  const register = { roles: { builder: role({ extensions: ['crew/pi/e.js'], skills: ['crew/pi/s.md'], agents: [{ name: 'Explore', def: 'crew/pi/a.json' }] }) } }
  const readFile = () => JSON.stringify({ name: 'Explore', prompt: 'go' })
  const grants = grantsFor(register, 'builder', { root: '/r', exists: () => true, readFile })
  assert.deepEqual(grants.extensions, [resolvePath('/r/crew/pi/e.js')])
  assert.deepEqual(grants.skills, [resolvePath('/r/crew/pi/s.md')])
  assert.deepEqual(grants.agents, [{ name: 'Explore', def: resolvePath('/r/crew/pi/a.json') }])
  assert.deepEqual(grants.tools, ['Read'])
  assert.equal(Object.isFrozen(grants.extensions), true)
  const refused = (over, reason) => assert.throws(
    () => grantsFor({ roles: { builder: role(over) } }, 'builder', { root: '/r', exists: () => false, readFile }),
    (err) => err.reason === reason && /at /.test(err.message),
  )
  refused({ extensions: ['crew/pi/nope.js'] }, 'extension-missing')
  refused({ skills: ['crew/pi/nope.md'] }, 'unknown-skill')
  assert.throws(() => grantsFor(register, 'nobody', { root: '/r' }), (err) => err.reason === 'register-invalid')
  assert.throws(
    () => grantsFor(register, 'builder', { root: '/r', exists: () => true, readFile: () => '{not-json' }),
    (err) => err.reason === 'agent-def-invalid',
  )
})

test('armGrants arms native extensions and fff, and refuses what it cannot back', () => {
  const root = '/r'
  const exists = () => true
  const native = armGrants({ role: 'builder', agent: 'pi', extensions: ['skeletonread'] }, { root, exists })
  assert.deepEqual(native.extensions, [resolvePath('/r/crew/pi/extensions/skeletonread.ts')])
  assert.deepEqual(native.mcp_servers, [])

  const mcp = armGrants({ role: 'builder', agent: 'pi', extensions: ['fff'] }, { root, exists })
  assert.deepEqual(mcp.mcp_servers.map((server) => server.name), ['fff'])
  assert.throws(() => armGrants({ role: 'builder', agent: 'pi', extensions: ['fff'] }, { root, exists: () => false }), (err) => err.reason === 'extension-missing')
  assert.throws(() => armGrants({ role: 'builder', agent: 'pi', extensions: ['Bad_Name'] }, { root, exists }), (err) => err.reason === 'unknown-grant')
  assert.throws(() => armGrants({ role: 'builder', agent: 'pi', extensions: ['lab'] }, { root, exists: () => false }), (err) => err.reason === 'extension-missing')

  assert.equal(SUBAGENT_EXTENSION, 'crew/pi/extensions/subagent.ts')
  const fan = armGrants({ role: 'planner', agent: 'pi', extensions: ['subagent'] }, { root, exists, readFile: () => JSON.stringify({ name: 'scout', prompt: 'look' }) })
  assert.deepEqual(fan.agents, [{ name: 'scout', def: resolvePath('/r/crew/pi/agents/scout.json') }])
  assert.throws(
    () => armGrants({ role: 'builder', agent: 'pi', extensions: ['subagent'] }, { root, exists, register: { roles: { builder: role() } } }),
    (err) => err.reason === 'unknown-grant' && /declares no agent definition/.test(err.message),
  )
})

test('the committed reviewer definition grants subagent with scout', () => {
  for (const role of ['reviewer']) {
    const { fields, defects } = parseAgent(readFileSync(new URL(`../agents/${role}.md`, import.meta.url), 'utf8'))
    assert.deepEqual(defects, [], role)
    const grants = armGrants({ role, agent: fields.agent, extensions: fields.extensions ?? [] })
    assert.ok(grants.extensions.some((path) => path.replaceAll('\\', '/').endsWith(SUBAGENT_EXTENSION)), role)
    assert.ok(grants.agents.some((agent) => agent.name === 'scout'), role)
  }
})

test('exportEntries scans exports with lines, spans and signatures', () => {
  const rows = exportEntries("export { remoteThing as localThing } from './remote.mjs';\n", 'fixture.mjs')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, 'localThing')
  assert.equal(rows[0].line, 1)
  assert.match(rows[0].signature, /from ['"]\.\/remote\.mjs['"]/)
  assert.equal(rows[0].bodySpan, null)
  assert.deepEqual(rows[0].signatureSpan, { start: 1, end: 1 })

  const multi = ['const first = () => { return 1 }', 'const second = () => { return 2 }', 'export {', '  first,', '  second as renamed,', '};'].join('\n') + '\n'
  const listed = exportEntries(multi, 'fixture.mjs')
  assert.deepEqual(listed.map(({ name, line }) => ({ name, line })), [{ name: 'first', line: 3 }, { name: 'renamed', line: 3 }])
  assert.equal(listed[0].signatureSpan.end, 6)

  const local = ['function alpha() { return "a" }', 'const beta = () => "b"', 'class Gamma { m() { return "g" } }', 'export { alpha, beta as betaAlias, Gamma as GammaAlias };'].join('\n') + '\n'
  const named = exportEntries(local, 'fixture.mjs')
  assert.deepEqual(named.map((row) => row.name), ['GammaAlias', 'alpha', 'betaAlias'])
  assert.equal(named.find((row) => row.name === 'betaAlias').bodySpan.start, 2)

  const dflt = exportEntries('export default function defaultThing() { return 7 }\n', 'fixture.mjs')
  assert.deepEqual(dflt.map(({ name, line }) => ({ name, line })), [{ name: 'default', line: 1 }])
  assert.match(dflt[0].signature, /export default function defaultThing/)

  const unsupported = ['export var unsupportedVar = 1;', "export * from './everything.mjs';", 'export interface UnsupportedInterface { value: string }', 'export const supportedValue = 2;'].join('\n') + '\n'
  assert.deepEqual(exportEntries(unsupported, 'fixture.ts').map((row) => row.name), ['supportedValue'])
  assert.deepEqual(exportEntries('export const typedValue: number = 1;\n', 'fixture.ts').map(({ name, line }) => ({ name, line })), [{ name: 'typedValue', line: 1 }])
  assert.deepEqual(exportEntries('export const ignoredValue = 1;\n', 'fixture.txt'), [])
  assert.throws(() => exportEntries(42), (err) => err instanceof BriefUsageError && err.reason === 'wrong-type')
})

test('BriefUsageError carries its name and reason', () => {
  const err = new BriefUsageError('brief: bad', 'wrong-type')
  assert.equal(err.name, 'BriefUsageError')
  assert.equal(err.reason, 'wrong-type')
  assert.equal(err instanceof Error, true)
  assert.equal(new BriefUsageError('x').reason, 'missing-line')
})
