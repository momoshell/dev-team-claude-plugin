// Gate for RA1-RA5: drives crew/loop.mjs runLoop with in-memory fakes (mirroring crew/loop.test.mjs fakes()).
// Run with cwd = checkout root. Prints one FAIL <id> per failing acceptance, exits nonzero if any fail.
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { runLoop } = await import(pathToFileURL(join(process.cwd(), 'crew/loop.mjs')).href)

const PR = { number: 73, url: 'https://example.test/pr/73', state: 'OPEN', headRefName: 'lane', baseRefName: 'main' }
const green = () => ({ status: 'green', reason: null, code: 0, signal: null, stdout: '', stderr: '', timedOut: false })
const MUT = (id) => ({ check: id, file: 'lib.mjs', find: `old-${id}`, replace: `new-${id}` })
const bindFail = (id) => ({ check: id, outcome: 'unmeasured', reason: 'bind-fail', occurrences: 0 })
const killed = (id) => ({ check: id, outcome: 'killed', reason: null })
const proofBindFail = (ids) => ({ status: 'unmeasured', reason: 'mutation-unmeasured', rows: ids.map(bindFail) })
const proofKilled = (ids) => ({ status: 'green', reason: null, rows: ids.map(killed) })

function makeRun({ acceptance = ['A1'], proof, onBuilder = null, builderRounds = 2 }) {
  const requests = [], proofInputs = [], returns = new Map()
  let builderTurns = 0, proofCalls = 0
  const spec = {
    id: 'lane', cwd: '/virtual/checkout', taskDir: '/virtual/task', tier: 'build', shape: 'standard', brief: 'operator task',
    acceptance, source: 'issue 12', branch: 'lane', base: 'main', closes: [12], refs: [13],
    suite: { command: 'node', args: ['--test', 'lane.test.mjs'] }, timeoutMs: 5000,
  }
  const seats = Object.fromEntries(['planner', 'builder', 'reviewer', 'lead'].map((role) => [role, { agent: 'pi', provider: 'test', id: role, effort: 'high', rounds: role === 'builder' ? builderRounds : 2 }]))
  const deps = {
    resolveAgents: () => ({ seats: structuredClone(seats), advisor: null }),
    mkdir: async () => {},
    readFile: async (path) => returns.get(path) ?? '',
    journal: async () => {},
    runSeat: async (request) => {
      requests.push(structuredClone(request))
      if (requests.length > 20) throw new Error('fixture turn safety bound')
      let details
      if (request.role === 'planner') details = { subject: 'fix(crew): planned lane', plan_path: '/virtual/task/plan.md', gate_path: '/virtual/task/gate.mjs', acceptance: [...acceptance], mutations: acceptance.map(MUT) }
      else if (request.role === 'builder') {
        builderTurns += 1
        details = { summary: 'built' }
        const muts = onBuilder?.(builderTurns, request)
        if (muts !== undefined) details.mutations = muts
      } else if (request.role === 'lead') details = { decision: 'escalate' }
      else details = { verdict: 'pass', findings: [] }
      returns.set(request.returnPath, JSON.stringify({ role: request.role, id: request.id, status: 'done', summary: 'fixture', details }))
      return undefined
    },
    checkBaseline: async () => ({ accepted: true, reason: 'gate-failed', result: { ...green(), status: 'red', code: 1, reason: 'gate-failed', failingIds: [...acceptance] } }),
    runGate: async () => ({ ...green(), failingIds: [] }),
    proveMutations: async (input) => { proofCalls += 1; proofInputs.push(structuredClone(input)); return structuredClone(proof(proofCalls, input)) },
    runSuite: async () => green(),
    commitChanges: async () => ({ status: 'green', reason: null, head: 'a'.repeat(40), files: ['lib.mjs'] }),
    run: async () => ({ ...green(), stdout: ' M lib.mjs\0' }),
    rebaseBranch: async () => ({ status: 'green', reason: null, head: 'b'.repeat(40) }),
    openPullRequest: async () => ({ status: 'green', reason: null, pr: PR }),
  }
  return { go: () => runLoop(spec, deps), requests, proofInputs, builderCount: () => requests.filter((r) => r.role === 'builder').length, proofCount: () => proofCalls }
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const REPL = { check: 'A1', file: 'lib.mjs', find: 're-aimed', replace: 'new2' }

const checks = {
  async RA1() {
    const f = makeRun({ builderRounds: 1, proof: (n) => (n === 1 ? proofBindFail(['A1']) : proofKilled(['A1'])) })
    const out = await f.go()
    if (out.status !== 'done') return `run stopped as ${out.reason} instead of completing after re-aim`
    if (f.builderCount() !== 2) return `builder turns = ${f.builderCount()}, expected 2`
    const fb = f.requests.filter((r) => r.role === 'builder')[1]?.feedback ?? []
    if (!fb.some((e) => e?.id === 'A1')) return `re-aim feedback does not name A1: ${JSON.stringify(fb)}`
    return null
  },
  async RA2() {
    const f = makeRun({ proof: (n) => (n === 1 ? proofBindFail(['A1']) : proofKilled(['A1'])), onBuilder: (turn) => (turn === 2 ? [REPL] : undefined) })
    const out = await f.go()
    if (out.status !== 'done') return `run stopped as ${out.reason}`
    if (f.proofCount() !== 2) return `proof calls = ${f.proofCount()}, expected 2`
    if (!eq(f.proofInputs[1]?.mutations, [REPL])) return `second proof mutations = ${JSON.stringify(f.proofInputs[1]?.mutations)}, expected replacement`
    return null
  },
  async RA3() {
    const f = makeRun({
      acceptance: ['A1', 'A2'],
      proof: (n) => (n === 1 ? { status: 'unmeasured', reason: 'mutation-unmeasured', rows: [bindFail('A1'), killed('A2')] } : proofKilled(['A1', 'A2'])),
      onBuilder: (turn) => (turn === 2 ? [{ check: 'A2', file: 'lib.mjs', find: 're-aimed', replace: 'new2' }] : undefined),
    })
    const out = await f.go()
    if (!(out.status === 'stopped' && out.reason === 'envelope-refused')) return `run = ${JSON.stringify(out)}, expected stopped envelope-refused`
    if (f.proofCount() !== 1) return `proof calls = ${f.proofCount()}, expected 1 (no re-proof)`
    return null
  },
  async RA4() {
    const f = makeRun({ proof: () => proofBindFail(['A1']), onBuilder: (turn) => (turn === 2 ? [REPL] : undefined) })
    const out = await f.go()
    if (!(out.status === 'stopped' && out.reason === 'mutation-unmeasured')) return `run = ${JSON.stringify(out)}, expected stopped mutation-unmeasured`
    if (f.builderCount() !== 2) return `builder turns = ${f.builderCount()}, expected exactly 2 (one re-aim)`
    if (f.proofCount() !== 2) return `proof calls = ${f.proofCount()}, expected 2`
    return null
  },
  async RA5() {
    const f = makeRun({
      acceptance: ['A1', 'A2'],
      proof: () => ({ status: 'red', reason: 'mutations-survived', rows: [{ check: 'A1', outcome: 'survived', reason: 'gate-green' }, bindFail('A2')] }),
    })
    const out = await f.go()
    if (!(out.status === 'stopped' && out.reason === 'mutations-survived')) return `run = ${JSON.stringify(out)}, expected stopped mutations-survived`
    if (f.builderCount() !== 1) return `builder turns = ${f.builderCount()}, expected 1 (no re-aim turn)`
    if (f.proofCount() !== 1) return `proof calls = ${f.proofCount()}, expected 1`
    return null
  },
}

let failed = 0
for (const [id, fn] of Object.entries(checks)) {
  let problem = null
  try { problem = await fn() } catch (e) { problem = `threw: ${e?.message ?? e}` }
  if (problem) { failed += 1; console.log(`FAIL ${id}: ${problem}`) }
}
process.exit(failed ? 1 : 0)
