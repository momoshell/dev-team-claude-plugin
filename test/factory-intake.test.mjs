// test/factory-intake.test.mjs — pure selection tests use injected board pages;
// no test reaches the network, and recording tests use explicit temporary db paths.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ROOT } from './helpers.mjs'
import {
  DEFAULT_INTAKE_CONFIG, REQUIRED_INTAKE_CONFIG_KEYS, compileIntakeBrief, dispatchPicked,
  extractIntakeBlock, fetchBoard, intakeConfigUsable, intakeLoop, intakeRun, intakeSweep, normalDeps,
  MIN_SWEEP_INTERVAL_MS, normaliseBoardPage, observeDispatches, orderCandidates,
} from '../scripts/factory/intake.mjs'
import { INTAKE_OUTCOMES, INTAKE_REFUSALS, openLedger } from '../scripts/factory/ledger.mjs'

const TARGET = 'scripts/factory/intake.mjs'
const NOW = Date.parse('2026-01-02T00:00:00.000Z')
const fixture = mkdtempSync(join(tmpdir(), 'factory-intake-'))
after(() => rmSync(fixture, { recursive: true, force: true }))

function dbPath() {
  return join(mkdtempSync(join(tmpdir(), 'factory-intake-')), 'ledger.db')
}

function field(name, value) {
  return { name: value, field: { name } }
}

function issue({
  number, title = `Issue ${number}`, body = null, status = 'Ready', priority = 'P1',
  id = `ITEM-${number}`,
  createdAt = `2025-12-${String(number).padStart(2, '0')}T00:00:00Z`,
} = {}) {
  const nodes = []
  if (status !== undefined) nodes.push(field('Status', status))
  if (priority !== undefined) nodes.push(field('Priority', priority))
  return {
    id,
    content: {
      number, title, url: `https://example.test/issues/${number}`, body, createdAt,
    },
    fieldValues: { nodes },
  }
}

function draft() {
  return { content: { title: 'Draft item' }, fieldValues: { nodes: [{}] } }
}

function page(nodes, {
  organization = false, hasNextPage = false, endCursor = null,
  remaining = 900, resetAt = '2026-01-02T01:00:00Z',
} = {}) {
  const project = { items: { nodes, pageInfo: { hasNextPage, endCursor } } }
  const data = organization
    ? { organization: { projectV2: project } }
    : { user: { projectV2: project } }
  return { data, rateLimit: { remaining, resetAt } }
}

function intakeBody({ ask = 'Implement measured queue selection', where = TARGET } = {}) {
  return `ask: ${ask}\nwhere: ${where}\ndone-means: The selected issue is recorded\nout-of-scope: Dispatching and status changes`
}

function sweepDeps(pages, extra = {}) {
  let index = 0
  const calls = []
  return {
    calls,
    deps: {
      now: () => NOW,
      existsSync: () => false,
      runsInWindow: () => 0,
      github: (request) => {
        calls.push(request)
        const response = pages[Math.min(index, pages.length - 1)]
        index += 1
        return response
      },
      ...extra,
    },
  }
}

function loopDeps(pages = [page([])], options = {}) {
  let index = 0
  let clock = NOW
  let brake = false
  const calls = []
  const sleeps = []
  const sleepCalls = []
  const setBrake = (value = true) => { brake = value }
  const deps = {
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms)
      clock += ms
      sleepCalls.push(calls.length)
      options.onSleep?.({ count: sleeps.length, ms, setBrake })
    },
    existsSync: () => brake,
    runsInWindow: () => 0,
    github: (request) => {
      calls.push(request)
      const response = pages.length > 0 ? pages[Math.min(index, pages.length - 1)] : page([])
      index += 1
      options.onGithub?.({ index: index - 1, request, setBrake })
      return response
    },
    ...options.deps,
  }
  return { calls, sleeps, sleepCalls, setBrake, deps }
}

const baseConfig = {
  ...DEFAULT_INTAKE_CONFIG,
  windowCap: 99,
  protectedPaths: [],
}

function runSweep(nodes, options = {}) {
  const fixturePages = options.pages || [page(nodes)]
  const runner = sweepDeps(fixturePages, options.deps)
  const result = intakeSweep({
    board: { owner: 'example-owner', projectNumber: 7 },
    checkout: ROOT,
    dbPath: options.dbPath ?? null,
    config: { ...baseConfig, ...(options.config || {}) },
    deps: runner.deps,
  })
  return { result, calls: runner.calls }
}

function dispatchDeps(nodes, overrides = {}) {
  const crewDir = mkdtempSync(join(fixture, 'crew-'))
  const taskDir = join(crewDir, 'task')
  const returnsDir = join(crewDir, 'returns')
  const ledgerDir = join(crewDir, 'ledger')
  const adwId = 'fixture-adw-id'
  mkdirSync(taskDir, { recursive: true })
  mkdirSync(returnsDir, { recursive: true })
  mkdirSync(ledgerDir, { recursive: true })
  const runSidecar = join(ledgerDir, 'run.json')
  writeFileSync(runSidecar, JSON.stringify({ adw_id: adwId }))
  const taskReturn = join(returnsDir, 'task.json')
  writeFileSync(taskReturn, JSON.stringify({ status: 'done', summary: 'fixture', artifacts: [], details: {} }))
  const calls = { moves: [], boots: [], runs: [], prs: [], branches: [] }
  const deps = {
    now: () => NOW,
    existsSync: (path) => String(path).endsWith('STOP') ? false : existsSync(path),
    readFileSync,
    writeFileSync,
    mkdirSync,
    runsInWindow: () => 0,
    github: () => page(nodes),
    branchFor: (request) => { calls.branches.push(request); return overrides.branch ?? 'test/branch' },
    boardMove: (request) => {
      calls.moves.push(request)
      return overrides.boardMove ? overrides.boardMove(request) : { ok: true, status: request.to, reason: null }
    },
    crewBoot: (request) => {
      calls.boots.push(request)
      return overrides.crewBoot ? overrides.crewBoot(request) : {
        exit: 0,
        stdout: `${JSON.stringify({ task_dir: taskDir, workspace_id: 'ws', members: {}, crew_json: join(crewDir, 'crew.json') })}\n`,
        stderr: '',
      }
    },
    crewRun: (request) => {
      calls.runs.push(request)
      return overrides.crewRun ? overrides.crewRun(request) : {
        exit: 0,
        stdout: `${JSON.stringify({ status: 'done', task_return: taskReturn, commit: 'c' })}\n`,
        stderr: '',
      }
    },
    pullRequestFor: (request) => {
      calls.prs.push(request)
      return overrides.pullRequestFor ? overrides.pullRequestFor(request) : null
    },
    ...overrides.deps,
  }
  return { calls, crewDir, taskDir, taskReturn, ledgerDir, runSidecar, adwId, deps }
}

function runIntake(nodes, options = {}) {
  const harness = dispatchDeps(nodes, options.overrides)
  const result = intakeRun({
    board: { owner: 'example-owner', projectNumber: 7 },
    checkout: ROOT,
    dbPath: options.dbPath ?? null,
    config: { ...baseConfig, ...(options.config || {}) },
    deps: harness.deps,
  })
  return { ...harness, result }
}

test('extractIntakeBlock returns the strict four-line request and never repairs prose', () => {
  assert.deepEqual(extractIntakeBlock(`intro\r\n ${intakeBody()} \r\ntrailing`), {
    ok: true,
    request: {
      ask: 'Implement measured queue selection',
      where: [TARGET],
      done_means: 'The selected issue is recorded',
      out_of_scope: 'Dispatching and status changes',
    },
  })
  assert.deepEqual(extractIntakeBlock('prose says ask: implement queue selection'), {
    ok: false, reason: 'intake-block-missing',
  })
  assert.deepEqual(extractIntakeBlock('ask: one\nwhere: x\nout-of-scope: y\ndone-means: z'), {
    ok: false, reason: 'intake-block-malformed',
  })
})

test('pagination sweeps every page and can pick an issue on page two', () => {
  const first = page([issue({ number: 1, body: intakeBody(), priority: 'P2' })], {
    hasNextPage: true, endCursor: 'cursor-one',
  })
  const second = page([issue({ number: 2, body: intakeBody(), priority: 'P0' })])
  const { result, calls } = runSweep([], { pages: [first, second] })
  assert.equal(result.picked.issue, 2)
  assert.equal(result.pages, 2)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].after, 'cursor-one')
})

test('normaliseBoardPage accepts user and organization envelopes, skips unknown fields, and counts drafts', () => {
  const nodes = [
    issue({ number: 9, body: intakeBody() }),
    draft(),
  ]
  const user = normaliseBoardPage(page(nodes), {
    statusField: 'Status', priorityField: 'Priority',
  })
  const organization = normaliseBoardPage(page(nodes, { organization: true, remaining: 321 }), {
    statusField: 'Status', priorityField: 'Priority',
  })
  assert.equal(user.items.length, 1)
  assert.equal(user.drafts, 1)
  assert.equal(user.items[0].status, 'Ready')
  assert.equal(user.items[0].priority, 'P1')
  assert.deepEqual(organization.rateLimit, { remaining: 321, reset_at: '2026-01-02T01:00:00Z' })
  assert.deepEqual(normaliseBoardPage({ nope: true }, { statusField: 'Status', priorityField: 'Priority' }), {
    items: [], pageInfo: { hasNextPage: false, endCursor: null }, rateLimit: null, drafts: 0,
  })
})

test('normaliseBoardPage lifts rateLimit nested in the GraphQL data envelope', () => {
  const raw = page([issue({ number: 12, body: intakeBody() })], {
    remaining: 10, resetAt: '2026-01-02T02:00:00Z',
  })
  const nested = {
    data: { ...raw.data, rateLimit: raw.rateLimit },
  }
  const out = normaliseBoardPage(nested, {
    statusField: 'Status', priorityField: 'Priority',
  })
  assert.deepEqual(out.rateLimit, { remaining: 10, reset_at: '2026-01-02T02:00:00Z' })
})

test('orderCandidates sorts priority before age and then issue for a total order', () => {
  const candidates = [
    { issue: 3, priority: 'P1', created_at: '2025-01-01T00:00:00Z' },
    { issue: 2, priority: 'P0', created_at: '2025-12-01T00:00:00Z' },
    { issue: 1, priority: 'P1', created_at: '2025-02-01T00:00:00Z' },
    { issue: 4, priority: 'P1', created_at: '2025-02-01T00:00:00Z' },
  ]
  assert.deepEqual(orderCandidates(candidates, { priorityOrder: ['P0', 'P1'] }).map(({ issue }) => issue), [2, 3, 1, 4])
  assert.deepEqual(candidates.map(({ issue }) => issue), [3, 2, 1, 4])
})

test('end-to-end selection picks the head of orderCandidates', () => {
  const nodes = [
    issue({ number: 10, body: intakeBody(), priority: 'P1', createdAt: '2025-01-01T00:00:00Z' }),
    issue({ number: 11, body: intakeBody(), priority: 'P0', createdAt: '2025-12-01T00:00:00Z' }),
  ]
  const { result } = runSweep(nodes)
  assert.equal(result.picked.issue, 11)
})

test('concurrency one picks exactly one and records the other survivor as not-first-in-order', () => {
  const { result } = runSweep([
    issue({ number: 20, body: intakeBody(), priority: 'P0' }),
    issue({ number: 21, body: intakeBody(), priority: 'P1' }),
  ])
  assert.equal(result.picked.issue, 20)
  assert.equal(result.refusals.length, 1)
  assert.equal(result.refusals[0].issue, 21)
  assert.equal(result.refusals[0].reason, 'not-first-in-order')
  assert.match(result.refusals[0].detail, /concurrency=1/)
})

test('stop switch parks before the runner spends API budget', () => {
  let calls = 0
  const { result } = runSweep([issue({ number: 30, body: intakeBody() })], {
    deps: { existsSync: () => true, github: () => { calls += 1; return page([]) } },
  })
  assert.equal(result.reason, 'stop-switch')
  assert.equal(result.outcome, 'parked')
  assert.equal(calls, 0)
})

test('protected paths refuse a candidate with the protected hits as detail', () => {
  const { result } = runSweep([issue({ number: 31, body: intakeBody() })], {
    config: { protectedPaths: [TARGET] },
  })
  assert.equal(result.outcome, 'none')
  assert.deepEqual(result.refusals.map(({ reason, detail }) => ({ reason, detail })), [
    { reason: 'protected-path', detail: TARGET },
  ])
})

test('window cap parks before the runner is called', () => {
  let calls = 0
  const { result } = runSweep([issue({ number: 32, body: intakeBody() })], {
    config: { windowCap: 3 },
    deps: { runsInWindow: () => 3, github: () => { calls += 1; return page([]) } },
  })
  assert.equal(result.reason, 'window-cap')
  assert.equal(calls, 0)
})

test('judge-tier proposal refuses without selecting or dispatching', () => {
  const { result } = runSweep([issue({ number: 33, body: intakeBody({ where: 'scripts/factory' }) })])
  assert.equal(result.outcome, 'none')
  assert.equal(result.refusals[0].reason, 'tier-judge')
})

test('missing intake block is refused even when prose describes the same request', () => {
  const body = `The issue asks to implement measured queue selection in ${TARGET}.`
  const { result } = runSweep([issue({ number: 40, body })])
  assert.equal(result.refusals[0].reason, 'intake-block-missing')
})

test('an out-of-order intake block is malformed rather than repaired', () => {
  const body = `ask: Implement measured queue selection\nwhere: ${TARGET}\nout-of-scope: Dispatching\ndone-means: Recorded`
  const { result } = runSweep([issue({ number: 41, body })])
  assert.equal(result.refusals[0].reason, 'intake-block-malformed')
})

test('a where path that does not resolve is brief-uncompilable with make-brief reason', () => {
  const body = intakeBody({ where: 'not-a-real-intake-file.mjs' })
  const { result } = runSweep([issue({ number: 42, body })])
  assert.equal(result.refusals[0].reason, 'brief-uncompilable')
  assert.equal(result.refusals[0].detail, 'missing-path')
})

test('an item with no priority field is priority-unknown', () => {
  const { result } = runSweep([issue({ number: 43, body: intakeBody(), priority: null })])
  assert.equal(result.refusals[0].reason, 'priority-unknown')
})

test('a low rate limit parks after one page and carries the reset time', () => {
  const first = page([issue({ number: 50, body: intakeBody() })], {
    hasNextPage: true, endCursor: 'never-used', remaining: 199, resetAt: '2026-01-02T02:00:00Z',
  })
  const second = page([issue({ number: 51, body: intakeBody() })])
  const { result, calls } = runSweep([], { pages: [first, second] })
  assert.equal(result.outcome, 'parked')
  assert.equal(result.reason, 'rate-limit-floor')
  assert.equal(result.pages, 1)
  assert.equal(result.rate_limit.degraded, true)
  assert.equal(result.rate_limit.reset_at, '2026-01-02T02:00:00Z')
  assert.equal(calls.length, 1)
})

test('a recorded sweep and each named refusal round-trip through the ledger tables', () => {
  const path = dbPath()
  const { result } = runSweep([
    issue({ number: 60, body: null }),
    issue({ number: 61, body: intakeBody(), priority: 'P1' }),
  ], { dbPath: path })
  const ledger = openLedger({ dbPath: path, stderr: { write: () => {} } })
  const sweeps = ledger.dumpTable('intake_sweeps')
  const refusals = ledger.dumpTable('intake_refusals')
  assert.equal(sweeps.length, 1)
  assert.equal(sweeps[0].outcome, 'picked')
  assert.equal(sweeps[0].picked_issue, 61)
  assert.equal(refusals.length, 1)
  assert.equal(refusals[0].issue, 60)
  assert.equal(refusals[0].reason, 'intake-block-missing')
  ledger.close()
})

test('fetchBoard tracks the lowest rate limit while preserving the latest reset at that floor', () => {
  const calls = []
  const result = fetchBoard({
    board: { owner: 'example-owner', projectNumber: 7 },
    config: { ...baseConfig, maxPages: 3 },
    deps: {
      github: (request) => {
        calls.push(request)
        return calls.length === 1
          ? page([], { hasNextPage: true, endCursor: 'next', remaining: 500, resetAt: 'first' })
          : page([], { remaining: 450, resetAt: 'second' })
      },
    },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.rateLimit, { remaining: 450, reset_at: 'second' })
  assert.equal(calls.length, 2)
})

test('normalDeps keeps the injected seams and defaults the runner without spawning at construction', () => {
  let spawned = 0
  const github = () => page([])
  const deps = normalDeps({
    github, now: () => NOW, existsSync: () => false,
    runsInWindow: () => 0, spawnSync: () => { spawned += 1 },
  })
  assert.equal(deps.github, github)
  assert.equal(deps.now(), NOW)
  assert.equal(deps.existsSync('x'), false)
  assert.equal(deps.runsInWindow(), 0)
  assert.equal(spawned, 0)
})

test('a picked issue compiles one brief, boots once, runs once, and claims the work column', () => {
  const path = dbPath()
  const { result, calls, taskDir } = runIntake([
    issue({ number: 70, body: intakeBody() }),
  ], { dbPath: path })
  assert.equal(result.sweep.picked.issue, 70)
  assert.equal(result.dispatch.outcome, 'done')
  assert.equal(calls.moves.filter((move) => move.to === baseConfig.workColumn).length, 1)
  assert.equal(calls.boots.length, 1)
  assert.equal(calls.runs.length, 1)
  assert.equal(calls.runs[0].briefPath, result.dispatch.brief_path)
  assert.equal(result.dispatch.brief_path.startsWith(taskDir), true)
  assert.match(readFileSync(result.dispatch.brief_path, 'utf8'), /## The ask/)
  const ledger = openLedger({ dbPath: path, stderr: { write: () => {} } })
  assert.deepEqual(ledger.dumpTable('intake_dispatches').map(({ outcome }) => outcome), ['claimed', 'done'])
  ledger.close()
})

test('dispatchPicked records the compiled ask on the sessions row minted by crewRun', () => {
  const path = dbPath()
  const harness = dispatchDeps([issue({ number: 80, body: intakeBody() })])
  harness.deps.crewRun = () => {
    const ledger = openLedger({ dbPath: path, stderr: { write: () => {} } })
    try {
      ledger.startSession({ adw_id: harness.adwId, repo_slug: 'repo', task_slug: 'intake-80' })
    } finally {
      ledger.close()
    }
    return { exit: 0, stdout: `${JSON.stringify({ status: 'done', task_return: harness.taskReturn })}\n`, stderr: '' }
  }
  const result = intakeRun({
    board: { owner: 'example-owner', projectNumber: 7 }, checkout: ROOT, dbPath: path,
    config: baseConfig, deps: harness.deps,
  })
  assert.equal(result.dispatch.outcome, 'done')
  const ledger = openLedger({ dbPath: path, stderr: { write: () => {} } })
  const row = ledger.getSession(harness.adwId)
  assert.deepEqual({ request: row.request, request_source: row.request_source }, {
    request: 'Implement measured queue selection', request_source: 'dispatch',
  })
  ledger.close()
})

test('dispatchPicked leaves honest request absence when the sidecar is missing or has no adw_id', () => {
  for (const invalid of ['missing', 'no-adw-id']) {
    const path = dbPath()
    const harness = dispatchDeps([issue({ number: invalid === 'missing' ? 81 : 82, body: intakeBody() })])
    if (invalid === 'missing') {
      rmSync(harness.runSidecar, { force: true })
    } else {
      writeFileSync(harness.runSidecar, JSON.stringify({ task_slug: 'without-an-id' }))
    }
    harness.deps.crewRun = () => {
      const ledger = openLedger({ dbPath: path, stderr: { write: () => {} } })
      try {
        ledger.startSession({ adw_id: harness.adwId, repo_slug: 'repo', task_slug: `intake-${invalid}` })
      } finally {
        ledger.close()
      }
      return { exit: 0, stdout: `${JSON.stringify({ status: 'done', task_return: harness.taskReturn })}\n`, stderr: '' }
    }
    const result = intakeRun({
      board: { owner: 'example-owner', projectNumber: 7 }, checkout: ROOT, dbPath: path,
      config: baseConfig, deps: harness.deps,
    })
    assert.equal(result.dispatch.outcome, 'done')
    const ledger = openLedger({ dbPath: path, stderr: { write: () => {} } })
    assert.equal(ledger.getSession(harness.adwId).request, null)
    ledger.close()
  }
})

test('observeDispatches promotion uses a synthetic picked without recording a request', () => {
  const path = dbPath()
  const harness = dispatchDeps([], { pullRequestFor: () => ({ number: 902, url: 'https://example.test/pull/902' }) })
  const ledger = openLedger({ dbPath: path, stderr: { write: () => {} } })
  ledger.recordIntakeDispatch({
    board_owner: 'example-owner', board_project: 7, issue: 83, outcome: 'claimed',
    tier: 'build', task_slug: 'intake-83', branch: 'test/branch', sweep_at: '2026-01-02T00:00:00.000Z',
  })
  ledger.close()
  assert.doesNotThrow(() => observeDispatches({
    board: { owner: 'example-owner', projectNumber: 7 },
    boardItems: [{ issue: 83, item_id: 'ITEM-83', status: baseConfig.workColumn }],
    checkout: ROOT, dbPath: path, config: baseConfig, deps: harness.deps,
  }))
  const check = openLedger({ dbPath: path, stderr: { write: () => {} } })
  assert.equal(check.dumpTable('sessions').length, 0)
  assert.equal(readFileSync(check._jsonlPath, 'utf8').includes('recordSessionRequest'), false)
  check.close()
})

test('a refused board write does not boot or claim, and the same Ready page can be picked again', () => {
  const path = dbPath()
  const nodes = [issue({ number: 71, body: intakeBody() })]
  const first = runIntake(nodes, {
    dbPath: path,
    overrides: { boardMove: () => ({ ok: false, status: null }) },
  })
  assert.equal(first.result.dispatch.outcome, 'refused')
  assert.equal(first.result.dispatch.reason, 'board-write-failed')
  assert.equal(first.calls.boots.length, 0)
  assert.equal(first.calls.runs.length, 0)
  const ledger = openLedger({ dbPath: path, stderr: { write: () => {} } })
  assert.deepEqual(ledger.dumpTable('intake_dispatches').map(({ outcome }) => outcome), ['refused'])
  ledger.close()
  const next = intakeSweep({
    board: { owner: 'example-owner', projectNumber: 7 }, checkout: ROOT,
    config: baseConfig, deps: first.deps,
  })
  assert.equal(next.picked.issue, 71)
})

test('a Ready read-back is board-write-unverified and never boots', () => {
  const { result, calls } = runIntake([issue({ number: 72, body: intakeBody() })], {
    dbPath: dbPath(),
    overrides: { boardMove: () => ({ ok: true, status: 'Ready' }) },
  })
  assert.equal(result.dispatch.outcome, 'refused')
  assert.equal(result.dispatch.reason, 'board-write-unverified')
  assert.equal(calls.boots.length, 0)
  assert.equal(calls.runs.length, 0)

  const spawned = []
  const defaults = normalDeps({
    spawnSync: (command, args) => {
      spawned.push({ command, args })
      return {
        status: 0,
        stdout: JSON.stringify({
          data: {
            user: {
              projectV2: {
                id: 'PROJECT-1',
                fields: {
                  nodes: [{
                    id: 'FIELD-STATUS', name: 'Status',
                    options: [{ id: 'READY', name: 'Ready' }, { id: 'WORK', name: 'In progress' }],
                  }],
                },
              },
            },
            node: {
              fieldValues: {
                nodes: [{ name: 'In review', field: { id: 'FIELD-STATUS' } }],
              },
            },
          },
        }),
        stderr: '',
      }
    },
  })
  const stale = defaults.boardMove({
    board: { owner: 'example-owner', projectNumber: 7 }, itemId: 'ITEM-72',
    issue: 72, from: 'Ready', to: 'In progress', config: baseConfig,
  })
  assert.deepEqual(stale, { ok: true, status: 'In review', reason: 'board-write-unverified' })
  assert.equal(spawned.length, 1)
})

test('preflight errors and done lines with non-zero exits are unreadable, never done', () => {
  const preflight = runIntake([issue({ number: 73, body: intakeBody() })], {
    dbPath: dbPath(),
    overrides: { crewRun: () => ({ exit: 1, stdout: '{"error":"dirty"}\n', stderr: '' }) },
  })
  assert.equal(preflight.result.dispatch.outcome, 'unreadable')
  const mismatch = runIntake([issue({ number: 74, body: intakeBody() })], {
    dbPath: dbPath(),
    overrides: { crewRun: () => ({ exit: 1, stdout: '{"status":"done","task_return":"old"}\n', stderr: '' }) },
  })
  assert.equal(mismatch.result.dispatch.outcome, 'unreadable')
  assert.notEqual(mismatch.result.dispatch.outcome, 'done')
})

test('a null proposed tier refuses before any board write', () => {
  const path = dbPath()
  const harness = dispatchDeps([], {})
  const result = dispatchPicked({
    board: { owner: 'example-owner', projectNumber: 7 },
    picked: { issue: 75, title: 'Tierless issue', tier: null },
    sweptAt: '2026-01-02T00:00:00.000Z',
    boardItems: [{ issue: 75, item_id: 'ITEM-75', status: 'Ready' }],
    checkout: ROOT, dbPath: path, config: baseConfig, deps: harness.deps,
  })
  assert.equal(result.outcome, 'refused')
  assert.equal(result.reason, 'tier-unproposed')
  assert.equal(harness.calls.moves.length, 0)
  assert.equal(harness.calls.boots.length, 0)
  assert.equal(harness.calls.runs.length, 0)
})

test('a discovered PR promotes the work item and records its number and URL', () => {
  const path = dbPath()
  runIntake([issue({ number: 76, body: intakeBody() })], { dbPath: path })
  const second = runIntake([issue({ number: 76, body: intakeBody(), status: 'In progress' })], {
    dbPath: path,
    overrides: { pullRequestFor: () => ({ number: 901, url: 'https://example.test/pull/901' }) },
  })
  assert.equal(second.calls.boots.length, 0)
  assert.equal(second.calls.runs.length, 0)
  assert.equal(second.calls.moves.filter((move) => move.to === 'In review').length, 1)
  assert.equal(second.result.promotions.length, 1)
  assert.deepEqual(second.result.promotions[0].pr, { number: 901, url: 'https://example.test/pull/901' })
  const ledger = openLedger({ dbPath: path, stderr: { write: () => {} } })
  const row = ledger.dumpTable('intake_dispatches').find(({ outcome }) => outcome === 'promoted')
  assert.deepEqual({ pr_number: row.pr_number, pr_url: row.pr_url }, { pr_number: 901, pr_url: 'https://example.test/pull/901' })
  ledger.close()
})

test('without a PR the work item is not moved and no promotion row is recorded', () => {
  const path = dbPath()
  runIntake([issue({ number: 77, body: intakeBody() })], { dbPath: path })
  const second = runIntake([issue({ number: 77, body: intakeBody(), status: 'In progress' })], { dbPath: path })
  assert.equal(second.calls.moves.filter((move) => move.to === 'In review').length, 0)
  assert.deepEqual(second.result.promotions, [])
  const ledger = openLedger({ dbPath: path, stderr: { write: () => {} } })
  assert.equal(ledger.dumpTable('intake_dispatches').some(({ outcome }) => outcome === 'promoted'), false)
  ledger.close()
})

test('dispatch rows carry swept_at, and an item already in the work column is not a candidate', () => {
  const path = dbPath()
  const first = runIntake([issue({ number: 78, body: intakeBody() })], { dbPath: path })
  const second = runIntake([issue({ number: 78, body: intakeBody(), status: 'In progress' })], {
    dbPath: path,
    overrides: { pullRequestFor: () => null },
  })
  assert.equal(second.result.sweep.outcome, 'none')
  assert.equal(second.result.sweep.picked, null)
  const ledger = openLedger({ dbPath: path, stderr: { write: () => {} } })
  const rows = ledger.dumpTable('intake_dispatches')
  assert.ok(rows.length >= 2)
  assert.ok(rows.every((row) => row.sweep_at === first.result.sweep.swept_at))
  ledger.close()
})

test('intake.mjs names exactly the two non-node static module imports and no merge, approve or close surface', () => {
  const source = readFileSync(join(ROOT, 'scripts/factory/intake.mjs'), 'utf8')
  const uncommented = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
  assert.equal((uncommented.match(/import\s*\(/g) || []).length, 0)
  assert.equal((uncommented.match(/export\s+\*\s+from/g) || []).length, 0)
  const specifiers = [...uncommented.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1])
  assert.deepEqual(specifiers.filter((specifier) => !specifier.startsWith('node:')), ['./ledger.mjs', './make-brief.mjs'])
  for (const forbidden of [
    'drive.mjs', 'daemon.mjs', 'factoryctl', 'pr merge', 'pr close', 'pr review',
    'pr create', '--approve', 'mergePullRequest', 'closeIssue',
    'addPullRequestReview', 'git push',
  ]) {
    assert.equal(uncommented.includes(forbidden), false, `found ${forbidden}`)
  }
})

test('intake.mjs carries no identity literals or absolute paths', () => {
  const source = readFileSync(join(ROOT, 'scripts/factory/intake.mjs'), 'utf8')
  for (const forbidden of ['momoshell', 'dev-team-claude-plugin', 'wt-intake-select', '/Users/']) {
    assert.equal(source.includes(forbidden), false, `found ${forbidden}`)
  }
  assert.equal(/(?:^|["'`])\/(?!\/)/m.test(source), false)
})

test('importing intake.mjs performs no I/O and node --check passes', () => {
  const script = fileURLToPath(new URL('../scripts/factory/intake.mjs', import.meta.url))
  const check = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' })
  assert.equal(check.status, 0, check.stderr)
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import(${JSON.stringify(new URL('../scripts/factory/intake.mjs', import.meta.url).href)}).then(() => console.log('ok'))
  `], { encoding: 'utf8' })
  assert.equal(imported.status, 0, imported.stderr)
  assert.equal(imported.stdout.trim(), 'ok')
})

test('an unusable board is rejected before the stop switch or runner', () => {
  let checked = 0
  let called = 0
  const result = intakeSweep({
    board: { owner: '', projectNumber: null },
    deps: {
      existsSync: () => { checked += 1; return true },
      github: () => { called += 1; return page([]) },
    },
  })
  assert.deepEqual(result, { ok: false, reason: 'board-config-unusable' })
  assert.equal(checked, 0)
  assert.equal(called, 0)
})

test('an empty required column is refused before the stop switch or the runner', () => {
  let checked = 0
  let called = 0
  const result = intakeSweep({
    board: { owner: 'example-owner', projectNumber: 7 },
    config: { readyColumn: '' },
    deps: {
      existsSync: () => { checked += 1; return false },
      github: () => { called += 1; return page([]) },
    },
  })
  assert.deepEqual(result, {
    ok: false, reason: 'intake-config-unusable', detail: 'readyColumn',
  })
  assert.equal(checked, 0)
  assert.equal(called, 0)
})

test('colliding write-back columns are refused', () => {
  const result = intakeSweep({
    board: { owner: 'example-owner', projectNumber: 7 },
    config: { readyColumn: 'Same', workColumn: 'Same' },
    deps: { existsSync: () => { throw new Error('must not check stop') } },
  })
  assert.deepEqual(result, {
    ok: false, reason: 'intake-config-unusable', detail: 'workColumn',
  })
})

test('intakeRun refuses before observing when its configuration gate fails', () => {
  const path = dbPath()
  let checked = 0
  let fetched = 0
  const result = intakeRun({
    board: { owner: 'example-owner', projectNumber: 7 },
    dbPath: path,
    config: { readyColumn: '' },
    deps: {
      existsSync: () => { checked += 1; return false },
      github: () => { fetched += 1; return page([]) },
    },
  })
  assert.deepEqual(result, {
    sweep: { ok: false, reason: 'intake-config-unusable', detail: 'readyColumn' },
    dispatch: null,
    promotions: [],
  })
  assert.equal(checked, 0)
  assert.equal(fetched, 0)
  assert.equal(existsSync(path), false)
})

test('the default configuration satisfies its own requirements', () => {
  for (const key of REQUIRED_INTAKE_CONFIG_KEYS) {
    assert.equal(typeof DEFAULT_INTAKE_CONFIG[key], 'string')
    assert.ok(DEFAULT_INTAKE_CONFIG[key].trim())
  }
  assert.equal(intakeConfigUsable(DEFAULT_INTAKE_CONFIG), null)
  assert.equal(new Set([
    DEFAULT_INTAKE_CONFIG.readyColumn,
    DEFAULT_INTAKE_CONFIG.workColumn,
    DEFAULT_INTAKE_CONFIG.reviewColumn,
  ]).size, 3)
  const result = intakeSweep({
    board: { owner: 'example-owner', projectNumber: 7 },
    config: {},
    deps: { existsSync: () => false, github: () => page([]), runsInWindow: () => 0 },
  })
  assert.equal(result.ok, true)
  assert.equal(result.outcome, 'none')
})

test('intakeLoop separates consecutive sweeps by at least sixty seconds even when a shorter interval is configured', () => {
  const harness = loopDeps([page([])])
  const result = intakeLoop({
    board: { owner: 'example-owner', projectNumber: 7 }, checkout: ROOT,
    config: { ...baseConfig, sweepIntervalMs: 1000 }, deps: harness.deps, maxTicks: 3,
  })
  assert.equal(result.ok, true)
  assert.equal(result.ticks.length, 3)
  assert.deepEqual(harness.sleeps, [MIN_SWEEP_INTERVAL_MS, MIN_SWEEP_INTERVAL_MS])
  const starts = result.ticks.map((tick) => Date.parse(tick.started_at))
  assert.ok(starts.slice(1).every((start, index) => start - starts[index] >= MIN_SWEEP_INTERVAL_MS))
})

test('intakeLoop pauses instead of sweeping when the measured rate limit is at or below the floor and names the measured value', () => {
  const floor = baseConfig.rateLimitFloor
  const harness = loopDeps([
    page([], { remaining: floor, resetAt: '2026-01-02T01:00:00Z' }),
    page([], { remaining: 900 }),
  ])
  const result = intakeLoop({
    board: { owner: 'example-owner', projectNumber: 7 }, checkout: ROOT,
    config: baseConfig, deps: harness.deps, maxTicks: 3,
  })
  assert.equal(result.ticks.length, 3)
  assert.equal(result.ticks[1].swept, false)
  assert.equal(result.ticks[1].outcome, 'parked')
  assert.equal(result.ticks[1].reason, 'rate-limit-floor')
  assert.equal(result.ticks[1].basis.measured_remaining, floor)
  assert.equal(result.ticks[1].basis.floor, floor)
  assert.equal(result.ticks[1].rate_limit_remaining, floor)
  assert.equal(harness.sleepCalls[1], 1)
  assert.equal(harness.calls.length, 2)
  assert.equal(result.ticks[2].swept, true)
})

test('an unmeasured rate limit never reads as zero', () => {
  const withoutRateLimit = { data: page([]).data }
  const harness = loopDeps([withoutRateLimit, page([])])
  const result = intakeLoop({
    board: { owner: 'example-owner', projectNumber: 7 }, checkout: ROOT,
    config: baseConfig, deps: harness.deps, maxTicks: 2,
  })
  assert.equal(result.ticks.length, 2)
  assert.equal(result.ticks[0].swept, true)
  assert.equal(result.ticks[1].swept, true)
  assert.equal(result.ticks[1].outcome, 'none')
  assert.equal(harness.calls.length, 2)
})

test('a brake engaged between sweeps halts the next sweep', () => {
  const harness = loopDeps([page([])], {
    onSleep: ({ count, setBrake }) => { if (count === 1) setBrake() },
  })
  const result = intakeLoop({
    board: { owner: 'example-owner', projectNumber: 7 }, checkout: ROOT,
    config: baseConfig, deps: harness.deps, maxTicks: 3,
  })
  assert.equal(result.stopped, true)
  assert.equal(result.ticks.length, 2)
  assert.equal(result.ticks[1].swept, false)
  assert.equal(result.ticks[1].outcome, 'parked')
  assert.equal(result.ticks[1].reason, 'stop-switch')
  assert.equal(harness.calls.length, 1)
})

test('a brake engaged during a sweep does not affect the sweep in flight', () => {
  const harness = loopDeps([page([])], {
    onGithub: ({ index, setBrake }) => { if (index === 0) setBrake() },
  })
  const result = intakeLoop({
    board: { owner: 'example-owner', projectNumber: 7 }, checkout: ROOT,
    config: baseConfig, deps: harness.deps, maxTicks: 2,
  })
  assert.equal(result.ticks[0].swept, true)
  assert.equal(result.ticks[0].run.sweep.ok, true)
  assert.equal(result.ticks[1].swept, false)
  assert.equal(result.ticks[1].reason, 'stop-switch')
  assert.equal(harness.calls.length, 1)
})

test('a brake created after admission waits for the next loop tick', () => {
  let checks = 0
  const harness = loopDeps([page([])], {
    deps: {
      existsSync: () => {
        checks += 1
        return checks > 1
      },
    },
  })
  const result = intakeLoop({
    board: { owner: 'example-owner', projectNumber: 7 }, checkout: ROOT,
    config: baseConfig, deps: harness.deps, maxTicks: 1,
  })
  assert.equal(result.stopped, false)
  assert.equal(result.ticks[0].swept, true)
  assert.equal(result.ticks[0].run.sweep.ok, true)
  assert.equal(result.ticks[0].outcome, 'none')
  assert.equal(checks, 1)
  assert.equal(harness.calls.length, 1)
})

test('every loop tick is recorded through the closed intake vocabulary', () => {
  const path = dbPath()
  const floor = baseConfig.rateLimitFloor
  const harness = loopDeps([page([], { remaining: floor, resetAt: '2026-01-02T01:00:00Z' })], {
    onSleep: ({ count, setBrake }) => { if (count === 2) setBrake() },
  })
  const result = intakeLoop({
    board: { owner: 'example-owner', projectNumber: 7 }, checkout: ROOT,
    dbPath: path, config: baseConfig, deps: harness.deps, maxTicks: 3,
  })
  const ledger = openLedger({ dbPath: path, stderr: { write: () => {} } })
  const rows = ledger.dumpTable('intake_sweeps')
  ledger.close()
  assert.equal(rows.length, result.ticks.length)
  const limited = rows.find((row) => row.reason === 'rate-limit-floor')
  const stopped = rows.find((row) => row.reason === 'stop-switch')
  assert.equal(limited.outcome, 'parked')
  assert.equal(limited.rate_limit_remaining, floor)
  assert.equal(stopped.outcome, 'parked')
  for (const tick of result.ticks) {
    assert.equal(tick.outcome === null || INTAKE_OUTCOMES.includes(tick.outcome), true)
    assert.equal(tick.reason === null || INTAKE_REFUSALS.includes(tick.reason), true)
  }
})

test('intakeLoop delegates eligibility to intakeSweep and never reimplements it', () => {
  const judge = intakeLoop({
    board: { owner: 'example-owner', projectNumber: 7 }, checkout: ROOT,
    config: baseConfig,
    deps: loopDeps([page([issue({ number: 90, body: intakeBody({ where: 'scripts/factory' }) })])]).deps,
    maxTicks: 1,
  })
  assert.equal(judge.ticks[0].run.sweep.refusals[0].reason, 'tier-judge')

  const failedHarness = loopDeps([page([])], {
    onGithub: ({ index }) => { if (index === 0) throw new Error('temporary failure') },
  })
  const failed = intakeLoop({
    board: { owner: 'example-owner', projectNumber: 7 }, checkout: ROOT,
    config: baseConfig, deps: failedHarness.deps, maxTicks: 2,
  })
  assert.equal(failed.ticks.length, 2)
  assert.equal(failed.ticks[0].run.sweep.ok, false)
  assert.equal(failed.ticks[0].failure, 'board-fetch-failed')
  assert.equal(failed.ticks[1].run.sweep.ok, true)
  assert.equal(failedHarness.calls.length, 2)
})

test('intakeLoop refuses an unusable board or configuration before sleeping or fetching', () => {
  let sleeps = 0
  let fetches = 0
  const deps = {
    sleep: () => { sleeps += 1; throw new Error('sleep must not run') },
    github: () => { fetches += 1; throw new Error('github must not run') },
    existsSync: () => { throw new Error('stop switch must not run') },
  }
  const board = intakeLoop({
    board: { owner: '', projectNumber: null }, checkout: ROOT, config: baseConfig, deps, maxTicks: 1,
  })
  assert.deepEqual(board, { ok: false, reason: 'board-config-unusable', ticks: [] })
  const config = intakeLoop({
    board: { owner: 'example-owner', projectNumber: 7 }, checkout: ROOT,
    config: { ...baseConfig, readyColumn: '' }, deps, maxTicks: 1,
  })
  assert.deepEqual(config, {
    ok: false, reason: 'intake-config-unusable', detail: 'readyColumn', ticks: [],
  })
  assert.equal(sleeps, 0)
  assert.equal(fetches, 0)
})
