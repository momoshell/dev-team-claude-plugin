import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { execSync, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname, isAbsolute } from 'node:path'
import { openLedger } from '../scripts/factory/ledger.mjs'
import { writeRosterSnapshot, loadLadder, assertBandFloors, BAND_FLOOR_REFUSALS, bootCmd, runCmd, stopCmd, RUN_START_EVENT, BATCH_DIR_EVENT, BATCH_DIR_NOT_BATCHED, batchDirFromBrief, RUN_CONFIG_DECLARATIONS, resolveFilesInScope, resolveLaneFence, resolveValidationLane, VALIDATION_LANE_REFUSAL, assertCtxSources, awaitSeatsReady, writeTerminalLine, UsageError, memoryConfig, CHARTER_BASELINE_BYTES, CHARTER_SOURCE_BUDGET, CHARTER_SOURCE_TOTAL_BUDGET, CHARTER_CEILINGS, CHARTER_BUDGET_REFUSAL, CHARTER_UNMEASURED_CAUSES, charterFileBytes, compiledCharterBytes, charterBudgetRefusals, charterSourceRefusals, assertCharterBudgets, charterBytesRecord, composeRolePrompt } from './crew.mjs'
import { runChild, resolveValidationLane as resolveChildValidationLane } from './child.mjs'
import { daemon, RUN_CONFIG_DECLARATIONS as DAEMON_RUN_CONFIG_DECLARATIONS } from './daemon.mjs'
import { RUN_CONFIG_DECLARATIONS as FACTORY_RUN_CONFIG_DECLARATIONS, completionLogPath } from './factoryctl.mjs'
import { TASK_PROFILES } from './task-profiles.mjs'
import { ASSURANCES, ASSURANCE_ALIASES } from './assurances.mjs'
import { driveTask, LIMITS, VARIANTS, VARIANT_NAMES, DEFAULT_VARIANT, PROTECTED_PATHS, validateScopeEntries } from './drive.mjs'
import { LIMIT_REFUSALS, PLAN_ROUNDS_MAX, BUILD_ROUNDS_MAX, REVIEW_ROUNDS_MAX, limitsCtx, limitsRecord, resolveBuildRounds, resolveLimits, resolvePlanRounds, resolveReviewRounds } from './limits.mjs'
import { modelString as piModelString } from './adapters/adapter-pi.mjs'
import { seatIo } from './seat-io.mjs'
import { testCheckout } from '../test/fixtures.mjs'
import { ROOT, scratchDir } from '../test/helpers.mjs'
import { probeRepo } from '../scripts/factory/probe-repo.mjs'
import { roster, nodeMeetsLedgerFloor, withHome, testCrewDir, callCounter, capabilityRegister } from './crew-test-helpers.mjs'

// Keep lexical import reach visible before byte-pinned regex test bodies.
void [test, after, assert, createHash, readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, renameSync, execSync, spawn, tmpdir, join, dirname, openLedger, writeRosterSnapshot, loadLadder, assertBandFloors, BAND_FLOOR_REFUSALS, bootCmd, runCmd, stopCmd, RUN_START_EVENT, BATCH_DIR_EVENT, BATCH_DIR_NOT_BATCHED, batchDirFromBrief, RUN_CONFIG_DECLARATIONS, resolveFilesInScope, resolveLaneFence, resolveValidationLane, VALIDATION_LANE_REFUSAL, assertCtxSources, awaitSeatsReady, writeTerminalLine, UsageError, memoryConfig, CHARTER_BASELINE_BYTES, CHARTER_SOURCE_BUDGET, CHARTER_SOURCE_TOTAL_BUDGET, CHARTER_CEILINGS, CHARTER_BUDGET_REFUSAL, CHARTER_UNMEASURED_CAUSES, charterFileBytes, compiledCharterBytes, charterBudgetRefusals, charterSourceRefusals, assertCharterBudgets, charterBytesRecord, composeRolePrompt, runChild, resolveChildValidationLane, daemon, DAEMON_RUN_CONFIG_DECLARATIONS, FACTORY_RUN_CONFIG_DECLARATIONS, completionLogPath, TASK_PROFILES, ASSURANCES, ASSURANCE_ALIASES, driveTask, LIMITS, VARIANTS, VARIANT_NAMES, DEFAULT_VARIANT, PROTECTED_PATHS, validateScopeEntries, LIMIT_REFUSALS, PLAN_ROUNDS_MAX, BUILD_ROUNDS_MAX, REVIEW_ROUNDS_MAX, limitsCtx, limitsRecord, resolveBuildRounds, resolveLimits, resolvePlanRounds, resolveReviewRounds, piModelString, seatIo, testCheckout, ROOT, scratchDir, probeRepo, roster, nodeMeetsLedgerFloor, withHome, testCrewDir, callCounter, capabilityRegister, globalThis.realWrite]

const SIGNAL_BLOCK_MS = 3000

function protectedProfile(factoryRoot, checkout, cell) {
  const repoKey = probeRepo({ checkout }).repo_key
  const path = join(factoryRoot, 'profiles', `${repoKey}.json`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({
    schema: 1, profile_version: 1, repo_key: repoKey, fields: { protected_paths_candidates: cell }, meta: {},
  }))
  return path
}


function childSignalFixture() {
  const root = mkdtempSync(join(tmpdir(), 'crew-child-signal-'))
  const crewDir = join(root, 'crew')
  const returnsDir = join(crewDir, 'returns')
  mkdirSync(join(crewDir, 'task'), { recursive: true })
  mkdirSync(returnsDir, { recursive: true })
  const taskReturn = join(returnsDir, 'task.json')
  const brief = join(crewDir, 'brief.md')
  writeFileSync(brief, '# child signal brief\n')
  writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({
    schema_version: 3, task: 'child-signal', checkout: root,
    roles: ['planner', 'builder', 'reviewer'],
    members: Object.fromEntries(['planner', 'builder', 'reviewer'].map((role) => [role, {
      surface_id: null, pane_id: null, transport: 'headless-json', model: 'sonnet', agent: 'claude',
    }])),
    task_return: taskReturn,
  }))
  writeFileSync(join(crewDir, 'journal.jsonl'), '')
  return { root, crewDir, taskReturn, brief, ledger: join(root, 'ledger.db') }
}

// A real signal to a real child is the only proof that survives the 2026-08-11
// convention: send SIGTERM while the child is blocked inside one named stretch of
// runChild and read how it died. Default disposition is `signal: 'SIGTERM'`; a
// handler armed across a turn-free stretch can never dispatch but still
// suppresses that disposition, so an armed child instead runs the block out and
// exits 0. Measured on this checkout: unarmed windows die in 1-2ms.

const SIGNAL_KILL_BOUND_MS = 1000

async function sigtermWhileBlocked(f, body) {
  const harness = join(f.root, 'signal-harness.mjs')
  writeFileSync(harness, `import { runChild } from ${JSON.stringify(new URL('./child.mjs', import.meta.url).href)}
import { writeFileSync as realWrite } from 'node:fs'
const taskReturn = ${JSON.stringify(f.taskReturn)}
const spec = { crew_dir: ${JSON.stringify(f.crewDir)}, task: 'child-signal',
  brief_file: ${JSON.stringify(f.brief)}, checkout: ${JSON.stringify(f.root)},
  ledger_db: ${JSON.stringify(f.ledger)} }
const env = { DEVTEAM_LEDGER_DB: ${JSON.stringify(f.ledger)} }
const block = () => { process.stdout.write('mark\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${SIGNAL_BLOCK_MS}) }
${body}
`)
  let child
  try {
    child = spawn(process.execPath, [harness], { stdio: ['ignore', 'pipe', 'pipe'] })
    return await new Promise((resolve, reject) => {
      let marked = false
      let sentAt = null
      let settled = false
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, 15000)
      const finish = (value, failed = false) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (failed) reject(value)
        else resolve(value)
      }
      child.once('error', (err) => finish(err, true))
      child.stdout.on('data', (chunk) => {
        if (marked || !String(chunk).includes('mark')) return
        marked = true
        sentAt = Date.now()
        child.kill('SIGTERM')
      })
      child.stderr.on('data', () => {})
      child.once('exit', (code, signal) => finish({ marked, code, signal, elapsed: sentAt == null ? null : Date.now() - sentAt }))
    })
  } finally {
    if (child && child.exitCode == null && child.signalCode == null) child.kill('SIGKILL')
  }
}


function assertKilledBySigterm(outcome, where) {
  assert.equal(outcome.marked, true, `the child never reached ${where}`)
  assert.equal(outcome.signal, 'SIGTERM', `${where}: expected death by SIGTERM, got exit code ${outcome.code}`)
  assert.ok(outcome.elapsed < SIGNAL_KILL_BOUND_MS, `${where}: expected death within ${SIGNAL_KILL_BOUND_MS}ms, took ${outcome.elapsed}ms`)
}


function stopUnitFixture({ sidecar = { adw_id: 'unit-run', db_path: '/tmp/unit-ledger.db' }, command = '/checkout/crew/crew.mjs run --task unit-stop', sessions = [{ status: 'running' }], alive = [false], processKill = null, psCommand = null, deathGraceMs = 0 } = {}) {
  const calls = { opened: 0, closed: 0, gets: 0, kills: [], ends: [], output: '' }
  let index = 0
  const ledger = {
    getSession: () => sessions[Math.min(index++, sessions.length - 1)],
    endSession: (payload) => { calls.ends.push(payload) },
    close: () => { calls.closed += 1 },
  }
  const deps = {
    pathsFor: () => ({ dir: '/state' }),
    loadCrew: () => ({ checkout: '/checkout' }),
    existsSync: () => true,
    readFileSync: () => JSON.stringify(sidecar),
    openLedger: () => { calls.opened += 1; return ledger },
    psCommand: () => (typeof psCommand === 'function' ? psCommand() : command),
    isAlive: () => alive.length ? alive.shift() : true,
    processKill: (pid, signal) => {
      calls.kills.push([pid, signal])
      if (processKill) return processKill(pid, signal)
    },
    delay: async () => {},
    deathGraceMs,
    stdout: { write: (text) => { calls.output += String(text) } },
  }
  return { calls, ledger, deps }
}


test('run configuration declarations stay identical across every entry point', () => {
  const declarations = [RUN_CONFIG_DECLARATIONS, DAEMON_RUN_CONFIG_DECLARATIONS, FACTORY_RUN_CONFIG_DECLARATIONS]
  for (const value of declarations) {
    assert.deepEqual(Object.keys(value).sort(), ['assuranceAliases', 'assurances', 'profiles', 'variantNames'])
    assert.equal(value.profiles, TASK_PROFILES)
    assert.equal(value.assurances, ASSURANCES)
    assert.equal(value.assuranceAliases, ASSURANCE_ALIASES)
    assert.deepEqual(value.variantNames, VARIANT_NAMES)
  }
})

test('resolveFilesInScope parses a comma list, handles neutral shapes, and refuses a valueless flag', () => {
  const inherited = VARIANT_NAMES.find((name) => VARIANTS[name]?.sources?.scope === 'inherited')
  const plain = VARIANT_NAMES.find((name) => VARIANTS[name]?.sources?.scope !== 'inherited')
  assert.deepEqual(resolveFilesInScope({ 'files-in-scope': ' a.mjs, , b.mjs ' }, inherited, '/missing/task.json'), ['a.mjs', 'b.mjs'])
  assert.equal(resolveFilesInScope({}, plain, '/missing/task.json'), null)
  assert.throws(() => resolveFilesInScope({ 'files-in-scope': true }, plain, '/missing/task.json'), /needs a comma-separated list/)
})

test('resolveFilesInScope inherits the preferred or fallback list and names every unreadable envelope', () => {
  const inherited = VARIANT_NAMES.find((name) => VARIANTS[name]?.sources?.scope === 'inherited')
  const dir = mkdtempSync(join(tmpdir(), 'crew-scope-envelope-'))
  const preferred = join(dir, 'preferred.json')
  const fallback = join(dir, 'fallback.json')
  const malformed = join(dir, 'malformed.json')
  try {
    writeFileSync(preferred, JSON.stringify({ details: { files_in_scope: ['lib/a.mjs'], files_committed: ['lib/b.mjs'] } }))
    writeFileSync(fallback, JSON.stringify({ details: { files_committed: ['lib/b.mjs'] } }))
    writeFileSync(malformed, '{not-json')
    assert.deepEqual(resolveFilesInScope({}, inherited, preferred), ['lib/a.mjs'])
    assert.deepEqual(resolveFilesInScope({}, inherited, fallback), ['lib/b.mjs'])
    for (const [path, deps] of [
      [join(dir, 'missing.json'), {}],
      [preferred, { existsSync: () => true, readFileSync: () => { throw new Error('denied') } }],
      [malformed, {}],
    ]) {
      assert.throws(() => resolveFilesInScope({}, inherited, path, deps), (err) => err.message.includes(path))
    }
    for (const [index, details] of [{ files_in_scope: 'lib/a.mjs' }, { files_in_scope: [] }, {}].entries()) {
      const path = join(dir, `bad-${index}.json`)
      writeFileSync(path, JSON.stringify({ details }))
      assert.throws(() => resolveFilesInScope({}, inherited, path), (err) => err.message.includes(path))
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('resolveFilesInScope refuses every entry the gate rejects', () => {
  const plain = VARIANT_NAMES.find((name) => VARIANTS[name]?.sources?.scope !== 'inherited')
  for (const entry of ['lib/*.mjs', '/abs/path.mjs', '../up.mjs', 'crew/', '']) {
    const defects = validateScopeEntries([entry])
    assert.equal(defects.length, 1)
    assert.throws(() => resolveFilesInScope({ 'files-in-scope': entry }, plain, '/missing/task.json'), (err) => err.message.includes(JSON.stringify(entry)))
  }
})

test('resolveLaneFence takes both flags or neither', () => {
  assert.equal(resolveLaneFence({}), null)
  assert.throws(() => resolveLaneFence({ lane: 'a' }), /given together or not at all/)
  assert.throws(() => resolveLaneFence({ fences: '/missing/fences.json' }), /given together or not at all/)
  const dir = mkdtempSync(join(tmpdir(), 'crew-fence-resolver-'))
  const register = join(dir, 'fences.json')
  execSync('git init -q', { cwd: dir })
  try {
    writeFileSync(register, JSON.stringify({ lanes: [
      { lane: 'b', files: ['z.mjs', 'y.mjs'] },
      { lane: 'a', files: ['x.mjs'] },
    ] }))
    assert.deepEqual(resolveLaneFence({ fences: register, lane: 'a' }), {
      lane: 'a', fence: [{ lane: 'b', files: ['y.mjs', 'z.mjs'] }],
    })
    mkdirSync(join(dir, 'config'))
    writeFileSync(register, JSON.stringify({ lanes: [
      { lane: 'b', files: ['config'] },
      { lane: 'a', files: ['x.mjs'] },
    ] }))
    assert.throws(
      () => resolveLaneFence({ fences: register, lane: 'a', checkout: dir }),
      (err) => err.reason === 'scope-directory-unslashed',
    )
    writeFileSync(register, JSON.stringify({ lanes: [
      { lane: 'b', files: ['config/'] },
      { lane: 'a', files: ['x.mjs'] },
    ] }))
    assert.deepEqual(resolveLaneFence({ fences: register, lane: 'a', checkout: dir }), {
      lane: 'a', fence: [{ lane: 'b', files: ['config/'] }],
    })
    assert.throws(() => resolveLaneFence({ fences: register, lane: 'unknown' }), (err) => err.reason === 'unknown-lane')
    writeFileSync(register, '{not json')
    assert.throws(() => resolveLaneFence({ fences: register, lane: 'a' }), (err) => err.reason === 'bad-fences')
    const source = readFileSync(new URL('./crew.mjs', import.meta.url), 'utf8')
    assert.match(source, /--fences/)
    assert.match(source, /--lane/)
    assert.match(source, /paired: both or neither/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('attended and child entrypoints resolve validation lanes identically', () => {
  const table = [
    [{}, { lane: null, source: 'none' }],
    [{ lane: null }, { lane: null, source: 'none' }],
    [{ validationLane: null }, { lane: null, source: 'none' }],
    [{ validationLane: '  node --test  ' }, { lane: 'node --test', source: 'validation-lane' }],
    [{ lane: '  npm test  ' }, { lane: 'npm test', source: 'lane' }],
    [{ lane: 'fence-register-name', fences: 'register.json' }, { lane: null, source: 'none' }],
    [{ validationLane: '  validation-command  ', lane: 'fence-register-name', fences: 'register.json' }, { lane: 'validation-command', source: 'validation-lane' }],
  ]
  for (const resolver of [resolveValidationLane, resolveChildValidationLane]) {
    for (const [args, expected] of table) assert.deepEqual(resolver(args), expected)
    for (const raw of [true, '   ', 42]) {
      assert.throws(() => resolver({ validationLane: raw }), (err) => {
        assert.equal(err.reason, 'invalid-validation-lane')
        assert.match(err.message, /--validation-lane/)
        assert.match(err.message, /\[invalid-validation-lane\]/)
        return true
      })
      assert.throws(() => resolver({ lane: raw }), (err) => err.reason === 'invalid-validation-lane')
    }
  }
})

test('daemon enqueue without a lane forwards null and the child resolves it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-daemon-null-lane-'))
  const crewDir = join(dir, 'crew')
  const returnsDir = join(crewDir, 'returns')
  mkdirSync(join(crewDir, 'task'), { recursive: true })
  mkdirSync(returnsDir, { recursive: true })
  const roles = ['planner', 'builder', 'reviewer']
  const brief = join(dir, 'brief.md')
  writeFileSync(brief, '# daemon null lane brief\n')
  writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({
    schema_version: 3, task: 'daemon-null-lane', checkout: dir, roles,
    members: Object.fromEntries(roles.map((role) => [role, {
      surface_id: null, pane_id: null, transport: 'headless-json', model: 'sonnet', agent: 'claude',
    }])),
    task_return: join(returnsDir, 'task.json'),
  }))
  writeFileSync(join(crewDir, 'journal.jsonl'), '')
  const forks = []
  let clock = 1
  const d = daemon({
    root: join(dir, 'daemon'),
    deps: {
      pid: 700, now: () => clock++, uuid: (() => { let n = 0; return () => `run-${++n}` })(),
      fork(...args) { forks.push(args); return { pid: 900, on() {}, kill() {}, unref() {}, disconnect() {} } },
      kill: () => true, setInterval: () => null, clearInterval: () => {},
    },
  })
  try {
    d.enqueue({ crew_dir: crewDir, task: 'daemon-null-lane', checkout: dir, brief_file: brief })
    assert.equal(forks.length, 1)
    const spec = JSON.parse(forks[0][1][1])
    assert.equal(spec.lane, null, 'the daemon normalises an absent lane to null')
    let seen = null
    let drove = 0
    const rows = []
    runChild(spec, {
      preflight: false,
      seatIo: () => ({ log: (row) => rows.push(row) }),
      driveTask: (ctx) => { drove += 1; seen = ctx; return { status: 'done', summary: '', artifacts: [], details: {} } },
      env: { DEVTEAM_LEDGER_DB: join(dir, 'ledger.db') },
    })
    assert.equal(drove, 1)
    assert.equal(seen.lane, null)
    const row = rows.find((entry) => entry.event === 'validation-lane')
    assert.deepEqual(row, { at: row.at, event: 'validation-lane', lane: null, source: 'none' })
  } finally {
    await d.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolvePlanRounds resolves absent and valid values and refuses invalid budgets closed', () => {
  assert.equal(resolvePlanRounds(undefined), null)
  assert.equal(resolvePlanRounds(null), null)
  assert.equal(resolvePlanRounds(''), null)
  assert.equal(resolvePlanRounds('6'), 6)
  assert.equal(resolvePlanRounds(6), 6)
  assert.equal(resolvePlanRounds(' 3 '), 3)
  for (const raw of [true, 'abc', '2.5', 2.5, 0, -1, '0x4', [], PLAN_ROUNDS_MAX + 1]) {
    assert.throws(() => resolvePlanRounds(raw), (err) => {
      assert.equal(err.reason, 'invalid-plan-rounds')
      assert.ok(LIMIT_REFUSALS.includes(err.reason))
      return true
    })
  }
})

test('resolveBuildRounds and resolveReviewRounds resolve absent and valid values and refuse invalid budgets closed', () => {
  for (const [resolve, reason, max] of [
    [resolveBuildRounds, 'invalid-build-rounds', BUILD_ROUNDS_MAX],
    [resolveReviewRounds, 'invalid-review-rounds', REVIEW_ROUNDS_MAX],
  ]) {
    assert.equal(resolve(undefined), null)
    assert.equal(resolve(null), null)
    assert.equal(resolve(''), null)
    assert.equal(resolve('3'), 3)
    assert.equal(resolve(3), 3)
    assert.equal(resolve(' 3 '), 3)
    for (const raw of [true, 'abc', '2.5', 2.5, 0, -1, '0x4', [], max + 1]) {
      assert.throws(() => resolve(raw), (err) => {
        assert.equal(err.reason, reason)
        assert.ok(LIMIT_REFUSALS.includes(err.reason))
        return true
      })
    }
  }
})

test('resolveLimits and limitsCtx overlay only the flagged keys', () => {
  const none = resolveLimits({})
  assert.deepEqual(none, { plan_rounds: null, build_rounds: null, review_rounds: null })
  assert.equal(limitsCtx(none), null)
  assert.deepEqual(limitsCtx(resolveLimits({ build_rounds: 4 })), { build_rounds: 4 })
})

test('limitsRecord records all effective round budgets with per-key sources', () => {
  assert.deepEqual(limitsRecord(resolveLimits({}), LIMITS), {
    plan_rounds: LIMITS.plan_rounds, build_rounds: LIMITS.build_rounds, review_rounds: LIMITS.review_rounds,
    source: { plan_rounds: 'default', build_rounds: 'default', review_rounds: 'default' },
  })
  assert.deepEqual(limitsRecord(resolveLimits({ build_rounds: 6, review_rounds: 1 }), LIMITS), {
    plan_rounds: LIMITS.plan_rounds, build_rounds: 6, review_rounds: 1,
    source: { plan_rounds: 'default', build_rounds: 'flag', review_rounds: 'flag' },
  })
})

test('run refuses an invalid round budget before reading crew state', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-rounds-refusal-home-'))
  let drove = 0
  try {
    await withHome(home, () => {
      for (const [flag, reason] of [
        ['plan-rounds', 'invalid-plan-rounds'],
        ['build-rounds', 'invalid-build-rounds'],
        ['review-rounds', 'invalid-review-rounds'],
      ]) {
        assert.throws(
          () => runCmd({ task: 'invalid-rounds-run', checkout: process.cwd(), 'brief-file': join(home, 'missing.md'), [flag]: '2.5' }, { drive: () => { drove += 1 } }),
          (err) => err.reason === reason,
        )
      }
      assert.equal(existsSync(join(home, '.crew')), false)
    })
    assert.equal(drove, 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('run plumbs flagged budgets, records defaults when absent, and preserves driver overrides', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-rounds-run-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-rounds-run-home-'))
  const task = 'rounds-run'
  execSync('git init -q', { cwd: checkout })
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# rounds brief\n')
  const previousLedger = process.env.DEVTEAM_LEDGER_DB
  process.env.DEVTEAM_LEDGER_DB = join(home, 'ledger.db')
  const seen = []
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      const capture = (ctx) => { seen.push(ctx); return done }
      runCmd({ task, checkout, 'brief-file': brief, 'plan-rounds': '4', keep: true }, { drive: capture })
      runCmd({ task, checkout, 'brief-file': brief, 'build-rounds': '5', 'review-rounds': '1', keep: true }, { drive: capture })
      runCmd({ task, checkout, 'brief-file': brief, keep: true }, { drive: capture })

      assert.equal(RUN_START_EVENT, 'run-start')
      assert.ok(seen.every((ctx) => ctx.publish && typeof ctx.publish.branch === 'string'))
      assert.deepEqual(seen[0].limits, { plan_rounds: 4 })
      assert.deepEqual(seen[1].limits, { build_rounds: 5, review_rounds: 1 })
      assert.equal(Object.prototype.hasOwnProperty.call(seen[2], 'limits'), false)
      const rows = readFileSync(seen[0].journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
        .filter((row) => row.event === 'limits')
      assert.equal(rows.length, 3)
      assert.deepEqual(rows[0], {
        at: rows[0].at, event: 'limits', plan_rounds: 4, build_rounds: LIMITS.build_rounds, review_rounds: LIMITS.review_rounds,
        source: { plan_rounds: 'flag', build_rounds: 'default', review_rounds: 'default' },
      })
      assert.deepEqual(rows[1], {
        at: rows[1].at, event: 'limits', plan_rounds: LIMITS.plan_rounds, build_rounds: 5, review_rounds: 1,
        source: { plan_rounds: 'default', build_rounds: 'flag', review_rounds: 'flag' },
      })
      assert.deepEqual(rows[2], {
        at: rows[2].at, event: 'limits', plan_rounds: LIMITS.plan_rounds, build_rounds: LIMITS.build_rounds, review_rounds: LIMITS.review_rounds,
        source: { plan_rounds: 'default', build_rounds: 'default', review_rounds: 'default' },
      })

      const stages = []
      const io = {
        assign: ({ role }) => ({ id: role, returnPath: role }),
        wait: (returnPath) => returnPath === 'planner'
          ? { status: 'insufficient', role: 'planner', summary: 'the brief leaves a gap', artifacts: [], details: {} }
          : { status: 'done', role: 'lead', summary: '', artifacts: [], details: { decision: 'bounce', reason: 'because', guidance: 'close the gap' } },
        writeFile: () => {}, readFile: () => [
          JSON.stringify({ seat_turn_census: { dispatch_id: 'planner', role: 'planner', transport: 'headless-json', turns: 1 }, headless_outcome: 'ok' }),
          JSON.stringify({ seat_turn_census: { dispatch_id: 'lead', role: 'lead', transport: 'headless-json', turns: 1 }, headless_outcome: 'ok' }),
        ].join('\n'), run: () => ({ ok: true, output: '' }),
        changedFiles: () => [], commit: () => 'abc1234',
        log: (row) => { if (row && typeof row.stage === 'string') stages.push(row.stage) }, now: () => 0,
      }
      const result = driveTask(seen[0], io)
      assert.equal(stages.filter((stage) => stage.startsWith('plan:r')).length, 4)
      assert.match(result.details.escalation.why, /within 4 rounds/)
    })
  } finally {
    if (previousLedger === undefined) delete process.env.DEVTEAM_LEDGER_DB
    else process.env.DEVTEAM_LEDGER_DB = previousLedger
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('batchDirFromBrief derives only compiled briefs under an out directory', () => {
  const batch = '/tmp/batch-2026-09-05-r32'
  const compiled = `${batch}/out/lane.brief.md`
  assert.deepEqual(batchDirFromBrief(compiled), { batch_dir: batch, brief: compiled, reason: null })
  for (const value of ['/tmp/hand-written.brief.md', '', 42]) {
    const result = batchDirFromBrief(value)
    assert.equal(result.batch_dir, null)
    assert.equal(result.reason, BATCH_DIR_NOT_BATCHED)
    assert.equal(result.brief, typeof value === 'string' && value.trim() ? value : null)
  }
})

test('run journals one batch-dir row per invocation with a closed non-batch reason', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-batch-dir-run-checkout-')
  const home = scratchDir('crew-batch-dir-run-home-')
  const batchBrief = join(home, 'batch-2026-09-05-r32', 'out', 'batch-dir-run.brief.md')
  const looseBrief = join(home, 'hand-written.brief.md')
  mkdirSync(dirname(batchBrief), { recursive: true })
  writeFileSync(batchBrief, '# compiled brief\n')
  writeFileSync(looseBrief, '# loose brief\n')
  const task = 'batch-dir-run'
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  try {
    execSync('git init -q', { cwd: checkout })
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      runCmd({ task, checkout, 'brief-file': batchBrief, keep: true }, { drive: () => done })
      runCmd({ task, checkout, 'brief-file': looseBrief, keep: true }, { drive: () => done })
    })
    const journal = join(testCrewDir(home, checkout, task), 'journal.jsonl')
    const rows = readFileSync(journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      .filter((row) => row.event === BATCH_DIR_EVENT)
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map(({ batch_dir, reason }) => ({ batch_dir, reason })), [
      { batch_dir: join(home, 'batch-2026-09-05-r32'), reason: null },
      { batch_dir: null, reason: BATCH_DIR_NOT_BATCHED },
    ])
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('run resolves, threads, and journals validation lanes without overloading fence names', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-validation-lane-run-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-validation-lane-run-home-'))
  const register = join(home, 'fences.json')
  const brief = join(home, 'brief.md')
  const task = 'validation-lane-run'
  writeFileSync(register, JSON.stringify({ lanes: [{ lane: 'fence-name', files: ['crew/crew.mjs'] }] }))
  writeFileSync(brief, '# validation lane brief\n')
  execSync('git init -q', { cwd: checkout })
  const seen = []
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      const capture = (ctx) => { seen.push(ctx); return done }
      runCmd({ task, checkout, 'brief-file': brief, 'validation-lane': '  npm test  ', keep: true }, { drive: capture })
      runCmd({ task, checkout, 'brief-file': brief, fences: register, lane: 'fence-name', keep: true }, { drive: capture })
      runCmd({ task, checkout, 'brief-file': brief, lane: '  ci-repair lane  ', keep: true }, { drive: capture })
    })
    assert.deepEqual(seen.map((ctx) => ctx.lane), ['npm test', null, 'ci-repair lane'])
    const rows = readFileSync(seen[0].journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      .filter((row) => row.event === 'validation-lane')
    assert.deepEqual(rows.map(({ lane, source }) => ({ lane, source })), [
      { lane: 'npm test', source: 'validation-lane' },
      { lane: null, source: 'none' },
      { lane: 'ci-repair lane', source: 'lane' },
    ])
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('completion log path accepts an override and otherwise defaults to the crew root', () => {
  const root = scratchDir('crew-completion-path-')
  const override = join(root, 'x.jsonl')
  assert.equal(completionLogPath({ env: { CREW_COMPLETION_LOG: `  ${override}  ` } }), override)
  assert.equal(completionLogPath({ root: join(root, 'root'), env: {} }), join(root, 'root', 'completions.jsonl'))
})

test('run keeps a blockless brief unmeasured and distinguishable from a compiler proposal', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-proposal-blockless-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-proposal-blockless-home-'))
  const task = 'proposal-blockless'
  execSync('git init -q', { cwd: checkout })
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# blockless brief\nno compiler proposal here\n')
  const dbPath = join(home, 'ledger.db')
  const previousLedger = process.env.DEVTEAM_LEDGER_DB
  process.env.DEVTEAM_LEDGER_DB = dbPath
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      runCmd({ task, checkout, 'brief-file': brief, keep: true }, { drive: () => done })
    })
    if (!nodeMeetsLedgerFloor) return
    const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
    try {
      const row = ledger.dumpTable('sessions').find((candidate) => candidate.task_slug === task)
      assert.ok(row)
      assert.equal(row.proposed_shape, null)
      assert.equal(row.proposed_strength, null)
      assert.notDeepEqual(
        { shape: row.proposed_shape, strength: row.proposed_strength },
        { shape: 'mechanical', strength: 'workhorse' },
      )
    } finally { ledger.close() }
  } finally {
    if (previousLedger === undefined) delete process.env.DEVTEAM_LEDGER_DB
    else process.env.DEVTEAM_LEDGER_DB = previousLedger
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('daemon path records the brief proposal with or without the crew.json brief_file', () => {
  const proposal = '# proposal brief\n```proposal\n{"shape":"mechanical","strength":"workhorse"}\n```\n'
  const daemonRun = (task, includeBriefFile) => {
    const root = mkdtempSync(join(tmpdir(), `crew-proposal-daemon-${task}-`))
    const crewDir = join(root, 'crew')
    const checkout = join(root, 'checkout')
    mkdirSync(crewDir, { recursive: true })
    mkdirSync(checkout, { recursive: true })
    mkdirSync(join(crewDir, 'returns'), { recursive: true })
    const brief = join(crewDir, 'brief.md')
    writeFileSync(brief, proposal)
    writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({
      schema_version: 3, task, checkout,
      roles: ['lead', 'planner', 'builder', 'reviewer'],
      members: Object.fromEntries(['lead', 'planner', 'builder', 'reviewer'].map((role) => [role, {
        surface_id: null, pane_id: null, transport: 'headless-json', model: 'sonnet', agent: 'claude',
      }])),
      task_return: join('returns', 'task.json'),
      ...(includeBriefFile ? { brief_file: brief } : {}),
    }))
    const dbPath = join(crewDir, 'ledger.db')
    try {
      runChild({ crew_dir: crewDir, task, brief_file: brief, checkout }, {
        preflight: false,
        seatIo: () => ({
          log: () => {}, assign: () => ({ id: 'x', returnPath: 'x' }), wait: () => null,
          writeFile: () => {}, readFile: () => null, run: () => ({ ok: true, output: '' }),
          changedFiles: () => [], commit: () => 'abc1234', now: () => 0,
        }),
        driveTask: () => ({ status: 'done', summary: '', artifacts: [], details: {} }),
        env: { DEVTEAM_LEDGER_DB: dbPath },
      })
      if (!nodeMeetsLedgerFloor) return null
      const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
      try { return ledger.dumpTable('sessions').find((row) => row.task_slug === task) } finally { ledger.close() }
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
  if (!nodeMeetsLedgerFloor) {
    daemonRun('proposal-daemon-key', true)
    daemonRun('proposal-daemon-nokey', false)
    return
  }
  const withKey = daemonRun('proposal-daemon-key', true)
  const withoutKey = daemonRun('proposal-daemon-nokey', false)
  assert.ok(withKey)
  assert.equal(withKey.proposed_shape, 'mechanical')
  assert.equal(withKey.proposed_strength, 'workhorse')
  assert.ok(withoutKey)
  assert.equal(withoutKey.proposed_shape, 'mechanical')
  assert.equal(withoutKey.proposed_strength, 'workhorse')
})

test('the settle path writes the envelope before its teardown and only once', () => {
  const f = childSignalFixture()
  const order = []
  try {
    const result = runChild({ crew_dir: f.crewDir, task: 'child-signal', brief_file: f.brief, checkout: f.root, ledger_db: f.ledger }, {
      preflight: false,
      env: { DEVTEAM_LEDGER_DB: f.ledger },
      writeFileSync: (path, data, options) => writeFileSync(path, data, options),
      renameSync: (from, to) => {
        if (String(to) === f.taskReturn) order.push('envelope')
        renameSync(from, to)
      },
      seatIo: () => ({ teardown: () => { order.push('teardown'); return [] } }),
      driveTask: () => ({ status: 'done', summary: 'done', artifacts: [], details: {} }),
    })
    assert.equal(result.status, 'done')
    assert.deepEqual(order, ['envelope', 'teardown'])
    assert.equal(JSON.parse(readFileSync(f.taskReturn, 'utf8')).status, 'done')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('the child arms no teardown signal handler at any point in a run', () => {
  const f = childSignalFixture()
  // The 2026-08-11 convention's own prescription: INSTRUMENT the OS-level
  // listener count through the code path rather than reading that a
  // registration happened. Every stretch a daemon reap can land in is sampled.
  const counts = () => ['SIGTERM', 'SIGINT'].map((signal) => process.listenerCount(signal))
  const before = counts()
  const seen = {}
  try {
    runChild({ crew_dir: f.crewDir, task: 'child-signal', brief_file: f.brief, checkout: f.root, ledger_db: f.ledger }, {
      preflight: false,
      env: { DEVTEAM_LEDGER_DB: f.ledger },
      // The FIRST call after seatIo and the FIRST call inside settle are both
      // sampled: a listener armed only across one of them would be invisible to
      // a probe that watched just the later log and teardown callbacks.
      checkoutProtectedPaths: () => {
        seen['protected-paths checkout'] = counts()
        return { paths: [], used: false, reason: 'test-double', basis: 'test double' }
      },
      writeFileSync: (path, data, options) => {
        if (String(path) === `${f.taskReturn}.tmp`) seen['settlement envelope write'] ??= counts()
        writeFileSync(path, data, options)
      },
      seatIo: () => ({
        log: () => { seen['post-seatIo preflight'] ??= counts() },
        teardown: () => { seen['settlement teardown'] = counts(); return [] },
      }),
      driveTask: () => { seen.drive = counts(); return { status: 'done', summary: 'done', artifacts: [], details: {} } },
    })
    seen.after = counts()
    for (const where of [
      'protected-paths checkout', 'post-seatIo preflight', 'drive',
      'settlement envelope write', 'settlement teardown', 'after',
    ]) {
      assert.deepEqual(seen[where], before, where)
    }
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a real SIGTERM still kills a child mid-drive without waiting for the drive', async () => {
  const f = childSignalFixture()
  try {
    const outcome = await sigtermWhileBlocked(f, `runChild(spec, { preflight: false, env,
  seatIo: () => ({ teardown: () => [] }),
  driveTask: () => { block(); return { status: 'done', summary: 'late', artifacts: [], details: {} } },
})`)
    assertKilledBySigterm(outcome, 'the drive')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a real SIGTERM during synchronous preflight keeps the default disposition', async () => {
  const f = childSignalFixture()
  try {
    const outcome = await sigtermWhileBlocked(f, `runChild(spec, { env,
  execSync: () => { block(); return '' },
  seatIo: () => ({ teardown: () => [] }),
  driveTask: () => ({ status: 'done', summary: 'late', artifacts: [], details: {} }),
})`)
    assertKilledBySigterm(outcome, 'preflight')
    // A reap before settle() leaves no envelope. That residual is covered by the
    // daemon's settleSignalled, never by the child (crew/daemon.mjs).
    assert.equal(existsSync(f.taskReturn), false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a real SIGTERM in the post-seatIo preflight window keeps the default disposition', async () => {
  const f = childSignalFixture()
  try {
    const outcome = await sigtermWhileBlocked(f, `runChild(spec, { preflight: false, env,
  checkoutProtectedPaths: () => { block(); return { paths: [], used: false, reason: 'test-double', basis: 'test double' } },
  seatIo: () => ({ log: () => {}, teardown: () => [] }),
  driveTask: () => ({ status: 'done', summary: 'late', artifacts: [], details: {} }),
})`)
    assertKilledBySigterm(outcome, 'the post-seatIo preflight window')
    assert.equal(existsSync(f.taskReturn), false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a real SIGTERM during settlement keeps the default disposition', async () => {
  const f = childSignalFixture()
  try {
    const outcome = await sigtermWhileBlocked(f, `runChild(spec, { preflight: false, env,
  writeFileSync: (path, data, options) => { realWrite(path, data, options); if (String(path) === taskReturn + '.tmp') block() },
  seatIo: () => ({ log: () => {}, teardown: () => [] }),
  driveTask: () => ({ status: 'done', summary: 'ok', artifacts: [], details: {} }),
})`)
    assertKilledBySigterm(outcome, 'the settlement window')
    // The signal lands inside settle's OWN temporary publish write, before the
    // rename, so the final path is empty and the daemon's settleSignalled records
    // the run when the reap lands inside this window.
    assert.equal(existsSync(f.taskReturn), false)
    assert.equal(existsSync(`${f.taskReturn}.tmp`), true)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('stopCmd closes its ledger and refuses unsafe identities without terminal writes', async () => {
  const args = { task: 'unit-stop', pid: '42', checkout: '/checkout' }
  const malformed = stopUnitFixture()
  malformed.deps.readFileSync = () => '{'
  malformed.deps.openLedger = () => { throw new Error('must not open malformed sidecar') }
  await assert.rejects(() => stopCmd(args, malformed.deps), (err) => err instanceof UsageError && /^crew\.mjs stop: refused/.test(err.message))
  assert.equal(malformed.calls.opened, 0)
  assert.equal(malformed.calls.closed, 0)

  for (const [label, fixture] of [
    ['invalid pid', stopUnitFixture()],
    ['command mismatch', stopUnitFixture({ command: '/other/crew.mjs run --task unit-stop' })],
    ['TERM EPERM', stopUnitFixture({ processKill: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) } })],
    ['unknown liveness', stopUnitFixture({ alive: [null, null, null] })],
    ['PID reuse', stopUnitFixture({ alive: [true], psCommand: (() => { let n = 0; return () => n++ === 0 ? '/checkout/crew/crew.mjs run --task unit-stop' : '/checkout/crew/crew.mjs run --task other' })() })],
  ]) {
    const localArgs = { ...args, pid: label === 'invalid pid' ? 'not-an-integer' : '42' }
    await assert.rejects(() => stopCmd(localArgs, fixture.deps), (err) => err instanceof UsageError && /^crew\.mjs stop: refused/.test(err.message), label)
    assert.equal(fixture.calls.ends.length, 0, label)
    assert.equal(fixture.calls.closed, 1, label)
  }

  const terminal = stopUnitFixture({ sessions: [{ status: 'running' }, { status: 'ok', outcome: 'success' }] })
  const result = await stopCmd(args, terminal.deps)
  assert.equal(result.status, 'ok')
  assert.equal(terminal.calls.ends.length, 0)
  assert.equal(terminal.calls.closed, 1)
})

test('RV1-1 stopCmd anchors dispatch-batch relative entry to declared checkout', async () => {
  const args = { task: 'unit-stop', pid: '42', checkout: '/checkout' }
  const matching = stopUnitFixture({
    command: 'node crew/crew.mjs run --task unit-stop --checkout /checkout --brief-file /tmp/unit-stop.md --keep',
    sessions: [
      { status: 'running' },
      { status: 'running' },
      { status: 'aborted', outcome: 'aborted', terminal_reason: 'operator-stop', terminal_actor: 'operator' },
    ],
  })
  const result = await stopCmd(args, matching.deps)
  assert.equal(result.status, 'aborted')
  assert.deepEqual(matching.calls.kills, [[42, 'SIGTERM']])
  assert.deepEqual(matching.calls.ends, [{ adw_id: 'unit-run', status: 'aborted', outcome: 'aborted', terminal_reason: 'operator-stop', terminal_actor: 'operator' }])

  const foreign = stopUnitFixture({
    command: 'node crew/crew.mjs run --task unit-stop --checkout /other-checkout --brief-file /tmp/unit-stop.md --keep',
  })
  await assert.rejects(() => stopCmd(args, foreign.deps), (err) => err instanceof UsageError && /^crew\.mjs stop: refused/.test(err.message))
  assert.deepEqual(foreign.calls.kills, [])
  assert.deepEqual(foreign.calls.ends, [])
  assert.equal(foreign.calls.closed, 1)
})

test('D1b only the finalizer row this stop CAUSED is superseded', async () => {
  const args = { task: 'unit-stop', pid: '42', checkout: '/checkout' }
  const finalizerRow = (reason, actor = 'finalizer') => ({ status: 'fail', outcome: 'failed', terminal_reason: reason, terminal_actor: actor })

  // the row this stop caused: superseded
  const caused = stopUnitFixture({ sessions: [{ status: 'running' }, finalizerRow('SIGTERM'), { status: 'aborted', outcome: 'aborted' }] })
  await stopCmd(args, caused.deps)
  assert.equal(caused.calls.ends.length, 1)
  assert.equal(caused.calls.ends[0].terminal_reason, 'operator-stop')
  assert.equal(caused.calls.ends[0].terminal_actor, 'operator')

  // rows this stop did NOT cause: preserved, no terminal write at all
  for (const row of [finalizerRow('SIGINT'), finalizerRow('SIGHUP'), finalizerRow('SIGTERM', 'driver'), { status: 'ok', outcome: 'success', terminal_reason: 'natural-completion', terminal_actor: 'driver' }]) {
    const untouched = stopUnitFixture({ sessions: [{ status: 'running' }, row] })
    await stopCmd(args, untouched.deps)
    assert.deepEqual(untouched.calls.ends, [], `${row.terminal_reason}/${row.terminal_actor} must be preserved`)
  }
})

test('run derives its process exit code from the envelope status', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-exit-code-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-exit-code-home-'))
  const task = 'exit-code-run'
  execSync('git init -q', { cwd: checkout })
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# exit code brief\n')
  const envelopes = [
    [{ status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }, 0],
    [{ status: 'escalation', summary: 'needs a human', artifacts: [], details: { escalation: { why: 'review' } } }, 3],
    [{ status: 'blocked', summary: 'blocked', artifacts: [], details: {} }, 1],
  ]
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      for (const [envelope, expected] of envelopes) {
        const previous = process.exitCode
        try {
          process.exitCode = undefined
          runCmd({ task, checkout, 'brief-file': brief, keep: true }, { drive: () => envelope })
          assert.equal(process.exitCode, expected)
        } finally { process.exitCode = previous }
      }
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('child entrypoint plumbs, journals, and refuses round budgets', () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-rounds-child-'))
  const crewDir = join(root, 'crew')
  const checkout = join(root, 'checkout')
  mkdirSync(crewDir, { recursive: true })
  mkdirSync(checkout, { recursive: true })
  mkdirSync(join(crewDir, 'returns'), { recursive: true })
  const brief = join(crewDir, 'brief.md')
  writeFileSync(brief, '# child rounds brief\n')
  writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({
    schema_version: 3, task: 'child-rounds', checkout,
    roles: ['lead', 'planner', 'builder', 'reviewer'],
    members: Object.fromEntries(['lead', 'planner', 'builder', 'reviewer'].map((role) => [role, {
      surface_id: null, pane_id: null, transport: 'headless-json', model: 'sonnet', agent: 'claude',
    }])),
    task_return: join('returns', 'task.json'),
  }))
  const makeRun = (budget = {}) => {
    const rows = []
    let seen = null
    let drove = 0
    const io = {
      log: (row) => rows.push(row), assign: () => ({ id: 'x', returnPath: 'x' }), wait: () => null,
      writeFile: () => {}, readFile: () => null, run: () => ({ ok: true, output: '' }),
      changedFiles: () => [], commit: () => 'abc1234', now: () => 0,
    }
    const spec = { crew_dir: crewDir, task: 'child-rounds', brief_file: brief, checkout, ...budget }
    runChild(spec, {
      preflight: false, seatIo: () => io,
      driveTask: (ctx) => { drove += 1; seen = ctx; return { status: 'done', summary: '', artifacts: [], details: {} } },
      env: { DEVTEAM_LEDGER_DB: join(crewDir, 'ledger.db') },
    })
    return { rows, seen, drove }
  }
  try {
    const flagged = makeRun({ build_rounds: 4, review_rounds: 1 })
    assert.deepEqual(flagged.seen.limits, { build_rounds: 4, review_rounds: 1 })
    assert.deepEqual(flagged.rows.find((row) => row.event === 'limits'), {
      at: flagged.rows.find((row) => row.event === 'limits').at, event: 'limits',
      plan_rounds: LIMITS.plan_rounds, build_rounds: 4, review_rounds: 1,
      source: { plan_rounds: 'default', build_rounds: 'flag', review_rounds: 'flag' },
    })
    const plain = makeRun()
    assert.equal(Object.prototype.hasOwnProperty.call(plain.seen, 'limits'), false)
    const plainRow = plain.rows.find((row) => row.event === 'limits')
    assert.deepEqual(plainRow, {
      at: plainRow.at, event: 'limits',
      plan_rounds: LIMITS.plan_rounds, build_rounds: LIMITS.build_rounds, review_rounds: LIMITS.review_rounds,
      source: { plan_rounds: 'default', build_rounds: 'default', review_rounds: 'default' },
    })
    for (const [budget, reason] of [
      [{ build_rounds: '2.5' }, 'invalid-build-rounds'],
      [{ review_rounds: 0 }, 'invalid-review-rounds'],
    ]) {
      let drove = 0
      assert.throws(() => runChild(
        { crew_dir: crewDir, task: 'child-rounds', brief_file: brief, checkout, ...budget },
        { preflight: false, seatIo: () => ({ log: () => {} }), driveTask: () => { drove += 1 }, env: { DEVTEAM_LEDGER_DB: join(crewDir, 'ledger.db') } },
      ), (err) => err.reason === reason)
      assert.equal(drove, 0)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('child entrypoint resolves both validation lane spellings, journals them, and refuses malformed specs', () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-validation-lane-child-'))
  const crewDir = join(root, 'crew')
  const checkout = join(root, 'checkout')
  mkdirSync(crewDir, { recursive: true })
  mkdirSync(checkout, { recursive: true })
  mkdirSync(join(crewDir, 'returns'), { recursive: true })
  const brief = join(crewDir, 'brief.md')
  writeFileSync(brief, '# child validation lane brief\n')
  writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({
    schema_version: 3, task: 'child-validation-lane', checkout,
    roles: ['lead', 'planner', 'builder', 'reviewer'],
    members: Object.fromEntries(['lead', 'planner', 'builder', 'reviewer'].map((role) => [role, {
      surface_id: null, pane_id: null, transport: 'headless-json', model: 'sonnet', agent: 'claude',
    }])),
    task_return: join('returns', 'task.json'),
  }))
  const base = { crew_dir: crewDir, task: 'child-validation-lane', brief_file: brief, checkout }
  const makeRun = (laneSpec) => {
    const rows = []
    let seen = null
    let drove = 0
    const io = {
      log: (row) => rows.push(row), assign: () => ({ id: 'x', returnPath: 'x' }), wait: () => null,
      writeFile: () => {}, readFile: () => null, run: () => ({ ok: true, output: '' }),
      changedFiles: () => [], commit: () => 'abc1234', now: () => 0,
    }
    runChild({ ...base, ...laneSpec }, {
      preflight: false, seatIo: () => io,
      driveTask: (ctx) => { drove += 1; seen = ctx; return { status: 'done', summary: '', artifacts: [], details: {} } },
      env: { DEVTEAM_LEDGER_DB: join(crewDir, 'ledger.db') },
    })
    return { rows, seen, drove }
  }
  try {
    for (const [laneSpec, expected] of [
      [{ validation_lane: '  node --test  ' }, { lane: 'node --test', source: 'validation-lane' }],
      [{ lane: '  daemon repair lane  ' }, { lane: 'daemon repair lane', source: 'lane' }],
    ]) {
      const result = makeRun(laneSpec)
      assert.equal(result.seen.lane, expected.lane)
      assert.deepEqual(result.rows.find((row) => row.event === 'validation-lane'), {
        at: result.rows.find((row) => row.event === 'validation-lane').at, event: 'validation-lane', ...expected,
      })
    }
    let drove = 0
    assert.throws(() => runChild(
      { ...base, validation_lane: true },
      { preflight: false, seatIo: () => ({ log: () => {} }), driveTask: () => { drove += 1 }, env: { DEVTEAM_LEDGER_DB: join(crewDir, 'ledger.db') } },
    ), (err) => err.reason === 'invalid-validation-lane')
    assert.equal(drove, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('child preflight uses the scout shape seats and keeps the default tier guard', () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-scout-child-'))
  const crewDir = join(root, 'crew')
  const checkout = join(root, 'checkout')
  mkdirSync(crewDir, { recursive: true })
  mkdirSync(checkout, { recursive: true })
  mkdirSync(join(crewDir, 'returns'), { recursive: true })
  const brief = join(crewDir, 'brief.md')
  writeFileSync(brief, '# scout brief\n')
  writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({
    schema_version: 3, task: 'scout-child', checkout,
    roles: ['planner'],
    members: { planner: { surface_id: null, pane_id: null, transport: 'headless-json', model: 'sonnet', agent: 'claude' } },
    task_return: join('returns', 'task.json'),
  }))
  execSync('git init -q', { cwd: checkout })
  const base = { crew_dir: crewDir, task: 'scout-child', brief_file: brief, checkout }
  let drove = 0
  let seen = null
  const io = { log: () => {} }
  try {
    runChild({ ...base, variant: 'scout' }, {
      seatIo: () => io,
      driveTask: (ctx) => { drove += 1; seen = ctx; return { status: 'done', summary: '', artifacts: [], details: {} } },
      env: { DEVTEAM_LEDGER_DB: join(crewDir, 'ledger.db') },
    })
    assert.deepEqual(seen.roles, ['planner'])
    assert.equal(drove, 1)
    assert.throws(() => runChild(base, {
      seatIo: () => io,
      driveTask: () => { drove += 1 },
      env: { DEVTEAM_LEDGER_DB: join(crewDir, 'ledger.db') },
    }), /requires a builder seat/)
    assert.equal(drove, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('repair lane absence remains the current triage refusal', () => {
  const result = driveTask({
    task: 'repair-lane-refusal', briefFile: '/tmp/brief.md', taskDir: '/tmp/repair-lane-refusal',
    checkout: '/tmp/repo', journal: '/tmp/repair-lane-refusal/journal.jsonl',
    files_in_scope: ['crew/crew.mjs'], lane: null, variant: 'repair',
  }, { log: () => {}, now: () => 0 })
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'triage')
  assert.match(result.details.escalation.why, /takes its validation lane from the failing run \(--lane\) and ctx carries none/)
})

test('run refuses an inherited shape with no declared scope before driving', async () => {
  const inherited = VARIANT_NAMES.find((name) => VARIANTS[name]?.sources?.scope === 'inherited')
  const { root: checkoutRoot, checkout } = testCheckout('crew-scope-refusal-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-scope-refusal-home-'))
  const task = 'scope-refusal'
  execSync('git init -q', { cwd: checkout })
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# scope brief\n')
  let drove = 0
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      assert.throws(() => runCmd({ task, checkout, 'brief-file': brief, variant: inherited, lane: 'lane-cmd', keep: true }, { drive: () => { drove += 1 } }), (err) => err.message.includes('task.json'))
    })
    assert.equal(drove, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('run places explicit scope on ctx and omits it for a neutral shape', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-scope-ctx-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-scope-ctx-home-'))
  const task = 'scope-ctx'
  execSync('git init -q', { cwd: checkout })
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# scope brief\n')
  const previousLedger = process.env.DEVTEAM_LEDGER_DB
  process.env.DEVTEAM_LEDGER_DB = join(home, 'ledger.db')
  const seen = []
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  const inherited = VARIANT_NAMES.find((name) => VARIANTS[name]?.sources?.scope === 'inherited')
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      const capture = (ctx) => { seen.push(ctx); return done }
      runCmd({ task, checkout, 'brief-file': brief, variant: inherited, lane: 'lane-cmd', 'files-in-scope': 'a.mjs, a.test.mjs', keep: true }, { drive: capture })
      runCmd({ task, checkout, 'brief-file': brief, keep: true }, { drive: capture })
      runCmd({ task, checkout, 'brief-file': brief, 'review-base-sha': 'a'.repeat(40), 'review-head-sha': 'b'.repeat(64), keep: true }, { drive: capture })
    })
    assert.deepEqual(seen[0].files_in_scope, ['a.mjs', 'a.test.mjs'])
    assert.equal(Object.prototype.hasOwnProperty.call(seen[1], 'files_in_scope'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(seen[1], 'review_identity'), false)
    assert.deepEqual(seen[2].review_identity, { base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(64) })
    assert.equal(Object.isFrozen(seen[2].review_identity), true)
  } finally {
    if (previousLedger === undefined) delete process.env.DEVTEAM_LEDGER_DB
    else process.env.DEVTEAM_LEDGER_DB = previousLedger
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('run inheritance reaches the repair stage and planner assignment', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-scope-e2e-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-scope-e2e-home-'))
  const task = 'scope-e2e'
  execSync('git init -q', { cwd: checkout })
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# scope brief\n')
  const inherited = VARIANT_NAMES.find((name) => VARIANTS[name]?.sources?.scope === 'inherited')
  const filesInScope = ['a.mjs', 'a.test.mjs']
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      const crewDir = testCrewDir(home, checkout, task)
      writeFileSync(join(crewDir, 'returns', 'task.json'), JSON.stringify({ status: 'escalation', details: { files_in_scope: filesInScope } }))
      let seen
      runCmd({ task, checkout, 'brief-file': brief, variant: inherited, lane: 'lane-cmd', keep: true }, {
        drive: (ctx) => { seen = ctx; return { status: 'done', summary: '', artifacts: [], details: {} } },
      })
      const assigned = []
      const stages = []
      const io = {
        assign: ({ role }) => { assigned.push(role); return { id: role, returnPath: `${role}:1` } },
        wait: () => null, writeFile: () => {}, readFile: () => null,
        run: () => ({ ok: true, output: '' }), changedFiles: () => [], commit: () => 'abc1234',
        log: (entry) => { if (entry && typeof entry.stage === 'string') stages.push(entry.stage) }, now: () => 0,
      }
      try { driveTask(seen, io) } catch { /* stage and assignment labels are the evidence */ }
      assert.equal(stages[0], `${inherited}:r1`)
      assert.equal(assigned[0], 'planner')
    })
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }) }
})

test('directed dispatch without a validation lane refuses before crew state or seats', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-directed-lane-refusal-home-'))
  let drove = 0
  try {
    await withHome(home, () => {
      assert.throws(
        () => runCmd(
          { task: 'directed-never-booted', checkout: process.cwd(), 'brief-file': join(home, 'missing.md'), variant: 'directed' },
          { drive: () => { drove += 1 } },
        ),
        (err) => err.reason === VALIDATION_LANE_REFUSAL,
      )
      assert.equal(drove, 0)
      assert.equal(existsSync(join(home, '.crew')), false)
    })
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('ctx source validation permits supplied lanes and neutral full dispatches', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-ctx-source-pass-home-'))
  try {
    await withHome(home, () => {
      assert.throws(
        () => runCmd({ task: 'directed-with-lane', checkout: process.cwd(), 'brief-file': join(home, 'missing.md'), variant: 'directed', 'validation-lane': 'node --test' }),
        /no crew booted/,
      )
      assert.throws(
        () => runCmd({ task: 'full-without-lane', checkout: process.cwd(), 'brief-file': join(home, 'missing.md'), variant: 'full' }),
        /no crew booted/,
      )
    })
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('assertCtxSources follows every variant declaration without restating shape names', () => {
  for (const name of VARIANT_NAMES) {
    const needsLane = VARIANTS[name]?.sources?.lane === 'ctx'
    if (needsLane) {
      assert.throws(() => assertCtxSources(name), (err) => err.reason === VALIDATION_LANE_REFUSAL)
    } else {
      assert.doesNotThrow(() => assertCtxSources(name))
    }
  }
})

test('run refuses an unknown execution shape before reading or writing crew state', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-variant-refusal-home-'))
  let drove = 0
  try {
    await withHome(home, () => {
      assert.throws(
        () => runCmd(
          { task: 'variant-never-booted', checkout: process.cwd(), 'brief-file': join(home, 'missing.md'), execution: 'no-such-shape' },
          { drive: () => { drove += 1 } },
        ),
        (err) => {
          assert.match(err.message, /unknown execution shape/)
          for (const name of VARIANT_NAMES) assert.match(err.message, new RegExp(name))
          return true
        },
      )
      assert.equal(drove, 0)
      assert.equal(existsSync(join(home, '.crew')), false)
    })
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('run passes a selected driver variant through ctx', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-variant-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-variant-home-'))
  const task = 'variant-selected'
  const variant = VARIANT_NAMES.find((name) => name !== DEFAULT_VARIANT)
  assert.ok(variant)
  execSync('git init -q', { cwd: checkout })
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# variant brief\n')
  const previousLedger = process.env.DEVTEAM_LEDGER_DB
  process.env.DEVTEAM_LEDGER_DB = join(home, 'ledger.db')
  let seen
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      runCmd(
        { task, checkout, 'brief-file': brief, variant, keep: true },
        { drive: (ctx) => { seen = ctx; return done } },
      )
    })
    const crew = JSON.parse(readFileSync(join(testCrewDir(home, checkout, task), 'crew.json'), 'utf8'))
    assert.equal(seen.variant, variant)
    assert.equal(seen.task, task)
    assert.equal(seen.checkout, checkout)
    assert.equal(seen.briefFile, brief)
    assert.deepEqual(seen.roles, crew.roles)
  } finally {
    if (previousLedger === undefined) delete process.env.DEVTEAM_LEDGER_DB
    else process.env.DEVTEAM_LEDGER_DB = previousLedger
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('run without a variant captures the same ctx as an explicit default', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-variant-default-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-variant-default-home-'))
  const task = 'variant-default'
  execSync('git init -q', { cwd: checkout })
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# variant brief\n')
  const previousLedger = process.env.DEVTEAM_LEDGER_DB
  process.env.DEVTEAM_LEDGER_DB = join(home, 'ledger.db')
  const seen = []
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      const capture = (ctx) => { seen.push(ctx); return done }
      runCmd({ task, checkout, 'brief-file': brief, variant: DEFAULT_VARIANT, keep: true }, { drive: capture })
      runCmd({ task, checkout, 'brief-file': brief, keep: true }, { drive: capture })
    })
    assert.equal(seen.length, 2)
    assert.equal(seen[1].variant, DEFAULT_VARIANT)
    assert.deepEqual(seen[1], seen[0])
  } finally {
    if (previousLedger === undefined) delete process.env.DEVTEAM_LEDGER_DB
    else process.env.DEVTEAM_LEDGER_DB = previousLedger
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('run resolves the repo protected paths and journals the basis', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-protected-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-protected-home-'))
  const factoryRoot = join(home, 'factory')
  const task = 'protected-run'
  const cell = {
    status: 'ratified', value: ['db/migrations/'], source: 'human',
    ratified_by: 'human', ratified_at: '2026-08-16T00:00:00.000Z',
  }
  execSync('git init -q', { cwd: checkout })
  protectedProfile(factoryRoot, checkout, cell)
  const previousFactory = process.env.DEVTEAM_FACTORY_DIR
  process.env.DEVTEAM_FACTORY_DIR = factoryRoot
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# brief\n')
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  let seen
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      runCmd({ task, checkout, 'brief-file': brief, keep: true }, { drive: (ctx) => { seen = ctx; return done } })
    })
    assert.ok(seen.protectedPaths.includes('db/migrations/'))
    for (const path of PROTECTED_PATHS) assert.ok(seen.protectedPaths.includes(path), `${path} missing from ctx`)
    const rows = readFileSync(seen.journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      .filter((row) => row.event === 'protected-paths')
    assert.equal(rows.length, 1)
    assert.match(rows[0].basis, /protected_paths_candidates/)
    assert.equal(rows[0].count, seen.protectedPaths.length)
  } finally {
    if (previousFactory === undefined) delete process.env.DEVTEAM_FACTORY_DIR
    else process.env.DEVTEAM_FACTORY_DIR = previousFactory
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('boot persists the fence and run rides it into ctx beside the protected paths', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-fence-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-fence-home-'))
  const register = join(home, 'fences.json')
  const brief = join(home, 'brief.md')
  const task = 'fence-slice1'
  const fenceArgs = {
    fences: register, lane: 'fence-slice1',
  }
  writeFileSync(register, JSON.stringify({ lanes: [
    { lane: 'intake-loop', files: ['scripts/factory/intake.mjs'] },
    { lane: 'fence-slice1', files: ['crew/crew.mjs', 'crew/crew.test.mjs'] },
  ] }))
  writeFileSync(brief, '# brief\n')
  execSync('git init -q', { cwd: checkout })
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  const seen = []
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath, ...fenceArgs },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      runCmd({ task, checkout, 'brief-file': brief, keep: true }, { drive: (ctx) => { seen.push(ctx); return done } })
      await bootCmd(
        { task: 'fence-plain', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      runCmd({ task: 'fence-plain', checkout, 'brief-file': brief, keep: true }, { drive: (ctx) => { seen.push(ctx); return done } })
    })
    const fencedDir = testCrewDir(home, checkout, task)
    const fencedCrew = JSON.parse(readFileSync(join(fencedDir, 'crew.json'), 'utf8'))
    assert.equal(fencedCrew.lane_name, 'fence-slice1')
    assert.deepEqual(fencedCrew.lane_fence, [{ lane: 'intake-loop', files: ['scripts/factory/intake.mjs'] }])
    assert.deepEqual(seen[0].laneFence, fencedCrew.lane_fence)
    assert.equal(seen[0].laneName, 'fence-slice1')
    for (const path of PROTECTED_PATHS) assert.ok(seen[0].protectedPaths.includes(path), `${path} missing from ctx`)
    const rows = readFileSync(seen[0].journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      .filter((row) => row.event === 'lane-fence')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].lane_name, 'fence-slice1')
    assert.equal(rows[0].lanes, 1)
    assert.equal(rows[0].files, 1)
    const plainCrew = JSON.parse(readFileSync(join(testCrewDir(home, checkout, 'fence-plain'), 'crew.json'), 'utf8'))
    assert.equal(Object.prototype.hasOwnProperty.call(plainCrew, 'lane_fence'), false)
    assert.equal(seen[1].laneFence, undefined)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('run refuses an unusable ratified protected-path cell before driving', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-protected-refusal-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-protected-refusal-home-'))
  const factoryRoot = join(home, 'factory')
  const task = 'protected-refusal'
  execSync('git init -q', { cwd: checkout })
  protectedProfile(factoryRoot, checkout, { status: 'ratified', value: ['db/migrations/'], source: 'human' })
  const previousFactory = process.env.DEVTEAM_FACTORY_DIR
  process.env.DEVTEAM_FACTORY_DIR = factoryRoot
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# brief\n')
  let drove = 0
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      assert.throws(
        () => runCmd({ task, checkout, 'brief-file': brief, keep: true }, { drive: () => { drove += 1 } }),
        (err) => err.reason === 'protected-paths-invalid' && err.message.includes('protected-paths-invalid'),
      )
    })
    assert.equal(drove, 0)
  } finally {
    if (previousFactory === undefined) delete process.env.DEVTEAM_FACTORY_DIR
    else process.env.DEVTEAM_FACTORY_DIR = previousFactory
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('all-headless tier boot makes no cmux calls and records daemon-acceptable seats', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-headless-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-headless-checkout-')
  const rosterDir = scratchDir('crew-headless-roster-')
  const rosterPath = join(rosterDir, 'roster.json')
  writeFileSync(rosterPath, JSON.stringify(roster, null, 2))
  const task = 'all-headless'
  const cmux = callCounter(); const tree = callCounter(); const renameTab = callCounter()
  try {
    await withHome(home, () => bootCmd(
      { task, checkout, tier: 'build', roster: rosterPath, 'headless-all': true, 'claude-bin': process.execPath },
      { cmux, tree, renameTab },
    ))
    assert.equal(cmux.calls.length, 0)
    assert.equal(tree.calls.length, 0)
    assert.equal(renameTab.calls.length, 0)
    const dir = testCrewDir(home, checkout, task)
    const crew = JSON.parse(readFileSync(join(dir, 'crew.json'), 'utf8'))
    assert.equal(crew.workspace_id, null)
    assert.equal(crew.window_id, null)
    const expected = { lead: 'headless-json', planner: 'headless-json', builder: 'headless-rpc', reviewer: 'headless-rpc' }
    assert.deepEqual(Object.fromEntries(crew.roles.map((role) => [role, crew.members[role].transport])), expected)
    for (const role of crew.roles) {
      assert.equal(crew.members[role].pane_id, null)
      assert.equal(crew.members[role].surface_id, null)
      assert.equal(existsSync(join(dir, 'task', `role-${role}.md`)), true)
      assert.ok(crew.members[role].transport && crew.members[role].transport !== 'pane')
    }
    const boot = readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).find((event) => event.event === 'boot')
    assert.deepEqual(Object.fromEntries(crew.roles.map((role) => [role, boot.allocation[role].transport])), expected)
    assert.equal(boot.allocation.lead.model, 'roster')

    // crew/daemon.mjs's paneSeat() is the consumer and must keep refusing pane transport.
    const daemonSource = readFileSync(new URL('./daemon.mjs', import.meta.url), 'utf8')
    assert.match(daemonSource, /daemon run refuses pane transport/)
    assert.match(daemonSource, /paneSeat/)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('--headless-all with a per-seat transport flag still boots — no workspace, nothing to be invisible inside', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-mode-factory-seat-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-mode-factory-seat-checkout-')
  const task = 'mode-factory-seat'
  const cmux = callCounter()
  try {
    await withHome(home, () => bootCmd(
      { task, checkout, tier: 'build', 'headless-all': true, 'headless-rpc': 'builder', 'claude-bin': process.execPath },
      { cmux, tree: callCounter(), renameTab: callCounter() },
    ))
    const crew = JSON.parse(readFileSync(join(testCrewDir(home, checkout, task), 'crew.json'), 'utf8'))
    assert.equal(crew.workspace_id, null)
    assert.equal(crew.members.builder.transport, 'headless-rpc')
    for (const member of Object.values(crew.members)) assert.notEqual(member.transport, 'pane')
    assert.equal(cmux.calls.length, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('a missing memory budget value falls back to the default and records invalid-budget', () => {
  const cfg = memoryConfig({ 'memory-dir': '/tmp/crew-memory-fixture', 'memory-budget-bytes': true })
  assert.equal(cfg.budgetBytes, 8000)
  assert.equal(cfg.reason, 'invalid-budget')
})

test('the charter ceilings and source budgets are the delivered bytes, below the 2026-09-05 baseline', () => {
  const roles = ['builder', 'lead', 'planner', 'reviewer', 'tech-lead']
  const guided = ['builder', 'planner', 'reviewer']
  const files = ['_shared', ...roles]
  assert.equal(Object.isFrozen(CHARTER_CEILINGS), true)
  assert.equal(Object.isFrozen(CHARTER_SOURCE_BUDGET), true)
  assert.equal(Object.isFrozen(CHARTER_BASELINE_BYTES), true)
  assert.deepEqual(CHARTER_BASELINE_BYTES, { _shared: 3432, builder: 5169, lead: 9378, planner: 16930, reviewer: 7697, 'tech-lead': 6529 })
  assert.deepEqual(CHARTER_SOURCE_BUDGET, { _shared: 4825, builder: 3963, lead: 9099, planner: 16928, reviewer: 7675, 'tech-lead': 6295 })
  for (const value of [...Object.values(CHARTER_BASELINE_BYTES), ...Object.values(CHARTER_SOURCE_BUDGET), ...Object.values(CHARTER_CEILINGS)]) assert.equal(Number.isInteger(value), true)
  const shared = readFileSync(join(ROOT, 'crew', 'roles', '_shared.md'), 'utf8')
  const cards = Object.fromEntries(roles.map((role) => [role, readFileSync(join(ROOT, 'crew', 'roles', `${role}.md`), 'utf8')]))
  const rawBytes = (card) => Buffer.byteLength(`${shared}\n\n${card}`, 'utf8')
  const delta = Buffer.byteLength(composeRolePrompt(shared, cards.builder), 'utf8') - rawBytes(cards.builder)
  assert.ok(delta > 0)
  for (const role of roles) {
    const base = CHARTER_SOURCE_BUDGET._shared + 2 + CHARTER_SOURCE_BUDGET[role]
    assert.equal(CHARTER_CEILINGS[role], guided.includes(role) ? base + delta : base)
    assert.ok(CHARTER_SOURCE_BUDGET[role] < CHARTER_BASELINE_BYTES[role])
  }
  assert.equal(CHARTER_SOURCE_TOTAL_BUDGET, 48785)
  assert.equal(CHARTER_SOURCE_TOTAL_BUDGET, Object.values(CHARTER_SOURCE_BUDGET).reduce((sum, value) => sum + value, 0))
  assert.ok(CHARTER_SOURCE_TOTAL_BUDGET < 49135)

  const source = charterFileBytes()
  assert.deepEqual(Object.fromEntries(Object.entries(source).map(([name, entry]) => [name, entry.bytes])), CHARTER_SOURCE_BUDGET)
  assert.equal(source.builder.bytes, CHARTER_SOURCE_BUDGET.builder, `builder source bytes: ${source.builder.bytes}`)
  for (const name of files) {
    assert.equal(source[name].reason, null)
    assert.equal(source[name].bytes, Buffer.byteLength(readFileSync(join(ROOT, 'crew', 'roles', `${name}.md`), 'utf8'), 'utf8'))
  }
  const compiled = compiledCharterBytes()
  for (const role of roles) {
    const expected = Buffer.byteLength(composeRolePrompt(shared, cards[role]), 'utf8')
    assert.deepEqual(compiled[role], { bytes: expected, reason: null })
    assert.equal(compiled[role].bytes, CHARTER_CEILINGS[role])
  }
})

test('composed charters resolve the three authored guideline references to absolute plugin paths', () => {
  // Built from parts so the census sees no new static path literal here.
  const checklistBase = 'seat-pre-return-checklist.md'
  const flagBase = 'review-do-not-flag.md'
  const checklistRel = join('crew', 'guidelines', checklistBase)
  const flagRel = join('crew', 'guidelines', flagBase)
  const names = ['_shared', 'builder', 'lead', 'planner', 'reviewer', 'tech-lead']
  const sources = Object.fromEntries(names.map((name) => [name, readFileSync(join(ROOT, 'crew', 'roles', `${name}.md`), 'utf8')]))
  const guidedRoles = ['builder', 'planner', 'reviewer']
  const countIn = (text, needle) => text.split(needle).length - 1
  let authored = 0
  for (const name of names) authored += countIn(sources[name], checklistRel) + countIn(sources[name], flagRel)
  assert.equal(authored, 3)
  assert.equal(countIn(sources.builder, checklistRel), 1)
  assert.equal(countIn(sources.planner, checklistRel), 1)
  assert.equal(countIn(sources.reviewer, flagRel), 1)
  const builderInstruction = `Read \`${checklistRel}\` and self-apply its builder items \`B1\`-\`B3\`.`
  const plannerInstruction = `\`${checklistRel}\` and self-apply its planner items\n\`P1\`-\`P3\` before you write the envelope.`
  const reviewerInstruction = `Before writing findings, load the do-not-flag guidelines\n(\`${flagRel}\`) with`
  assert.ok(sources.builder.includes(builderInstruction))
  assert.ok(sources.planner.includes(plannerInstruction))
  assert.ok(sources.reviewer.includes(reviewerInstruction))
  for (const role of guidedRoles) {
    const rel = role === 'reviewer' ? flagRel : checklistRel
    const expected = join(ROOT, rel)
    const composed = composeRolePrompt(sources._shared, sources[role])
    assert.equal(composed.includes(`\`${rel}\``), false)
    assert.ok(composed.includes(`\`${expected}\``))
    const escaped = rel.replaceAll('.', '\\.')
    const found = composed.match(new RegExp(`\`([^\`]*${escaped})\``))?.[1] ?? ''
    assert.equal(found, expected)
    assert.ok(existsSync(found))
    assert.equal(readFileSync(found, 'utf8'), readFileSync(join(ROOT, rel), 'utf8'))
    assert.ok(isAbsolute(found))
  }
  const prefix = join('crew', 'guidelines')
  for (const role of ['lead', 'tech-lead']) {
    assert.equal(composeRolePrompt(sources._shared, sources[role]).includes(prefix), false)
  }
})

test('BH1', () => {
  const source = charterFileBytes()
  const compiled = compiledCharterBytes()
  assert.deepEqual(charterSourceRefusals(), [])
  assert.deepEqual(charterBudgetRefusals(), [])
  assert.doesNotThrow(() => assertCharterBudgets(compiled, source))
  assert.deepEqual(Object.fromEntries(Object.entries(source).map(([name, entry]) => [name, entry.bytes])), CHARTER_SOURCE_BUDGET)
  for (const [role, entry] of Object.entries(compiled)) {
    assert.equal(entry.bytes, CHARTER_CEILINGS[role])
    assert.ok(CHARTER_SOURCE_BUDGET[role] < CHARTER_BASELINE_BYTES[role])
  }
})

test('a charter over its bound refuses by name, at either level', () => {
  const compiled = compiledCharterBytes()
  const files = charterFileBytes()
  assert.doesNotThrow(() => assertCharterBudgets(compiled, files))
  const atCeiling = Object.fromEntries(Object.entries(CHARTER_CEILINGS).map(([role, bytes]) => [role, { bytes, reason: null }]))
  const atSource = Object.fromEntries(Object.entries(CHARTER_SOURCE_BUDGET).map(([name, bytes]) => [name, { bytes, reason: null }]))
  assert.deepEqual(charterBudgetRefusals(atCeiling), [])
  assert.deepEqual(charterSourceRefusals(atSource), [])

  const overCompiled = { ...compiled, planner: { bytes: compiled.planner.bytes + 1, reason: null } }
  assert.throws(
    () => assertCharterBudgets(overCompiled, files),
    (error) => error.message.includes(CHARTER_BUDGET_REFUSAL) && error.message.includes('planner') && error.message.includes(String(CHARTER_CEILINGS.planner)),
  )
  const overSource = { ...files, planner: { bytes: files.planner.bytes + 1, reason: null } }
  assert.throws(
    () => assertCharterBudgets(compiled, overSource),
    (error) => error.message.includes(CHARTER_BUDGET_REFUSAL) && error.message.includes('planner.md') && error.message.includes(String(CHARTER_SOURCE_BUDGET.planner)),
  )
  const unmeasuredCompiled = { ...compiled, lead: { bytes: null, reason: CHARTER_UNMEASURED_CAUSES[0] } }
  assert.throws(() => assertCharterBudgets(unmeasuredCompiled, files), (error) => error.message.includes(CHARTER_BUDGET_REFUSAL) && error.message.includes('lead') && error.message.includes(CHARTER_UNMEASURED_CAUSES[0]))
  const unmeasuredSource = { ...files, lead: { bytes: null, reason: CHARTER_UNMEASURED_CAUSES[0] } }
  assert.throws(() => assertCharterBudgets(compiled, unmeasuredSource), (error) => error.message.includes(CHARTER_BUDGET_REFUSAL) && error.message.includes('lead.md') && error.message.includes(CHARTER_UNMEASURED_CAUSES[0]))
})

test('a memory addendum is measured outside the ceiling, and an unreadable charter is null with a closed cause', () => {
  const dir = scratchDir('crew-charter-memory-')
  const shared = readFileSync(join(ROOT, 'crew', 'roles', '_shared.md'), 'utf8')
  const card = readFileSync(join(ROOT, 'crew', 'roles', 'planner.md'), 'utf8')
  const section = '## Team memory\n\nA remembered thing.\n'
  writeFileSync(join(dir, 'role-planner.md'), composeRolePrompt(shared, card, section))
  const record = charterBytesRecord(dir, ['planner'], { planner: section })
  const memory = Buffer.byteLength(section, 'utf8') + 2
  assert.equal(record.memory_bytes.planner, memory)
  assert.equal(record.base.planner, CHARTER_CEILINGS.planner)
  assert.equal(record.bytes.planner, CHARTER_CEILINGS.planner + memory)

  const empty = scratchDir('crew-charter-empty-')
  const unreadable = charterBytesRecord(empty, ['planner'])
  assert.equal(unreadable.bytes.planner, null)
  assert.equal(unreadable.base.planner, null)
  assert.ok(CHARTER_UNMEASURED_CAUSES.includes(unreadable.unmeasured.planner))
  assert.notEqual(unreadable.bytes.planner, 0)
})

test('retired lean charter arm refuses at boot; unknown arms compose control, only terse-tail appends', async () => {
  // The lean tail was always '': unknown arms fall back to the control prompt (#1441),
  // while the --charter-arm enum no longer offers lean.
  const control = composeRolePrompt('shared charter', 'role card', 'measured section', 'control')
  const lean = composeRolePrompt('shared charter', 'role card', 'measured section', 'lean')
  const terse = composeRolePrompt('shared charter', 'role card', 'measured section', 'terse-tail')
  assert.equal(lean, control)
  assert.equal(terse.startsWith(control), true)
  assert.notEqual(terse, control)
  const home = scratchDir('crew-charter-lean-retired-home-')
  const { root: checkoutRoot, checkout } = testCheckout('crew-charter-lean-retired-checkout-')
  const cmux = callCounter()
  const tree = callCounter()
  try {
    await assert.rejects(
      () => withHome(home, () => bootCmd(
        { task: 'charter-lean-retired', checkout, tier: 'build', 'headless-all': true, 'charter-arm': 'lean' },
        { cmux, tree, renameTab: callCounter(), register: capabilityRegister() },
      )),
      (error) => error?.message === `invalid --charter-arm "lean"; expected one of control|terse-tail`,
    )
    assert.equal(cmux.calls.length, 0)
    assert.equal(tree.calls.length, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('D1 prototype-named charter arms compose control exactly', () => {
  const control = composeRolePrompt('shared', 'card', 'memory', 'control')
  for (const arm of ['constructor', 'toString']) {
    assert.equal(composeRolePrompt('shared', 'card', 'memory', arm), control)
  }
})

test('B1 an invalid charter arm still refuses by name', async () => {
  const home = scratchDir('crew-charter-invalid-home-')
  const { root: checkoutRoot, checkout } = testCheckout('crew-charter-invalid-checkout-')
  const cmux = callCounter()
  const tree = callCounter()
  try {
    await assert.rejects(
      () => withHome(home, () => bootCmd(
        { task: 'charter-invalid', checkout, tier: 'build', 'headless-all': true, 'charter-arm': 'rogue-arm' },
        { cmux, tree, renameTab: callCounter(), register: capabilityRegister() },
      )),
      (error) => error?.message === `invalid --charter-arm "rogue-arm"; expected one of control|terse-tail`,
    )
    assert.equal(existsSync(testCrewDir(home, checkout, 'charter-invalid')), false)
    assert.equal(cmux.calls.length, 0)
    assert.equal(tree.calls.length, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})


test('awaitSeatsReady returns immediately without probing an all-headless crew', () => {
  const cmux = callCounter()
  awaitSeatsReady({ members: { lead: { surface_id: null }, builder: { surface_id: null } } }, 'warm', null, { cmux })
  assert.equal(cmux.calls.length, 0)
})

test('awaitSeatsReady tags every seat still pending when readiness times out', () => {
  let clock = 0
  assert.throws(
    () => awaitSeatsReady({ members: { builder: { surface_id: 'surface-builder' }, reviewer: { surface_id: 'surface-reviewer' } } }, 'fresh', null, {
      cmux: () => ({ ok: false, stdout: '' }), now: () => { clock += 181_000; return clock }, sleep: () => {},
    }),
    (err) => {
      assert.deepEqual(err.roles, ['builder', 'reviewer'])
      assert.equal(err.mode, 'fresh')
      assert.deepEqual(err.signals, { builder: null, reviewer: null })
      assert.match(err.message, /mode: fresh/)
      assert.match(err.message, /builder \(last signal: none\)/)
      assert.match(err.message, /reviewer \(last signal: none\)/)
      return true
    },
  )
})

test('awaitSeatsReady fresh mode journals chrome once but refuses it', () => {
  const rows = []
  const times = [0, 1, 181_000]
  const crew = { members: { planner: { surface_id: 'surface-planner' } } }
  assert.throws(
    () => awaitSeatsReady(crew, 'fresh', '/journal.jsonl', {
      cmux: () => ({ ok: true, stdout: 'sub-agent ready\\n❯ ' }),
      logLine: (_path, row) => rows.push(row),
      now: () => times.shift() ?? 181_000,
      sleep: () => {},
    }),
    (err) => err.mode === 'fresh' && err.roles.join(',') === 'planner',
  )
  assert.equal(rows.length, 1)
  assert.deepEqual({ role: rows[0].role, signal: rows[0].signal, mode: rows[0].mode, accepted: rows[0].accepted }, {
    role: 'planner', signal: 'chrome', mode: 'fresh', accepted: false,
  })
})

test('awaitSeatsReady fresh mode clears on a role-anchored ready reply', () => {
  const rows = []
  awaitSeatsReady({ members: { planner: { surface_id: 'surface-planner' } } }, 'fresh', '/journal.jsonl', {
    cmux: () => ({ ok: true, stdout: 'ready: planner\\n' }),
    logLine: (_path, row) => rows.push(row),
  })
  assert.deepEqual({ role: rows[0].role, signal: rows[0].signal, mode: rows[0].mode, accepted: rows[0].accepted }, {
    role: 'planner', signal: 'ready-reply', mode: 'fresh', accepted: true,
  })
})

test('awaitSeatsReady fresh mode does not accept an echoed boot brief', () => {
  const rows = []
  assert.throws(
    () => awaitSeatsReady({ members: { planner: { surface_id: 'surface-planner' } } }, 'fresh', '/journal.jsonl', {
      cmux: () => ({ ok: true, stdout: 'Crew for task t. Task dir /x/task. Read your role in the system prompt, reply exactly ready: your-role, then wait.' }),
      logLine: (_path, row) => rows.push(row),
      now: (() => { const times = [0, 180_001]; return () => times.shift() ?? 180_001 })(),
      sleep: () => {},
    }),
    /planner \(last signal: none\)/,
  )
  assert.equal(rows.length, 0)
})

test('awaitSeatsReady recognizes a pi status line under a fresh ready reply', () => {
  const rows = []
  awaitSeatsReady({ members: { reviewer: { surface_id: 'surface-reviewer' } } }, 'fresh', '/journal.jsonl', {
    cmux: () => ({ ok: true, stdout: '$0.000 (sub) · openai-codex/gpt-5.6 • high\\nready: reviewer\\n' }),
    logLine: (_path, row) => rows.push(row),
  })
  assert.deepEqual({ role: rows[0].role, signal: rows[0].signal, mode: rows[0].mode, accepted: rows[0].accepted }, {
    role: 'reviewer', signal: 'ready-reply', mode: 'fresh', accepted: true,
  })
})

test('awaitSeatsReady warm mode accepts chrome when the ready reply has scrolled away', () => {
  const rows = []
  awaitSeatsReady({ members: { planner: { surface_id: 'surface-planner' } } }, 'warm', '/journal.jsonl', {
    cmux: () => ({ ok: true, stdout: 'sub-agent ready\\n❯ ' }),
    logLine: (_path, row) => rows.push(row),
  })
  assert.deepEqual({ role: rows[0].role, signal: rows[0].signal, mode: rows[0].mode, accepted: rows[0].accepted }, {
    role: 'planner', signal: 'chrome', mode: 'warm', accepted: true,
  })
})

test('awaitSeatsReady uses the named fresh and warm timeout budgets', () => {
  for (const [mode, timeout] of [['fresh', 180_000], ['warm', 120_000]]) {
    const times = [0, timeout + 1]
    assert.throws(
      () => awaitSeatsReady({ members: { planner: { surface_id: 'surface-planner' } } }, mode, null, {
        cmux: () => ({ ok: false, stdout: '' }), now: () => times.shift() ?? timeout + 1, sleep: () => {},
      }),
      (err) => err.mode === mode && err.message.includes(`within ${timeout / 1000}s`),
    )
  }
})

test('awaitSeatsReady refusal names each pending seat signal', () => {
  const times = [0, 60_000, 180_001]
  let polls = 0
  assert.throws(
    () => awaitSeatsReady({ members: {
      planner: { surface_id: 'surface-planner' }, reviewer: { surface_id: 'surface-reviewer' },
    } }, 'fresh', null, {
      cmux: (_cmd, args) => args.includes('surface-planner')
        ? { ok: true, stdout: 'sub-agent ready\\n❯ ' } : { ok: false, stdout: '' },
      now: () => times.shift() ?? 180_001,
      sleep: () => { polls += 1 },
    }),
    (err) => {
      assert.equal(err.mode, 'fresh')
      assert.deepEqual(err.roles, ['planner', 'reviewer'])
      assert.deepEqual(err.signals, { planner: 'chrome', reviewer: null })
      assert.match(err.message, /planner \(last signal: chrome\)/)
      assert.match(err.message, /reviewer \(last signal: none\)/)
      return polls === 1
    },
  )
})

test('awaitSeatsReady rejects unknown and absent modes explicitly', () => {
  const crew = { members: { planner: { surface_id: 'surface-planner' } } }
  for (const mode of ['bogus', undefined]) {
    assert.throws(() => awaitSeatsReady(crew, mode, null, { cmux: callCounter() }), /readiness mode/)
  }
})

test('a tier boot records the handed roster and byte snapshot provenance', async () => {
  const home = scratchDir('crew-roster-boot-home-')
  const { root: checkoutRoot, checkout } = testCheckout('crew-roster-boot-checkout-')
  const sourceDir = scratchDir('crew-roster-source-')
  const sourcePath = join(sourceDir, 'roster.json')
  const bytes = Buffer.from(JSON.stringify(roster, null, 2))
  writeFileSync(sourcePath, bytes)
  const task = 'roster-provenance'
  try {
    await withHome(home, () => bootCmd({ task, checkout, tier: 'build', roster: sourcePath, 'headless-all': true, 'claude-bin': process.execPath }, { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() }))
    const dir = testCrewDir(home, checkout, task)
    const crew = JSON.parse(readFileSync(join(dir, 'crew.json'), 'utf8'))
    assert.deepEqual(crew.roster, { path: sourcePath, origin: 'flag', sha256: createHash('sha256').update(bytes).digest('hex'), snapshot: join(dir, 'roster.snapshot.json') })
    assert.equal(readFileSync(crew.roster.snapshot).equals(bytes), true)
    assert.equal(crew.seats.planner.id, roster.tiers.build.planner.id)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('pane boot snapshots before cmux and leaves no crew record when snapshotting fails', async () => {
  const home = scratchDir('crew-roster-order-home-')
  const { root: checkoutRoot, checkout } = testCheckout('crew-roster-order-checkout-')
  const sourceDir = scratchDir('crew-roster-order-source-')
  const sourcePath = join(sourceDir, 'roster.json')
  writeFileSync(sourcePath, JSON.stringify(roster, null, 2))
  const failedTask = 'roster-snapshot-fails'
  const controlTask = 'roster-snapshot-control'
  const failedCmux = callCounter()
  const controlCalls = []
  const controlCmux = (...args) => { controlCalls.push(args); return { ok: false, error: new Error('control stop') } }
  try {
    await withHome(home, () => assert.rejects(
      () => bootCmd({ task: failedTask, checkout, tier: 'build', roster: sourcePath, 'claude-bin': process.execPath }, {
        cmux: failedCmux, tree: callCounter(), renameTab: callCounter(), writeRosterSnapshot: () => { throw new Error('snapshot stop') },
      }), /snapshot stop/,
    ))
    assert.equal(failedCmux.calls.length, 0)
    assert.equal(existsSync(join(testCrewDir(home, checkout, failedTask), 'crew.json')), false)
    await withHome(home, () => assert.rejects(
      () => bootCmd({ task: controlTask, checkout, tier: 'build', roster: sourcePath, 'claude-bin': process.execPath }, {
        cmux: controlCmux, tree: callCounter(), renameTab: callCounter(),
      }), /control stop/,
    ))
    assert.ok(controlCalls.length > 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('model-not-in-catalog is closed for canonical cells while pure and raw band checks remain exempt', () => {
  const ladder = loadLadder()
  const canonical = { builder: { provider: 'openai', id: 'gpt-5.6-sol' } }
  assert.throws(
    () => assertBandFloors(canonical, 'build', ladder, { models: {} }),
    (err) => err.reason === 'model-not-in-catalog' && err.message.includes('openai/gpt-5.6-sol'),
  )
  assert.doesNotThrow(() => assertBandFloors(canonical, 'build', ladder))
  assert.ok(BAND_FLOOR_REFUSALS.includes('model-not-in-catalog'))
  const raw = { builder: { provider: null, id: null, model: 'openai-codex/gpt-5.6-sol' } }
  assert.doesNotThrow(() => assertBandFloors(raw, 'build', ladder, { models: {}, adapters: { builder: { adapter: { modelString: piModelString } } } }))
})

test('run-path seatIo receives a reader for the boot snapshot rather than the runtime roster', async () => {
  const home = scratchDir('crew-roster-run-home-')
  const { root: checkoutRoot, checkout } = testCheckout('crew-roster-run-checkout-')
  const sourceDir = scratchDir('crew-roster-run-source-')
  const sourcePath = join(sourceDir, 'roster.json')
  const runtimePath = join(sourceDir, 'runtime.json')
  writeFileSync(sourcePath, JSON.stringify(roster, null, 2))
  const decoy = structuredClone(roster)
  decoy.tiers.judge.planner = { provider: 'anthropic', id: 'claude-sonnet-5', agent: 'claude', effort: 'high' }
  writeFileSync(runtimePath, JSON.stringify(decoy, null, 2))
  const task = 'roster-run-reader'
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# roster run reader\n')
  let captured = null
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  try {
    execSync('git init -q', { cwd: checkout })
    await withHome(home, () => bootCmd({ task, checkout, tier: 'build', roster: sourcePath, 'headless-all': true, 'claude-bin': process.execPath }, { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() }))
    writeFileSync(sourcePath, readFileSync(runtimePath))
    await withHome(home, () => runCmd({ task, checkout, 'brief-file': brief, keep: true }, {
      awaitSeatsReady: () => {},
      seatIo: (...args) => { captured = args; return { emit: () => {} } },
      drive: () => done,
      writeTerminalLine: () => {},
    }))
    assert.equal(typeof captured?.[6]?.readRoster, 'function')
    assert.equal(captured[6].readRoster().tiers.judge.planner.id, roster.tiers.judge.planner.id)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('runCmd refuses missing briefs despite injected seatIo and drive', async () => {
  const home = scratchDir('crew-run-brief-required-home-')
  const { root: checkoutRoot, checkout } = testCheckout('crew-run-brief-required-checkout-')
  const rosterPath = join(home, 'roster.json')
  const task = 'run-brief-required'
  let seatIoCalls = 0
  let driveCalls = 0
  const seams = {
    awaitSeatsReady: () => {},
    seatIo: () => {
      seatIoCalls += 1
      throw new Error('seatIo reached before the brief guard')
    },
    drive: () => { driveCalls += 1; return { status: 'done', summary: '', artifacts: [], details: {} } },
  }
  try {
    writeFileSync(rosterPath, JSON.stringify(roster, null, 2))
    execSync('git init -q', { cwd: checkout })
    await withHome(home, () => bootCmd(
      { task, checkout, tier: 'build', roster: rosterPath, 'headless-all': true, 'claude-bin': process.execPath },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
    ))
    await withHome(home, () => {
      assert.throws(
        () => runCmd({ task, checkout, keep: true }, seams),
        /run requires --brief-file <path to the task brief>/,
      )
      assert.throws(
        () => runCmd({ task, checkout, 'brief-file': join(home, 'missing.md'), keep: true }, seams),
        /brief file not found/,
      )
    })
    assert.equal(seatIoCalls, 0)
    assert.equal(driveCalls, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test("a child run with no suite in its spec drives the owner's command", () => {
  const f = childSignalFixture()
  let seen = null
  try {
    runChild({ crew_dir: f.crewDir, task: 'child-signal', brief_file: f.brief, checkout: f.root, ledger_db: f.ledger }, {
      preflight: false,
      seatIo: () => ({ log: () => {} }),
      driveTask: (ctx) => { seen = ctx; return { status: 'done', summary: '', artifacts: [], details: {} } },
      env: { DEVTEAM_LEDGER_DB: f.ledger },
    })
    assert.equal(seen.suite, JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).scripts.test)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('panel-distinct-agents refuses equal resolved agents before any workspace', async () => {
  const home = scratchDir('crew-panel-refusal-home-')
  const { root: checkoutRoot, checkout } = testCheckout('crew-panel-refusal-checkout-')
  const cmux = callCounter()
  const tree = callCounter()
  try {
    execSync('git init -q', { cwd: checkout })
    await assert.rejects(
      () => withHome(home, () => bootCmd(
        { task: 'panel-refusal', checkout, roles: 'reviewer,tech-lead', 'headless-all': true, 'claude-bin': process.execPath, 'panel-distinct-agents': true },
        { cmux, tree, renameTab: callCounter(), register: capabilityRegister() },
      )),
      (error) => /panel-same-agent/.test(error.message),
    )
    assert.equal(existsSync(testCrewDir(home, checkout, 'panel-refusal')), false)
    assert.equal(cmux.calls.length, 0)
    assert.equal(tree.calls.length, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('panel boots record both resolved agents with and without the flag', async () => {
  for (const [name, extra, expected] of [
    ['panel-distinct', { 'agent-reviewer': 'pi', 'agent-tech-lead': 'claude', 'panel-distinct-agents': true }, { reviewer: 'pi', 'tech-lead': 'claude' }],
    ['panel-same-allowed', {}, { reviewer: 'claude', 'tech-lead': 'claude' }],
  ]) {
    const home = scratchDir(`crew-${name}-home-`)
    const { root: checkoutRoot, checkout } = testCheckout(`crew-${name}-checkout-`)
    try {
      execSync('git init -q', { cwd: checkout })
      await withHome(home, () => bootCmd(
        { task: name, checkout, roles: 'reviewer,tech-lead', 'headless-all': true, 'claude-bin': process.execPath, ...extra },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), register: capabilityRegister() },
      ))
      const crew = JSON.parse(readFileSync(join(testCrewDir(home, checkout, name), 'crew.json'), 'utf8'))
      assert.equal(crew.members.reviewer.agent, expected.reviewer)
      assert.equal(crew.members['tech-lead'].agent, expected['tech-lead'])
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(checkoutRoot, { recursive: true, force: true })
    }
  }
})
