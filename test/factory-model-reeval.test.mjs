// test/factory-model-reeval.test.mjs — offline injected-dependency coverage for the
// --all-seats re-evaluation cadence. Tests read real disposable bench inputs and
// tracked authored inputs offline without executing their gates; no test probes a
// real endpoint, resolves a worker binary, uses live credentials, or edits audit
// fixtures. Ledger, routing, composition, and roster writes are stubbed through
// explicit dependency seams. The default sweep reads stored rows only; only
// provisioned:true runs benches.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, scratchDir } from './helpers.mjs'
import {
  EvalRefusal,
  benchSha,
  classifyStoredAbsences,
  discoverAuthoredBenches,
  runAllSeats,
} from '../scripts/factory/model-eval.mjs'
import { EVAL_ABSENT_REASONS } from '../scripts/factory/ledger.mjs'

const CANDIDATE_A = { provider: 'anthropic', id: 'claude-sonnet-5', agent: 'claude', effort: 'medium' }
const CANDIDATE_B = { provider: 'anthropic', id: 'claude-haiku-4-5', agent: 'claude', effort: 'medium' }

function makeRow(over = {}) {
  return {
    bench: over.bench ?? 'bench-sha',
    role: 'builder',
    provider: CANDIDATE_A.provider,
    model_id: CANDIDATE_A.id,
    agent: CANDIDATE_A.agent,
    effort: CANDIDATE_A.effort,
    production: 0,
    task_sha: 'task-sha',
    envelope_status: over.absent_reason == null ? 'received' : 'absent',
    absent_reason: over.absent_reason ?? null,
    error_text: over.error_text ?? null,
    asserts_declared: over.asserts_declared ?? null,
    asserts_passed: over.asserts_passed ?? null,
    judge_findings: null,
    billed_input_tokens: null,
    billed_output_tokens: null,
    billed_cache_read_tokens: null,
    billed_cache_write_tokens: null,
    duration_ms: over.duration_ms ?? null,
    ...over,
  }
}

// MUTATION: restore cwd-relative default metadata reads; external-cwd admission must fail.
test('P1 default readers admit tracked benches from a different cwd without writes', () => {
  const root = childSweep(ROOT)
  const external = childSweep(scratchDir('factory-reeval-p1-'))
  assert.ok(root.dirs.length > 0)
  for (const result of [root, external]) {
    assert.equal(result.report.seat_reports.length, result.dirs.length)
    assert.ok(result.report.seat_reports.every((seat) => seat.refusal === null))
    assert.equal(result.writes, 0)
  }
  assert.equal(external.report.seat_reports.length, root.report.seat_reports.length)
})

// MUTATION: report absolute resolved seat identifiers; reports and candidates stay checkout-relative.
test('P2 reports and candidate rows retain discovered relative seat identifiers', () => {
  const cwd = scratchDir('factory-reeval-p2-')
  const dry = childSweep(cwd)
  assert.deepEqual(dry.report.seat_reports.map((seat) => seat.seat), dry.dirs)
  assert.deepEqual(dry.report.seat_reports.map((seat) => seat.path), dry.dirs)
  assert.ok(dry.dirs.every((dir) => !dir.startsWith('/')))
  const rows = childSweep(cwd, 'rows')
  assert.equal(rows.report.candidate_rows.length, rows.dirs.length)
  assert.deepEqual(rows.report.candidate_rows.map((row) => row.seat), rows.dirs)
})

// MUTATION: pass relative args.dir to the default runBench; provisioned reads must reach the offline gate.
test('P3 default provisioned runner reaches the injected offline gate refusal', () => {
  const result = childSweep(scratchDir('factory-reeval-p3-'), 'gate')
  assert.ok(result.dirs.length > 0)
  assert.equal(result.report.seat_reports.length, result.dirs.length)
  assert.ok(result.report.seat_reports.every((seat) => seat.refusal === 'no-mechanical-gate' && seat.refusal_detail.includes('offline gate sentinel')))
  assert.equal(result.writes, 0)
})

// MUTATION: resolve the injected metadata argument; injected readers and runners must receive relative dirs.
test('P4 injected readers and runners continue receiving relative discovered dirs', () => {
  const result = childSweep(scratchDir('factory-reeval-p4-'), 'injected')
  assert.ok(result.dirs.length > 0)
  assert.deepEqual(result.seenMeta, result.dirs)
  assert.deepEqual(result.seenRunner, result.dirs)
})

function metaFor(dir, over = {}) {
  return {
    sha: `sha-${dir.replace(/[^a-z0-9]+/gi, '-')}`,
    role: 'builder',
    tier: 'build',
    candidates: [CANDIDATE_A],
    production: 'anthropic/claude-sonnet-5',
    source: null,
    ...over,
  }
}

function stubLedger() {
  const writes = []
  const reads = []
  return {
    writes,
    reads,
    ledger: {
      recordEvalCell: async (row) => { writes.push(row); return { ok: true } },
      evalCells: async (args) => { reads.push(args); return [] },
    },
  }
}

function childSweep(cwd, mode = 'dry') {
  const moduleUrl = pathToFileURL(join(ROOT, 'scripts/factory/model-eval.mjs')).href
  const source = `
    const { runAllSeats, discoverAuthoredBenches } = await import(${JSON.stringify(moduleUrl)});
    const [checkout, mode] = process.argv.slice(1);
    const writes = [], seenMeta = [], seenRunner = [];
    const deps = {
      ledger: { recordEvalCell: async (row) => { writes.push(row); return { ok: true }; }, evalCells: async () => [] },
      readStoredRows: async ({ benches }) => mode === 'rows' ? benches.map((bench) => ({ bench, role:'builder', provider:'anthropic', model_id:'m', agent:'claude', effort:'medium', production:0, task_sha:'t', envelope_status:'received', absent_reason:null, asserts_declared:1, asserts_passed:1 })) : [],
      loadRoutingPolicy: () => ({ policy: { routes: {} }, policyHash: 'a'.repeat(64) }),
      materialiseRoutingChoice: async () => ({ outcome:'abstained', chosen_cell:null }),
      readRosterText: () => JSON.stringify({ schema_version:1, tiers:{ build:{ builder:null } } }),
      readLadder: () => ({ degraded:false, error:null }),
      composeMoves: async () => ({ ok:true, patch:null, branch:null, commit_subject:null, checks:[], refusals:[] }),
    };
    if (mode === 'injected') {
      deps.readBenchMeta = async (dir) => { seenMeta.push(dir); return { sha:'sha-'+dir, role:'builder', tier:'build', candidates:[], production:'anthropic/m' }; };
      deps.runBench = async ({dir}) => { seenRunner.push(dir); return { cells:[], role:'builder', tier:'build' }; };
    }
    if (mode === 'gate') deps.runGate = () => { throw new Error('offline gate sentinel'); };
    const dirs = await discoverAuthoredBenches({ checkout });
    const report = await runAllSeats({ checkout, provisioned: mode === 'gate' || mode === 'injected', deps });
    console.log(JSON.stringify({ dirs, report, writes:writes.length, seenMeta, seenRunner }));
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, ROOT, mode], { cwd, encoding: 'utf8', timeout: 30000 })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout.trim().split('\\n').at(-1))
}

function offlineDeps(over = {}) {
  const { ledger } = stubLedger()
  return {
    ledger,
    readStoredRows: async () => [],
    loadRoutingPolicy: () => ({ policy: { routes: {} }, policyHash: 'a'.repeat(64) }),
    materialiseRoutingChoice: async () => ({ outcome: 'abstained', chosen_cell: null }),
    readRosterText: () => JSON.stringify({ schema_version: 1, tiers: { build: { builder: null } } }),
    readLadder: () => ({ degraded: false, error: null }),
    composeMoves: async () => ({ ok: true, patch: null, branch: null, commit_subject: null, checks: [], refusals: [] }),
    ...over,
  }
}

test('A1 unavailable execution keeps null metrics with one closed current reason', async () => {
  const checkout = scratchDir('factory-reeval-a1-')
  const dir = 'bench/alpha'
  const deps = offlineDeps({
    listTrackedFiles: async () => [`${dir}/candidates.json`],
    readBenchMeta: async () => metaFor(dir),
    runBench: async () => ({
      bench: 'bench-sha',
      role: 'builder',
      tier: 'build',
      candidates: [CANDIDATE_A],
      cells: [makeRow({ absent_reason: 'seat-runner-failed', error_text: 'endpoint dead' })],
    }),
  })
  const report = await runAllSeats({ provisioned: true, checkout, deps })
  assert.equal(report.candidate_rows.length, 1)
  const [row] = report.candidate_rows
  assert.equal(row.asserts_passed, null)
  assert.equal(row.asserts_declared, null)
  assert.equal(row.duration_ms, null)
  assert.ok(EVAL_ABSENT_REASONS.includes(row.absent_reason))
  assert.equal(row.absent_reason, 'seat-runner-failed')
  assert.deepEqual(row.rate, { numerator: null, denominator: null, value: null })
  for (const metric of [row.asserts_declared, row.asserts_passed, row.duration_ms, row.rate.numerator, row.rate.denominator, row.rate.value]) {
    assert.ok(metric === null, 'a missing metric stays null, never a zero-valued synthetic')
  }
})

test('B1 proposal composes a diff without applying or writing the roster', async () => {
  const checkout = scratchDir('factory-reeval-b1-')
  const dir = 'bench/alpha'
  const meta = metaFor(dir)
  const rosterText = JSON.stringify({
    schema_version: 1,
    tiers: { build: { builder: { provider: 'anthropic', id: 'old-model', agent: 'claude', effort: 'high' } } },
  })
  const chosen = { provider: 'anthropic', id: 'new-model', agent: 'claude', effort: 'high' }
  const composeCalls = []
  const deps = offlineDeps({
    listTrackedFiles: async () => [`${dir}/candidates.json`],
    readBenchMeta: async () => meta,
    readStoredRows: async () => [makeRow({ bench: meta.sha, model_id: 'new-model', asserts_declared: 2, asserts_passed: 2 })],
    materialiseRoutingChoice: async () => ({ outcome: 'chosen', chosen_cell: chosen }),
    readRosterText: () => rosterText,
    composeMoves: async (args) => {
      composeCalls.push(args)
      return { ok: true, patch: 'diff --git crew/roster.json', branch: 'chore/roster', commit_subject: 'chore(roster)', checks: [], refusals: [] }
    },
  })
  const report = await runAllSeats({ checkout, deps })
  assert.equal(typeof report.proposal.patch, 'string')
  assert.equal(report.metadata.mode, 'all-seats')
  assert.equal(composeCalls.length, 1)
  assert.equal(composeCalls[0].breaker, null)
  assert.equal(typeof composeCalls[0].readBreaker, 'function')
  assert.equal(composeCalls[0].readBreaker(), null)
  assert.equal(composeCalls[0].moves.length, 1)
  assert.equal(composeCalls[0].moves[0].cell.id, 'new-model')
  assert.equal(composeCalls[0].rosterText, rosterText)
  assert.equal(await deps.readRosterText(), rosterText)
  assert.ok(!('applyMoves' in deps), 'the sweep has no apply seam to call')
})

test('C1 every discovered seat reports attempted, measured, and absent denominators', async () => {
  const checkout = scratchDir('factory-reeval-c1-')
  const dirs = [
    'docs/audits/2026-09-16/bench/builder',
    'docs/audits/2026-09-16/bench/planner',
    'docs/audits/2026-09-17/bench/builder',
    'docs/audits/2026-09-17/bench/planner',
    'docs/audits/2026-09-21/bench/reviewer',
    'docs/audits/2026-09-21/bench/tech-lead',
  ]
  const metas = new Map(dirs.map((dir) => [dir, metaFor(dir, { role: dir.endsWith('planner') ? 'planner' : dir.endsWith('reviewer') ? 'reviewer' : dir.endsWith('tech-lead') ? 'tech-lead' : 'builder' })]))
  const stored = new Map()
  for (const dir of dirs) {
    const meta = metas.get(dir)
    stored.set(meta.sha, [
      makeRow({ bench: meta.sha, role: meta.role, asserts_declared: 2, asserts_passed: 2 }),
      makeRow({ bench: meta.sha, role: meta.role, provider: CANDIDATE_B.provider, model_id: CANDIDATE_B.id, asserts_declared: 2, asserts_passed: 1 }),
    ])
  }
  // One seat keeps an absent row so the denominator covers all three counters.
  const weak = metas.get(dirs[1])
  stored.set(weak.sha, [
    makeRow({ bench: weak.sha, role: 'planner', asserts_declared: 3, asserts_passed: 3 }),
    makeRow({ bench: weak.sha, role: 'planner', provider: CANDIDATE_B.provider, model_id: CANDIDATE_B.id, absent_reason: 'wait-failed' }),
  ])
  const deps = offlineDeps({
    listTrackedFiles: async () => dirs.map((dir) => `${dir}/candidates.json`),
    readBenchMeta: async (dir) => metas.get(dir),
    readStoredRows: async ({ benches }) => stored.get(benches[0]) ?? [],
    runBench: async () => { throw new Error('default sweep must not run benches') },
  })
  const report = await runAllSeats({ checkout, deps })
  assert.equal(report.metadata.seats_discovered, 6)
  assert.equal(report.seat_reports.length, 6)
  assert.deepEqual(report.seat_reports.map((seat) => seat.seat).sort(), [...dirs].sort())
  for (const seat of report.seat_reports) {
    assert.equal(seat.refusal, null)
    assert.equal(seat.runs_attempted, seat.measured + seat.absent)
  }
  const full = report.seat_reports.find((seat) => seat.seat === dirs[0])
  assert.deepEqual({ attempted: full.runs_attempted, measured: full.measured, absent: full.absent }, { attempted: 2, measured: 2, absent: 0 })
  const partial = report.seat_reports.find((seat) => seat.seat === dirs[1])
  assert.deepEqual({ attempted: partial.runs_attempted, measured: partial.measured, absent: partial.absent }, { attempted: 2, measured: 1, absent: 1 })
  assert.deepEqual(partial.absent_by_reason, { 'wait-failed': 1 })
})

test('D1 only explicit provisioned runs the one-real-cell-per-model check', async () => {
  const checkout = scratchDir('factory-reeval-d1-')
  const dir = 'bench/alpha'
  const meta = metaFor(dir)
  const benchResult = () => ({
    bench: meta.sha,
    role: 'builder',
    tier: 'build',
    candidates: [CANDIDATE_A, CANDIDATE_B],
    cells: [
      makeRow({ bench: meta.sha, asserts_declared: 2, asserts_passed: 2 }),
      makeRow({ bench: meta.sha, provider: CANDIDATE_B.provider, model_id: CANDIDATE_B.id, absent_reason: 'gate-failed' }),
    ],
  })
  const base = {
    listTrackedFiles: async () => [`${dir}/candidates.json`],
    readBenchMeta: async () => meta,
    runBench: async () => benchResult(),
  }
  const unprovisioned = await runAllSeats({ checkout, deps: offlineDeps(base) })
  assert.deepEqual(unprovisioned.provisioned_check, { ran: false, refusal: 'provisioned-flag-required' })
  const provisioned = await runAllSeats({ provisioned: true, checkout, deps: offlineDeps(base) })
  assert.equal(provisioned.provisioned_check.ran, true)
  assert.equal(provisioned.provisioned_check.ok, false)
  assert.equal(provisioned.provisioned_check.refusal, 'provisioned-incomplete')
  assert.ok(provisioned.provisioned_check.missing.some((entry) => entry.model === 'anthropic/claude-haiku-4-5'))
})

test('E1 stored absences keep a 24-row denominator with seat-refused as legacy only', () => {
  const rows = []
  for (let index = 0; index < 15; index += 1) rows.push({ absent_reason: null, asserts_passed: 2, asserts_declared: 2 })
  for (let index = 0; index < 3; index += 1) rows.push({ absent_reason: 'wait-failed' })
  rows.push({ absent_reason: 'judge-not-briefed' })
  rows.push({ absent_reason: 'boot-failed' })
  for (let index = 0; index < 4; index += 1) rows.push({ absent_reason: 'seat-refused' })
  const classified = classifyStoredAbsences(rows)
  assert.equal(classified.total, 24)
  assert.equal(classified.measured, 15)
  assert.deepEqual(classified.legacy_reasons, { 'seat-refused': 4 })
  assert.deepEqual(classified.current_reasons, { 'wait-failed': 3, 'judge-not-briefed': 1, 'boot-failed': 1 })
  assert.ok(!Object.hasOwn(classified.current_reasons, 'seat-refused'))
  assert.equal(classified.measured + classified.current_total + classified.legacy_total, 24)
  assert.match(classified.policy, /retained/)
  assert.match(classified.policy, /unmeasured/)
  assert.match(classified.policy, /not current/)
})

test('F1 discovery dedupes, sorts, and sweeps each authored bench exactly once', async () => {
  const checkout = scratchDir('factory-reeval-f1-')
  const seen = []
  const metas = new Map([
    'docs/audits/2026-09-16/bench/builder',
    'docs/audits/2026-09-16/bench/planner',
    'docs/audits/2026-09-17/bench/builder',
    'docs/audits/2026-09-17/bench/planner',
  ].map((dir) => [dir, metaFor(dir)]))
  const deps = offlineDeps({
    listTrackedFiles: async () => [
      'docs/audits/2026-09-17/bench/planner/candidates.json',
      'docs/audits/2026-09-16/bench/builder/candidates.json',
      'docs/audits/2026-09-16/bench/builder/candidates.json',
      'docs/audits/2026-09-16/bench/planner/candidates.json',
      'docs/audits/2026-09-17/bench/builder/candidates.json',
      'README.md',
      'docs/audits/2026-09-16/bench/builder/notes.json',
    ],
    readBenchMeta: async (dir) => { seen.push(dir); return metas.get(dir) },
    runBench: async () => { throw new Error('default sweep must not run benches') },
  })
  const discovered = await discoverAuthoredBenches({ checkout, deps })
  assert.deepEqual(discovered, [
    'docs/audits/2026-09-16/bench/builder',
    'docs/audits/2026-09-16/bench/planner',
    'docs/audits/2026-09-17/bench/builder',
    'docs/audits/2026-09-17/bench/planner',
  ])
  await runAllSeats({ checkout, deps })
  assert.deepEqual([...seen].sort(), discovered)
  assert.equal(new Set(seen).size, 4)
})

test('G1 package cadence aliases the all-seats sweep', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts['model:reeval'], 'node scripts/factory/model-eval.mjs --all-seats')
})

test('H1 a bench-level refusal names its reason and writes zero eval cells', async () => {
  const checkout = scratchDir('factory-reeval-h1-')
  const stub = stubLedger()
  const runBenchCalls = []
  const deps = offlineDeps({
    ledger: stub.ledger,
    listTrackedFiles: async () => ['bench/alpha/candidates.json'],
    readBenchMeta: async () => { throw new EvalRefusal('production-absent', 'the seated model is not among candidates') },
    runBench: async (args) => { runBenchCalls.push(args); throw new Error('must not run') },
  })
  const report = await runAllSeats({ checkout, deps })
  assert.equal(report.seat_reports.length, 1)
  assert.equal(report.seat_reports[0].refusal, 'production-absent')
  assert.equal(report.seat_reports[0].runs_attempted, 0)
  assert.equal(report.candidate_rows.length, 0)
  assert.equal(stub.writes.length, 0)
  assert.equal(runBenchCalls.length, 0)
})

test('I1 same provider and id with a changed agent or effort still reaches composeMoves', async () => {
  const checkout = scratchDir('factory-reeval-i1-')
  const dir = 'bench/alpha'
  const meta = metaFor(dir)
  const seated = { provider: 'anthropic', id: 'claude-sonnet-5', agent: 'claude', effort: 'high' }
  const chosen = { provider: 'anthropic', id: 'claude-sonnet-5', agent: 'claude', effort: 'low' }
  assert.notEqual(JSON.stringify(seated), JSON.stringify(chosen))
  const composeCalls = []
  const deps = offlineDeps({
    listTrackedFiles: async () => [`${dir}/candidates.json`],
    readBenchMeta: async () => meta,
    readStoredRows: async () => [makeRow({ bench: meta.sha, agent: 'claude', effort: 'low', asserts_declared: 2, asserts_passed: 2 })],
    materialiseRoutingChoice: async () => ({ outcome: 'chosen', chosen_cell: chosen }),
    readRosterText: () => JSON.stringify({ schema_version: 1, tiers: { build: { builder: seated } } }),
    composeMoves: async (args) => {
      composeCalls.push(args)
      return { ok: true, patch: 'diff --git crew/roster.json', branch: 'chore/roster', commit_subject: 'chore(roster)', checks: [], refusals: [] }
    },
  })
  const report = await runAllSeats({ checkout, deps })
  assert.equal(composeCalls.length, 1)
  assert.equal(composeCalls[0].moves.length, 1)
  assert.deepEqual(composeCalls[0].moves[0].cell, chosen)
  assert.equal(typeof report.proposal.patch, 'string')
})

test('J1 default all-seats runs no bench, writes no rows, and names unmeasured seats', async () => {
  const checkout = scratchDir('factory-reeval-j1-')
  const stub = stubLedger()
  const runBenchCalls = []
  const dirs = ['bench/one', 'bench/two']
  const metas = new Map(dirs.map((dir) => [dir, metaFor(dir)]))
  const deps = offlineDeps({
    ledger: stub.ledger,
    listTrackedFiles: async () => dirs.map((dir) => `${dir}/candidates.json`),
    readBenchMeta: async (dir) => metas.get(dir),
    readStoredRows: async () => [],
    runBench: async (args) => { runBenchCalls.push(args); throw new Error('default sweep must not run benches') },
  })
  const report = await runAllSeats({ checkout, deps })
  assert.equal(runBenchCalls.length, 0)
  assert.equal(stub.writes.length, 0)
  assert.equal(report.provisioned, false)
  assert.deepEqual(report.provisioned_check, { ran: false, refusal: 'provisioned-flag-required' })
  assert.equal(report.seat_reports.length, 2)
  for (const seat of report.seat_reports) {
    assert.equal(seat.refusal, null)
    assert.equal(seat.runs_attempted, 0)
    assert.equal(seat.measured, 0)
    assert.equal(seat.absent, 0)
    assert.equal(seat.unmeasured_reason, 'no-stored-cells')
  }
  assert.equal(report.candidate_rows.length, 0)
})

test('K1 the npm cadence is allowlisted with the explicit provisioned escape reason', () => {
  const source = readFileSync(join(ROOT, 'test/factory-env.test.mjs'), 'utf8')
  assert.ok(source.includes("'model:reeval'"), 'the cadence name stays pinned as the K1 mutation anchor')
  assert.ok(
    source.includes("['model:reeval', 'dry run by default — running benches requires an explicit -- --provisioned (#1300)']"),
    'the allowlist entry carries the exact read-only reason with its explicit escape',
  )
})

test('RV1-1 real-shape runBench carries the declared non-default tier', async () => {
  const checkout = scratchDir('factory-reeval-rv11-')
  const dir = 'docs/audits/2026-09-17/bench/builder'
  const deps = offlineDeps({
    listTrackedFiles: async () => [`${dir}/candidates.json`],
    // The read-only authority names no tier here; the provisioned runBench
    // return carries the tier it actually admitted and ran.
    readBenchMeta: async () => metaFor(dir, { tier: null }),
    runBench: async () => ({
      bench: 'bench-sha',
      task_sha: 'task-sha',
      role: 'builder',
      tier: 'mechanical',
      routing_choice: { outcome: 'chosen', tier: 'mechanical', role: 'builder' },
      cells: [makeRow({ asserts_declared: 2, asserts_passed: 2 })],
      production: { ...CANDIDATE_A },
    }),
    readFile: () => { throw new Error('candidates.json must not be re-read; provisioned tier comes from runBench') },
  })
  const report = await runAllSeats({ provisioned: true, checkout, deps })
  assert.equal(report.seat_reports.length, 1)
  assert.equal(report.seat_reports[0].tier, 'mechanical')
  assert.equal(report.seat_reports[0].effective_tier, 'mechanical')
})

test('RV1-1 degraded stored ledger is named ledger-degraded, never a silent empty corpus', async () => {
  const checkout = scratchDir('factory-reeval-rv11deg-')
  const dirs = ['bench/one', 'bench/two']
  const metas = new Map(dirs.map((dir) => [dir, metaFor(dir)]))
  const evalCalls = []
  const deps = offlineDeps({
    ledger: {
      recordEvalCell: async () => { throw new Error('default sweep must not write') },
      evalCells: async (args) => { evalCalls.push(args); return [] },
      stats: () => ({ degraded: true, degraded_reason: 'mirror-unreadable', degraded_message: 'mirror down' }),
    },
    listTrackedFiles: async () => dirs.map((dir) => `${dir}/candidates.json`),
    readBenchMeta: async (dir) => metas.get(dir),
    runBench: async () => { throw new Error('default sweep must not run benches') },
  })
  // No readStoredRows seam: the default reader must surface the degraded
  // ledger instead of swallowing it into an empty successful corpus.
  delete deps.readStoredRows
  const report = await runAllSeats({ checkout, deps })
  assert.equal(evalCalls.length, 2)
  assert.equal(report.seat_reports.length, 2)
  for (const seat of report.seat_reports) {
    assert.equal(seat.runs_attempted, 0)
    assert.equal(seat.unmeasured_reason, 'ledger-degraded')
    assert.match(String(seat.stored_error), /mirror-unreadable/)
  }
  assert.ok(!EVAL_ABSENT_REASONS.includes('ledger-degraded'), 'a report reason, never an absence enum member')
  assert.equal(report.candidate_rows.length, 0)
  assert.equal(report.ok, false)
  assert.deepEqual(report.stored_ledger, { ok: false, reason: 'ledger-degraded', seats: [...dirs].sort() })
  assert.equal(report.proposal.note, 'ledger-degraded')
})

test('RV1-2 default sweep opens an uninjected ledger read-only and runs nothing', async () => {
  const checkout = scratchDir('factory-reeval-rv12-')
  const openCalls = []
  const runBenchCalls = []
  const recordCalls = []
  const savedDb = process.env.DEVTEAM_LEDGER_DB
  process.env.DEVTEAM_LEDGER_DB = join(checkout, 'ledger.db')
  try {
    const deps = offlineDeps({
      ledger: undefined,
      openLedger: (options) => {
        openCalls.push(options)
        return {
          recordEvalCell: async (row) => { recordCalls.push(row); return { ok: true } },
          evalCells: async () => [],
          stats: () => ({ degraded: false }),
        }
      },
      listTrackedFiles: async () => ['bench/alpha/candidates.json'],
      readBenchMeta: async () => metaFor('bench/alpha'),
      runBench: async (args) => { runBenchCalls.push(args); throw new Error('default sweep must not run benches') },
    })
    delete deps.readStoredRows
    const report = await runAllSeats({ checkout, deps })
    assert.equal(openCalls.length, 1)
    assert.deepEqual(openCalls[0], { dbPath: join(checkout, 'ledger.db'), readOnly: true })
    assert.equal(runBenchCalls.length, 0)
    assert.equal(recordCalls.length, 0)
    assert.equal(report.seat_reports.length, 1)
    assert.equal(report.seat_reports[0].unmeasured_reason, 'no-stored-cells')
    assert.equal(report.seat_reports[0].stored_error, null)
    assert.equal(report.ok, true)
  } finally {
    if (savedDb === undefined) delete process.env.DEVTEAM_LEDGER_DB
    else process.env.DEVTEAM_LEDGER_DB = savedDb
  }
})

// MUTATION: remove refusedSeats.length === 0; mixed/all-refused successful proposals must fail.
test('W1 refused benches fail mixed and all-refused dry and provisioned sweeps', async () => {
  for (const provisioned of [false, true]) {
    for (const dirs of [['bench/refused', 'bench/admitted'], ['bench/refused']]) {
      const checkout = scratchDir('factory-reeval-w1-')
      const deps = offlineDeps({
        listTrackedFiles: async () => dirs.map((dir) => `${dir}/candidates.json`),
        readBenchMeta: async (dir) => {
          if (dir === 'bench/refused') throw new EvalRefusal('judge-is-candidate', 'fixture self judge')
          return metaFor(dir)
        },
        runBench: async () => ({
          bench: 'sha', role: 'builder', tier: 'build', candidates: [CANDIDATE_A],
          cells: [makeRow({ bench: 'sha', asserts_declared: 1, asserts_passed: 1 })],
        }),
      })
      const report = await runAllSeats({ provisioned, checkout, deps })
      assert.equal(report.ok, false)
      assert.equal(report.metadata.seats_refused, 1)
      assert.equal(report.metadata.seats_admitted, dirs.length - 1)
      if (provisioned) assert.deepEqual(report.provisioned_check, { ran: true, ok: true, real_cells: dirs.length - 1 })
    }
  }
})

// MUTATION: replace admission seats with []; the exact named-seat summary must redden.
test('W2 admission summary names refused seat and preserves its refusal detail', async () => {
  const checkout = scratchDir('factory-reeval-w2-')
  const deps = offlineDeps({
    listTrackedFiles: async () => ['bench/refused/candidates.json', 'bench/admitted/candidates.json'],
    readBenchMeta: async (dir) => {
      if (dir === 'bench/refused') throw new EvalRefusal('judge-is-candidate', 'fixture self judge')
      return metaFor(dir)
    },
  })
  const report = await runAllSeats({ checkout, deps })
  assert.deepEqual(report.admission, { ok: false, reason: 'bench-refused', seats: ['bench/refused'] })
  const refused = report.seat_reports.find((seat) => seat.seat === 'bench/refused')
  assert.equal(refused.refusal, 'judge-is-candidate')
  assert.equal(refused.refusal_detail, 'fixture self judge')
})

// MUTATION: remove readBenchMeta's self-judge refusal; this real digest-valid bench must no longer refuse.
test('W3 real digest-valid self-judging bench is refused without a metadata stub', async () => {
  const checkout = scratchDir('factory-reeval-w3-')
  const dir = join(checkout, 'bench', 'self-judge')
  mkdirSync(dir, { recursive: true })
  const task = 'fixture task\n'
  const gate = 'export default true\n'
  const candidate = { provider: 'anthropic', id: 'claude-sonnet-5', agent: 'claude', effort: 'medium' }
  const judgeText = JSON.stringify({ model: 'anthropic/claude-sonnet-5', vendor: 'anthropic' })
  const candidatesText = JSON.stringify({ schema: 1, role: 'builder', tier: 'build', production: 'anthropic/claude-sonnet-5', candidates: [candidate] })
  writeFileSync(join(dir, 'task.md'), task)
  writeFileSync(join(dir, 'gate.mjs'), gate)
  writeFileSync(join(dir, 'judge.json'), judgeText)
  writeFileSync(join(dir, 'candidates.json'), candidatesText)
  writeFileSync(join(dir, 'bench.sha'), benchSha({ task, gate, judge: judgeText, candidates: candidatesText }))
  const deps = offlineDeps({ listTrackedFiles: async () => [join(dir, 'candidates.json')] })
  const report = await runAllSeats({ checkout, deps })
  assert.equal(report.ok, false)
  assert.equal(report.seat_reports[0].refusal, 'judge-is-candidate')
})

// MUTATION: replace refused-seat clause with && false; admitted success must redden.
test('W4 all-admitted dry sweep succeeds with no stored cells', async () => {
  const checkout = scratchDir('factory-reeval-w4-')
  const deps = offlineDeps({
    listTrackedFiles: async () => ['bench/admitted/candidates.json'],
    readBenchMeta: async () => metaFor('bench/admitted'),
  })
  const report = await runAllSeats({ checkout, deps })
  assert.equal(report.ok, true)
  assert.deepEqual(report.admission, { ok: true })
})
