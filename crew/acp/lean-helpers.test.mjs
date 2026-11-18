import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve as resolvePath } from 'node:path'
import {
  CAPABILITY_REFUSALS, armGrants,
  grantsFor, pathExists, pathMessage, refuse,
  resolvedGrantPath,
} from './grants.mjs'
import { BriefUsageError, exportEntries } from './export-entries.mjs'
import * as grants from './grants.mjs'

const role = (over = {}) => ({ extensions: [], agents: [], mcp_servers: [], ...over })
const never = () => { throw new Error('unreadable') }

test('refuse stamps a closed reason and rejects an unknown one', () => {
  const err = refuse('unknown-grant', 'nope')
  assert.equal(err.reason, 'unknown-grant')
  assert.equal(err.message, 'nope [unknown-grant]')
  assert.equal(Object.isFrozen(CAPABILITY_REFUSALS), true)
  assert.throws(() => refuse('not-a-capability-reason', 'bad'), /unknown capability refusal reason/)
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

test('grantsFor resolves valid grants and fails closed on missing paths', () => {
  const register = { roles: { builder: role({ extensions: ['crew/pi/e.js'], agents: [{ name: 'Explore', def: 'crew/pi/a.json' }] }) } }
  const readFile = () => JSON.stringify({ name: 'Explore', prompt: 'go' })
  const grants = grantsFor(register, 'builder', { root: '/r', exists: () => true, readFile })
  assert.deepEqual(grants.extensions, [resolvePath('/r/crew/pi/e.js')])
  assert.deepEqual(grants.agents, [{ name: 'Explore', def: resolvePath('/r/crew/pi/a.json') }])
  assert.equal(Object.isFrozen(grants.extensions), true)
  const refused = (over, reason) => assert.throws(
    () => grantsFor({ roles: { builder: role(over) } }, 'builder', { root: '/r', exists: () => false, readFile }),
    (err) => err.reason === reason && /at /.test(err.message),
  )
  refused({ extensions: ['crew/pi/nope.js'] }, 'extension-missing')
  assert.throws(() => grantsFor(register, 'nobody', { root: '/r' }), (err) => err.reason === 'register-invalid')
  assert.throws(
    () => grantsFor(register, 'builder', { root: '/r', exists: () => true, readFile: () => '{not-json' }),
    (err) => err.reason === 'agent-def-invalid',
  )
})

// MUTATION: restore the hard-coded LEAN_FFF_BIN probe.
test('armGrants arms fff from the register binary, not a hard-coded path', () => {
  const server = { name: 'fff', command: { bin: '/usr/local/bin/fff-mcp', args: [] }, url: null }
  const register = { roles: { builder: { agents: [], mcp_servers: [server] } } }
  const spec = { role: 'builder', agent: 'pi', extensions: ['fff'] }
  let armed
  assert.doesNotThrow(() => { armed = armGrants(spec, { register, exists: (p) => p === server.command.bin }) })
  assert.equal(armed.mcp_servers[0].command.bin, server.command.bin)
  assert.throws(() => armGrants(spec, { register, exists: (p) => p === '/opt/homebrew/bin/fff-mcp' }), (error) => error.reason === 'extension-missing' && error.message.includes('/usr/local/bin/fff-mcp'))
  server.command = null
  server.url = 'http://x'
  assert.throws(() => armGrants(spec, { register, exists: () => true }), (error) => error.reason === 'extension-missing' && error.message.includes('no command'))
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

// MUTATION: read spec.extensions without a default.
test('grantsFor on a shipped role with no extensions field grants no extensions', () => {
  const register = grants.REGISTER
  assert.equal(Object.hasOwn(register.roles.builder, 'extensions'), false)
  assert.deepEqual(grantsFor(register, 'builder', { exists: () => true }).extensions, [])
})
