// Gate FD1-FD9 — run from repo root: node <this file>. Prints FAIL <id> per failing id, exit 1 if any.
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = process.cwd()
let failed = false
const check = async (id, fn) => { try { await fn() } catch (e) { failed = true; console.log(`FAIL ${id}: ${String(e?.message ?? e).slice(0, 300)}`) } }
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`)

const FINDING = { id: 'R1', severity: 'must-fix', location: 'lib.mjs:1', summary: 'Fix the defect' }
const MUTATION = { check: 'A1', file: 'lib.mjs', find: 'old', replace: 'new' }
const STOP = { reason: 'mutations-survived', observation: { stage: 'mutations', detail: 'A1 survived' } }
const green = () => ({ status: 'green', reason: null, code: 0, signal: null, stdout: '', stderr: '', timedOut: false })

// ---- loop fixture (mirrors crew/loop.test.mjs fakes) ----
async function runFinishLoop({ reviews = ['pass'], guidance, priorReviewRounds } = {}) {
  const { runLoop } = await import(pathToFileURL(join(REPO, 'crew/loop.mjs')).href)
  const rows = [], requests = [], writes = new Map(), returns = new Map(), seen = {}
  let ri = 0
  const spec = {
    id: 'lane', cwd: '/virtual/checkout', taskDir: '/virtual/task', tier: 'build', shape: 'finish', brief: 'b',
    acceptance: ['A1'], source: 's', branch: 'lane', base: 'main', closes: [], refs: [],
    suite: { command: 'node', args: ['--test'] }, timeoutMs: 5000,
    finish: { planPath: '/virtual/task/plan.md', gatePath: '/virtual/task/gate.mjs', subject: 'fix(crew): planned lane', mutations: [MUTATION], stop: STOP, findings: [FINDING], turnOffset: 3, ...(guidance !== undefined ? { guidance } : {}), ...(priorReviewRounds !== undefined ? { priorReviewRounds } : {}) },
  }
  const envelope = (req) => {
    if (req.role === 'builder') return { role: req.role, id: req.id, status: 'done', summary: 'x', details: { summary: 'built' } }
    const verdict = reviews[Math.min(ri++, reviews.length - 1)]
    return { role: req.role, id: req.id, status: 'done', summary: 'x', details: { verdict, findings: verdict === 'changes-needed' ? [FINDING] : [] } }
  }
  const measured = (name, result) => async (input) => { seen[name] = structuredClone(input); return structuredClone(result) }
  const deps = {
    resolveAgents: () => ({ seats: { builder: { agent: 'pi', provider: 't', id: 'builder', effort: 'high' }, reviewer: { agent: 'pi', provider: 't', id: 'reviewer', effort: 'high' } }, advisor: null }),
    mkdir: async () => {},
    readFile: async (p) => returns.get(p) ?? '',
    writeFile: async (p, c) => { writes.set(p, String(c)) },
    journal: async (row) => { rows.push(structuredClone(row)) },
    runSeat: async (req) => { requests.push(structuredClone(req)); const v = envelope(req); returns.set(req.returnPath, JSON.stringify(v)); return undefined },
    checkBaseline: measured('baseline', green()), runGate: measured('gate', green()),
    proveMutations: measured('mutations', { status: 'green', reason: null, rows: [{ check: 'A1', outcome: 'killed', reason: null }] }),
    runSuite: measured('suite', green()),
    commitChanges: measured('commit', { status: 'green', reason: null, head: 'a'.repeat(40) }),
    run: async () => green(),
    rebaseBranch: measured('rebase', { status: 'green', reason: null, head: 'b'.repeat(40) }),
    openPullRequest: measured('publish', { status: 'green', reason: null, pr: { number: 1, url: 'https://github.com/o/r/pull/1' } }),
  }
  // run() must answer git status probes with a changed path
  deps.run = async (input) => input?.args?.includes('status') ? { ...green(), stdout: ' M lib.mjs\0' } : green()
  const result = await runLoop(spec, deps)
  return { result, rows, requests, writes, seen }
}

// ---- ready-lane fixture for crew/finish.mjs decisions ----
const PR = { number: 73, url: 'https://github.com/o/r/pull/73', state: 'OPEN', headRefName: 'lane9', baseRefName: 'main' }
const PLANNER = { role: 'planner', id: 'lane9.planner.1', status: 'done', summary: 'p', details: { subject: 'fix(crew): planned lane', plan_path: '/t/plan.md', gate_path: '/t/gate.mjs', acceptance: ['A1'], mutations: [MUTATION] } }
function readyFixture({ ready = true, decided = false, trailingStop = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'gate-finish-'))
  const root = join(base, 'crew'); const taskDir = join(root, 'dt-lane9', 'lane9', 'task'); const cwd = join(base, 'wt')
  mkdirSync(taskDir, { recursive: true }); mkdirSync(cwd)
  const spec = { id: 'lane9', cwd, taskDir, tier: 'build', shape: 'standard', brief: 'x', acceptance: ['A1'], source: 's', branch: 'lane9', base: 'main', closes: [], refs: [], suite: { command: 'npm', args: ['test'] } }
  writeFileSync(join(taskDir, 'lean.json'), JSON.stringify(spec))
  writeFileSync(join(taskDir, 'planner-1.json'), JSON.stringify(PLANNER))
  const rows = [
    { event: 'run-start', stage: null },
    { event: 'envelope', role: 'planner', id: 'lane9.planner.1', parsed: PLANNER, defects: [], error: null },
    { event: 'envelope', role: 'builder', id: 'lane9.builder.2', parsed: { status: 'done' }, defects: [], error: null },
    { event: 'verdict', stage: 'review', status: 'reviewed', verdict: 'changes-needed', findings: [FINDING] },
    { event: 'verdict', stage: 'mutations', status: 'stopped', reason: STOP.reason, observation: STOP.observation },
  ]
  if (ready) rows.push({ event: 'commit', stage: 'commit', head: 'a'.repeat(40) }, { event: 'finish-ready', stage: null, status: 'ready-for-operator', head: 'b'.repeat(40), subject: 'fix(crew): planned lane', body: 'MEASURED BODY', reviewRounds: 1 })
  if (decided) rows.push({ event: 'finish-decision', lane: 'lane9', choice: 'abandon', notesSha256: null })
  if (trailingStop) rows.push({ event: 'verdict', stage: null, status: 'stopped', reason: 'round-bound' })
  writeFileSync(join(taskDir, 'journal.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const published = [], spawned = []
  const deps = {
    openPullRequest: async (input) => { published.push(structuredClone(input)); return { status: 'green', reason: null, pr: PR } },
    spawnDetached: (file, args, opts) => { spawned.push({ file, args, opts }); return 4242 }, log: () => {},
    run: async ({ args }) => ({ status: 'green', reason: null, stdout: args[0] === 'rev-parse' ? `${'b'.repeat(40)}\n` : '' }),
  }
  return { base, root, taskDir, cwd, published, spawned, deps }
}
const journalOf = (f) => readFileSync(join(f.taskDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
async function decide(f, args) {
  const mod = await import(pathToFileURL(join(REPO, 'crew/finish.mjs')).href)
  assert(typeof mod.decideFinish === 'function', 'crew/finish.mjs does not export decideFinish')
  return mod.decideFinish({ lane: 'lane9', root: f.root, deps: f.deps, ...args })
}
const sha = (t) => createHash('sha256').update(t).digest('hex')

await check('FD1', async () => {
  const f = await runFinishLoop({ reviews: ['changes-needed', 'pass'] })
  eq(f.result.status, 'done', 'finish run not done')
  const raw = f.writes.get('/virtual/task/finish-report.json')
  assert(raw, 'no finish-report.json written in the lane task dir')
  const report = JSON.parse(raw)
  eq(report.stop?.reason, STOP.reason, 'report does not name the stop reason it finished')
  assert(Array.isArray(report.measurements) && report.measurements.some((m) => String(m).includes('Gate')) && report.measurements.some((m) => String(m).includes('Mutations')) && report.measurements.some((m) => String(m).includes('Suite')), 'report lacks gate/proof/suite measurements')
})
await check('FD2', async () => {
  const f = await runFinishLoop({ reviews: ['changes-needed', 'pass'] })
  const raw = f.writes.get('/virtual/task/finish-report.json')
  assert(raw, 'no finish-report.json written')
  eq(JSON.parse(raw).reviews, [{ verdict: 'changes-needed', findings: [FINDING] }, { verdict: 'pass', findings: [] }], 'report does not list each review verdict with its findings')
})
await check('FD3', async () => {
  const f = readyFixture(); try {
    await decide(f, { choice: 'accept' })
    eq(f.published.length, 1, 'accept did not publish exactly once')
    eq(f.published[0].title, 'fix(crew): planned lane', 'PR title is not the finish run subject')
    eq(f.published[0].body, 'MEASURED BODY', 'PR body is not the measured body verbatim (no notes)')
  } finally { rmSync(f.base, { recursive: true, force: true }) }
})
await check('FD4', async () => {
  const f = readyFixture(); try {
    const notes = join(f.base, 'notes.md'); writeFileSync(notes, 'operator learned X')
    await decide(f, { choice: 'accept', file: notes })
    eq(f.published[0]?.body, 'MEASURED BODY\n\n## Operator notes\n\noperator learned X', 'notes not under their own heading in the PR body')
    const dec = journalOf(f).find((r) => r.event === 'finish-decision')
    eq(dec?.notesSha256, sha('operator learned X'), 'decision row lacks the notes sha256 digest')
  } finally { rmSync(f.base, { recursive: true, force: true }) }
})
await check('FD5', async () => {
  const f = readyFixture(); try {
    await decide(f, { choice: 'accept' })
    const prs = journalOf(f).filter((r) => r.event === 'pr')
    eq(prs.at(-1)?.pr, PR, 'accept appended no pr row that crew closeout reads as the lane PR')
  } finally { rmSync(f.base, { recursive: true, force: true }) }
})
await check('FD6', async () => {
  const f = readyFixture(); try {
    await decide(f, { choice: 'abandon' })
    const dec = journalOf(f).filter((r) => r.event === 'finish-decision')
    eq(dec, [{ event: 'finish-decision', lane: 'lane9', choice: 'abandon', notesSha256: null }], 'abandon decision row missing/wrong')
    eq([f.published.length, f.spawned.length], [0, 0], 'abandon published or spawned')
  } finally { rmSync(f.base, { recursive: true, force: true }) }
})
await check('FD7', async () => {
  const f = readyFixture(); try {
    const guide = join(f.base, 'return.md'); writeFileSync(guide, 'Fix the widget first')
    await decide(f, { choice: 'return', file: guide })
    eq(f.spawned.length, 1, 'return did not start a finish run')
    const spec = JSON.parse(readFileSync(join(f.taskDir, 'finish.json'), 'utf8'))
    eq(spec.finish?.guidance, 'Fix the widget first', 'return guidance not in the finish spec')
    eq(spec.finish?.priorReviewRounds, 1, 'return pass does not count prior review rounds against the cap')
  } finally { rmSync(f.base, { recursive: true, force: true }) }
  const loop = await runFinishLoop({ reviews: ['changes-needed', 'changes-needed'], guidance: 'Fix the widget first', priorReviewRounds: 2 })
  const first = loop.requests.find((r) => r.role === 'builder')
  assert(first?.feedback?.some((e) => e?.id === 'finish-return' && e?.guidance === 'Fix the widget first'), 'builder first feedback does not carry the return file text')
  eq(loop.requests.filter((r) => r.role === 'reviewer').length, 1, 'return pass granted review rounds beyond the three-round cap')
  eq(loop.result.reason, 'round-bound', 'return pass did not stop at the review cap')
})
await check('FD8', async () => {
  for (const opts of [{ ready: false }, { trailingStop: true }]) {
    const f = readyFixture(opts); try {
      let reason = null; try { await decide(f, { choice: 'accept' }) } catch (e) { reason = e?.reason }
      eq(reason, 'finish-not-ready', `decision on a non-ready lane not refused finish-not-ready (${JSON.stringify(opts)})`)
      eq([f.published.length, f.spawned.length], [0, 0], 'refused decision published or spawned')
    } finally { rmSync(f.base, { recursive: true, force: true }) }
  }
})
await check('FD9', async () => {
  const f = readyFixture(); try {
    await decide(f, { choice: 'abandon' })
    let reason = null; try { await decide(f, { choice: 'accept' }) } catch (e) { reason = e?.reason }
    eq(reason, 'finish-decided', 'second decision not refused finish-decided')
    eq(f.published.length, 0, 'second decision published')
  } finally { rmSync(f.base, { recursive: true, force: true }) }
  const g = readyFixture({ decided: true }); try {
    let reason = null; try { await decide(g, { choice: 'abandon' }) } catch (e) { reason = e?.reason }
    eq(reason, 'finish-decided', 'decision after an earlier decision not refused finish-decided')
  } finally { rmSync(g.base, { recursive: true, force: true }) }
})

process.exitCode = failed ? 1 : 0
