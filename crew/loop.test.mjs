import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { projectHash } from './onboard.mjs'
import { git as repoGit, gitResult, scratchDir } from '../test/helpers.mjs'
import { decideFinish, FinishRefusal, finishLane } from './finish.mjs'
import { LOOP_REASONS, runLoop } from './loop.mjs'
import { resolveAgents } from './agents.mjs'
import { composeLanePrBody, runSuite } from './checks.mjs'
import { stateless } from './lean-journal-order.mjs'

const PR = { number: 73, url: 'https://example.test/pr/73', state: 'OPEN', headRefName: 'lane', baseRefName: 'main' }
const finding = { id: 'R1', severity: 'must-fix', location: 'lib.mjs:1', summary: 'Fix the defect', trigger: 'bad input' }
const green = () => ({ status: 'green', reason: null, code: 0, signal: null, stdout: '', stderr: '', timedOut: false })
const MUTATION = { check: 'A1', file: 'lib.mjs', find: 'old', replace: 'new' }

test('non-green proof checks name their full captured output artifact (#2410)', async () => {
  const taskDir = scratchDir('loop-proof-output-')
  const proofTimeoutMs = 5_000
  for (const mode of ['repair', 'rebase', 'unmeasured', 'all-timeout']) {
    const allTimeout = mode === 'all-timeout'
    const rows = allTimeout ? [{ file: 'lib.test.mjs', title: 'works', proven: false, reason: 'timeout',
      base: { state: null, reason: 'timeout' }, build: { state: null, reason: 'not-run' } }] : []
    const failed = { status: mode === 'unmeasured' ? 'unmeasured' : 'red', reason: mode === 'unmeasured' ? 'timeout' : 'proof-unproven', rows,
      stdout: `proof first stdout ${mode}\n${'x'.repeat(5000)}`, stderr: `proof first stderr ${mode}\n${'e'.repeat(5000)}` }
    const proven = { status: 'green', reason: null, rows: [{ file: 'lib.test.mjs', title: 'works', proven: true }] }
    const options = { spec: { taskDir, ...(allTimeout ? { proofTimeoutMs } : {}), ...(mode === 'rebase' ? { tier: 'mechanical' } : {}) }, proof: mode === 'repair' ? answers(failed, failed, proven) : mode === 'rebase' ? answers(proven, failed) : failed,
      deps: { writeFile: async (...args) => writeFileSync(...args) } }
    const f = mode === 'rebase' ? moved(options) : fakes(options)
    const outcome = await f.go()
    if (allTimeout) assert.deepEqual(outcome, stopped('proof-timeout'))
    const checks = f.rows.filter((r) => r.event === 'check' && r.check === 'proof' && r.result.status !== 'green')
    assert.equal(checks.length, mode === 'repair' ? 2 : 1)
    for (const row of checks) {
      assert.equal(typeof row.outputFile, 'string')
      assert.deepEqual(JSON.parse(readFileSync(join(taskDir, row.outputFile), 'utf8')), { stdout: failed.stdout, stderr: failed.stderr })
    }
    assert.equal(new Set(checks.map((r) => r.outputFile)).size, checks.length)
    if (mode !== 'repair') {
      const stopped = f.rows.findLast((r) => r.event === 'verdict' && r.status === 'stopped')
      assert.equal(stopped.reason, allTimeout ? 'proof-timeout' : failed.reason)
      assert.deepEqual(stopped.observation, checks.at(-1).result)
      if (allTimeout) {
        assert.equal(stopped.observation.status, 'unmeasured')
        assert.deepEqual(stopped.observation.rows, rows)
        assert.equal(stopped.observation.proofTimeoutMs, proofTimeoutMs)
        assert.equal(f.seen.proof.timeoutMs, proofTimeoutMs)
        assert.deepEqual(f.calls.slice(f.calls.indexOf('proof') + 1).filter((call) => call === 'seat:builder' || call === 'seat:lead'), [])
      }
      for (const stream of ['stdout', 'stderr']) {
        assert.equal(stopped.observation[stream], failed[stream].slice(-4096))
        assert.equal(stopped.observation[`${stream}Bytes`], Buffer.byteLength(failed[stream]))
      }
    }
  }
})

test('failed output writes are reported without changing suite or proof routing (#2410)', async () => {
  for (const check of ['suite', 'proof']) for (const status of ['red', 'unmeasured']) for (const failure of ['sync', 'reject']) {
    const make = () => {
      const failed = { ...green(), status, reason: status === 'unmeasured' ? 'timeout' : check === 'suite' ? 'exit-nonzero' : 'proof-unproven', code: 1, rows: [], stdout: 'diagnostic' }
      return check === 'suite' ? sequenced([failed, green()]) : fakes({ proof: answers(failed, { status: 'green', reason: null, rows: [{ file: 'lib.test.mjs', title: 'works', proven: true }] }) })
    }
    const baseline = make(), f = make(), write = f.deps.writeFile
    f.deps.writeFile = (path, ...args) => {
      if (!path.includes(`check-${check}-`)) return write(path, ...args)
      const error = Object.assign(new Error('output denied'), { code: 'EACCES' })
      if (failure === 'sync') throw error
      return Promise.reject(error)
    }
    assert.deepEqual(await f.go(), await baseline.go())
    assert.deepEqual(f.calls, baseline.calls)
    assert.deepEqual(f.requests, baseline.requests)
    const row = f.rows.find((r) => r.event === 'check' && r.check === check)
    assert.equal(row.outputFile, null)
    assert.deepEqual(row.outputError, { code: 'EACCES', message: 'output denied' })
    assert.deepEqual(row.result, baseline.rows.find((r) => r.event === 'check' && r.check === check).result)
  }
})

test('suite and proof check rows measure elapsed seconds without failing on bad clocks (#2410)', async () => {
  for (const check of ['suite', 'proof']) for (const status of ['green', 'red', 'unmeasured', 'throw']) for (const clock of ['good', 'throw', 'nan', 'infinite', 'backwards']) {
    let time = 10_000
    const result = { ...green(), status, reason: status === 'green' ? null : status === 'red' ? check === 'suite' ? 'exit-nonzero' : 'proof-unproven' : 'timeout', rows: [] }
    const f = fakes({ [check]: result, ...(status === 'throw' ? { throwCheck: check } : {}), deps: { now: () => {
      if (clock === 'throw') throw new Error('bad clock')
      return clock === 'nan' ? NaN : clock === 'infinite' ? Infinity : time
    } } })
    const key = check === 'suite' ? 'runSuite' : 'proveTests', run = f.deps[key], write = f.deps.writeFile
    f.deps[key] = async (input) => { try { return await run(input) } finally { time += clock === 'backwards' ? -2500 : 2500 } }
    f.deps.writeFile = async (...args) => { time += 50_000; return write(...args) }
    await f.go()
    const row = f.rows.find((r) => r.event === 'check' && r.check === check)
    assert.ok(row, `${check} ${status} ${clock}`)
    assert.equal(row.seconds, clock === 'good' ? 2.5 : null)
    if (clock === 'good') assert.equal(Object.hasOwn(row, 'secondsReason'), false)
    else assert.equal(row.secondsReason, 'clock-unmeasured')
    assert.equal(row.result.status, status === 'throw' ? 'unmeasured' : status)
  }
})

// MUTATION: stop instead of bouncing an accept with no envelope.
test('a lead accept on a spent bound with nothing to accept is a bounce to that seat (b1487)', async () => {
  const A = 'a'.repeat(40), C = 'c'.repeat(40)
  const f = sequenced([green(), redRun(), green()], { bounds: { reviewer: 1 }, lead: 'accept',
    checkedTree: () => ({ ...green(), stdout: String(f.calls.filter((c) => c === 'seat:builder' || c === 'uncommit').length).repeat(40) }),
    rebase: answers({ ...MOVED, head: A }, { ...MOVED, onto: O }, { ...MOVED, head: C }),
    commit: answers({ status: 'green', reason: null, head: A, files: ['lib.mjs'] }, { status: 'green', reason: null, head: C, files: ['lib.mjs'] }) })
  assert.equal((await f.go()).status, 'done')
  assert.deepEqual(f.requests.map((r) => r.role), ['planner', 'builder', 'reviewer', 'reviewer', 'builder', 'lead', 'reviewer'])
  assert.deepEqual(f.requests.find((r) => r.role === 'lead').feedback[0].reason, 'round-bound')
  assert.ok(f.seen.publish)
})

// Every effect is a recorded call; nothing touches a model, git, gh, the network or the disk.
// A seat "returns" by writing its envelope into a virtual file the loop then reads back.
function fakes(options = {}) {
  const calls = [], rows = [], requests = [], tiers = [], seen = {}, returns = new Map(), writes = new Map()
  let reviewTurns = 0, secondTurns = 0, reviewReads = 0, baseOid = 'c'.repeat(40)
  const discardArgs = []
  const spec = {
    id: 'lane', cwd: '/virtual/checkout', taskDir: '/virtual/task', tier: 'build', shape: 'standard', brief: '## The ask\nBuild the lane.',
    source: 'issue 12', branch: 'lane', base: 'main', closes: [12],
    suite: { command: 'node', args: ['--test', 'lane.test.mjs'] }, ...options.spec,
  }
  const envelope = (request) => ({
    role: request.role, id: request.id, status: 'done', summary: 'fixture',
    details: request.role === 'planner' ? { subject: 'fix(crew): planned lane', plan_path: join(spec.taskDir, 'plan.md'), tests: [{ file: 'lib.test.mjs', title: 'works' }], files_in_scope: ['lib.mjs'] }
      : request.role === 'builder' ? { summary: 'built', tests: [{ file: 'lib.test.mjs', title: 'works' }] }
      : request.role === 'lead' ? { decision: options.lead ?? 'escalate', ...((options.lead ?? 'escalate') === 'escalate' ? { question: 'Which way should the lane go?' } : options.lead === 'bounce' ? { target: options.target ?? 'builder' } : {}) }
      : (() => {
          const second = request.role === 'tech-lead'
          const turns = second ? ++secondTurns : ++reviewTurns
          const changes = turns <= (second ? options.secondReview ?? 0 : options.review ?? 0)
          const current = second ? { ...finding, id: 'T1' } : finding
          return { verdict: changes ? 'changes-needed' : 'pass', findings: changes ? [current] : [], requirements: [{ requirement: 'build', status: 'met', evidence: 'read' }], failure_modes: [], coverage: { read: ['lib.mjs'], complete: true }, closed: request.feedback.filter((f) => f.id && !(changes && f.id === current.id)).map((f) => ({ id: f.id, evidence: 'fixed' })) }
        })(),
  })
  const measured = (name, result) => async (input) => {
    calls.push(name); seen[name] = structuredClone(input)
    if (options.throwCheck === name) throw Object.assign(new Error('denied'), { code: 'EPERM' })
    return typeof result === 'function' ? result(input) : structuredClone(result)
  }
  const deps = {
    resolveAgents: (tier) => { tiers.push(tier); if (tier === 'judge' && options.throwJudge) throw new Error('judge unavailable'); const roles = ['planner', 'builder', 'reviewer', 'lead', ...(tier === 'judge' ? ['tech-lead'] : [])].filter((role) => !(spec.tier === 'mechanical' && tier !== 'mechanical' ? [] : options.unseated ?? []).includes(role)); return { seats: Object.fromEntries(roles.map((role) => [role, { agent: 'pi', provider: 'test', id: role, effort: tier === 'judge' ? 'xhigh' : 'high', ...(options.bounds?.[role] ? { rounds: options.bounds[role] } : {}) }])), advisor: null } },
    mkdir: async (path, opts) => { calls.push('mkdir'); seen.mkdir = [path, opts] },
    readFile: async (path) => {
      if (options.readError) throw Object.assign(new Error('denied'), { code: options.readError })
      return path === join(spec.taskDir, 'plan.md') ? options.plan ?? '' : returns.get(path) ?? ''
    },
    // the planner's two artifacts exist as virtual regular files inside the virtual task dir
    stat: async (path) => {
      if (path !== join(spec.taskDir, 'plan.md')) throw Object.assign(new Error(`no ${path}`), { code: 'ENOENT' })
      return { isFile: () => true }
    },
    lstat: async () => ({ isSymbolicLink: () => false }),
    realpath: async (path) => path,
    writeFile: async (path, content) => { if (options.writeError) throw Object.assign(new Error('denied'), { code: options.writeError }); writes.set(path, String(content)) },
    journal: options.journal ?? (async (row) => { rows.push(structuredClone(row)) }),
    now: () => 0,
    runSeat: async (request) => {
      calls.push(`seat:${request.role}`); requests.push(structuredClone(request))
      if (requests.length > 24) throw new Error('fixture turn safety bound')
      if (options.seatThrows === request.role) throw new Error('seat crashed')
      if (options.seatRejects === request.role) return Promise.reject(new Error('seat rejected'))
      let value = envelope(request)
      if (options.edit) value = options.edit(value, request) ?? value
      returns.set(request.returnPath, typeof value === 'string' ? value : JSON.stringify(value))
      const recorded = options.recording?.(request)
      if (!recorded) return undefined
      return { definition: recorded.definition, recorded: recorded.rows ? recorded.rows.map((r) => JSON.stringify(r)).join('\n') : null }
    },
    proveTests: measured('proof', options.proof ?? { status: 'green', reason: null, rows: [{ file: 'lib.test.mjs', title: 'works', proven: true }] }),
    runSuite: measured('suite', options.suite ?? green()),
    commitChanges: (input) => ['wip: crew finish base', 'wip: crew pre-check base'].includes(input.subject)
      ? measured('base-commit', { status: 'green', reason: null, head: 'a'.repeat(40), files: input.files })(input)
      : measured('commit', options.commit ?? { status: 'green', reason: null, head: 'a'.repeat(40), files: ['lib.mjs'] })(input),
    // Keep the pre-proof status probes separate from the scripted review and commit paths.
    run: (input) => input.args.includes('reset') && input.args.includes('--soft') ? (discardArgs.push(input.args), measured(spec.shape === 'finish' && !calls.includes('seat:builder') ? 'base-restore' : 'uncommit', green())(input))
      : input.args.includes('reset') || input.args.includes('clean') ? (discardArgs.push(input.args), measured('discard', options.discard ?? green())(input))
      : input.args.includes('add') ? measured('suite-stage', options.stageResult ?? green())(input)
      : input.args.includes('write-tree') ? measured('checked-tree', options.checkedTree ?? { ...green(), stdout: `${'e'.repeat(40)}\n` })(input)
      : input.args.includes('--no-ext-diff') ? Promise.resolve({ ...green(), stdout: 'lib.mjs\0' })
      : input.args.includes('diff') ? measured('published-paths', options.publishedPaths ?? { ...green(), stdout: 'lib.mjs\0' })(input)
      : input.args.includes('rev-parse') && input.args.at(-1) === `refs/remotes/origin/${spec.base}` ? measured('check-base', options.checkBase ?? { ...green(), stdout: `${baseOid}\n` })(input)
      : input.args.includes('rev-parse') ? measured('post-rebase-head', () => ({ ...green(), stdout: options.cleanHead ?? `${(options.rebase ?? {}).head ?? 'a'.repeat(40)}\n` }))(input)
      : input.args.includes('status') && spec.shape === 'finish' && !calls.includes('rebase') ? measured('base-paths', { ...green(), stdout: ' M lib.mjs\0' })(input)
      : input.args.includes('status') && calls.at(-1) === 'seat:builder' ? measured('build-paths', { ...green(), stdout: ' M lib.mjs\0' })(input)
      : input.args.includes('status') && calls.includes('commit') && calls.lastIndexOf('rebase') > calls.lastIndexOf('uncommit') ? measured('post-rebase-clean', () => ({ ...green(), stdout: options.cleanStatus ?? '' }))(input)
      : input.args.includes('status')
      ? (['suite', 'seat:reviewer', 'seat:tech-lead'].includes(calls.at(-1))
        ? measured('paths', options.pathsResult ?? (() => ({ ...green(), stdout: options.paths ?? 'M  lib.mjs\0' })))
        : measured('review-paths', options.reviewResult ?? (() => ({ ...green(), stdout: [options.reviewPaths].flat()[Math.min(reviewReads++, [options.reviewPaths].flat().length - 1)] ?? ' M lib.mjs\0' }))))(input)
      : input.args.includes('rm') ? measured('base-unstage', green())(input)
      : input.args[0] === 'fetch' ? measured('fetch', options.fetch ?? green())(input)
      : input.args[0] === 'rebase' && input.args[1] === '--abort' ? measured('conflict-undo', green())(input)
      : Promise.reject(new Error(`unexpected git command: ${input.args}`)),
    rebaseBranch: async (input) => {
      const result = await measured('rebase', options.rebase ?? { status: 'green', reason: null, head: 'a'.repeat(40), onto: 'c'.repeat(40) })(input)
      if (result.status === 'green') baseOid = result.onto
      return result
    },
    openPullRequest: measured('publish', options.publish ?? { status: 'green', reason: null, pr: PR }),
    ...options.deps,
  }
  return { spec, deps, calls, rows, requests, tiers, seen, writes, discardArgs, go: () => runLoop(spec, deps) }
}
test('every seat turn journals one seat-turn row whose unmeasured values are null with one closed reason (#2287)', async () => {
  for (const reject of [false, true]) {
    let state = 0
    const issued = [], rows = []
    const f = fakes({ deps: { repoState: () => String(state++), journal: async (row) => {
      if (reject && row.event === 'seat-turn') throw new Error('journal denied')
      rows.push(row)
    } } })
    const run = f.deps.runSeat
    f.deps.runSeat = async (request) => {
      issued.push(request)
      if (request.role === 'planner' && !request.rerun) throw new Error('turn failed')
      await run(request)
      if (request.role === 'builder') return { definition: { agent: 'pi', model: 'local/model', effort: 'high', writes: 'repo' }, recorded: null, toolCalls: 3, stopReason: 'end_turn', usage: { inputTokens: 12 } }
      if (request.role === 'reviewer') return { definition: { agent: 7 }, toolCalls: -1, usage: 'x' }
    }
    assert.equal((await f.go()).status, 'done')
    if (reject) continue
    const turns = rows.filter((row) => row.event === 'seat-turn')
    assert.deepEqual(turns.map(({ role, id }) => ({ role, id })), issued.map(({ role, id }) => ({ role, id })))
    for (const turn of turns) {
      const index = rows.indexOf(turn)
      assert.equal(rows.slice(index + 1).find((row) => row.event === 'envelope' && row.id === turn.id)?.role, turn.role)
    }
    const [failed, planner, builder, reviewer] = turns
    assert.deepEqual(Object.fromEntries(['agent', 'model', 'effort', 'tool_calls', 'stop_reason', 'usage', 'seconds', 'status', 'worktree_changed', 'unmeasured'].map((key) => [key, builder[key]])), {
      agent: 'pi', model: 'local/model', effort: 'high', tool_calls: 3, stop_reason: 'end_turn', usage: { inputTokens: 12 }, seconds: 0, status: 'done', worktree_changed: true, unmeasured: {},
    })
    for (const [row, reason] of [[failed, 'turn-failed'], [planner, 'not-reported'], [reviewer, 'not-reported']]) {
      for (const field of ['agent', 'model', 'effort', 'tool_calls', 'stop_reason', 'usage']) {
        assert.equal(row[field], null, field)
        assert.equal(row.unmeasured[field], reason, field)
      }
      assert.equal(row.worktree_changed, null)
      assert.equal(row.unmeasured.worktree_changed, 'not-repo-seat')
    }
    assert.equal(failed.status, null)
    assert.equal(failed.unmeasured.status, 'no-return')
    assert.equal(planner.status, 'done')
  }
  for (const mode of ['throws', 'nonfinite']) {
    const f = fakes({ deps: { repoState: () => null, now: () => { if (mode === 'throws') throw new Error('clock'); return Infinity } } })
    assert.equal((await f.go()).status, 'done')
    const row = f.rows.find((item) => item.event === 'seat-turn' && item.role === 'builder')
    assert.equal(row.seconds, null)
    assert.equal(row.unmeasured.seconds, 'clock-unmeasured')
    assert.equal(row.worktree_changed, null)
    assert.equal(row.unmeasured.worktree_changed, 'worktree-unmeasured')
  }
  let state = 0, clock = 0
  const repaired = fakes({ deps: { repoState: () => String(state++), now: () => clock++ }, edit: (value, request) => request.role === 'builder' && !request.repair ? { ...value, status: 'invalid' } : value })
  assert.equal((await repaired.go()).status, 'done')
  const builderRows = repaired.rows.filter((row) => row.event === 'seat-turn' && row.role === 'builder')
  assert.equal(builderRows.length, 2)
  assert.deepEqual(builderRows.map((row) => [row.status, row.worktree_changed, row.seconds]), [[null, true, 0.001], ['done', true, 0.001]])
  assert.equal(builderRows[0].unmeasured.status, 'no-return')
  const getter = fakes()
  const run = getter.deps.runSeat
  getter.deps.runSeat = async (request) => { await run(request); return { get toolCalls() { throw new Error('bad recording') } } }
  assert.equal((await getter.go()).status, 'done')
})

test('a tier raise and a finish run seat the roster recorded at start', async () => {
  const path = join(scratchDir('roster-loop-'), 'agents.json')
  writeFileSync(path, JSON.stringify({ builder: { model: 'local/recorded' } }))
  const roster = { overrides: { builder: { model: 'local/recorded', tiers: { judge: { model: 'local/raised' } } } }, files: [{ layer: 'project', path, sha256: 'a'.repeat(64) }] }
  writeFileSync(path, JSON.stringify({ builder: { model: 'local/changed' } }))
  for (const finish of [false, true]) {
    const f = fakes({ spec: { ...(finish ? finishSpec({ filesInScope: ['crew/loop.mjs'] }) : {}), roster }, edit: (v) => { if (v.role === 'planner') v.details.files_in_scope = ['crew/loop.mjs']; return v } })
    f.deps.resolveAgents = resolveAgents
    await f.go()
    assert.equal(f.requests.find((r) => r.role === 'builder').seat.id, 'raised')
    assert.ok(f.rows.some((row) => row.event === 'tier-raised'))
    assert.equal(f.rows.filter((row) => row.event === 'roster').length, finish ? 0 : 1)
  }
  const dir = scratchDir('roster-plugin-')
  cpSync(fileURLToPath(new URL('./agents/', import.meta.url)), dir, { recursive: true })
  const tiers = ['mechanical', 'build', 'judge']
  const original = Object.fromEntries(tiers.map((tier) => [tier, resolveAgents(tier, dir)]))
  const snapshot = Object.fromEntries(['lead', 'planner', 'builder', 'reviewer', 'tech-lead'].map((role) => {
    const cell = (tier) => {
      const seat = original[tier].seats[role]
      return seat ? { agent: seat.agent, model: `${seat.provider}/${seat.id}`, effort: seat.effort, advisor: role === 'builder' && original[tier].advisor ? { agent: original[tier].advisor.agent, model: `${original[tier].advisor.provider}/${original[tier].advisor.id}`, effort: original[tier].advisor.effort } : null } : null
    }
    return [role, { ...(cell('build') ?? cell('judge')), tiers: Object.fromEntries(tiers.map((tier) => [tier, cell(tier)])) }]
  }))
  const builder = join(dir, 'builder.md')
  writeFileSync(builder, readFileSync(builder, 'utf8').replace('model: openai/gpt-6.1-terra', 'model: local/changed').replace('"judge":{"effort":"xhigh"}', '"judge":null'))
  for (const finish of [false, true]) {
    const f = fakes({ spec: { ...(finish ? finishSpec({ filesInScope: ['crew/loop.mjs'] }) : {}), roster: { overrides: {}, files: [], snapshot } }, edit: (v) => { if (v.role === 'planner') v.details.files_in_scope = ['crew/loop.mjs']; return v } })
    f.deps.resolveAgents = (tier, _, overrides) => resolveAgents(tier, dir, overrides)
    await f.go()
    assert.equal(f.requests.find((r) => r.role === 'builder').seat.id, original.judge.seats.builder.id)
    assert.equal(f.rows.find((r) => r.event === 'tier-raised').seats.builder.effort, original.judge.seats.builder.effort)
  }
  for (const roster of [null, {}, { overrides: { ghost: {} }, files: [] }, { overrides: {}, files: [{}] }, { overrides: {}, files: [], snapshot: {} }]) {
    const f = fakes({ spec: { roster } })
    assert.equal((await f.go()).reason, 'invalid-input')
  }
})

test('every rebase the loop runs carries the spec generated declaration, none when the spec has none, and a malformed declaration is refused', async () => {
  const generated = { paths: ['dist/'], command: 'npm', args: ['run', 'generate'], timeoutMs: 1800000 }
  for (const shape of ['standard', 'finish', 'mechanical']) for (const declared of [true, false]) {
    const inputs = []
    const f = fakes({ spec: { ...(shape === 'finish' ? finishSpec() : shape === 'mechanical' ? { tier: 'mechanical' } : {}), ...(declared ? { generated } : {}) }, edit: (v) => { if (shape === 'mechanical' && v.role === 'builder') v.details.subject = 'fix: generated'; return v } })
    const rebase = f.deps.rebaseBranch
    f.deps.rebaseBranch = (input) => { inputs.push(input); return rebase(input) }
    assert.equal((await f.go()).status, 'done')
    assert.equal(inputs.length, 2)
    for (const input of inputs) {
      assert.equal(Object.hasOwn(input, 'generated'), declared)
      if (declared) assert.deepEqual(input.generated, generated)
    }
  }
  for (const bad of [null, {}, { ...generated, paths: ['../bad'] }, { ...generated, args: [1] }]) {
    const f = fakes({ spec: { generated: bad } })
    assert.equal((await f.go()).reason, 'invalid-input')
    assert.deepEqual(f.calls, [])
  }
})

test('a mechanical lane discards its build and restarts from planning: as judge on a protected path, as build on a builder insufficient', async () => {
  for (const mode of ['path', 'project-path', 'insufficient', 'discard-reset', 'discard-clean']) {
    let builds = 0
    const project = mode === 'project-path'
    const paths = project ? ['migrations/0007.sql', 'config/billing.toml'] : mode === 'insufficient' ? null : ['crew/loop.mjs']
    const f = fakes({ spec: { tier: 'mechanical', ...(project ? { protectedPaths: ['migrations/', 'config/billing.toml'] } : {}) }, unseated: ['planner', 'reviewer', 'lead'], bounds: { builder: 1 },
      reviewPaths: paths ? [paths.map((path) => ` M ${path}\0`).join('') + (project ? ' M config/billing.toml.bak\0' : ''), ' M lib.mjs\0'] : undefined,
      discard: mode.startsWith('discard-') ? (input) => input.args.includes(mode.slice(8)) ? { ...green(), status: 'red', reason: 'exit-nonzero', code: 1 } : green() : undefined,
      edit: (v) => {
        if (v.role === 'builder') { builds++; if (builds === 1 && mode === 'insufficient') v.status = 'insufficient'; else if (builds === 1) v.details.subject = 'docs(crew): fix typo' }
        return v
      },
    })
    const result = await f.go()
    if (mode.startsWith('discard-')) { assert.equal(result.reason, 'exit-nonzero'); assert.equal(f.requests.some((r) => r.role === 'planner'), false); continue }
    const row = f.rows.find((r) => r.event === 'tier-raised')
    assert.ok(row, `${mode}: expected mechanical restart`)
    assert.equal(result.status, 'done', mode)
    assert.deepEqual(f.discardArgs, [['reset', '--hard', 'a'.repeat(40)], ['clean', '-f', '-d']])
    assert.ok(f.calls.lastIndexOf('discard') < f.calls.indexOf('seat:planner'))
    assert.deepEqual(f.requests.map((r) => r.role), paths ? ['builder', 'planner', 'builder', 'reviewer', 'tech-lead'] : ['builder', 'planner', 'builder', 'reviewer'])
    assert.deepEqual([row.from, row.to, row.reason], ['mechanical', paths ? 'judge' : 'build', paths ? 'protected-path' : 'builder-insufficient'])
    const planner = f.requests.find((r) => r.role === 'planner')
    assert.equal(planner.feedback[0].id, 'mechanical-restart')
    assert.equal(planner.feedback[0].reason, row.reason)
    if (paths) {
      assert.deepEqual(row.paths, paths)
      assert.deepEqual(planner.feedback[0].paths, paths)
    } else assert.equal(planner.feedback[0].envelope.status, 'insufficient')
    assert.deepEqual(f.requests.filter((r) => r.role === 'builder')[1].feedback, [])
    assert.equal(f.requests.filter((r) => r.role === 'builder')[1].tier, row.to)
  }
  let builds = 0
  const repair = sequenced([redRun(), green()], { spec: { tier: 'mechanical' }, lead: 'bounce', target: 'planner', edit: (v) => {
    if (v.role === 'builder') {
      builds++
      if (builds === 1) v.details.subject = 'docs(crew): fix typo'
      if (builds === 2 || builds === 3) { v.status = 'insufficient'; v.details.summary = `gap ${builds}` }
    }
    return v
  } })
  assert.equal((await repair.go()).status, 'done')
  assert.deepEqual(repair.requests.map((r) => r.role), ['builder', 'builder', 'planner', 'builder', 'lead', 'planner', 'builder', 'reviewer'])
  const next = repair.requests.filter((r) => r.role === 'builder')
  assert.deepEqual(next[2].feedback, [])
  assert.deepEqual(next[3].feedback.map((item) => item.id), ['plan-revised'])
})

test('judge halts drain the sibling review and retain seat bounds (#2425)', async () => {
  for (const [role, mode] of [['reviewer', 'escalate'], ['tech-lead', 'escalate'], ['reviewer', 'escalate-red'], ['reviewer', 'unmeasured'], ['tech-lead', 'unmeasured'], ['tech-lead', 'bound'], ['reviewer', 'sibling-bound']]) {
    const sibling = role === 'reviewer' ? 'tech-lead' : 'reviewer'
    const bounded = mode === 'bound' || mode === 'sibling-bound'
    const f = fakes({ spec: { tier: 'judge' }, ...(bounded ? { review: 1, secondReview: 1, bounds: { 'tech-lead': 1 } } : mode === 'escalate-red' ? { secondReview: 1 } : {}),
      checkedTree: () => ({ ...green(), stdout: String(count(f, 'builder')).repeat(40) }),
      edit: (v) => {
        if (v.role !== role || mode === 'bound' || (mode === 'sibling-bound' && count(f, 'builder') === 1)) return v
        return mode === 'unmeasured' ? '' : { ...v, status: 'escalate', details: { question: 'Which contract applies?' } }
      } })
    const gate = Promise.withResolvers(), seat = f.deps.runSeat
    let siblingPending = false, settled = false
    f.deps.runSeat = async (request) => {
      const result = await seat(request)
      const gatedRole = mode === 'sibling-bound' ? role : sibling
      if (request.role === gatedRole && (!bounded || count(f, gatedRole) === 2)) { siblingPending = true; await gate.promise }
      return result
    }
    const pending = f.go().then((result) => { settled = true; return result })
    try {
      await new Promise(setImmediate)
      assert.equal(siblingPending, true, `${role}/${mode}`)
      assert.equal(settled, false, `${role}/${mode}`)
      assert.equal(f.rows.some((r) => r.event === 'verdict' && r.status === 'stopped'), false)
      if (mode === 'sibling-bound') assert.equal(count(f, 'lead'), 0)
      assert.equal(f.calls.includes('publish'), false)
    } finally {
      gate.resolve()
      await pending
    }
    const reason = mode === 'bound' ? 'lead-escalated' : mode === 'unmeasured' ? 'seat-unmeasured' : 'seat-escalated'
    assert.deepEqual(await pending, stopped(reason))
    const tail = f.rows.findLast((row, index) => !stateless(f.rows, row, index))
    assert.equal(tail.event, 'verdict')
    assert.equal(tail.status, 'stopped')
    assert.equal(tail.reason, reason)
    if (reason === 'seat-escalated') assert.equal(tail.observation.question, 'Which contract applies?')
    assert.equal(f.rows.slice(f.rows.indexOf(tail) + 1).some((r) => r.event === 'verdict' && r.status === 'reviewed'), false)
    if (mode === 'escalate-red') {
      const returned = f.rows.findLast((r) => r.event === 'envelope' && r.role === sibling)
      assert.equal(returned.parsed.details.verdict, 'changes-needed')
      assert.ok(f.rows.indexOf(returned) < f.rows.indexOf(tail))
      assert.equal(f.rows.some((r) => r.event === 'verdict' && r.status === 'reviewed' && r.role === sibling), false)
    }
    for (const seatRole of ['reviewer', 'tech-lead']) {
      const stage = seatRole === 'reviewer' ? 'review' : 'second-review'
      assert.equal(f.rows.filter((r) => r.event === 'envelope' && r.role === seatRole).length, count(f, seatRole))
      assert.equal(f.rows.filter((r) => r.event === 'stage-end' && r.stage === stage).length, bounded ? 2 : 1)
    }
    assert.equal(f.calls.includes('commit'), false)
    if (bounded) {
      assert.equal(count(f, 'tech-lead'), 1)
      assert.equal(count(f, 'reviewer'), 2)
      if (mode === 'bound') {
        const held = f.requests.find((r) => r.role === 'lead').feedback[0]
        assert.deepEqual([held.role, held.reason], ['tech-lead', 'round-bound'])
      }
    }
    if (mode !== 'bound') assert.equal(count(f, 'lead'), 0)
  }
})

test('a judge lane with no tech-lead seat stops seat-unmeasured at the start and on a raise', async () => {
  for (const tier of ['judge', 'build']) {
    const f = fakes({ spec: { tier }, unseated: ['tech-lead'], edit: (v) => { if (v.role === 'planner') v.details.judge = 'needs review'; return v } })
    assert.deepEqual(await f.go(), stopped('seat-unmeasured'))
    if (tier === 'judge') { assert.deepEqual(f.calls, []); assert.deepEqual(f.rows, [{ event: 'verdict', lane: 'lane', stage: null, status: 'stopped', reason: 'seat-unmeasured', at: 0 }]) }
    else assert.equal(count(f, 'builder'), 0)
  }
})

test('the tech-lead turn is bounded like any seat, and a lead bounce past the builder bound gives that build its review and second review (b1487)', async () => {
  const bounded = fakes({ spec: { tier: 'judge' }, bounds: { 'tech-lead': 1, builder: 3 }, secondReview: 10, lead: 'escalate' })
  assert.deepEqual(await bounded.go(), stopped('lead-escalated'))
  assert.equal(count(bounded, 'tech-lead'), 1)
  assert.equal(bounded.requests.find((r) => r.role === 'lead').feedback[0].role, 'tech-lead')
  for (const tier of ['build', 'judge']) {
    const f = fakes({ spec: { tier }, review: tier === 'build' ? 2 : 0, secondReview: tier === 'judge' ? 2 : 0, lead: 'bounce',
      checkedTree: () => ({ ...green(), stdout: String(count(f, 'builder')).repeat(40) }), edit: (v) => { if (v.role === 'lead' && count(f, 'lead') > 1) v.details = { decision: 'accept' }; return v } })
    assert.deepEqual(await f.go(), { status: 'done', reason: null, pr: PR }, tier)
    if (tier === 'build') assert.deepEqual(f.requests.map((r) => r.role), ['planner', 'builder', 'reviewer', 'builder', 'reviewer', 'lead', 'builder', 'reviewer'])
    else { assert.equal(count(f, 'reviewer'), 3); assert.equal(count(f, 'tech-lead'), 3); assert.equal(count(f, 'lead'), 1) }
  }
})

const BODY = ['Source: "issue 12"', '', '## Measurements', '- proof: lib.test.mjs "works": red on the old source, green on the build', '- Suite: green; exit 0; node --test lane.test.mjs.'].join('\n')
test('non-done decision seats escalate with their question or summary without repair', async () => {
  for (const role of ['planner', 'reviewer', 'tech-lead', 'lead']) for (const status of ['insufficient', 'escalate']) for (const question of [undefined, '', 'Which rule applies?']) {
    const f = fakes({ spec: { tier: role === 'tech-lead' ? 'judge' : 'build' }, edit: (v) => {
      if (role === 'lead' && v.role === 'builder') return { ...v, status: 'escalate', details: { ...v.details, question: 'Ask the lead?' } }
      if (v.role !== role) return v
      return { ...v, status, summary: 'Which constraint takes precedence?', details: {
        ...(role === 'lead' ? { decision: 'escalate', section: 'rules', notes: 'blocked' } : { gap: 'Missing rules' }),
        ...(role === 'planner' ? { plan_path: '/virtual/task/nonexistent.md', tests: [], files_in_scope: [], validation_lane: '' } : {}),
        ...(question === undefined ? {} : { question }),
      } }
    } })
    assert.deepEqual(await f.go(), stopped(role === 'lead' ? 'lead-escalated' : 'seat-escalated'), `${role}/${status}/${question}`)
    assert.equal(count(f, role), 1)
    assert.equal(f.requests.some((r) => r.repair || r.feedback.some((item) => item.id === 'escalate-no-question')), false)
    const observation = f.rows.findLast((r) => r.event === 'verdict').observation
    assert.equal(observation.question, question || 'Which constraint takes precedence?')
    const returned = role === 'lead' ? observation.lead : observation.envelope
    assert.equal(returned.status, status)
    assert.equal(Object.hasOwn(returned.details, role === 'lead' ? 'notes' : 'gap'), false)
    assert.equal(Object.hasOwn(returned.details, 'question'), Boolean(question))
  }
})

test('a builder escalate or done lead decision without details.question retries the same seat', async () => {
  for (const role of ['builder', 'lead']) {
    let returned = false
    const f = fakes({ edit: (v) => {
      if (role === 'lead' && v.role === 'builder') return { ...v, status: 'escalate', details: { ...v.details, question: 'Builder question?' } }
      if (v.role === role && !returned) { returned = true; return role === 'lead' ? { ...v, details: { decision: 'escalate' } } : { ...v, status: 'escalate' } }
      return v
    } })
    const result = await f.go()
    const expected = role === 'builder' ? ['planner', 'builder', 'builder', 'reviewer'] : ['planner', 'builder', 'lead', 'lead']
    assert.deepEqual(f.requests.map((r) => r.role), expected)
    const retry = f.requests.filter((r) => r.role === role)[1]
    assert.equal(retry.feedback[0].id, 'escalate-no-question')
    if (role === 'lead') {
      assert.equal(result.reason, 'lead-escalated')
      assert.equal(f.rows.findLast((r) => r.event === 'verdict').observation.question, 'Which way should the lane go?')
    } else assert.equal(result.status, 'done')
  }
})

// MUTATION: restore direct replan for builder insufficiency on build lanes.
test('a builder insufficient on build and judge goes to the lead with its envelope, and the lead routes it to the builder, the planner or the operator', async () => {
  for (const tier of ['build', 'judge']) for (const route of ['builder', 'planner', 'escalate']) {
    let builds = 0, plans = 0
    const f = fakes({ spec: { tier }, lead: route === 'escalate' ? 'escalate' : 'bounce', target: route, edit: (v) => {
      if (v.role === 'planner' && ++plans === 2 && tier === 'judge') Object.assign(v.details, { files_in_scope: ['crew/loop.mjs'], subject: 'fix(crew): revised plan', tests: [] })
      if (v.role === 'builder' && ++builds === 1) return { ...v, status: 'insufficient', summary: 'gap' }
      if (v.role === 'builder' && route === 'planner' && tier === 'judge') v.details.tests = []
      return v
    } })
    const result = await f.go()
    const roles = route === 'escalate' ? ['planner', 'builder', 'lead'] : ['planner', 'builder', 'lead', ...(route === 'planner' ? ['planner'] : []), 'builder', 'reviewer', ...(tier === 'judge' ? ['tech-lead'] : [])]
    assert.deepEqual(f.requests.map((r) => r.role), roles, `${tier} ${route}`)
    const held = f.requests.find((r) => r.role === 'lead').feedback[0]
    assert.equal(held.role, 'builder'); assert.equal(held.reason, 'insufficient')
    assert.equal(held.envelope.status, 'insufficient'); assert.equal(held.envelope.summary, 'gap')
    if (route === 'escalate') {
      assert.deepEqual(result, stopped('lead-escalated'))
      assert.equal(f.rows.findLast((r) => r.event === 'verdict').observation.question, 'Which way should the lane go?')
    } else {
      assert.equal(result.status, 'done')
      const planners = f.requests.filter((r) => r.role === 'planner')
      const builders = f.requests.filter((r) => r.role === 'builder')
      if (route === 'builder') {
        assert.equal(planners.length, 1)
        assert.equal(builders[1].planPath, builders[0].planPath)
        assert.deepEqual(builders[1].feedback[0], { id: 'lead-bounce', summary: 'fixture' })
      } else {
        assert.deepEqual(planners[1].feedback[0], { id: 'plan-gap', role: 'builder', envelope: held.envelope, lead: 'fixture' })
        assert.deepEqual(builders[1].feedback[0], { id: 'plan-revised', summary: 'The planner revised the plan at plan_path: continue on the revised plan.', plan_path: builders[1].planPath })
        if (tier === 'judge') {
          assert.deepEqual(builders[1].filesInScope, ['crew/loop.mjs'])
          assert.equal(builders[1].tier, 'judge')
          assert.equal(f.seen.publish.title, 'fix(crew): revised plan')
          assert.ok(f.seen.publish.body.includes('Proof: no criterion is machine-checked.'))
        }
      }
    }
  }
  for (const tier of ['build', 'judge']) for (const next of ['builder', 'planner', 'accept']) {
    let builds = 0, leads = 0
    const f = fakes({ spec: { tier }, lead: 'bounce', target: next, edit: (v) => {
      if (v.role === 'builder' && ++builds === 1) return { ...v, status: 'insufficient', summary: 'gap' }
      if (v.role === 'lead' && (++leads === 1 || next === 'accept')) v.details = { decision: 'accept' }
      return v
    } })
    const result = await f.go()
    const roles = f.requests.map((r) => r.role)
    assert.deepEqual(roles.slice(0, 4), ['planner', 'builder', 'lead', 'lead'], `${tier} ${next}`)
    const retry = f.requests.filter((r) => r.role === 'lead')[1].feedback[0]
    assert.equal(retry.envelope.status, 'insufficient')
    assert.equal(retry.feedback[0].id, 'accept-insufficient')
    if (next === 'accept') {
      assert.deepEqual(result, stopped('lead-escalated'))
      assert.match(f.rows.findLast((r) => r.event === 'verdict').observation.question, /accept/)
      assert.ok(!f.calls.includes('proof'))
    } else {
      assert.equal(roles[4], next)
      assert.equal(result.status, 'done')
    }
  }
})

test('a builder insufficient that names no gap and changed the worktree continues on the same plan without a lead turn or a round (#2279)', async () => {
  for (const mode of ['changed', 'gap', 'unchanged', 'unmeasured', 'throws']) {
    let builds = 0, state = 0
    const f = fakes({ bounds: { builder: 1 }, deps: { repoState: () => {
      if (mode === 'throws') throw new Error('unmeasured')
      return mode === 'unmeasured' ? null : mode === 'unchanged' ? 'same' : String(state++)
    } }, edit: (v) => {
      if (v.role === 'builder' && ++builds === 1) return { ...v, status: 'insufficient', details: { ...v.details, ...(mode === 'gap' ? { gap: 'Missing criterion' } : {}) } }
      return v
    } })
    const result = await f.go()
    const builders = f.requests.filter((r) => r.role === 'builder')
    if (mode === 'changed') {
      assert.equal(result.status, 'done')
      assert.equal(builders.length, 2)
      assert.equal(builders[1].planPath, builders[0].planPath)
      assert.equal(builders[1].feedback[0].id, 'builder-continue')
      assert.equal(f.requests.filter((r) => r.role === 'lead').length, 0)
      assert.equal(f.rows.filter((r) => r.event === 'builder-continue').length, 1)
    } else {
      assert.equal(result.reason, 'lead-escalated', mode)
      const lead = f.requests.find((r) => r.role === 'lead')
      assert.equal(lead.feedback[0].held.status, 'insufficient', mode)
      if (mode === 'gap') assert.equal(lead.feedback[0].held.details.gap, 'Missing criterion')
    }
  }
})

test('a replan whose tier raise stops leaves no lead rulings for finish (#2347)', async () => {
  let builds = 0, leads = 0, plans = 0
  const f = fakes({ lead: 'bounce', throwJudge: true, deps: { repoState: () => 'same' }, edit: (v) => {
    if (v.role === 'builder' && ++builds <= 2) return { ...v, status: 'insufficient', details: { ...v.details, gap: `gap ${builds}` } }
    if (v.role === 'lead') { v.summary = `ruling ${++leads}`; v.details.target = leads === 1 ? 'builder' : 'planner' }
    if (v.role === 'planner' && ++plans === 2) v.details.judge = 'needs review'
    return v
  } })
  const result = await f.go()
  assert.equal(result.reason, 'seat-unmeasured')
  assert.equal(plans, 2)
  assert.deepEqual(f.rows.filter((r) => r.event === 'lead-rulings').at(-1).rulings, [])
})

test('a mechanical restart whose tier raise stops leaves no lead rulings for finish (#2351)', async () => {
  let builds = 0
  const f = fakes({ spec: { tier: 'mechanical' }, lead: 'bounce', edit: (v) => {
    if (v.role === 'builder') {
      builds++
      if (builds === 1) return { ...v, status: 'escalate', details: { ...v.details, question: 'What next?' } }
      if (builds === 2) return { ...v, status: 'insufficient' }
    }
    return v
  } })
  const resolve = f.deps.resolveAgents
  f.deps.resolveAgents = (...args) => {
    if (args[0] === 'build') throw new Error('build unavailable')
    return resolve(...args)
  }
  const result = await f.go()
  assert.equal(result.reason, 'seat-unmeasured')
  const rows = f.rows.filter((r) => r.event === 'lead-rulings')
  assert.ok(rows.some((r) => r.rulings.length > 0))
  assert.deepEqual(rows.at(-1).rulings, [])
})

test('round-bound lead refunds share the per-lane progress cap with builder continuations (#2375)', async () => {
  let state = 0, reviews = 0, builds = 0
  const f = fakes({ review: 4, bounds: { builder: 1, reviewer: 10 }, lead: 'bounce', deps: { repoState: () => String(state++) }, edit: (v, request) => {
    if (v.role === 'builder' && ++builds <= 5) v.status = 'insufficient'
    if (v.role === 'reviewer' && v.details.verdict === 'changes-needed') {
      v.details.findings = [{ ...finding, id: `R${++reviews}` }]
      v.details.closed = request.feedback.map((item) => ({ id: item.id, evidence: 'fixed' }))
    }
    return v
  } })
  assert.equal((await f.go()).reason, 'lead-escalated')
  assert.deepEqual(f.rows.filter((r) => r.event === 'builder-continue').map((r) => r.progressTurns), [1, 2, 3, 4, 5])
  assert.deepEqual(f.rows.filter((r) => r.event === 'lead-bound-refund').map((r) => r.progressTurns), [6])
  assert.equal(f.requests.filter((r) => r.role === 'lead').length, 3)
})

test('a lead bounce to the planner for a builder held at its round bound spends the lead bound (#2375)', async () => {
  let state = 0, reviews = 0
  const f = fakes({ review: 3, bounds: { builder: 1, reviewer: 10 }, lead: 'bounce', target: 'planner', deps: { repoState: () => String(state++) }, edit: (v, request) => {
    if (v.role === 'reviewer' && v.details.verdict === 'changes-needed') {
      v.details.findings = [{ ...finding, id: `R${++reviews}` }]
      v.details.closed = request.feedback.map((item) => ({ id: item.id, evidence: 'fixed' }))
    }
    return v
  } })
  await f.go()
  assert.equal(f.rows.filter((r) => r.event === 'lead-bound-refund').length, 0)
  assert.equal(f.requests.filter((r) => r.role === 'lead').length, 2)
})

test('the same failure with the same evidence twice stops the lane no-progress and no seat decides it', async () => {
  for (const mode of ['envelope', 'insufficient', 'insufficient-reordered', 'lead', 'proof-no-tests', 'proof-unproven']) {
    let turns = 0
    const f = fakes({ lead: 'bounce', proof: { status: 'red', reason: 'exit-nonzero', rows: [{ file: 'lib.test.mjs', title: 'works', proven: false, reason: 'base-green' }] }, edit: (v) => {
      if (v.role === 'builder' && mode === 'envelope') return { ...v, status: 'escalate', details: { ...v.details, question: 'What next?' } }
      if (v.role === 'builder' && mode === 'insufficient') return { ...v, status: 'insufficient', summary: `gap ${++turns}` }
      if (v.role === 'builder' && mode === 'insufficient-reordered') return { ...v, status: 'insufficient', details: ++turns === 1
        ? { summary: 'gap', tests: [{ file: 'lib.test.mjs', title: 'works' }] }
        : { tests: [{ title: 'works', file: 'lib.test.mjs' }], summary: 'gap' } }
      if (v.role === 'builder' && mode === 'lead') return { ...v, status: 'escalate', details: { ...v.details, question: 'What next?' } }
      if (v.role === 'lead' && mode === 'lead') return { ...v, details: { decision: 'escalate' }, summary: `gap ${++turns}` }
      if (v.role === 'builder' && mode === 'proof-no-tests') v.details.tests = []
      return v
    } })
    const result = await f.go()
    const expected = mode === 'envelope' ? ['planner', 'builder', 'lead', 'builder'] : mode.startsWith('insufficient') ? ['planner', 'builder', 'lead', 'builder'] : mode === 'lead' ? ['planner', 'builder', 'lead', 'lead'] : ['planner', 'builder', 'builder']
    assert.deepEqual(f.requests.map((r) => r.role), expected)
    assert.equal(result.reason, 'no-progress')
    const observation = f.rows.findLast((r) => r.event === 'verdict').observation
    assert.equal(['envelope', 'insufficient', 'insufficient-reordered', 'lead'].includes(mode) ? observation.role : observation.failure, mode === 'lead' ? 'lead' : mode === 'envelope' || mode.startsWith('insufficient') ? 'builder' : mode)
  }
  let builds = 0
  const revised = fakes({ bounds: { planner: 3 }, lead: 'bounce', target: 'planner', edit: (v) => {
    if (v.role === 'builder' && ++builds <= 2) return { ...v, status: 'insufficient', details: { ...v.details, summary: `gap ${builds}` } }
    return v
  } })
  assert.equal((await revised.go()).status, 'done')
  assert.deepEqual(revised.requests.map((r) => r.role), ['planner', 'builder', 'lead', 'planner', 'builder', 'lead', 'planner', 'builder', 'reviewer'])
})

test('a proof failure keeps the open review findings behind the proof item (#2296)', async () => {
  for (const mode of ['proof-no-tests', 'proof-unproven', 'both']) {
    let builds = 0, proofs = 0
    const f = fakes({ review: 1, bounds: { builder: 4 }, proof: () => ++proofs === 2 && mode !== 'proof-no-tests'
      ? { status: 'red', reason: 'proof-unproven', rows: [{ file: 'lib.test.mjs', title: 'works', proven: false }] }
      : { status: 'green', reason: null, rows: [{ file: 'lib.test.mjs', title: 'works', proven: true }] }, edit: (v) => {
      if (v.role === 'builder' && ++builds === 2 && mode !== 'proof-unproven') v.details.tests = []
      return v
    } })
    assert.equal((await f.go()).status, 'done', mode)
    const turns = f.requests.filter((r) => r.role === 'builder')
    assert.deepEqual(turns[2].feedback.map((item) => item.id), [mode === 'proof-unproven' ? mode : 'proof-no-tests', 'R1'], mode)
    if (mode === 'both') assert.deepEqual(turns[3].feedback.map((item) => item.id), ['proof-unproven', 'R1'])
  }
})

test('plan-revised, mechanical-restart, finish-stop and finish-return feedback carry a summary (#2296)', async () => {
  const result = (lines) => ({ ...redRun(), stderr: `FAIL lib.test.mjs > works\n${'passing output\n'.repeat(lines)}final diagnostic\n` })
  for (const [mode, stop] of [
    ['plan-revised'], ['mechanical-restart'],
    ['finish', { reason: 'exit-nonzero', observation: result(1000) }],
    ['finish', { reason: 'red-after-sleep-rerun', observation: { stage: 'suite', result: result(250) } }],
  ]) {
    let builds = 0
    const f = fakes({ spec: mode === 'finish' ? finishSpec({ guidance: 'Fix it', stop }) : { tier: mode === 'mechanical-restart' ? 'mechanical' : 'build' }, lead: 'bounce', target: 'planner', edit: (v) => {
      if (mode !== 'finish' && v.role === 'builder' && ++builds === 1) return { ...v, status: 'escalate', details: { ...v.details, question: 'What next?' } }
      return v
    } })
    assert.equal((await f.go()).status, 'done', mode)
    const ids = mode === 'finish' ? ['finish-stop', 'finish-return'] : [mode]
    for (const id of ids) {
      const item = f.requests.flatMap((r) => r.feedback).find((entry) => entry.id === id)
      assert.equal(typeof item?.summary, 'string', id)
      assert.match(item.summary, /^[^\r\n]*\S[^\r\n]*$/, id)
    }
    if (mode === 'finish') {
      const { observation } = builderTurns(f)[0].feedback.find((item) => item.id === 'finish-stop')
      const rerun = stop.reason === 'red-after-sleep-rerun'
      if (rerun) assert.equal(observation.stage, 'suite')
      const diagnostics = rerun ? observation.result : observation
      assert.ok(!Object.hasOwn(diagnostics, 'stdout') && !Object.hasOwn(diagnostics, 'stderr'), 'raw streams must not reach the builder')
      assert.deepEqual(diagnostics.failingTests, ['works'])
      assert.deepEqual(diagnostics.failingFiles, ['lib.test.mjs'])
      assert.equal(diagnostics.outputTail.length, 1)
      assert.ok(diagnostics.outputTail[0].length <= 2000)
      assert.ok(diagnostics.outputTail[0].endsWith('final diagnostic\n'))
    }
  }
})

const count = (f, role) => f.requests.filter((r) => r.role === role).length
const stopped = (reason) => ({ status: 'stopped', reason, pr: null })

test('a suite timeoutMs above 2147483647 is refused as invalid-input before any effect and 2147483647 reaches the suite', async () => {
  for (const timeoutMs of [2147483648, Number.MAX_SAFE_INTEGER]) {
    const f = fakes({ spec: { suite: { command: 'node', timeoutMs } } })
    assert.deepEqual(await f.go(), stopped('invalid-input'))
    assert.deepEqual(f.calls, [])
    assert.deepEqual(f.rows, [{ event: 'verdict', lane: 'lane', stage: null, status: 'stopped', reason: 'invalid-input', at: 0 }])
  }
  const f = fakes({ spec: { suite: { command: 'node', timeoutMs: 2147483647 } } })
  assert.equal((await f.go()).status, 'done')
  assert.equal(f.seen.suite.timeoutMs, 2147483647)
})


const nth = (role, turn, edit) => (v, r) => (r.role === role && Number(r.id.split('.').at(-1)) === turn ? edit(v) : v)

// MUTATION: treat every envelope as valid and a refused return advances the loop.
test('a refused, unreadable, empty or stale envelope stops the lane and a lead accept never launders it', async () => {
  const cases = {
    'unknown field': [{ edit: (v) => ({ ...v, forbidden: true }) }, 'envelope-refused'],
    'wrong id': [{ edit: (v) => ({ ...v, id: 'stale-return' }) }, 'envelope-refused'],
    'wrong role': [{ edit: (v) => ({ ...v, role: 'builder', details: { summary: 'x' } }) }, 'envelope-refused'],
    'null': [{ edit: () => 'null' }, 'envelope-refused'],
    'array': [{ edit: () => '[]' }, 'envelope-refused'],
    'malformed json': [{ edit: () => '{' }, 'envelope-refused'],
    'incomplete details': [{ edit: (v) => ({ ...v, details: { plan_path: 'p' } }) }, 'envelope-refused'],
    'empty file': [{ edit: () => '' }, 'seat-unmeasured'],
    'EPERM': [{ readError: 'EPERM' }, 'seat-unmeasured'],
    'ENOENT': [{ readError: 'ENOENT' }, 'seat-unmeasured'],
    'seat throws': [{ seatThrows: 'planner' }, 'seat-unmeasured'],
    'seat rejects': [{ seatRejects: 'planner' }, 'seat-unmeasured'],
  }
  for (const [name, [options, reason]] of Object.entries(cases)) {
    const f = fakes({ lead: 'accept', ...options })
    assert.deepEqual(await f.go(), stopped(reason), name)
    assert.equal(count(f, 'lead'), 0, name)
    assert.equal(f.calls.includes('fetch'), false, name)
    assert.equal(count(f, 'builder'), 0, name)
  }
  const stale = fakes({ edit: (v, r) => r.role === 'builder' ? { ...v, id: 'lane.planner.1' } : v })
  assert.deepEqual(await stale.go(), stopped('envelope-refused'))
  assert.equal(stale.calls.includes('proof'), false)
})

// MUTATION: drop the changes-needed branch and the findings never reach a second build.
test('from round 2 the reviewer hears the earlier findings, and a return that drops one is refused', async () => {
  for (const cleanup of ['proven', 'delayed', 'unknown']) {
    const cwd = scratchDir('loop-cancel-suite-'), ready = join(cwd, 'ready.json')
    // Start the detached child's pipe-close delay at cancellation, not at startup.
    const descendant = `process.on('SIGUSR2', () => setTimeout(() => process.exit(0), 3000)); console.log('suite ready'); require('node:fs').writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pgid: process.ppid, pid: process.pid })); setTimeout(() => process.exit(0), 10_000)`
    const source = `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit', detached: ${cleanup === 'delayed'} }); process.on('SIGTERM', () => ${cleanup === 'delayed' ? "{ child.kill('SIGUSR2'); process.exit(0) }" : "child.kill('SIGTERM')"}); child.on('exit', () => process.exit(0)); setTimeout(() => { child.kill('SIGKILL'); process.exit(0) }, 5000)`
    const f = fakes({ review: 1, deps: { now: Date.now } })
    const suite = f.deps.runSuite, seat = f.deps.runSeat
    let first = true, group, running, cancelled = false
    const probes = []
    f.deps.runSuite = async (input) => {
      if (!first) return suite(input)
      first = false
      input.signal?.addEventListener('abort', () => { cancelled = true }, { once: true })
      running = runSuite({ ...input, cwd, command: process.execPath, args: ['-e', source], timeoutMs: 7000 }, cleanup === 'unknown' ? {
        probeKill: () => {
          probes.push(count(f, 'builder'))
          throw Object.assign(new Error('unknown group'), { code: 'EIO' })
        },
      } : {})
      return running
    }
    f.deps.runSeat = async (request) => {
      if (request.role === 'reviewer' && !group) {
        const deadline = Date.now() + 5000
        while (!group && Date.now() < deadline) {
          try { group = JSON.parse(readFileSync(ready, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
          if (!group) await new Promise((resolve) => setTimeout(resolve, 10))
        }
        assert.ok(group, 'review waits for the suite process to be ready')
      }
      if (request.role === 'builder' && count(f, 'builder') === 1) {
        assert.notEqual(cleanup, 'unknown', 'unknown cleanup cannot release another builder')
        assert.throws(() => process.kill(-group.pgid, 0), { code: 'ESRCH' })
        assert.deepEqual(request.feedback, [finding])
      }
      return seat(request)
    }
    try {
      const result = await f.go()
      const check = f.rows.find((row) => row.event === 'check' && row.check === 'suite')
      assert.equal(check.result.status, cleanup === 'unknown' ? 'unmeasured' : 'cancelled', cleanup)
      assert.equal(cancelled, true, 'review requests cancellation while the suite is running')
      assert.equal(typeof check.seconds, 'number')
      assert.ok(check.seconds > 0)
      assert.match(JSON.parse(f.writes.get(join(f.spec.taskDir, check.outputFile))).stdout, /suite ready/)
      assert.equal(f.requests.some((request) => request.feedback.some((item) => item.id === 'suite-repair')), false)
      if (cleanup !== 'unknown') {
        assert.equal(check.result.reason, 'cancelled')
        assert.equal(check.result.cleanup, 'proven')
        assert.equal(result.status, 'done')
        assert.equal(f.rows.filter((row) => row.event === 'check' && row.check === 'suite').at(-1).result.status, 'green')
        assert.match(f.seen.publish.body, /- Suite: green; exit 0;/)
        assert.doesNotMatch(f.seen.publish.body, /Suite: cancelled/)
      } else {
        assert.deepEqual(result, stopped('cleanup-unproven'))
        assert.equal(count(f, 'builder'), 1)
        assert.ok(probes.length > 1 && probes.every((turns) => turns === 1))
        assert.equal(f.seen.publish, undefined)
      }
    } finally {
      if (group) {
        try { process.kill(-group.pgid, 'SIGKILL') } catch {}
        if (cleanup === 'delayed') { try { process.kill(group.pid, 'SIGKILL') } catch {} }
      }
      await running
    }
  }
  const normal = fakes({ review: 1 })
  assert.equal((await normal.go()).status, 'done')
  assert.deepEqual(normal.requests.filter((r) => r.role === 'reviewer').map((r) => r.feedback), [[], [finding]])
  assert.deepEqual(normal.requests.find((r) => r.role === 'reviewer').builderReport, { tests: [{ file: 'lib.test.mjs', title: 'works' }], notes: null })
  for (const mode of ['drop', 'carry', 'bad-closed']) {
    const f = fakes({ review: 1, edit: (v, req) => {
      if (req.role === 'reviewer' && req.feedback.length) {
        v.details.closed = mode === 'bad-closed' ? [{ id: 'R1' }] : []
        if (mode === 'carry') v.details.findings = [{ ...finding, severity: 'should-fix' }]
      }
      return v
    } })
    const result = await f.go()
    assert.equal(result.status, mode === 'carry' ? 'done' : 'stopped')
    if (mode !== 'carry') {
      assert.equal(result.reason, 'envelope-refused')
      assert.ok(f.requests.some((r) => r.role === 'reviewer' && r.repair && r.repair.defects.some((d) => d.includes(mode === 'drop' ? 'R1' : 'details.closed'))))
    }
  }
  const finish = fakes({ spec: finishSpec(), unseated: ['planner'] })
  assert.equal((await finish.go()).status, 'done')
  assert.deepEqual(finish.requests.find((r) => r.role === 'reviewer').feedback, [finding])
  const malformed = fakes({ spec: finishSpec({ findings: [{ ...finding, id: '../bad' }] }), unseated: ['planner'], edit: (v) => { if (v.role === 'reviewer') v.details.closed = []; return v } })
  assert.equal((await malformed.go()).status, 'done')
})

test('a reserve re-review that still asks for changes or returns insufficient stops with no further build or lead consult', async () => {
  for (const mode of ['changes-needed', 'insufficient']) {
    let reviews = 0
    const f = fakes({ review: 10, bounds: { builder: 10, reviewer: 2 }, lead: 'bounce', edit: (v) => {
      if (v.role === 'reviewer' && ++reviews === 3 && mode === 'insufficient') v.status = 'insufficient'
      return v
    } })
    assert.deepEqual(await f.go(), stopped(mode === 'insufficient' ? 'seat-escalated' : 'round-bound'), mode)
    assert.equal(count(f, 'reviewer'), 3, mode)
    assert.equal(count(f, 'builder'), 3, mode)
    assert.equal(count(f, 'lead'), 0, mode)
    assert.equal(f.calls.filter((call) => call === 'proof').length, 3, mode)
    assert.equal(f.calls.includes('commit'), false, mode)
    assert.equal(f.calls.includes('publish'), false, mode)
    if (mode === 'changes-needed') assert.deepEqual(f.rows.findLast((row) => row.status === 'stopped').observation.findings, [finding])
  }
})

test('a reserve re-review that passes with a red suite stops round-bound with no further builder turn', async () => {
  const red = { ...redRun(), stdout: 'not ok 1 - failing test' }
  const f = sequenced([green(), green(), red], { review: 2, bounds: { builder: 10, reviewer: 2 } })
  assert.deepEqual(await f.go(), stopped('round-bound'))
  assert.equal(count(f, 'reviewer'), 3)
  assert.equal(count(f, 'builder'), 3)
  assert.equal(count(f, 'lead'), 0)
  assert.equal(f.calls.filter((call) => call === 'proof').length, 3)
  assert.equal(f.calls.includes('commit'), false)
  assert.equal(f.calls.includes('publish'), false)
  const observation = f.rows.findLast((row) => row.status === 'stopped').observation
  assert.deepEqual(observation.findings, [])
  assert.deepEqual(observation.feedback[0].failingTests, ['failing test'])
})

// MUTATION: let accept pass with no valid envelope and a bound or lead decision stands in for a measurement.
test('a lead accept releases only a valid non-done envelope and never an exhausted bound', async () => {
  const escalated = fakes({ lead: 'accept', edit: (v) => v.id === 'lane.builder.2' ? { ...v, status: 'escalate', details: { ...v.details, question: 'What next?' } } : v })
  assert.equal((await escalated.go()).status, 'done')
  assert.equal(count(escalated, 'lead'), 1)
  assert.deepEqual(escalated.requests.find((r) => r.role === 'lead').feedback.map((x) => [x.role, x.reason, x.envelope.status]), [['builder', 'escalate', 'escalate']])
  const exhausted = fakes({ lead: 'accept', review: 10, bounds: { builder: 1, reviewer: 10 } })
  assert.deepEqual(await exhausted.go(), stopped('lead-escalated'))
  assert.equal(count(exhausted, 'lead'), 2)
  assert.equal(exhausted.calls.includes('commit'), false)
  const changes = fakes({ lead: 'accept', review: 10, edit: (v) => v.role === 'reviewer' ? { ...v, status: 'escalate', details: { ...v.details, question: 'What next?' } } : v })
  assert.notEqual((await changes.go()).status, 'done')
  assert.equal(changes.calls.includes('suite'), true)

})

// MUTATION: consult a missing lead anyway, or let a bad lead envelope decide.
test('an unseated, refusing or insufficient lead stops without recursion', async () => {
  const none = fakes({ unseated: ['lead'], edit: (v) => v.role === 'builder' ? { ...v, status: 'escalate', details: { ...v.details, question: 'What next?' } } : v })
  assert.deepEqual(await none.go(), stopped('lead-unavailable'))
  assert.equal(count(none, 'lead'), 0)
  const bad = fakes({ edit: (v) => v.role === 'builder' ? { ...v, status: 'escalate', details: { ...v.details, question: 'What next?' } } : v.role === 'lead' ? { ...v, extra: 1 } : v })
  assert.deepEqual(await bad.go(), stopped('lead-refused'))
  assert.equal(count(bad, 'lead'), 2)
  const insufficient = fakes({ edit: (v) => v.role === 'builder' || v.role === 'lead' ? { ...v, status: 'insufficient' } : v })
  assert.deepEqual(await insufficient.go(), stopped('lead-escalated'))
  assert.equal(count(insufficient, 'lead'), 1)
  const undecided = fakes({ edit: (v) => v.role === 'builder' ? { ...v, status: 'insufficient' } : v.role === 'lead' ? { ...v, status: 'insufficient', details: {} } : v })
  assert.deepEqual(await undecided.go(), stopped('lead-refused'))
  const crashed = fakes({ seatThrows: 'lead', edit: (v) => v.role === 'builder' ? { ...v, status: 'escalate', details: { ...v.details, question: 'What next?' } } : v })
  assert.deepEqual(await crashed.go(), stopped('lead-refused'))
})

const redRun = (code = 1, reason = 'exit-nonzero') => ({ ...green(), status: 'red', code, reason })
const timeoutRun = () => ({ ...green(), status: 'unmeasured', code: null, reason: 'timeout', timedOut: true })
// A suite seam that answers from a sequence and counts every invocation; an exhausted sequence throws.
function sequenced(sequence, options = {}) {
  const inputs = []
  const f = fakes(options)
  f.deps.runSuite = async (input) => {
    f.calls.push('suite'); inputs.push(structuredClone(input))
    const next = sequence[inputs.length - 1]
    if (next instanceof Error) throw next
    if (next === undefined) throw new Error('unexpected extra suite run')
    return structuredClone(next)
  }
  return Object.assign(f, { inputs })
}
test('a judge reuses each roles pass on an unchanged recheck tree (#2412)', async () => {
  const A = 'a'.repeat(40), C = 'c'.repeat(40)
  const f = sequenced([green(), redRun(), green()], { spec: { tier: 'judge' },
    rebase: answers({ ...MOVED, head: A }, { ...MOVED, onto: O }, { ...MOVED, head: C }),
    commit: answers({ status: 'green', reason: null, head: A }, { status: 'green', reason: null, head: C }),
    edit: (v) => {
      if (['reviewer', 'tech-lead'].includes(v.role)) v.details.findings = [{ ...finding, id: v.role === 'reviewer' ? 'R1' : 'T1', severity: 'should-fix', summary: `${v.role} note` }]
      return v
    },
  })
  assert.deepEqual(await f.go(), { status: 'done', reason: null, pr: PR })
  assert.equal(count(f, 'reviewer'), 1)
  assert.equal(count(f, 'tech-lead'), 1)
  assert.equal(builderTurns(f).length, 2)
  assert.equal(f.calls.filter((c) => c === 'proof').length, 3)
  assert.equal(f.inputs.length, 3)
  assert.deepEqual(f.rows.filter((r) => r.event === 'review-reused').map(({ role, tree, verdict }) => ({ role, tree, verdict })), ['reviewer', 'tech-lead'].map((role) => ({ role, tree: 'e'.repeat(40), verdict: 'pass' })))
  assert.equal(f.rows.filter((r) => r.event === 'verdict' && r.status === 'reviewed').length, 2)
  assert.match(f.seen.publish.body, /## Open points\n- reviewer note \(lib.mjs:1\)\n- tech-lead note \(lib.mjs:1\)/)
})

const EFFECTS = ['paths', 'commit', 'fetch', 'rebase', 'publish']
const PUBLISH_EFFECTS = EFFECTS.filter((effect) => effect !== 'fetch')

// MUTATION: pass the lane's own timeouts to the checks, or read the onboarding once at loop entry, and a raise that arrives
// with the pass's rebase never reaches the proof or suite (#2514).
test('a finish pass runs its proof and suite under the larger of the lane\'s and the rebased tree\'s onboarding timeouts and journals each; a lowered onboarding keeps the lane\'s and a legacy lane is untouched (#2514)', async () => {
  const write = (cwd, project) => {
    const body = { suite: 'node --test lane.test.mjs', proof: [], ...project }
    mkdirSync(join(cwd, '.crew'), { recursive: true })
    writeFileSync(join(cwd, '.crew', 'project.json'), JSON.stringify({ ...body, onboarded: { hash: projectHash(body) } }))
  }
  const path = '.crew/project.json'
  const raised = { proofTimeoutMs: 900_000, suiteTimeoutMs: 1_800_000 }
  for (const [name, project, onboarded, expected, fallback] of [
    ['raised by the rebase', { ...raised, builderChecks: ['echo —'] }, true, [900_000, 1_800_000]],
    ['hidden by skip-worktree', raised, true, [120_000, 600_000], 'onboarding-tree-mismatch'],
    ['lowered', { proofTimeoutMs: 1_000, suiteTimeoutMs: 1_000 }, true, [120_000, 600_000]],
    ['unreadable', null, true, [120_000, 600_000], 'onboarding-unreadable'],
    ['legacy lane', raised, false, [120_000, 600_000]],
    ['standard lane', raised, 'standard', [120_000, 600_000]],
  ]) {
    const cwd = scratchDir('finish-timeouts-')
    repoGit(cwd, 'init', '-q')
    const hidden = name === 'hidden by skip-worktree'
    if (hidden) {
      write(cwd, { proofTimeoutMs: 120_000, suiteTimeoutMs: 600_000 })
      repoGit(cwd, 'add', '-f', '--', path)
      repoGit(cwd, 'commit', '-qm', 'lane budgets')
      repoGit(cwd, 'update-index', '--skip-worktree', '--', path)
      write(cwd, project)
      assert.equal(repoGit(cwd, 'status', '--porcelain=v1', '--', path), '')
    }
    const f = fakes({ spec: { ...(onboarded === 'standard' ? {} : finishSpec()), cwd, ...(onboarded ? { onboarded: 'a'.repeat(64) } : {}), proofTimeoutMs: 120_000, suite: { command: 'node', args: ['--test', 'lane.test.mjs'], timeoutMs: 600_000 } } })
    const run = f.deps.run
    f.deps.run = (input) => input.args.at(-1) === path ? { ...green(), stdout: repoGit(cwd, ...input.args) } : run(input)
    const rebase = f.deps.rebaseBranch
    f.deps.rebaseBranch = (input) => {
      if (project && !hidden) { write(cwd, project); repoGit(cwd, 'add', '-f', '--', path) }
      return rebase(input)
    }
    assert.equal((await f.go()).status, 'done', name)
    assert.deepEqual([f.seen.proof.timeoutMs, f.seen.suite.timeoutMs], expected, name)
    const rows = f.rows.filter((r) => r.event === 'check' && (r.check === 'proof' || r.check === 'suite')).map((r) => [r.check, r.timeoutMs, r.timeoutFallback])
    assert.deepEqual(rows, !onboarded || onboarded === 'standard' ? [['proof', undefined, undefined], ['suite', undefined, undefined]]
      : [['proof', expected[0], fallback], ['suite', expected[1], fallback]], name)
  }
})

// MUTATION: invert which finish red gets an unchanged-tree re-run.
test('a finish first red repairs immediately unless a sleep-credited re-run passes', async () => {
  const spec = { ...finishSpec(), suite: { command: 'node', args: ['--test', 'lane.test.mjs'], timeoutMs: 1800000 } }
  const f = sequenced([{ ...redRun(7), stdout: SPEC_OUT, stderr: TAP_OUT }, green()], { spec, checkedTree: () => ({ ...green(), stdout: String(count(f, 'builder')).repeat(40) }) })
  assert.deepEqual(await f.go(), { status: 'done', reason: null, pr: null })
  assert.equal(builderTurns(f).length, 2)
  assert.deepEqual(f.calls.slice(f.calls.indexOf('suite'), f.calls.lastIndexOf('suite') + 1), ['suite', 'seat:builder', 'build-paths', 'proof', 'review-paths', 'suite-stage', 'checked-tree', 'seat:reviewer', 'suite'])
  const feedback = builderTurns(f)[1].feedback.find((item) => item.id === 'suite-repair')
  assert.equal(feedback.summary, 'The project suite is red after your change: node --test lane.test.mjs. Fix the failing tests. This is your only repair turn.')
  assert.equal(feedback.checkout, f.spec.cwd)
  assert.deepEqual(feedback.failingTests, ['anchor spans remain current', 'exhibit census remains current'])
  assert.deepEqual(feedback.failingFiles, ['skills/qa-test-writing/exhibits.test.mjs:42:1', '/virtual/checkout/skills/ux/exhibits.test.mjs:73:1'])
  assert.deepEqual(feedback.outputTail, [`${SPEC_OUT}\n${TAP_OUT}`])
  assert.ok(feedback.outputTail[0].length <= 2000)
  assert.equal(f.inputs.length, 2)
  assert.deepEqual(f.inputs[1], f.inputs[0])
  assert.deepEqual(f.inputs[0], { cwd: '/virtual/checkout', command: 'node', args: ['--test', 'lane.test.mjs'], timeoutMs: 1800000, suiteLock: undefined, lane: f.spec.id })
  assert.equal(f.calls.filter((c) => c === 'proof').length, 2)
  assert.equal(count(f, 'reviewer'), 2)
  assert.deepEqual(f.rows.filter((r) => r.event === 'check' && r.check === 'suite').map((r) => r.result.status), ['red', 'green'])
  assert.match(f.seen.commit.body, /- Suite: green; exit 0; node --test lane\.test\.mjs\.\n?$/)
  const report = JSON.parse(f.writes.get('/virtual/task/finish-report.json'))
  assert.ok(report.measurements.includes('- Suite: green; exit 0; node --test lane.test.mjs.'))
  assert.match(report.body, /- Suite: green; exit 0; node --test lane\.test\.mjs\./)
  assert.doesNotMatch(f.seen.commit.body + JSON.stringify(report), /redCode|re-run after red|re-run after a red/)
  assert.equal(f.calls.includes('publish'), false)

  const slept = sequenced([{ ...redRun(), sleep_credited_s: 28336 }, green()], { spec: { ...spec, suiteLock: true } })
  assert.deepEqual(await slept.go(), { status: 'done', reason: null, pr: null })
  assert.deepEqual(slept.calls.slice(slept.calls.indexOf('suite'), slept.calls.lastIndexOf('suite') + 1), ['suite', 'suite'])
  const input = { ...f.inputs[0], suiteLock: true }
  assert.deepEqual(slept.inputs, [input, input])
  assert.equal(builderTurns(slept).length, 1)
  assert.equal(count(slept, 'reviewer'), 1)
  const attempts = slept.rows.filter((r) => r.stage === 'suite')
  assert.deepEqual(attempts.map(({ event, result, outcome }) => [event, (result ?? outcome)?.status]), [
    ['stage-start', undefined], ['check', 'red'], ['stage-end', 'red'],
    ['stage-start', undefined], ['check', 'green'], ['stage-end', 'green'],
  ])
  assert.equal(attempts[1].result.reason, 'exit-nonzero')
  assert.equal(attempts[2].outcome.sleep_credited_s, 28336)
  assert.ok(slept.rows.some((r) => r.event === 'finish-ready' && r.status === 'ready-for-operator'))

  // #2520: a red that prints a declared environment signature is re-run once, with no builder turn.
  const envSpec = { ...spec, environmentSignatures: ['PoolTimedOut'] }
  const envRed = { ...redRun(), stderr: 'open test store: Database(PoolTimedOut)' }
  const env = sequenced([envRed, green()], { spec: envSpec })
  assert.deepEqual(await env.go(), { status: 'done', reason: null, pr: null })
  assert.deepEqual(env.calls.slice(env.calls.indexOf('suite'), env.calls.lastIndexOf('suite') + 1), ['suite', 'suite'])
  assert.equal(builderTurns(env).length, 1)
  assert.equal(env.rows.filter((r) => r.event === 'check' && r.check === 'suite').at(-1).environmentSignature, 'PoolTimedOut')
  const broken = sequenced([envRed, envRed], { spec: envSpec })
  assert.equal((await broken.go()).reason, 'red-after-environment-rerun')
  assert.equal(builderTurns(broken).length, 1)
  // A red without the signature, first or after a matching red, is an ordinary red: the builder repairs it.
  const otherRed = { ...redRun(), stderr: 'AssertionError: stale' }
  for (const sequence of [[otherRed, green()], [envRed, otherRed, green()]]) {
    const repaired = sequenced(sequence, { spec: envSpec, checkedTree: () => ({ ...green(), stdout: String(count(repaired, 'builder')).repeat(40) }) })
    assert.deepEqual(await repaired.go(), { status: 'done', reason: null, pr: null })
    assert.equal(builderTurns(repaired).length, 2)
    assert.ok(builderTurns(repaired)[1].feedback.some((item) => item.id === 'suite-repair'))
    assert.equal(repaired.calls.filter((c) => c === 'suite').length, sequence.length)
  }
})

const SPEC_OUT = ['ℹ failing tests:', 'test at skills/qa-test-writing/exhibits.test.mjs:42:1', '✖ anchor spans remain current (2ms)', '  AssertionError: stale'].join('\n')
const TAP_OUT = ['not ok 1 - exhibit census remains current', '  ---', "  location: '/virtual/checkout/skills/ux/exhibits.test.mjs:73:1'", '  ...'].join('\n')
const redOut = (stdout) => ({ ...redRun(1), stdout })
const builderTurns = (f) => f.requests.filter((r) => r.role === 'builder')

test('a red suite tail keeps the failing line past the tail bound', async () => {
  for (const line of ['FAIL [ 0.123s] crate::module test_name', 'test path::name ... FAILED', ' FAIL  src/widget.test.ts > widget > renders', '  × handles input 12ms', '✖ node failure (2ms)', 'not ok 1 - tap failure']) {
    const f = sequenced([redOut(`${line}\n${'trailing output\n'.repeat(200)}`), green()])
    await f.go()
    const tail = builderTurns(f)[1].feedback.find((item) => item.id === 'suite-repair').outputTail[0]
    assert.ok(tail.includes(line), line)
    assert.ok(tail.length <= 2000, `tail length: ${tail.length}`)
    assert.ok(tail.endsWith('trailing output\n'))
  }
  const early = `✖ ${'early'.repeat(30)}`
  const displaced = '✖ displaced failure (2ms)'
  const displacedRun = sequenced([redOut(`${early}\n${'padding\n'.repeat(40)}${displaced}\n${'z'.repeat(1950)}`), green()])
  await displacedRun.go()
  const displacedTail = builderTurns(displacedRun)[1].feedback.find((item) => item.id === 'suite-repair').outputTail[0]
  assert.ok(displacedTail.includes(early))
  assert.ok(displacedTail.includes(displaced))
  assert.ok(displacedTail.length <= 2000)

  const longLines = [`✖ ${'a'.repeat(598)}`, `✖ ${'b'.repeat(598)}`]
  const longRun = sequenced([redOut(`${longLines.join('\n')}\n${'z'.repeat(2000)}`), green()])
  await longRun.go()
  const longTail = builderTurns(longRun)[1].feedback.find((item) => item.id === 'suite-repair').outputTail[0]
  for (const line of longLines) assert.ok(longTail.includes(line))
  assert.ok(longTail.length <= 2000)

  const summary = Array.from({ length: 21 }, (_, i) => `✖ failure ${i} with a long test name (2ms)\ntest at /virtual/checkout/long/path/test-${i}.test.mjs:42:1\n  AssertionError: diagnostic ${i}`).join('\n')
  const nodeRun = sequenced([redOut(`${'earlier output\n'.repeat(200)}failing tests:\n${summary}`), green()])
  await nodeRun.go()
  const nodeTail = builderTurns(nodeRun)[1].feedback.find((item) => item.id === 'suite-repair').outputTail[0]
  assert.ok(nodeTail.includes('AssertionError: diagnostic 20'))
  assert.ok(nodeTail.length <= 2000)

  for (const count of [10, 20]) {
    const blocks = Array.from({ length: count }, (_, i) => [
      `✖ failure ${i} ${'long test name '.repeat(4)}(2ms)`,
      `test at /virtual/checkout/${'long-path/'.repeat(4)}test-${i}.test.mjs:42:1`,
      `  AssertionError: diagnostic ${i} ${'details '.repeat(8)}`,
      ...Array.from({ length: 7 }, (_, frame) => `    at frame${frame} (/virtual/checkout/${'stack-path/'.repeat(5)}file.mjs:42:1)`),
    ].join('\n')).join('\n')
    const f = sequenced([redOut(`failing tests:\n${blocks}`), green()])
    await f.go()
    const tail = builderTurns(f)[1].feedback.find((item) => item.id === 'suite-repair').outputTail[0]
    assert.ok(tail.includes('AssertionError:'), `${count} failures lost diagnostics`)
    assert.ok(tail.length <= 2000, `${count} failures: tail length ${tail.length}`)
  }
})
// MUTATION: retry a repaired red or let it reach commit and publication.
test('a finish red after repair stops without an unchanged-tree retry', async () => {
  const after = { ...redRun(2), stderr: TAP_OUT }
  const f = sequenced([redOut(SPEC_OUT), after, green()], { spec: finishSpec(), checkedTree: () => ({ ...green(), stdout: String(count(f, 'builder')).repeat(40) }) })
  assert.deepEqual(await f.go(), stopped('exit-nonzero'))
  assert.equal(builderTurns(f).length, 2)
  assert.equal(f.inputs.length, 2)
  assert.deepEqual(f.calls.slice(f.calls.indexOf('suite')), ['suite', 'seat:builder', 'build-paths', 'proof', 'review-paths', 'suite-stage', 'checked-tree', 'seat:reviewer', 'suite'])
  assert.equal(f.calls.filter((c) => c === 'proof').length, 2)
  assert.equal(count(f, 'reviewer'), 2)
  assert.deepEqual(f.rows.findLast((r) => r.status === 'stopped').observation, after)
  assert.deepEqual(f.rows.filter((r) => r.event === 'check' && r.check === 'suite').map((r) => r.result.status), ['red', 'red'])
  for (const effect of PUBLISH_EFFECTS) assert.equal(f.calls.slice(f.calls.indexOf('seat:builder')).includes(effect), false, effect)
  assert.equal(f.writes.has('/virtual/task/finish-report.json'), false)
})

// MUTATION: let an unmeasured check or non-done repair bounce into more builders.
test('an unmeasured post-repair suite or non-done finish repair stops without publication', async () => {
  for (const post of [timeoutRun(), new Error('crashed'), { ...green(), code: 4 }]) {
    const r = sequenced([redRun(), post, green()], { spec: finishSpec() })
    assert.equal((await r.go()).status, 'stopped')
    assert.equal(builderTurns(r).length, 2)
    assert.equal(r.inputs.length, 2)
    for (const effect of PUBLISH_EFFECTS) assert.equal(r.calls.slice(r.calls.indexOf('seat:builder')).includes(effect), false, effect)
  }
  for (const status of ['insufficient', 'escalate']) {
    const r = sequenced([redRun(), green()], { spec: finishSpec(), lead: 'bounce', edit: (v, req) => req.role === 'builder' && req.feedback.some((item) => item.id === 'suite-repair') ? { ...v, status } : v })
    assert.equal((await r.go()).status, 'stopped')
    assert.equal(builderTurns(r).length, 2)
    assert.equal(count(r, 'lead'), 0)
    for (const effect of PUBLISH_EFFECTS) assert.equal(r.calls.slice(r.calls.indexOf('seat:builder')).includes(effect), false, effect)
  }
})

test('three ref-lock fetch failures stop with the last attempt (#2400)', async () => {
  for (const finish of [false, true]) for (const afterCommit of [false, true]) {
    const failures = [1, 2, 3].map((n) => ({ ...redRun(128), stderr: `cannot lock ref: attempt ${n}` }))
    const results = [...(afterCommit ? [green(), green()] : []), ...failures]
    const waits = [], next = answers(...results)
    const f = fakes({ spec: finish ? finishSpec() : {}, fetch: next,
      deps: { sleep: async (ms) => { waits.push(ms); f.calls.push(`sleep:${ms}`) } } })
    assert.deepEqual(await f.go(), stopped('exit-nonzero'))
    assert.deepEqual(waits, [1000, 2000])
    const start = afterCommit ? f.calls.indexOf('commit') + 1 : f.calls.indexOf('fetch')
    assert.deepEqual(f.calls.slice(start), ['fetch', 'sleep:1000', 'fetch', 'sleep:2000', 'fetch'])
    assert.deepEqual(f.rows.filter((r) => r.event === 'check' && r.check === 'fetch').map((r) => r.result),
      results.map((r) => ({ ...r, stdoutBytes: 0, stderrBytes: Buffer.byteLength(r.stderr) })))
    assert.deepEqual(f.rows.find((r) => r.event === 'verdict' && r.status === 'stopped').observation, failures[2])
  }
})

// MUTATION: continue past a failed publication effect and a later effect runs on an unproven state.
test('a failed commit, fetch, rebase or publish stops every later effect and returns one enum reason', async () => {
  const bad = (reason) => ({ status: 'red', reason })
  const cases = [
    [{ commit: bad('nothing-to-commit') }, 'nothing-to-commit', 'commit'],
    [{ commit: { status: 'green', reason: null } }, 'runner-threw', 'commit'],
    [{ fetch: { ...green(), status: 'unmeasured', code: null, reason: 'timeout' } }, 'timeout', 'fetch'],
    [{ fetch: { ...green(), code: 128 } }, 'runner-threw', 'fetch'],
    [{ rebase: { status: 'red', reason: 'rebase-conflict', conflicts: ['x'] } }, 'rebase-conflict', 'rebase'],
    [{ rebase: { status: 'green', reason: null } }, 'runner-threw', 'rebase'],
    [{ publish: { status: 'unmeasured', reason: 'pr-unmeasured' } }, 'pr-unmeasured', 'publish'],
    [{ publish: { status: 'green', reason: null, pr: null } }, 'runner-threw', 'publish'],
    [{ publish: { status: 'green', reason: null } }, 'runner-threw', 'publish'],
    [{ publish: { status: 'red', reason: 'invented' } }, 'runner-threw', 'publish'],
  ]
  for (const [options, reason, failedAt] of cases) {
    const f = fakes(options)
    assert.deepEqual(await f.go(), stopped(reason), failedAt)
    const order = ['commit', 'fetch', 'rebase', 'publish']
    assert.deepEqual(f.calls.filter((c) => order.includes(c)), ['fetch', ...(failedAt === 'fetch' ? [] : ['rebase']), ...(failedAt === 'fetch' || failedAt === 'rebase' ? [] : ['fetch', ...order.slice(0, order.indexOf(failedAt) + 1)])])
    assert.ok(LOOP_REASONS.includes(reason))
  }
  const thrown = fakes({ throwCheck: 'rebase' })
  assert.deepEqual(await thrown.go(), stopped('runner-threw'))
  assert.equal(thrown.calls.includes('publish'), false)
})

// MUTATION: close a stage only after its work succeeds and a stage that throws is left open in the journal.
test('a stage whose work throws still ends in the journal and the lane stops runner-threw', async () => {
  // a rejection with no string form makes describe() throw inside the seat turn, so the exception reaches the stage
  const f = fakes({ deps: { runSeat: async () => { throw Object.create(null) } } })
  assert.deepEqual(await f.go(), stopped('runner-threw'))
  const ends = f.rows.filter((r) => r.event === 'stage-start' || r.event === 'stage-end')
  assert.deepEqual(ends.map((r) => [r.event, r.stage]), [['stage-start', 'plan'], ['stage-end', 'plan']])
  assert.equal(typeof ends[1].outcome.threw.message, 'string')
})

test('a failing journal append leaves the lane outcome unchanged and the result carries the unwritten count and the described error', async () => {
  for (const mode of ['sync', 'async', 'reject']) for (const stoppedRun of [false, true]) {
    let count = 0
    const error = Object.assign(new Error('first failure'), { code: 'EPERM' })
    const next = () => ++count === 1 ? error : new Error('later failure')
    const journal = mode === 'sync' ? () => { throw next() } : mode === 'async' ? async () => { throw next() } : () => Promise.reject(next())
    const options = stoppedRun ? { proof: { status: 'unmeasured', reason: 'timeout', rows: [] } } : {}
    const expected = await fakes(options).go()
    const result = await fakes({ ...options, journal }).go()
    assert.deepEqual({ status: result.status, reason: result.reason, pr: result.pr }, expected)
    assert.deepEqual(result.journal, { unwritten: count, error: { code: 'EPERM', message: 'first failure' } })
    assert.ok(count > 0)
  }
  const result = await fakes({ journal: () => { throw Object.create(null) } }).go()
  assert.deepEqual(result.journal.error, { code: null, message: 'unprintable error' })
})

// MUTATION: skip input validation and an unsupported or malformed lane starts effects.
test('an unsupported shape, invalid input or unsound seam is refused before dependency effects', async () => {
  const cases = [
    [{ shape: 'stepped' }, 'unsupported-shape'], [{ shape: 'finish' }, 'invalid-input'], [{ shape: undefined }, 'unsupported-shape'],
    [{ tier: 'rigorous' }, 'invalid-input'], [{ id: '' }, 'invalid-input'], [{ cwd: 3 }, 'invalid-input'], [{ taskDir: undefined }, 'invalid-input'],
    [{ brief: '' }, 'invalid-input'],
    [{ suite: null }, 'invalid-input'], [{ suite: { command: '' } }, 'invalid-input'],
    [{ source: '' }, 'invalid-input'], [{ source: undefined }, 'invalid-input'], [{ source: 7 }, 'invalid-input'], [{ branch: undefined }, 'invalid-input'], [{ base: undefined }, 'invalid-input'],
    [{ closes: 12 }, 'invalid-input'],
  ]
  for (const [spec, reason] of cases) {
    const f = fakes({ spec })
    assert.deepEqual(await f.go(), stopped(reason), JSON.stringify(spec))
    assert.deepEqual(f.calls, [])
    assert.deepEqual(f.rows, spec.id === '' || Object.hasOwn(spec, 'taskDir') && spec.taskDir === undefined ? [] : [{ event: 'verdict', lane: 'lane', stage: null, status: 'stopped', reason, at: 0 }])
  }
  for (const name of ['runSeat', 'journal', 'readFile', 'proveTests', 'openPullRequest', 'run']) {
    const f = fakes({ deps: { [name]: undefined } })
    assert.deepEqual(await f.go(), stopped('invalid-input'), name)
    assert.deepEqual(f.calls, [])
    assert.deepEqual(f.rows, name === 'journal' ? [] : [{ event: 'verdict', lane: 'lane', stage: null, status: 'stopped', reason: 'invalid-input', at: 0 }])
  }
  assert.deepEqual(await runLoop(null, {}), stopped('invalid-input'))
  const { status, reason, pr } = await runLoop(fakes().spec)
  assert.deepEqual({ status, reason, pr }, stopped('invalid-input'))
})

// MUTATION: let a mkdir failure continue and the seats write into a task directory that does not exist.
test('a task directory that cannot be made stops the lane before any seat', async () => {
  const f = fakes({ deps: { mkdir: async () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) } } })
  assert.deepEqual(await f.go(), stopped('runner-threw'))
  assert.equal(count(f, 'planner'), 0)
})

test('a protected path the suite writes after the review-time path check stops the lane before the commit', async () => {
  for (const spec of [{ tier: 'mechanical' }, {}]) {
    const f = fakes({ spec, unseated: spec.tier ? ['planner', 'reviewer', 'lead'] : [], paths: ' M lib.mjs\0 M crew/loop.mjs\0',
      edit: (v) => { if (v.role === 'builder') v.details.subject = 'docs(crew): fix typo'; return v } })
    assert.deepEqual(await f.go(), stopped('dirty-worktree'), spec.tier ?? 'build')
    assert.equal(f.calls.includes('commit'), false)
    assert.equal(f.rows.some((r) => r.event === 'tier-raised'), false)
  }
  const raised = fakes({ reviewPaths: ' M crew/loop.mjs\0', paths: 'M  crew/loop.mjs\0' })
  assert.equal((await raised.go()).status, 'done')
})

// MUTATION: commit anyway when the status read is unusable and unmeasured paths are committed as an empty list.
test('a changed-path read that is denied, interrupted, non-green or malformed stops before the commit', async () => {
  const bad = (fields) => ({ pathsResult: { ...green(), stdout: ' M a.mjs\0', ...fields } })
  const cases = {
    'EPERM': { throwCheck: 'paths' },
    'ENOENT': bad({ status: 'unmeasured', reason: 'spawn-failed', code: null, stdout: '' }),
    'EINTR': bad({ status: 'unmeasured', reason: 'interrupted', code: null, signal: 'SIGINT' }),
    'red': bad({ status: 'red', reason: 'exit-nonzero', code: 128 }),
    'signal': bad({ signal: 'SIGKILL' }),
    'timeout': bad({ timedOut: true }),
    'nonzero green': bad({ code: 1 }),
    'no stdout': bad({ stdout: undefined }),
    'truncated': { paths: ' M a.mjs' },
    'dangling rename': { paths: 'R  new.mjs\0' },
    'empty source': { paths: 'R  new.mjs\0\0' },
    'short record': { paths: ' M\0' },
    'bad status': { paths: 'xx a.mjs\0' },
    'quoted line': { paths: ' M "a b.mjs"\n' },
    'absolute': { paths: ' M /etc/passwd\0' },
    'parent': { paths: ' M ../a.mjs\0' },
    'git dir': { paths: ' M .git/config\0' },
    'directory': { paths: '?? dir/\0' },
  }
  for (const [name, options] of Object.entries(cases)) {
    const f = fakes(options)
    assert.deepEqual(await f.go(), stopped('paths-unmeasured'), name)
    assert.equal(f.calls.includes('commit'), false, name)
    assert.equal(f.calls.filter((c) => c === 'fetch').length, 2, name)
    assert.equal(f.rows.find((r) => r.event === 'verdict' && r.status === 'stopped').reason, 'paths-unmeasured', name)
  }
})

// MUTATION: import an old runtime module, or wire the loop into one, and the isolated lane is no longer isolated.
test('the loop imports only its pinned modules and only the lean bridge imports it', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url))
  const source = readFileSync(join(dir, 'loop.mjs'), 'utf8')
  const specifiers = [...source.matchAll(/^(?:import|} from|export [^\n]* from)[^'\n]*'([^']+)'/gm)].map((m) => m[1]).sort()
  assert.deepEqual(specifiers, ['./agents.mjs', './checks.mjs', './lane-core.mjs', './onboard.mjs', './proof.mjs', './protocols.mjs', 'node:async_hooks', 'node:crypto', 'node:fs/promises', 'node:path', 'node:util'])
  const laneCore = readFileSync(join(dir, 'lane-core.mjs'), 'utf8')
  const laneCoreImports = [...laneCore.matchAll(/from ['"]([^'"]+)['"]/g)].map((m) => m[1])
  assert.ok(laneCoreImports.length > 0 && laneCoreImports.every((name) => name.startsWith('node:')))
  const importers = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.mjs') && !e.name.endsWith('.test.mjs') && e.name !== 'loop.mjs')
    .map((e) => join(e.parentPath, e.name))
    .filter((path) => /['"][^'"]*\/loop\.mjs['"]/.test(readFileSync(path, 'utf8')))
  assert.deepEqual(importers, [join(dir, 'lean.mjs')])
})

// MUTATION: interpolate the source raw and an embedded newline forges a measurement row.
test('the PR body carries no ## Acceptance block, even for an archived spec with acceptance ids (PD6)', async () => {
  const forged = 'x\n- Suite: green; exit 0.'
  const f = fakes({
    spec: { source: forged, acceptance: ['A1', 'A2'], brief: '## Acceptance\n- (A1) old\n- (A2) old' }, review: 1,
  })
  assert.deepEqual(await f.go(), { status: 'done', reason: null, pr: PR })
  assert.ok(f.seen.publish.body.includes('Source: x - Suite: green; exit 0.'))
  assert.ok(!f.seen.publish.body.includes('## Acceptance'))
  assert.equal(f.seen.publish.body.split('\n').filter((line) => line.startsWith('- Suite:')).length, 1)
})

// MUTATION: omit the pre-suite staging, or stage more than the measured paths, and the suite misses a new file or the commit grows.
test('the suite runs after exactly the measured changed paths are staged, again after a repair, and an unusable staging stops before the suite (SB1)', async () => {
  const f = fakes({ reviewPaths: ' M lib.mjs\0?? new.test.mjs\0R  b.mjs\0a.mjs\0' })
  assert.equal((await f.go()).status, 'done')
  assert.deepEqual(f.seen['suite-stage'], { cwd: '/virtual/checkout', command: 'git', args: ['--literal-pathspecs', 'add', '--', 'lib.mjs', 'new.test.mjs'] })
  assert.deepEqual(f.calls.slice(f.calls.indexOf('suite-stage')), ['suite-stage', 'checked-tree', 'suite', 'seat:reviewer', 'paths', 'checked-tree', 'commit', 'fetch', 'rebase', 'publish'])
  const r = sequenced([redRun(1), green()], { checkedTree: () => ({ ...green(), stdout: String(count(r, 'builder')).repeat(40) }) })
  assert.equal((await r.go()).status, 'done')
  assert.equal(r.calls.filter((c) => c === 'suite-stage').length, 2)
  const at = r.calls.lastIndexOf('seat:builder')
  assert.deepEqual(r.calls.slice(at), ['seat:builder', 'build-paths', 'proof', 'review-paths', 'suite-stage', 'checked-tree', 'suite', 'seat:reviewer', 'paths', 'checked-tree', ...EFFECTS.slice(1)])
  for (const stageResult of [{ ...green(), status: 'red', code: 1, reason: 'exit-nonzero' }, { ...green(), code: 3 }, { status: 'unmeasured', reason: 'timeout' }]) {
    const g = fakes({ stageResult })
    assert.equal((await g.go()).status, 'stopped')
    for (const later of ['suite', 'commit', 'publish']) assert.equal(g.calls.includes(later), false, later)
  }
})

// MUTATION: stage every changed path (a staged deletion or a rename source has no pathspec) and the stage stops the lane before the suite.
test('with real git the suite sees a new file and staging survives a staged deletion, a staged rename and a deletion through suite repair (SB1)', async () => {
  const dir = scratchDir('lean-stage-')
  {
    const g = (...args) => repoGit(dir, ...args)
    g('init', '-q')
    for (const name of ['lib.mjs', 'gone.txt', 'moved.txt', 'later.txt']) writeFileSync(join(dir, name), `${name}\n`)
    g('add', '.'); g('commit', '-qm', 'base')
    g('rm', '-q', 'gone.txt'); g('mv', 'moved.txt', 'renamed.txt')
    writeFileSync(join(dir, 'lib.mjs'), 'changed\n'); writeFileSync(join(dir, 'new.test.mjs'), 'new\n'); unlinkSync(join(dir, 'later.txt'))
    const real = (input) => {
      try { return { ...green(), stdout: execFileSync(input.command, input.args, { cwd: dir, encoding: 'utf8' }) } } catch (error) { return { ...green(), status: 'red', code: error.status ?? 1, reason: 'exit-nonzero', stderr: String(error.stderr) } }
    }
    const f = sequenced([redRun(1), green()], { spec: { cwd: dir } })
    const listed = []
    const fallback = f.deps.run
    f.deps.run = async (input) => (input.command === 'git' && (input.args.includes('add') || input.args.includes('status'))) ? real(input) : fallback(input)
    const suite = f.deps.runSuite
    f.deps.runSuite = async (input) => { listed.push(g('ls-files').split('\n')); return suite(input) }
    assert.deepEqual(await f.go(), { status: 'done', reason: null, pr: PR })
    assert.equal(listed.length, 2)
    for (const files of listed) {
      assert.ok(files.includes('new.test.mjs'))
      assert.ok(files.includes('renamed.txt'))
      assert.equal(files.includes('later.txt') || files.includes('gone.txt') || files.includes('moved.txt'), false)
    }
    assert.equal(f.calls.filter((c) => c === 'seat:builder').length, 2)
  }
})

// ---- finish shape (lean plan 3.5): a stopped lane re-entered by its builder ----
const STOP = { reason: 'mutations-survived', observation: { stage: 'mutations', detail: 'A1 survived' } }
const finishSpec = (over = {}) => ({
  shape: 'finish',
  finish: { planPath: '/virtual/task/plan.md', subject: 'fix(crew): planned lane', mutations: [MUTATION], stop: STOP, findings: [finding], turnOffset: 3, ...over },
})
test('a build suite re-run stop preserves the review finding for the returned builder', async () => {
  const root = scratchDir(), taskDir = join(root, 'dt-lane', 'lane', 'task')
  mkdirSync(taskDir, { recursive: true })
  const plan = 'Preserve the review finding.\n'
  const red = { ...redRun(), stderr: 'open test store: Database(PoolTimedOut)' }
  const f = sequenced([red, red], { review: 1, plan, spec: { cwd: root, taskDir, environmentSignatures: ['PoolTimedOut'] } })
  assert.deepEqual(await f.go(), stopped('red-after-environment-rerun'))

  writeFileSync(join(taskDir, 'lean.json'), JSON.stringify(f.spec))
  writeFileSync(join(taskDir, 'plan.md'), plan)
  writeFileSync(join(taskDir, 'planner-1.json'), await f.deps.readFile(f.requests[0].returnPath))
  writeFileSync(join(taskDir, 'journal.jsonl'), f.rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  const guidance = join(root, 'guidance.txt')
  writeFileSync(guidance, 'Fix the review finding.')
  const launched = await decideFinish({ lane: 'lane', root, choice: 'return', file: guidance, deps: {
    spawnDetached: () => 4242, holdIdleSleep: () => {}, log: () => {},
  } })
  const returned = fakes({ spec: JSON.parse(readFileSync(launched.specPath, 'utf8')) })
  assert.deepEqual(await returned.go(), { status: 'done', reason: null, pr: null })
  assert.deepEqual(builderTurns(returned)[0].feedback.filter((item) => item.id === finding.id), [finding])

  const verdicts = f.rows.filter((row) => row.event === 'verdict')
  assert.deepEqual(verdicts.map((row) => row.status), ['reviewed', 'stopped'])
  assert.equal(verdicts[0].verdict, 'changes-needed')
  assert.deepEqual(verdicts[0].findings, [finding])
})

test('a finish consult distinguishes imported tech-lead findings from reviewer findings with the same id (#2375)', async () => {
  for (const role of ['reviewer', 'tech-lead', 'mixed']) {
    const root = scratchDir(), task = join(root, 'dt-lane', 'lane', 'task')
    mkdirSync(task, { recursive: true })
    const planner = { role: 'planner', id: 'lane.planner.1', status: 'done', summary: 'planned', details: { subject: 'fix(crew): planned lane', plan_path: '/virtual/task/plan.md', tests: [{ file: 'lib.test.mjs', title: 'works' }], files_in_scope: ['lib.mjs'] } }
    const builder = { role: 'builder', id: 'lane.builder.2', status: 'done', summary: 'built', details: { summary: 'built', tests: [{ file: 'lib.test.mjs', title: 'works' }] } }
    const rows = [
      { event: 'envelope', role: 'planner', id: planner.id, parsed: planner, defects: [], error: null },
      { event: 'envelope', role: 'builder', id: builder.id, parsed: builder, defects: [], error: null },
      ...(role === 'mixed' ? [{ event: 'verdict', status: 'reviewed', verdict: 'changes-needed', findings: [{ ...finding, id: 'R2' }] }] : []),
      { event: 'verdict', status: 'reviewed', role: role === 'mixed' ? 'tech-lead' : role, verdict: 'changes-needed', findings: [{ ...finding, id: 'T1' }] },
      { event: 'verdict', status: 'stopped', stage: 'build', reason: 'round-bound' },
    ]
    writeFileSync(join(task, 'lean.json'), JSON.stringify({ ...fakes().spec, cwd: root, taskDir: task, tier: 'judge' }))
    writeFileSync(join(task, 'planner-1.json'), JSON.stringify(planner))
    writeFileSync(join(task, 'journal.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
    finishLane({ lane: 'lane', root, deps: { platform: 'linux', log: () => {}, spawnDetached: () => 4242 } })
    const finish = JSON.parse(readFileSync(join(task, 'finish.json'), 'utf8')).finish
    let state = 0, builds = 0
    const f = fakes({ spec: { shape: 'finish', tier: 'judge', finish }, review: 1, lead: 'bounce', deps: { repoState: () => String(state++) }, edit: (v) => {
      if (v.role === 'builder' && ++builds === 1) return { ...v, status: 'insufficient', details: { ...v.details, gap: 'gap' } }
      if (v.role === 'reviewer' && v.details.verdict === 'changes-needed') {
        v.details.findings = [{ ...finding, id: 'T1' }]
        v.details.closed = role === 'mixed' ? [{ id: 'R2', evidence: 'fixed' }] : []
      }
      return v
    } })
    assert.equal((await f.go()).status, 'done', role)
    assert.equal(f.requests.filter((r) => r.role === 'lead').length, 2, role)
    assert.equal(f.rows.filter((r) => r.event === 'lead-bound-refund').length, role === 'reviewer' ? 1 : 2, role)
  }
})

test('a finish run builder receives the lead rulings from its finish spec (#2341)', async () => {
  const rulings = [{ id: 'lead-bounce', summary: 'ruling 0' }]
  const f = fakes({ spec: finishSpec({ rulings }), unseated: ['planner'] })
  assert.equal((await f.go()).status, 'done')
  assert.ok(builderTurns(f)[0].feedback.some((item) => item.id === rulings[0].id && item.summary === rulings[0].summary))
  for (const bad of [null, {}, [null], [{}], [{ summary: '' }]]) {
    assert.equal((await fakes({ spec: finishSpec({ rulings: bad }), unseated: ['planner'] }).go()).reason, 'invalid-input')
  }
})

test('a pre-build planning return resumes planning and publishes without accept', async () => {
  const plan = { role: 'planner', id: 'lane.planner.1', status: 'done', summary: 'Held plan', details: {
    subject: 'fix(crew): held plan', plan_path: '/virtual/task/plan.md', tests: [], files_in_scope: ['held.mjs'],
  } }
  for (const [decision, archived] of [['plan', false], ['accept', false], ['accept', true], ['bounce', false], ['escalate', false]]) {
    const plannerEntry = decision === 'plan'
    const held = plannerEntry ? { role: 'planner', id: plan.id, status: 'escalate', summary: 'Baseline unresolved', details: { question: 'Approve the baseline?' } } : structuredClone(plan)
    if (archived) delete held.details.tests
    const guidance = 'The baseline is approved.'
    const testsRequired = decision !== 'accept' || archived
    const retryProof = testsRequired && !plannerEntry
    let builds = 0
    const observation = { question: 'Approve the baseline?', stderr: `${'x'.repeat(5000)}final diagnostic\n` }
    const f = fakes({ spec: finishSpec({ subject: null, planPath: null, findings: [], turnOffset: 80, guidance,
      stop: { reason: plannerEntry ? 'seat-escalated' : STOP.reason, observation },
      planning: { entry: plannerEntry ? 'planner' : 'lead', plan: plannerEntry ? null : held, planner: { returnPath: '/virtual/task/planner-1.json', parsed: held, defects: [], error: null }, observation } }),
      lead: decision, target: 'planner', edit: (v) => {
        if (v.role === 'builder' && (!testsRequired || (retryProof && ++builds === 1))) v.details.tests = []
        if (v.role === 'lead') {
          if (decision === 'bounce') v.details.instructions = 'Revise the plan with the approved baseline.'
          if (decision === 'escalate') v.details.question = 'Which new checklist should I use?'
        }
        return v
      } })
    const result = await f.go()
    const entry = plannerEntry ? 'planner' : 'lead'
    assert.deepEqual(f.requests.map((r) => r.role), [entry, ...(decision === 'escalate' ? [] : [...(decision === 'bounce' ? ['planner'] : []), 'builder', ...(retryProof ? ['builder'] : []), 'reviewer'])], decision)
    assert.equal(f.requests[0].id, `lane.${entry}.81`)
    if (!plannerEntry) assert.deepEqual(f.requests[0].feedback[0].envelope, held)
    for (const r of f.requests.filter((r) => ['lead', 'planner'].includes(r.role))) {
      assert.equal(r.feedback.find((item) => item.id === 'finish-return').guidance, guidance)
      const { observation: resumed } = r.feedback.find((item) => item.id === 'planning-resume')
      assert.equal(resumed.question, observation.question)
      assert.ok(!Object.hasOwn(resumed, 'stderr'), 'raw stderr must not reach the planning seat')
      assert.equal(resumed.outputTail.length, 1)
      assert.ok(resumed.outputTail[0].length <= 2000)
      assert.ok(resumed.outputTail[0].endsWith('final diagnostic\n'))
    }
    if (decision === 'escalate') {
      assert.equal(result.reason, 'lead-escalated')
      assert.equal(f.rows.at(-1).observation.question, 'Which new checklist should I use?')
      assert.equal(f.rows.some((r) => r.event === 'finish-ready'), false)
      assert.equal(f.calls.includes('fetch'), false)
      assert.equal(f.calls.includes('publish'), false)
    } else {
      assert.deepEqual(result, { status: 'done', reason: null, pr: PR }, decision)
      assert.deepEqual(f.rows.find((r) => r.event === 'pr')?.pr, PR)
      assert.equal(f.rows.some((r) => r.event === 'finish-ready'), false)
      const builder = f.requests.find((r) => r.role === 'builder')
      assert.equal(builder.planPath, plan.details.plan_path)
      // The first builder turn after a planning return still gets the stop, clipped, and the operator guidance.
      const stopItem = builder.feedback.find((item) => item.id === 'finish-stop')
      assert.ok(stopItem, decision)
      if (plannerEntry) assert.ok(stopItem.observation.stderr === undefined && Array.isArray(stopItem.observation.outputTail))
      assert.equal(builder.feedback.find((item) => item.id === 'finish-return')?.guidance, guidance)
      assert.deepEqual(builder.filesInScope, decision === 'accept' ? ['held.mjs'] : ['lib.mjs'])
      assert.equal(builder.testsRequired, testsRequired)
      if (retryProof) assert.equal(builderTurns(f)[1].feedback[0].id, 'proof-no-tests')
      assert.equal(f.calls.includes('proof'), testsRequired)
      if (!testsRequired) {
        assert.match(f.seen.commit.body, /proof: none, no criterion is machine-checked/)
        assert.match(f.seen.publish.body, /Proof: no criterion is machine-checked\./)
      }
      assert.equal(f.seen.publish.title, f.seen.commit.subject)
      assert.equal(f.seen.commit.subject, decision === 'accept' ? plan.details.subject : 'fix(crew): planned lane')
      if (decision === 'bounce') assert.ok(f.requests[1].feedback.some((item) => item.id === 'lead-bounce' && item.summary === 'Revise the plan with the approved baseline.'))
    }
    assert.ok(!f.discardArgs.some((args) => args.includes('--hard') || args.includes('clean')))
  }
})

test('a committed finish-ready return after conflict resolution proves against the rebase base and ends with one commit (#2399)', async () => {
  await committedReadyReturn(true)
})

async function committedReadyReturn(conflict, stop = false) {
  const root = scratchDir('finish-return-'), cwd = join(root, 'checkout'), remote = join(root, 'origin.git')
  const taskDir = join(root, 'dt-lane', 'lane', 'task')
  mkdirSync(cwd); mkdirSync(taskDir, { recursive: true })
  const g = (...args) => repoGit(cwd, ...args)
  g('init', '-q', '-b', 'main')
  g('config', 'user.name', 'Crew Test'); g('config', 'user.email', 'crew@example.invalid')
  repoGit(root, 'init', '--bare', '-q', remote)
  g('remote', 'add', 'origin', remote)
  writeFileSync(join(cwd, 'lib.mjs'), "export const value = 'old'\n")
  g('add', '.'); g('commit', '-qm', 'base'); g('push', '-q', 'origin', 'main')
  g('checkout', '-qb', 'lane')
  const named = { file: 'new.test.mjs', title: 'the returned build works' }
  writeFileSync(join(cwd, 'lib.mjs'), "export const value = 'new'\n")
  writeFileSync(join(cwd, 'build.txt'), 'original build\n')
  writeFileSync(join(cwd, named.file), `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { value } from './lib.mjs'\ntest('${named.title}', () => assert.equal(value, 'new'))\n`)
  g('add', '.'); g('commit', '-qm', 'committed build')
  const head = g('rev-parse', 'HEAD').trim()
  if (conflict) {
    g('checkout', '-q', 'main')
    writeFileSync(join(cwd, 'lib.mjs'), "export const value = 'upstream'\n")
    g('add', '.'); g('commit', '-qm', 'advance base'); g('push', '-q', 'origin', 'main')
    g('checkout', '-q', 'lane')
  }
  const onto = g('rev-parse', 'refs/remotes/origin/main').trim()
  const planPath = join(taskDir, 'plan.md')
  const planner = { role: 'planner', id: 'lane.planner.1', status: 'done', summary: 'planned', details: {
    subject: 'fix(crew): returned build', plan_path: planPath, tests: [named], files_in_scope: ['lib.mjs', 'build.txt', named.file, 'return.txt'],
  } }
  const spec = { ...fakes().spec, cwd, taskDir, suite: { command: process.execPath, args: ['--test', named.file] } }
  const history = [
    { event: 'run-start', run_id: 'lane' },
    { event: 'envelope', role: 'planner', id: planner.id, parsed: planner, defects: [], error: null },
    { event: 'envelope', role: 'builder', id: 'lane.builder.2', parsed: { role: 'builder', id: 'lane.builder.2', status: 'done', summary: 'built', details: { summary: 'built', tests: [named] } }, defects: [], error: null },
    { event: 'verdict', stage: 'review', status: 'stopped', ...STOP },
    { event: 'commit', stage: 'commit', head },
    { event: 'finish-ready', status: 'ready-for-operator', head, subject: planner.details.subject, body: 'measured', reviewRounds: 1 },
  ]
  writeFileSync(planPath, 'Return the committed build.\n')
  writeFileSync(join(taskDir, 'planner-1.json'), JSON.stringify(planner))
  writeFileSync(join(taskDir, 'lean.json'), JSON.stringify(spec))
  const journal = join(taskDir, 'journal.jsonl')
  writeFileSync(journal, history.map((row) => JSON.stringify(row)).join('\n') + '\n')
  const guidance = join(root, 'guidance.txt')
  writeFileSync(guidance, 'Add the return edit and keep the original build.')
  assert.equal(g('status', '--porcelain'), '')
  let spawned = 0
  const launched = await decideFinish({ lane: 'lane', root, choice: 'return', file: guidance, deps: {
    platform: 'linux', spawnDetached: () => { spawned++; return 4242 }, log: () => {},
  } })
  assert.equal(spawned, 1)
  const finish = JSON.parse(readFileSync(launched.specPath, 'utf8'))
  const seats = fakes({ edit: (value) => {
    if (value.role === 'builder') {
      value.details.tests = [named]
      if (stop) {
        value.status = 'escalate'
        value.details.question = 'Which return edit should be kept?'
      }
    }
    return value
  } })
  const triageHeads = [], resolutions = []
  const result = await runLoop(finish, {
    resolveAgents: seats.deps.resolveAgents,
    runSeat: async (request) => {
      if (request.role === 'builder') {
        if (request.feedback.some((item) => item.id === 'rebase-conflict')) {
          resolutions.push(gitResult(cwd, 'rebase', 'origin/main').status)
          writeFileSync(join(cwd, 'lib.mjs'), "export const value = 'new'\nexport const resolved = true\n")
          g('add', 'lib.mjs'); g('-c', 'core.editor=true', 'rebase', '--continue')
        } else {
          triageHeads.push(g('rev-parse', 'HEAD').trim())
          writeFileSync(join(cwd, 'return.txt'), 'return edit\n')
        }
      }
      await seats.deps.runSeat(request)
      writeFileSync(request.returnPath, await seats.deps.readFile(request.returnPath))
    },
  })
  const rows = readFileSync(journal, 'utf8').trim().split('\n').map((row) => JSON.parse(row)).slice(history.length)
  if (stop) {
    assert.equal(result.reason, 'lead-escalated')
    assert.equal(g('rev-parse', 'HEAD').trim(), onto)
    assert.equal(readFileSync(join(cwd, 'build.txt'), 'utf8'), 'original build\n')
    assert.equal(readFileSync(join(cwd, 'return.txt'), 'utf8'), 'return edit\n')
    writeFileSync(guidance, 'Keep both edits and resume.')
    await decideFinish({ lane: 'lane', root, choice: 'return', file: guidance, deps: {
      platform: 'linux', spawnDetached: () => { spawned++; return 4243 }, log: () => {},
    } })
    assert.equal(spawned, 2)
    assert.equal(JSON.parse(readFileSync(launched.specPath, 'utf8')).finish.guidance, 'Keep both edits and resume.')
    return
  }
  const proof = rows.find((row) => row.event === 'check' && row.check === 'proof')?.result
  assert.deepEqual(proof?.rows.map((row) => [row.base.state, row.build.state, row.proven]), [['red', 'green', true]])
  assert.deepEqual(result, { status: 'done', reason: null, pr: null })
  const rebases = rows.filter((row) => row.event === 'stage-end' && row.stage === 'rebase')
  assert.deepEqual(rebases.map((row) => row.outcome.status), conflict ? ['red', 'green', 'green'] : ['green', 'green'])
  if (conflict) assert.equal(rebases[0].outcome.reason, 'rebase-conflict')
  const initial = rebases.find((row) => row.outcome.status === 'green')
  assert.equal(initial.outcome.onto, onto)
  assert.deepEqual(triageHeads, [initial.outcome.onto])
  assert.deepEqual(resolutions, conflict ? [1] : [])
  assert.equal(rows.filter((row) => row.event === 'stage-end' && row.stage === 'conflict').length, conflict ? 1 : 0)
  assert.ok(rows.indexOf(initial) < rows.findIndex((row) => row.event === 'stage-start' && row.stage === 'build'))
  assert.equal(readFileSync(join(cwd, 'lib.mjs'), 'utf8'), "export const value = 'new'\n" + (conflict ? 'export const resolved = true\n' : ''))
  assert.equal(readFileSync(join(cwd, 'build.txt'), 'utf8'), 'original build\n')
  assert.equal(readFileSync(join(cwd, 'return.txt'), 'utf8'), 'return edit\n')
  assert.ok(g('ls-tree', '--name-only', 'HEAD').split('\n').includes(named.file))
  assert.equal(g('status', '--porcelain'), '')
  assert.equal(rows.at(-1).event, 'finish-ready')
  assert.equal(rows.at(-1).head, g('rev-parse', 'HEAD').trim())
  assert.equal(g('rev-list', '--count', `${initial.outcome.onto}..HEAD`).trim(), '1')
}

// MUTATION: drop base-restore on a failed rebase and the build remains committed.
test('a finish run whose base rebase conflicts stops, names the conflicting paths and leaves the build uncommitted', async () => {
  for (const [rebase, reason, restore] of [
    [{ status: 'red', reason: 'rebase-conflict', conflicts: ['lib.mjs'] }, 'rebase-conflict', true],
    [{ status: 'unmeasured', reason: 'cleanup-unproven' }, 'cleanup-unproven', false],
    [{ status: 'green', reason: null, head: 'a'.repeat(40), onto: 'invalid' }, 'runner-threw', true],
  ]) {
    const f = fakes({ spec: finishSpec(), rebase })
    assert.deepEqual(await f.go(), stopped(reason))
    assert.equal(f.requests.length, reason === 'rebase-conflict' ? 1 : 0)
    if (reason !== 'rebase-conflict') assert.equal(f.calls.includes('base-restore'), restore)
    if (restore) {
      assert.deepEqual(f.discardArgs, [...(reason === 'rebase-conflict' ? [['reset', '--hard', 'a'.repeat(40)], ['clean', '-f', '-d']] : []), ['reset', '--soft', `${'a'.repeat(40)}^`]])
      if (reason === 'rebase-conflict') assert.deepEqual(f.rows.findLast((row) => row.status === 'stopped').observation.conflicts, ['lib.mjs'])
    }
  }
})

test('an uncounted finish review that asks for changes with the cap spent stops round-bound with its findings and no builder turn (#2374)', async () => {
  const A = 'a'.repeat(40), C = 'c'.repeat(40)
  for (const kind of ['repair', 'recheck']) {
    let reviews = 0
    const options = { spec: finishSpec({ priorReviewRounds: 2 }), unseated: ['planner'],
      checkedTree: () => ({ ...green(), stdout: String(f.calls.filter((c) => c === 'seat:builder' || c === 'uncommit').length).repeat(40) }), edit: (v) => {
      if (v.role === 'reviewer' && ++reviews === 2) v.details = { ...v.details, verdict: 'changes-needed', findings: [finding] }
      return v
    } }
    const f = kind === 'repair' ? sequenced([redRun(), green()], options) : fakes({ ...options,
      rebase: answers({ ...MOVED, head: A }, { ...MOVED, onto: O }, { ...MOVED, head: C, onto: O }),
      commit: answers({ status: 'green', reason: null, head: A, files: ['lib.mjs'] }, { status: 'green', reason: null, head: C, files: ['lib.mjs'] }) })
    assert.deepEqual(await f.go(), stopped('round-bound'), kind)
    const observation = f.rows.findLast((row) => row.status === 'stopped').observation
    assert.equal(observation.role, 'reviewer', kind)
    assert.equal(observation.envelope?.details.verdict, 'changes-needed', kind)
    assert.deepEqual(observation.findings, [finding], kind)
    assert.equal(count(f, 'builder'), kind === 'repair' ? 2 : 1, kind)
    assert.equal(count(f, 'lead'), 0, kind)
    assert.equal(f.requests.at(-1).role, 'reviewer', kind)
  }
})

// MUTATION: raise a planless finish and its next builder boots judge seats that refuse without a plan.
test('a mechanical finish whose diff reaches a protected path stops raise-needs-plan before the raise or the review', async () => {
  const f = fakes({ spec: { ...finishSpec({ planPath: null }), tier: 'mechanical' }, reviewPaths: ' M crew/loop.mjs\0' })
  assert.deepEqual(await f.go(), stopped('raise-needs-plan'))
  assert.deepEqual(f.requests.map((r) => r.role), ['builder'])
  assert.equal(f.rows.some((r) => r.event === 'tier-raised'), false)
  assert.deepEqual(f.rows.findLast((r) => r.status === 'stopped').observation, { reason: 'protected-path', paths: ['crew/loop.mjs'] })
  assert.equal(f.writes.size, 0)
  const planned = fakes({ spec: { ...finishSpec(), tier: 'build' }, reviewPaths: ' M crew/loop.mjs\0' })
  assert.equal((await planned.go()).status, 'done')
})

// MUTATION: change the unmeasured proof line.
test('finish without named tests reports unmeasured proof and standard reports each test', async () => {
  const f = fakes({ spec: finishSpec(), unseated: ['planner'], edit: (v) => { if (v.role === 'builder') delete v.details.tests; return v } })
  assert.equal((await f.go()).status, 'done')
  assert.equal(f.calls.includes('proof'), false)
  assert.ok(f.seen.commit.body.includes('- proof: unmeasured'))
  assert.ok(JSON.parse(f.writes.get('/virtual/task/finish-report.json')).body.includes('Proof: unmeasured.'))
  const standard = fakes()
  assert.equal((await standard.go()).status, 'done')
  assert.equal(standard.seen.commit.body.split('\n').filter((line) => line.startsWith('- proof:')).length, 1)
  assert.doesNotMatch(standard.seen.commit.body, /kill/i)
})

// MUTATION: flip isFinish && in the guard for a planner bounce from a finish builder.
test('a finish lead bounce to the planner is asked again with no planner to route to, and a last consult stops for the operator without another builder turn', async () => {
  for (const mode of ['finish', 'last', 'build', 'judge']) {
    let builds = 0, leads = 0
    const finish = mode === 'finish' || mode === 'last'
    const f = fakes({
      spec: finish ? finishSpec() : { tier: mode },
      ...(finish ? { unseated: ['planner'] } : {}),
      ...(mode === 'last' ? { bounds: { lead: 1 } } : {}),
      lead: 'bounce',
      edit: (v) => {
        if (v.role === 'builder' && ++builds === 1) return { ...v, status: 'insufficient', summary: 'gap' }
        if (v.role === 'lead') v.details.target = ++leads === 1 || mode === 'last' ? 'planner' : 'builder'
        return v
      },
    })
    const result = await f.go()
    const roles = f.requests.map((r) => r.role)
    const consults = f.requests.filter((r) => r.role === 'lead')
    for (const request of consults) assert.deepEqual(request.feedback[0].targets, finish ? ['builder'] : ['builder', 'planner'], mode)
    if (mode === 'last') {
      assert.deepEqual(result, stopped('lead-escalated'))
      assert.deepEqual(roles, ['builder', 'lead'])
      assert.match(f.rows.findLast((r) => r.event === 'verdict').observation.question, /gap/)
    } else if (finish) {
      assert.equal(result.status, 'done')
      assert.deepEqual(roles.slice(0, 4), ['builder', 'lead', 'lead', 'builder'])
      assert.ok(!roles.includes('planner'))
      const feedback = consults[1].feedback[0].feedback[0]
      assert.equal(feedback.id, 'finish-no-planner')
      assert.match(feedback.summary, /finish run has no planner.*bounce to builder.*escalate naming the plan gap/i)
    } else {
      assert.equal(result.status, 'done')
      assert.deepEqual(roles.slice(0, 5), ['planner', 'builder', 'lead', 'planner', 'builder'])
    }
  }
})

// MUTATION: drop the report write, the guidance entry or the prior-rounds deduction and the matching assertion fails.
test('a green finish run writes a fused report and a finish-ready row with the measured subject and body; a return pass keeps the cap (FD1, FD2, FD7)', async () => {
  const f = fakes({ spec: finishSpec(), unseated: ['planner'], review: 1, bounds: { builder: 3 } })
  assert.equal((await f.go()).status, 'done')
  const report = JSON.parse(f.writes.get('/virtual/task/finish-report.json'))
  assert.equal(report.stop.reason, STOP.reason)
  assert.deepEqual(report.reviews, [{ verdict: 'changes-needed', findings: [finding] }, { verdict: 'pass', findings: [] }])
  assert.equal(report.measurements.some((m) => m.startsWith('- Suite')), true)
  const ready = f.rows.at(-1)
  assert.deepEqual([ready.subject, ready.reviewRounds, ready.body.includes('## Verification')], ['fix(crew): planned lane', 2, true])
  assert.equal(ready.body, report.body)
  assert.ok(report.body.includes('The lane stopped with reason mutations-survived. This report covers only this finish run.\n2 reviews in this finish run; final verdict: pass.'))
  assert.equal(BODY.includes('## Finish'), false)
  assert.equal(Object.hasOwn(ready, 'mutations'), false)

  const g = fakes({ spec: finishSpec({ guidance: 'Fix it first', priorReviewRounds: 2 }), unseated: ['planner'], review: 2, bounds: { builder: 3 } })
  assert.deepEqual(await g.go(), stopped('round-bound'))
  assert.deepEqual(g.requests[0].feedback.slice(0, 2), [{ id: 'finish-stop', summary: 'The previous lane stopped with the given reason and observation.', reason: STOP.reason, observation: STOP.observation }, { id: 'finish-return', summary: 'The operator supplied guidance for this finish run. It stands for the whole finish run and outranks the plan and a lead ruling where they differ.', guidance: 'Fix it first' }])
  assert.equal(count(g, 'reviewer'), 1)
  for (const bad of [{ guidance: 5 }, { priorReviewRounds: -1 }, { priorReviewRounds: 1.5 }]) {
    assert.deepEqual(await fakes({ spec: finishSpec(bad), unseated: ['planner'] }).go(), stopped('invalid-input'))
  }
})

// MUTATION: drop the seat-escalated branch and the question stops round-bound.
test('a finish review or finish suite-repair escalate with a question stops seat-escalated with that question and no lead consult (S1-4)', async () => {
  const question = 'Keep or drop the public API?'
  for (const mode of ['review', 'repair', 'insufficient', 'questionless']) {
    let builds = 0
    const edit = (v) => {
      if (v.role === 'builder') builds++
      if ((mode === 'repair' && v.role === 'builder' && builds === 2) || (mode !== 'repair' && v.role === 'reviewer')) {
        v.status = mode === 'insufficient' ? 'insufficient' : 'escalate'
        if (mode !== 'insufficient' && mode !== 'questionless') v.details.question = question
      }
      return v
    }
    const options = { spec: finishSpec(), unseated: ['planner'], edit }
    const f = mode === 'repair' ? sequenced([redRun()], options) : fakes(options)
    assert.deepEqual(await f.go(), stopped('seat-escalated'), mode)
    assert.equal(count(f, 'lead'), 0)
    if (!['insufficient', 'questionless'].includes(mode)) {
      const observation = f.rows.findLast((r) => r.status === 'stopped').observation
      assert.equal(observation.question, question)
      assert.equal(observation.role, mode === 'repair' ? 'builder' : 'reviewer')
      assert.equal(observation.reason, 'escalate')
      assert.equal(observation.envelope.details.question, question)
    }
    assert.equal(f.calls.includes('commit'), false)
    assert.equal(f.rows.some((r) => r.event === 'finish-ready'), false)
  }
})

// MUTATION: restore the mechanical skip on the dropped-commit check.
test('a mechanical lane whose publishing rebase drops its commit as already upstream stops nothing-to-commit without reproving or publishing (S1-5)', async () => {
  for (const invalid of [false, true]) {
    const f = moved({ rebase: answers({ ...MOVED, head: 'a'.repeat(40) }, invalid ? { ...MOVED, onto: undefined } : { ...MOVED, head: O, onto: O }), cleanHead: `${invalid ? MOVED.head : O}\n` })
    assert.deepEqual(await f.go(), stopped(invalid ? 'runner-threw' : 'nothing-to-commit'))
    assert.equal(f.calls.filter((c) => c === 'proof').length, 1)
    assert.equal(f.calls.filter((c) => c === 'suite').length, 1)
    assert.equal(f.calls.includes('uncommit'), false)
    assert.equal(f.calls.includes('publish'), false)
    if (!invalid) assert.deepEqual(f.rows.findLast((r) => r.status === 'stopped').observation, { head: O, onto: O, committed: 'a'.repeat(40) })
  }
})

// MUTATION: drop the early journal write.
test('an early refusal journals one stopped verdict row with its reason, and none when the spec names no lane or task dir (D5)', async () => {
  for (const [options, reason] of [
    [{ spec: { shape: 'stepped' } }, 'unsupported-shape'],
    [{ spec: { brief: '' } }, 'invalid-input'],
    [{ spec: finishSpec({ turnOffset: -1 }) }, 'invalid-input'],
    [{ deps: { runSeat: undefined } }, 'invalid-input'],
    [{ unseated: ['builder'] }, 'seat-unmeasured'],
    [{ deps: { resolveAgents: () => { throw new Error('unavailable') } } }, 'seat-unmeasured'],
    [{ deps: { resolveAgents: () => ({ seats: { planner: { rounds: 0 }, builder: {}, reviewer: {} } }) } }, 'invalid-input'],
  ]) {
    const f = fakes(options)
    assert.deepEqual(await f.go(), stopped(reason))
    assert.deepEqual(f.calls, [])
    assert.deepEqual(f.rows, [{ event: 'verdict', lane: 'lane', stage: null, status: 'stopped', reason, at: 0 }])
  }
  for (const options of [{ spec: { id: '' } }, { spec: { taskDir: undefined } }, { deps: { journal: undefined } }]) {
    const f = fakes(options)
    assert.deepEqual(await f.go(), stopped('invalid-input'))
    assert.deepEqual(f.rows, [])
  }
  for (const journal of [() => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }) }, async () => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }) }]) {
    const f = fakes({ spec: { brief: '' }, deps: { journal } })
    assert.deepEqual(await f.go(), { ...stopped('invalid-input'), journal: { unwritten: 1, error: { code: 'ENOSPC', message: 'full' } } })
  }
  const taskDir = scratchDir('early-journal-')
  const f = fakes({ spec: { taskDir, brief: '' } })
  delete f.deps.journal
  assert.deepEqual(await f.go(), stopped('invalid-input'))
  assert.deepEqual(JSON.parse(readFileSync(join(taskDir, 'journal.jsonl'), 'utf8')), { event: 'verdict', lane: 'lane', stage: null, status: 'stopped', reason: 'invalid-input', at: 0 })
  for (const now of [() => NaN, () => { throw new Error('clock') }]) {
    const f = fakes({ spec: { brief: '' }, deps: { now } })
    assert.deepEqual(await f.go(), stopped('invalid-input'))
    assert.deepEqual(f.rows, [{ event: 'verdict', lane: 'lane', stage: null, status: 'stopped', reason: 'invalid-input' }])
  }
})

test('a lead accept of a mechanical builder escalate stops seat-escalated with the builder question and never commits (S1-4)', async () => {
  const f = fakes({ spec: { tier: 'mechanical' }, lead: 'accept', edit: (v) => {
    if (v.role === 'builder') { v.status = 'escalate'; v.details.question = 'Which file?' }
    return v
  } })
  assert.deepEqual(await f.go(), stopped('seat-escalated'))
  assert.equal(f.rows.find((r) => r.event === 'verdict' && r.reason === 'seat-escalated').observation.question, 'Which file?')
  assert.equal(f.calls.some((c) => c === 'commit' || c === 'publish'), false)
})

test('a test proven as base-package-absent says so in the commit and PR body, never red on the old source', async () => {
  const f = fakes({ proof: { status: 'green', reason: null, rows: [{ file: 'lib.test.mjs', title: 'works', proven: true, base: { state: null, reason: 'base-package-absent' }, build: { state: 'green', reason: null } }] } })
  assert.equal((await f.go()).status, 'done')
  assert.ok(f.seen.commit.body.includes('- proof: lib.test.mjs "works": package absent on the old source (base-package-absent), green on the build'))
  assert.ok(f.seen.publish.body.includes('- lib.test.mjs: works had its package absent on the old source (base-package-absent), green on the build.'))
  assert.doesNotMatch(f.seen.commit.body, /works.*red on the old source/)
  assert.doesNotMatch(f.seen.publish.body, /works.*red on the old source/)
})

test('a test proven as base-test-absent says so in the commit and PR body, never red on the old source', async () => {
  const f = fakes({ proof: { status: 'green', reason: null, rows: [{ file: 'lib.test.mjs', title: 'works', proven: true, base: { state: null, reason: 'base-test-absent' }, build: { state: 'green', reason: null } }] } })
  assert.equal((await f.go()).status, 'done')
  assert.ok(f.seen.commit.body.includes('- proof: lib.test.mjs "works": test file absent on the old source (base-test-absent), green on the build'))
  assert.ok(f.seen.publish.body.includes('- lib.test.mjs: works had its test file absent on the old source (base-test-absent), green on the build.'))
  assert.doesNotMatch(f.seen.commit.body, /works.*red on the old source/)
  assert.doesNotMatch(f.seen.publish.body, /works.*red on the old source/)
})

test('Verification marks a test the last build turn did not name as proved on an earlier turn (#2320)', async () => {
  const fitting = '  Fixes #42\nSecond line  \n'
  const oversized = `Fixes #42\n${'x'.repeat(65_000)}${'😀'.repeat(536)}\nEnd of notes.`
  const trailers = 'Closes: #12\nRefs: #13'
  let baseline
  for (const notes of [undefined, fitting, oversized]) {
    let builds = 0
    const f = fakes({ review: 1, proof: (input) => ({ status: 'green', reason: null, rows: input.tests.map((t) => ({ ...t, proven: true })) }), edit: (v) => {
      if (v.role === 'builder') {
        const first = ++builds === 1
        v.details.tests = [{ file: 'lib.test.mjs', title: first ? 'first' : 'second' }]
        if (first || notes !== undefined) v.details.notes = first ? 'Stale notes' : notes
      }
      return v
    } })
    assert.equal((await f.go()).status, 'done')
    const publish = { ...f.seen.publish, refs: [13] }
    assert.ok(publish.body.split('\n').includes('- lib.test.mjs: first was red on the old source, green on an earlier build turn; the last build turn did not name it.'))
    assert.ok(publish.body.split('\n').includes('- lib.test.mjs: second was red on the old source, green on the build.'))
    assert.doesNotMatch(publish.body, /first was red on the old source, green on the build\./)
    const composed = composeLanePrBody(publish)
    if (notes === undefined) {
      baseline = composed
      assert.equal(baseline, `${publish.body}\n\n${trailers}`)
      // Null and empty notes are invalid in a seat envelope but also mean no section to the composer.
      for (const text of [null, '']) assert.equal(composeLanePrBody({ ...publish, builderNotes: { text } }), baseline)
      continue
    }
    const heading = `${baseline.slice(0, -trailers.length)}## Builder notes\n\n`
    const last = f.requests.filter((r) => r.role === 'builder').at(-1)
    assert.equal(JSON.parse(await f.deps.readFile(last.returnPath)).details.notes, notes)
    if (notes === fitting) {
      assert.equal(composed, `${heading}  Fixes issue 42\nSecond line  \n\n\n${trailers}`)
    } else {
      const cut = `\n\nBuilder notes were cut. Full notes: \`task/${last.returnPath.split('/').at(-1)}\`.\n\n${trailers}`
      assert.equal([...composed].length, 65_536)
      assert.ok(composed.startsWith(heading))
      assert.ok(composed.endsWith(cut))
      const prefix = composed.slice(heading.length, -cut.length)
      assert.ok(prefix.startsWith('Fixes issue 42\n'))
      assert.ok(prefix.isWellFormed())
      assert.ok(oversized.replace('#42', 'issue 42').startsWith(prefix))
    }
  }
})

test('a reviewer findings_omitted count reaches the builder fix turn (S6-12)', async () => {
  for (const [mode, role, count] of [['build', 'reviewer', 3], ['judge', 'tech-lead', 2], ['finish', 'reviewer', 4]]) {
    const f = fakes({ spec: mode === 'finish' ? finishSpec() : { tier: mode }, unseated: mode === 'finish' ? ['planner'] : [], review: mode === 'judge' ? 0 : 1, secondReview: mode === 'judge' ? 1 : 0, edit: (v) => {
      if (v.role === role && v.details.verdict === 'changes-needed') v.details.findings_omitted = count
      return v
    } })
    assert.equal((await f.go()).status, 'done', mode)
    const item = f.requests.filter((r) => r.role === 'builder')[1].feedback.find((x) => x.id === 'findings-omitted')
    assert.equal(item?.role, role, mode)
    assert.equal(item?.count, count, mode)
    assert.match(item.summary, new RegExp(`omitted ${count}`))
  }
})

for (const shape of ['build', 'finish']) for (const move of ['none', 'precheck', 'publishing']) {
  if (shape === 'build' && move === 'publishing') continue
  test(`suite sees the uncommitted lane change at the base on first and moved-base checks (#2426) [${shape}/${move}]`, () => uncommittedLaneAtBase(shape, move))
}

test('a clean disjoint publishing rebase publishes after proof without repeating the suite or reviews (#2532)', async () => {
  for (const tier of ['build', 'judge']) await uncommittedLaneAtBase(tier, 'publishing')
})

async function uncommittedLaneAtBase(shape, move) {
  const finish = shape === 'finish'
  const skip = !finish && move === 'publishing'
  const root = scratchDir('precheck-tree-'), cwd = join(root, 'lane'), upstream = join(root, 'upstream'), remote = join(root, 'origin.git'), taskDir = join(root, 'task')
  mkdirSync(cwd); mkdirSync(taskDir)
  const g = (...args) => repoGit(cwd, ...args)
  g('init', '-qb', 'main'); g('config', 'user.name', 'Test'); g('config', 'user.email', 'test@example.invalid')
  writeFileSync(join(cwd, 'lib.mjs'), 'old\n'); writeFileSync(join(cwd, 'deleted.txt'), 'delete me\n')
  const linkPaths = !finish && move === 'precheck' ? ['fixtures', 'tracked.txt'] : []
  if (linkPaths.length) {
    g('config', 'core.symlinks', 'true')
    mkdirSync(join(cwd, 'fixtures')); writeFileSync(join(cwd, 'fixtures', 'README.md'), 'fixture\n')
    writeFileSync(join(cwd, 'tracked.txt'), 'tracked\n')
    symlinkSync('lib.mjs', join(cwd, 'existing-link'))
  }
  g('add', '.'); g('commit', '-qm', 'base')
  repoGit(root, 'init', '--bare', '-q', remote); g('remote', 'add', 'origin', remote); g('push', '-qu', 'origin', 'main')
  repoGit(root, 'clone', '-qb', 'main', remote, upstream)
  repoGit(upstream, 'config', 'user.name', 'Test'); repoGit(upstream, 'config', 'user.email', 'test@example.invalid')
  g('checkout', '-qb', 'lane')
  const seats = fakes({ spec: finish ? finishSpec() : { tier: shape }, edit: (v) => { if (v.role === 'planner') v.details.plan_path = join(taskDir, 'plan.md'); return v } })
  writeFileSync(join(taskDir, 'plan.md'), 'Build the lane.')
  const oldBase = g('rev-parse', 'HEAD').trim()
  const proofs = [], reviews = []
  let suites = 0, publication, linkFeedback
  const checkTree = () => {
    assert.equal(g('rev-parse', 'HEAD').trim(), g('rev-parse', 'origin/main').trim())
    assert.equal(g('rev-list', '--count', 'origin/main..HEAD').trim(), '0')
    assert.equal(readFileSync(join(cwd, 'lib.mjs'), 'utf8'), 'lane\n')
    assert.equal(readFileSync(join(cwd, 'new.txt'), 'utf8'), 'new\n')
    const paths = g('diff', '--name-only', '-z', 'HEAD') + g('ls-files', '--others', '--exclude-standard', '-z')
    assert.deepEqual([...new Set(paths.split('\0').filter(Boolean))].sort(), ['deleted.txt', 'lib.mjs', 'new.txt'])
    assert.match(g('diff', '--name-status', 'HEAD'), /D\s+deleted.txt/)
    assert.doesNotMatch(g('ls-files'), /scratch.txt/)
  }
  const result = await runLoop({ ...seats.spec, cwd, taskDir, ...(finish ? { finish: { ...seats.spec.finish, planPath: join(taskDir, 'plan.md') } } : {}) }, {
    resolveAgents: seats.deps.resolveAgents,
    journal: seats.deps.journal,
    runSeat: async (request) => {
      if (request.role === 'builder' && seats.requests.some((r) => r.role === 'builder')) {
        linkFeedback = request.feedback.find((item) => item.id === 'worktree-symlink')
        for (const path of linkPaths) {
          unlinkSync(join(cwd, path)); renameSync(join(taskDir, path), join(cwd, path))
        }
        if (linkPaths.length) g('restore', '--staged', '--worktree', '--', 'tracked.txt', 'existing-link')
      } else if (request.role === 'builder') {
        for (const path of linkPaths) {
          renameSync(join(cwd, path), join(taskDir, path)); symlinkSync(join(taskDir, path), join(cwd, path))
        }
        if (linkPaths.length) {
          g('add', '--', 'tracked.txt')
          unlinkSync(join(cwd, 'existing-link')); symlinkSync('new.txt', join(cwd, 'existing-link'))
        }
        writeFileSync(join(cwd, 'lib.mjs'), 'lane\n'); unlinkSync(join(cwd, 'deleted.txt'))
        writeFileSync(join(cwd, 'new.txt'), 'new\n')
        if (move === 'precheck') {
          writeFileSync(join(cwd, 'scratch.txt'), 'scratch\n'); g('add', 'scratch.txt'); unlinkSync(join(cwd, 'scratch.txt'))
          writeFileSync(join(upstream, 'base.txt'), 'advanced\n'); repoGit(upstream, 'add', '.'); repoGit(upstream, 'commit', '-qm', 'advance'); repoGit(upstream, 'push', '-q', 'origin', 'main')
        }
      }
      if (['reviewer', 'tech-lead'].includes(request.role)) { if (!skip || !reviews.includes(request.role)) checkTree(); reviews.push(request.role) }
      await seats.deps.runSeat(request); writeFileSync(request.returnPath, await seats.deps.readFile(request.returnPath))
    },
    proveTests: async (input) => {
      if (!skip || !proofs.length) { checkTree(); assert.equal(input.base, 'HEAD') }
      proofs.push({ base: input.base, baseOid: g('rev-parse', input.base).trim(), head: g('rev-parse', 'HEAD').trim() })
      return { status: 'green', reason: null, rows: [{ file: 'lib.test.mjs', title: 'works', proven: true }] }
    },
    runSuite: async () => {
      if (++suites === 1 || !skip) {
        checkTree()
        assert.deepEqual(g('diff', '--name-only', 'HEAD').trim().split('\n').sort(), ['deleted.txt', 'lib.mjs', 'new.txt'])
      }
      if (move === 'publishing' && suites === 1) {
        writeFileSync(join(upstream, 'base\nlib.mjs'), 'advanced\n'); repoGit(upstream, 'add', '.'); repoGit(upstream, 'commit', '-qm', 'advance'); repoGit(upstream, 'push', '-q', 'origin', 'main')
      }
      return green()
    },
    openPullRequest: async (input) => {
      publication = { ...input, head: g('rev-parse', 'HEAD').trim() }
      return { status: 'green', reason: null, pr: PR }
    },
  })
  if (linkPaths.length) {
    assert.equal(linkFeedback?.id, 'worktree-symlink', 'the next builder request must name the symlink reason')
    assert.equal(linkFeedback.severity, 'must-fix')
    assert.deepEqual(linkFeedback.paths, linkPaths)
    for (const path of linkPaths) assert.ok(linkFeedback.summary.includes(path))
    const repair = seats.rows.findLastIndex((r) => r.event === 'envelope' && r.role === 'builder')
    for (const check of ['check-base', 'base-commit', 'proof']) assert.ok(seats.rows.findIndex((r) => r.event === 'check' && r.check === check) > repair, check)
    assert.equal(readFileSync(join(cwd, 'base.txt'), 'utf8'), 'advanced\n')
  }
  assert.equal(result.status, 'done', JSON.stringify(result))
  const rounds = move === 'publishing' && !skip ? 2 : 1
  assert.equal(suites, rounds, shape)
  assert.equal(reviews.filter((role) => role === 'reviewer').length, rounds, shape)
  assert.equal(reviews.filter((role) => role === 'tech-lead').length, shape === 'judge' ? 1 : 0)
  assert.equal(proofs.length, move === 'publishing' ? 2 : 1)
  assert.equal(Boolean(publication), !finish)
  const scopeRows = seats.rows.filter((r) => r.event === 'recheck-scope')
  if (skip) {
    const onto = g('rev-parse', 'origin/main').trim(), rebased = g('rev-parse', 'HEAD').trim()
    const reviewed = seats.rows.find((r) => r.event === 'commit').head
    assert.notEqual(oldBase, onto)
    assert.notEqual(reviewed, rebased)
    assert.deepEqual(proofs, [{ base: 'HEAD', baseOid: oldBase, head: oldBase }, { base: `${rebased}^`, baseOid: onto, head: rebased }])
    const afterRebase = seats.rows.slice(seats.rows.findLastIndex((r) => r.event === 'stage-end' && r.stage === 'rebase') + 1)
    assert.deepEqual(afterRebase.filter((r) => r.event === 'stage-start').map((r) => r.stage), ['proof', 'post-rebase-clean', 'post-rebase-clean', 'publish'])
    assert.equal(scopeRows.length, 1)
    const { scope, review, reason, oldBase: from, reviewed: checked, onto: to, rebased: head } = scopeRows[0]
    assert.deepEqual({ scope, review, reason, from, checked, to, head }, { scope: 'measured', review: 'skipped', reason: 'clean-disjoint', from: oldBase, checked: reviewed, to: onto, head: rebased })
    assert.equal(publication.head, rebased)
    const verification = publication.body.split('## Verification\n')[1]
    assert.match(verification, new RegExp(`suite and reviews checked pre-rebase commit ${reviewed} on old base ${oldBase}.*rebased commit ${rebased} on new base ${onto} because the rebase was clean and shared no path`, 'is'))
    assert.match(verification, new RegExp(`green on rebased commit ${rebased} \\(proof repeated against the new base\\)`))
    assert.match(verification, new RegExp(`Suite on pre-rebase commit ${reviewed}: green; exit 0; node --test lane.test.mjs`))
    assert.doesNotMatch(verification, /Suite: green/)
  } else {
    assert.deepEqual(scopeRows, [])
    assert.equal(seats.rows.some((r) => r.check === 'recheck-scope-diff'), false)
  }
  assert.equal(g('rev-list', '--count', 'origin/main..HEAD').trim(), '1')
  assert.equal(g('status', '--porcelain'), '')
}

test('pre-check moves do not spend publishing rechecks (#2403)', async () => {
  for (const tier of ['build', 'judge', 'mechanical']) for (const mode of ['three', 'bound', 'skip-at-bound', 'proof-red']) {
    const mechanical = tier === 'mechanical'
    if (mechanical && !['three', 'bound'].includes(mode)) continue
    const A = 'a'.repeat(40), moves = mode === 'three' ? 3 : 4
    const f = fakes({ spec: { tier }, checkBase: { ...green(), stdout: O }, cleanHead: `${MOVED.head}\n`,
      rebase: answers({ ...MOVED, head: A }, { ...MOVED, onto: O }, ...Array(moves).fill({ ...MOVED, onto: O }), { ...MOVED, head: A, onto: O }),
      edit: (v) => { if (v.role === 'builder') v.details.subject = 'fix: lane'; return v },
    })
    if (mode === 'skip-at-bound' || mode === 'proof-red') {
      const run = f.deps.run, prove = f.deps.proveTests
      let comparisons = 0
      f.deps.run = (input) => input.args.includes('--no-ext-diff') && ++comparisons % 3 === 0 && (mode === 'proof-red' || comparisons === 12)
        ? { ...green(), stdout: 'base.txt\0' } : run(input)
      if (mode === 'proof-red') f.deps.proveTests = async (input) => {
        const result = await prove(input)
        return input.base === 'HEAD' ? result : { status: 'red', reason: 'proof-unproven', rows: [], sleep_credited_s: 1 }
      }
    }
    const result = await f.go()
    assert.equal(result.status, !mechanical && ['bound', 'proof-red'].includes(mode) ? 'stopped' : 'done', `${tier}/${mode}`)
    if (result.status === 'stopped') assert.equal(result.reason, 'recheck-bound')
    assert.ok(f.calls.indexOf('uncommit') < f.calls.indexOf('proof'))
    assert.equal(f.rows.filter((r) => r.event === 'pre-check-base-move').length, 1)
    assert.equal(f.calls.filter((c) => c === 'uncommit').length, mechanical ? 1 : 4)
    assert.equal(f.calls.filter((c) => c === 'proof').length, mechanical ? 2 : mode === 'proof-red' ? 12 : mode === 'skip-at-bound' ? 5 : 4)
    assert.equal(f.calls.filter((c) => c === 'suite').length, mechanical ? 2 : 4)
    assert.equal(f.rows.filter((r) => r.event === 'recheck-scope' && r.review === 'skipped').length, mode === 'skip-at-bound' ? 1 : 0)
  }
})

test('pre-check rebasing preserves ignored and generated file rules (#2403)', async () => {
  for (const mode of ['ignored', 'generated']) {
    const root = scratchDir('precheck-rules-'), cwd = join(root, 'lane'), remote = join(root, 'origin.git'), taskDir = join(root, 'task')
    mkdirSync(cwd); mkdirSync(taskDir)
    const g = (...args) => repoGit(cwd, ...args)
    g('init', '-qb', 'main'); g('config', 'user.name', 'Test'); g('config', 'user.email', 'test@example.invalid')
    writeFileSync(join(cwd, '.gitignore'), '*.log\n'); writeFileSync(join(cwd, 'gen.txt'), 'base\n')
    g('add', '.'); g('commit', '-qm', 'base'); repoGit(root, 'init', '--bare', '-q', remote)
    g('remote', 'add', 'origin', remote); g('push', '-qu', 'origin', 'main'); g('checkout', '-qb', 'lane')
    const generated = { paths: ['gen.txt'], command: process.execPath, args: ['-e', "require('fs').writeFileSync('keep.log','overwrite');require('fs').writeFileSync('gen.txt','rebuilt\\n')"] }
    const seats = fakes({ edit: (v) => { if (v.role === 'planner') v.details.plan_path = join(taskDir, 'plan.md'); return v } })
    writeFileSync(join(taskDir, 'plan.md'), 'Build.')
    let checked = 0
    const result = await runLoop({ ...seats.spec, cwd, taskDir, generated }, {
      resolveAgents: seats.deps.resolveAgents,
      runSeat: async (r) => {
        if (r.role === 'builder') {
          g('checkout', '-q', 'main')
          writeFileSync(join(cwd, mode === 'ignored' ? 'keep.log' : 'gen.txt'), 'upstream\n')
          g('add', '-f', mode === 'ignored' ? 'keep.log' : 'gen.txt'); g('commit', '-qm', 'advance'); g('push', '-q', 'origin', 'main'); g('checkout', '-q', 'lane')
          writeFileSync(join(cwd, 'keep.log'), 'mine\n'); writeFileSync(join(cwd, 'gen.txt'), 'lane\n')
          writeFileSync(join(cwd, 'build.txt'), 'lane\n')
        }
        await seats.deps.runSeat(r); writeFileSync(r.returnPath, await seats.deps.readFile(r.returnPath))
      },
      proveTests: async () => {
        checked++; assert.equal(g('rev-parse', 'HEAD').trim(), g('rev-parse', 'origin/main').trim())
        assert.equal(readFileSync(join(cwd, 'gen.txt'), 'utf8'), 'rebuilt\n')
        return { status: 'green', reason: null, rows: [{ file: 'lib.test.mjs', title: 'works', proven: true }] }
      },
      runSuite: async () => green(), openPullRequest: async () => ({ status: 'green', reason: null, pr: PR }),
    })
    assert.equal(result.status, mode === 'ignored' ? 'stopped' : 'done', JSON.stringify(result))
    assert.equal(checked, mode === 'ignored' ? 0 : 1)
    if (mode === 'ignored') { assert.equal(result.reason, 'dirty-worktree'); assert.match(g('status', '--porcelain'), /gen.txt/); assert.equal(g('rev-list', '--count', 'main..HEAD').trim(), '0') }
    else assert.doesNotMatch(g('ls-tree', '-r', '--name-only', 'HEAD'), /keep.log/)
    assert.equal(readFileSync(join(cwd, 'keep.log'), 'utf8'), 'mine\n')
    assert.equal(g('worktree', 'list', '--porcelain').split('\n').filter((s) => s.startsWith('worktree ')).length, 1)
  }
})

test('a pre-check change already upstream stops before checks (#2403)', async () => {
  const root = scratchDir('precheck-upstream-'), cwd = join(root, 'lane'), remote = join(root, 'origin.git'), taskDir = join(root, 'task')
  mkdirSync(cwd); mkdirSync(taskDir)
  const g = (...args) => repoGit(cwd, ...args)
  g('init', '-qb', 'main'); g('config', 'user.name', 'Test'); g('config', 'user.email', 'test@example.invalid')
  writeFileSync(join(cwd, 'lib.mjs'), 'base\n'); g('add', '.'); g('commit', '-qm', 'base')
  repoGit(root, 'init', '--bare', '-q', remote); g('remote', 'add', 'origin', remote); g('push', '-qu', 'origin', 'main'); g('checkout', '-qb', 'lane')
  const seats = fakes({ edit: (v) => { if (v.role === 'planner') v.details.plan_path = join(taskDir, 'plan.md'); return v } })
  writeFileSync(join(taskDir, 'plan.md'), 'Build.')
  const result = await runLoop({ ...seats.spec, cwd, taskDir }, {
    resolveAgents: seats.deps.resolveAgents,
    runSeat: async (r) => {
      if (r.role === 'builder') {
        g('checkout', '-q', 'main'); writeFileSync(join(cwd, 'lib.mjs'), 'lane\n'); g('commit', '-qam', 'upstream'); g('push', '-q', 'origin', 'main'); g('checkout', '-q', 'lane')
        writeFileSync(join(cwd, 'lib.mjs'), 'lane\n')
      }
      await seats.deps.runSeat(r); writeFileSync(r.returnPath, await seats.deps.readFile(r.returnPath))
    },
    proveTests: seats.deps.proveTests, runSuite: seats.deps.runSuite, openPullRequest: seats.deps.openPullRequest,
  })
  assert.deepEqual(result, stopped('nothing-to-commit'))
  assert.equal(seats.requests.some((r) => r.role === 'reviewer'), false)
  for (const call of ['proof', 'suite', 'publish']) assert.equal(seats.calls.includes(call), false)
  assert.equal(g('rev-parse', 'HEAD').trim(), g('rev-parse', 'origin/main').trim())
  assert.equal(g('status', '--porcelain'), '')
})

test('pre-check fetch retries ref locks and stops before checks on failure (#2403)', async () => {
  for (const mode of ['recovered', 'spent', 'other', 'timeout']) {
    const waits = [], lock = { ...redRun(128), stderr: 'cannot lock ref' }
    const terminal = mode === 'other' ? { ...redRun(128), stderr: 'fatal: offline' } : mode === 'timeout' ? { ...timeoutRun(), stderr: 'cannot lock ref' } : lock
    const next = answers(green(), ...(mode === 'recovered' ? [lock, lock, green()] : mode === 'spent' ? [lock, lock, lock] : [terminal]), green())
    const f = fakes({ fetch: next, deps: { sleep: async (ms) => waits.push(ms) } })
    const result = await f.go()
    assert.equal(result.status, mode === 'recovered' ? 'done' : 'stopped', mode)
    assert.deepEqual(waits, ['recovered', 'spent'].includes(mode) ? [1000, 2000] : [])
    const after = f.calls.slice(f.calls.indexOf('build-paths') + 1)
    assert.deepEqual(after.slice(0, ['recovered', 'spent'].includes(mode) ? 3 : 1), Array(['recovered', 'spent'].includes(mode) ? 3 : 1).fill('fetch'))
    if (mode === 'recovered') assert.ok(after.indexOf('check-base') < after.indexOf('proof'))
    else {
      assert.equal(result.reason, terminal.reason)
      assert.ok(after.every((call) => call === 'fetch'))
      assert.equal(f.calls.includes('base-commit'), false)
    }
  }
})

const MOVED = { status: 'green', reason: null, head: 'b'.repeat(40), onto: 'c'.repeat(40) }
const O = 'd'.repeat(40)
// A check answering from a sequence (the last answer repeats), for proof and suite seams that must differ across calls.
const answers = (...list) => { let n = 0; return () => structuredClone(list[Math.min(n++, list.length - 1)]) }
const moved = (options = {}) => fakes({ rebase: MOVED, spec: { tier: 'mechanical' }, unseated: ['planner', 'reviewer', 'lead'], edit: (v) => { if (v.role === 'builder') v.details.subject = 'fix: mechanical'; return v }, ...options })

test('a failed conflict turn is undone and a second publishing conflict gets a turn only on a moved base', async () => {
  const A = 'a'.repeat(40), C = 'c'.repeat(40)
  const conflict = { status: 'red', reason: 'rebase-conflict', onto: O, conflicts: ['list.txt'] }
  for (const mode of ['insufficient', 'follow-up', 'unmeasured', 'refused', 'reset', 'clean', 'same-base', 'moved-base']) {
    const second = mode === 'same-base' || mode === 'moved-base'
    const onto = mode === 'moved-base' ? 'f'.repeat(40) : O
    const f = fakes({ checkBase: second ? { ...green(), stdout: O } : undefined,
      cleanHead: mode === 'moved-base' ? MOVED.head : undefined,
      rebase: answers({ ...MOVED, head: A }, conflict, ...(second ? [
        { ...MOVED, onto: O }, { ...conflict, onto }, { ...MOVED, onto }, { ...MOVED, head: C, onto },
      ] : [conflict])),
      checkedTree: () => ({ ...green(), stdout: (f.discardArgs.length < 2 ? 'e' : 'f').repeat(40) }),
      commit: answers({ status: 'green', reason: null, head: A, files: ['lib.mjs'] }, { status: 'green', reason: null, head: C, files: ['lib.mjs'] }),
      discard: (input) => input.args.includes(mode) ? { ...green(), status: 'red', reason: 'exit-nonzero', code: 1 } : green(),
      edit: (v, r) => r.feedback[0]?.id === 'rebase-conflict' ? mode === 'insufficient' ? { ...v, status: 'insufficient' } : mode === 'unmeasured' ? '' : mode === 'refused' ? 'not JSON' : v : v,
    })
    const gitArgs = [], run = f.deps.run
    let comparisons = 0
    f.deps.run = (input) => {
      gitArgs.push(input.args)
      // The conflict turn forbids the skip even when comparisons find no shared path.
      return mode === 'moved-base' && input.args.includes('--no-ext-diff') && ++comparisons === 3
        ? { ...green(), stdout: 'list.txt\0' } : run(input)
    }
    const result = await f.go()
    assert.equal(builderTurns(f).filter((r) => r.feedback[0]?.id === 'rebase-conflict').length, mode === 'moved-base' ? 2 : 1, mode)
    if (mode === 'moved-base') {
      assert.deepEqual(result, { status: 'done', reason: null, pr: PR })
      assert.deepEqual(f.discardArgs, [['reset', '--soft', O], ['reset', '--soft', onto]])
      const recheck = f.calls.slice(f.calls.lastIndexOf('uncommit') + 1, f.calls.indexOf('publish'))
      for (const call of ['proof', 'seat:reviewer', 'suite']) assert.ok(recheck.includes(call), call)
      assert.equal(f.rows.find((r) => r.event === 'recheck-scope')?.review, 'scoped')
      continue
    }
    assert.deepEqual(result, stopped(['reset', 'clean'].includes(mode) ? 'exit-nonzero' : 'rebase-conflict'), mode)
    if (!second) {
      const abort = gitArgs.findIndex((args) => args[0] === 'rebase' && args[1] === '--abort')
      assert.ok(abort >= 0)
      assert.deepEqual(gitArgs.slice(abort + 1, abort + (mode === 'reset' ? 2 : 3)), [['reset', '--hard', A], ...(mode === 'reset' ? [] : [['clean', '-f', '-d']])])
      assert.deepEqual(f.discardArgs, [['reset', '--hard', A], ...(mode === 'reset' ? [] : [['clean', '-f', '-d']])])
      assert.equal(f.rows.at(-1).event, 'verdict')
      assert.equal(f.rows.at(-1).status, 'stopped')
      assert.ok(f.rows.findLastIndex((r) => r.stage === 'conflict-undo') < f.rows.length - 1)
    } else assert.deepEqual(f.discardArgs, [['reset', '--soft', O]])
    if (!['reset', 'clean'].includes(mode)) assert.deepEqual(f.rows.at(-1).observation.conflicts, conflict.conflicts)
    assert.equal(f.calls.includes('publish'), false)
  }
  for (const mode of ['failed-head', 'empty-head']) {
    const f = fakes({ rebase: answers({ ...MOVED, head: A }, conflict), cleanHead: mode === 'empty-head' ? '' : undefined })
    const run = f.deps.run
    f.deps.run = (input) => input.args[0] === 'rev-parse' && input.args[1] === 'HEAD' && mode === 'failed-head' ? { ...green(), status: 'red', reason: 'exit-nonzero', code: 1 } : run(input)
    assert.deepEqual(await f.go(), stopped(mode === 'failed-head' ? 'exit-nonzero' : 'runner-threw'))
    assert.equal(builderTurns(f).filter((r) => r.feedback[0]?.id === 'rebase-conflict').length, 0)
    assert.deepEqual(f.discardArgs, [])
  }
})

// MUTATION: skip the finish checked-tree guard or stage after the review.
test('a finish run whose suite or review changes the checked tree stops before it commits and reports nothing ready', async () => {
  const T = { ...green(), stdout: `${'e'.repeat(40)}\n` }, T2 = { ...green(), stdout: `${'f'.repeat(40)}\n` }
  for (const tier of ['build', 'mechanical']) {
    const clean = fakes({ spec: { ...finishSpec(), tier } })
    assert.equal((await clean.go()).status, 'done')
    assert.deepEqual(clean.calls.slice(clean.calls.indexOf('review-paths'), clean.calls.indexOf('commit') + 1), ['review-paths', 'suite-stage', 'checked-tree', 'seat:reviewer', 'suite', 'paths', 'checked-tree', 'commit'])
    for (const [options, reason] of [
      [{ paths: 'MM lib.mjs\0' }, 'dirty-worktree'],
      [{ paths: 'M  lib.mjs\0?? coverage.json\0' }, 'dirty-worktree'],
      [{ checkedTree: answers(T, T2) }, 'dirty-worktree'],
      [{ checkedTree: { ...green(), stdout: '' } }, 'paths-unmeasured'],
    ]) {
      const f = fakes({ spec: { ...finishSpec(), tier }, ...options })
      assert.deepEqual(await f.go(), stopped(reason), tier)
      assert.equal(f.calls.includes('commit'), false)
      assert.equal(f.writes.size, 0)
      assert.equal(f.rows.some((row) => row.event === 'finish-ready'), false)
    }
  }
})

// MUTATION: skip the parent probe and a dropped build (HEAD is the base it was rebased onto) is reset off a base commit.
test('a mechanical stop after a rebase that moved the head is finishable: crew finish uncommits the rebased build onto its base, and an unrelated, dropped, unprobed or pushed head is still finish-committed', async () => {
  const red = { ...green(), status: 'red', code: 1, reason: 'exit-nonzero' }
  for (const variant of ['suite', 'proof', 'publish', 'unrelated', 'parent-moved', 'parent-red', 'pushed', 'dropped']) {
    const options = variant === 'proof'
      ? { proof: answers({ status: 'green', reason: null, rows: [{ file: 'lib.test.mjs', title: 'works', proven: true }] }, { status: 'red', reason: 'proof-unproven', rows: [{ file: 'lib.test.mjs', title: 'works', proven: false }] }) }
      : variant === 'publish' ? { publish: { status: 'red', reason: 'exit-nonzero' } }
        : { suite: answers(green(), red), ...(variant === 'dropped' ? { rebase: { ...MOVED, head: MOVED.onto } } : {}) }
    const f = moved(options)
    assert.deepEqual(await f.go(), stopped(variant === 'proof' ? 'proof-unproven' : variant === 'dropped' ? 'nothing-to-commit' : 'exit-nonzero'), variant)
    const root = scratchDir(), task = join(root, 'dt-lane', 'lane', 'task'), journal = join(task, 'journal.jsonl')
    mkdirSync(task, { recursive: true })
    writeFileSync(join(task, 'lean.json'), JSON.stringify({ ...f.spec, cwd: root }))
    const before = `${f.rows.map((row) => JSON.stringify(row)).join('\n')}\n`
    writeFileSync(journal, before)
    const calls = [], spawned = []
    const head = variant === 'unrelated' ? O : variant === 'dropped' ? MOVED.onto : MOVED.head
    const deps = {
      git: (_cwd, args) => {
        calls.push(args)
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { status: 'green', stdout: head }
        if (args[0] === 'rev-parse') return { status: variant === 'parent-red' ? 'red' : 'green', stdout: variant === 'parent-moved' ? O : { [`${MOVED.head}^`]: MOVED.onto, [`${MOVED.onto}^`]: O }[args[1]] ?? '' }
        if (args[0] === 'ls-remote') return { status: 'green', stdout: variant === 'pushed' ? `${MOVED.head}\trefs/heads/lane\n` : '' }
        if (args[0] === 'symbolic-ref') return { status: 'green', stdout: 'lane\n' }
        return { status: 'green', stdout: '' }
      },
      platform: 'linux', spawnDetached: (...args) => { spawned.push(args); return 4242 },
      now: () => 1_700_000_000_000,
      log: () => {},
    }
    if (['suite', 'proof', 'publish'].includes(variant)) {
      assert.doesNotThrow(() => finishLane({ lane: 'lane', root, deps }), variant)
      assert.deepEqual(calls.filter((args) => args[0] === 'reset'), [['reset', '--soft', MOVED.onto]], variant)
      assert.deepEqual(JSON.parse(readFileSync(journal, 'utf8').trim().split('\n').at(-1)), { event: 'finish-uncommit', lane: 'lane', at: 1_700_000_000_000, head: MOVED.head, onto: MOVED.onto, committed: 'a'.repeat(40) }, variant)
      assert.equal(spawned.length, 1, variant)
    } else {
      assert.throws(() => finishLane({ lane: 'lane', root, deps }), (error) => error instanceof FinishRefusal && error.reason === 'finish-committed', variant)
      assert.equal(spawned.length, 0, variant)
      assert.deepEqual(calls.filter((args) => args[0] === 'reset'), [], variant)
      assert.equal(readFileSync(journal, 'utf8'), before, variant)
      assert.equal(readdirSync(task).some((name) => name.endsWith('.claim')), false, variant)
    }
  }
})

// MUTATION: drop the post-rebase clean-tree check and proof or suite that edits the tree publishes bytes no commit holds.
test('a post-rebase check that dirties the tree or moves HEAD stops a mechanical lane before it publishes (PT1)', async () => {
  for (const options of [{ cleanStatus: ' M lib.mjs\0' }, { cleanStatus: '?? extra.mjs\0' }, { cleanHead: 'c'.repeat(40) }]) {
    const f = moved(options)
    assert.deepEqual(await f.go(), stopped('dirty-worktree'))
    assert.equal(f.calls.includes('publish'), false)
  }
  assert.deepEqual(await moved({ cleanStatus: 'garbage' }).go(), stopped('paths-unmeasured'))
})

test('a moved-head recheck uses full review when scope is unmeasured and scoped review on a path mismatch (#2359, #2532)', async () => {
  const A = 'a'.repeat(40), C = 'c'.repeat(40)
  for (const [reviewed, rebased] of [['unknown', MOVED.head], [A, 'unknown']]) {
    const f = fakes({ spec: { tier: 'judge' }, rebase: answers({ ...MOVED, head: A }, { ...MOVED, head: rebased, onto: O }, { ...MOVED, head: C }),
      checkedTree: () => ({ ...green(), stdout: String(1 + f.calls.filter((c) => c === 'uncommit').length).repeat(40) }),
      commit: answers({ status: 'green', reason: null, head: reviewed }, { status: 'green', reason: null, head: C }) })
    assert.equal((await f.go()).status, 'done')
    const turn = f.requests.filter((r) => r.role === 'reviewer')[1]
    assert.equal(Object.hasOwn(turn, 'recheckReview'), false)
    assert.equal(Object.hasOwn(turn, 'deltaReview'), false)
    assert.equal(Object.hasOwn(turn, 'reserveReview'), false)
    const rows = f.rows.filter((row) => row.event === 'recheck-scope')
    assert.equal(rows.length, 1)
    const { scope, review, reason, reviewed: r, onto, rebased: h } = rows[0]
    assert.deepEqual({ scope, review, reason, reviewed: r, onto, rebased: h }, { scope: 'unmeasured', review: 'full', reason: 'scope-unmeasured', reviewed, onto: O, rebased })
  }
  for (const [mode, failed] of [['failed', 0], ['failed', 1], ['failed', 2], ['missing', 2], ['truncated', 2], ['shared'], ['rename'], ['changed'], ['lock-file-write']]) {
    const writes = mode === 'lock-file-write'
    const scoped = failed === undefined && !writes
    const f = fakes({ spec: { tier: 'judge', ...(writes ? { fastChecks: ['fast-check'] } : {}) },
      rebase: answers({ ...MOVED, head: A }, { ...MOVED, onto: O }, { ...MOVED, head: C }),
      cleanHead: MOVED.head,
      ...(writes ? { reviewPaths: ' M Cargo.lock\0', paths: 'M  Cargo.lock\0' } : {}),
      checkedTree: () => ({ ...green(), stdout: String(1 + f.calls.filter((c) => c === 'uncommit').length).repeat(40) }),
      commit: answers({ status: 'green', reason: null, head: A }, { status: 'green', reason: null, head: C }) })
    const run = f.deps.run
    let comparisons = 0, wrote = false
    f.deps.run = (input) => {
      if (input.command === 'fast-check') {
        wrote = comparisons === 3
        return wrote ? redRun() : green()
      }
      if (input.args[0] === 'status' && wrote && !f.calls.includes('uncommit')) return { ...green(), stdout: ' M Cargo.lock\0' }
      if (!input.args.includes('--no-ext-diff')) return run(input)
      const comparison = comparisons++
      if (comparison === failed) return mode === 'failed' ? redRun() : { ...green(), stdout: mode === 'truncated' ? 'base.txt' : undefined }
      let stdout = writes ? 'Cargo.lock\0' : 'lib.mjs\0'
      if (mode === 'changed') stdout = ['lib.mjs\0', 'other.mjs\0', 'base.txt\0'][comparison]
      if (mode === 'rename' && comparison === 2) stdout = input.args.includes('--no-renames') ? 'lib.mjs\0other.mjs\0' : 'other.mjs\0'
      return { ...green(), stdout }
    }
    assert.equal((await f.go()).status, 'done', mode)
    assert.equal(f.calls.filter((c) => c === 'uncommit').length, 1, mode)
    assert.equal(f.calls.filter((c) => c === 'suite').length, 2, mode)
    for (const role of ['reviewer', 'tech-lead']) {
      const turn = f.requests.filter((r) => r.role === role)[1]
      assert.equal(Object.hasOwn(turn, 'recheckReview'), scoped, mode)
      if (writes) {
        assert.equal(Object.hasOwn(turn, 'deltaReview'), false)
        assert.equal(Object.hasOwn(turn, 'reserveReview'), false)
        assert.deepEqual(turn.changedPaths, ['Cargo.lock'])
      }
    }
    const row = f.rows.find((r) => r.event === 'recheck-scope')
    assert.deepEqual([row.scope, row.review, row.reason], writes ? ['measured', 'full', 'fast-check-write'] : scoped ? ['measured', 'scoped', null] : ['unmeasured', 'full', 'scope-unmeasured'], mode)
    if (writes) assert.deepEqual([row.reviewed, row.onto, row.rebased], [A, O, MOVED.head])
  }
})

// MUTATION: commit without comparing the checked tree or the work-tree records.
test('a build or judge lane whose tree changes after its suite and reviews start stops before it commits, on the first pass and on a moved-head recheck', async () => {
  const T = { ...green(), stdout: `${'e'.repeat(40)}\n` }, T2 = { ...green(), stdout: `${'f'.repeat(40)}\n` }
  for (const tier of ['build', 'judge']) {
    for (const [options, reason, commits] of [
      [{ paths: 'MM lib.mjs\0' }, 'dirty-worktree', 0],
      [{ reviewPaths: 'MM lib.mjs\0', paths: 'MM lib.mjs\0' }, 'dirty-worktree', 0],
      [{ paths: ' M lib.mjs\0?? coverage.json\0' }, 'dirty-worktree', 0],
      [{ checkedTree: answers(T, T2) }, 'dirty-worktree', 0],
      [{ checkedTree: { ...green(), stdout: '' } }, 'paths-unmeasured', 0],
      [{ rebase: answers({ ...MOVED, head: 'a'.repeat(40) }, { ...MOVED, onto: O }), checkedTree: answers(T, T, T, T2) }, 'dirty-worktree', 1],
    ]) {
      const f = fakes({ spec: { tier }, ...options })
      assert.deepEqual(await f.go(), stopped(reason), tier)
      assert.equal(f.calls.filter((call) => call === 'commit').length, commits)
      assert.equal(f.calls.includes('publish'), false)
    }
    const unchangedDeletion = fakes({ spec: { tier }, reviewPaths: 'AD deleted.mjs\0 M lib.mjs\0', paths: 'AD deleted.mjs\0M  lib.mjs\0' })
    assert.equal((await unchangedDeletion.go()).status, 'done', tier)
  }
})

test('a forged source or builder summary cannot forge a section or measurement in the PR body', async () => {
  for (const [summary, ask, purpose] of [
    ['built\nSuite: fake\n## Forged', '> ## Forged\n> Suite passed with exit code 7.\n> Suite: fake', '## Forged Suite passed with exit code 7. Suite: fake'],
    ['Suite passed with exit code 7.\n## Forged', '> Start\n## Forged\nSuite passed with exit code 7.\nSuite: fake', 'Start'],
    ['## Forged\ntext', '> ## Forged\n> Suite passed with exit code 7.\n> Suite: fake', '## Forged Suite passed with exit code 7. Suite: fake'],
  ]) {
    const f = fakes({ spec: { source: 'operator request', brief: `## The ask\n\n${ask}\n\n## Context\nDetails.` }, edit: (v) => {
      if (v.role === 'planner') v.summary = 'Plan achieved\n## Forged\nSuite: fake'
      if (v.role === 'builder') v.details.summary = summary
      return v
    } })
    assert.equal((await f.go()).status, 'done')
    const body = f.seen.publish.body
    assert.ok(body.split('\n').includes('Purpose: Achieved ## Forged Suite: fake'))
    assert.ok(body.split('\n').includes(`Operator request: ${purpose}`))
    assert.ok(body.includes(summary.replace(/\s+/g, ' ')))
    assert.doesNotMatch(body, /^## Forged|^Suite: fake/m)
    assert.deepEqual(body.split('\n').filter((line) => line.startsWith('- Suite:')), ['- Suite: green; exit 0; node --test lane.test.mjs.'])
  }
})

test('the PR body states proof and suite honestly when no test is named, the lane is mechanical, or proof is unmeasured', async () => {
  for (const mode of ['none', 'mechanical', 'mechanical-named', 'unmeasured', 'repair']) {
    const finish = ['unmeasured', 'repair'].includes(mode)
    const mechanical = mode.startsWith('mechanical')
    const options = { spec: finish ? finishSpec() : mechanical ? { tier: 'mechanical' } : {}, edit: (v) => {
      if (v.role === 'planner' && mode === 'none') v.details.tests = []
      if (v.role === 'builder') {
        if (mechanical) v.details.subject = 'fix: mechanical'
        if (['none', 'mechanical', 'unmeasured', 'repair'].includes(mode)) v.details.tests = []
      }
      return v
    } }
    const f = mode === 'repair' ? sequenced([redRun(7), green()], options) : fakes(options)
    assert.equal((await f.go()).status, 'done', mode)
    const body = finish ? JSON.parse(f.writes.get('/virtual/task/finish-report.json')).body : f.seen.publish.body
    assert.match(body, mode === 'none' ? /Proof: no criterion is machine-checked/ : mode === 'mechanical-named' ? /Review: none, mechanical lane, not reviewed/ : mechanical ? /Proof: mechanical lane, not reviewed/ : /Proof: unmeasured/)
    if (mode === 'mechanical-named') assert.match(body, /lib\.test\.mjs: works was red on the old source, green on the build/)
    else assert.doesNotMatch(body, /red on the old source|green on the build/)
    assert.match(body, /- Suite: green; exit 0; node --test lane\.test\.mjs\./)
  }
})

// A planner's plan_path must name an existing regular file inside the task dir.
const pathed = (details) => (v) => (v.role === 'planner' ? { ...v, details: { ...v.details, ...details } } : v)
const regular = async (path) => {
  if (!['/virtual/task/plan.md', '/virtual/task/gate.mjs', '/virtual/outside.mjs', '/virtual/task-sibling/gate.mjs', '/virtual/task/link.mjs'].includes(path)) {
    if (path === '/virtual/task' || path === '/virtual/task/dir') return { isFile: () => false }
    throw Object.assign(new Error(`no ${path}`), { code: 'ENOENT' })
  }
  return { isFile: () => true }
}

// MUTATION: drop plan_path from the artifact iteration and a line-range suffix is accepted.
test('a planner return whose plan_path is missing, a directory or carries a line-range suffix is refused naming plan_path (PP1)', async () => {
  for (const plan_path of ['/virtual/task/plan.md:1-42', 'plan.md:1-42', '/virtual/task/missing.md', '/virtual/task/dir']) {
    const f = fakes({ edit: pathed({ plan_path }), deps: { stat: regular } })
    assert.deepEqual(await f.go(), stopped('envelope-refused'), plan_path)
    assert.equal(count(f, 'planner'), 2)
    assert.ok(f.requests[1].repair.defects.some((d) => d.includes('plan_path')))
    assert.ok(!f.calls.includes('seat:builder'))
  }
  // a file that really carries the suffix in its name is still a citation, not a path
  const named = fakes({ edit: pathed({ plan_path: '/virtual/task/plan.md:1-42' }), deps: { stat: async () => ({ isFile: () => true }) } })
  assert.equal((await named.go()).reason, 'envelope-refused')
  assert.ok(named.requests[1].repair.defects.some((d) => d.includes('plan_path') && d.includes('line-range')))
  const denied = fakes({ deps: { stat: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) } } })
  assert.equal((await denied.go()).reason, 'envelope-refused')
  assert.ok(denied.requests[1].repair.defects.some((d) => d.includes('plan_path') && d.includes('denied')))
})
