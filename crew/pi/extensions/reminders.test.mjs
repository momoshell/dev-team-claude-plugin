import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { scratchDir } from '../../../test/helpers.mjs'
import { assignmentPrompt } from '../../driver.mjs'
import { createReminders, attachReminders } from './reminders.ts'

const ids = ['S1','S2','S3','P1','P2','P3','P4','E1','R1','O1','O2','J1','U1','T1']
const shipped = JSON.parse(readFileSync(new URL('./reminders.json', import.meta.url), 'utf8'))
function setup({ table = shipped, role = 'builder', task = true } = {}) {
  const root = scratchDir('reminders-')
  const rows = []
  const env = { CREW_ROLE: role, ...(task ? { CREW_TASK_DIR: join(root, 'task') } : {}) }
  const hooks = createReminders({ env, deps: { tablePath: join(root, 'table.json'), readFileSync(path) { if (path.endsWith('table.json')) return JSON.stringify(table); return readFileSync(path, 'utf8') }, append(path, row) { rows.push({ path, ...row }) } } })
  return { hooks, rows, env }
}
const bash = (command) => ({ toolName: 'bash', input: { command }, content: [{ type: 'text', text: 'original' }] })
const assignment = (id) => assignmentPrompt({ id, role: 'builder', briefFile: '/tmp/brief.md', returnPath: `/tmp/returns/run-1/${id}.builder.json`, taskDir: '/tmp/task' })

test('S1 shipped table has exactly two expected rules', () => { assert.equal(shipped.rules.length, 2); assert.deepEqual(shipped.rules.map((r) => r.id), ['raw-temp-call', 'test-name-pattern']); assert.equal(setup().hooks.usable, true) })
test('S2 rejects unknown keys, invalid regex, duplicate ids, bad source and top-level keys', () => {
  for (const mutate of [t => { t.rules[0].extra = true }, t => { t.rules[0].pattern = '[' }, t => { t.rules[1].id = t.rules[0].id }, t => { t.rules[0].source.quote = 'definitely-not-a-source-quote-zzq' }, t => { t.extra = true }]) { const t = structuredClone(shipped); mutate(t); const f = setup({ table: t }); assert.equal(f.hooks.usable, false); assert.equal(f.hooks.reason, 'schema') }
})
test('S3 each shipped source quote occurs literally', () => { for (const r of shipped.rules) assert.ok(readFileSync(r.source.path, 'utf8').includes(r.source.quote)) })
test('P1 bash reminder prepends and preserves original content order', () => { const f = setup(); const result = f.hooks.toolResult(bash('--test-name-pattern=abc')); assert.match(result.content[0].text, /reminder/); assert.equal(result.content[1].text, 'original') })
test('P2 edit newText matches on test path', () => { const f = setup(); const result = f.hooks.toolResult({ toolName: 'edit', input: { path: 'x.test.mjs', edits: [{ newText: 'mkdtempSync(' }] }, content: [] }); assert.match(result.content[0].text, /scratchDir/) })
test('P3 non-test edit does not match', () => { const f = setup(); assert.equal(f.hooks.toolResult({ toolName: 'edit', input: { path: 'x.js', edits: [{ newText: 'mkdtempSync(' }] }, content: [] }), undefined) })
test('P4 nonmatching call returns undefined', () => { assert.equal(setup().hooks.toolResult(bash('echo hi')), undefined) })
test('E1 failed edit gets no reminder', () => { assert.equal(setup().hooks.toolResult({ toolName: 'edit', isError: true, input: { path: 'x.test.mjs', edits: [{ newText: 'mkdtemp(' }] }, content: [] }), undefined) })
test('R1 planner gets none', () => { assert.equal(setup({ role: 'planner' }).hooks.toolResult(bash('--test-name-pattern')), undefined) })
test('O1 duplicate in one assignment gets none', () => { const f = setup(); const e = bash('--test-name-pattern'); assert.ok(f.hooks.toolResult(e)); assert.equal(f.hooks.toolResult(e), undefined) })
test('O2 distinct assignment id re-arms', () => { const f = setup(); const e = bash('--test-name-pattern'); f.hooks.beforeAgentStart({ prompt: assignment('a') }); assert.ok(f.hooks.toolResult(e)); f.hooks.beforeAgentStart({ prompt: assignment('b') }); assert.ok(f.hooks.toolResult(e)) })
test('J1 one complete firing row per firing', () => { const f = setup(); f.hooks.beforeAgentStart({ prompt: assignment('a') }); f.hooks.toolResult(bash('--test-name-pattern')); assert.equal(f.rows.length, 1); assert.deepEqual(f.rows[0].rule_reminder, { rule: 'test-name-pattern', role: 'builder', tool: 'bash', assignment_id: 'a' }) })
test('U1 corrupt JSON yields one unparseable row and no firing', () => { const root = scratchDir('reminders-bad-'); const rows = []; const hooks = createReminders({ env: { CREW_ROLE: 'builder', CREW_TASK_DIR: join(root, 'task') }, deps: { tablePath: '/bad', readFileSync() { return '{' }, append(_p, row) { rows.push(row) } } }); hooks.beforeAgentStart({ prompt: assignment('a') }); assert.equal(hooks.toolResult(bash('--test-name-pattern')), undefined); assert.equal(rows.length, 1); assert.equal(rows[0].rule_reminder_table_unusable.reason, 'unparseable') })
test('RV1-1 corrupt table assignment hook does not throw', () => {
  const root = scratchDir('reminders-assignment-')
  const hooks = createReminders({ env: { CREW_ROLE: 'builder', CREW_TASK_DIR: join(root, 'task') }, deps: { tablePath: '/bad', readFileSync() { return '{' }, append() {} } })
  assert.equal(hooks.usable, false)
  assert.doesNotThrow(() => hooks.beforeAgentStart({ prompt: assignment('rv1-1') }))
})
test('T1 test IDs are exactly the complete set and gate runs this file', () => { const source = readFileSync(new URL(import.meta.url), 'utf8'); const found = [...source.matchAll(/^test\('(S1|S2|S3|P1|P2|P3|P4|E1|R1|O1|O2|J1|U1|T1) /gm)].map(m => m[1]); assert.deepEqual(found.sort(), [...ids].sort()); assert.match(source, /test\('O2 /) })
