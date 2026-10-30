// Gate for RB1-RB3: after a head-moving rebase, gate+suite rerun before publish / finish-ready;
// a red post-rebase check stops the lane; an unchanged head costs no rerun.
// Behavioural: drives runLoop from the checkout in process.cwd() with fake seams.
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { runLoop } = await import(pathToFileURL(join(process.cwd(), 'crew/loop.mjs')).href)

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const PR = { number: 73, url: 'https://example.test/pr/73', state: 'OPEN', headRefName: 'lane', baseRefName: 'main' }
const green = () => ({ status: 'green', reason: null, code: 0, signal: null, stdout: '', stderr: '', timedOut: false })
const redSuite = () => ({ ...green(), status: 'red', code: 1, reason: 'exit-nonzero' })
const redGate = () => ({ ...green(), status: 'red', code: 1, reason: 'gate-failed', failingIds: ['A1'] })
const MUTATION = { check: 'A1', file: 'lib.mjs', find: 'old', replace: 'new' }

function makeRun({ rebaseHead = A, suiteSeq = [green()], gateSeq = [green()], finish = false } = {}) {
  const calls = []
  const rows = []
  const returns = new Map()
  const writes = new Map()
  let gateCalls = 0
  let suiteCalls = 0
  const pick = (seq, n) => structuredClone(seq[Math.min(n, seq.length - 1)])
  const spec = {
    id: 'lane', cwd: '/virtual/checkout', taskDir: '/virtual/task', tier: 'build',
    shape: finish ? 'finish' : 'standard',
    brief: '## Acceptance\n\n- (A1) the lane works\n',
    acceptance: ['A1'], source: 'issue 12', branch: 'lane', base: 'main', closes: [12], refs: [13],
    suite: { command: 'node', args: ['--test', 'lane.test.mjs'] }, timeoutMs: 5000,
    ...(finish ? { finish: { planPath: '/virtual/task/plan.md', gatePath: '/virtual/task/gate.mjs', subject: 'fix(crew): planned lane', mutations: [MUTATION], stop: { reason: 'mutations-survived', observation: null }, findings: [], turnOffset: 0 } } : {}),
  }
  const deps = {
    resolveAgents: () => ({ seats: Object.fromEntries(['planner', 'builder', 'reviewer', 'lead'].map((role) => [role, { agent: 'pi', provider: 'test', id: role, effort: 'high' }])), advisor: null }),
    mkdir: async () => {},
    readFile: async (path) => returns.get(path) ?? '',
    writeFile: async (path, content) => { calls.push('write-report'); writes.set(path, String(content)) },
    journal: async (row) => { rows.push(structuredClone(row)) },
    runSeat: async (request) => {
      calls.push(`seat:${request.role}`)
      const value = {
        role: request.role, id: request.id, status: 'done', summary: 'fixture',
        details: request.role === 'planner' ? { subject: 'fix(crew): planned lane', plan_path: '/virtual/task/plan.md', gate_path: '/virtual/task/gate.mjs', acceptance: ['A1'], mutations: [MUTATION] }
          : request.role === 'builder' ? { summary: 'built' }
          : request.role === 'lead' ? { decision: 'escalate' }
          : { verdict: 'pass', findings: [] },
      }
      returns.set(request.returnPath, JSON.stringify(value))
      return undefined
    },
    checkBaseline: async () => { calls.push('baseline'); return { accepted: true, reason: 'gate-failed', result: { ...green(), status: 'red', code: 1, reason: 'gate-failed', failingIds: ['A1'] } } },
    runGate: async () => { calls.push('gate'); return pick(gateSeq, gateCalls++) },
    proveMutations: async () => { calls.push('mutations'); return { status: 'green', reason: null, rows: [{ check: 'A1', outcome: 'killed', reason: null }] } },
    runSuite: async () => { calls.push('suite'); return pick(suiteSeq, suiteCalls++) },
    commitChanges: async () => { calls.push('commit'); return { status: 'green', reason: null, head: A, files: ['lib.mjs'] } },
    rebaseBranch: async () => { calls.push('rebase'); return { status: 'green', reason: null, head: rebaseHead } },
    openPullRequest: async () => { calls.push('publish'); return { status: 'green', reason: null, pr: PR } },
    run: async (input) => input.args.includes('add')
      ? (calls.push('suite-stage'), green())
      : { ...green(), stdout: ' M lib.mjs\0' },
  }
  return { go: () => runLoop(spec, deps), calls, rows, writes, counts: () => ({ gate: gateCalls, suite: suiteCalls }) }
}

const nth = (calls, name, n) => calls.reduce((acc, c, i) => (c === name ? [...acc, i] : acc), [])[n] ?? -1
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

const checks = {
  async RB1() {
    const f = makeRun({ rebaseHead: B })
    const result = await f.go()
    assert(result.status === 'done' && result.pr?.number === 73, `moved-head run did not publish: ${JSON.stringify(result)}`)
    const { gate, suite } = f.counts()
    assert(gate >= 2, `gate ran ${gate} time(s) after a head-moving rebase, expected a rerun`)
    assert(suite >= 2, `suite ran ${suite} time(s) after a head-moving rebase, expected a rerun before publish`)
    const rebaseAt = nth(f.calls, 'rebase', 0)
    const publishAt = nth(f.calls, 'publish', 0)
    assert(nth(f.calls, 'gate', 1) > rebaseAt && nth(f.calls, 'gate', 1) < publishAt, 'second gate is not between rebase and publish')
    assert(nth(f.calls, 'suite', 1) > rebaseAt && nth(f.calls, 'suite', 1) < publishAt, 'second suite is not between rebase and publish')
    assert(nth(f.calls, 'gate', 1) < nth(f.calls, 'suite', 1), 'post-rebase gate does not precede post-rebase suite')
    const fin = makeRun({ rebaseHead: B, finish: true })
    const finResult = await fin.go()
    assert(finResult.status === 'done' && finResult.pr === null, `moved-head finish run did not finish: ${JSON.stringify(finResult)}`)
    assert(fin.counts().suite >= 2 && fin.counts().gate >= 2, 'finish run did not rerun gate and suite after a head-moving rebase')
    assert(nth(fin.calls, 'suite', 1) > nth(fin.calls, 'rebase', 0) && nth(fin.calls, 'suite', 1) < nth(fin.calls, 'write-report', 0), 'finish rerun is not between rebase and the report write')
    assert(fin.rows.some((r) => r.event === 'finish-ready'), 'finish run emitted no finish-ready')
    assert(!fin.calls.includes('publish'), 'finish run published')
  },
  async RB2() {
    const f = makeRun({ rebaseHead: B, suiteSeq: [green(), redSuite()] })
    const result = await f.go()
    assert(result.status === 'stopped' && result.reason === 'exit-nonzero', `red post-rebase suite did not stop with exit-nonzero: ${JSON.stringify(result)}`)
    assert(!f.calls.includes('publish'), 'published despite a red post-rebase suite')
    const g = makeRun({ rebaseHead: B, gateSeq: [green(), redGate()] })
    const gateResult = await g.go()
    assert(gateResult.status === 'stopped' && gateResult.reason === 'gate-failed', `red post-rebase gate did not stop with gate-failed: ${JSON.stringify(gateResult)}`)
    assert(!g.calls.includes('publish'), 'published despite a red post-rebase gate')
    const fin = makeRun({ rebaseHead: B, finish: true, suiteSeq: [green(), redSuite()] })
    const finResult = await fin.go()
    assert(finResult.status === 'stopped' && finResult.reason === 'exit-nonzero', `finish run did not stop on a red post-rebase suite: ${JSON.stringify(finResult)}`)
    assert(!fin.calls.includes('write-report') && !fin.rows.some((r) => r.event === 'finish-ready'), 'finish run wrote finish-ready despite a red post-rebase suite')
  },
  async RB3() {
    const f = makeRun({ rebaseHead: A })
    const result = await f.go()
    assert(result.status === 'done' && result.pr?.number === 73, `unchanged-head run did not publish: ${JSON.stringify(result)}`)
    const { gate, suite } = f.counts()
    assert(suite === 1, `suite ran ${suite} times when the rebase left the head unchanged, expected exactly once`)
    assert(gate === 1, `gate ran ${gate} times when the rebase left the head unchanged, expected exactly once`)
  },
}

let failed = false
for (const [id, check] of Object.entries(checks)) {
  try { await check() } catch (error) { failed = true; console.log(`FAIL ${id}: ${error.message}`) }
}
process.exit(failed ? 1 : 0)
