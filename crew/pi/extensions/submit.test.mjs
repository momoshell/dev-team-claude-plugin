import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { scratchDir } from '../../../test/helpers.mjs'
import { assignmentPrompt, assignmentLine, parseAssignment } from '../../driver.mjs'
import { attachSubmit } from './submit.ts'
import { PI_FIRST_PARTY_EXTENSION_TOOLS, piActivatedTools, seatCommand } from '../../adapters/adapter-pi.mjs'
import { grantsFor, loadCapabilities } from '../../capabilities.mjs'
import { rpcCommand } from '../../headless-rpc.mjs'

function fixture({ scoped = true, name = 's', renameSync } = {}) {
  const root = scratchDir(`submit-${name}-`)
  const taskDir = join(root, 'task')
  const returnPath = scoped ? join(root, 'returns', 'run-1', 'd1.planner.json') : join(root, 'returns', 'planner.json')
  mkdirSync(dirname(returnPath), { recursive: true })
  process.env.CREW_TASK_DIR = taskDir
  const handlers = new Map()
  let tool
  attachSubmit({ registerTool(value) { tool = value }, on(name, callback) { handlers.set(name, callback) } }, { renameSync })
  const assignment = { id: 'd1', role: 'planner', briefFile: join(taskDir, 'brief.md'), taskDir, returnPath }
  const prompt = (value = assignment) => assignmentPrompt({ ...value, delivery: 'path' })
  const start = (value = assignment) => handlers.get('before_agent_start')({ prompt: prompt(value) })
  const settle = () => handlers.get('agent_before_settle')({})
  const envelope = (extra = {}) => ({ assignment_id: 'd1', role: 'planner', status: 'done', summary: 'finished', ...(scoped ? { run_id: 'run-1' } : {}), artifacts: [], details: {}, ...extra })
  start()
  return { root, taskDir, returnPath, handlers, tool, assignment, prompt, start, settle, envelope, call: (value) => tool.execute('call', { envelope: value }) }
}

const journalPath = (f) => join(dirname(process.env.CREW_TASK_DIR || f.taskDir), 'journal.jsonl')

test('S1 parser accepts path/inline scoped and flat first lines and rejects hostile prompts', () => {
  const f = fixture({ name: 's1' })
  assert.deepEqual(parseAssignment(f.prompt()), { id: 'd1', role: 'planner', returnPath: f.returnPath, taskDir: f.taskDir, runId: 'run-1' })
  const inline = assignmentPrompt({ ...f.assignment, delivery: 'inline', briefText: 'ASSIGNMENT injected\n' })
  assert.equal(parseAssignment(inline).id, 'd1')
  const flat = { ...f.assignment, returnPath: join(f.root, 'returns', 'flat.json') }
  assert.equal(parseAssignment(assignmentLine({ ...flat, briefFile: join(f.taskDir, 'brief.md') })).runId, null)
  for (const value of ['', 'not an assignment', f.prompt().replace('run-1', 'wrong'), f.prompt().replace(f.taskDir, '/tmp/../bad')]) assert.equal(parseAssignment(value), null)
})


test('S2 valid submission atomically writes exactly the JSON and journals it; correction succeeds', async () => {
  const f = fixture({ name: 's2' })
  const invalid = await f.call(f.envelope({ status: 4 }))
  assert.equal(invalid.details.reason, 'status-kind')
  const value = f.envelope({ note: 'fixed' })
  const result = await f.call(value)
  assert.equal(result.details.submitted, true)
  assert.deepEqual(JSON.parse(readFileSync(f.returnPath, 'utf8')), value)
  assert.ok(readFileSync(journalPath(f), 'utf8').includes('"event":"submit_envelope"'))
  const blocked = fixture({ name: 'journal-block' })
  mkdirSync(journalPath(blocked), { recursive: true })
  assert.equal((await blocked.call(blocked.envelope())).details.submitted, true)
})

test('return write failures preserve an existing file and clean temporary files', async () => {
  const f = fixture({ name: 'return-write-error', renameSync() { const error = new Error('simulated rename failure'); error.code = 'EIO'; throw error } })
  const previous = f.envelope({ summary: 'prior return' })
  writeFileSync(f.returnPath, JSON.stringify(previous))
  const before = readFileSync(f.returnPath, 'utf8')
  const result = await f.call(f.envelope({ summary: 'replacement' }))
  assert.equal(result.details.reason, 'write-error')
  assert.equal(result.details.submitted, undefined)
  assert.equal(readFileSync(f.returnPath, 'utf8'), before)
  assert.deepEqual(readdirSync(dirname(f.returnPath)).filter((name) => name.endsWith('.tmp')), [])
})

test('S3 strict anti-replay checks scoped identity and flat paths need no run_id', async () => {
  const f = fixture({ name: 's3' })
  const wrong = await f.call(f.envelope({ assignment_id: 'other' }))
  assert.equal(wrong.details.reason, 'assignment-id-mismatch')
  assert.equal(existsSync(f.returnPath), false)
  const noRunFixture = fixture({ name: 's3-no-run' })
  const noRun = await noRunFixture.call(noRunFixture.envelope({ run_id: undefined }))
  assert.equal(noRun.details.reason, 'run-mismatch')
  assert.equal(noRun.details.submit_overridden, undefined)
  assert.equal(existsSync(noRunFixture.returnPath), false)
  const badRunFixture = fixture({ name: 's3-bad-run' })
  const badRun = await badRunFixture.call(badRunFixture.envelope({ run_id: 'wrong' }))
  assert.equal(badRun.details.reason, 'run-mismatch')
  assert.equal(badRun.details.submit_overridden, undefined)
  assert.equal(existsSync(badRunFixture.returnPath), false)
  const flat = fixture({ scoped: false, name: 'flat' })
  assert.equal((await flat.call(flat.envelope({ run_id: undefined }))).details.submitted, true)
})

test('S4 outside-task artifacts refuse with the shared shape reason and why', async () => {
  const f = fixture({ name: 's4' })
  const result = await f.call(f.envelope({ artifacts: ['/outside/secret'] }))
  assert.equal(result.details.reason, 'artifacts')
  assert.match(result.details.why, /outside|task/i)
  assert.equal(existsSync(f.returnPath), false)
})

test('S5 third consecutive refusal writes the last defective object with override detail only', async () => {
  const f = fixture({ name: 's5' })
  assert.equal((await f.call(f.envelope({ assignment_id: 'bad' }))).details.attempt, 1)
  assert.equal((await f.call(f.envelope({ assignment_id: 'bad' }))).details.attempt, 2)
  const bad = f.envelope({ assignment_id: 'bad' })
  const result = await f.call(bad)
  assert.equal(result.details.submit_overridden, true)
  assert.deepEqual(JSON.parse(readFileSync(f.returnPath, 'utf8')), bad)
})

test('S6 settle nudges once, skips existing return and rearms on next assignment', async () => {
  const f = fixture({ name: 's6' })
  const first = f.settle()
  assert.equal(first.continue, true)
  assert.equal(first.entries[0].customType, 'submit_nudge')
  assert.equal(f.settle(), undefined)
  const next = { ...f.assignment, id: 'd2', returnPath: join(f.root, 'returns', 'run-2', 'd2.planner.json') }
  mkdirSync(dirname(next.returnPath), { recursive: true })
  f.start(next)
  assert.equal(f.settle().continue, true)
  const existing = fixture({ name: 's6-existing' })
  writeFileSync(existing.returnPath, '{}')
  assert.equal(existing.settle(), undefined)
  const cleared = fixture({ name: 's6-clear' })
  cleared.handlers.get('before_agent_start')({ prompt: 'unrelated prompt' })
  assert.equal((await cleared.call(cleared.envelope())).details.reason, 'no-assignment')
  assert.equal(cleared.settle(), undefined)
  assert.equal(existsSync(cleared.returnPath), false)
})

test('S7 shipped planner, builder, and tech-lead grants activate submit in pane and RPC compositions', () => {
  assert.deepEqual(PI_FIRST_PARTY_EXTENSION_TOOLS['crew/pi/extensions/submit.ts'], ['submit_envelope'])
  const register = loadCapabilities()
  for (const role of ['planner', 'builder', 'tech-lead']) {
    const grants = grantsFor(register, role, { agent: 'pi' })
    assert.ok(grants.extensions.some((item) => item.endsWith('/crew/pi/extensions/submit.ts')), role)
    assert.ok(piActivatedTools({ extensions: grants.extensions }).includes('submit_envelope'))
    const command = seatCommand({ role, model: 'openai-codex/gpt-5.6', promptFile: '/tmp/role.md', tools: [], deny: [], taskDir: '/tmp/task', grants })
    assert.ok(command.includes('/crew/pi/extensions/submit.ts'))
    const rpc = rpcCommand({ bin: '/repo/pi', model: 'openai-codex/gpt-5.6', sessionDir: '/tmp/task/sessions', sessionId: role, promptFile: '/tmp/role.md', deny: [], env: {}, grants })
    assert.ok(rpc.args.some((value) => value.endsWith('/crew/pi/extensions/submit.ts')))
    assert.ok(rpc.args[rpc.args.indexOf('--tools') + 1].split(',').includes('submit_envelope'))
  }
  assert.equal(existsSync(new URL('./submit.ts', import.meta.url)), true)
})
