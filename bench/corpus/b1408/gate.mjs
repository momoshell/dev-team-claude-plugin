// Gate for RB1-RB5. Run from the repo checkout: node <task>/gate.mjs
// Prints one FAIL <id> line per failing acceptance; exits nonzero if any fail.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

function findRoot(start) {
  let dir = start
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'crew/loop.mjs')) && existsSync(join(dir, 'visualizer/server/server.mjs'))) return dir
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return start
}
const root = findRoot(process.cwd())
const failures = []
const check = (id, ok, why) => { if (!ok) failures.push(`FAIL ${id}: ${why}`) }

const green = () => ({ status: 'green', reason: null, code: 0, signal: null, stdout: '', stderr: '', timedOut: false })
const MUTATION = { check: 'A1', file: 'lib.mjs', find: 'old', replace: 'new' }
const PR = { number: 73, url: 'https://example.test/pr/73', state: 'OPEN' }
const FINDING = { id: 'R1', severity: 'must-fix', location: 'lib.mjs:1', summary: 'Fix the defect' }
const bindFail = (c) => ({ check: c, outcome: 'unmeasured', reason: 'bind-fail', occurrences: 0 })
const killed = (c) => ({ check: c, outcome: 'killed', reason: null })
const unbound = (...rows) => ({ status: 'unmeasured', reason: 'mutation-unmeasured', rows })
const killedProof = (...ids) => ({ status: 'green', reason: null, rows: ids.map(killed) })

let runLoop
try {
  ;({ runLoop } = await import(pathToFileURL(join(root, 'crew/loop.mjs')).href))
} catch (error) {
  for (const id of ['RB1', 'RB2', 'RB3', 'RB4', 'RB5']) console.log(`FAIL ${id}: cannot import repo code: ${error.message}`)
  process.exit(1)
}

// Minimal fakes() driving planner/builder/reviewer turns, modelled on crew/loop.test.mjs.
function drive({ proofs, reviews = [] }) {
  const requests = [], rows = [], returns = new Map()
  let proofCalls = 0, reviewCalls = 0
  const sequence = (list, fallback) => list[Math.min(proofCalls++, list.length - 1)] ?? fallback
  const envelope = (request) => ({
    role: request.role, id: request.id, status: 'done', summary: 'fixture',
    details: request.role === 'planner'
      ? { subject: 'fix(crew): planned lane', plan_path: '/virtual/task/plan.md', gate_path: '/virtual/task/gate.mjs', acceptance: ['A1'], mutations: [MUTATION] }
      : request.role === 'builder' ? { summary: 'built' }
        : request.role === 'lead' ? { decision: 'escalate' }
          : { verdict: reviews[reviewCalls++] ?? 'pass', findings: (reviews[reviewCalls - 1] ?? 'pass') === 'changes-needed' ? [FINDING] : [] },
  })
  const measured = (result) => async () => structuredClone(typeof result === 'function' ? result() : result)
  const spec = {
    id: 'lane', cwd: '/virtual/checkout', taskDir: '/virtual/task', tier: 'build', shape: 'standard',
    brief: '## Acceptance\n\n- (A1) the lane works\n', acceptance: ['A1'], source: 'issue 12', branch: 'lane', base: 'main',
    closes: [], refs: [], suite: { command: 'node', args: ['--test', 'lane.test.mjs'] }, timeoutMs: 5000,
  }
  const deps = {
    resolveAgents: () => ({ seats: Object.fromEntries(['planner', 'builder', 'reviewer', 'lead'].map((role) => [role, { agent: 'pi', id: role, rounds: 10 }])), advisor: null }),
    mkdir: async () => {},
    readFile: async (path) => returns.get(path) ?? '',
    writeFile: async () => {},
    journal: async (row) => { rows.push(structuredClone(row)) },
    runSeat: async (request) => { requests.push(structuredClone(request)); returns.set(request.returnPath, JSON.stringify(envelope(request))) },
    checkBaseline: measured({ accepted: true, reason: 'gate-failed', result: { ...green(), status: 'red', code: 1, reason: 'gate-failed', failingIds: ['A1'] } }),
    runGate: measured(green()),
    proveMutations: async () => structuredClone(sequence(proofs, killedProof('A1'))),
    runSuite: measured(green()),
    commitChanges: measured({ status: 'green', reason: null, head: 'a'.repeat(40), files: ['lib.mjs'] }),
    run: measured(() => ({ ...green(), stdout: ' M lib.mjs\0' })),
    rebaseBranch: measured({ status: 'green', reason: null, head: 'b'.repeat(40) }),
    openPullRequest: measured({ status: 'green', reason: null, pr: PR }),
  }
  return { go: () => runLoop(spec, deps), requests, rows, proofCalls: () => proofCalls }
}
const builders = (f) => f.requests.filter((r) => r.role === 'builder')

// RB1: bind-fail -> re-aim -> killed -> review fix -> bind-fail again -> a second re-aim is earned.
try {
  const f = drive({ proofs: [unbound(bindFail('A1')), killedProof('A1'), unbound(bindFail('A1')), killedProof('A1')], reviews: ['changes-needed', 'pass'] })
  const result = await f.go()
  check('RB1', result.status === 'done' && builders(f).length === 4,
    `expected done with 4 builder turns (build, re-aim, review-fix, re-aim), got ${result.status}/${result.reason} with ${builders(f).length}`)
} catch (error) { check('RB1', false, error.message) }

// RB2: bind-fail directly after a re-aim turn stops as mutation-unmeasured (no third builder).
try {
  const f = drive({ proofs: [unbound(bindFail('A1')), unbound(bindFail('A1')), killedProof('A1')] })
  const result = await f.go()
  check('RB2', result.status === 'stopped' && result.reason === 'mutation-unmeasured' && builders(f).length === 2,
    `expected stopped/mutation-unmeasured with 2 builders, got ${result.status}/${result.reason} with ${builders(f).length}`)
} catch (error) { check('RB2', false, error.message) }

// RB3: never two re-aim turns in a row (no consecutive mutation-reaim stages).
try {
  const f = drive({ proofs: [unbound(bindFail('A1')), unbound(bindFail('A1')), killedProof('A1')] })
  const result = await f.go()
  const stages = f.rows.filter((r) => r.event === 'stage-start').map((r) => r.stage)
    .filter((s) => ['build', 'mutation-reaim', 'suite-repair'].includes(s))
  const consecutive = stages.some((s, i) => s === 'mutation-reaim' && stages[i - 1] === 'mutation-reaim')
  check('RB3', result.status === 'stopped' && !consecutive && stages.filter((s) => s === 'mutation-reaim').length === 1,
    `expected exactly one non-consecutive mutation-reaim stage and a stop, got stages=${stages.join(',')} result=${result.status}/${result.reason}`)
} catch (error) { check('RB3', false, error.message) }

// RB4 + RB5: one real server over a temp lean lane; checkout is the repo (agent propose never writes).
let server, sandbox
async function startGateServer() {
  const { startServer } = await import(pathToFileURL(join(root, 'visualizer/server/server.mjs')).href)
  sandbox = mkdtempSync(join(tmpdir(), 'gate-viz-'))
  const crewRoot = join(sandbox, '.crew')
  const laneDir = join(crewRoot, 'dt-gate4', 'gate4')
  mkdirSync(join(laneDir, 'task'), { recursive: true })
  writeFileSync(join(laneDir, 'crew.json'), JSON.stringify({ members: { planner: { agent: 'pi' }, builder: { agent: 'pi' } } }))
  writeFileSync(join(laneDir, 'task', 'lean.json'), JSON.stringify({ id: 'gate4', tier: 'build' }))
  writeFileSync(join(laneDir, 'task', 'journal.jsonl'),
    [{ event: 'stage-start', stage: 'plan' }, { event: 'stage-start', stage: 'build' }].map((r) => JSON.stringify(r)).join('\n') + '\n')
  const handles = startServer({ port: 0, host: '127.0.0.1', crewRoot, home: sandbox, checkout: root, ledgerDb: join(sandbox, 'none', 'ledger.db'), triageDb: join(sandbox, 'side', 'v.db'), shipState: { resolve: async () => new Map() } })
  await new Promise((ok) => handles.server.once('listening', ok))
  return { handles, base: `http://127.0.0.1:${handles.server.address().port}` }
}
try {
  const { handles, base } = await startGateServer()
  server = handles
  const get = async (path) => { const r = await fetch(base + path); return { status: r.status, body: await r.json().catch(() => ({})) } }
  const filtered = await get('/api/events?adw_id=lean%3Agate4&phase_id=1')
  const refusal = filtered.status >= 400 && /phase_id/.test(String(filtered.body.error ?? ''))
    && !(Array.isArray(filtered.body.events) && filtered.body.events.length > 0)
  const unfiltered = await get('/api/events?adw_id=lean%3Agate4')
  check('RB4', refusal && unfiltered.status === 200 && unfiltered.body.events?.length === 2,
    `expected 400 naming phase_id with no events (and 2 rows unfiltered), got phase_id->${filtered.status} ${JSON.stringify(filtered.body).slice(0, 160)} unfiltered->${unfiltered.status}/${unfiltered.body.events?.length}`)

  const post = async (payload) => {
    const r = await fetch(base + '/api/roster/agent/propose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    return { status: r.status, body: await r.json().catch(() => ({})) }
  }
  const missing = await post({ role: 'planner', tier: 'judge', field: 'effort' })
  const refusedMissing = missing.status >= 400 || missing.body.ok === false
  const explicitNull = await post({ role: 'planner', tier: 'judge', field: 'effort', value: null })
  check('RB5', refusedMissing && explicitNull.status === 200 && explicitNull.body.ok === true,
    `expected missing value refused and explicit null accepted, got missing->${missing.status} ${JSON.stringify(missing.body).slice(0, 160)} null->${explicitNull.status}/${explicitNull.body.ok}`)
} catch (error) {
  check('RB4', false, error.message)
  check('RB5', false, error.message)
} finally {
  try {
    server?.server?.closeAllConnections?.()
    if (server?.server) await new Promise((ok) => server.server.close(ok))
    server?.feed?.close?.()
  } catch {}
  if (sandbox) rmSync(sandbox, { recursive: true, force: true })
}

for (const line of failures) console.log(line)
process.exit(failures.length ? 1 : 0)
