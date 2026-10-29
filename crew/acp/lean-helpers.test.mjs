import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import {
  CAPABILITY_REFUSALS, EMPTY_GRANTS, PI_AGENT_DIR_ENV, REGISTER_ROOT, SUBAGENT_EXTENSION, armGrants, assertGrantsBacked,
  grantsFor, loadCapabilities, mergeMcpServers, pathExists, pathMessage, refuse, resolveVendorExtension,
  resolvedGrantPath, validateCapabilities, vendorRoots,
} from './grants.mjs'
import { parseAgent } from '../protocols.mjs'
import { BriefUsageError, exportEntries } from './export-entries.mjs'
import { parseAssignment } from './assignment.mjs'
import { scratchDir } from '../../test/helpers.mjs'
import { logLine } from './log.mjs'

const role = (over = {}) => ({ tools: ['Read'], extensions: [], agents: [], skills: [], advisor: false, requires: [], mcp_servers: [], vendor_extensions: [], ...over })
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

test('vendorRoots uses the explicit, configured, then default arms', () => {
  assert.equal(PI_AGENT_DIR_ENV, 'PI_CODING_AGENT_DIR')
  assert.deepEqual(vendorRoots({ env: { CREW_PI_VENDOR_ROOT: 'rel', PI_CODING_AGENT_DIR: '/c/pi' }, home: '/h' }), [resolvePath('rel')])
  assert.deepEqual(vendorRoots({ env: { PI_CODING_AGENT_DIR: '/c/pi' }, home: '/h' }), ['/c/pi/npm/node_modules'])
  assert.deepEqual(vendorRoots({ env: {}, home: '/h' }), ['/h/.pi/agent/npm/node_modules'])
})

test('resolveVendorExtension resolves every declared entry and refuses a missing package', () => {
  const grant = { package: '@x/y', tools: ['t1'] }
  const files = { '/v/@x/y/package.json': JSON.stringify({ pi: { extensions: ['a.js', 'b.js'] } }), '/v/@x/y/a.js': '', '/v/@x/y/b.js': '' }
  const resolved = resolveVendorExtension(grant, { roots: ['/v'], exists: (p) => p in files, readFile: (p) => files[p] })
  assert.deepEqual(resolved.entries, ['/v/@x/y/a.js', '/v/@x/y/b.js'])
  assert.deepEqual(resolved.tools, ['t1'])
  assert.equal(Object.isFrozen(resolved), true)
  assert.throws(() => resolveVendorExtension(grant, { roots: ['/v'], exists: () => false }), (err) => err.reason === 'vendor-extension-missing')
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
  const grants = grantsFor(register, 'builder', { root: '/r', exists: () => true, readFile, vendorRoots: [] })
  assert.deepEqual(grants.extensions, [resolvePath('/r/crew/pi/e.js')])
  assert.deepEqual(grants.skills, [resolvePath('/r/crew/pi/s.md')])
  assert.deepEqual(grants.agents, [{ name: 'Explore', def: resolvePath('/r/crew/pi/a.json') }])
  assert.deepEqual(grants.tools, ['Read'])
  assert.equal(Object.isFrozen(grants.extensions), true)
  const refused = (over, reason) => assert.throws(
    () => grantsFor({ roles: { builder: role(over) } }, 'builder', { root: '/r', exists: () => false, readFile, vendorRoots: [] }),
    (err) => err.reason === reason && /at /.test(err.message),
  )
  refused({ extensions: ['crew/pi/nope.js'] }, 'extension-missing')
  refused({ skills: ['crew/pi/nope.md'] }, 'unknown-skill')
  assert.throws(() => grantsFor(register, 'nobody', { root: '/r' }), (err) => err.reason === 'register-invalid')
  assert.throws(
    () => grantsFor(register, 'builder', { root: '/r', exists: () => true, readFile: () => '{not-json', vendorRoots: [] }),
    (err) => err.reason === 'agent-def-invalid',
  )
})

test('assertGrantsBacked passes backed grants and refuses unregistered ones', () => {
  const register = { roles: { builder: role({ extensions: ['crew/pi/e.js'] }) } }
  const grants = grantsFor(register, 'builder', { root: '/r', exists: () => true, vendorRoots: [] })
  assert.equal(assertGrantsBacked('builder', grants, register, { vendorRoots: [] }), grants)
  assert.throws(() => assertGrantsBacked('builder', { ...grants, tools: ['Bash'] }, register, { vendorRoots: [] }), (err) => err.reason === 'unknown-grant')
  assert.throws(() => assertGrantsBacked('builder', { ...grants, extensions: ['/r/other.js'] }, register, { vendorRoots: [] }), (err) => err.reason === 'unknown-grant')
  assert.throws(() => assertGrantsBacked('ghost', EMPTY_GRANTS, register), (err) => err.reason === 'unknown-grant')
  assert.equal(Object.isFrozen(EMPTY_GRANTS), true)
})

test('armGrants arms native extensions, fff and lab, and refuses what it cannot back', () => {
  const root = '/r'
  const exists = () => true
  const native = armGrants({ role: 'builder', agent: 'pi', extensions: ['skeletonread'] }, { root, exists })
  assert.deepEqual(native.extensions, [resolvePath('/r/crew/pi/extensions/skeletonread.ts')])
  assert.deepEqual(native.mcp_servers, [])

  const mcp = armGrants({ role: 'builder', agent: 'pi', extensions: ['fff', 'lab'] }, { root, exists })
  assert.deepEqual(mcp.mcp_servers.map((server) => server.name), ['fff', 'lab'])
  assert.deepEqual(mcp.mcp_servers[1].command, { bin: process.execPath, args: [resolvePath('/r/crew/mcp/lab-server.mjs')] })
  assert.throws(() => armGrants({ role: 'builder', agent: 'pi', extensions: ['fff'] }, { root, exists: () => false }), (err) => err.reason === 'extension-missing')
  assert.throws(() => armGrants({ role: 'builder', agent: 'pi', extensions: ['Bad_Name'] }, { root, exists }), (err) => err.reason === 'unknown-grant')
  assert.throws(() => armGrants({ role: 'builder', agent: 'pi', extensions: ['lab'] }, { root, exists, register: { roles: { builder: role() } } }), (err) => err.reason === 'unknown-grant')

  assert.equal(SUBAGENT_EXTENSION, 'crew/pi/extensions/subagent.ts')
  const fan = armGrants({ role: 'planner', agent: 'pi', extensions: ['subagent'] }, { root, exists, readFile: () => JSON.stringify({ name: 'scout', prompt: 'look' }) })
  assert.deepEqual(fan.agents, [{ name: 'scout', def: resolvePath('/r/crew/pi/agents/scout.json') }])
  assert.throws(
    () => armGrants({ role: 'builder', agent: 'pi', extensions: ['subagent'] }, { root, exists, register: { roles: { builder: role() } } }),
    (err) => err.reason === 'unknown-grant' && /declares no agent definition/.test(err.message),
  )
})

test('the committed planner and reviewer definitions grant subagent with scout', () => {
  for (const role of ['planner', 'reviewer']) {
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

test('parseAssignment reads only the exact assignment head and refuses unsafe or mismatched input', () => {
  const head = (over = {}) => {
    const { id = 'p1', done = 'p1', returnPath = '/Users/x/.crew/demo/returns/run-1/d1.planner.json', runId = ' Add top-level JSON field "run_id":"run-1" to your ReturnEnvelope.', brief = '/Users/x/.crew/demo/task/brief-planner.md' } = over
    return `ASSIGNMENT ${id}: read your brief at ${brief}. Task dir: /Users/x/.crew/demo/task. Write your ReturnEnvelope to ${returnPath}${runId} then print exactly: CREW-DONE planner ${done}`
  }
  const expected = { id: 'p1', role: 'planner', returnPath: '/Users/x/.crew/demo/returns/run-1/d1.planner.json', taskDir: '/Users/x/.crew/demo/task', runId: 'run-1' }
  assert.deepEqual(parseAssignment(head()), expected)
  assert.deepEqual(parseAssignment(`${head()}\nsecond line is ignored`), expected)
  assert.equal(parseAssignment(head({ runId: '' })).runId, null)
  assert.equal(parseAssignment(''), null)
  assert.equal(parseAssignment(null), null)
  assert.equal(parseAssignment(head({ done: 'p2' })), null)
  assert.equal(parseAssignment(head({ runId: ' Add top-level JSON field "run_id":"other" to your ReturnEnvelope.' })), null)
  assert.equal(parseAssignment(head({ brief: '/Users/x/../brief.md' })), null)
  assert.equal(parseAssignment(head({ id: '..', done: '..' })), null)
})

test('logLine appends one JSON line and never throws', () => {
  const dir = scratchDir('lean-helpers-')
  try {
    const file = join(dir, 'nested', 'crew.log')
    logLine(file, { a: 1 })
    logLine(file, { b: 'two' })
    assert.equal(readFileSync(file, 'utf8'), '{"a":1}\n{"b":"two"}\n')
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x')
    assert.equal(logLine(join(blocker, 'sub', 'crew.log'), { c: 3 }), undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
