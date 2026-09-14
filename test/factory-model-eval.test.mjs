// test/factory-model-eval.test.mjs — injected-dependency coverage for the
// serial model-evaluation bench. No test in this file boots a real seat or
// resolves a provider worker.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
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
    ledger: { recordEvalCell: async (row) => { rows.push(row); return row } },
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
      ledger: { recordEvalCell: async (row) => { rows.push(row); return row } },
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
    ledger: { recordEvalCell: async (row) => { rows.push(row); return row } },
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
    ledger: { recordEvalCell: async (row) => { rows.push(row); return row } },
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
    ledger: { recordEvalCell: async (row) => { rows.push(row); return row } },
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
    ledger: { recordEvalCell: async (row) => { rows.push(row); return row } },
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
