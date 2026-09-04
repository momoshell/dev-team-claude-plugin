// test/factory-model-eval.test.mjs — injected-dependency coverage for the
// serial model-evaluation bench. No test in this file boots a real seat or
// resolves a provider worker.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFileSync, mkdirSync } from 'node:fs'
import { ROOT, scratchDir, sqliteAvailable } from './helpers.mjs'
import {
  benchSha,
  compileBench,
  runBench,
  EvalRefusal,
} from '../scripts/factory/model-eval.mjs'
import { EVAL_ABSENT_REASONS } from '../scripts/factory/ledger.mjs'

const SQLITE = sqliteAvailable()
const SKIP = SQLITE ? false : 'node:sqlite unavailable below the shared floor'

const CANDIDATE_A = {
  provider: 'anthropic', id: 'claude-sonnet-5', agent: 'claude', effort: 'medium', source: 'models.dev',
}
const CANDIDATE_B = {
  provider: 'anthropic', id: 'claude-haiku-4-5', agent: 'claude', effort: 'medium', source: 'models.dev',
}
const JUDGE = { model: 'openai/gpt-5.6-sol', vendor: 'openai' }

function writeBench({
  task = `# model evaluation fixture\n\nRoot: ${ROOT}\n`,
  gate = 'console.log(\'GATE-SUMMARY {"total":2,"failed":0,"errored":0}\')\n',
  judge = JUDGE,
  candidates = [CANDIDATE_A, CANDIDATE_B],
  role = 'builder',
  production = 'anthropic/claude-sonnet-5',
  sha = null,
} = {}) {
  const dir = scratchDir('factory-model-eval-')
  mkdirSync(dir, { recursive: true })
  const judgeText = `${JSON.stringify(judge, null, 2)}\n`
  const candidatesText = `${JSON.stringify({ schema: 1, role, production, candidates }, null, 2)}\n`
  writeFileSync(join(dir, 'task.md'), task)
  writeFileSync(join(dir, 'gate.mjs'), gate)
  writeFileSync(join(dir, 'judge.json'), judgeText)
  writeFileSync(join(dir, 'candidates.json'), candidatesText)
  const digest = sha ?? benchSha({ task, gate, judge: judgeText, candidates: candidatesText })
  writeFileSync(join(dir, 'bench.sha'), `${digest}\n`)
  return { dir, digest }
}

function depsFor({
  gate = { total: 2, failed: 0, errored: 0 },
  probe = async () => true,
  readRoster = null,
  envelopes = {},
  rows = [],
  calls = [],
  runJudge = async () => ({ findings: ['finding-1'] }),
} = {}) {
  return {
    ledger: {
      recordEvalCell: async (row) => { rows.push(row); return row },
    },
    probe,
    readRoster,
    runGate: async () => gate,
    runJudge,
    runSeat: async ({ task, candidate }) => {
      calls.push({ task, candidate })
      const envelope = envelopes[candidate.id]
      if (envelope === null) return { envelope: null, absent_reason: 'no-envelope', duration_ms: 120 }
      return {
        envelope: envelope ?? { status: 'done' },
        workdir: join(ROOT, 'test'),
        duration_ms: 100,
        usage: { input: 10, output: 20, cache_read: 30, cache_write: 40 },
      }
    },
  }
}

async function refusalFor(options) {
  const calls = []
  const deps = depsFor({
    calls,
    gate: options.gate ?? { total: 2, failed: 0, errored: 0 },
    probe: options.probe ?? (async () => true),
    readRoster: options.readRoster,
  })
  let caught = null
  try {
    await compileBench({ dir: options.dir, deps })
  } catch (err) {
    caught = err
  }
  return { caught, calls }
}

test('compile refuses unreadable, stale, colliding, zero-gate and absent-production benches before a seat', { skip: SKIP }, async () => {
  const unreadable = scratchDir('factory-model-eval-unreadable-')
  const unreadableResult = await refusalFor({ dir: unreadable })
  assert.equal(unreadableResult.caught instanceof EvalRefusal, true)
  assert.equal(unreadableResult.caught.refusal, 'bench-unreadable')
  assert.equal(unreadableResult.calls.length, 0)

  const stale = writeBench({ sha: '0'.repeat(64) })
  const staleResult = await refusalFor({ dir: stale.dir })
  assert.equal(staleResult.caught instanceof EvalRefusal, true)
  assert.equal(staleResult.caught.refusal, 'bench-sha-mismatch')
  assert.equal(staleResult.calls.length, 0)

  const collision = writeBench({ judge: { model: 'anthropic/claude-opus-5', vendor: 'anthropic' } })
  const collisionResult = await refusalFor({ dir: collision.dir })
  assert.equal(collisionResult.caught instanceof EvalRefusal, true)
  assert.equal(collisionResult.caught.refusal, 'vendor-collision')
  assert.equal(collisionResult.calls.length, 0)

  const noGate = writeBench()
  const noGateResult = await refusalFor({ dir: noGate.dir, gate: { total: 0, failed: 0, errored: 0 } })
  assert.equal(noGateResult.caught instanceof EvalRefusal, true)
  assert.equal(noGateResult.caught.refusal, 'no-mechanical-gate')
  assert.equal(noGateResult.calls.length, 0)

  const noProduction = writeBench({ production: 'anthropic/not-in-the-candidates' })
  const noProductionResult = await refusalFor({ dir: noProduction.dir })
  assert.equal(noProductionResult.caught instanceof EvalRefusal, true)
  assert.equal(noProductionResult.caught.refusal, 'production-absent')
  assert.equal(noProductionResult.calls.length, 0)
})

test('RV1-1 readable roster rejects a declared candidate that is not seated', async () => {
  const seated = { provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'max', source: 'models.dev' }
  const declared = { provider: 'openai', id: 'gpt-5.6-terra', agent: 'pi', effort: 'medium', source: 'models.dev' }
  const judge = { model: 'anthropic/claude-opus-5', vendor: 'anthropic' }
  const readRoster = () => ({ build: { builder: seated } })
  const missingSeated = writeBench({ judge, candidates: [declared], production: 'openai/gpt-5.6-terra' })
  const refused = await refusalFor({ dir: missingSeated.dir, readRoster })
  assert.equal(refused.caught instanceof EvalRefusal, true)
  assert.equal(refused.caught.refusal, 'production-absent')
  assert.equal(refused.calls.length, 0)

  const includedSeated = writeBench({ judge, candidates: [declared, seated], production: 'openai/gpt-5.6-terra' })
  const compiled = await compileBench({ dir: includedSeated.dir, deps: depsFor({ readRoster }) })
  assert.equal(compiled.production.id, seated.id)
})

test('RV1-1 injected dependencies retain the default roster reader', async () => {
  const declared = { provider: 'openai', id: 'gpt-5.6-terra', agent: 'pi', effort: 'medium', source: 'models.dev' }
  const bench = writeBench({
    judge: { model: 'anthropic/claude-opus-5', vendor: 'anthropic' },
    candidates: [declared],
    production: 'openai/gpt-5.6-terra',
  })
  const rows = []
  const calls = []
  const deps = depsFor({ rows, calls })
  Reflect.deleteProperty(deps, 'readRoster')
  let caught = null
  try { await runBench({ dir: bench.dir, deps }) } catch (err) { caught = err }
  assert.equal(caught instanceof EvalRefusal, true)
  assert.equal(caught.refusal, 'production-absent')
  assert.equal(calls.length, 0)
  assert.equal(rows.length, 0)
})

test('RV1-2 default compile runs a repository-relative gate from the checkout', async () => {
  const seated = { provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'max', source: 'models.dev' }
  const bench = writeBench({
    judge: { model: 'anthropic/claude-opus-5', vendor: 'anthropic' },
    candidates: [seated],
    production: 'openai/gpt-5.6-luna',
  })
  const deps = depsFor({ readRoster: () => ({ build: { builder: seated } }) })
  deps.runGate = async ({ cwd }) => {
    assert.equal(cwd, ROOT)
    return { total: 1, failed: 0, errored: 0 }
  }
  const compiled = await compileBench({ dir: bench.dir, deps })
  assert.equal(compiled.production.id, seated.id)
})

test('benchSha is stable and changes for each independently changed input', () => {
  const base = {
    task: 'task',
    gate: 'gate',
    judge: '{"model":"openai/gpt-5","vendor":"openai"}',
    candidates: '{"role":"builder","production":"anthropic/claude-sonnet-5","candidates":[]}',
  }
  const original = benchSha(base)
  assert.equal(benchSha(base), original)
  for (const key of Object.keys(base)) {
    const changed = { ...base, [key]: `${base[key]} changed` }
    assert.notEqual(benchSha(changed), original, key)
  }
})

test('runBench serially hands one byte-identical task to two candidates and records both cells', { skip: SKIP }, async () => {
  const bench = writeBench()
  const rows = []
  const calls = []
  let inFlight = 0
  let maxInFlight = 0
  const deps = depsFor({ rows, calls })
  deps.runSeat = async ({ task, candidate }) => {
    calls.push({ task, candidate })
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((resolve) => setImmediate(resolve))
    inFlight -= 1
    return { envelope: { status: 'done' }, duration_ms: 50, usage: { input: 1, output: 2, cache_read: 3, cache_write: 4 } }
  }
  const result = await runBench({ dir: bench.dir, deps })
  assert.equal(rows.length, 2)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map(({ candidate }) => candidate.id), [CANDIDATE_A.id, CANDIDATE_B.id])
  assert.equal(new Set(rows.map((row) => row.bench)).size, 1)
  assert.equal(new Set(rows.map((row) => row.task_sha)).size, 1)
  assert.equal(new Set(rows.map((row) => row.model_id)).size, 2)
  assert.equal(maxInFlight, 1)
  assert.equal(result.bench, rows[0].bench)
})

test('a silent candidate remains a row with null asserts and a closed absent reason', { skip: SKIP }, async () => {
  const bench = writeBench()
  const rows = []
  const calls = []
  let gateCalls = 0
  let judgeCalls = 0
  const deps = depsFor({ rows, calls, envelopes: { [CANDIDATE_B.id]: null } })
  deps.runGate = async () => { gateCalls += 1; return { total: 2, failed: 0, errored: 0 } }
  deps.runJudge = async () => { judgeCalls += 1; return { findings: [] } }
  await runBench({ dir: bench.dir, deps })
  assert.equal(rows.length, 2)
  const silent = rows.find((row) => row.model_id === CANDIDATE_B.id)
  assert.deepEqual({ asserts_passed: silent.asserts_passed, asserts_declared: silent.asserts_declared }, { asserts_passed: null, asserts_declared: null })
  assert.equal(silent.judge_findings, null)
  assert.equal(silent.envelope_status, 'absent')
  assert.equal(EVAL_ABSENT_REASONS.includes(silent.absent_reason), true)
  assert.equal(calls.length, 2)
  assert.equal(gateCalls, 2)
  assert.equal(judgeCalls, 1)
})

test('a failed local endpoint refuses before runSeat', async () => {
  const local = {
    provider: 'local', id: 'qwen3-coder', agent: 'pi', effort: 'medium', source: 'local', base_url: 'http://127.0.0.1:1/v1/models',
  }
  const bench = writeBench({ candidates: [CANDIDATE_A, local] })
  const result = await refusalFor({ dir: bench.dir, probe: async () => false })
  assert.equal(result.caught instanceof EvalRefusal, true)
  assert.equal(result.caught.refusal, 'local-endpoint-dead')
  assert.equal(result.calls.length, 0)
})
