// Gate for FN1-FN9: lean finish run. Run from the repo root: node <taskDir>/gate.mjs
// Checks FN1-FN6 by driving runLoop with fake seams on a finish spec, and
// FN7-FN9 by calling crew/finish.mjs finishLane on temp lane fixtures.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const IDS = ['FN1', 'FN2', 'FN3', 'FN4', 'FN5', 'FN6', 'FN7', 'FN8', 'FN9']
const failed = new Set()
const check = (id, fn) => { try { fn() } catch { failed.add(id) } }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const FINDING = { id: 'R1', severity: 'must-fix', location: 'lib.mjs:1', summary: 'Fix the defect' }
const PLANNED_MUTATION = { check: 'A1', file: 'lib.mjs', find: 'old', replace: 'new' }
const REPLACEMENT = { check: 'A1', file: 'lib.mjs', find: 're-aimed', replace: 'new2' }
const STOP = { reason: 'mutations-survived', observation: { stage: 'mutations', detail: 'A1 survived' } }
const green = () => ({ status: 'green', reason: null, code: 0, signal: null, stdout: '', stderr: '', timedOut: false })

// ---- FN1-FN6: one finish runLoop over fake seams (no planner seat seated) ----
let outcome = null
try {
  const { runLoop } = await import(pathToFileURL(join(root, 'crew/loop.mjs')))
  const calls = [], rows = [], requests = [], seen = {}, returns = new Map()
  const spec = {
    id: 'lane', cwd: '/virtual/checkout', taskDir: '/virtual/task', tier: 'build', shape: 'finish',
    brief: 'operator task', acceptance: ['A1'], source: 'issue 12', branch: 'lane', base: 'main',
    closes: [], refs: [], suite: { command: 'node', args: ['--test', 'lane.test.mjs'] }, timeoutMs: 5000,
    finish: {
      planPath: '/virtual/task/plan.md', gatePath: '/virtual/task/gate.mjs', subject: 'fix(crew): planned lane',
      mutations: [PLANNED_MUTATION], stop: STOP, findings: [FINDING], turnOffset: 3,
    },
  }
  const envelope = (request) => ({
    role: request.role, id: request.id, status: 'done', summary: 'fixture',
    details: request.role === 'builder' ? { summary: 'built', mutations: [REPLACEMENT] }
      : request.role === 'lead' ? { decision: 'escalate' }
      : { verdict: 'pass', findings: [] },
  })
  const measured = (name, result) => async (input) => { calls.push(name); seen[name] = structuredClone(input); return structuredClone(result) }
  const deps = {
    // No planner seat: a finish run that requires one stops seat-unmeasured.
    resolveAgents: () => ({ seats: { builder: { agent: 'pi', provider: 'test', id: 'builder', effort: 'high' }, reviewer: { agent: 'pi', provider: 'test', id: 'reviewer', effort: 'high' }, lead: { agent: 'pi', provider: 'test', id: 'lead', effort: 'high' } } }),
    mkdir: async () => {},
    readFile: async (path) => returns.get(path) ?? '',
    journal: async (row) => { rows.push(structuredClone(row)) },
    runSeat: async (request) => {
      calls.push(`seat:${request.role}`); requests.push(structuredClone(request))
      returns.set(request.returnPath, JSON.stringify(envelope(request)))
      return undefined
    },
    checkBaseline: measured('baseline', { accepted: true, reason: 'gate-failed', result: { ...green(), status: 'red', code: 1, reason: 'gate-failed', failingIds: ['A1'] } }),
    runGate: measured('gate', { ...green(), failingIds: [] }),
    proveMutations: measured('mutations', { status: 'green', reason: null, rows: [{ check: 'A1', outcome: 'killed', reason: null }] }),
    runSuite: measured('suite', green()),
    commitChanges: measured('commit', { status: 'green', reason: null, head: 'a'.repeat(40), files: ['lib.mjs'] }),
    run: async (input) => { const name = input.args.includes('status') ? (calls.at(-1) === 'suite' ? 'paths' : 'review-paths') : 'fetch'; calls.push(name); seen[name] = structuredClone(input); return { ...green(), stdout: ' M lib.mjs\0' } },
    rebaseBranch: measured('rebase', { status: 'green', reason: null, head: 'b'.repeat(40) }),
    openPullRequest: measured('publish', { status: 'green', reason: null, pr: { number: 1, url: 'https://example.test/pr/1' } }),
  }
  const result = await runLoop(spec, deps)
  outcome = { result, calls, rows, requests, seen }
} catch { outcome = null }

const builders = outcome?.requests.filter((r) => r.role === 'builder') ?? []
check('FN1', () => { assert.equal(outcome?.result.status, 'done'); assert.ok(builders.length > 0); assert.equal(outcome.requests.some((r) => r.role === 'planner'), false) })
check('FN2', () => { assert.equal(outcome?.result.status, 'done'); assert.equal(outcome.calls.includes('baseline'), false) })
check('FN3', () => {
  assert.ok(builders.length > 0)
  const hit = builders[0].feedback.find((e) => e?.reason === STOP.reason)
  assert.ok(hit, 'first builder feedback carries the stop reason')
  assert.ok(same(hit.observation, STOP.observation), 'first builder feedback carries the stop observation')
})
check('FN4', () => { assert.ok(builders.length > 0); assert.ok(builders[0].feedback.some((e) => same(e, FINDING)), 'first builder feedback carries the last open review findings') })
check('FN5', () => { assert.ok(same(outcome?.seen.mutations?.mutations, [REPLACEMENT]), 'the proof runs the builder replacement mutation') })
check('FN6', () => {
  assert.deepEqual(outcome?.result, { status: 'done', reason: null, pr: null })
  assert.equal(outcome.calls.includes('publish'), false)
  assert.ok(outcome.rows.some((r) => r.event === 'finish-ready' && r.status === 'ready-for-operator'), 'journal rows say ready for the operator')
  assert.equal(outcome.rows.some((r) => r.event === 'pr'), false)
})

// ---- FN7-FN9: crew/finish.mjs refusals on temp lane fixtures ----
let finishLane = null
try { finishLane = (await import(pathToFileURL(join(root, 'crew/finish.mjs')))).finishLane } catch { finishLane = null }

const PLANNER = {
  role: 'planner', id: 'lane.planner.1', status: 'done', summary: 'planned',
  details: {
    subject: 'fix(crew): planned lane', plan_path: '/virtual/task/plan.md', gate_path: '/virtual/task/gate.mjs',
    acceptance: ['A1'], mutations: [PLANNED_MUTATION],
    files_in_scope: ['lib.mjs'], validation_lane: 'node --test lane.test.mjs', gate_cmd: 'node gate.mjs',
  },
}
function fixture({ stage = 'mutations', builder = true, worktreeExists = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'crew-finish-gate-'))
  const lane = 'lane9'
  const crewRoot = join(base, 'crew')
  const taskDir = join(crewRoot, `dt-${lane}`, lane, 'task')
  const worktree = join(base, 'worktree')
  mkdirSync(taskDir, { recursive: true })
  if (worktreeExists) mkdirSync(worktree, { recursive: true })
  writeFileSync(join(crewRoot, `dt-${lane}`, lane, 'crew.json'), JSON.stringify({ members: { builder: { agent: 'pi', model: 'test/builder', transport: 'lean-acp' }, reviewer: { agent: 'pi', model: 'test/reviewer', transport: 'lean-acp' } } }))
  const spec = { id: lane, cwd: worktree, taskDir, tier: 'build', shape: 'standard', brief: 'x', acceptance: ['A1'], source: 's', branch: lane, base: 'main', closes: [], suite: { command: 'npm', args: ['test'] } }
  writeFileSync(join(taskDir, 'lean.json'), JSON.stringify(spec))
  writeFileSync(join(taskDir, 'planner-1.json'), JSON.stringify(PLANNER))
  const rows = [{ event: 'run-start', lane, stage: null, at: 1, run_id: lane }]
  if (builder) rows.push({ event: 'envelope', lane, stage: 'build', role: 'builder', id: `${lane}.builder.2`, parsed: { role: 'builder', id: `${lane}.builder.2`, status: 'done', summary: 'built', details: { summary: 'built' } }, defects: [], error: null })
  rows.push({ event: 'verdict', lane, stage: 'review', status: 'reviewed', verdict: 'changes-needed', findings: [FINDING] })
  rows.push({ event: 'verdict', lane, stage, status: 'stopped', reason: STOP.reason, observation: STOP.observation })
  writeFileSync(join(taskDir, 'journal.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return { base, crewRoot, lane }
}
async function refusalFor(options) {
  const f = fixture(options)
  try {
    assert.equal(typeof finishLane, 'function', 'crew/finish.mjs exports finishLane')
    let error = null
    try { await finishLane({ lane: f.lane, root: f.crewRoot, deps: { spawnDetached: () => 4242, log: () => {} } }) } catch (e) { error = e }
    assert.ok(error, 'finishLane refuses')
    return error
  } finally { rmSync(f.base, { recursive: true, force: true }) }
}
const refusedWith = (error, code) => error?.reason === code || error?.code === code || String(error?.message ?? '').includes(code)
// Async refusal checks run below; FN7-FN9 are settled before printing.
const asyncChecks = [
  ['FN7', async () => refusedWith(await refusalFor({ builder: false }), 'finish-no-build')],
  ['FN8', async () => refusedWith(await refusalFor({ stage: 'plan', builder: false }), 'finish-premise')],
  ['FN9', async () => refusedWith(await refusalFor({ worktreeExists: false }), 'finish-worktree')],
]
for (const [id, fn] of asyncChecks) {
  let ok = false
  try { ok = await fn() } catch { ok = false }
  if (!ok) failed.add(id)
}

for (const id of IDS) if (failed.has(id)) console.log(`FAIL ${id}`)
process.exitCode = failed.size ? 1 : 0
