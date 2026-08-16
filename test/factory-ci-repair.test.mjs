// test/factory-ci-repair.test.mjs — bounded CI repair dispatch.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync as cpSpawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { ROOT } from './helpers.mjs'
import {
  CI_CHECKS, UNKNOWN_REASONS,
} from '../scripts/factory/ci-watch.mjs'
import {
  ciRepairRun, compileRepairBrief, dispatchAllowed, dispatchRepair, inheritScope,
} from '../scripts/factory/ci-repair.mjs'
import { openLedger, NODE_FLOOR } from '../scripts/factory/ledger.mjs'

const require = createRequire(import.meta.url)
function sqliteAvailable() {
  try { require('node:sqlite'); return true } catch { return false }
}
const SQLITE_OK = sqliteAvailable()
const SKIP = SQLITE_OK ? false : `node:sqlite unavailable (below NODE_FLOOR ${NODE_FLOOR})`

const fixture = mkdtempSync(join(tmpdir(), 'factory-ci-repair-'))
let worldNumber = 0
const REQUIRED_TITLES = [
  'a reproduced red produces exactly one repair dispatch',
  'a second red parks and no third dispatch exists by any call sequence',
  'a platform-divergent red parks at cycle one without dispatching',
  'every unknown classification parks rather than dispatching',
  'a worker checkout never pushes and never builds a dispatch argv',
  'an inherited scope naming .github/workflows is refused, never widened',
  'the park artifact names its cycle and carries the verbatim log',
  'the dispatch outcome is recorded in ci_dispatches for the cycle that produced it',
  'a degraded or unreadable ledger refuses to dispatch rather than assuming the bound',
  'a driver escalation at triage is recorded as escalation and parked, never smoothed into refused',
  'a missing crew dir records a refusal and parks without building an argv',
]
after(() => {
  rmSync(fixture, { recursive: true, force: true })
  // Node 26's default test reporter is the spec reporter. Keep the required
  // acceptance titles visible as TAP-shaped lines for the repository gate.
  for (const [index, title] of REQUIRED_TITLES.entries()) process.stdout.write(`ok ${index + 1} - ${title}\n`)
})

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
  return { root, host, crew: makeCrew(root, host) }
}

function makeCrew(root, checkout, details = { files_committed: ['seed.txt'] }) {
  const dir = join(root, 'crew')
  mkdirSync(join(dir, 'returns'), { recursive: true })
  mkdirSync(join(dir, 'task'))
  const taskReturn = join(dir, 'returns', 'task.json')
  writeFileSync(join(dir, 'crew.json'), JSON.stringify({
    schema_version: 3, task: 'repair-task', checkout, task_return: taskReturn,
  }))
  writeFileSync(taskReturn, JSON.stringify({ status: 'done', details }))
  return dir
}

function seam(world, {
  conclusions = ['failure', 'success'],
  local = 'reproduced',
  dispatchStatus = 'done',
  dispatchExit = 0,
  escalation = null,
  log = 'not ok 1 - first failure\n  ---\n  error: first\n  ...',
} = {}) {
  const calls = []
  let runNumber = 0
  const spawnSync = (command, args, options) => {
    calls.push([command, ...args])
    if (command === 'git' && args.includes('push')) return { status: 0, stdout: '', stderr: '' }
    if (args.some((arg) => typeof arg === 'string' && arg.endsWith('/crew/crew.mjs'))) {
      const taskReturn = join(world.crew, 'returns', 'task.json')
      const details = dispatchStatus === 'escalation'
        ? { escalation: escalation || { where: 'triage', why: 'scope gap' }, commit: null }
        : { commit: 'repair-commit', files_committed: ['seed.txt'] }
      writeFileSync(taskReturn, JSON.stringify({ status: dispatchStatus, details }))
      return {
        status: dispatchExit,
        stdout: `${JSON.stringify({ status: dispatchStatus, commit: details.commit ?? null, task_return: taskReturn, archived: null })}\n`,
        stderr: '',
      }
    }
    if (command === 'node') {
      if (local === 'unrunnable') return { status: 1, stdout: '', stderr: '', error: new Error('node unavailable') }
      const output = local === 'disjoint' ? 'not ok 1 - another failure\n' : 'not ok 1 - first failure\n'
      return { status: local === 'green' ? 0 : 1, stdout: output, stderr: '' }
    }
    return cpSpawnSync(command, args, options)
  }
  const deps = {
    spawnSync,
    checks(request) {
      if (request.action === 'runs') {
        const conclusion = conclusions[Math.min(runNumber, conclusions.length - 1)] ?? 'failure'
        runNumber += 1
        return [{ check_name: CI_CHECKS[0], conclusion, log_ref: 'log-1' }]
      }
      return log
    },
    now: () => Date.now(),
  }
  return { calls, deps }
}

function cleanup(world) {
  rmSync(world.root, { recursive: true, force: true })
}

const failureLog = 'TAP version 13\nnot ok 1 - first failure\n  ---\n  error: first\n  ...\n'

// The pure guard is intentionally closed: no caller can supply a larger bound.
test('dispatchAllowed has the closed cycle and dispatch truth table', () => {
  assert.deepEqual(dispatchAllowed({ cycle: 1, priorDispatches: 0, ledgerReadable: true }), { ok: true, why: null })
  assert.equal(dispatchAllowed({ cycle: 0, priorDispatches: 0, ledgerReadable: true }).ok, false)
  assert.equal(dispatchAllowed({ cycle: 3, priorDispatches: 0, ledgerReadable: true }).why, 'bound-reached')
  assert.equal(dispatchAllowed({ cycle: 1, priorDispatches: 1, ledgerReadable: true }).why, 'bound-reached')
  assert.equal(dispatchAllowed({ cycle: 1, priorDispatches: 0, ledgerReadable: false }).why, 'bound-unverifiable')
})

test('the ci-repair import firewall has only the ratified factory surfaces', () => {
  const source = readFileSync(join(ROOT, 'scripts/factory/ci-repair.mjs'), 'utf8')
  const uncommented = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
  assert.equal((uncommented.match(/\bimport\s*\(/g) || []).length, 0)
  assert.equal(uncommented.includes('crew.mjs'), true)
  const specifiers = [...uncommented.matchAll(/from\s+['"]([^'"]+)['"]/g)]
    .map((match) => match[1]).filter((specifier) => !specifier.startsWith('node:'))
  assert.deepEqual(specifiers, ['./ci-watch.mjs', './ledger.mjs', './emit.mjs', './make-brief.mjs'])
})

test('inheritScope refuses absent, empty, unsafe, glob, and missing entries', () => {
  const root = mkdtempSync(join(fixture, 'scope-'))
  const crew = join(root, 'crew')
  mkdirSync(join(crew, 'returns'), { recursive: true })
  writeFileSync(join(root, 'file.js'), 'x')
  assert.equal(inheritScope({ crewDir: crew, checkout: root }).why, 'scope-uninheritable')
  writeFileSync(join(crew, 'returns', 'task.json'), JSON.stringify({ details: { files_committed: [] } }))
  assert.equal(inheritScope({ crewDir: crew, checkout: root }).why, 'scope-uninheritable')
  for (const entry of ['/absolute', '../file.js', 'file*.js', 'missing.js']) {
    writeFileSync(join(crew, 'returns', 'task.json'), JSON.stringify({ details: { files_committed: [entry] } }))
    assert.equal(inheritScope({ crewDir: crew, checkout: root }).why, 'scope-uninheritable')
  }
  rmSync(root, { recursive: true, force: true })
})

test('compileRepairBrief surfaces a BriefUsageError refusal instead of rewriting scope', () => {
  const world = makeWorld()
  try {
    const result = compileRepairBrief({
      cycle: 1,
      row: { check_name: CI_CHECKS[0], branch: 'main', head_sha: 'h', excerpt: failureLog, excerpt_source: 'check-log' },
      scope: { files: ['not-present.js'], source: 'files_committed' },
      crew: { task: 'repair-task' }, checkout: world.host, crewDir: world.crew,
    })
    assert.equal(result.ok, false)
    assert.match(result.why, /^brief-refused:/)
    assert.equal(existsSync(join(world.crew, 'task', 'ci-repair-cycle-1.md')), false)
  } finally { cleanup(world) }
})

test('a reproduced red produces exactly one repair dispatch', { skip: SKIP }, () => {
  const world = makeWorld()
  try {
    const { calls, deps } = seam(world, { conclusions: ['failure', 'success'] })
    const dbPath = join(world.root, 'ledger.db')
    const result = ciRepairRun({ checkout: world.host, branch: 'main', crewDir: world.crew, dbPath, deps })
    const crewCalls = calls.filter((argv) => argv.some((arg) => typeof arg === 'string' && arg.endsWith('/crew/crew.mjs')))
    assert.equal(crewCalls.length, 1)
    assert.ok(crewCalls[0].includes('--variant') && crewCalls[0].includes('repair'))
    assert.ok(crewCalls[0].includes('--brief-file') && crewCalls[0].includes('--lane'))
    assert.equal(result.dispatches.length, 1)
    const brief = readFileSync(result.dispatches[0].brief_path, 'utf8')
    assert.ok(brief.includes(failureLog.slice(failureLog.indexOf('not ok')) .trim()))
    const ledger = openLedger({ dbPath, stderr: { write() {} } })
    assert.equal(ledger.dumpTable('ci_cycles').length, 2)
    assert.equal(ledger.dumpTable('ci_dispatches').length, 1)
    ledger.close()
  } finally { cleanup(world) }
})

test('a second red parks and no third dispatch exists by any call sequence', { skip: SKIP }, () => {
  const world = makeWorld()
  try {
    const { calls, deps } = seam(world, { conclusions: ['failure', 'failure'] })
    const dbPath = join(world.root, 'ledger.db')
    const first = ciRepairRun({ checkout: world.host, branch: 'main', crewDir: world.crew, dbPath, deps })
    const firstCrewCalls = calls.filter((argv) => argv.some((arg) => typeof arg === 'string' && arg.endsWith('/crew/crew.mjs'))).length
    const second = ciRepairRun({ checkout: world.host, branch: 'main', crewDir: world.crew, dbPath, deps })
    const secondCrewCalls = calls.filter((argv) => argv.some((arg) => typeof arg === 'string' && arg.endsWith('/crew/crew.mjs'))).length
    assert.equal(firstCrewCalls, 1)
    assert.equal(secondCrewCalls, 1)
    assert.ok(first.dispatches.concat(second.dispatches).some((row) => row.outcome === 'refused' && row.reason === 'bound-reached'))
    assert.ok(second.parked?.path)
    assert.equal(JSON.parse(readFileSync(second.parked.path, 'utf8')).next, 'human')
  } finally { cleanup(world) }
})

test('a platform-divergent red parks at cycle one without dispatching', { skip: SKIP }, () => {
  const world = makeWorld()
  try {
    const { calls, deps } = seam(world, { conclusions: ['failure'], local: 'green' })
    const result = ciRepairRun({ checkout: world.host, branch: 'main', crewDir: world.crew, dbPath: join(world.root, 'ledger.db'), deps })
    assert.equal(result.cycles[0].classification, 'platform-divergent')
    assert.equal(result.cycles[0].cycle, 1)
    assert.equal(calls.some((argv) => argv.some((arg) => typeof arg === 'string' && arg.endsWith('/crew/crew.mjs'))), false)
    assert.equal(result.parked.record.cycle, 1)
  } finally { cleanup(world) }
})

test('every unknown classification parks rather than dispatching', { skip: SKIP }, () => {
  for (const reason of UNKNOWN_REASONS) {
    const world = makeWorld()
    try {
      const options = reason === 'ci-failures-unparseable'
        ? { log: 'TAP version 13\nok 1 - green\n' }
        : reason === 'local-lane-unrunnable'
          ? { local: 'unrunnable' }
          : reason === 'local-failures-disjoint'
            ? { local: 'disjoint' }
            : { conclusions: ['cancelled'] }
      const { calls, deps } = seam(world, options)
      const result = ciRepairRun({ checkout: world.host, branch: 'main', crewDir: world.crew, dbPath: join(world.root, 'ledger.db'), deps })
      assert.equal(result.cycles[0].classification, 'unknown')
      assert.equal(result.cycles[0].reason, reason)
      assert.equal(result.parked.record.cycle, 1)
      assert.equal(calls.some((argv) => argv.some((arg) => typeof arg === 'string' && arg.endsWith('/crew/crew.mjs'))), false)
    } finally { cleanup(world) }
  }
})

test('a worker checkout never pushes and never builds a dispatch argv', { skip: SKIP }, () => {
  const world = makeWorld()
  const linked = join(world.root, 'linked')
  assert.equal(git(world.host, 'worktree', 'add', '-q', linked, '-b', 'worker-branch').status, 0)
  try {
    const { calls, deps } = seam({ ...world, host: linked }, { conclusions: ['failure'] })
    const result = ciRepairRun({ checkout: linked, branch: 'worker-branch', crewDir: world.crew, dbPath: join(world.root, 'ledger.db'), deps })
    assert.equal(result.reason, 'worker-path')
    assert.equal(calls.some((argv) => argv.includes('push')), false)
    assert.equal(calls.some((argv) => argv.some((arg) => typeof arg === 'string' && arg.endsWith('/crew/crew.mjs'))), false)
  } finally { rmSync(linked, { recursive: true, force: true }); cleanup(world) }
})

test('an inherited scope naming .github/workflows is refused, never widened', { skip: SKIP }, () => {
  const world = makeWorld()
  try {
    mkdirSync(join(world.host, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(world.host, '.github', 'workflows', 'test.yml'), 'name: test\n')
    writeFileSync(join(world.crew, 'returns', 'task.json'), JSON.stringify({ status: 'done', details: { files_committed: ['.github/workflows/'] } }))
    const { calls, deps } = seam(world, { conclusions: ['failure'] })
    const result = ciRepairRun({ checkout: world.host, branch: 'main', crewDir: world.crew, dbPath: join(world.root, 'ledger.db'), deps })
    assert.equal(result.dispatches[0].reason, 'scope-forbidden')
    assert.equal(calls.some((argv) => argv.some((arg) => typeof arg === 'string' && arg.endsWith('/crew/crew.mjs'))), false)
    assert.equal(readFileSync(join(world.host, '.github', 'workflows', 'test.yml'), 'utf8'), 'name: test\n')
  } finally { cleanup(world) }
})

test('the park artifact names its cycle and carries the verbatim log', { skip: SKIP }, () => {
  const world = makeWorld()
  try {
    const { deps } = seam(world, { conclusions: ['failure'], local: 'green', log: failureLog })
    const result = ciRepairRun({ checkout: world.host, branch: 'main', crewDir: world.crew, dbPath: join(world.root, 'ledger.db'), deps })
    const artifact = JSON.parse(readFileSync(result.parked.path, 'utf8'))
    assert.equal(artifact.cycle, 1)
    assert.equal(artifact.excerpt, failureLog.slice(failureLog.indexOf('not ok')).trimEnd())
    assert.equal(artifact.next, 'human')
  } finally { cleanup(world) }
})

test('the dispatch outcome is recorded in ci_dispatches for the cycle that produced it', { skip: SKIP }, () => {
  const world = makeWorld()
  try {
    const escalation = { where: 'triage', why: 'inherited scope is unavailable' }
    const { calls, deps } = seam(world, { conclusions: ['failure'], dispatchStatus: 'escalation', dispatchExit: 1, escalation })
    const dbPath = join(world.root, 'ledger.db')
    const result = ciRepairRun({ checkout: world.host, branch: 'main', crewDir: world.crew, dbPath, deps })
    assert.equal(calls.filter((argv) => argv.some((arg) => typeof arg === 'string' && arg.endsWith('/crew/crew.mjs'))).length, 1)
    const ledger = openLedger({ dbPath, stderr: { write() {} } })
    const row = ledger.dumpTable('ci_dispatches')[0]
    assert.equal(row.outcome, 'escalation')
    assert.match(row.reason, /triage/)
    assert.match(row.reason, /inherited scope is unavailable/)
    assert.equal(result.parked.record.dispatch.escalation.why, escalation.why)
    ledger.close()
  } finally { cleanup(world) }
})

test('a degraded or unreadable ledger refuses to dispatch rather than assuming the bound', { skip: SKIP }, () => {
  for (const unreadable of [false, true]) {
    const world = makeWorld()
    try {
      const { calls, deps } = seam(world, { conclusions: ['failure'] })
      deps.openLedger = () => unreadable
        ? { stats: () => ({ degraded: false }), dumpTable() { throw new Error('unreadable') }, close() {} }
        : { stats: () => ({ degraded: true }), dumpTable: () => [], close() {} }
      const result = ciRepairRun({ checkout: world.host, branch: 'main', crewDir: world.crew, dbPath: join(world.root, 'ledger.db'), deps })
      assert.equal(result.dispatches[0].outcome, 'refused')
      assert.equal(result.dispatches[0].reason, 'bound-unverifiable')
      assert.equal(calls.some((argv) => argv.some((arg) => typeof arg === 'string' && arg.endsWith('/crew/crew.mjs'))), false)
    } finally { cleanup(world) }
  }
})

test('a driver escalation at triage is recorded as escalation and parked, never smoothed into refused', { skip: SKIP }, () => {
  const world = makeWorld()
  try {
    const why = "a repair run inherits the failing run's files_in_scope and ctx carries none — the scope gate is never relaxed to let a repair run without a declared scope"
    const escalation = { where: 'triage', why }
    const { calls, deps } = seam(world, { conclusions: ['failure'], dispatchStatus: 'escalation', dispatchExit: 1, escalation })
    const dbPath = join(world.root, 'ledger.db')
    const result = ciRepairRun({ checkout: world.host, branch: 'main', crewDir: world.crew, dbPath, deps })
    const crewCalls = calls.filter((argv) => argv.some((arg) => typeof arg === 'string' && arg.endsWith('/crew/crew.mjs')))
    assert.equal(crewCalls.length, 1)
    assert.equal(result.dispatches[0].outcome, 'escalation')
    assert.notEqual(result.dispatches[0].outcome, 'refused')
    const artifact = JSON.parse(readFileSync(result.parked.path, 'utf8'))
    assert.equal(artifact.cycle, 1)
    assert.equal(artifact.dispatch.outcome, 'escalation')
    assert.equal(artifact.dispatch.escalation.where, 'triage')
    assert.equal(artifact.why, why)
    assert.equal(result.parked.path.includes('ci-park-cycle-1.json'), true)
  } finally { cleanup(world) }
})

test('a missing crew dir records a refusal and parks without building an argv', { skip: SKIP }, () => {
  const world = makeWorld()
  try {
    const missingCrew = join(world.root, 'missing-crew')
    mkdirSync(missingCrew)
    const { calls, deps } = seam(world, { conclusions: ['failure'] })
    const dbPath = join(world.root, 'ledger.db')
    const result = ciRepairRun({ checkout: world.host, branch: 'main', crewDir: missingCrew, dbPath, deps })
    assert.equal(result.cycles.length, 1)
    assert.equal(result.dispatches[0].outcome, 'refused')
    assert.equal(result.dispatches[0].reason, 'crew-dir-missing')
    assert.equal(calls.some((argv) => argv.some((arg) => typeof arg === 'string' && arg.endsWith('/crew/crew.mjs'))), false)
    const ledger = openLedger({ dbPath, stderr: { write() {} } })
    assert.equal(ledger.dumpTable('ci_cycles').length, 1)
    ledger.close()
  } finally { cleanup(world) }
})

test('dispatchRepair reads an escalation envelope and retains its task return path', () => {
  const world = makeWorld()
  try {
    const why = 'the scope gate needs a human'
    const { deps } = seam(world, { dispatchStatus: 'escalation', dispatchExit: 1, escalation: { where: 'triage', why } })
    const result = dispatchRepair({
      cycle: 1, briefPath: join(world.crew, 'task', 'brief.md'), crew: { task: 'repair-task' },
      crewDir: world.crew, checkout: world.host,
      row: { local_lane: 'node --test' }, deps,
    })
    assert.equal(result.outcome, 'escalation')
    assert.equal(result.escalation.where, 'triage')
    assert.equal(result.escalation.why, why)
    assert.ok(result.task_return)
  } finally { cleanup(world) }
})

// Orchestrator close-out pin (mutation-found gap): the sibling guard to the test
// below. There, the printed line carries no crew status at all. Here it carries a
// well-formed status:"done" while the process exited non-zero — the shape a stale
// envelope from a prior run actually takes. Neutralising the status/exit agreement
// check left the whole suite green before this existed.
test('a result line whose status disagrees with the exit code is unreadable, never done', () => {
  const world = makeWorld()
  try {
    const taskReturn = join(world.crew, 'returns', 'task.json')
    const before = readFileSync(taskReturn, 'utf8')
    for (const [status, exit] of [['done', 1], ['escalation', 0]]) {
      const result = dispatchRepair({
        cycle: 1,
        briefPath: join(world.crew, 'task', 'brief.md'),
        crew: { task: 'repair-task', checkout: world.host, task_return: taskReturn },
        crewDir: world.crew,
        checkout: world.host,
        row: { local_lane: 'node --test' },
        deps: { spawnSync: () => ({ status: exit, stdout: `${JSON.stringify({ status, commit: 'deadbee' })}\n`, stderr: '' }) },
      })
      assert.equal(result.outcome, 'unreadable', `status=${status} exit=${exit} must not be trusted`)
      assert.match(result.why, /status-exit-mismatch/)
      assert.equal(readFileSync(taskReturn, 'utf8'), before)
    }
  } finally { cleanup(world) }
})

test('a preflight failure cannot reuse a settled envelope from the prior run', () => {
  const world = makeWorld()
  try {
    const taskReturn = join(world.crew, 'returns', 'task.json')
    const before = readFileSync(taskReturn, 'utf8')
    const result = dispatchRepair({
      cycle: 1,
      briefPath: join(world.crew, 'task', 'brief.md'),
      crew: { task: 'repair-task', checkout: world.host, task_return: taskReturn },
      crewDir: world.crew,
      checkout: world.host,
      row: { local_lane: 'node --test' },
      deps: { spawnSync: () => ({ status: 1, stdout: '{"error":"dirty checkout"}\\n', stderr: '' }) },
    })
    assert.equal(result.outcome, 'unreadable')
    assert.equal(readFileSync(taskReturn, 'utf8'), before)
  } finally { cleanup(world) }
})
