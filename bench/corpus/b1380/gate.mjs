import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Resolve against cwd, never against this artifact's location: proof copies must
// exercise their own production code. All effects of runLoop are virtual below.
const moduleURL = pathToFileURL(resolve(process.cwd(), 'crew/loop.mjs')).href
const green = () => ({ status: 'green', reason: null, code: 0, signal: null, stdout: '', stderr: '', timedOut: false })
const red = (code = 1, reason = 'exit-nonzero') => ({ ...green(), status: 'red', reason, code })
const timeout = () => ({ ...green(), status: 'unmeasured', reason: 'timeout', code: null, timedOut: true })
const PR = { number: 1, url: 'https://example.test/pr/1', state: 'OPEN', headRefName: 'lane', baseRefName: 'main' }
const ids = ['SR1', 'SR2']

async function scenario(sequence) {
  const { runLoop } = await import(moduleURL)
  const calls = [], suiteInputs = [], rows = [], files = new Map()
  const seen = {}
  const spec = {
    id: 'suite-rerun-gate', cwd: '/virtual/repo', taskDir: '/virtual/task', tier: 'build', shape: 'standard',
    brief: 'Check one red-suite re-run', acceptance: ids, source: 'suite re-run gate', branch: 'lane', base: 'main',
    suite: { command: 'virtual-suite', args: ['--full'], timeoutMs: 1800000 }, timeoutMs: 5000,
  }
  const deps = {
    resolveAgents: () => ({ seats: { planner: {}, builder: {}, reviewer: {} } }),
    mkdir: async () => {},
    readFile: async (path) => {
      assert.ok(files.has(path), 'unexpected read outside virtual envelope map')
      return files.get(path)
    },
    journal: async (row) => { rows.push(structuredClone(row)) },
    runSeat: async (request) => {
      calls.push(`seat:${request.role}`)
      const details = request.role === 'planner' ? {
        subject: 'fix(crew): retry one red suite', plan_path: '/virtual/task/plan.md', gate_path: '/virtual/task/gate.mjs',
        acceptance: ids, mutations: ids.map((check) => ({ check, file: 'crew/loop.mjs', find: 'fixture', replace: 'mutant' })),
      } : request.role === 'builder' ? { summary: 'virtual build' } : { verdict: 'pass', findings: [] }
      files.set(request.returnPath, JSON.stringify({ role: request.role, id: request.id, status: 'done', summary: 'virtual seat', details }))
    },
    checkBaseline: async () => ({ accepted: true, reason: 'gate-failed', result: { ...red(1, 'gate-failed'), failingIds: ids } }),
    runGate: async () => ({ ...green(), failingIds: [] }),
    proveMutations: async () => ({ status: 'green', reason: null, rows: ids.map((check) => ({ check, outcome: 'killed', reason: null })) }),
    runSuite: async (input) => {
      calls.push('suite')
      suiteInputs.push(structuredClone(input))
      const next = sequence[suiteInputs.length - 1]
      if (next instanceof Error) throw next
      if (next === undefined) throw new Error('unexpected extra suite invocation')
      return structuredClone(next)
    },
    run: async (input) => {
      assert.equal(input.command, 'git', 'unexpected command seam')
      if (input.args.includes('status')) {
        calls.push(suiteInputs.length ? 'paths' : 'review-paths')
        return { ...green(), stdout: ' M crew/loop.mjs\0' }
      }
      assert.deepEqual(input.args, ['fetch', 'origin'])
      calls.push('fetch')
      return green()
    },
    commitChanges: async (input) => {
      calls.push('commit'); seen.commit = structuredClone(input)
      return { status: 'green', reason: null, head: 'a'.repeat(40) }
    },
    rebaseBranch: async () => {
      calls.push('rebase')
      return { status: 'green', reason: null, head: 'b'.repeat(40) }
    },
    openPullRequest: async (input) => {
      calls.push('publish'); seen.publish = structuredClone(input)
      return { status: 'green', reason: null, pr: PR }
    },
  }
  const outcome = await runLoop(spec, deps)
  return { outcome, calls, suiteInputs, rows, seen }
}

function assertInputs(f, count) {
  assert.equal(f.suiteInputs.length, count, 'wrong suite invocation count')
  for (const input of f.suiteInputs) assert.deepEqual(input, {
    cwd: '/virtual/repo', command: 'virtual-suite', args: ['--full'], timeoutMs: 1800000,
  }, 'both runs must retain the suite command, args and timeout override')
  const checks = f.rows.filter((row) => row.event === 'check' && row.check === 'suite')
  assert.equal(checks.length, count, 'each suite run must be journaled')
}

function assertStopped(f, count, reason) {
  assertInputs(f, count)
  assert.deepEqual(f.outcome, { status: 'stopped', reason, pr: null })
  for (const effect of ['paths', 'commit', 'fetch', 'rebase', 'publish']) {
    assert.ok(!f.calls.includes(effect), `${effect} ran after a failed suite`)
  }
  const verdict = f.rows.findLast((row) => row.event === 'verdict' && row.status === 'stopped')
  assert.equal(verdict?.reason, reason, 'stopped journal reason must agree')
}

async function SR1() {
  const f = await scenario([red(7), green(), red(9)])
  assertInputs(f, 2)
  assert.deepEqual(f.outcome, { status: 'done', reason: null, pr: PR })
  assert.deepEqual(f.calls.filter((call) => ['suite', 'paths', 'commit', 'fetch', 'rebase', 'publish'].includes(call)),
    ['suite', 'suite', 'paths', 'commit', 'fetch', 'rebase', 'publish'])
  assert.equal(f.seen.commit?.body, f.seen.publish?.body, 'commit and PR must carry the same measured body')
  const body = f.seen.publish?.body
  assert.equal(typeof body, 'string', 'no generated PR measurements')
  const measurementSection = body.split('## Measurements\n')[1]
  assert.ok(measurementSection, 'missing measurements section')
  const suiteLines = measurementSection.split('\n').filter((line) => /^- Suite\b/i.test(line))
  assert.equal(suiteLines.length, 2, 'the PR must name both suite runs separately')
  assert.match(suiteLines[0], /\bred\b/)
  assert.match(suiteLines[0], /\bexit\s+7\b/)
  assert.match(suiteLines[1], /\bgreen\b/)
  assert.match(suiteLines[1], /\bexit\s+0\b/)
  assert.match(suiteLines[1], /re-?run|retry|attempt\s*2|run\s*2/i, 'second measurement must identify the re-run')
  const observed = f.rows.filter((row) => row.event === 'check' && row.check === 'suite')
  assert.deepEqual(observed.map((row) => row.result.status), ['red', 'green'])

  const firstGreen = await scenario([green(), red()])
  assertInputs(firstGreen, 1)
  assert.equal(firstGreen.outcome.status, 'done', 'a green suite must not be retried')
  assert.deepEqual(firstGreen.seen.publish.body.split('\n').filter((line) => /^- Suite\b/i.test(line)), ['- Suite: green; exit 0.'])
}

async function SR2() {
  assertStopped(await scenario([red(1), red(2), green()]), 2, 'exit-nonzero')
  // Both reasons are valid closed check reasons. The artificial second reason
  // distinguishes preserving the first result from accidentally using the last.
  assertStopped(await scenario([red(1), red(2, 'gate-failed'), green()]), 2, 'exit-nonzero')

  const unknowns = [
    [timeout(), 'timeout'],
    [new Error('runner crashed'), 'runner-threw'],
    [{ ...green(), code: 4 }, 'runner-threw'],
    [{ ...green(), timedOut: true }, 'runner-threw'],
    [{ status: 'green' }, 'runner-threw'],
  ]
  for (const [unknown, reason] of unknowns) {
    assertStopped(await scenario([unknown, green()]), 1, reason)
    assertStopped(await scenario([red(), unknown, green()]), 2, reason)
  }
}

let failed = 0
for (const [id, check] of Object.entries({ SR1, SR2 })) {
  try { await check() } catch (error) {
    failed++
    const message = String(error?.message ?? error).replace(/[\r\n\x00-\x1f\x7f]+/g, ' ').slice(0, 600)
    console.log(`FAIL ${id}: ${message}`)
  }
}
process.exitCode = failed ? 1 : 0
