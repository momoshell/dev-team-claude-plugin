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
  CI_CHECKS, LOCAL_LANE, ciWatchRun, classifyRed, decisionFor, extractFailure,
  fetchCheckLog, fetchCheckRuns, isWorkerPath, pushBranch, runLocalLane,
} from '../scripts/factory/ci-watch.mjs'
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

const fixture = mkdtempSync(join(tmpdir(), 'factory-ci-watch-'))
let worldNumber = 0
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

function seam(world, extra = {}) {
  const calls = []
  const spawnSync = (command, args, options) => {
    calls.push([command, ...args])
    if (command === 'git' && args[0] === '-C' && args.includes('push')) {
      return { status: 0, stdout: '', stderr: '' }
    }
    if (command === 'node' && extra.local) return extra.local
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
    const { calls, deps } = seam(world, {
      local: { status: 1, stdout: 'not ok 1 - first failure\n', stderr: '' },
      deps: { checks: ({ action }) => action === 'runs'
        ? [{ check_name: CI_CHECKS[0], conclusion: 'failure', log_ref: 'log-1' }]
        : failureLog },
    })
    const result = ciWatchRun({
      checkout: world.host, branch: 'main', crewRoot: join(world.root, 'crew'),
      deps, dbPath: join(world.root, 'ledger.db'),
    })
    assert.equal(result.ok, true)
    assert.ok(calls.length > 0)
    assert.ok(calls.every((argv) => argv[0] === 'git' || argv[0] === 'node'))
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
  assert.deepEqual(specifiers.filter((specifier) => !specifier.startsWith('node:')), ['./ledger.mjs', './emit.mjs'])
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
  const rows = fetchCheckRuns({ branch: 'main', headSha: 'head', deps: { checks: () => [] } })
  assert.deepEqual(rows, [{ check_name: CI_CHECKS[0], conclusion: 'unknown', log_ref: null }])
})

test('runLocalLane reports a spawn failure without throwing', () => {
  const result = runLocalLane({ checkout: '/missing', deps: { spawnSync: () => { throw new Error('no node') } } })
  assert.deepEqual(result, { ran: false, exit: null, failures: [], lane: [...LOCAL_LANE] })
})

test('CI_CHECKS matches the workflow job check name', () => {
  const workflow = readFileSync(join(ROOT, '.github/workflows/test.yml'), 'utf8')
  const job = workflow.match(/jobs:\s*\n\s+test:\s*\n\s+name:\s*([^\n]+)/)
  assert.ok(job)
  assert.deepEqual(CI_CHECKS, [job[1].trim().replace(/^['"]|['"]$/g, '')])
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
    const { deps } = seam(world, {
      local: { status: 1, stdout: 'not ok 1 - first failure\n', stderr: '' },
      deps: { checks: ({ action }) => action === 'runs'
        ? [{ check_name: CI_CHECKS[0], conclusion: 'failure', log_ref: 'log-1' }]
        : failureLog, now: () => '2024-01-01T00:00:00.000Z' },
    })
    const dbPath = join(world.root, 'ledger.db')
    const result = ciWatchRun({ checkout: world.host, branch: 'main', crewRoot: join(world.root, 'crew'), dbPath, deps })
    assert.equal(result.cycles.length, 1)
    assert.equal(result.cycles[0].classification, 'reproduced')
    assert.equal(result.cycles[0].decision, 'repair')
    const ledger = openLedger({ dbPath, stderr: { write() {} } })
    const rows = ledger.dumpTable('ci_cycles')
    assert.equal(rows.length, 1)
    assert.deepEqual({ classification: rows[0].classification, decision: rows[0].decision, cycle: rows[0].cycle, check_name: rows[0].check_name }, {
      classification: 'reproduced', decision: 'repair', cycle: 1, check_name: CI_CHECKS[0],
    })
    assert.equal(rows[0].excerpt, failureLog.slice(failureLog.indexOf('not ok 1')))
    ledger.close()
  })
})

test('seeded platform-divergent red parks on cycle one', { skip: SKIP }, () => {
  withWorld((world) => {
    const { deps } = seam(world, {
      local: { status: 0, stdout: '', stderr: '' },
      deps: { checks: ({ action }) => action === 'runs'
        ? [{ check_name: CI_CHECKS[0], conclusion: 'failure', log_ref: 'log-1' }]
        : failureLog },
    })
    const dbPath = join(world.root, 'platform.db')
    const result = ciWatchRun({ checkout: world.host, branch: 'main', crewRoot: join(world.root, 'crew'), dbPath, deps })
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
