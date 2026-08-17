// test/factory-ci-watch.test.mjs — host-side CI watch and adjudication.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync as cpSpawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { ROOT } from './helpers.mjs'
import {
  PROFILE_REFUSALS, ciShape, ciWatchRun, classifyRed, decisionFor,
  extractFailure, fetchCheckLog, fetchCheckRuns, isWorkerPath, pushBranch,
  runLocalLane,
} from '../scripts/factory/ci-watch.mjs'
import { probeRepo } from '../scripts/factory/probe-repo.mjs'
import { recordCiCycle as emitRecordCiCycle } from '../scripts/factory/emit.mjs'
import { openLedger, NODE_FLOOR } from '../scripts/factory/ledger.mjs'

const require = createRequire(import.meta.url)
function sqliteAvailable() {
  try {
    require('node:sqlite')
    return true
  } catch {
    return false
  }
}
const SQLITE_OK = sqliteAvailable()
const SKIP = SQLITE_OK ? false : `node:sqlite unavailable (below NODE_FLOOR ${NODE_FLOOR})`
const FIXTURE_CHECK = 'test (node 24)'
const FIXTURE_LANE = Object.freeze(['node', '--test', '--test-timeout=30000'])

const fixture = mkdtempSync(join(tmpdir(), 'factory-ci-watch-'))
let worldNumber = 0
let profileNumber = 0
after(() => rmSync(fixture, { recursive: true, force: true }))

function git(repoDir, ...args) {
  return cpSpawnSync('git', [
    '-c', 'user.email=crew@example.invalid',
    '-c', 'user.name=Crew Test',
    '-c', 'protocol.file.allow=always',
    '-C', repoDir, ...args,
  ], { encoding: 'utf8' })
}

function makeWorld() {
  worldNumber += 1
  const root = join(fixture, `world-${worldNumber}`)
  mkdirSync(root)
  const host = join(root, 'host')
  mkdirSync(host)
  assert.equal(git(host, 'init', '-q', '-b', 'main').status, 0)
  writeFileSync(join(host, 'seed.txt'), 'seed\n')
  assert.equal(git(host, 'add', 'seed.txt').status, 0)
  assert.equal(git(host, 'commit', '-q', '-m', 'base').status, 0)
  const run = join(root, 'run')
  assert.equal(git(host, 'worktree', 'add', '-q', run, '-b', 'run-branch').status, 0)
  return { root, host, run }
}

function withWorld(fn) {
  const world = makeWorld()
  try { return fn(world) } finally { rmSync(world.root, { recursive: true, force: true }) }
}

function ratifiedCell(value) {
  return {
    status: 'ratified',
    value,
    source: 'test fixture',
    ratified_by: 'test',
    ratified_at: '2026-08-17T00:00:00.000Z',
  }
}

function ciValue(checks, triggers = ['push', 'pull_request']) {
  return {
    workflows: [{
      file: '.github/workflows/test.yml',
      name: 'test',
      triggers,
      jobs: checks.map((name) => ({
        id: name, name, check_name: name, runs_on: 'ubuntu-latest', steps_run: [],
      })),
    }],
  }
}

function profileFixture({ checks = [FIXTURE_CHECK], lane = 'npm test', triggers, fields } = {}) {
  profileNumber += 1
  const path = join(fixture, `profile-${profileNumber}.json`)
  writeFileSync(path, `${JSON.stringify({
    schema: 1,
    profile_version: 1,
    repo_key: 'test__fixture',
    repo_slug: 'fixture',
    fields: fields || {
      ci: ratifiedCell(ciValue(checks, triggers)),
      test_command: ratifiedCell(lane),
    },
    meta: { probed_at: '2026-08-17T00:00:00.000Z' },
  }, null, 2)}\n`)
  return path
}

function seam(world, extra = {}) {
  const calls = []
  const spawnSync = (command, args, options) => {
    calls.push([command, ...args])
    if (command === 'git' && args[0] === '-C' && args.includes('push')) {
      return { status: 0, stdout: '', stderr: '' }
    }
    if (extra.local && (extra.localCommand
      ? command === extra.localCommand
      : command === 'node' || command === '/bin/sh')) return extra.local
    return cpSpawnSync(command, args, options)
  }
  return { calls, deps: { spawnSync, ...extra.deps } }
}

const failureLog = [
  'TAP version 13',
  'not ok 1 - first failure',
  '  ---',
  '  duration_ms: 1',
  '  error: first',
  '  ...',
  'not ok 2 - second failure',
  '  ---',
  '  duration_ms: 2',
  '  error: second',
  '  ...',
].join('\n')

// AC-1: a linked worktree is refused before a push argv exists.
test('worker linked worktree refuses push without constructing push argv', () => {
  withWorld((world) => {
    const calls = []
    const spawnSync = (command, args, options) => {
      calls.push([command, ...args])
      if (command === 'git' && args.includes('push')) return { status: 0, stdout: '', stderr: '' }
      return cpSpawnSync(command, args, options)
    }
    const result = pushBranch({ checkout: world.run, branch: 'run-branch', crewRoot: join(world.root, 'crew'), deps: { spawnSync } })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'worker-path')
    assert.equal(calls.some((argv) => argv.includes('push')), false)
  })
})

test('a primary checkout under the crew root is also a worker path', () => {
  withWorld((world) => {
    const calls = []
    const spawnSync = (command, args, options) => {
      calls.push([command, ...args])
      return cpSpawnSync(command, args, options)
    }
    const result = pushBranch({ checkout: world.host, branch: 'main', crewRoot: world.root, deps: { spawnSync } })
    assert.deepEqual({ ok: result.ok, reason: result.reason }, { ok: false, reason: 'worker-path' })
    assert.equal(calls.some((argv) => argv.includes('push')), false)
  })
})

test('a primary checkout outside the crew root reaches the push seam', () => {
  withWorld((world) => {
    const { calls, deps } = seam(world)
    const result = pushBranch({ checkout: world.host, branch: 'main', crewRoot: join(world.root, 'crew'), deps })
    assert.equal(result.ok, true)
    assert.ok(calls.some((argv) => argv[0] === 'git' && argv.includes('push')))
  })
})

test('every subprocess in a watch uses the injected seam', () => {
  withWorld((world) => {
    const profilePath = profileFixture()
    const { calls, deps } = seam(world, {
      local: { status: 1, stdout: 'not ok 1 - first failure\n', stderr: '' },
      deps: { checks: ({ action }) => action === 'runs'
        ? [{ check_name: FIXTURE_CHECK, conclusion: 'failure', log_ref: 'log-1' }]
        : failureLog },
    })
    const result = ciWatchRun({
      checkout: world.host, branch: 'main', crewRoot: join(world.root, 'crew'),
      profilePath, deps, dbPath: join(world.root, 'ledger.db'),
    })
    assert.equal(result.ok, true)
    assert.ok(calls.length > 0)
    const shape = ciShape({ checkout: world.host, profilePath })
    assert.equal(shape.ok, true)
    assert.ok(calls.every((argv) => argv[0] === 'git' || argv[0] === shape.lane[0]))
  })
})

test('ci-watch import firewall has only the three allowed static import surfaces', () => {
  const source = readFileSync(join(ROOT, 'scripts/factory/ci-watch.mjs'), 'utf8')
  const uncommented = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
  const forbidden = ['drive', 'mjs'].join('.')
  assert.equal(uncommented.includes(forbidden), false)
  assert.equal((uncommented.match(/\bimport\s*\(/g) || []).length, 0)
  assert.equal((uncommented.match(/export\s+\*\s+from/g) || []).length, 0)
  const specifiers = [...uncommented.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1])
  assert.deepEqual(specifiers.filter((specifier) => !specifier.startsWith('node:')), ['./ledger.mjs', './emit.mjs', './probe-repo.mjs'])
})

test('decisionFor is total over the closed classifications and never collapses unknown into repair', () => {
  assert.equal(decisionFor('green'), 'none')
  assert.equal(decisionFor('reproduced'), 'repair')
  assert.equal(decisionFor('platform-divergent'), 'park')
  assert.equal(decisionFor('unknown'), 'park')
  assert.notEqual(decisionFor('unknown'), 'repair')
  assert.throws(() => decisionFor('not-a-classification'))
})

test('classifyRed truth table: green conclusion', () => {
  assert.deepEqual(classifyRed({ conclusion: 'success', ciFailures: [], local: {} }), { classification: 'green', reason: null })
})
test('classifyRed truth table: non-failure conclusion', () => {
  assert.deepEqual(classifyRed({ conclusion: 'cancelled', ciFailures: ['x'], local: { ran: true, exit: 1, failures: ['x'] } }), { classification: 'unknown', reason: 'conclusion-not-adjudicable' })
})
test('classifyRed truth table: no CI failures', () => {
  assert.deepEqual(classifyRed({ conclusion: 'failure', ciFailures: [], local: { ran: true, exit: 1, failures: [] } }), { classification: 'unknown', reason: 'ci-failures-unparseable' })
})
test('classifyRed truth table: local lane unrunnable', () => {
  assert.deepEqual(classifyRed({ conclusion: 'failure', ciFailures: ['x'], local: { ran: false, exit: null, failures: [] } }), { classification: 'unknown', reason: 'local-lane-unrunnable' })
})
test('classifyRed truth table: local lane green', () => {
  assert.deepEqual(classifyRed({ conclusion: 'failure', ciFailures: ['x'], local: { ran: true, exit: 0, failures: [] } }), { classification: 'platform-divergent', reason: 'local-lane-green' })
})
test('classifyRed truth table: reproduced and disjoint local failures', () => {
  assert.deepEqual(classifyRed({ conclusion: 'failure', ciFailures: ['x'], local: { ran: true, exit: 1, failures: ['x', 'y'] } }), { classification: 'reproduced', reason: 'local-lane-reproduced' })
  assert.deepEqual(classifyRed({ conclusion: 'failure', ciFailures: ['x'], local: { ran: true, exit: 1, failures: ['y'] } }), { classification: 'unknown', reason: 'local-failures-disjoint' })
})

test('extractFailure preserves every TAP failure block verbatim', () => {
  const result = extractFailure(failureLog)
  assert.equal(result.source, 'check-log')
  assert.deepEqual(result.failures, ['first failure', 'second failure'])
  assert.ok(result.excerpt.includes(failureLog.slice(failureLog.indexOf('not ok 1'), failureLog.indexOf('not ok 2'))))
  assert.ok(result.excerpt.includes(failureLog.slice(failureLog.indexOf('not ok 2'))))
})

test('an unparseable log uses the named tail window and parks', () => {
  const result = extractFailure('TAP version 13\nok 1 - fine\n')
  assert.equal(result.source, 'check-log-tail-200')
  assert.deepEqual(result.failures, [])
  assert.deepEqual(classifyRed({ conclusion: 'failure', ciFailures: result.failures, local: { ran: true, exit: 1, failures: [] } }), { classification: 'unknown', reason: 'ci-failures-unparseable' })
  assert.equal(decisionFor('unknown'), 'park')
})

test('fetchCheckRuns carries a missing watched check as unknown', () => {
  const rows = fetchCheckRuns({ branch: 'main', headSha: 'head', checks: [FIXTURE_CHECK], deps: { checks: () => [] } })
  assert.deepEqual(rows, [{ check_name: FIXTURE_CHECK, conclusion: 'unknown', log_ref: null }])
})

test('runLocalLane reports a spawn failure without throwing', () => {
  const result = runLocalLane({ checkout: '/missing', lane: FIXTURE_LANE, deps: { spawnSync: () => { throw new Error('no node') } } })
  assert.deepEqual(result, { ran: false, exit: null, failures: [], lane: [...FIXTURE_LANE] })
})

test("ciShape reads the watched check names from this repo's ratified ci cell", () => {
  const probed = probeRepo({ checkout: ROOT })
  const profilePath = profileFixture({
    fields: {
      ci: ratifiedCell(probed.fields.ci.value),
      test_command: ratifiedCell('npm test'),
    },
  })
  const shape = ciShape({ checkout: ROOT, profilePath })
  assert.equal(shape.ok, true)
  assert.deepEqual(shape.checks, ['test (node 24)'])
})

test('ciShape flattens every job across workflows and dedupes by check name', () => {
  const profilePath = profileFixture({
    fields: {
      ci: ratifiedCell({
        workflows: [
          { triggers: ['push'], jobs: [{ check_name: 'lint' }, { check_name: 'build' }] },
          { triggers: ['pull_request'], jobs: [{ check_name: 'build' }, { check_name: 'test' }] },
        ],
      }),
      test_command: ratifiedCell('npm test'),
    },
  })
  const shape = ciShape({ checkout: ROOT, profilePath })
  assert.equal(shape.ok, true)
  assert.deepEqual(shape.checks, ['lint', 'build', 'test'])
})

test('ciShape skips a workflow no branch push triggers and keeps an untriggered-unparsed one', () => {
  const profilePath = profileFixture({
    fields: {
      ci: ratifiedCell({
        workflows: [
          { triggers: ['schedule'], jobs: [{ check_name: 'scheduled-only' }] },
          { triggers: [], jobs: [{ check_name: 'unparsed-trigger' }] },
          { triggers: ['pull_request'], jobs: [{ check_name: 'pull-request' }] },
        ],
      }),
      test_command: ratifiedCell('npm test'),
    },
  })
  const shape = ciShape({ checkout: ROOT, profilePath })
  assert.equal(shape.ok, true)
  assert.deepEqual(shape.checks, ['unparsed-trigger', 'pull-request'])
})

test('ciShape refuses a proposed ci cell', () => {
  const profilePath = profileFixture({
    fields: {
      ci: { status: 'proposed', value: ciValue(['unratified']), source: 'test fixture' },
      test_command: ratifiedCell('npm test'),
    },
  })
  const shape = ciShape({ checkout: ROOT, profilePath })
  assert.equal(shape.ok, false)
  assert.equal(shape.reason, 'profile-unratified')
  assert.equal(shape.field, 'ci')
})

test('ciShape refuses an unknown ci cell', () => {
  const profilePath = profileFixture({
    fields: {
      ci: { status: 'unknown', value: null, reason: 'no_ci' },
      test_command: ratifiedCell('npm test'),
    },
  })
  const shape = ciShape({ checkout: ROOT, profilePath })
  assert.equal(shape.ok, false)
  assert.equal(shape.reason, 'profile-field-unknown')
  assert.equal(shape.detail, 'no_ci')
})

test('ciShape refuses a profile that declares no CI checks', () => {
  const profilePath = profileFixture({
    fields: {
      ci: ratifiedCell(ciValue([])),
      test_command: ratifiedCell('npm test'),
    },
  })
  const shape = ciShape({ checkout: ROOT, profilePath })
  assert.equal(shape.ok, false)
  assert.equal(shape.reason, 'ci-no-checks')
})

test('ciShape names an absent profile and an unreadable profile with distinct reasons', () => {
  const absentPath = join(fixture, 'profile-absent.json')
  const unreadablePath = join(fixture, 'profile-unreadable.json')
  writeFileSync(unreadablePath, '{ not json\n')
  const absent = ciShape({ checkout: ROOT, profilePath: absentPath })
  const unreadable = ciShape({ checkout: ROOT, profilePath: unreadablePath })
  assert.equal(absent.reason, 'profile-missing')
  assert.equal(unreadable.reason, 'profile-unreadable')
  assert.notEqual(absent.reason, unreadable.reason)
})

test('ciShape takes the local lane from the ratified test_command and refuses a proposed one', () => {
  const profilePath = profileFixture({ checks: ['foreign'], lane: 'make check' })
  const shape = ciShape({ checkout: ROOT, profilePath })
  assert.equal(shape.ok, true)
  assert.deepEqual(shape.lane, ['/bin/sh', '-c', 'make check'])
  assert.equal(shape.laneLabel, 'make check')
  const proposedPath = profileFixture({
    fields: {
      ci: ratifiedCell(ciValue(['foreign'])),
      test_command: { status: 'proposed', value: 'make check', source: 'test fixture' },
    },
  })
  const proposed = ciShape({ checkout: ROOT, profilePath: proposedPath })
  assert.equal(proposed.ok, false)
  assert.equal(proposed.reason, 'profile-unratified')
  assert.equal(proposed.field, 'test_command')
})

test("a watch against a foreign profile watches that repo's checks and runs that repo's lane", { skip: SKIP }, () => {
  withWorld((world) => {
    const checks = ['foreign/lint', 'foreign/test']
    const profilePath = profileFixture({ checks, lane: 'foreign suite' })
    const { calls, deps } = seam(world, {
      local: { status: 1, stdout: 'not ok 1 - first failure\n', stderr: '' },
      localCommand: '/bin/sh',
      deps: { checks: ({ action }) => action === 'runs'
        ? checks.map((check_name) => ({ check_name, conclusion: 'failure', log_ref: 'log-1' }))
        : failureLog },
    })
    const result = ciWatchRun({
      checkout: world.host, branch: 'main', crewRoot: join(world.root, 'crew'),
      profilePath, dbPath: join(world.root, 'foreign.db'), deps,
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.cycles.map((row) => row.check_name), checks)
    assert.deepEqual([...new Set(result.cycles.map((row) => row.local_lane))], ['foreign suite'])
    assert.equal(calls.some((argv) => argv.includes('--test-timeout=30000')), false)
  })
})

test('ciWatchRun accepts a pre-resolved shape and never re-reads the profile', { skip: SKIP }, () => {
  withWorld((world) => {
    const profilePath = join(world.root, 'profile-that-does-not-exist.json')
    const shape = {
      ok: true,
      checks: ['pre-resolved/check'],
      lane: ['/bin/sh', '-c', 'foreign suite'],
      laneLabel: 'foreign suite',
      profilePath,
    }
    const { deps } = seam(world, {
      local: { status: 1, stdout: 'not ok 1 - first failure\n', stderr: '' },
      deps: { checks: ({ action }) => action === 'runs'
        ? [{ check_name: 'pre-resolved/check', conclusion: 'failure', log_ref: 'log-1' }]
        : failureLog },
    })
    const result = ciWatchRun({
      checkout: world.host, branch: 'main', crewRoot: join(world.root, 'crew'),
      profilePath, shape, dbPath: join(world.root, 'pre-resolved.db'), deps,
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.cycles.map((row) => row.check_name), ['pre-resolved/check'])
    assert.equal(result.cycles[0].local_lane, 'foreign suite')
    assert.equal(result.profilePath, profilePath)
  })
})

test('a watch refuses with a named reason when the profile is absent, and records no cycle', () => {
  withWorld((world) => {
    const profilePath = join(world.root, 'missing-profile.json')
    const { deps } = seam(world)
    const result = ciWatchRun({
      checkout: world.host, branch: 'main', crewRoot: join(world.root, 'crew'),
      profilePath, dbPath: join(world.root, 'missing.db'), deps,
    })
    assert.equal(result.ok, false)
    assert.equal(result.pushed, true)
    assert.equal(result.reason, 'profile-missing')
    assert.deepEqual(result.cycles, [])
    assert.equal(Object.isFrozen(PROFILE_REFUSALS), true)
    assert.ok(PROFILE_REFUSALS.includes(result.reason))
  })
})

test('the emit facade never throws when the ledger refuses its input', () => {
  const errors = []
  const result = emitRecordCiCycle({
    dbPath: join(fixture, 'refused.db'), stderr: { write: (line) => errors.push(line) },
    _openLedger: () => ({
      recordCiCycle() { throw new Error('refused') },
      close() {},
    }),
  })
  assert.equal(result, false)
  assert.equal(errors.length, 1)
})

test('seeded red watch records one reproduced cycle with its complete excerpt', { skip: SKIP }, () => {
  withWorld((world) => {
    const profilePath = profileFixture()
    const { deps } = seam(world, {
      local: { status: 1, stdout: 'not ok 1 - first failure\n', stderr: '' },
      deps: { checks: ({ action }) => action === 'runs'
        ? [{ check_name: FIXTURE_CHECK, conclusion: 'failure', log_ref: 'log-1' }]
        : failureLog, now: () => '2024-01-01T00:00:00.000Z' },
    })
    const dbPath = join(world.root, 'ledger.db')
    const result = ciWatchRun({ checkout: world.host, branch: 'main', crewRoot: join(world.root, 'crew'), profilePath, dbPath, deps })
    assert.equal(result.cycles.length, 1)
    assert.equal(result.cycles[0].classification, 'reproduced')
    assert.equal(result.cycles[0].decision, 'repair')
    const ledger = openLedger({ dbPath, stderr: { write() {} } })
    const rows = ledger.dumpTable('ci_cycles')
    assert.equal(rows.length, 1)
    assert.deepEqual({ classification: rows[0].classification, decision: rows[0].decision, cycle: rows[0].cycle, check_name: rows[0].check_name }, {
      classification: 'reproduced', decision: 'repair', cycle: 1, check_name: FIXTURE_CHECK,
    })
    assert.equal(rows[0].excerpt, failureLog.slice(failureLog.indexOf('not ok 1')))
    ledger.close()
  })
})

test('seeded platform-divergent red parks on cycle one', { skip: SKIP }, () => {
  withWorld((world) => {
    const profilePath = profileFixture()
    const { deps } = seam(world, {
      local: { status: 0, stdout: '', stderr: '' },
      deps: { checks: ({ action }) => action === 'runs'
        ? [{ check_name: FIXTURE_CHECK, conclusion: 'failure', log_ref: 'log-1' }]
        : failureLog },
    })
    const dbPath = join(world.root, 'platform.db')
    const result = ciWatchRun({ checkout: world.host, branch: 'main', crewRoot: join(world.root, 'crew'), profilePath, dbPath, deps })
    assert.equal(result.cycles[0].classification, 'platform-divergent')
    assert.equal(result.cycles[0].decision, 'park')
    assert.equal(result.cycles[0].cycle, 1)
    assert.ok(result.cycles[0].reason)
    const ledger = openLedger({ dbPath, stderr: { write() {} } })
    assert.equal(ledger.dumpTable('ci_cycles').length, 1)
    ledger.close()
  })
})

// Keep the imported helper in the module's exercised surface; this also pins
// check-log retrieval to the checks seam rather than to a direct subprocess.
test('fetchCheckLog preserves the injected log bytes', () => {
  assert.equal(fetchCheckLog({ logRef: 'x', deps: { checks: ({ action }) => action === 'log' ? failureLog : [] } }), failureLog)
})
