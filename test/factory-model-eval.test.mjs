// test/factory-model-eval.test.mjs — injected-dependency coverage for the
// serial model-evaluation bench. No test in this file boots a real seat or
// resolves a provider worker.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { ROOT, scratchDir, sqliteAvailable } from './helpers.mjs'
import {
  benchSha,
  compileBench,
  runBench,
  defaultRunSeat,
  normalDeps,
  EVAL_SEAT_FAILURE_REASONS,
  EvalRefusal,
  BENCH_DEFAULT_ROUTING_TIER,
} from '../scripts/factory/model-eval.mjs'
import { EVAL_ABSENT_REASONS, evalsReadout } from '../scripts/factory/ledger.mjs'
import { PI_PROVIDERS } from '../crew/adapters/adapter-pi.mjs'
import { archivedLanes, discoverLanes } from '../scripts/factory/lane-watch.mjs'

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
  tier = undefined,
} = {}) {
  const dir = scratchDir('factory-model-eval-')
  mkdirSync(dir, { recursive: true })
  const judgeText = `${JSON.stringify(judge, null, 2)}\n`
  const candidatesText = `${JSON.stringify({ schema: 1, role, production, ...(tier === undefined ? {} : { tier }), candidates }, null, 2)}\n`
  writeFileSync(join(dir, 'task.md'), task)
  writeFileSync(join(dir, 'gate.mjs'), gate)
  writeFileSync(join(dir, 'judge.json'), judgeText)
  writeFileSync(join(dir, 'candidates.json'), candidatesText)
  const digest = sha ?? benchSha({ task, gate, judge: judgeText, candidates: candidatesText })
  writeFileSync(join(dir, 'bench.sha'), `${digest}\n`)
  return { dir, digest }
}

function fixtureAdapters(roles, args = {}, seats = null) {
  const out = {}
  for (const role of roles) {
    const seat = seats?.[role]
    const agent = seat?.agent ?? args[`agent-${role}`] ?? 'claude'
    out[role] = {
      name: agent,
      transport: 'headless-rpc',
      adapter: {
        modelString({ provider, id, localProviders }) {
          if (agent === 'claude') return id
          const namespace = PI_PROVIDERS[provider] ?? localProviders?.[provider]?.pi_provider
          if (!namespace) throw new Error(`fixture adapter: no namespace for ${provider}`)
          return `${namespace}/${id}`
        },
      },
    }
  }
  Object.defineProperty(out, 'registry', {
    value: { local_providers: { 'llama-swap': { pi_provider: 'llama-swap' } } },
  })
  return out
}

function depsFor({
  gate = { total: 2, failed: 0, errored: 0 },
  probe = async () => true,
  readRoster = null,
  envelopes = {},
  rows = [],
  calls = [],
  runJudge = async () => ({ findings: ['finding-1'] }),
  resolveAdapters = null,
} = {}) {
  return {
    ledger: {
      recordRoutingChoice: async (row) => row,
      recordEvalCell: async (row) => { rows.push(row); return row },
    },
    probe,
    readRoster,
    runGate: async () => gate,
    runJudge,
    resolveAdapters: resolveAdapters || ((roles, args, seats) => fixtureAdapters(roles, args, seats)),
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

function runnerFixture({
  bootStatus = 0,
  bootOutput = null,
  bootStderr = '',
  assign = null,
  wait = null,
  resolveAdapters = null,
  seatIo = null,
  registrationRoot = null,
  worktree = null,
  rejectDuplicate = true,
  role = 'builder',
  candidate = CANDIDATE_A,
  memberModel = null,
  omitMemberModel = false,
  expectedBootModel = null,
} = {}) {
  const stateDir = scratchDir('factory-model-eval-state-')
  const crewRoot = registrationRoot ?? scratchDir('factory-model-eval-crew-')
  const worktreeParent = scratchDir('factory-model-eval-worktree-')
  const checkout = worktree ?? join(worktreeParent, 'tree')
  mkdirSync(stateDir, { recursive: true })
  mkdirSync(checkout, { recursive: true })
  writeFileSync(join(checkout, 'candidate-only-artifact.txt'), 'disposable candidate artifact\n')
  const events = { assigns: [], waits: [], teardowns: 0, removals: [], boots: [] }
  let crewJson = null
  const commandResult = (args) => {
    if (args.includes('boot')) {
      events.boots.push(args)
      const modelIndex = args.indexOf(`--model-${role}`)
      const bootModel = modelIndex >= 0 ? String(args[modelIndex + 1]) : null
      if (expectedBootModel !== null && bootModel !== expectedBootModel) {
        const output = `unexpected boot model ${JSON.stringify(bootModel)}; expected ${JSON.stringify(expectedBootModel)}`
        return {
          result: { status: 1, stdout: output, stderr: '' },
          parsed: null,
          output,
        }
      }
      const taskIndex = args.indexOf('--task')
      const task = taskIndex >= 0 ? String(args[taskIndex + 1]) : 'model-eval-missing-task'
      const checkoutIndex = args.indexOf('--checkout')
      const recordedCheckout = checkoutIndex >= 0 ? String(args[checkoutIndex + 1]) : checkout
      const laneDir = join(crewRoot, 'repo', task)
      crewJson = join(laneDir, 'crew.json')
      if (rejectDuplicate && existsSync(crewJson)) {
        const output = `duplicate task registration: ${task}`
        return {
          result: { status: 1, stdout: output, stderr: '' },
          parsed: null,
          output,
        }
      }
      mkdirSync(join(laneDir, 'returns'), { recursive: true })
      const configuredModel = memberModel ?? `${candidate.provider}/${candidate.id}`
      writeFileSync(crewJson, JSON.stringify({
        schema_version: 3,
        task,
        checkout: recordedCheckout,
        roles: [role],
        members: {
          [role]: {
            transport: 'headless-rpc', agent: candidate.agent,
            ...(omitMemberModel || configuredModel == null ? {} : { model: configuredModel }),
            effort: candidate.effort,
          },
        },
        task_return: join(stateDir, 'returns', 'task.json'),
      }))
      writeFileSync(join(laneDir, 'journal.jsonl'), '')
      const validBootOutput = JSON.stringify({ crew_json: crewJson })
      return {
        result: { status: bootStatus, stdout: bootOutput ?? validBootOutput, stderr: bootStderr },
        parsed: bootOutput === null ? (bootStatus === 0 ? { crew_json: crewJson } : null) : undefined,
        output: `${bootOutput ?? validBootOutput}\n${bootStderr}`,
      }
    }
    return { result: { status: 0, stdout: '', stderr: '' }, parsed: null, output: '\n' }
  }
  const io = seatIo || {
    assign(spec) {
      events.assigns.push(spec)
      if (assign) return assign(spec)
      return { id: 'd1', returnPath: join(stateDir, 'returns', `d1.${role}.json`) }
    },
    wait(returnPath, timeoutS) {
      events.waits.push({ returnPath, timeoutS })
      if (wait) return wait(returnPath, timeoutS)
      return { status: 'done', summary: 'terminal fixture', artifacts: [] }
    },
    teardown() { events.teardowns += 1 },
  }
  const deps = {
    commandResult,
    makeWorktree: () => checkout,
    removeWorktree: (_source, path) => {
      events.removals.push(path)
      if (path === checkout) rmSync(path, { recursive: true, force: true })
      return { removed: path === checkout, why: path === checkout ? null : 'fixture refused to remove the source checkout' }
    },
    resolveAdapters: resolveAdapters || ((roles, args, seats) => fixtureAdapters(roles, args, seats)),
    seatIo: () => io,
    readFile: readFileSync,
  }
  return { deps, events, worktree: () => checkout, stateDir, crewRoot, get crewJson() { return crewJson } }
}

function normalizedJudgeFixtureSeat(judge) {
  const model = String(judge.model || '')
  const slash = model.indexOf('/')
  const provider = slash < 0 ? judge.vendor : model.slice(0, slash)
  const id = slash < 0 ? model : model.slice(slash + 1)
  return {
    provider,
    id,
    agent: judge.agent ?? (provider === 'openai' ? 'pi' : 'claude'),
    effort: judge.effort ?? 'medium',
  }
}

async function runDefaultJudgeBench({ judge, wait, expectedBootModel }) {
  const candidate = CANDIDATE_A
  const bench = writeBench({ judge, candidates: [candidate], production: `${candidate.provider}/${candidate.id}` })
  const fixture = runnerFixture({
    role: 'reviewer', candidate: normalizedJudgeFixtureSeat(judge), wait, expectedBootModel,
  })
  const rows = []
  const deps = {
    ...fixture.deps,
    readRoster: null,
    ledger: { recordRoutingChoice: async (row) => row, recordEvalCell: async (row) => { rows.push(row); return row } },
    runGate: async () => ({ total: 1, failed: 0, errored: 0 }),
    runSeat: async () => ({
      envelope: { status: 'done', summary: 'candidate terminal fixture' },
      workdir: fixture.worktree(), duration_ms: 1,
    }),
  }
  await runBench({ dir: bench.dir, deps })
  return { bench, fixture, rows }
}

async function runFixtureSeat(candidate, options = {}) {
  const bench = writeBench({ candidates: [candidate], production: `${candidate.provider}/${candidate.id}` })
  const fixture = runnerFixture({ candidate, ...options })
  const seat = await defaultRunSeat({
    task: '# adapter model fixture', candidate, role: options.role ?? 'builder', bench: 'adapter-seat', dir: bench.dir, deps: fixture.deps,
  })
  return { bench, fixture, seat }
}

async function refusalFor(options) {
  const calls = []
  const deps = depsFor({
    calls,
    gate: options.gate ?? { total: 2, failed: 0, errored: 0 },
    probe: options.probe ?? (async () => true),
    readRoster: options.readRoster,
    resolveAdapters: options.resolveAdapters,
  })
  let caught = null
  try {
    await compileBench({ dir: options.dir, deps })
  } catch (err) {
    caught = err
  }
  return { caught, calls }
}

test('A1 role benches contain every required valid input', () => {
  const readJson = (relativePath) => JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8'))
  const declarations = {
    planner: {
      path: 'docs/audits/2026-09-17/bench/planner/candidates.json',
      cell: readJson('crew/roster.json').tiers.mechanical.planner,
    },
    builder: {
      path: 'docs/audits/2026-09-17/bench/builder/candidates.json',
      cell: readJson('crew/roster.json').tiers.mechanical.builder,
    },
  }
  const ladder = readJson('crew/model-ladder.json')
  const capabilities = readJson('crew/capabilities.json')
  const localProviderName = 'llama-swap'
  const localAgent = 'pi'
  const localProvider = capabilities.local_providers?.[localProviderName]
  assert.equal(capabilities.coding_agents?.[localAgent]?.providers?.includes(localProviderName), true)
  assert.equal(typeof localProvider?.base_url, 'string')
  assert.notEqual(localProvider.base_url.trim(), '')
  const localModelKeys = ladder.bands.flatMap((band) => band.members)
    .filter((key) => key.startsWith(`${localProviderName}/`))
  assert.deepEqual(localModelKeys, [
    'llama-swap/qwen3.8-27b',
    'llama-swap/gpt-oss-20b',
    'llama-swap/gemma4-31b',
  ])
  const topKeys = ['candidates', 'production', 'role', 'schema']
  const candidateKeys = ['agent', 'base_url', 'effort', 'id', 'provider', 'source']
  const modelKey = (candidate) => `${candidate.provider}/${candidate.id}`
  const cellProjection = (candidate) => ({
    provider: candidate.provider,
    id: candidate.id,
    agent: candidate.agent,
    effort: candidate.effort,
  })

  for (const [role, spec] of Object.entries(declarations)) {
    const benchDir = join(ROOT, 'docs/audits/2026-09-17/bench', role)
    const requiredBenchFiles = ['task.md', 'gate.mjs', 'judge.json', 'candidates.json']
    for (const name of [...requiredBenchFiles, 'bench.sha']) {
      const bytes = readFileSync(join(benchDir, name))
      assert.ok(bytes.length > 0, `${role}/${name} must be non-blank`)
    }
    const judge = readJson(`docs/audits/2026-09-17/bench/${role}/judge.json`)
    assert.deepEqual(Object.keys(judge).sort(), ['model', 'vendor'])
    assert.equal(typeof judge.model, 'string')
    assert.notEqual(judge.model.trim(), '')
    assert.equal(typeof judge.vendor, 'string')
    assert.notEqual(judge.vendor.trim(), '')
    assert.match(readFileSync(join(benchDir, 'bench.sha'), 'utf8').trim(), /^[a-f0-9]{64}$/i)
    const declaration = readJson(spec.path)
    assert.equal(typeof declaration, 'object')
    assert.equal(Array.isArray(declaration), false)
    // The builder bench stands in for ONE roster tier (the builder is seated differently
    // across tiers), so it names it; a bench whose role is seated alike everywhere need not.
    assert.deepEqual(Object.keys(declaration).filter((key) => key !== 'tier').sort(), topKeys)
    if (role === 'builder') assert.equal(declaration.tier, 'mechanical')
    else assert.equal(Object.prototype.hasOwnProperty.call(declaration, 'tier'), false)
    assert.equal(declaration.schema, 1)
    assert.equal(declaration.role, role)
    assert.equal(typeof declaration.role, 'string')
    assert.notEqual(declaration.role.trim(), '')
    assert.equal(typeof declaration.production, 'string')
    assert.notEqual(declaration.production.trim(), '')
    assert.ok(Array.isArray(declaration.candidates))
    assert.ok(declaration.candidates.length > 0)
    assert.equal(declaration.candidates.length, localModelKeys.length + 1)

    for (const candidate of declaration.candidates) {
      assert.equal(typeof candidate, 'object')
      assert.equal(Array.isArray(candidate), false)
      for (const field of ['provider', 'id', 'agent', 'effort']) {
        assert.equal(typeof candidate[field], 'string')
        assert.notEqual(candidate[field].trim(), '')
      }
      assert.equal(typeof candidate.source, 'string')
      assert.notEqual(candidate.source.trim(), '')
      const expectedKeys = candidate.source === 'local'
        ? candidateKeys
        : candidateKeys.filter((key) => key !== 'base_url')
      assert.deepEqual(Object.keys(candidate).sort(), expectedKeys)
      if (candidate.source === 'local') {
        assert.equal(candidate.provider, localProviderName)
        assert.equal(candidate.agent, localAgent)
        assert.equal(candidate.base_url, localProvider.base_url)
      } else {
        assert.equal(candidate.source, 'models.dev')
      }
    }

    assert.equal(declaration.production, modelKey(spec.cell))
    const productionCandidates = declaration.candidates.filter(
      (candidate) => modelKey(candidate) === declaration.production,
    )
    assert.equal(productionCandidates.length, 1)
    assert.deepEqual(cellProjection(productionCandidates[0]), cellProjection(spec.cell))
    assert.equal(productionCandidates[0].source, 'models.dev')
    assert.equal(modelKey(declaration.candidates[0]), declaration.production)

    const localCandidates = declaration.candidates.filter((candidate) => candidate.source === 'local')
    assert.equal(localCandidates.length, localModelKeys.length)
    assert.deepEqual(localCandidates.map(modelKey), localModelKeys)
    assert.deepEqual(
      [...new Set(localCandidates.map(modelKey))].sort(),
      [...new Set(localModelKeys)].sort(),
    )
  }
})

test('compile refuses unreadable, stale, zero-gate and absent-production benches before a seat', { skip: SKIP }, async () => {
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

test('a same-vendor judge and candidate compile past the retired vendor position', { skip: SKIP }, async () => {
  const bench = writeBench({
    judge: { model: 'anthropic/claude-opus-5', vendor: 'anthropic' },
    candidates: [CANDIDATE_A, CANDIDATE_B],
    production: 'anthropic/claude-sonnet-5',
  })
  let caught = null
  try {
    await compileBench({ dir: bench.dir, deps: depsFor() })
  } catch (err) {
    caught = err
  }
  assert.equal(caught, null)
  assert.equal(caught instanceof EvalRefusal, false)
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

test('A1 two consecutive fixed-sha bench runs reach candidate verdicts', async () => {
  const bench = writeBench({ candidates: [CANDIDATE_A], production: `${CANDIDATE_A.provider}/${CANDIDATE_A.id}` })
  const registrationRoot = scratchDir('factory-model-eval-shared-crew-')
  const first = runnerFixture({ registrationRoot })
  const second = runnerFixture({ registrationRoot })
  const rows = []
  const run = (fixture) => runBench({
    dir: bench.dir,
    deps: {
      ...fixture.deps,
      readRoster: null,
      ledger: { recordRoutingChoice: async (row) => row, recordEvalCell: async (row) => { rows.push(row); return row } },
      runGate: async () => ({ total: 1, failed: 0, errored: 0 }),
      runJudge: async () => ({ findings: ['candidate-verdict'] }),
    },
  })

  await run(first)
  await run(second)

  assert.notEqual(first.worktree(), second.worktree())
  assert.equal(rows.length, 2)
  assert.equal(rows.every((row) => row.envelope_status === 'received'), true)
  assert.equal(rows.every((row) => row.absent_reason === null), true)
  assert.equal(rows.every((row) => row.error_text === null), true)
  assert.deepEqual(rows.map((row) => row.judge_findings), [['candidate-verdict'], ['candidate-verdict']])
  assert.equal(rows.some((row) => row.absent_reason === EVAL_SEAT_FAILURE_REASONS.boot_exit), false)
})

test('B1 a settled bench candidate leaves no live registration', async () => {
  const bench = writeBench({ candidates: [CANDIDATE_A], production: `${CANDIDATE_A.provider}/${CANDIDATE_A.id}` })
  const fixture = runnerFixture()
  const rows = []
  let initial = null
  const deps = {
    ...fixture.deps,
    readRoster: null,
    ledger: { recordRoutingChoice: async (row) => row, recordEvalCell: async (row) => { rows.push(row); return row } },
    runGate: async (spec) => {
      if (spec.envelope) {
        const live = discoverLanes(fixture.crewRoot)
        assert.equal(live.length, 1)
        initial = live[0]
      }
      return { total: 1, failed: 0, errored: 0 }
    },
    runJudge: async () => ({ findings: ['settled-verdict'] }),
  }

  await runBench({ dir: bench.dir, deps })

  assert.ok(initial)
  assert.equal(fixture.events.removals.length, 1)
  assert.equal(existsSync(fixture.worktree()), false)
  assert.deepEqual(discoverLanes(fixture.crewRoot), [])
  const historical = archivedLanes(fixture.crewRoot)
  assert.equal(historical.length, 1)
  assert.equal(historical[0].id, initial.id)
  assert.equal(historical[0].task, initial.task)
  assert.equal(historical[0].archivedAt, null)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].envelope_status, 'received')
})

test('A1 production candidate reaches headless-rpc assign/wait and mechanical judge measurement', async () => {
  const bench = writeBench({ candidates: [CANDIDATE_A], production: `${CANDIDATE_A.provider}/${CANDIDATE_A.id}` })
  const fixture = runnerFixture()
  const rows = []
  const deps = {
    ...fixture.deps,
    readRoster: null,
    ledger: { recordRoutingChoice: async (row) => row, recordEvalCell: async (row) => { rows.push(row); return row } },
    runGate: async (spec) => {
      if (spec.envelope) {
        assert.equal(spec.envelope.status, 'done')
        assert.equal(spec.cwd, fixture.worktree())
      }
      return { total: 2, failed: 0, errored: 0 }
    },
    runJudge: async (spec) => {
      assert.equal(spec.envelope.status, 'done')
      assert.equal(spec.dir, fixture.worktree())
      return { findings: ['mechanical-pass'] }
    },
  }
  await runBench({ dir: bench.dir, deps })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].production, 1)
  assert.deepEqual({ asserts_declared: rows[0].asserts_declared, asserts_passed: rows[0].asserts_passed }, { asserts_declared: 2, asserts_passed: 2 })
  assert.deepEqual(rows[0].judge_findings, ['mechanical-pass'])
  assert.equal(rows[0].error_text, null)
  assert.equal(fixture.events.assigns.length, 1)
  assert.equal(fixture.events.waits[0].timeoutS, 24 * 60 * 60)
  assert.equal(fixture.events.teardowns, 1)
})

test('B1 each headless seat failure stage has its distinct closed reason', async () => {
  const bench = writeBench({ candidates: [CANDIDATE_A], production: `${CANDIDATE_A.provider}/${CANDIDATE_A.id}` })
  const run = async (options) => {
    const fixture = runnerFixture(options)
    const seat = await defaultRunSeat({
      task: '# failure fixture', candidate: CANDIDATE_A, role: 'builder', bench: 'b1', dir: bench.dir, deps: fixture.deps,
    })
    await seat.cleanup()
    return seat
  }
  const cases = [
    [EVAL_SEAT_FAILURE_REASONS.boot_exit, { bootStatus: 1, bootOutput: 'boot exited with diagnostic' }],
    [EVAL_SEAT_FAILURE_REASONS.boot_parse, { bootOutput: 'boot output was not JSON' }],
    [EVAL_SEAT_FAILURE_REASONS.assignment, { assign: () => { throw new Error('assignment exception') } }],
    [EVAL_SEAT_FAILURE_REASONS.wait_error, { wait: () => { throw new Error('wait exception') } }],
    [EVAL_SEAT_FAILURE_REASONS.wait_empty, { wait: () => null }],
    [EVAL_SEAT_FAILURE_REASONS.runner, { resolveAdapters: async () => { throw new Error('adapter construction exception') } }],
  ]
  const observed = []
  for (const [reason, options] of cases) {
    const seat = await run(options)
    observed.push(seat.absent_reason)
    assert.equal(seat.absent_reason, reason)
    assert.equal(EVAL_ABSENT_REASONS.includes(seat.absent_reason), true)
    assert.equal(typeof seat.error, 'string')
    assert.ok(seat.error.length > 0)
  }
  assert.equal(new Set(observed).size, cases.length)
})

test('C1 command output and exceptions survive in the ledger input and readout rows', async () => {
  const bench = writeBench({ candidates: [CANDIDATE_A], production: `${CANDIDATE_A.provider}/${CANDIDATE_A.id}` })
  const fixture = runnerFixture({ bootStatus: 9, bootOutput: 'boot stdout diagnostic', bootStderr: 'boot stderr diagnostic' })
  const rows = []
  const deps = {
    ...fixture.deps,
    readRoster: null,
    ledger: { recordRoutingChoice: async (row) => row, recordEvalCell: async (row) => { rows.push(row); return row } },
    runGate: async () => ({ total: 1, failed: 0, errored: 0 }),
  }
  await runBench({ dir: bench.dir, deps })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].absent_reason, EVAL_SEAT_FAILURE_REASONS.boot_exit)
  assert.match(rows[0].error_text, /boot stdout diagnostic/)
  assert.match(rows[0].error_text, /boot stderr diagnostic/)
  const readout = evalsReadout({ bench: rows[0].bench, cells: rows, catalog: { models: {} }, priceSourcePath: 'fixture-prices.json' })
  assert.equal(readout.rows.length, 1)
  assert.equal(readout.rows[0].error_text, rows[0].error_text)
})

test('D1 candidate artifacts stay in the disposable worktree through judge, then source bytes and status remain unchanged', async () => {
  const bench = writeBench({ candidates: [CANDIDATE_A], production: `${CANDIDATE_A.provider}/${CANDIDATE_A.id}` })
  const fixture = runnerFixture()
  const sourceFile = join(ROOT, 'scripts/factory/model-eval.mjs')
  const sourceBytesBefore = readFileSync(sourceFile)
  const sourceWitness = join(ROOT, '.model-eval-source-witness')
  const sourceStatusBefore = existsSync(sourceWitness)
  let gateSawArtifact = false
  let judgeSawArtifact = false
  const artifact = () => join(fixture.worktree(), 'candidate-only-artifact.txt')
  const rows = []
  const deps = {
    ...fixture.deps,
    readRoster: null,
    ledger: { recordRoutingChoice: async (row) => row, recordEvalCell: async (row) => { rows.push(row); return row } },
    runGate: async (spec) => {
      if (spec.envelope) {
        gateSawArtifact = existsSync(artifact())
        assert.equal(spec.cwd, fixture.worktree())
      }
      return { total: 1, failed: 0, errored: 0 }
    },
    runJudge: async (spec) => {
      judgeSawArtifact = existsSync(artifact())
      assert.equal(spec.dir, fixture.worktree())
      return { findings: [] }
    },
  }
  await runBench({ dir: bench.dir, deps })
  assert.equal(gateSawArtifact, true)
  assert.equal(judgeSawArtifact, true)
  assert.equal(existsSync(fixture.worktree()), false)
  assert.deepEqual(readFileSync(sourceFile), sourceBytesBefore)
  assert.equal(existsSync(sourceWitness), sourceStatusBefore)
  assert.equal(rows.length, 1)
})

test('E1 absent envelopes retain null assertions, findings, USD, and an explicit reason', async () => {
  const bench = writeBench({ candidates: [CANDIDATE_A], production: `${CANDIDATE_A.provider}/${CANDIDATE_A.id}` })
  const rows = []
  let gateCalls = 0
  let judgeCalls = 0
  const deps = depsFor({ rows, readRoster: null })
  deps.runSeat = async () => ({ envelope: null, absent_reason: EVAL_SEAT_FAILURE_REASONS.wait_empty, error: 'wait returned no envelope', duration_ms: null, usage: null })
  deps.runGate = async () => { gateCalls += 1; return { total: 1, failed: 0, errored: 0 } }
  deps.runJudge = async () => { judgeCalls += 1; return { findings: ['should-not-run'] } }
  await runBench({ dir: bench.dir, deps })
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.equal(row.asserts_declared, null)
  assert.equal(row.asserts_passed, null)
  assert.equal(row.judge_findings, null)
  assert.equal(row.billed_input_tokens, null)
  assert.equal(row.billed_output_tokens, null)
  assert.equal(row.billed_cache_read_tokens, null)
  assert.equal(row.billed_cache_write_tokens, null)
  assert.equal(row.absent_reason, 'wait-empty')
  assert.equal(row.error_text, 'wait returned no envelope')
  const readout = evalsReadout({ bench: row.bench, cells: rows, catalog: { models: {} }, priceSourcePath: 'empty-prices.json' })
  const emitted = readout.rows[0]
  assert.equal(emitted.asserts, null)
  assert.equal(emitted.judge_findings, null)
  assert.equal(emitted.usd, null)
  assert.equal(emitted.error_text, row.error_text)
  assert.equal(emitted.absent.envelope, 'wait-empty')
  assert.equal(readout.usd_total, null)
  assert.equal(readout.ratifiable, false)
  assert.equal(gateCalls, 1)
  assert.equal(judgeCalls, 0)
})

test('A1 adapter-composed claude judge reaches verdict', async () => {
  const judge = {
    model: 'anthropic/claude-opus-5', vendor: 'anthropic', agent: 'claude', effort: 'medium',
  }
  const result = await runDefaultJudgeBench({
    judge,
    expectedBootModel: 'claude-opus-5',
    wait: () => ({ status: 'done', findings: ['claude-verdict'], artifacts: [] }),
  })
  const row = result.rows[0]
  assert.equal(row.envelope_status, 'received')
  assert.equal(row.absent_reason, null)
  assert.deepEqual(row.judge_findings, ['claude-verdict'])
  assert.equal(result.fixture.events.boots.length, 1)
  assert.equal(result.fixture.events.assigns.length, 1)
  assert.equal(result.fixture.events.waits.length, 1)
  assert.equal(result.fixture.events.boots[0][result.fixture.events.boots[0].indexOf('--model-reviewer') + 1], 'claude-opus-5')
})

test('B1 adapter-composed pi candidate reaches verdict', async () => {
  const candidate = { provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'medium' }
  const expected = `${PI_PROVIDERS.openai}/${candidate.id}`
  const result = await runFixtureSeat(candidate, {
    expectedBootModel: expected,
    wait: () => ({ status: 'done', findings: ['pi-verdict'], artifacts: [] }),
  })
  assert.equal(result.seat.envelope?.status, 'done')
  assert.deepEqual(result.seat.envelope?.findings, ['pi-verdict'])
  assert.equal(result.fixture.events.boots.length, 1)
  assert.equal(result.fixture.events.assigns.length, 1)
  assert.equal(result.fixture.events.waits.length, 1)
  assert.equal(result.fixture.events.boots[0][result.fixture.events.boots[0].indexOf('--model-builder') + 1], expected)
  await result.seat.cleanup()
})

test('C1 pi anthropic candidate keeps pi namespace', async () => {
  const candidate = { provider: 'anthropic', id: 'claude-opus-5', agent: 'pi', effort: 'medium' }
  const expected = `${PI_PROVIDERS.anthropic}/${candidate.id}`
  const result = await runFixtureSeat(candidate, {
    expectedBootModel: expected,
    wait: () => ({ status: 'done', findings: ['pi-anthropic-verdict'], artifacts: [] }),
  })
  assert.equal(result.seat.envelope?.status, 'done')
  assert.deepEqual(result.seat.envelope?.findings, ['pi-anthropic-verdict'])
  assert.equal(result.fixture.events.boots.length, 1)
  assert.equal(result.fixture.events.assigns.length, 1)
  assert.equal(result.fixture.events.waits.length, 1)
  await result.seat.cleanup()
})

test('D1 crew fallback keeps adapter-composed candidate model', async () => {
  const candidate = { provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'medium' }
  const expected = `${PI_PROVIDERS.openai}/${candidate.id}`
  let adapterArgs = null
  const result = await runFixtureSeat(candidate, {
    omitMemberModel: true,
    expectedBootModel: expected,
    resolveAdapters: (roles, args, seats) => {
      if (!seats) adapterArgs = { ...args }
      return fixtureAdapters(roles, args, seats)
    },
    wait: () => ({ status: 'done', findings: ['fallback-verdict'], artifacts: [] }),
  })
  assert.equal(adapterArgs?.['model-builder'], expected)
  assert.equal(result.seat.envelope?.status, 'done')
  assert.deepEqual(result.seat.envelope?.findings, ['fallback-verdict'])
  assert.equal(result.fixture.events.assigns.length, 1)
  assert.equal(result.fixture.events.waits.length, 1)
  await result.seat.cleanup()
})

test('E1 unsupported candidate provider refuses before boot', async () => {
  const unsupported = { provider: 'google', id: 'gemini-pro', agent: 'claude', effort: 'medium' }
  const resolveUnsupported = (roles, args, seats) => {
    if (seats?.builder?.provider === unsupported.provider) throw new Error('unsupported provider/agent pair')
    return fixtureAdapters(roles, args, seats)
  }
  const direct = await runFixtureSeat(unsupported, { resolveAdapters: resolveUnsupported })
  assert.equal(direct.seat.envelope, null)
  assert.equal(direct.seat.absent_reason, EVAL_SEAT_FAILURE_REASONS.runner)
  assert.equal(direct.fixture.events.boots.length, 0)
  assert.equal(direct.fixture.events.assigns.length, 0)
  assert.equal(direct.fixture.events.waits.length, 0)
  await direct.seat.cleanup()

  const bench = writeBench({
    judge: { model: 'google/gemini-pro', vendor: 'google', agent: 'claude', effort: 'medium' },
    candidates: [CANDIDATE_A],
    production: `${CANDIDATE_A.provider}/${CANDIDATE_A.id}`,
  })
  const refused = await refusalFor({
    dir: bench.dir,
    resolveAdapters: (roles, args, seats) => {
      if (seats?.reviewer?.provider === 'google') throw new Error('unsupported judge provider/agent pair')
      return fixtureAdapters(roles, args, seats)
    },
  })
  assert.equal(refused.caught instanceof EvalRefusal, true)
  assert.equal(refused.caught.refusal, 'judge-unresolvable')
  assert.equal(refused.calls.length, 0)
})

test('M1 unresolvable candidate refuses compileBench before any seat runs', async () => {
  const bench = writeBench()
  const refused = await refusalFor({
    dir: bench.dir,
    resolveAdapters: (roles, args, seats) => {
      if (seats?.builder?.provider === CANDIDATE_A.provider) throw new Error('unsupported candidate provider/agent pair')
      return fixtureAdapters(roles, args, seats)
    },
  })
  assert.equal(refused.caught instanceof EvalRefusal, true)
  assert.equal(refused.caught.refusal, 'candidate-unresolvable')
  assert.equal(refused.calls.length, 0)
})

test('F1 dead seat cannot satisfy model composition checks', async () => {
  const candidate = { provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'medium' }
  const expected = `${PI_PROVIDERS.openai}/${candidate.id}`
  const live = await runFixtureSeat(candidate, {
    expectedBootModel: expected,
    wait: () => ({ status: 'done', findings: ['live-verdict'], artifacts: [] }),
  })
  assert.equal(live.seat.envelope?.status, 'done')
  assert.deepEqual(live.seat.envelope?.findings, ['live-verdict'])
  assert.equal(live.fixture.events.assigns.length, 1)
  assert.equal(live.fixture.events.waits.length, 1)
  await live.seat.cleanup()

  const dead = await runFixtureSeat(candidate, {
    bootStatus: 1,
    bootOutput: 'forced boot failure',
    expectedBootModel: expected,
  })
  assert.equal(dead.seat.envelope, null)
  assert.equal(dead.seat.absent_reason, EVAL_SEAT_FAILURE_REASONS.boot_exit)
  assert.match(dead.seat.error, /forced boot failure/)
  assert.equal(dead.fixture.events.boots.length, 1)
  assert.equal(dead.fixture.events.assigns.length, 0)
  assert.equal(dead.fixture.events.waits.length, 0)
  await dead.seat.cleanup()
})

test('G1 thrown judge records closed reason and error text', async () => {
  const diagnostic = 'judge exploded while reading the candidate'
  const rows = []
  const deps = depsFor({
    rows,
    runJudge: async () => { throw new Error(diagnostic) },
  })
  const bench = writeBench({ candidates: [CANDIDATE_A], production: `${CANDIDATE_A.provider}/${CANDIDATE_A.id}` })
  await runBench({ dir: bench.dir, deps })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].absent_reason, 'judge-failed')
  assert.equal(rows[0].error_text, diagnostic)
  assert.equal(rows[0].judge_findings, null)
  assert.equal(EVAL_ABSENT_REASONS.includes(rows[0].absent_reason), true)
})

test('G2 default judge seat failure preserves its diagnostic', async () => {
  const diagnostic = '404 judge response not found'
  const result = await runDefaultJudgeBench({
    judge: { model: 'anthropic/claude-opus-5', vendor: 'anthropic', agent: 'claude', effort: 'medium' },
    expectedBootModel: 'claude-opus-5',
    wait: () => { throw new Error(diagnostic) },
  })
  const row = result.rows[0]
  assert.equal(row.absent_reason, 'judge-failed')
  assert.equal(row.error_text, diagnostic)
  assert.equal(row.judge_findings, null)
  assert.equal(result.fixture.events.assigns.length, 1)
  assert.equal(result.fixture.events.waits.length, 1)
})

test('H1 empty judge response differs from thrown judge', async () => {
  const bench = writeBench({ candidates: [CANDIDATE_A, CANDIDATE_B], production: `${CANDIDATE_A.provider}/${CANDIDATE_A.id}` })
  const rows = []
  const diagnostic = 'judge transport threw'
  const deps = depsFor({
    rows,
    runJudge: async ({ candidate }) => {
      if (candidate.id === CANDIDATE_A.id) return {}
      throw new Error(diagnostic)
    },
  })
  await runBench({ dir: bench.dir, deps })
  const empty = rows.find((row) => row.model_id === CANDIDATE_A.id)
  const thrown = rows.find((row) => row.model_id === CANDIDATE_B.id)
  assert.equal(empty.absent_reason, 'judge-not-briefed')
  assert.equal(empty.error_text, null)
  assert.equal(empty.judge_findings, null)
  assert.equal(thrown.absent_reason, 'judge-failed')
  assert.equal(thrown.error_text, diagnostic)
  assert.equal(thrown.judge_findings, null)
})

test('I1 thrown gate records closed reason and error text', async () => {
  const diagnostic = 'gate process was interrupted'
  const bench = writeBench({ candidates: [CANDIDATE_A], production: `${CANDIDATE_A.provider}/${CANDIDATE_A.id}` })
  const rows = []
  let judgeCalls = 0
  const deps = depsFor({
    rows,
    runJudge: async () => { judgeCalls += 1; return { findings: ['unexpected'] } },
  })
  deps.runGate = async ({ candidate } = {}) => {
    if (candidate) throw new Error(diagnostic)
    return { total: 1, failed: 0, errored: 0 }
  }
  await runBench({ dir: bench.dir, deps })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].absent_reason, 'gate-failed')
  assert.equal(rows[0].error_text, diagnostic)
  assert.equal(rows[0].judge_findings, null)
  assert.equal(judgeCalls, 0)
})

test('J1 null gate result records gate-not-run', async () => {
  const bench = writeBench({ candidates: [CANDIDATE_A], production: `${CANDIDATE_A.provider}/${CANDIDATE_A.id}` })
  const rows = []
  let judgeCalls = 0
  const deps = depsFor({
    rows,
    runJudge: async () => { judgeCalls += 1; return { findings: ['unexpected'] } },
  })
  deps.runGate = async ({ candidate } = {}) => candidate ? null : { total: 1, failed: 0, errored: 0 }
  await runBench({ dir: bench.dir, deps })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].absent_reason, 'gate-not-run')
  assert.equal(rows[0].error_text, null)
  assert.equal(rows[0].asserts_declared, null)
  assert.equal(rows[0].asserts_passed, null)
  assert.equal(judgeCalls, 0)
})

test('K1 absence reasons remain closed and errors stay separate', async () => {
  const bench = writeBench({ candidates: [CANDIDATE_A, CANDIDATE_B], production: `${CANDIDATE_A.provider}/${CANDIDATE_A.id}` })
  const rows = []
  const gateDiagnostic = 'gate diagnostic text'
  const judgeDiagnostic = 'judge diagnostic text'
  const deps = depsFor({ rows })
  deps.runGate = async ({ candidate } = {}) => {
    if (!candidate) return { total: 1, failed: 0, errored: 0 }
    if (candidate.id === CANDIDATE_A.id) throw new Error(gateDiagnostic)
    return { total: 1, failed: 0, errored: 0 }
  }
  deps.runJudge = async () => { throw new Error(judgeDiagnostic) }
  await runBench({ dir: bench.dir, deps })
  const gateRow = rows.find((row) => row.model_id === CANDIDATE_A.id)
  const judgeRow = rows.find((row) => row.model_id === CANDIDATE_B.id)
  assert.equal(gateRow.absent_reason, 'gate-failed')
  assert.equal(gateRow.error_text, gateDiagnostic)
  assert.equal(judgeRow.absent_reason, 'judge-failed')
  assert.equal(judgeRow.error_text, judgeDiagnostic)
  for (const row of rows) {
    assert.equal(EVAL_ABSENT_REASONS.includes(row.absent_reason), true)
    assert.equal(EVAL_ABSENT_REASONS.includes(row.error_text), false)
  }
})

test('L1 production identity remains provider-qualified', async () => {
  const candidate = { ...CANDIDATE_A }
  const bench = writeBench({ candidates: [candidate], production: `${candidate.provider}/${candidate.id}` })
  const rows = []
  await runBench({ dir: bench.dir, deps: depsFor({ rows }) })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].production, 1)
  assert.equal(rows[0].provider, candidate.provider)
  assert.equal(rows[0].model_id, candidate.id)
})

test('F1 eval absence vocabularies are frozen, exact, and admit every runner reason', () => {
  const expected = [
    'no-envelope', 'boot-failed', 'boot-unreadable', 'assignment-failed', 'wait-failed', 'wait-empty', 'seat-runner-failed', 'gate-not-run', 'judge-not-briefed', 'gate-failed', 'judge-failed',
  ]
  assert.equal(Object.isFrozen(EVAL_ABSENT_REASONS), true)
  assert.equal(Object.isFrozen(EVAL_SEAT_FAILURE_REASONS), true)
  assert.deepEqual([...EVAL_ABSENT_REASONS], expected)
  assert.deepEqual(Object.keys(EVAL_SEAT_FAILURE_REASONS), ['boot_exit', 'boot_parse', 'assignment', 'wait_error', 'wait_empty', 'runner'])
  for (const reason of Object.values(EVAL_SEAT_FAILURE_REASONS)) assert.equal(EVAL_ABSENT_REASONS.includes(reason), true)
  assert.equal(EVAL_ABSENT_REASONS.includes('seat-refused'), false)
})

test('routing A1 bench records one replayable choice before every candidate and retains candidate order', async () => {
  const bench = writeBench()
  const routingRows = []
  const evalRows = []
  const calls = []
  const deps = depsFor({ rows: evalRows, calls })
  deps.ledger.recordRoutingChoice = async (row) => {
    assert.equal(evalRows.length, 0)
    routingRows.push(row)
    return row
  }
  const result = await runBench({ dir: bench.dir, deps })
  assert.equal(routingRows.length, 1)
  assert.equal(result.routing_choice, routingRows[0])
  assert.equal(evalRows.length, 2)
  assert.deepEqual(calls.map(({ candidate }) => candidate.id), [CANDIDATE_A.id, CANDIDATE_B.id])
  assert.deepEqual(evalRows.map((row) => row.model_id), [CANDIDATE_A.id, CANDIDATE_B.id])
  assert.equal(routingRows[0].entry_point, 'bench')
  assert.equal(routingRows[0].outcome, 'abstained')
  assert.equal(routingRows[0].exclusions.some(({ reason }) => reason === 'undeclared-candidate'), true)
  for (const row of routingRows[0].normalized_measurements) {
    assert.equal(row.rate.value, null)
    assert.equal(row.rate.denominator, null)
  }
  assert.notDeepEqual(routingRows[0].candidate_set, [CANDIDATE_A, CANDIDATE_B])
})

test('routing policy and ledger write refusals stop bench admission without fabricated evaluation rows', async () => {
  const bench = writeBench()
  const absent = () => {
    const error = new Error('policy bytes missing')
    error.reason = 'policy-unreadable'
    throw error
  }
  await assert.rejects(
    () => runBench({ dir: bench.dir, deps: { ...depsFor(), loadRoutingPolicy: absent } }),
    (error) => error instanceof EvalRefusal && error.refusal === 'routing-policy-unreadable',
  )
  const invalid = () => ({ policy: {}, policyHash: 'a'.repeat(64) })
  await assert.rejects(
    () => runBench({ dir: bench.dir, deps: { ...depsFor(), loadRoutingPolicy: invalid } }),
    (error) => error instanceof EvalRefusal && error.refusal === 'routing-policy-invalid',
  )
  const rows = []; const calls = []
  const deps = depsFor({ rows, calls })
  deps.ledger.recordRoutingChoice = async () => { throw new Error('mirror unavailable') }
  await assert.rejects(
    () => runBench({ dir: bench.dir, deps }),
    (error) => error instanceof EvalRefusal && error.refusal === 'routing-ledger-unavailable',
  )
  assert.deepEqual(rows, [])
  assert.deepEqual(calls, [])
})

const ROLE_BENCH_ROOT = 'docs/audits/2026-09-17/bench'
const ROLE_NAMES = ['planner', 'builder']
const reviewedCandidateShas = {
  // Updated 2026-09-23 by the operator-ratified successor bump (PR #1507): production moves to
  // openai/gpt-6-sol at medium; the local candidate set is unchanged. The operator ratified the
  // bump, not this file: the new candidates.json has had no separate operator review.
  planner: '873a860fb2015ce78bdf3401ab954ed63f5038e4f2520214d6c4c94d32107d7a',
  // Updated 2026-09-25 by the operator-ratified builder reseat: production moves from
  // meta/muse-spark-1.3-contributor to openai/gpt-6-luna at medium; the local candidate set is
  // unchanged. The operator ratified the seat, not this file: no separate operator review.
  // (Re-reviewed 2026-09-20: builder effort low -> medium. 2026-09-19: `"tier": "mechanical"`.)
  builder: '1367e4fad4388c4aaaea385bb1314f1a84670df8dc955b46d7a5e482eb15d58b',
}
const PLANNER_TARGET = ['bench', 'sha', 'mismatch'].join('-')
const BUILDER_README = `${ROLE_BENCH_ROOT}/builder/README.md`

function roleBenchPath(role, name) {
  return join(ROOT, ROLE_BENCH_ROOT, role, name)
}

function gateSummaryFromOutput(output) {
  const line = String(output || '').split(/\r?\n/).filter((entry) => entry.startsWith('GATE-SUMMARY ')).at(-1)
  assert.ok(line, `gate output must contain a readable summary: ${String(output || '')}`)
  let summary
  try { summary = JSON.parse(line.slice('GATE-SUMMARY '.length)) } catch (error) { assert.fail(`gate summary must be JSON: ${error.message}`) }
  assert.equal(Number.isSafeInteger(summary.total), true)
  assert.equal(Number.isSafeInteger(summary.failed), true)
  assert.equal(Number.isSafeInteger(summary.errored), true)
  return summary
}

function runRoleGate(role) {
  const result = spawnSync(process.execPath, [roleBenchPath(role, 'gate.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, MODEL_EVAL_TEST_ENDPOINT: 'http://127.0.0.1:1' },
  })
  assert.equal(result.error, undefined, `gate ${role} must start: ${result.error?.message || ''}`)
  assert.equal(result.signal, null, `gate ${role} must not be interrupted`)
  assert.equal(typeof result.status, 'number', `gate ${role} must return an exit status`)
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  return { ...result, output, summary: gateSummaryFromOutput(output) }
}

function fixtureGit(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'model-eval fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'model-eval fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  })
  assert.equal(result.error, undefined, `fixture git command must start: ${result.error?.message || ''}`)
  assert.equal(result.signal, null, `fixture git command must not be interrupted: ${args.join(' ')}`)
  assert.equal(result.status, 0, `fixture git command must succeed: ${args.join(' ')}\n${result.stdout || ''}\n${result.stderr || ''}`)
  return result
}

// A fixture carries its gate at the bench's real path, committed, as a bench checkout does:
// the planner gate excludes that directory from its scan, and W1 reads the working tree.
function fixtureGatePath(dir) {
  for (const role of ROLE_NAMES) {
    const path = join(dir, ROLE_BENCH_ROOT, role, 'gate.mjs')
    if (existsSync(path)) return path
  }
  return join(dir, 'gate.mjs')
}

function runFixtureGate(dir) {
  const result = spawnSync(process.execPath, [fixtureGatePath(dir)], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, MODEL_EVAL_TEST_ENDPOINT: 'http://127.0.0.1:1' },
  })
  assert.equal(result.error, undefined, `fixture gate must start: ${result.error?.message || ''}`)
  assert.equal(result.signal, null, 'fixture gate must not be interrupted')
  assert.equal(typeof result.status, 'number', 'fixture gate must return an exit status')
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  return { ...result, output, summary: gateSummaryFromOutput(output) }
}

function plannerGateFixture({ output, stray = false } = {}) {
  const dir = scratchDir('factory-model-eval-planner-gate-')
  mkdirSync(dir, { recursive: true })
  fixtureGit(dir, ['init', '-q'])
  const source = `header\n${PLANNER_TARGET}\nfooter\n${PLANNER_TARGET}\n`
  writeFileSync(join(dir, 'source.mjs'), source)
  // The gate is committed at its real bench path, which the gate's own scan excludes.
  mkdirSync(join(dir, ROLE_BENCH_ROOT, 'planner'), { recursive: true })
  writeFileSync(join(dir, ROLE_BENCH_ROOT, 'planner', 'gate.mjs'), readFileSync(roleBenchPath('planner', 'gate.mjs'), 'utf8'))
  fixtureGit(dir, ['add', '.'])
  fixtureGit(dir, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'])
  mkdirSync(join(dir, '.bench-out'), { recursive: true })
  if (stray) writeFileSync(join(dir, 'scout-report.md'), 'an unauthorized write\n')
  const findings = [
    { path: 'source.mjs', line: 2, classification: 'fixture occurrence' },
    { path: 'source.mjs', line: 4, classification: 'fixture occurrence' },
  ]
  writeFileSync(join(dir, '.bench-out/planner-scout.json'), JSON.stringify(
    output ?? { schema: 1, target: PLANNER_TARGET, findings },
    null,
    2,
  ))
  return { dir, findings }
}

function builderCanonicalReadme(scaffold) {
  const input = '[3, -1, 3, 2, -1]\n<!-- PLACEHOLDER: replace this array with the canonical ascending unique JSON array. -->'
  assert.equal(scaffold.includes(input), true, 'builder fixture scaffold must contain its work item')
  return scaffold.replace(input, '[-1,2,3]')
}

function builderGateFixture({ readme = null, extraDiff = false, stray = false } = {}) {
  const dir = scratchDir('factory-model-eval-builder-gate-')
  mkdirSync(join(dir, 'docs/audits/2026-09-17/bench/builder'), { recursive: true })
  fixtureGit(dir, ['init', '-q'])
  const scaffold = readFileSync(roleBenchPath('builder', 'README.md'), 'utf8')
  writeFileSync(join(dir, BUILDER_README), scaffold)
  if (extraDiff) writeFileSync(join(dir, 'fixture-noise.txt'), 'fixture baseline\n')
  writeFileSync(join(dir, ROLE_BENCH_ROOT, 'builder', 'gate.mjs'), readFileSync(roleBenchPath('builder', 'gate.mjs'), 'utf8'))
  fixtureGit(dir, ['add', '.'])
  fixtureGit(dir, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'])
  if (stray) writeFileSync(join(dir, 'scratch-notes.txt'), 'an unauthorized write\n')
  if (readme !== null) writeFileSync(join(dir, BUILDER_README), readme)
  if (extraDiff) writeFileSync(join(dir, 'fixture-noise.txt'), 'fixture changed\n')
  return { dir, scaffold, canonical: builderCanonicalReadme(scaffold) }
}

test('B1 role gates report positive readable summaries', () => {
  for (const role of ROLE_NAMES) {
    const result = runRoleGate(role)
    const summary = result.summary
    assert.notEqual(result.status, 0, `${role} gate must be red at the repository baseline`)
    assert.ok(summary.total >= 1, `${role} gate must report at least one check`)
    assert.ok(summary.failed >= 1)
    assert.equal(summary.errored, 0)
  }
})

test('C1 recorded bench digests match all four inputs', () => {
  const inputNames = { task: 'task.md', gate: 'gate.mjs', judge: 'judge.json', candidates: 'candidates.json' }
  for (const role of ROLE_NAMES) {
    const input = {}
    for (const [name, file] of Object.entries(inputNames)) input[name] = readFileSync(roleBenchPath(role, file), 'utf8')
    const expectedDigest = benchSha(input)
    const recordedDigest = readFileSync(roleBenchPath(role, 'bench.sha'), 'utf8').trim()
    assert.equal(recordedDigest, expectedDigest, `${role} recorded digest`)
    for (const name of Object.keys(input)) {
      const changed = { ...input, [name]: `${input[name]}changed` }
      assert.notEqual(benchSha(changed), expectedDigest, `${role} digest must change when ${name} changes`)
    }
  }
})

test('D1 moved candidate declarations retain reviewed bytes', () => {
  for (const role of ROLE_NAMES) {
    const oldPath = `docs/audits/2026-09-16/bench/${role}-candidates.json`
    const movedPath = roleBenchPath(role, 'candidates.json')
    assert.equal(existsSync(join(ROOT, oldPath)), false, `${oldPath} must be absent`)
    const moved = readFileSync(movedPath)
    const actualCandidateSha = createHash('sha256').update(moved).digest('hex')
    assert.equal(actualCandidateSha, reviewedCandidateShas[role])
  }
})

test('E1 real bench compile coverage remains offline', async () => {
  const probes = []
  const deps = {
    readRoster: null,
    runGate: async () => ({ total: 4, failed: 1, errored: 0 }),
    probe: async (url) => { probes.push(url); return true },
    resolveAdapters: (roles, args, seats) => fixtureAdapters(roles, args, seats),
  }
  for (const role of ROLE_NAMES) {
    const compiled = await compileBench({ dir: join(ROOT, ROLE_BENCH_ROOT, role), deps })
    assert.equal(compiled.role, role)
    assert.match(compiled.sha, /^[a-f0-9]{64}$/)
  }
  assert.equal(probes.length, 6)
  assert.equal(probes.every((url) => url === 'http://10.112.20.20:8080/v1'), true)

  const source = readFileSync(join(ROOT, 'test/factory-model-eval.test.mjs'), 'utf8')
  const start = source.indexOf("test('E1 real bench compile coverage remains offline'")
  const end = source.indexOf('\ntest(', start + 1)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  const e1Source = source.slice(start, end)
  for (const fragment of [
    ['run', 'Bench'].join(''),
    ['fetch', '('].join(''),
    ['http', 's.request('].join(''),
    ['probeLocalEndpoint', '('].join(''),
    ['model-eval.mjs', 'run'].join(' '),
  ]) assert.equal(e1Source.includes(fragment), false, `E1 must not contain ${fragment}`)
})

test('planner candidate gate exercises every P1-P4 and W1 check in both directions', () => {
  const positive = plannerGateFixture()
  const green = runFixtureGate(positive.dir)
  assert.equal(green.status, 0, green.output)
  assert.deepEqual(green.summary, { total: 5, failed: 0, errored: 0 })
  // W1: a complete, correct answer plus one untracked file elsewhere — the defect that let
  // qwen3.8-27b score 4/4 on 2026-09-19 while writing two files the task forbade.
  const strayRed = runFixtureGate(plannerGateFixture({ stray: true }).dir)
  assert.notEqual(strayRed.status, 0, 'W1 stray write must make the gate red')
  assert.match(strayRed.output, /^FAIL W1: wrote outside the declared output \.bench-out\/planner-scout\.json: scout-report\.md$/m)
  assert.match(strayRed.output, /^PASS P4$/m, 'P4 alone could not see it')
  for (const [label, output] of [
    ['P1', []],
    ['P2', { schema: 1, target: PLANNER_TARGET, findings: [{ ...positive.findings[0], classification: '' }, positive.findings[1]] }],
    ['P3', { schema: 1, target: PLANNER_TARGET, findings: [positive.findings[0], positive.findings[0]] }],
    ['P4', { schema: 1, target: PLANNER_TARGET, findings: [positive.findings[0]] }],
  ]) {
    const fixture = plannerGateFixture({ output })
    const red = runFixtureGate(fixture.dir)
    assert.notEqual(red.status, 0, `${label} mutation must make the gate red`)
    assert.match(red.output, new RegExp(`^FAIL ${label}(?::|\\s)`, 'm'))
  }
})

test('builder candidate gate exercises every B1-B3 and W1 check in both directions', () => {
  const positive = builderGateFixture({ readme: builderCanonicalReadme(readFileSync(roleBenchPath('builder', 'README.md'), 'utf8')) })
  const green = runFixtureGate(positive.dir)
  assert.equal(green.status, 0, green.output)
  assert.deepEqual(green.summary, { total: 4, failed: 0, errored: 0 })
  const strayRed = runFixtureGate(builderGateFixture({ readme: builderCanonicalReadme(readFileSync(roleBenchPath('builder', 'README.md'), 'utf8')), stray: true }).dir)
  assert.notEqual(strayRed.status, 0, 'W1 stray write must make the gate red')
  assert.match(strayRed.output, /^FAIL W1: wrote outside the declared output .*: scratch-notes\.txt$/m)
  assert.match(strayRed.output, /^PASS B3$/m, 'B3 alone could not see an untracked file')

  const scaffold = readFileSync(roleBenchPath('builder', 'README.md'), 'utf8')
  for (const [label, options] of [
    ['B1', { readme: scaffold.replace('```BENCH_WORK_ITEM\n', '') }],
    ['B2', { readme: scaffold }],
    ['B3', { readme: builderCanonicalReadme(scaffold), extraDiff: true }],
  ]) {
    const fixture = builderGateFixture(options)
    const red = runFixtureGate(fixture.dir)
    assert.notEqual(red.status, 0, `${label} mutation must make the gate red`)
    assert.match(red.output, new RegExp(`^FAIL ${label}(?::|\\s)`, 'm'))
  }
})

// 2026-09-19: the builder is seated with muse-spark on the mechanical tier and gpt-5.6-luna
// on build and judge, so the mechanical builder bench refused production-absent with
// "model null". A bench that names its tier reads that tier alone; one that does not still
// refuses an ambiguous seat rather than guessing which model is production.
// Mutation killed: ignoring the declared tier; reading a tier other than the one named;
// accepting a blank tier.
test('a bench that names its roster tier resolves production from that tier alone', async () => {
  const mechanical = { provider: 'meta', id: 'muse-spark-1.3-contributor', agent: 'pi', effort: 'low', source: 'models.dev' }
  const build = { provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'high', source: 'models.dev' }
  const judge = { model: 'anthropic/claude-opus-5', vendor: 'anthropic' }
  const readRoster = () => ({ mechanical: { builder: mechanical }, build: { builder: build }, judge: { builder: build } })
  const production = 'meta/muse-spark-1.3-contributor'

  const named = writeBench({ judge, candidates: [mechanical, build], production, tier: 'mechanical' })
  assert.equal((await compileBench({ dir: named.dir, deps: depsFor({ readRoster }) })).production.id, mechanical.id)
  const other = writeBench({ judge, candidates: [mechanical, build], production, tier: 'build' })
  assert.equal((await compileBench({ dir: other.dir, deps: depsFor({ readRoster }) })).production.id, build.id)

  const unnamed = writeBench({ judge, candidates: [mechanical, build], production })
  const ambiguous = await refusalFor({ dir: unnamed.dir, readRoster })
  assert.equal(ambiguous.caught.refusal, 'production-absent')
  assert.match(ambiguous.caught.detail, /no single model — none, or more than one across tiers/)

  const missing = writeBench({ judge, candidates: [mechanical, build], production, tier: 'nonexistent' })
  const absent = await refusalFor({ dir: missing.dir, readRoster })
  assert.equal(absent.caught.refusal, 'production-absent')
  assert.match(absent.caught.detail, /in tier nonexistent/)

  const blank = writeBench({ judge, candidates: [mechanical, build], production, tier: ' ' })
  assert.equal((await refusalFor({ dir: blank.dir, readRoster })).caught.refusal, 'bench-unreadable')
})

// Sol, #1413 pass 1: the tier resolved production but compileBench dropped it, and runBench
// filed the bench's routing choice under a hard-coded `build`, so a mechanical bench counted
// as a build choice in the ledger. The tier now reaches both the policy lookup and the
// materialised choice; a tierless bench keeps `build`.
// Mutation killed: dropping `tier` from the compiled bench; hard-coding either routing site.
test('a tiered bench files its routing choice under its own tier, and a tierless one under build', async () => {
  const { materialiseRoutingChoice } = await import('../crew/crew.mjs')
  const mechanical = { provider: 'meta', id: 'muse-spark-1.3-contributor', agent: 'pi', effort: 'low', source: 'models.dev' }
  const build = { provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'high', source: 'models.dev' }
  const judge = { model: 'anthropic/claude-opus-5', vendor: 'anthropic' }
  const readRoster = () => ({ mechanical: { builder: mechanical }, build: { builder: build }, judge: { builder: build } })
  const filedUnder = async (tier, production, roster = readRoster) => {
    const bench = writeBench({ judge, candidates: [mechanical, build], production, ...(tier ? { tier } : {}) })
    const seen = []
    const deps = { ...depsFor({ readRoster: roster }), materialiseRoutingChoice: (input) => { seen.push(input.tier); return materialiseRoutingChoice(input) } }
    const compiled = await compileBench({ dir: bench.dir, deps })
    await runBench({ dir: bench.dir, deps })
    return { compiledTier: compiled.tier, routed: seen }
  }
  assert.deepEqual(await filedUnder('mechanical', 'meta/muse-spark-1.3-contributor'), { compiledTier: 'mechanical', routed: ['mechanical'] })
  // A tierless bench needs a role seated alike everywhere, or it refuses before routing.
  const tierless = await filedUnder(null, 'openai/gpt-5.6-luna', () => ({ mechanical: { builder: build }, build: { builder: build }, judge: { builder: build } }))
  assert.deepEqual(tierless, { compiledTier: null, routed: [BENCH_DEFAULT_ROUTING_TIER] })

  // The policy route is read from the bench's tier too. The shipped policy declares the same
  // builder candidate for mechanical and build, so inject one where they differ and read the
  // candidate set the choice was materialised from. Mutation killed: the lookup hard-coded
  // to build.
  const { loadRoutingPolicy } = await import('../crew/crew.mjs')
  const real = loadRoutingPolicy()
  const policy = structuredClone(real.policy)
  const marker = { ...policy.routes.build.builder.candidates[0], provider: 'meta', id: 'muse-spark-1.3-contributor', effort: 'low' }
  policy.routes.mechanical.builder.candidates = [marker]
  const bench = writeBench({ judge, candidates: [mechanical, build], production: 'meta/muse-spark-1.3-contributor', tier: 'mechanical' })
  const cellsSeen = []
  const deps = {
    ...depsFor({ readRoster }),
    loadRoutingPolicy: () => ({ policy, policyHash: real.policyHash }),
    materialiseRoutingChoice: (input) => { cellsSeen.push(input.measurements.map((row) => row.cell?.id ?? row.id ?? row.model_id)); return materialiseRoutingChoice(input) },
  }
  await runBench({ dir: bench.dir, deps })
  assert.equal(cellsSeen.length, 1)
  assert.equal(cellsSeen[0][0], 'muse-spark-1.3-contributor', `the mechanical route leads the candidate set: ${JSON.stringify(cellsSeen[0])}`)
})

import { readdirSync } from 'node:fs'

// 2026-09-21 reviewer and tech-lead benches: offline, answer-free, floor-compliant
// declarations under docs/audits/2026-09-21/bench. The 2026-09-17 D1 block above
// is untouched; the live-derivation D1 below is a new test with a distinct name.
const NEW_BENCH_ROOT = 'docs/audits/2026-09-21/bench'
const NEW_ROLES = ['reviewer', 'tech-lead']
const NEW_REQUIRED_FILES = ['README.md', 'bench.sha', 'candidates.json', 'gate.mjs', 'judge.json', 'task.md']

function newBenchPath(role, name) {
  return join(ROOT, NEW_BENCH_ROOT, role, name)
}

function newBenchJson(role, name) {
  return JSON.parse(readFileSync(newBenchPath(role, name), 'utf8'))
}

function newCandidateKey(candidate) {
  return `${candidate.provider}/${candidate.id}`
}

function liveEligibleModels(tier) {
  const ladder = JSON.parse(readFileSync(join(ROOT, 'crew/model-ladder.json'), 'utf8'))
  const rankByBand = new Map(ladder.bands.map((band) => [band.band, band.rank]))
  const rankByModel = new Map()
  for (const band of ladder.bands) for (const model of band.members) rankByModel.set(model, band.rank)
  const floor = rankByBand.get(ladder.tier_floors[tier])
  assert.ok(Number.isSafeInteger(floor), `live ladder must resolve a floor rank for tier ${tier}`)
  return [...rankByModel].filter(([, rank]) => rank >= floor).map(([model]) => model).sort()
}

function liveRosterCell(role, tier) {
  const roster = JSON.parse(readFileSync(join(ROOT, 'crew/roster.json'), 'utf8'))
  const cell = roster.tiers[tier]?.[role]
  assert.ok(cell, `live roster must seat ${role} at tier ${tier}`)
  return cell
}

function newRoleGateFixture(role, outputName, { output = undefined, stray = false } = {}) {
  const dir = scratchDir(`factory-model-eval-new-gate-${role}-`)
  mkdirSync(dir, { recursive: true })
  fixtureGit(dir, ['init', '-q'])
  writeFileSync(join(dir, 'gate.mjs'), readFileSync(newBenchPath(role, 'gate.mjs'), 'utf8'))
  fixtureGit(dir, ['add', '.'])
  fixtureGit(dir, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'])
  mkdirSync(join(dir, '.bench-out'), { recursive: true })
  if (output !== undefined) writeFileSync(join(dir, outputName), JSON.stringify(output, null, 2))
  if (stray) writeFileSync(join(dir, 'stray-notes.txt'), 'an unauthorized write\n')
  return { dir }
}

function runNewRoleGate(dir) {
  const result = spawnSync(process.execPath, [join(dir, 'gate.mjs')], { cwd: dir, encoding: 'utf8', env: { ...process.env } })
  assert.equal(result.error, undefined, `new role gate must start: ${result.error?.message || ''}`)
  assert.equal(result.signal, null, 'new role gate must not be interrupted')
  assert.equal(typeof result.status, 'number', 'new role gate must return an exit status')
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  return { ...result, output, summary: gateSummaryFromOutput(output) }
}

test('A1/B1 new role benches hold exact six-file shape and compile offline', async () => {
  for (const role of NEW_ROLES) {
    assert.deepEqual(readdirSync(join(ROOT, NEW_BENCH_ROOT, role)).sort(), NEW_REQUIRED_FILES)
    const candidates = newBenchJson(role, 'candidates.json')
    const judge = newBenchJson(role, 'judge.json')
    assert.equal(candidates.schema, 1)
    assert.equal(candidates.role, role)
    assert.ok(typeof candidates.tier === 'string' && candidates.tier.trim() !== '')
    assert.ok(typeof candidates.production === 'string' && candidates.production.trim() !== '')
    assert.ok(Array.isArray(candidates.candidates) && candidates.candidates.length > 0)
    assert.ok(typeof judge.model === 'string' && judge.model.trim() !== '')
    assert.ok(typeof judge.vendor === 'string' && judge.vendor.trim() !== '')
    const probes = []
    const compiled = await compileBench({
      dir: join(ROOT, NEW_BENCH_ROOT, role),
      deps: {
        runGate: async () => ({ total: 3, failed: 1, errored: 0 }),
        probe: async (url) => { probes.push(url); return true },
        resolveAdapters: (roles, args, seats) => fixtureAdapters(roles, args, seats),
      },
    })
    assert.equal(compiled.role, role)
    assert.match(compiled.sha, /^[a-f0-9]{64}$/)
    assert.equal(probes.length, 0, 'floor-compliant benches ship zero local arms, so no endpoint is probed')
  }
})

test('C1 new bench production equals the roster cell at its declared tier', () => {
  for (const role of NEW_ROLES) {
    const doc = newBenchJson(role, 'candidates.json')
    const cell = liveRosterCell(role, doc.tier)
    assert.equal(doc.production, `${cell.provider}/${cell.id}`)
    const arm = doc.candidates.find((candidate) => newCandidateKey(candidate) === doc.production)
    assert.ok(arm, 'production arm must be listed')
    assert.equal(arm.agent, cell.agent)
    assert.equal(arm.effort, cell.effort)
  }
})

test('D1 new benches admit all and only models at or above the live tier floor', () => {
  for (const role of NEW_ROLES) {
    const doc = newBenchJson(role, 'candidates.json')
    const actual = doc.candidates.map(newCandidateKey).sort()
    assert.deepEqual(actual, liveEligibleModels(doc.tier))
    assert.equal(new Set(actual).size, actual.length, 'candidate arms must not repeat')
  }
})

test('E1 new bench production occurs exactly once in its own list', () => {
  for (const role of NEW_ROLES) {
    const doc = newBenchJson(role, 'candidates.json')
    assert.equal(doc.candidates.filter((candidate) => newCandidateKey(candidate) === doc.production).length, 1)
  }
})

test('F1 new bench digests recompute and reject nonhex and stale digests', async () => {
  const inputNames = { task: 'task.md', gate: 'gate.mjs', judge: 'judge.json', candidates: 'candidates.json' }
  for (const role of NEW_ROLES) {
    const input = {}
    for (const [name, file] of Object.entries(inputNames)) input[name] = readFileSync(newBenchPath(role, file), 'utf8')
    const expectedDigest = benchSha(input)
    assert.match(expectedDigest, /^[a-f0-9]{64}$/)
    assert.equal(readFileSync(newBenchPath(role, 'bench.sha'), 'utf8').trim(), expectedDigest)
    for (const name of Object.keys(input)) {
      assert.notEqual(benchSha({ ...input, [name]: `${input[name]}changed` }), expectedDigest, `${role} digest must change when ${name} changes`)
    }
  }
  const hexless = writeBench({ sha: `${'0'.repeat(63)}z` })
  assert.equal((await refusalFor({ dir: hexless.dir })).caught?.refusal, 'bench-unreadable')
  const stale = writeBench({})
  writeFileSync(join(stale.dir, 'task.md'), `${readFileSync(join(stale.dir, 'task.md'), 'utf8')}changed\n`)
  assert.equal((await refusalFor({ dir: stale.dir })).caught?.refusal, 'bench-sha-mismatch')
})

test('G1 new role gate contract', () => {
  const specs = [
    {
      role: 'reviewer',
      output: '.bench-out/reviewer-review.json',
      valid: { schema: 1, verdict: 'request-changes', findings: [{ id: 'R1', severity: 'major', path: 'lib/retry.mjs', line: 4, message: 'Line 4 halves the attempt-0 wait: the exponent must be attempt, not attempt - 1.' }] },
      malformed: [
        {},
        { schema: 1, verdict: 'pass', findings: [] },
      ],
    },
    {
      role: 'tech-lead',
      output: '.bench-out/tech-lead-adjudication.json',
      valid: { schema: 1, decision: 'changes-required', dispositions: [{ finding_id: 'T1', disposition: 'uphold', rationale: 'Line 4 contradicts the stated attempt-0 wait.' }, { finding_id: 'T2', disposition: 'dismiss', rationale: 'The contract requires a nonnegative safe integer.' }] },
      malformed: [
        {},
        { schema: 1, decision: 'approved', dispositions: [] },
      ],
    },
  ]
  for (const spec of specs) {
    const green = runNewRoleGate(newRoleGateFixture(spec.role, spec.output, { output: spec.valid }).dir)
    assert.equal(green.status, 0, green.output)
    assert.deepEqual(green.summary, { total: 3, failed: 0, errored: 0 })
    const absent = runNewRoleGate(newRoleGateFixture(spec.role, spec.output).dir)
    assert.notEqual(absent.status, 0, `${spec.role} gate must be red when its output is absent`)
    assert.match(absent.output, /^(FAIL R1|FAIL J1): .*missing/m)
    assert.equal(absent.summary.errored, 0)
    for (const output of spec.malformed) {
      const red = runNewRoleGate(newRoleGateFixture(spec.role, spec.output, { output }).dir)
      assert.notEqual(red.status, 0, `${spec.role} gate must be red for malformed output ${JSON.stringify(output)}`)
      assert.match(red.output, /^FAIL (R1|R2|J1|J2): /m)
      assert.equal(red.summary.errored, 0)
    }
    const stray = runNewRoleGate(newRoleGateFixture(spec.role, spec.output, { output: spec.valid, stray: true }).dir)
    assert.notEqual(stray.status, 0, `${spec.role} gate must be red when a stray file is written`)
    assert.match(stray.output, /^FAIL W1: wrote outside the declared output /m)
  }
})

test('H1 local candidate contract', async () => {
  const synthetic = { source: 'local', provider: 'llama-swap', id: 'h1-contract-local', agent: 'pi', effort: 'medium', base_url: 'http://127.0.0.1:65531/h1-contract' }
  for (const role of NEW_ROLES) {
    const doc = newBenchJson(role, 'candidates.json')
    assert.equal(doc.candidates.filter((candidate) => candidate.source === 'local').length, 0, 'shipped benches carry zero local arms')
    const dir = scratchDir(`factory-model-eval-h1-${role}-`)
    mkdirSync(dir, { recursive: true })
    const input = {}
    for (const [name, file] of Object.entries({ task: 'task.md', gate: 'gate.mjs', judge: 'judge.json' })) {
      input[name] = readFileSync(newBenchPath(role, file), 'utf8')
      writeFileSync(join(dir, file), input[name])
    }
    const withLocal = [...doc.candidates.map((candidate) => ({ ...candidate })), { ...synthetic }]
    input.candidates = `${JSON.stringify({ schema: 1, role: doc.role, tier: doc.tier, production: doc.production, candidates: withLocal }, null, 2)}\n`
    writeFileSync(join(dir, 'candidates.json'), input.candidates)
    writeFileSync(join(dir, 'bench.sha'), `${benchSha(input)}\n`)
    const probes = []
    const deps = {
      runGate: async () => ({ total: 3, failed: 1, errored: 0 }),
      probe: async (url) => { probes.push(url); return true },
      resolveAdapters: (roles, args, seats) => fixtureAdapters(roles, args, seats),
    }
    const compiled = await compileBench({ dir, deps })
    assert.equal(compiled.candidates.length, withLocal.length)
    assert.deepEqual(probes, [synthetic.base_url])
    const cloned = withLocal.map((candidate) => ({ ...candidate }))
    const c = cloned.at(-1)
    delete c.base_url
    const withoutUrl = `${JSON.stringify({ schema: 1, role: doc.role, tier: doc.tier, production: doc.production, candidates: cloned }, null, 2)}\n`
    writeFileSync(join(dir, 'candidates.json'), withoutUrl)
    writeFileSync(join(dir, 'bench.sha'), `${benchSha({ ...input, candidates: withoutUrl })}\n`)
    assert.equal((await refusalFor({ dir, ...deps })).caught?.refusal, 'bench-unreadable')
  }
})

test('I1 answer-free task contract', () => {
  const normalize = (text) => text.replace(/\s+/g, ' ')
  const reviewer = normalize(readFileSync(newBenchPath('reviewer', 'task.md'), 'utf8'))
  const techLead = normalize(readFileSync(newBenchPath('tech-lead', 'task.md'), 'utf8'))
  assert.ok(reviewer.includes('verdict: one of `pass` or `request-changes`'), 'reviewer task pins its shape-only verdict line')
  assert.ok(readFileSync(newBenchPath('reviewer', 'task.md'), 'utf8').split('\n').some((line) => line.trim() === 'Write only .bench-out/reviewer-review.json.'), 'reviewer task pins its write boundary')
  for (const pattern of [/"R1"/, /"verdict"\s*:\s*"[^"]*"/, /"request-changes"/, /"severity"\s*:\s*"(major|minor)"/]) {
    assert.equal(pattern.test(reviewer), false, `reviewer task must not contain a filled answer matching ${pattern}`)
  }
  assert.ok(techLead.includes('decision: one of `approved` or `changes-required`'), 'tech-lead task pins its shape-only decision line')
  for (const pattern of [/"T[12]"/, /"decision"\s*:\s*"[^"]*"/, /"changes-required"/, /"disposition"\s*:\s*"(uphold|dismiss)"/, /"uphold"/, /"dismiss"/]) {
    assert.equal(pattern.test(techLead), false, `tech-lead task must not contain a filled answer matching ${pattern}`)
  }
})

test('RV1-1 snippet line 5 sleeps unconditionally', () => {
  for (const role of NEW_ROLES) {
    const task = readFileSync(newBenchPath(role, 'task.md'), 'utf8')
    assert.ok(task.includes('    await sleep(delay);'), `${role} snippet line 5 must sleep unconditionally`)
    assert.equal(task.includes('if (attempt > 0)'), false, `${role} snippet must not skip the attempt-0 wait`)
  }
})
