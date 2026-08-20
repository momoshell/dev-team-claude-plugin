// test/factory-intake.test.mjs — pure selection tests use injected board pages;
// no test reaches the network, and recording tests use explicit temporary db paths.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ROOT } from './helpers.mjs'
import {
  ACTOR_CLAIM_MAX_CHARS, DEFAULT_INTAKE_CONFIG, MAX_SWEEP_TICKS, PREMISE_REFERENCE_CAP,
  REQUIRED_INTAKE_CONFIG_KEYS, SWEEP_USAGE, bodyDigest, compileIntakeBrief,
  dispatchPicked, extractIntakeBlock, extractPremiseReferences, fetchBoard, intakeConfigUsable, intakeLoop,
  intakeRun, intakeSweep, main, normalDeps, parseBoardArgument, renderStartHeader, renderSweepReport,
  sweepCommand, verifyPremise, MIN_SWEEP_INTERVAL_MS, normaliseBoardPage,
  observeDispatches, orderCandidates, repeatEscalationDetail,
} from '../scripts/factory/intake.mjs'
import {
  INTAKE_DISPATCH_OUTCOMES, INTAKE_DISPATCH_VERDICTS, INTAKE_OUTCOMES, INTAKE_REFUSALS,
  LedgerUsageError, PREMISE_VERDICTS, openLedger,
} from '../scripts/factory/ledger.mjs'

const TARGET = 'scripts/factory/intake.mjs'
const UNKNOWN_PREMISE_SYMBOL = ['zzz', 'NotAReal', 'Symbol', 'Here'].join('')
const NOW = Date.parse('2026-01-02T00:00:00.000Z')
const fixture = mkdtempSync(join(tmpdir(), 'factory-intake-'))
after(() => rmSync(fixture, { recursive: true, force: true }))

function dbPath() {
  return join(mkdtempSync(join(tmpdir(), 'factory-intake-')), 'ledger.db')
}

function withLedgerSentinel(fn) {
  const base = mkdtempSync(join(tmpdir(), 'factory-intake-sentinel-'))
  const db = join(base, 'db', 'ledger.db')
  const dir = join(base, 'dir')
  const previousDb = process.env.DEVTEAM_LEDGER_DB
  const previousDir = process.env.DEVTEAM_LEDGER_DIR
  process.env.DEVTEAM_LEDGER_DB = db
  process.env.DEVTEAM_LEDGER_DIR = dir
  try {
    return fn({ db, dir, base })
  } finally {
    if (previousDb === undefined) delete process.env.DEVTEAM_LEDGER_DB
    else process.env.DEVTEAM_LEDGER_DB = previousDb
    if (previousDir === undefined) delete process.env.DEVTEAM_LEDGER_DIR
    else process.env.DEVTEAM_LEDGER_DIR = previousDir
    assert.equal(existsSync(db), false, `ledger sentinel was created: ${db}`)
    assert.equal(existsSync(dir), false, `ledger directory sentinel was created: ${dir}`)
    rmSync(base, { recursive: true, force: true })
  }
}

let callerCheckoutMemo = null
function callerCheckout() {
  if (callerCheckoutMemo) return callerCheckoutMemo
  const root = mkdtempSync(join(fixture, 'caller-checkout-'))
  mkdirSync(join(root, 'lib'), { recursive: true })
  mkdirSync(join(root, 'test'), { recursive: true })
  writeFileSync(join(root, 'lib', 'widget.mjs'), 'export function widgetLoop() { return 1 }\n')
  writeFileSync(join(root, 'test', 'widget.test.mjs'), "import { widgetLoop } from '../lib/widget.mjs'\nwidgetLoop()\n")
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  assert.equal(git('init', '-q').status, 0)
  assert.equal(git('config', 'user.email', 'factory@example.test').status, 0)
  assert.equal(git('config', 'user.name', 'factory-test').status, 0)
  assert.equal(git('add', '-A').status, 0)
  assert.equal(git('-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q', '-m', 'fixture').status, 0)
  callerCheckoutMemo = root
  return root
}

function callerBody() {
  return [
    'ask: Give the shipped `widgetLoop` a caller',
    'where: lib/widget.mjs',
    'done-means: The selected issue is reported',
    'out-of-scope: Dispatching and status changes',
  ].join('\n')
}

function captureStreams(fn) {
  const stdout = []
  const stderr = []
  const realStdoutWrite = process.stdout.write
  const realStderrWrite = process.stderr.write
  process.stdout.write = (chunk) => { stdout.push(String(chunk)); return true }
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true }
  let value
  try {
    value = fn()
  } finally {
    process.stdout.write = realStdoutWrite
    process.stderr.write = realStderrWrite
  }
  return { value, stdout: stdout.join(''), stderr: stderr.join('') }
}

function cliRefusalCases(checkout) {
  const board = 'example-owner/7'
  const actor = 'ops'
  const checkoutFlag = ['--checkout', checkout]
  return [
    ['missing-verb', []],
    ['unknown-verb', ['sweepy']],
    ['unknown-option', ['sweep', '--board', board, '--actor', actor, '--nope', 'x', ...checkoutFlag]],
    ['unknown-option', ['sweep', '--board', board, '--actor', actor, '--record', 'x', ...checkoutFlag]],
    ['unknown-option', ['sweep', '--board', board, '--actor', actor, '--db', 'x', ...checkoutFlag]],
    ['unknown-option', ['sweep', '--board', board, '--actor', actor, '--dispatch', ...checkoutFlag]],
    ['duplicate-flag', ['sweep', '--board', board, '--board', board, '--actor', actor, ...checkoutFlag]],
    ['duplicate-flag', ['sweep', '--board', board, '--actor', actor, '--json', '--json', ...checkoutFlag]],
    ['missing-value', ['sweep', '--board', board, '--actor', ...checkoutFlag]],
    ['unexpected-argument', ['sweep', 'stray', '--board', board, '--actor', actor, ...checkoutFlag]],
    ['missing-checkout', ['sweep', '--board', board, '--actor', actor, '--checkout', join(checkout, 'no-such-dir')]],
    ['board-unusable', ['sweep', '--board', 'owner', '--actor', actor, ...checkoutFlag]],
    ['missing-actor', ['sweep', '--board', board, ...checkoutFlag]],
    ['actor-too-long', ['sweep', '--board', board, '--actor', 'x'.repeat(121), ...checkoutFlag]],
    ['ticks-out-of-range', ['sweep', '--board', board, '--actor', actor, '--ticks', '999', ...checkoutFlag]],
  ]
}

function field(name, value) {
  return { name: value, field: { name } }
}

function issue({
  number, title = `Issue ${number}`, body = null, status = 'Ready', priority = 'P1',
  id = `ITEM-${number}`,
  createdAt = `2025-12-${String(number).padStart(2, '0')}T00:00:00Z`, content = {},
} = {}) {
  const nodes = []
  if (status !== undefined) nodes.push(field('Status', status))
  if (priority !== undefined) nodes.push(field('Priority', priority))
  return {
    id,
    content: {
      number, title, url: `https://example.test/issues/${number}`, body, createdAt, ...content,
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

function ghResponse({ root, project, errors = [], stderr } = {}) {
  const data = {
    user: root === 'user' ? { projectV2: project } : null,
    organization: root === 'organization' ? { projectV2: project } : null,
    rateLimit: { remaining: 900, resetAt: '2026-01-02T01:00:00Z' },
  }
  return {
    status: 1,
    stdout: JSON.stringify({ data, errors }),
    stderr: stderr ?? errors.map((error) => error?.message || '').filter(Boolean).join('\n'),
  }
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

function runOutcome(nodes, { dbPath: path, outcome = 'done', now = NOW, overrides = {} } = {}) {
  const harness = dispatchDeps(nodes, overrides)
  if (outcome === 'escalation') {
    writeFileSync(harness.taskReturn, JSON.stringify({
      status: 'escalation', summary: 'fixture', artifacts: [], details: { escalation: { why: 'same wall' } },
    }))
    harness.deps.crewRun = () => ({
      exit: 3,
      stdout: `${JSON.stringify({ status: 'escalation', task_return: harness.taskReturn })}\n`,
      stderr: '',
    })
  }
  const result = intakeRun({
    board: { owner: 'example-owner', projectNumber: 7 },
    checkout: ROOT,
    dbPath: path ?? null,
    config: baseConfig,
    deps: { ...harness.deps, now: () => now },
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

test('user-owned board accepts the sibling-root error through the real runner', () => {
  const calls = []
  const response = ghResponse({
    root: 'user',
    project: { items: { nodes: [issue({ number: 101 })], pageInfo: { hasNextPage: false, endCursor: null } } },
    errors: [{
      type: 'NOT_FOUND', path: ['organization'],
      message: "Could not resolve to an Organization with the login of 'example-owner'.",
    }],
    stderr: "gh: Could not resolve to an Organization with the login of 'example-owner'.\n",
  })
  const result = fetchBoard({
    board: { owner: 'example-owner', projectNumber: 7 },
    config: { ...baseConfig, pageSize: 5, maxPages: 3 },
    deps: {
      spawnSync: (command, args) => {
        calls.push({ command, args })
        return response
      },
    },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.items.map(({ issue: number }) => number), [101])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'gh')
  assert.deepEqual(calls[0].args.slice(0, 2), ['api', 'graphql'])
  const query = calls[0].args.find((arg) => arg.startsWith('query='))
  assert.match(query, /user\(login:\$owner\)/)
  assert.match(query, /organization\(login:\$owner\)/)
  assert.ok(calls[0].args.includes('owner=example-owner'))
  assert.ok(calls[0].args.includes('number=7'))
  assert.ok(calls[0].args.includes('first=5'))
})

test('organization-owned board accepts the sibling-root error through the real runner', () => {
  const response = ghResponse({
    root: 'organization',
    project: { items: { nodes: [issue({ number: 202 })], pageInfo: { hasNextPage: false, endCursor: null } } },
    errors: [{
      type: 'NOT_FOUND', path: ['user'],
      message: "Could not resolve to a User with the login of 'example-owner'.",
    }],
    stderr: "gh: Could not resolve to a User with the login of 'example-owner'.\n",
  })
  const result = fetchBoard({
    board: { owner: 'example-owner', projectNumber: 7 },
    config: { ...baseConfig, pageSize: 5, maxPages: 3 },
    deps: { spawnSync: () => response },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.items.map(({ issue: number }) => number), [202])
})

test('a missing project fails with a distinct runner verdict instead of an empty board', () => {
  const missing = ghResponse({
    root: 'user', project: null,
    errors: [
      {
        type: 'NOT_FOUND', path: ['organization'],
        message: "Could not resolve to an Organization with the login of 'example-owner'.",
      },
      {
        type: 'NOT_FOUND', path: ['user', 'projectV2'],
        message: 'Could not resolve to a ProjectV2 with the number 7.',
      },
    ],
    stderr: "gh: Could not resolve to an Organization with the login of 'example-owner'.\nCould not resolve to a ProjectV2 with the number 7.\n",
  })
  const transport = { status: 1, stdout: '', stderr: 'gh: could not connect to api.github.com\n' }
  const messageFor = (response) => {
    const deps = normalDeps({ spawnSync: () => response })
    try {
      deps.github({ owner: 'example-owner', projectNumber: 7, first: 5, after: null })
    } catch (err) {
      return String(err?.message || err)
    }
    return null
  }
  const missingMessage = messageFor(missing)
  const transportMessage = messageFor(transport)
  assert.match(missingMessage, /could not resolve project example-owner\/7/)
  assert.doesNotMatch(transportMessage, /could not resolve project example-owner\/7/)

  const result = fetchBoard({
    board: { owner: 'example-owner', projectNumber: 7 },
    config: { ...baseConfig, pageSize: 5, maxPages: 3 },
    deps: { spawnSync: () => missing },
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'board-fetch-failed')
  assert.deepEqual(result.items, [])
})

test('an error touching the resolved root still fails through the real runner', () => {
  const response = ghResponse({
    root: 'user',
    project: { items: { nodes: [issue({ number: 303 })], pageInfo: { hasNextPage: false, endCursor: null } } },
    errors: [{
      type: 'SERVER_ERROR', path: ['user', 'projectV2', 'items'], message: 'items could not be read',
    }],
  })
  const result = fetchBoard({
    board: { owner: 'example-owner', projectNumber: 7 },
    config: { ...baseConfig, pageSize: 5, maxPages: 3 },
    deps: { spawnSync: () => response },
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'board-fetch-failed')
  assert.deepEqual(result.items, [])
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

test('body digests are deterministic and repeat escalation details fail closed', () => {
  assert.equal(bodyDigest(null), null)
  assert.equal(bodyDigest(''), null)
  assert.equal(bodyDigest('same'), bodyDigest('same'))
  assert.notEqual(bodyDigest('same'), bodyDigest('changed'))
  const verdicts = [
    { outcome: 'escalation', task_slug: 'intake-297', created_at: '2026-01-02T01:00:00.000Z', issue_body_digest: bodyDigest('same') },
    { outcome: 'escalation', task_slug: 'intake-297', created_at: '2026-01-02T00:00:00.000Z', issue_body_digest: null },
  ]
  const detail = repeatEscalationDetail({ verdicts, digest: bodyDigest('same') })
  assert.match(detail, /2 consecutive escalations/)
  assert.equal((detail.match(/intake-297/g) || []).length, 2)
  assert.match(detail, /2026-01-02T00:00:00.000Z.*2026-01-02T01:00:00.000Z/)
  assert.ok(detail.length < 400)
  assert.equal(repeatEscalationDetail({ verdicts: verdicts.slice(0, 1), digest: bodyDigest('same') }), null)
  assert.equal(repeatEscalationDetail({ verdicts, digest: bodyDigest('changed') }), null)

  const longDetail = repeatEscalationDetail({
    verdicts: [
      { outcome: 'escalation', task_slug: `second-${'b'.repeat(193)}`, created_at: '2026-01-02T01:00:00.000Z' },
      { outcome: 'escalation', task_slug: `first-${'a'.repeat(194)}`, created_at: '2026-01-02T00:00:00.000Z' },
    ],
  })
  assert.ok(longDetail.length < 400)
  assert.match(longDetail, /first-/)
  assert.match(longDetail, /second-/)
  assert.equal((longDetail.match(/2026-01-02T0[01]:00:00\.000Z/g) || []).length, 2)
})

test('two escalations park a same-body third sweep with dated evidence', () => {
  const path = dbPath()
  const nodes = [issue({ number: 297, body: intakeBody() })]
  const first = runOutcome(nodes, { dbPath: path, outcome: 'escalation', now: Date.parse('2026-01-02T00:00:00.000Z') })
  const second = runOutcome(nodes, { dbPath: path, outcome: 'escalation', now: Date.parse('2026-01-02T01:00:00.000Z') })
  assert.equal(first.result.dispatch.outcome, 'escalation')
  assert.equal(second.result.dispatch.outcome, 'escalation')
  const third = runSweep(nodes, {
    dbPath: path,
    deps: { now: () => Date.parse('2026-01-02T02:00:00.000Z') },
  }).result
  assert.equal(third.picked, null)
  const refusal = third.refusals.find(({ issue: number }) => number === 297)
  assert.equal(refusal.reason, 'repeat-escalation')
  assert.equal((refusal.detail.match(/intake-297/g) || []).length, 2)
  assert.equal((refusal.detail.match(/2026-01-02T0[01]:00:00\.000Z/g) || []).length, 2)
  assert.match(refusal.detail, /2 consecutive escalations/)
})

test('a changed body lifts the repeat escalation park, while metadata bumps do not', () => {
  const path = dbPath()
  const original = intakeBody()
  const nodes = [issue({ number: 298, body: original })]
  runOutcome(nodes, { dbPath: path, outcome: 'escalation', now: Date.parse('2026-01-02T00:00:00.000Z') })
  runOutcome(nodes, { dbPath: path, outcome: 'escalation', now: Date.parse('2026-01-02T01:00:00.000Z') })
  const bumped = runSweep([issue({
    number: 298,
    body: original,
    content: {
      updatedAt: '2026-06-01T00:00:00Z',
      labels: { nodes: [{ name: 'needs-triage' }] },
      comments: { totalCount: 4 },
    },
  })], { dbPath: path }).result
  assert.equal(bumped.picked, null)
  assert.equal(bumped.refusals[0].reason, 'repeat-escalation')
  const changed = runSweep([issue({
    number: 298,
    body: intakeBody({ ask: 'Rescope the issue body before dispatch' }),
  })], { dbPath: path }).result
  assert.equal(changed.picked.issue, 298)
  assert.equal(changed.refusals.some(({ reason }) => reason === 'repeat-escalation'), false)
})

test('an escalation followed by done leaves the issue pickable', () => {
  const path = dbPath()
  const nodes = [issue({ number: 299, body: intakeBody() })]
  runOutcome(nodes, { dbPath: path, outcome: 'escalation', now: Date.parse('2026-01-02T00:00:00.000Z') })
  runOutcome(nodes, { dbPath: path, outcome: 'done', now: Date.parse('2026-01-02T01:00:00.000Z') })
  const next = runSweep(nodes, { dbPath: path }).result
  assert.equal(next.picked.issue, 299)
  assert.equal(next.refusals.some(({ reason }) => reason === 'repeat-escalation'), false)
})

test('hand dispatch still boots after two escalations and digest rows pair by dispatch', () => {
  const path = dbPath()
  const nodes = [issue({ number: 300, body: intakeBody() })]
  const first = runOutcome(nodes, { dbPath: path, outcome: 'escalation', now: Date.parse('2026-01-02T00:00:00.000Z') })
  runOutcome(nodes, { dbPath: path, outcome: 'escalation', now: Date.parse('2026-01-02T01:00:00.000Z') })
  const harness = dispatchDeps(nodes)
  harness.deps.now = () => Date.parse('2026-01-02T02:00:00.000Z')
  const row = dispatchPicked({
    board: { owner: 'example-owner', projectNumber: 7 },
    picked: first.result.sweep.picked,
    sweptAt: '2026-01-02T02:00:00.000Z',
    boardItems: [{ issue: 300, item_id: 'ITEM-300', status: 'Ready' }],
    checkout: ROOT, dbPath: path, config: baseConfig, deps: harness.deps,
  })
  assert.equal(row.outcome, 'done')
  assert.equal(harness.calls.boots.length, 1)
  const ledger = openLedger({ dbPath: path, stderr: { write: () => {} } })
  const rows = ledger.dumpTable('intake_dispatches')
  const hand = rows.filter(({ sweep_at }) => sweep_at === '2026-01-02T02:00:00.000Z')
  assert.equal(hand.every(({ issue_body_digest }) => issue_body_digest === first.result.sweep.picked.body_digest), true)
  ledger.close()
})

test('dispatch rows carry the body digest on claimed and settled steps, and changed bodies differ', () => {
  const path = dbPath()
  const firstBody = intakeBody()
  const secondBody = intakeBody({ ask: 'A genuinely different rescope' })
  const first = runOutcome([issue({ number: 301, body: firstBody })], {
    dbPath: path, outcome: 'escalation', now: Date.parse('2026-01-02T00:00:00.000Z'),
  })
  const second = runOutcome([issue({ number: 301, body: secondBody })], {
    dbPath: path, outcome: 'done', now: Date.parse('2026-01-02T01:00:00.000Z'),
  })
  const ledger = openLedger({ dbPath: path, stderr: { write: () => {} } })
  const rows = ledger.dumpTable('intake_dispatches')
  const firstRows = rows.filter(({ sweep_at }) => sweep_at === first.result.sweep.swept_at)
  const secondRows = rows.filter(({ sweep_at }) => sweep_at === second.result.sweep.swept_at)
  const firstDigest = bodyDigest(firstBody)
  const secondDigest = bodyDigest(secondBody)
  assert.equal(firstRows.find(({ outcome }) => outcome === 'claimed').issue_body_digest, firstDigest)
  assert.equal(firstRows.find(({ outcome }) => outcome === 'escalation').issue_body_digest, firstDigest)
  assert.equal(secondRows.find(({ outcome }) => outcome === 'claimed').issue_body_digest, secondDigest)
  assert.equal(secondRows.find(({ outcome }) => outcome === 'done').issue_body_digest, secondDigest)
  assert.notEqual(firstDigest, secondDigest)
  ledger.close()
})

test('adjudicated dispatch verdicts are a strict subset of dispatch outcomes', () => {
  assert.equal(INTAKE_DISPATCH_VERDICTS.every((outcome) => INTAKE_DISPATCH_OUTCOMES.includes(outcome)), true)
  for (const excluded of ['claimed', 'promoted', 'refused']) assert.equal(INTAKE_DISPATCH_VERDICTS.includes(excluded), false)
})

test('intake source never names updatedAt as rescope evidence', () => {
  const source = readFileSync(join(ROOT, 'scripts/factory/intake.mjs'), 'utf8')
  assert.equal(source.includes('updatedAt'), false)
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
    premise_verdict: 'clean', premise_notes: 'clean 1/1 resolve (paths 1, anchors 0, identifiers 0)',
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
  const promoted = check.dumpTable('intake_dispatches').find(({ outcome }) => outcome === 'promoted')
  assert.equal(promoted.premise_verdict, 'clean')
  assert.equal(promoted.premise_notes, 'clean 1/1 resolve (paths 1, anchors 0, identifiers 0)')
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

test('premise extraction is deterministic, phased, deduplicated and capped', () => {
  const body = [
    'The anchor is scripts/factory/intake.mjs:1-2.',
    'The paths are scripts/factory/intake.mjs and crew/nope.mjs.',
    'The identifiers are `intakeSweep` and `' + UNKNOWN_PREMISE_SYMBOL + '`.',
    'The path repeats scripts/factory/intake.mjs.',
  ].join(' ')
  const first = extractPremiseReferences(body)
  const second = extractPremiseReferences(body)
  assert.deepEqual(first, second)
  assert.deepEqual(first.references.map(({ kind, text }) => ({ kind, text })), [
    { kind: 'anchor', text: 'scripts/factory/intake.mjs:1' },
    { kind: 'path', text: 'scripts/factory/intake.mjs' },
    { kind: 'path', text: 'crew/nope.mjs' },
    { kind: 'identifier', text: 'intakeSweep' },
    { kind: 'identifier', text: UNKNOWN_PREMISE_SYMBOL },
  ])
  assert.equal(new Set(first.references.map(({ text }) => text)).size, first.references.length)

  const many = extractPremiseReferences(Array.from({ length: 60 }, (_, index) => `dir${index}/file${index}.mjs`).join(' '))
  assert.equal(many.references.length, PREMISE_REFERENCE_CAP)
  assert.equal(many.truncated, true)
})

test('premise extraction excludes userinfo URLs and keeps scoped paths', () => {
  assert.deepEqual(extractPremiseReferences('See https://user@host/x.md for context.').references, [])
  assert.deepEqual(extractPremiseReferences('The package is packages/@scope/file.mjs:12.').references, [{
    kind: 'anchor', text: 'packages/@scope/file.mjs:12', path: 'packages/@scope/file.mjs', line: 12,
  }])
})

test('premise verification records an explicit clean result', () => {
  const result = verifyPremise({
    checkout: ROOT,
    body: 'The file is scripts/factory/intake.mjs; its header is scripts/factory/intake.mjs:1 and entry is `intakeSweep`.',
  })
  assert.equal(result.verdict, 'clean')
  assert.deepEqual(result.unresolved, [])
  assert.match(result.notes, /^clean /)
  assert.ok(result.notes.length > 0)
})

test('premise verification catches missing paths, dead anchors and missing grep hits', () => {
  const result = verifyPremise({
    checkout: ROOT,
    body: 'Missing scripts/factory/not-a-real-intake-file.mjs; dead scripts/factory/intake.mjs:999999; symbol `' + UNKNOWN_PREMISE_SYMBOL + '`.',
  })
  assert.equal(result.verdict, 'unresolved')
  assert.match(result.notes, /^unresolved /)
  assert.deepEqual(result.unresolved.map(({ why }) => why).sort(), [
    'dead-anchor', 'missing-path', 'no-grep-hits',
  ])
  for (const named of [
    'scripts/factory/not-a-real-intake-file.mjs',
    'scripts/factory/intake.mjs:999999',
    UNKNOWN_PREMISE_SYMBOL,
  ]) assert.match(result.notes, new RegExp(named.replaceAll('.', '\\.'), 'u'))
})

test('indeterminate premise probes are unknown, never unresolved', () => {
  const spawnUnknown = verifyPremise({
    checkout: ROOT,
    body: '`' + UNKNOWN_PREMISE_SYMBOL + '`',
    deps: { spawnSync: () => ({ error: new Error('EPERM') }) },
  })
  assert.equal(spawnUnknown.verdict, 'unknown')
  assert.match(spawnUnknown.notes, /^unknown /)
  assert.deepEqual(spawnUnknown.unresolved, [])

  const statusUnknown = verifyPremise({
    checkout: ROOT,
    body: '`' + UNKNOWN_PREMISE_SYMBOL + '`',
    deps: { spawnSync: () => ({ status: 128 }) },
  })
  assert.equal(statusUnknown.verdict, 'unknown')
  assert.deepEqual(statusUnknown.unresolved, [])

  const readUnknown = verifyPremise({
    checkout: ROOT,
    body: 'scripts/factory/intake.mjs:1',
    deps: {
      existsSync: () => true,
      readFileSync: () => { throw new Error('EPERM') },
    },
  })
  assert.equal(readUnknown.verdict, 'unknown')
  assert.deepEqual(readUnknown.unresolved, [])
})

test('absolute and parent paths are skipped rather than falsified', () => {
  const result = verifyPremise({
    checkout: ROOT,
    body: `${join(ROOT, 'scripts', 'factory', 'intake.mjs')} ../outside/thing.mjs`,
  })
  assert.equal(result.verdict, 'no-references')
  assert.equal(result.skipped, 2)
  assert.deepEqual(result.unresolved, [])
})

test('a sweep attaches a premise measurement without refusing the candidate', () => {
  const missing = runSweep([issue({
    number: 401,
    body: `${intakeBody()}\nThe stale claim names crew/nope.mjs.`,
  })]).result
  assert.equal(missing.outcome, 'picked')
  assert.equal(missing.picked.premise.verdict, 'unresolved')
  assert.equal(missing.refusals.some(({ reason }) => reason.includes('premise')), false)

  const clean = runSweep([issue({ number: 402, body: intakeBody() })], {
    deps: { existsSync },
  }).result
  assert.equal(clean.outcome, 'picked')
  assert.equal(clean.picked.premise.verdict, 'clean')
})

test('every dispatch step carries the same premise verdict and notes', () => {
  const path = dbPath()
  const unresolvedBody = `${intakeBody()}\nThe stale claim names crew/nope.mjs.`
  const unresolved = runOutcome([issue({ number: 403, body: unresolvedBody })], { dbPath: path })
  const clean = runOutcome([issue({ number: 404, body: intakeBody() })], { dbPath: path })
  const ledger = openLedger({ dbPath: path, stderr: { write: () => {} } })
  const rows = ledger.dumpTable('intake_dispatches')
  ledger.close()

  const unresolvedRows = rows.filter(({ issue }) => issue === 403)
  assert.equal(unresolvedRows.length, 2)
  assert.equal(new Set(unresolvedRows.map(({ premise_verdict }) => premise_verdict)).size, 1)
  assert.equal(unresolvedRows[0].premise_verdict, unresolved.result.sweep.picked.premise.verdict)
  assert.equal(new Set(unresolvedRows.map(({ premise_notes }) => premise_notes)).size, 1)
  assert.equal(unresolvedRows[0].premise_notes, unresolved.result.sweep.picked.premise.notes)

  const cleanRows = rows.filter(({ issue }) => issue === 404)
  assert.equal(cleanRows.length, 2)
  assert.equal(cleanRows.every(({ premise_verdict }) => premise_verdict === 'clean'), true)
  assert.equal(cleanRows.every(({ premise_notes }) => typeof premise_notes === 'string' && premise_notes.length > 0), true)
  assert.equal(clean.result.dispatch.outcome, 'done')
})

test('ledger accepts every premise verdict and refuses unknown verdicts', () => {
  const ledger = openLedger({ dbPath: dbPath(), stderr: { write: () => {} } })
  assert.throws(() => ledger.recordIntakeDispatch({
    board_owner: 'example-owner', board_project: 7, issue: 405, outcome: 'claimed',
    premise_verdict: 'not-a-real-verdict',
  }), (error) => error instanceof LedgerUsageError)
  for (const [index, premise_verdict] of PREMISE_VERDICTS.entries()) {
    assert.doesNotThrow(() => ledger.recordIntakeDispatch({
      board_owner: 'example-owner', board_project: 7, issue: 406 + index, outcome: 'claimed',
      premise_verdict, created_at: `2026-01-02T00:00:0${index}.000Z`,
    }))
  }
  ledger.close()
})

test('premise probing adds no board writes and uses only git grep', () => {
  const harness = dispatchDeps([issue({
    number: 407,
    body: `${intakeBody()}\nThe prose names ${'`'}${UNKNOWN_PREMISE_SYMBOL}${'`'}.`,
  })], {
    deps: { spawnSync: () => ({ status: 1, stdout: '', stderr: '' }) },
  })
  const result = intakeRun({
    board: { owner: 'example-owner', projectNumber: 7 }, checkout: ROOT,
    config: baseConfig, deps: harness.deps,
  })
  assert.equal(result.dispatch.outcome, 'done')
  assert.equal(harness.calls.moves.length, 1)

  const spawned = []
  const premise = verifyPremise({
    checkout: ROOT,
    body: '`' + UNKNOWN_PREMISE_SYMBOL + '`',
    deps: {
      spawnSync: (bin, args) => {
        spawned.push({ bin, args })
        return { status: 1, stdout: '', stderr: '' }
      },
    },
  })
  assert.equal(premise.verdict, 'unresolved')
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].bin, 'git')
  assert.deepEqual(spawned[0].args, ['-C', ROOT, 'grep', '-l', '-F', '-e', UNKNOWN_PREMISE_SYMBOL, '--', '.'])
})

test('the sweep verb runs exactly the ticks it was given and waits the shipped floor between them', () => {
  withLedgerSentinel(() => {
    const harness = loopDeps([page([])])
    const report = sweepCommand({
      board: { owner: 'example-owner', projectNumber: 7 },
      actor: 'ops', checkout: ROOT, config: baseConfig, deps: harness.deps, ticks: 3,
    })
    assert.equal(report.ticks.length, 3)
    assert.equal(harness.calls.length, 3)
    assert.deepEqual(harness.sleeps, [MIN_SWEEP_INTERVAL_MS, MIN_SWEEP_INTERVAL_MS])
  })
})

test('the sweep verb refuses a tick count outside its bound', () => {
  withLedgerSentinel(() => {
    for (const ticks of [0, -1, MAX_SWEEP_TICKS + 1, 'many']) {
      const harness = loopDeps([page([])])
      assert.throws(() => sweepCommand({
        board: { owner: 'example-owner', projectNumber: 7 }, actor: 'ops', checkout: ROOT,
        config: baseConfig, deps: harness.deps, ticks,
      }), (error) => error?.reason === 'ticks-out-of-range')
    }
    const omitted = loopDeps([page([])])
    const report = sweepCommand({
      board: { owner: 'example-owner', projectNumber: 7 }, actor: 'ops', checkout: ROOT,
      config: baseConfig, deps: omitted.deps,
    })
    assert.equal(report.ticks.length, 1)
  })
})

test('the sweep verb is recording only and calls no dispatch dep', () => {
  withLedgerSentinel(() => {
    const checkout = callerCheckout()
    const calls = { branches: 0, moves: 0, boots: 0, runs: 0, prs: 0 }
    const harness = loopDeps([page([issue({ number: 501, body: callerBody() })])], {
      deps: {
        existsSync,
        branchFor: () => { calls.branches += 1; return 'test/branch' },
        boardMove: () => { calls.moves += 1; return { ok: true, status: 'In progress' } },
        crewBoot: () => { calls.boots += 1; return { exit: 0, stdout: '', stderr: '' } },
        crewRun: () => { calls.runs += 1; return { exit: 0, stdout: '', stderr: '' } },
        pullRequestFor: () => { calls.prs += 1; return null },
      },
    })
    const report = sweepCommand({
      board: { owner: 'example-owner', projectNumber: 7 }, actor: 'ops', checkout,
      config: baseConfig, deps: harness.deps, ticks: 1,
    })
    assert.equal(report.mode, 'record-only')
    assert.deepEqual(report.would_dispatch, [501])
    assert.deepEqual(calls, { branches: 0, moves: 0, boots: 0, runs: 0, prs: 0 })
  })
})

test('the sweep verb opens no ledger and writes no file', () => {
  withLedgerSentinel(({ db, dir }) => {
    let writes = 0
    let mkdirs = 0
    const windows = []
    const harness = loopDeps([page([])], {
      deps: {
        writeFileSync: () => { writes += 1 },
        mkdirSync: () => { mkdirs += 1 },
        runsInWindow: (request) => { windows.push(request); return 0 },
      },
    })
    const report = sweepCommand({
      board: { owner: 'example-owner', projectNumber: 7 }, actor: 'ops', checkout: ROOT,
      config: baseConfig, deps: harness.deps, ticks: 1,
    })
    assert.equal(report.ok, true)
    assert.equal(existsSync(db), false)
    assert.equal(existsSync(dir), false)
    assert.equal(writes, 0)
    assert.equal(mkdirs, 0)
    assert.ok(windows.length >= 1)
    assert.equal(windows.every((request) => request.dbPath === null), true)
  })
})

test('the sweep verb reports every refused candidate and an empty Ready column reads differently', () => {
  withLedgerSentinel(() => {
    const refusedHarness = loopDeps([page([issue({ number: 601, body: null })])])
    const refused = sweepCommand({
      board: { owner: 'example-owner', projectNumber: 7 }, actor: 'ops', checkout: ROOT,
      config: baseConfig, deps: refusedHarness.deps, ticks: 1,
    })
    assert.equal(refused.ticks[0].outcome, 'none')
    assert.equal(refused.ticks[0].considered, 1)
    assert.deepEqual(refused.ticks[0].refusals, [
      { issue: 601, reason: 'intake-block-missing', detail: null },
    ])
    const refusedRendered = renderSweepReport(refused)
    assert.equal(refusedRendered.some((line) => /^\s+refused 601: intake-block-missing$/.test(line)), true)
    assert.equal(refusedRendered.some((line) => line.includes('considered=1') && line.includes('refused=1')), true)

    const emptyHarness = loopDeps([page([])])
    const empty = sweepCommand({
      board: { owner: 'example-owner', projectNumber: 7 }, actor: 'ops', checkout: ROOT,
      config: baseConfig, deps: emptyHarness.deps, ticks: 1,
    })
    const emptyRendered = renderSweepReport(empty)
    assert.equal(empty.ticks[0].considered, 0)
    assert.deepEqual(empty.ticks[0].refusals, [])
    assert.equal(emptyRendered.some((line) => line.includes('candidates: none')), true)
    assert.equal(emptyRendered.some((line) => line.includes('refused ')), false)
    assert.equal(refusedRendered.some((line) => line.includes('candidates: none')), false)
  })
})

test('the reported refusals use only the closed vocabulary', () => {
  withLedgerSentinel(() => {
    const harness = loopDeps([page([
      issue({ number: 602, body: intakeBody(), priority: 'P9' }),
      issue({ number: 603, body: 'ask: one\nwhere: x\nout-of-scope: y\ndone-means: z' }),
      issue({ number: 604, body: intakeBody(), priority: 'P0' }),
      issue({ number: 605, body: intakeBody(), priority: 'P1' }),
    ])])
    const report = sweepCommand({
      board: { owner: 'example-owner', projectNumber: 7 }, actor: 'ops', checkout: ROOT,
      config: baseConfig, deps: harness.deps, ticks: 1,
    })
    for (const tick of report.ticks) {
      for (const refusal of tick.refusals) assert.equal(INTAKE_REFUSALS.includes(refusal.reason), true)
      assert.equal(tick.outcome === null || INTAKE_OUTCOMES.includes(tick.outcome), true)
    }
    assert.deepEqual(INTAKE_OUTCOMES, ['picked', 'none', 'parked'])
  })
})

test('reporting refusals still writes nothing', () => {
  withLedgerSentinel(({ db, dir }) => {
    const checkout = callerCheckout()
    const status = () => {
      const result = spawnSync('git', ['-C', checkout, 'status', '--porcelain'], { encoding: 'utf8' })
      assert.equal(result.status, 0)
      return result.stdout
    }
    let writes = 0
    let mkdirs = 0
    const windows = []
    const harness = loopDeps([page([issue({ number: 606, body: null })])], {
      deps: {
        writeFileSync: () => { writes += 1 },
        mkdirSync: () => { mkdirs += 1 },
        runsInWindow: (request) => { windows.push(request); return 0 },
      },
    })
    const before = status()
    const captured = captureStreams(() => main([
      'sweep', '--board', 'example-owner/7', '--actor', 'ops', '--ticks', '1',
      '--checkout', checkout, '--json',
    ], harness.deps))
    const after = status()
    assert.equal(captured.value, 0, captured.stderr)
    assert.equal(after, before)
    assert.equal(existsSync(db), false)
    assert.equal(existsSync(dir), false)
    assert.equal(writes, 0)
    assert.equal(mkdirs, 0)
    assert.equal(windows.length >= 1, true)
    assert.equal(windows.every((request) => request.dbPath === null), true)
    const report = JSON.parse(captured.stdout)
    assert.deepEqual(report.ticks[0].refusals.map((refusal) => refusal.issue), [606])
  })
})

test('the brake halts the next sweep and leaves the sweep in flight alone', () => {
  withLedgerSentinel(() => {
    const between = loopDeps([page([])], {
      onSleep: ({ count, setBrake }) => { if (count === 1) setBrake() },
    })
    const halted = sweepCommand({
      board: { owner: 'example-owner', projectNumber: 7 }, actor: 'ops', checkout: ROOT,
      config: baseConfig, deps: between.deps, ticks: 3,
    })
    assert.equal(halted.stopped, true)
    assert.equal(halted.ticks.length, 2)
    assert.deepEqual(halted.ticks[1], {
      index: 1,
      started_at: halted.ticks[1].started_at,
      swept: false,
      outcome: 'parked',
      reason: 'stop-switch',
      failure: null,
      picked_issue: null,
      considered: 0,
      refusals: [],
    })

    const during = loopDeps([page([])], {
      onGithub: ({ index, setBrake }) => { if (index === 0) setBrake() },
    })
    const inFlight = sweepCommand({
      board: { owner: 'example-owner', projectNumber: 7 }, actor: 'ops', checkout: ROOT,
      config: baseConfig, deps: during.deps, ticks: 2,
    })
    assert.equal(inFlight.ticks[0].swept, true)
    assert.equal(inFlight.ticks[0].outcome, 'none')
    assert.equal(inFlight.ticks[1].swept, false)
    assert.equal(inFlight.ticks[1].reason, 'stop-switch')
  })
})

test('the sweep report and its rendered form name the stop switch that halts it, and say what it did not record', () => {
  withLedgerSentinel(() => {
    let start = null
    const harness = loopDeps([page([])])
    const report = sweepCommand({
      board: { owner: 'example-owner', projectNumber: 7 }, actor: 'ops', checkout: ROOT,
      config: baseConfig, deps: harness.deps, ticks: 1, onStart: (value) => { start = value },
    })
    const stopPath = resolve(ROOT, DEFAULT_INTAKE_CONFIG.stopSwitchPath)
    assert.equal(report.stop_switch.path, stopPath)
    assert.equal(report.durable_record, 'none')
    assert.deepEqual(report.fails_open, ['window-cap', 'repeat-escalation'])
    const rendered = renderSweepReport(report)
    const stopLine = rendered.find((line) => line.startsWith('stop: create '))
    assert.ok(stopLine?.includes(stopPath))
    assert.ok(rendered.some((line) => line.includes('window-cap') && line.includes('repeat-escalation')))
    const header = renderStartHeader(start)
    const brakeLine = header.find((line) => line.startsWith('brake: create '))
    assert.ok(brakeLine?.includes(stopPath))
    assert.ok(header.some((line) => line.includes('window-cap') && line.includes('repeat-escalation')))
    for (const token of ['sweep', '--board', '--actor', '--ticks', '.factory/STOP']) {
      assert.equal(SWEEP_USAGE.includes(token), true)
    }
    for (const token of ['--record', '--db', '--dispatch']) {
      assert.equal(SWEEP_USAGE.includes(token), false)
    }
  })
})

test('every tick the verb reports uses the closed intake vocabulary', () => {
  withLedgerSentinel(() => {
    const harness = loopDeps([page([])], {
      onSleep: ({ count, setBrake }) => { if (count === 1) setBrake() },
    })
    const report = sweepCommand({
      board: { owner: 'example-owner', projectNumber: 7 }, actor: 'ops', checkout: ROOT,
      config: baseConfig, deps: harness.deps, ticks: 3,
    })
    const outcomes = new Set(report.ticks.map((tick) => tick.outcome))
    assert.equal(outcomes.has('none'), true)
    assert.equal(outcomes.has('parked'), true)
    for (const tick of report.ticks) {
      assert.equal(tick.outcome === null || INTAKE_OUTCOMES.includes(tick.outcome), true)
      assert.equal(tick.reason === null || INTAKE_REFUSALS.includes(tick.reason), true)
    }
  })
})

test('the verb reports the actor claim it was given and refuses to invent one', () => {
  withLedgerSentinel(() => {
    let start = null
    const valid = loopDeps([page([])])
    const report = sweepCommand({
      board: { owner: 'example-owner', projectNumber: 7 }, actor: 'ops', checkout: ROOT,
      config: baseConfig, deps: valid.deps, ticks: 1, onStart: (value) => { start = value },
    })
    assert.equal(report.actor, 'ops')
    assert.equal(start.actor, 'ops')
    assert.equal(renderStartHeader(start).join('\n').includes('ops'), true)
    assert.equal(renderSweepReport(report).join('\n').includes('ops'), true)

    for (const [actor, reason] of [
      [undefined, 'missing-actor'], ['', 'missing-actor'], ['   ', 'missing-actor'],
      ['x'.repeat(ACTOR_CLAIM_MAX_CHARS + 1), 'actor-too-long'],
    ]) {
      let writes = 0
      const harness = loopDeps([page([])], {
        deps: { writeFileSync: () => { writes += 1 } },
      })
      assert.throws(() => sweepCommand({
        board: { owner: 'example-owner', projectNumber: 7 }, actor, checkout: ROOT,
        config: baseConfig, deps: harness.deps, ticks: 1,
      }), (error) => error?.reason === reason)
      assert.equal(harness.calls.length, 0)
      assert.equal(harness.sleeps.length, 0)
      assert.equal(writes, 0)
    }
  })
})

test('main refuses every malformed invocation and knows no write-path or dispatch flag', () => {
  withLedgerSentinel(() => {
    const checkout = callerCheckout()
    assert.deepEqual(parseBoardArgument('momoshell/7'), { owner: 'momoshell', projectNumber: 7 })
    for (const token of ['--record', '--db', '--dispatch']) assert.equal(SWEEP_USAGE.includes(token), false)
    for (const [reason, argv] of cliRefusalCases(checkout)) {
      let writes = 0
      let mkdirs = 0
      const harness = loopDeps([page([])], {
        deps: {
          writeFileSync: () => { writes += 1 },
          mkdirSync: () => { mkdirs += 1 },
        },
      })
      const captured = captureStreams(() => main(argv, harness.deps))
      assert.equal(captured.value, 2, `${JSON.stringify(argv)}: ${captured.stderr}`)
      assert.equal(captured.stderr.includes(reason), true, `${JSON.stringify(argv)}: ${captured.stderr}`)
      assert.equal(writes, 0)
      assert.equal(mkdirs, 0)
      assert.equal(harness.calls.length, 0)
    }
  })
})

test('no refusal and no successful run touches the checkout, a ledger, or a branch', () => {
  withLedgerSentinel(({ db, dir }) => {
    const checkout = callerCheckout()
    const status = () => {
      const result = spawnSync('git', ['-C', checkout, 'status', '--porcelain'], { encoding: 'utf8' })
      assert.equal(result.status, 0)
      return result.stdout
    }
    const before = status()
    const run = (argv, nodes = []) => {
      const calls = { writes: 0, mkdirs: 0, dispatch: 0, spawns: [] }
      const harness = loopDeps([page(nodes)], {
        deps: {
          existsSync,
          spawnSync: (bin, args, options) => {
            calls.spawns.push({ bin, args: [...args] })
            return spawnSync(bin, args, options)
          },
          writeFileSync: () => { calls.writes += 1 },
          mkdirSync: () => { calls.mkdirs += 1 },
          branchFor: () => { calls.dispatch += 1; return 'test/branch' },
          boardMove: () => { calls.dispatch += 1; return { ok: true, status: 'In progress' } },
          crewBoot: () => { calls.dispatch += 1; return { exit: 1, stdout: '', stderr: '' } },
          crewRun: () => { calls.dispatch += 1; return { exit: 1, stdout: '', stderr: '' } },
          pullRequestFor: () => { calls.dispatch += 1; return null },
        },
      })
      const captured = captureStreams(() => main(argv, harness.deps))
      return { calls, harness, captured }
    }
    for (const [, argv] of cliRefusalCases(checkout)) {
      const { calls } = run(argv, [issue({ number: 502, body: callerBody() })])
      assert.equal(status(), before)
      assert.equal(existsSync(db), false)
      assert.equal(existsSync(dir), false)
      assert.equal(calls.writes, 0)
      assert.equal(calls.mkdirs, 0)
      assert.equal(calls.dispatch, 0)
      for (const spawn of calls.spawns) {
        assert.equal(spawn.bin, 'git')
        assert.equal(spawn.args.includes('grep'), true)
        for (const forbidden of ['push', 'merge', 'commit', 'worktree', '-b']) {
          assert.equal(spawn.args.includes(forbidden), false)
        }
      }
    }
    const success = run([
      'sweep', '--board', 'example-owner/7', '--actor', 'ops', '--ticks', '1', '--checkout', checkout,
    ], [issue({ number: 503, body: callerBody() })])
    assert.equal(success.captured.value, 0, success.captured.stderr)
    assert.equal(status(), before)
    assert.equal(existsSync(db), false)
    assert.equal(existsSync(dir), false)
    assert.equal(success.calls.writes, 0)
    assert.equal(success.calls.mkdirs, 0)
    assert.equal(success.calls.dispatch, 0)
    assert.ok(success.calls.spawns.length >= 1)
    for (const spawn of success.calls.spawns) {
      assert.equal(spawn.bin, 'git')
      assert.equal(spawn.args.includes('grep'), true)
      for (const forbidden of ['push', 'merge', 'commit', 'worktree', '-b']) {
        assert.equal(spawn.args.includes(forbidden), false)
      }
    }
  })
})

test('a board fetch that throws is a failed attempt, never a park, and the run is not a success', () => {
  withLedgerSentinel(() => {
    const harness = loopDeps([page([])], {
      onGithub: ({ index }) => { if (index === 0) throw new Error('temporary board failure') },
    })
    const report = sweepCommand({
      board: { owner: 'example-owner', projectNumber: 7 }, actor: 'ops', checkout: ROOT,
      config: baseConfig, deps: harness.deps, ticks: 2,
    })
    assert.equal(report.ok, false)
    assert.equal(report.ticks[0].failure, 'board-fetch-failed')
    assert.equal(report.ticks[0].outcome, null)
    assert.equal(INTAKE_REFUSALS.includes(report.ticks[0].reason), false)
    assert.deepEqual(report.failures, [{ index: 0, failure: 'board-fetch-failed' }])
    assert.equal(report.ticks.length, 2)
    assert.equal(harness.calls.length, 2)
  })
})

test('a failed sweep tick does not render an empty Ready column', () => {
  withLedgerSentinel(() => {
    const harness = loopDeps([page([])], {
      onGithub: () => { throw new Error('temporary board failure') },
    })
    const report = sweepCommand({
      board: { owner: 'example-owner', projectNumber: 7 }, actor: 'ops', checkout: ROOT,
      config: baseConfig, deps: harness.deps, ticks: 1,
    })
    assert.equal(report.ticks[0].swept, true)
    assert.equal(report.ticks[0].failure, 'board-fetch-failed')
    assert.equal(report.ticks[0].outcome, null)
    assert.equal(renderSweepReport(report).some((line) => line.includes('candidates: none')), false)
  })
})

test('the CLI route sweeps and prints one JSON document', () => {
  withLedgerSentinel(() => {
    const harness = loopDeps([page([])])
    const captured = captureStreams(() => main([
      'sweep', '--board', 'example-owner/7', '--actor', 'ops', '--ticks', '2', '--checkout', ROOT, '--json',
    ], harness.deps))
    assert.equal(captured.value, 0, captured.stderr)
    assert.equal(harness.calls.length, 2)
    assert.equal(captured.stderr.includes('ops'), true)
    const report = JSON.parse(captured.stdout)
    assert.equal(report.ticks.length, 2)
    assert.equal(report.actor, 'ops')
    assert.equal(report.mode, 'record-only')
    assert.equal(report.durable_record, 'none')
  })
})

test('the start header is emitted before the first sweep', () => {
  withLedgerSentinel(() => {
    let start = null
    let checkedBeforeFetch = false
    const harness = loopDeps([page([])], {
      onGithub: () => { checkedBeforeFetch = start != null },
    })
    const report = sweepCommand({
      board: { owner: 'example-owner', projectNumber: 7 }, actor: 'ops', checkout: ROOT,
      config: baseConfig, deps: harness.deps, ticks: 2, onStart: (value) => { start = value },
    })
    assert.equal(report.ok, true)
    assert.equal(checkedBeforeFetch, true)
    assert.equal(start.actor, 'ops')
    assert.equal(start.stop_switch.path, resolve(ROOT, DEFAULT_INTAKE_CONFIG.stopSwitchPath))
    assert.equal(start.requested_ticks, 2)
    assert.equal(start.mode, 'record-only')
  })
})

test('the recordOnly seam leaves existing library callers alone', () => {
  const nodes = [issue({ number: 504, body: intakeBody() })]
  const defaultHarness = dispatchDeps(nodes)
  const defaultResult = intakeRun({
    board: { owner: 'example-owner', projectNumber: 7 }, checkout: ROOT,
    config: baseConfig, deps: defaultHarness.deps,
  })
  assert.deepEqual(Object.keys(defaultResult), ['sweep', 'dispatch', 'promotions'])
  assert.equal(defaultResult.dispatch.outcome, 'done')
  assert.equal(defaultHarness.calls.branches.length, 1)
  assert.equal(defaultHarness.calls.moves.length, 1)

  const loopHarness = dispatchDeps(nodes)
  const loopResult = intakeLoop({
    board: { owner: 'example-owner', projectNumber: 7 }, checkout: ROOT,
    config: baseConfig, deps: loopHarness.deps, maxTicks: 1,
  })
  assert.equal(loopResult.ticks[0].run.dispatch.outcome, 'done')
  assert.equal(loopHarness.calls.branches.length, 1)
  assert.equal(loopHarness.calls.moves.length, 1)

  const recordingHarness = dispatchDeps(nodes)
  const recordingResult = intakeRun({
    board: { owner: 'example-owner', projectNumber: 7 }, checkout: ROOT,
    config: baseConfig, deps: recordingHarness.deps, recordOnly: true,
  })
  assert.deepEqual(Object.keys(recordingResult), ['sweep', 'dispatch', 'promotions'])
  assert.equal(recordingResult.dispatch, null)
  assert.deepEqual(recordingResult.promotions, [])
  assert.equal(recordingHarness.calls.branches.length, 0)
  assert.equal(recordingHarness.calls.moves.length, 0)
})
