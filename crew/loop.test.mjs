import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { git as repoGit, scratchDir } from '../test/helpers.mjs'
import { CHECK_REASONS } from './checks.mjs'
import { FinishRefusal, finishLane } from './finish.mjs'
import { DEFAULT_ROUNDS, LOOP_REASONS, runLoop } from './loop.mjs'

const PR = { number: 73, url: 'https://example.test/pr/73', state: 'OPEN', headRefName: 'lane', baseRefName: 'main' }
const finding = { id: 'R1', severity: 'must-fix', location: 'lib.mjs:1', summary: 'Fix the defect', trigger: 'bad input' }
const green = () => ({ status: 'green', reason: null, code: 0, signal: null, stdout: '', stderr: '', timedOut: false })
const STAGES = ['plan', 'fetch', 'rebase', 'build', 'proof', 'review-paths', 'suite-stage', 'checked-tree', 'suite', 'review', 'paths', 'checked-tree', 'commit', 'fetch', 'rebase', 'publish']
const SUCCESS = ['seat:planner', 'fetch', 'rebase', 'seat:builder', 'proof', 'review-paths', 'suite-stage', 'checked-tree', 'suite', 'seat:reviewer', 'paths', 'checked-tree', 'commit', 'fetch', 'rebase', 'publish']
const MUTATION = { check: 'A1', file: 'lib.mjs', find: 'old', replace: 'new' }

// MUTATION: skip the return read after a failed turn.
test('a valid return written before a turn error is accepted with the error on its envelope row, read once and never reissued (b1490)', async () => {
  const f = fakes({ spec: { tier: 'judge' } })
  const run = f.deps.runSeat, read = f.deps.readFile
  let reads = 0
  f.deps.readFile = async (path, ...args) => { if (path.includes('tech-lead-')) reads++; return read(path, ...args) }
  const message = 'Claude ended the turn without returning results for tool calls: toolu_017oix8Gd77bQUj4ZiovxaYR'
  f.deps.runSeat = async (r) => { const result = await run(r); if (r.role === 'tech-lead') throw Object.assign(new Error(message), { code: -32603 }); return result }
  assert.equal((await f.go()).status, 'done')
  assert.equal(reads, 1)
  assert.equal(f.requests.filter((r) => r.role === 'tech-lead').length, 1)
  assert.deepEqual(f.rows.find((r) => r.event === 'envelope' && r.role === 'tech-lead').turnError, { code: -32603, message })
})

// MUTATION: ignore the failed turn's skill recording.
test('a return read after a turn error is validated in full, required-skill proof included', async () => {
  for (const proven of [false, true]) {
    const f = fakes()
    const run = f.deps.runSeat
    f.deps.runSeat = async (r) => {
      const result = await run(r)
      if (r.role === 'planner') throw Object.assign(new Error('turn failed'), { recording: { definition: { agent: 'pi', requires: ['alpha'], skills: ['alpha'], writes: 'repo' }, recorded: (proven ? [LOAD, DONE] : []).map(JSON.stringify).join('\n') } })
      return result
    }
    const result = await f.go()
    assert.equal(result.status, proven ? 'done' : 'stopped')
    if (!proven) { assert.equal(result.reason, 'envelope-refused'); assert.ok(f.rows.some((r) => r.defects?.includes('required-skills-unproven'))) }
  }
})

// MUTATION: prove every attempt, the replaced thrown one included.
test('a thrown first attempt with no recording never blocks a rerun that proves its required skills', async () => {
  for (const proven of [true, false]) {
    const definition = { agent: 'pi', requires: ['alpha'], skills: ['alpha'], writes: 'repo' }
    const f = fakes({ recording: (r) => r.role === 'planner' ? { definition, rows: proven ? [LOAD, DONE] : [] } : null })
    const run = f.deps.runSeat, planners = []
    f.deps.runSeat = async (r) => {
      if (r.role === 'planner') {
        planners.push(r)
        if (!r.rerun) throw Object.assign(new Error('turn failed'), { recording: { definition, recorded: null } })
      }
      return run(r)
    }
    const result = await f.go()
    assert.equal(planners.length, 2)
    assert.ok(planners[1].rerun)
    assert.equal(result.status, proven ? 'done' : 'stopped')
    if (!proven) {
      assert.equal(result.reason, 'envelope-refused')
      assert.ok(f.rows.some((r) => r.defects?.includes('required-skills-unproven')))
    }
  }
})

// MUTATION: stop immediately on a failed turn or rerun it without a bound.
test('an absent or invalid return after a turn error gets one rerun of the turn, then the lane stops seat-unmeasured', async () => {
  for (const mode of ['absent', 'json', 'schema', 'id', 'twice', 'provider']) {
    const f = fakes({ bounds: { planner: 1 }, edit: (v, r) => r.role === 'planner' && !r.rerun ? mode === 'json' ? '{' : mode === 'schema' ? { ...v, summary: '' } : mode === 'id' ? { ...v, id: 'stale' } : v : v })
    const run = f.deps.runSeat
    const issued = []
    f.deps.runSeat = async (r) => {
      if (r.role !== 'planner') return run(r)
      issued.push(r)
      if (r.rerun && mode !== 'twice') return run(r)
      if (['json', 'schema', 'id'].includes(mode)) await run(r)
      throw Object.assign(new Error('Claude ended the turn without returning results for tool calls: toolu_017oix8Gd77bQUj4ZiovxaYR'), { code: -32603, ...(mode === 'provider' ? { providerKind: 'authentication' } : {}) })
    }
    const result = await f.go()
    assert.equal(result.status, ['twice', 'provider'].includes(mode) ? 'stopped' : 'done', mode)
    if (result.status === 'stopped') assert.equal(result.reason, 'seat-unmeasured')
    assert.equal(issued.length, mode === 'provider' ? 1 : 2)
    if (mode !== 'provider') {
      const [a, b] = issued
      assert.equal(a.id, b.id); assert.equal(a.returnPath, b.returnPath); assert.ok(b.rerun)
    }
  }
})

// MUTATION: consult the lead again when the planner's bound was already spent.
test('a lead bounce to a planner whose rounds are spent gives the planner one more turn without asking the lead again (b1491)', async () => {
  const f = fakes({ review: 2, bounds: { planner: 1 }, lead: 'bounce', target: 'planner' })
  assert.equal((await f.go()).status, 'done')
  assert.deepEqual(f.requests.map((r) => r.role), ['planner', 'builder', 'reviewer', 'builder', 'reviewer', 'lead', 'planner', 'builder', 'reviewer'])
})

// MUTATION: stop instead of bouncing an accept with no envelope.
test('a lead accept on a spent bound with nothing to accept is a bounce to that seat (b1487)', async () => {
  const f = fakes({ review: 1, bounds: { reviewer: 1 }, lead: 'accept' })
  assert.equal((await f.go()).status, 'done')
  assert.deepEqual(f.requests.map((r) => r.role), ['planner', 'builder', 'reviewer', 'builder', 'lead', 'reviewer'])
  assert.ok(f.seen.publish)
})

// MUTATION: replan a mechanical lane without discarding and raising it.
test('a mechanical lane whose builder the lead bounces to the planner restarts as build, planned and reviewed (PR 2133)', async () => {
  let builds = 0
  const f = fakes({ spec: { tier: 'mechanical' }, lead: 'bounce', target: 'planner', edit: (v) => {
    if (v.role === 'builder' && ++builds === 1) { v.status = 'escalate'; v.details.question = 'What next?' }
    return v
  } })
  assert.equal((await f.go()).status, 'done')
  assert.deepEqual(f.requests.map((r) => r.role), ['builder', 'lead', 'planner', 'builder', 'reviewer'])
  assert.deepEqual(f.discardArgs, [['reset', '--hard', 'a'.repeat(40)], ['clean', '-f', '-d']])
  assert.ok(f.calls.lastIndexOf('discard') < f.calls.indexOf('seat:planner'))
  const row = f.rows.find((r) => r.event === 'tier-raised')
  assert.deepEqual([row.from, row.to, row.reason], ['mechanical', 'build', 'lead-bounce-planner'])
  assert.equal(f.requests.find((r) => r.role === 'planner').feedback[0].id, 'mechanical-restart')
  assert.doesNotMatch(f.seen.publish.body, /mechanical lane, not reviewed/)
})

// Every effect is a recorded call; nothing touches a model, git, gh, the network or the disk.
// A seat "returns" by writing its envelope into a virtual file the loop then reads back.
function fakes(options = {}) {
  const calls = [], rows = [], requests = [], tiers = [], seen = {}, returns = new Map(), writes = new Map()
  let reviewTurns = 0, secondTurns = 0, reviewReads = 0
  const discardArgs = []
  const spec = {
    id: 'lane', cwd: '/virtual/checkout', taskDir: '/virtual/task', tier: 'build', shape: 'standard', brief: '## The ask\nBuild the lane.',
    source: 'issue 12', branch: 'lane', base: 'main', closes: [12], refs: [13],
    suite: { command: 'node', args: ['--test', 'lane.test.mjs'] }, timeoutMs: 5000, ...options.spec,
  }
  const envelope = (request) => ({
    role: request.role, id: request.id, status: 'done', summary: 'fixture',
    details: request.role === 'planner' ? { subject: 'fix(crew): planned lane', plan_path: '/virtual/task/plan.md', tests: [{ file: 'lib.test.mjs', title: 'works' }] }
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
      return path === '/virtual/task/plan.md' ? options.plan ?? '' : returns.get(path) ?? ''
    },
    // the planner's two artifacts exist as virtual regular files inside the virtual task dir
    stat: async (path) => {
      if (path !== '/virtual/task/plan.md') throw Object.assign(new Error(`no ${path}`), { code: 'ENOENT' })
      return { isFile: () => true }
    },
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
    commitChanges: (input) => input.subject === 'wip: crew finish base'
      ? measured('base-commit', { status: 'green', reason: null, head: 'a'.repeat(40), files: input.files })(input)
      : measured('commit', options.commit ?? { status: 'green', reason: null, head: 'a'.repeat(40), files: ['lib.mjs'] })(input),
    // the status probe right after a suite measures the commit's paths, any other measures the reviewer's
    run: (input) => input.args.includes('reset') && input.args.includes('--soft') ? (discardArgs.push(input.args), measured(spec.shape === 'finish' && !calls.includes('seat:builder') ? 'base-restore' : 'uncommit', green())(input))
      : input.args.includes('reset') || input.args.includes('clean') ? (discardArgs.push(input.args), measured('discard', options.discard ?? green())(input))
      : input.args.includes('add') ? measured('suite-stage', options.stageResult ?? green())(input)
      : input.args.includes('write-tree') ? measured('checked-tree', options.checkedTree ?? { ...green(), stdout: `${'e'.repeat(40)}\n` })(input)
      : input.args.includes('rev-parse') ? measured('post-rebase-head', () => ({ ...green(), stdout: options.cleanHead ?? `${(options.rebase ?? {}).head ?? 'a'.repeat(40)}\n` }))(input)
      : input.args.includes('status') && spec.shape === 'finish' && !calls.includes('seat:builder') ? measured('base-paths', options.baseStatus ?? { ...green(), stdout: ' M lib.mjs\0' })(input)
      : input.args.includes('status') && calls.includes('commit') && calls.lastIndexOf('rebase') > calls.lastIndexOf('uncommit') ? measured('post-rebase-clean', () => ({ ...green(), stdout: options.cleanStatus ?? '' }))(input)
      : input.args.includes('status')
      ? (['suite', 'seat:reviewer', 'seat:tech-lead'].includes(calls.at(-1))
        ? measured('paths', options.pathsResult ?? (() => ({ ...green(), stdout: options.paths ?? 'M  lib.mjs\0' })))
        : measured('review-paths', options.reviewResult ?? (() => ({ ...green(), stdout: [options.reviewPaths].flat()[Math.min(reviewReads++, [options.reviewPaths].flat().length - 1)] ?? ' M lib.mjs\0' }))))(input)
      : input.args.includes('rm') ? measured('base-unstage', green())(input)
      : measured('fetch', options.fetch ?? green())(input),
    rebaseBranch: measured('rebase', options.rebase ?? { status: 'green', reason: null, head: 'a'.repeat(40), onto: 'c'.repeat(40) }),
    openPullRequest: measured('publish', options.publish ?? { status: 'green', reason: null, pr: PR }),
    ...options.deps,
  }
  return { spec, deps, calls, rows, requests, tiers, seen, writes, discardArgs, go: () => runLoop(spec, deps) }
}
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

// MUTATION: restore the mechanical skip at the commit gate.
test('a mechanical lane stops dirty-worktree when the suite leaves a file or moves the checked tree, and commits nothing', async () => {
  for (const mode of ['file', 'tree']) {
    let trees = 0
    const f = fakes({ spec: { tier: 'mechanical' }, paths: mode === 'file' ? 'M  lib.mjs\0?? coverage/lcov.info\0' : undefined,
      checkedTree: () => ({ ...green(), stdout: (mode === 'tree' && trees++ ? 'f' : 'e').repeat(40) }),
      edit: (v) => { if (v.role === 'builder') v.details.subject = 'fix: mechanical'; return v } })
    assert.deepEqual(await f.go(), stopped('dirty-worktree'))
    assert.equal(f.calls.includes('commit'), false)
    assert.ok(f.calls.indexOf('checked-tree') < f.calls.indexOf('suite'))
  }
})

test('a mechanical lane runs rebase, build, proof and suite with no plan, review or lead, and publishes under the builder\'s subject', async () => {
  for (const mode of ['none', 'test', 'repair']) {
    const f = fakes({ spec: { tier: 'mechanical' }, unseated: ['planner', 'reviewer', 'lead'], edit: (v, r) => {
      if (v.role === 'builder') {
        if (mode !== 'repair' || r.repair) v.details.subject = 'docs(crew): fix typo'
        if (mode === 'none') v.details.tests = []
      }
      return v
    } })
    assert.equal((await f.go()).status, 'done', mode)
    assert.deepEqual(f.calls.slice(1), ['fetch', 'rebase', 'seat:builder', ...(mode === 'repair' ? ['seat:builder'] : []), ...(mode === 'none' ? [] : ['proof']), 'review-paths', 'suite-stage', 'checked-tree', 'suite', 'paths', 'checked-tree', 'commit', 'fetch', 'rebase', 'publish'])
    assert.equal(f.seen.publish.title, 'docs(crew): fix typo')
    assert.match(f.seen.publish.body, mode === 'none' ? /proof: none, mechanical lane, not reviewed/ : /proof: lib.test.mjs.*red on the old source, green on the build/)
    assert.equal(f.seen.publish.body.match(/mechanical lane, not reviewed/g)?.length, 1, mode)
    if (mode === 'repair') assert.match(f.requests[1].repair.defects.join(' '), /details.subject is required on a mechanical lane/)
  }
})

test('a mechanical lane discards its build and restarts from planning: as judge on a protected path, as build on a builder insufficient', async () => {
  for (const mode of ['path', 'insufficient', 'discard-reset', 'discard-clean']) {
    let builds = 0
    const f = fakes({ spec: { tier: 'mechanical' }, unseated: ['planner', 'reviewer', 'lead'], bounds: { builder: 1 },
      reviewPaths: mode === 'path' || mode.startsWith('discard-') ? [' M crew/loop.mjs\0', ' M lib.mjs\0'] : undefined,
      discard: mode.startsWith('discard-') ? (input) => input.args.includes(mode.slice(8)) ? { ...green(), status: 'red', reason: 'exit-nonzero', code: 1 } : green() : undefined,
      edit: (v) => {
        if (v.role === 'builder') { builds++; if (builds === 1 && mode === 'insufficient') v.status = 'insufficient'; else if (builds === 1) v.details.subject = 'docs(crew): fix typo' }
        return v
      },
    })
    const result = await f.go()
    if (mode.startsWith('discard-')) { assert.equal(result.reason, 'exit-nonzero'); assert.equal(f.requests.some((r) => r.role === 'planner'), false); continue }
    assert.equal(result.status, 'done', mode)
    assert.deepEqual(f.discardArgs, [['reset', '--hard', 'a'.repeat(40)], ['clean', '-f', '-d']])
    assert.ok(f.calls.lastIndexOf('discard') < f.calls.indexOf('seat:planner'))
    assert.deepEqual(f.requests.map((r) => r.role), mode === 'path' ? ['builder', 'planner', 'builder', 'reviewer', 'tech-lead'] : ['builder', 'planner', 'builder', 'reviewer'])
    const row = f.rows.find((r) => r.event === 'tier-raised')
    assert.deepEqual([row.from, row.to, row.reason], ['mechanical', mode === 'path' ? 'judge' : 'build', mode === 'path' ? 'protected-path' : 'builder-insufficient'])
    const planner = f.requests.find((r) => r.role === 'planner')
    assert.equal(planner.feedback[0].id, 'mechanical-restart')
    assert.equal(planner.feedback[0].reason, row.reason)
    if (mode === 'path') assert.deepEqual(planner.feedback[0].paths, ['crew/loop.mjs'])
    else assert.equal(planner.feedback[0].envelope.status, 'insufficient')
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

test('a judge lane runs the tech-lead second review after the reviewer passes and the suite is green, a raised lane too, and a build or finish lane never does', async () => {
  for (const mode of ['judge', 'planner', 'path', 'build', 'finish']) {
    const f = fakes({
      spec: mode === 'finish' ? { ...finishSpec(), tier: 'judge' } : { tier: mode === 'judge' ? 'judge' : 'build' },
      reviewPaths: mode === 'path' ? ' M crew/loop.mjs\0' : undefined,
      edit: (v) => { if (v.role === 'planner') { v.details.files_in_scope = ['lib.mjs']; if (mode === 'planner') v.details.judge = 'needs review' } return v },
    })
    assert.equal((await f.go()).status, 'done', mode)
    const second = ['judge', 'planner', 'path'].includes(mode)
    const expected = second ? ['suite-stage', 'checked-tree', 'suite', 'seat:reviewer', 'seat:tech-lead', 'paths', 'checked-tree', 'commit'] : mode === 'finish' ? ['suite-stage', 'checked-tree', 'seat:reviewer', 'suite', 'paths', 'checked-tree', 'commit'] : ['suite-stage', 'checked-tree', 'suite', 'seat:reviewer', 'paths', 'checked-tree', 'commit']
    assert.deepEqual(f.calls.slice(f.calls.indexOf(expected[0]), f.calls.indexOf('commit') + 1), expected, mode)
    assert.equal(count(f, 'tech-lead'), second ? 1 : 0, mode)
    if (second) {
      const reviewer = f.requests.find((r) => r.role === 'reviewer')
      const lead = f.requests.find((r) => r.role === 'tech-lead')
      for (const key of ['filesInScope', 'changedPaths', 'builderReport']) assert.deepEqual(lead[key], reviewer[key], key)
      const row = f.rows.find((r) => r.event === 'verdict' && r.role === 'tech-lead')
      assert.deepEqual([row.stage, row.status, row.verdict, row.findings], [null, 'reviewed', 'pass', []])
    }
  }
})

test('a tech-lead changes-needed goes back to the builder like a review finding, then proof, review, suite and the second review run again', async () => {
  const t = { ...finding, id: 'T1' }
  for (const drop of [false, true]) {
    const f = fakes({ spec: { tier: 'judge' }, secondReview: 1, edit: (v, r) => { if (drop && r.role === 'tech-lead' && r.feedback.length) v.details.closed = []; return v } })
    const result = await f.go()
    assert.ok(count(f, 'tech-lead') >= 1)
    assert.deepEqual(f.requests.filter((r) => r.role === 'builder')[1].feedback, [t])
    assert.deepEqual(f.requests.filter((r) => r.role === 'tech-lead')[1].feedback, [t])
    if (drop) {
      assert.equal(result.reason, 'envelope-refused')
      assert.ok(f.requests.some((r) => r.role === 'tech-lead' && r.repair && r.repair.defects.some((d) => d.includes('prior finding T1'))))
    } else {
      const at = f.calls.indexOf('seat:tech-lead')
      assert.deepEqual(f.calls.slice(at + 1), ['seat:builder', 'proof', 'review-paths', 'suite-stage', 'checked-tree', 'suite', 'seat:reviewer', 'seat:tech-lead', 'paths', 'checked-tree', 'commit', 'fetch', 'rebase', 'publish'])
      assert.deepEqual(result, { status: 'done', reason: null, pr: PR })
    }
  }
})

test('a judge lane with no tech-lead seat stops seat-unmeasured at the start and on a raise', async () => {
  for (const tier of ['judge', 'build']) {
    const f = fakes({ spec: { tier }, unseated: ['tech-lead'], edit: (v) => { if (v.role === 'planner') v.details.judge = 'needs review'; return v } })
    assert.deepEqual(await f.go(), stopped('seat-unmeasured'))
    if (tier === 'judge') { assert.deepEqual(f.calls, []); assert.deepEqual(f.rows, []) }
    else assert.equal(count(f, 'builder'), 0)
  }
})

test('the tech-lead turn is bounded like any seat, and a lead bounce past the builder bound gives that build its review and second review (b1487)', async () => {
  const bounded = fakes({ spec: { tier: 'judge' }, bounds: { 'tech-lead': 1, builder: 3 }, secondReview: 10, lead: 'escalate' })
  assert.deepEqual(await bounded.go(), stopped('lead-escalated'))
  assert.equal(count(bounded, 'tech-lead'), 1)
  assert.equal(bounded.requests.find((r) => r.role === 'lead').feedback[0].role, 'tech-lead')
  for (const tier of ['build', 'judge']) {
    const f = fakes({ spec: { tier }, review: tier === 'build' ? 2 : 0, secondReview: tier === 'judge' ? 2 : 0, lead: 'bounce', edit: (v) => { if (v.role === 'lead' && count(f, 'lead') > 1) v.details = { decision: 'accept' }; return v } })
    assert.deepEqual(await f.go(), { status: 'done', reason: null, pr: PR }, tier)
    if (tier === 'build') assert.deepEqual(f.requests.map((r) => r.role), ['planner', 'builder', 'reviewer', 'builder', 'reviewer', 'lead', 'builder', 'reviewer'])
    else { assert.equal(count(f, 'reviewer'), 3); assert.equal(count(f, 'tech-lead'), 3); assert.equal(count(f, 'lead'), 1) }
  }
})

const BODY = ['Source: "issue 12"', '', '## Measurements', '- proof: lib.test.mjs "works": red on the old source, green on the build', '- Suite: green; exit 0.'].join('\n')
const LANE = '\n\n## Lane\n- Wall time: 0 s before publication; publication unmeasured.\n- Rounds: planner 1, builder 1, reviewer 1, tech-lead 0.\n- Suite repairs: 0.\n- Lead consults: 0.'
test('a planner judge reason raises a build lane to judge before the build (PD4)', async () => {
  for (const mode of ['judge', 'none', 'throw']) {
    const f = fakes({ spec: { acceptance: ['A1'] }, throwJudge: mode === 'throw', edit: (v) => { if (v.role === 'planner') { if (mode !== 'none') v.details.judge = 'needs review' } return v } })
    const result = await f.go()
    assert.equal(result.status, mode === 'throw' ? 'stopped' : 'done')
    assert.deepEqual(f.tiers, mode === 'none' ? ['build'] : ['build', 'judge'])
    const raises = f.rows.filter((r) => r.event === 'tier-raised')
    assert.equal(raises.length, mode === 'judge' ? 1 : 0)
    if (mode === 'judge') assert.equal(raises[0].reason, 'planner-judge')
    if (mode === 'throw') { assert.equal(result.reason, 'seat-unmeasured'); assert.equal(count(f, 'builder'), 0) }
    else for (const r of f.requests.slice(1)) { assert.equal(r.tier, mode === 'judge' ? 'judge' : 'build'); assert.equal(r.seat.effort, mode === 'judge' ? 'xhigh' : 'high') }
  }
})

test('a protected path in files_in_scope or the diff raises the lane to judge, and a judge lane is never lowered (PD5)', async () => {
  for (const [path, scope, initial, raised, builderTier] of [
    ['crew/loop.mjs', null, 'build', true, 'build'], ['hooks/x.mjs', null, 'build', true, 'build'],
    ['lib.mjs', ['crew/loop.mjs'], 'build', true, 'judge'], ['crew/lean.mjs', null, 'build', false, 'build'],
    ['crew/loop.mjs', null, 'judge', false, 'judge'],
  ]) {
    const f = fakes({ spec: { tier: initial, acceptance: ['A1'] }, reviewPaths: ` M ${path}\0`, edit: (v) => { if (v.role === 'planner') { if (scope) v.details.files_in_scope = scope } return v } })
    assert.equal((await f.go()).status, 'done')
    assert.deepEqual(f.tiers, raised ? ['build', 'judge'] : [initial])
    assert.equal(f.requests.find((r) => r.role === 'builder').tier, builderTier)
    assert.equal(f.requests.find((r) => r.role === 'reviewer').tier, raised ? 'judge' : initial)
    const rows = f.rows.filter((r) => r.event === 'tier-raised')
    assert.equal(rows.length, raised ? 1 : 0)
    if (raised) { assert.equal(rows[0].reason, 'protected-path'); assert.deepEqual(rows[0].paths, scope ?? [path]) }
  }
})

test("the planner's tests alone decide proof: an empty list reaches the PR with proof: none, a named test needs one whatever plan.md says (PD7)", async () => {
  for (const namesTest of [false, true]) {
    const f = fakes({ plan: namesTest ? '## Properties\nNone.\n' : '## Properties\n- P1 test\n', edit: (v) => { if (v.role === 'planner' && !namesTest) v.details.tests = []; if (v.role === 'builder') v.details.tests = []; return v } })
    const result = await f.go()
    assert.deepEqual(f.requests.map((r) => r.role), namesTest ? ['planner', 'builder', 'builder'] : ['planner', 'builder', 'reviewer'])
    if (namesTest) {
      assert.equal(f.requests[2].feedback[0].id, 'proof-no-tests')
      assert.equal(result.reason, 'no-progress')
    } else {
      assert.equal(result.status, 'done')
      assert.ok(!f.calls.includes('proof'))
      for (const name of ['commit', 'publish']) assert.ok(f.seen[name].body.includes('- proof: none, no criterion is machine-checked'))
    }
  }
})

test('an escalate without details.question is a bounce to the same seat, and the lead stops lead-escalated only with its question', async () => {
  for (const role of ['planner', 'builder', 'reviewer', 'lead']) {
    let returned = false
    const f = fakes({ edit: (v) => {
      if (role === 'lead' && v.role === 'builder') return { ...v, status: 'escalate', details: { ...v.details, question: 'Builder question?' } }
      if (v.role === role && !returned) { returned = true; return role === 'lead' ? { ...v, details: { decision: 'escalate' } } : { ...v, status: 'escalate' } }
      return v
    } })
    const result = await f.go()
    const expected = role === 'planner' ? ['planner', 'planner', 'builder', 'reviewer'] : role === 'builder' ? ['planner', 'builder', 'builder', 'reviewer'] : role === 'reviewer' ? ['planner', 'builder', 'reviewer', 'reviewer'] : ['planner', 'builder', 'lead', 'lead']
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
        assert.deepEqual(builders[1].feedback[0], { id: 'plan-revised', plan_path: builders[1].planPath })
        if (tier === 'judge') {
          assert.deepEqual(builders[1].filesInScope, ['crew/loop.mjs'])
          assert.equal(builders[1].tier, 'judge')
          assert.equal(f.seen.publish.title, 'fix(crew): revised plan')
          assert.ok(f.seen.publish.body.includes('proof: none'))
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

// MUTATION: restore round-bound at the spent-lead stop.
test("the lead's last consult is marked last, and a spent lead bound stops for the operator with a question, never round-bound", async () => {
  const later = fakes({ review: 10, bounds: { builder: 1, reviewer: 10 }, lead: 'bounce', edit: (v) => {
    if (v.role === 'lead') v.summary = 'keep fixing R1'
    if (v.role === 'builder') v.summary = 'built R1'
    return v
  } })
  assert.deepEqual(await later.go(), stopped('lead-escalated'))
  assert.deepEqual(later.requests.filter((r) => r.role === 'lead').map((r) => r.feedback[0].last), [false, true])
  const observation = later.rows.findLast((r) => r.event === 'verdict').observation
  assert.equal(observation.bound, 'lead'); assert.equal(observation.role, 'builder'); assert.equal(observation.reason, 'round-bound')
  // MUTATION: build the question from the earlier builder return and the review finding never reaches the operator.
  for (const text of ['builder', 'round-bound', 'Fix the defect', 'Earlier lead decision: bounce', 'keep fixing R1']) assert.ok(observation.question.includes(text), text)
  assert.ok(!observation.question.includes('built R1'), observation.question)
  assert.deepEqual(observation.feedback.map((item) => item.summary).filter(Boolean), ['Fix the defect'])
  assert.ok(!later.rows.some((r) => r.event === 'verdict' && r.reason === 'round-bound'))

  const reask = fakes({ bounds: { lead: 1 }, edit: (v) => {
    if (v.role === 'planner') return { ...v, status: 'escalate', details: { ...v.details, question: 'What next?' } }
    if (v.role === 'lead') return { ...v, details: { decision: 'escalate' } }
    return v
  } })
  assert.deepEqual(await reask.go(), stopped('lead-escalated'))
  assert.equal(reask.requests.find((r) => r.role === 'lead').feedback[0].last, true)
  // MUTATION: drop held from the lead request and the current planner escalation is labelled an earlier return.
  const reasked = reask.rows.findLast((r) => r.event === 'verdict').observation.question
  assert.match(reasked, /planner/)
  assert.doesNotMatch(reasked, /last return:/)
})

test('a lead bounce names its target: planner revises the plan from the builder\'s envelope, builder keeps building', async () => {
  for (const target of ['planner', 'builder']) {
    let builds = 0, plans = 0
    const f = fakes({ lead: 'bounce', target, edit: (v) => {
      if (v.role === 'planner' && ++plans === 2) v.details.files_in_scope = ['revised.mjs']
      if (v.role === 'builder' && ++builds === 1) return { ...v, status: 'escalate', details: { ...v.details, question: 'What next?' } }
      return v
    } })
    const result = await f.go()
    assert.deepEqual(f.requests.map((r) => r.role), target === 'planner' ? ['planner', 'builder', 'lead', 'planner', 'builder', 'reviewer'] : ['planner', 'builder', 'lead', 'builder', 'reviewer'])
    assert.equal(result.status, 'done')
    if (target === 'planner') {
      assert.equal(f.requests[3].feedback[0].envelope.status, 'escalate')
      assert.equal(f.requests[3].feedback[0].lead, 'fixture')
      assert.deepEqual(f.requests[4].filesInScope, ['revised.mjs'])
    }
  }
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

const count = (f, role) => f.requests.filter((r) => r.role === role).length
const stopped = (reason) => ({ status: 'stopped', reason, pr: null })

// MUTATION: return pr null from the success result and the published PR is lost.
test('a green run walks every stage in order and returns the measured PR with each input forwarded', async () => {
  const f = fakes()
  assert.deepEqual(await f.go(), { status: 'done', reason: null, pr: PR })
  assert.deepEqual(f.calls, ['mkdir', ...SUCCESS])
  assert.deepEqual(f.seen.mkdir, ['/virtual/task', { recursive: true }])
  assert.deepEqual(f.seen.proof, { cwd: '/virtual/checkout', base: 'HEAD', tests: [{ file: 'lib.test.mjs', title: 'works' }], timeoutMs: 5000 })
  assert.deepEqual(f.seen.suite, { cwd: '/virtual/checkout', command: 'node', args: ['--test', 'lane.test.mjs'], timeoutMs: 5000 })
  assert.deepEqual(f.seen['review-paths'], f.seen.paths)
  assert.deepEqual(f.seen.paths, { cwd: '/virtual/checkout', command: 'git', args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'], timeoutMs: 5000 })
  assert.deepEqual(f.seen.commit, { cwd: '/virtual/checkout', files: ['lib.mjs'], subject: 'fix(crew): planned lane', body: BODY, closes: [12], refs: [13], timeoutMs: 5000 })
  assert.deepEqual(f.seen.fetch, { cwd: '/virtual/checkout', command: 'git', args: ['fetch', 'origin'], timeoutMs: 5000 })
  assert.deepEqual(f.seen.rebase, { cwd: '/virtual/checkout', base: 'main', timeoutMs: 5000 })
  assert.deepEqual(f.seen.publish, { cwd: '/virtual/checkout', branch: 'lane', base: 'main', title: 'fix(crew): planned lane', body: BODY + LANE, closes: [12], refs: [13], timeoutMs: 5000 })
  const planner = f.requests[0]
  assert.deepEqual(Object.keys(planner).sort(), ['brief', 'feedback', 'id', 'planPath', 'returnPath', 'role', 'seat', 'tier'])
  assert.deepEqual(Object.keys(f.requests[1]).sort(), [...Object.keys(planner), 'filesInScope'].sort())
  assert.deepEqual(Object.keys(f.requests[2]).sort(), [...Object.keys(planner), 'filesInScope', 'changedPaths', 'builderReport'].sort())
  assert.deepEqual(f.requests[1], { ...f.requests[1], role: 'builder', planPath: '/virtual/task/plan.md', feedback: [] })
  assert.equal(new Set(f.requests.map((r) => r.id)).size, f.requests.length)
  assert.equal(new Set(f.requests.map((r) => r.returnPath)).size, f.requests.length)
})

// MUTATION: omit or replace the accepted scope in builder and reviewer requests.
test('accepted scope survives repaired envelopes, repeated turns and finish', async () => {
  const scope = ['app/component.svelte', 'tests/a.rs']
  const f = fakes({ review: 1, edit: (value, request) => {
    if (value.role === 'planner') value.details.files_in_scope = request.repair ? scope : [123]
    if (value.role === 'builder' && !request.repair && request.id.endsWith('.2')) value.details.extra = true
    return value
  } })
  assert.equal((await f.go()).status, 'done')
  assert.ok(f.requests.some((r) => r.role === 'planner' && r.repair))
  assert.ok(f.requests.some((r) => r.role === 'builder' && r.repair))
  for (const request of f.requests.filter((r) => ['builder', 'reviewer'].includes(r.role))) assert.deepEqual(request.filesInScope, scope)
  const absent = fakes()
  assert.equal((await absent.go()).status, 'done')
  for (const request of absent.requests.slice(1)) assert.equal(request.filesInScope, null)
  const finish = fakes({ spec: finishSpec({ filesInScope: scope }), unseated: ['planner'] })
  assert.equal((await finish.go()).status, 'done')
  for (const request of finish.requests) assert.deepEqual(request.filesInScope, scope)
  const invalid = fakes({ spec: finishSpec({ filesInScope: [1] }), unseated: ['planner'] })
  assert.deepEqual(await invalid.go(), stopped('invalid-input'))
})

// MUTATION: forward the general timeout to the suite and the suite override never reaches the runner.
test('a suite timeout override reaches only the suite and absent overrides inherit the general timeout', async () => {
  for (const timeoutMs of [1, 1800000, Number.MAX_SAFE_INTEGER]) {
    const f = fakes({ spec: { suite: { command: 'node', args: ['--test', 'lane.test.mjs'], timeoutMs } } })
    assert.deepEqual(await f.go(), { status: 'done', reason: null, pr: PR })
    assert.deepEqual(f.seen.suite, { cwd: '/virtual/checkout', command: 'node', args: ['--test', 'lane.test.mjs'], timeoutMs })
    for (const stage of ['proof', 'review-paths', 'paths', 'commit', 'fetch', 'rebase', 'publish']) assert.equal(f.seen[stage].timeoutMs, 5000, stage)
  }
  const inherit = fakes({ spec: { suite: { command: 'node', timeoutMs: undefined } } })
  await inherit.go()
  assert.equal(inherit.seen.suite.timeoutMs, 5000)
  const neither = fakes({ spec: { timeoutMs: undefined, suite: { command: 'node' } } })
  await neither.go()
  assert.equal(neither.seen.suite.timeoutMs, undefined)
})

// MUTATION: drop the suite timeout validation and an unsound override starts the lane.
test('an invalid suite timeout override is refused before any dependency or journal effect', async () => {
  const invalid = [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '1800000', null, true, {}, []]
  for (const timeoutMs of invalid) {
    const f = fakes({ spec: { suite: { command: 'node', timeoutMs } } })
    assert.deepEqual(await f.go(), stopped('invalid-input'), String(timeoutMs))
    assert.deepEqual(f.calls, [])
    assert.deepEqual(f.rows, [])
    assert.equal(f.requests.length, 0)
  }
})

// MUTATION: let a suite override swallow the timeout stop and a timed-out suite publishes.
test('a measured suite timeout under an override stops the lane with no commit, fetch, rebase or publish', async () => {
  const f = fakes({ spec: { suite: { command: 'node', timeoutMs: 1800000 } }, suite: { ...green(), status: 'unmeasured', reason: 'timeout', timedOut: true } })
  assert.deepEqual(await f.go(), stopped('timeout'))
  assert.equal(f.seen.suite.timeoutMs, 1800000)
  for (const effect of ['paths', 'commit', 'publish']) assert.equal(f.calls.includes(effect), false, effect)
})


const gaps = (v) => ({ ...v, details: { ...v.details, gaps: [] } })
const nth = (role, turn, edit) => (v, r) => (r.role === role && Number(r.id.split('.').at(-1)) === turn ? edit(v) : v)

// MUTATION: allow no repair turn and the b1385 builder envelope with one extra field ends the lane.
test('a schema-refused envelope gets one repair turn on the same id and path, and the lane continues without a lost round', async () => {
  for (const role of ['planner', 'builder', 'reviewer']) {
    const f = fakes({ bounds: { [role]: 1 }, edit: (v, r) => (r.role === role && !r.repair ? gaps(v) : v) })
    assert.equal((await f.go()).status, 'done', role)
    const [first, repair] = f.requests.filter((r) => r.role === role)
    assert.equal(f.requests.filter((r) => r.role === role).length, 2, role)
    assert.deepEqual(repair.repair, { defects: [`details.gaps is not a field of ${role} details`] }, role)
    assert.equal(first.repair, undefined)
    assert.equal(repair.id, first.id)
    assert.equal(repair.returnPath, first.returnPath)
    const seen = f.rows.filter((r) => r.event === 'envelope' && r.role === role)
    assert.equal(seen.length, 2)
    assert.equal(seen[0].defects.length, 1)
    assert.deepEqual(seen[1].defects, [])
    assert.equal(count(f, 'lead'), 0)
  }
  // the repair costs no round: a builder bound of two still serves the build that review sends back
  const f = fakes({ review: 1, bounds: { builder: 2 }, edit: (v, r) => (r.role === 'builder' && !r.repair && r.feedback.length === 0 ? gaps(v) : v) })
  assert.equal((await f.go()).status, 'done')
  assert.equal(count(f, 'builder'), 3)
  assert.deepEqual(f.requests.filter((r) => r.role === 'builder').at(-1).feedback, [finding])
  for (const raw of ['null', '[]', '42']) {
    const parsedRoot = fakes({ edit: (v, r) => (r.role === 'builder' && !r.repair ? raw : v) })
    assert.equal((await parsedRoot.go()).status, 'done', raw)
    assert.equal(count(parsedRoot, 'builder'), 2, raw)
  }
})

// MUTATION: skip the second validation and a repaired envelope that is still bad advances.
test('a repaired envelope that is refused again stops the lane with no third turn', async () => {
  const cases = {
    'same defect': (v) => gaps(v),
    'different defect': (v) => ({ ...v, summary: '' }),
    'stale id': (v) => ({ ...v, id: 'stale-return' }),
    'not JSON': () => '{',
  }
  for (const [name, edit] of Object.entries(cases)) {
    const f = fakes({ edit: (v, r) => (r.role === 'builder' ? (r.repair ? edit(v) : gaps(v)) : v) })
    assert.deepEqual(await f.go(), stopped('envelope-refused'), name)
    assert.equal(count(f, 'builder'), 2, name)
    assert.equal(f.calls.includes('proof'), false, name)
    assert.equal(count(f, 'lead'), 0, name)
  }
  for (const [name, options, reason] of [
    ['empty', { edit: (v, r) => (r.role === 'builder' ? (r.repair ? '' : gaps(v)) : v) }, 'seat-unmeasured'],
    ['seat failure', { edit: (v, r) => (r.role === 'builder' ? gaps(v) : v) }, 'seat-unmeasured'],
  ]) {
    const f = fakes(options)
    let dispatched = 0
    if (name === 'seat failure') {
      const run = f.deps.runSeat
      f.deps.runSeat = async (request) => { if (request.role === 'builder') dispatched += 1; if (request.repair) throw new Error('repair crashed'); return run(request) }
    }
    assert.deepEqual(await f.go(), stopped(reason), name)
    assert.equal(name === 'seat failure' ? dispatched : count(f, 'builder'), name === 'seat failure' ? 3 : 2, name)
    assert.equal(f.calls.includes('proof'), false, name)
  }
  // a refused repair of the lead is a lead refusal
  const lead = fakes({ edit: (v) => (v.role === 'planner' ? { ...v, status: 'escalate', details: { ...v.details, question: 'What next?' } } : v.role === 'lead' ? gaps(v) : v) })
  assert.deepEqual(await lead.go(), stopped('lead-refused'))
  assert.equal(count(lead, 'lead'), 2)
})

// MUTATION: repair a file that was never JSON, or one refused only for its id or skill proof.
test('a non-JSON, empty, unreadable, id-only or proof-only refusal gets no repair turn', async () => {
  for (const [options, reason] of [
    [{ edit: () => '{' }, 'envelope-refused'],
    [{ edit: () => 'not JSON' }, 'envelope-refused'],
    [{ edit: () => '' }, 'seat-unmeasured'],
    [{ readError: 'EPERM' }, 'seat-unmeasured'],
    [{ seatThrows: 'planner' }, 'seat-unmeasured'],
    [{ edit: (v) => ({ ...v, id: 'stale-return' }) }, 'envelope-refused'],
    [required([]), 'envelope-refused'],
  ]) {
    const f = fakes(options)
    assert.deepEqual(await f.go(), stopped(reason))
    assert.equal(count(f, 'planner'), options.seatThrows ? 2 : 1)
    assert.equal(f.requests.some((r) => r.repair), false)
  }
})

// MUTATION: prove only the repair turn's recording and unproven work is laundered by a fresh repair.
test('a repair does not launder an unproven original and must itself prove its required skills', async () => {
  for (const unproven of [1, 2]) {
    const f = fakes({
      edit: (v, r) => (r.role === 'builder' && !r.repair ? gaps(v) : v),
      recording: (r) => (r.role === 'builder' ? { definition: { agent: 'pi', requires: ['alpha'], skills: ['alpha'], writes: 'repo' }, rows: (r.repair ? 2 : 1) === unproven ? [] : [LOAD, DONE] } : null),
    })
    assert.deepEqual(await f.go(), stopped('envelope-refused'), `turn ${unproven}`)
    assert.equal(count(f, 'builder'), 2)
    assert.equal(f.calls.includes('proof'), false)
  }
  const both = fakes({
    edit: (v, r) => (r.role === 'builder' && !r.repair ? gaps(v) : v),
    recording: (r) => (r.role === 'builder' ? { definition: { agent: 'pi', requires: ['alpha'], skills: ['alpha'], writes: 'repo' }, rows: [LOAD, DONE] } : null),
  })
  assert.equal((await both.go()).status, 'done')
})

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

test('changes-needed carries the exact findings to the next build and repeats proof and review before the suite', async () => {
  const f = fakes({ review: 1 })
  assert.equal((await f.go()).status, 'done')
  const builders = f.requests.filter((r) => r.role === 'builder')
  assert.equal(builders.length, 2)
  assert.deepEqual(builders[0].feedback, [])
  assert.deepEqual(builders[1].feedback, [finding])
  assert.deepEqual(f.calls.slice(1, 17), ['seat:planner', 'fetch', 'rebase', 'seat:builder', 'proof', 'review-paths', 'suite-stage', 'checked-tree', 'suite', 'seat:reviewer', 'seat:builder', 'proof', 'review-paths', 'suite-stage', 'checked-tree', 'suite'])
  assert.equal(count(f, 'planner'), 1)
})

// MUTATION: drop the per-role bound check and a seat is dispatched past its declared rounds.
test('a declared bound ends in the lead and the default bound is two', async () => {
  assert.equal(DEFAULT_ROUNDS, 2)
  const declared = fakes({ review: 10, bounds: { builder: 1 } })
  assert.deepEqual(await declared.go(), stopped('lead-escalated'))
  assert.equal(count(declared, 'builder'), 1)
  assert.equal(count(declared, 'lead'), 1)
  assert.equal(declared.calls.includes('commit'), false)
  const byDefault = fakes({ review: 10 })
  assert.deepEqual(await byDefault.go(), stopped('lead-escalated'))
  assert.equal(count(byDefault, 'builder'), 2)
  assert.equal(count(byDefault, 'reviewer'), 2)
})

// MUTATION: reset the obstructed seat's bound on a bounce and the retry becomes unlimited.
test('a lead bounce grants one retry, repeated bounces are bounded by the lead and an escalate ends the lane', async () => {
  const once = fakes({ review: 1, bounds: { builder: 1 }, lead: 'bounce' })
  assert.equal((await once.go()).status, 'done')
  assert.equal(count(once, 'lead'), 1)
  assert.equal(count(once, 'builder'), 2)
  const repeated = fakes({ review: 10, bounds: { builder: 1, reviewer: 10 }, lead: 'bounce' })
  assert.deepEqual(await repeated.go(), stopped('lead-escalated'))
  assert.equal(count(repeated, 'lead'), 2)
  assert.equal(count(repeated, 'builder'), 3)
  assert.equal(repeated.calls.includes('commit'), false)
  const retried = fakes({ lead: 'bounce', edit: (v, r) => r.role === 'planner' && r.id.endsWith('.1') ? { ...v, status: 'insufficient' } : v })
  assert.equal((await retried.go()).status, 'done')
  assert.equal(count(retried, 'planner'), 2)
})

// MUTATION: grant a whole extra round on every bounce and a seat with turns left outruns its bound unsupervised.
test('a lead bounce on a seat with turns left does not raise its bound, so the next exhausted bound is put to the lead again', async () => {
  const f = fakes({ review: 2, lead: 'bounce', edit: (v) => v.id === 'lane.builder.2' ? { ...v, status: 'escalate', details: { ...v.details, question: 'What next?' } } : v })
  await f.go()
  assert.deepEqual(f.requests.map((r) => r.role).slice(0, 7), ['planner', 'builder', 'lead', 'builder', 'reviewer', 'lead', 'builder'])
})

// MUTATION: let accept pass with no valid envelope and a bound or lead decision stands in for a measurement.
test('a lead accept releases only a valid non-done envelope and never an exhausted bound', async () => {
  const escalated = fakes({ lead: 'accept', edit: (v) => v.role === 'planner' ? { ...v, status: 'escalate', details: { ...v.details, question: 'What next?' } } : v })
  assert.equal((await escalated.go()).status, 'done')
  assert.equal(count(escalated, 'lead'), 1)
  assert.deepEqual(escalated.requests.find((r) => r.role === 'lead').feedback.map((x) => [x.role, x.reason, x.envelope.status]), [['planner', 'escalate', 'escalate']])
  const exhausted = fakes({ lead: 'accept', review: 10, bounds: { builder: 1 } })
  assert.deepEqual(await exhausted.go(), stopped('lead-escalated'))
  assert.equal(count(exhausted, 'lead'), 2)
  assert.equal(exhausted.calls.includes('commit'), false)
  const changes = fakes({ lead: 'accept', review: 10, edit: (v) => v.role === 'reviewer' ? { ...v, status: 'escalate', details: { ...v.details, question: 'What next?' } } : v })
  assert.notEqual((await changes.go()).status, 'done')
  assert.equal(changes.calls.includes('suite'), true)

})

// MUTATION: consult a missing lead anyway, or let a bad lead envelope decide.
test('an unseated, refusing or insufficient lead stops without recursion', async () => {
  const none = fakes({ unseated: ['lead'], edit: (v) => v.role === 'planner' ? { ...v, status: 'escalate', details: { ...v.details, question: 'What next?' } } : v })
  assert.deepEqual(await none.go(), stopped('lead-unavailable'))
  assert.equal(count(none, 'lead'), 0)
  const bad = fakes({ edit: (v) => v.role === 'planner' ? { ...v, status: 'escalate', details: { ...v.details, question: 'What next?' } } : v.role === 'lead' ? { ...v, extra: 1 } : v })
  assert.deepEqual(await bad.go(), stopped('lead-refused'))
  assert.equal(count(bad, 'lead'), 2)
  const insufficient = fakes({ edit: (v) => v.role === 'planner' || v.role === 'lead' ? { ...v, status: 'insufficient' } : v })
  assert.deepEqual(await insufficient.go(), stopped('lead-escalated'))
  assert.equal(count(insufficient, 'lead'), 1)
  const undecided = fakes({ edit: (v) => v.role === 'planner' ? { ...v, status: 'insufficient' } : v.role === 'lead' ? { ...v, status: 'insufficient', details: {} } : v })
  assert.deepEqual(await undecided.go(), stopped('lead-refused'))
  const crashed = fakes({ seatThrows: 'lead', edit: (v) => v.role === 'planner' ? { ...v, status: 'escalate', details: { ...v.details, question: 'What next?' } } : v })
  assert.deepEqual(await crashed.go(), stopped('lead-refused'))
})

// MUTATION: drop the overall proof decision and a surviving or incomplete proof reaches review.

// MUTATION: trust a non-green proof and the review and commit run on a build that does not pass.

// MUTATION: skip the suite decision and a red or unmeasured suite still commits.
test('a red, unmeasured or malformed-green suite never commits', async () => {
  const cases = [
    [{ ...green(), status: 'red', code: 1, reason: 'exit-nonzero' }, 'exit-nonzero'],
    [{ ...green(), status: 'unmeasured', code: null, reason: 'timeout' }, 'timeout'],
    [{ ...green(), code: 1 }, 'runner-threw'],
    [{ ...green(), signal: 'SIGKILL' }, 'runner-threw'],
    [{ ...green(), timedOut: true }, 'runner-threw'],
    [{ ...green(), reason: 'timeout' }, 'runner-threw'],
    [{ status: 'green' }, 'runner-threw'],
  ]
  for (const [suite, reason] of cases) {
    const f = fakes({ suite })
    assert.deepEqual(await f.go(), stopped(suite.status === 'red' ? 'lead-escalated' : reason), JSON.stringify(suite))
    assert.equal(f.calls.includes('commit'), false)
  }
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
const EFFECTS = ['paths', 'commit', 'fetch', 'rebase', 'publish']

// MUTATION: never re-run a red suite and a flaky first red stops the lane.
test('a red suite is run once more and a green re-run reaches commit with both runs in the PR measurements', async () => {
  const f = sequenced([redRun(7), green(), redRun(9)], { spec: { ...finishSpec(), suite: { command: 'node', args: ['--test', 'lane.test.mjs'], timeoutMs: 1800000 } } })
  const { inputs } = f
  assert.deepEqual(await f.go(), { status: 'done', reason: null, pr: null })
  assert.equal(inputs.length, 2)
  assert.deepEqual(inputs[1], inputs[0])
  assert.deepEqual(inputs[0], { cwd: '/virtual/checkout', command: 'node', args: ['--test', 'lane.test.mjs'], timeoutMs: 1800000 })
  assert.deepEqual(f.calls.filter((c) => ['suite', ...EFFECTS].includes(c)), ['fetch', 'rebase', 'suite', 'suite', ...EFFECTS.filter((c) => c !== 'publish')])
  assert.match(f.seen.commit.body, /Suite: green; exit 0 \(re-run after red; exit 7\)/)
  assert.ok(JSON.parse(f.writes.get('/virtual/task/finish-report.json')).body.includes('## Lane'))
  assert.deepEqual(f.rows.filter((r) => r.event === 'check' && r.check === 'suite').map((r) => r.result.status), ['red', 'green'])
})

const SPEC_OUT = ['ℹ failing tests:', 'test at skills/qa-test-writing/exhibits.test.mjs:42:1', '✖ anchor spans remain current (2ms)', '  AssertionError: stale'].join('\n')
const TAP_OUT = ['not ok 1 - exhibit census remains current', '  ---', "  location: '/virtual/checkout/skills/ux/exhibits.test.mjs:73:1'", '  ...'].join('\n')
const redOut = (stdout) => ({ ...redRun(1), stdout })
const builderTurns = (f) => f.requests.filter((r) => r.role === 'builder')
test('a mechanical suite red goes straight to one builder fix before the suite runs again', async () => {
  for (const after of [green(), redOut(TAP_OUT)]) {
    const f = sequenced([redOut(SPEC_OUT), after, green()], { spec: { tier: 'mechanical' }, unseated: ['planner', 'reviewer', 'lead'], edit: (v) => {
      if (v.role === 'builder') v.details.subject = 'docs(crew): fix typo'
      return v
    } })
    const result = await f.go()
    assert.equal(result.status, after.status === 'green' ? 'done' : 'stopped')
    if (after.status === 'red') assert.equal(result.reason, 'exit-nonzero')
    assert.equal(builderTurns(f).length, 2)
    assert.deepEqual(builderTurns(f)[1].feedback[0].outputTail, [SPEC_OUT])
    assert.match(builderTurns(f)[1].feedback[0].summary, /suite is red after your change/)
    assert.deepEqual(f.calls.slice(f.calls.indexOf('suite'), f.calls.lastIndexOf('suite') + 1), ['suite', 'seat:builder', 'proof', 'review-paths', 'suite-stage', 'checked-tree', 'suite'])
    assert.equal(f.calls.includes('publish'), after.status === 'green')
  }
})

// MUTATION: apply the single-turn bound to a mechanical repair escalation.
test('a mechanical suite-repair escalation reaches the lead or reports it unavailable', async () => {
  for (const seated of [false, true]) {
    const f = sequenced([redRun(), green()], { spec: { tier: 'mechanical' }, unseated: ['planner', 'reviewer', ...(!seated ? ['lead'] : [])], edit: (v, req) => {
      if (v.role === 'builder') {
        v.details.subject = 'fix(crew): repair suite'
        if (req.feedback.some((i) => i.id === 'suite-repair')) return { ...v, status: 'escalate', details: { ...v.details, question: 'Which fix?' } }
      }
      return v
    } })
    const result = await f.go()
    assert.equal(result.status, 'stopped')
    assert.equal(result.reason, seated ? 'lead-escalated' : 'lead-unavailable')
    assert.equal(builderTurns(f).length, 2)
    assert.equal(f.requests.filter((r) => r.role === 'lead').length, seated ? 1 : 0)
  }
})

// MUTATION: omit scope on a suite-repair turn.
test('suite repair keeps the accepted scope', async () => {
  const scope = ['src/widget.svelte']
  const f = sequenced([redRun(1), green()], { edit: (v) => v.role === 'planner' ? { ...v, details: { ...v.details, files_in_scope: scope } } : v })
  assert.equal((await f.go()).status, 'done')
  assert.equal(builderTurns(f).length, 2)
  for (const r of f.requests.filter((r) => ['builder', 'reviewer'].includes(r.role))) assert.deepEqual(r.filesInScope, scope)
})

// MUTATION: drop the feedback at the repair call, or skip the repair turn, and a double red stops without a builder.
test('a suite red on both runs gives the builder one repair turn whose feedback names the failing tests and files', async () => {
  const f = sequenced([redOut(SPEC_OUT), redOut(TAP_OUT), green()], { spec: finishSpec() })
  assert.deepEqual((await f.go()).status, 'done')
  assert.equal(builderTurns(f).length, 2)
  assert.equal(builderTurns(f)[0].feedback[0].id, 'finish-stop')
  const feedback = JSON.stringify(builderTurns(f)[1].feedback)
  for (const needle of ['skills/qa-test-writing/exhibits.test.mjs', 'skills/ux/exhibits.test.mjs', 'anchor spans remain current', 'exhibit census remains current']) assert.ok(feedback.includes(needle), needle)
  assert.equal(feedback.includes('anchor-pin.mjs'), false, 'the repair hint names no deleted tool')
  // parsed names never drop the diagnostics: both runs' output tails ride along
  assert.deepEqual(builderTurns(f)[1].feedback[0].outputTail, [SPEC_OUT, TAP_OUT])
  const empty = sequenced([redRun(1), redRun(1), green()], { spec: finishSpec() })
  assert.equal((await empty.go()).status, 'done')
  assert.equal(builderTurns(empty).length, 2)
  // the repair turn and its review are granted even when review fixes spent both rounds, and need no lead
  const spent = sequenced([redOut(SPEC_OUT), redOut(TAP_OUT), green()], { spec: finishSpec(), review: 1, bounds: { builder: 2, reviewer: 2 } })
  assert.equal((await spent.go()).status, 'done')
  assert.equal(builderTurns(spent).length, 3)
  assert.equal(count(spent, 'lead'), 0)
})

// MUTATION: skip the fresh proof, review or suite after the repair and an unproven green is published.
test('after a suite repair the proof, review and suite run again, then the lane commits and opens its PR with every measurement', async () => {
  const f = sequenced([redRun(1), redRun(2), green()], { spec: finishSpec() })
  assert.deepEqual(await f.go(), { status: 'done', reason: null, pr: null })
  const at = f.calls.lastIndexOf('seat:builder')
  assert.deepEqual(f.calls.slice(at), ['seat:builder', 'proof', 'review-paths', 'suite-stage', 'checked-tree', 'seat:reviewer', 'suite', 'paths', 'checked-tree', 'commit', 'fetch', 'rebase'])
  assert.equal(f.inputs.length, 3)
  assert.deepEqual(f.inputs[2], f.inputs[0])
  assert.match(f.seen.commit.body, /Suite: green; exit 0/)
  assert.ok(JSON.parse(f.writes.get('/virtual/task/finish-report.json')).body.includes('## Lane'))

})

// MUTATION: accept a red repaired suite, retry it, or let a non-done repair bounce into more builders.
test('a suite still red after the repair turn stops with no second repair turn and no publication', async () => {
  // the repaired suite gets the same single re-run as any red suite, and two more reds stop the lane
  const f = sequenced([redRun(1), redRun(2), redRun(3), redRun(4), green()], { spec: finishSpec() })
  assert.deepEqual(await f.go(), stopped('exit-nonzero'))
  assert.equal(builderTurns(f).length, 2)
  assert.equal(f.inputs.length, 4)
  for (const effect of EFFECTS) assert.equal(f.calls.slice(f.calls.indexOf('seat:builder')).includes(effect), false, effect)
  for (const post of [timeoutRun(), new Error('crashed'), { ...green(), code: 4 }]) {
    const r = sequenced([redRun(), redRun(), post, green()], { spec: finishSpec() })
    assert.equal((await r.go()).status, 'stopped')
    assert.equal(builderTurns(r).length, 2)
    assert.equal(r.inputs.length, 3)
    for (const effect of EFFECTS) assert.equal(r.calls.slice(r.calls.indexOf('seat:builder')).includes(effect), false, effect)
  }
  for (const status of ['insufficient', 'escalate']) {
    const r = sequenced([redRun(), redRun(), green()], { spec: finishSpec(), lead: 'bounce', edit: (v, req) => req.role === 'builder' && req.feedback.some((item) => item.id === 'suite-repair') ? { ...v, status } : v })
    assert.equal((await r.go()).status, 'stopped')
    assert.equal(builderTurns(r).length, 2)
    assert.equal(count(r, 'lead'), 0)
    for (const effect of EFFECTS) assert.equal(r.calls.slice(r.calls.indexOf('seat:builder')).includes(effect), false, effect)
  }
})

// MUTATION: let a re-run turn an unmeasured result into green, or re-run an unmeasured first result.
test('an unmeasured suite is never re-run and never turned green by a re-run', async () => {
  const unknowns = [[timeoutRun(), 'timeout'], [new Error('crashed'), 'runner-threw'], [{ ...green(), code: 4 }, 'runner-threw'], [{ status: 'green' }, 'runner-threw']]
  for (const [unknown, reason] of unknowns) {
    const initial = sequenced([unknown, green()], { spec: finishSpec() })
    assert.deepEqual(await initial.go(), stopped(reason))
    assert.equal(initial.inputs.length, 1)
    const rerun = sequenced([redRun(), unknown, green()], { spec: finishSpec() })
    assert.deepEqual(await rerun.go(), stopped(reason))
    assert.equal(rerun.inputs.length, 2)
    for (const f of [initial, rerun]) for (const effect of EFFECTS) assert.equal(f.calls.slice(f.calls.indexOf('seat:builder')).includes(effect), false, effect)
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
    assert.deepEqual(f.calls.filter((c) => order.includes(c)), ['fetch', ...(failedAt === 'fetch' ? [] : ['rebase']), ...(failedAt === 'fetch' || failedAt === 'rebase' ? [] : order.slice(0, order.indexOf(failedAt) + 1))])
    assert.ok(LOOP_REASONS.includes(reason))
  }
  const thrown = fakes({ throwCheck: 'rebase' })
  assert.deepEqual(await thrown.go(), stopped('runner-threw'))
  assert.equal(thrown.calls.includes('publish'), false)
})

// MUTATION: drop the stage-end emit and a refused or thrown stage never closes in the journal.
test('every started stage ends on success and refusal, in order', async () => {
  const pairs = (rows) => rows.filter((r) => r.event === 'stage-start' || r.event === 'stage-end').map((r) => [r.event, r.stage])
  const ok = fakes()
  await ok.go()
  assert.deepEqual(pairs(ok.rows).filter(([, s]) => !['suite', 'review'].includes(s)), STAGES.filter((s) => !['suite', 'review'].includes(s)).flatMap((s) => [['stage-start', s], ['stage-end', s]]))
  assert.deepEqual(pairs(ok.rows).filter(([, s]) => ['suite', 'review'].includes(s)), [['stage-start', 'suite'], ['stage-start', 'review'], ['stage-end', 'suite'], ['stage-end', 'review']])
  assert.ok(ok.rows.every((r) => r.lane === 'lane' && typeof r.event === 'string' && 'stage' in r))
  const refused = fakes({ suite: { ...green(), status: 'red', code: 1, reason: 'exit-nonzero' } })
  await refused.go()
  for (const name of new Set(pairs(refused.rows).map(([, s]) => s))) assert.equal(pairs(refused.rows).filter(([event, s]) => event === 'stage-start' && s === name).length, pairs(refused.rows).filter(([event, s]) => event === 'stage-end' && s === name).length, name)
  const thrown = fakes({ deps: { mkdir: async () => {}, resolveAgents: undefined } })
  assert.deepEqual(await thrown.go(), stopped('invalid-input'))
  const lead = fakes({ edit: (v) => v.role === 'planner' ? { ...v, status: 'escalate', details: { ...v.details, question: 'What next?' } } : v })
  await lead.go()
  assert.deepEqual(pairs(lead.rows), [['stage-start', 'plan'], ['stage-start', 'lead'], ['stage-end', 'lead'], ['stage-end', 'plan']])
  const crashing = fakes({ deps: { readFile: async () => { throw new Error('boom') } } })
  await crashing.go()
  assert.deepEqual(pairs(crashing.rows), [['stage-start', 'plan'], ['stage-end', 'plan']])
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

test('every loop-only stop reason is emitted by the loop source', () => {
  const source = readFileSync(fileURLToPath(new URL('./loop.mjs', import.meta.url)), 'utf8').replace(/export const LOOP_REASONS = Object\.freeze\(\[[\s\S]*?\]\)/, '')
  for (const reason of LOOP_REASONS.filter((r) => !CHECK_REASONS.includes(r))) assert.ok(source.includes(`'${reason}'`), reason)
})

// MUTATION: drop the journal call and the lane leaves no observation record.
test('the journal carries each envelope, verdict, check, commit and PR observation and a failing journal changes nothing', async () => {
  const f = fakes()
  await f.go()
  const events = (name) => f.rows.filter((r) => r.event === name)
  assert.deepEqual(events('envelope').map((r) => [r.role, r.id, r.parsed.status, r.defects, r.error]), [
    ['planner', 'lane.planner.1', 'done', [], null], ['builder', 'lane.builder.2', 'done', [], null], ['reviewer', 'lane.reviewer.3', 'done', [], null],
  ])
  assert.deepEqual(events('check').map((r) => r.check), ['fetch', 'rebase', 'proof', 'review-paths', 'suite-stage', 'checked-tree', 'suite', 'paths', 'checked-tree', 'commit', 'fetch', 'rebase', 'publish'])
  assert.equal(events('check').find((r) => r.check === 'proof').result.rows[0].proven, true)
  assert.deepEqual(events('verdict').map((r) => [r.status, r.verdict]), [['reviewed', 'pass']])
  assert.deepEqual(events('commit').map((r) => r.head), ['a'.repeat(40)])
  assert.deepEqual(events('pr').map((r) => r.pr), [PR])
  const stoppedRun = fakes({ proof: { status: 'unmeasured', reason: 'timeout', rows: [] } })
  await stoppedRun.go()
  const verdict = stoppedRun.rows.find((r) => r.event === 'verdict')
  assert.deepEqual([verdict.status, verdict.reason], ['stopped', 'timeout'])
  const malformed = fakes({ suite: { status: 'green', reason: 'timeout' } })
  await malformed.go()
  assert.equal(malformed.rows.find((r) => r.event === 'check' && r.check === 'suite').result.reason, 'timeout')
  for (const journal of [() => { throw new Error('sync full') }, async () => { throw new Error('async full') }, () => Promise.reject(new Error('rejected'))]) {
    const { status, reason, pr } = await fakes({ journal }).go()
    assert.deepEqual({ status, reason, pr }, { status: 'done', reason: null, pr: PR })
    const failed = await fakes({ journal, suite: { ...green(), status: 'red', code: 1, reason: 'exit-nonzero' } }).go()
    assert.deepEqual({ status: failed.status, reason: failed.reason, pr: failed.pr }, stopped('lead-escalated'))
  }
})

// MUTATION: skip input validation and an unsupported or malformed lane starts effects.
test('an unsupported shape, invalid input or unsound seam is refused before any effect', async () => {
  const cases = [
    [{ shape: 'stepped' }, 'unsupported-shape'], [{ shape: 'finish' }, 'invalid-input'], [{ shape: undefined }, 'unsupported-shape'],
    [{ tier: 'rigorous' }, 'invalid-input'], [{ id: '' }, 'invalid-input'], [{ cwd: 3 }, 'invalid-input'], [{ taskDir: undefined }, 'invalid-input'],
    [{ brief: '' }, 'invalid-input'],
    [{ suite: null }, 'invalid-input'], [{ suite: { command: '' } }, 'invalid-input'],
    [{ source: '' }, 'invalid-input'], [{ source: undefined }, 'invalid-input'], [{ source: 7 }, 'invalid-input'], [{ branch: undefined }, 'invalid-input'], [{ base: undefined }, 'invalid-input'],
    [{ timeoutMs: 0 }, 'invalid-input'], [{ timeoutMs: -1 }, 'invalid-input'], [{ timeoutMs: 1.5 }, 'invalid-input'], [{ timeoutMs: Infinity }, 'invalid-input'],
    [{ closes: 12 }, 'invalid-input'],
  ]
  for (const [spec, reason] of cases) {
    const f = fakes({ spec })
    assert.deepEqual(await f.go(), stopped(reason), JSON.stringify(spec))
    assert.deepEqual([f.calls, f.rows], [[], []])
  }
  for (const name of ['runSeat', 'journal', 'readFile', 'proveTests', 'openPullRequest', 'run']) {
    const f = fakes({ deps: { [name]: undefined } })
    assert.deepEqual(await f.go(), stopped('invalid-input'), name)
    assert.deepEqual(f.calls, [])
  }
  assert.deepEqual(await runLoop(null, {}), stopped('invalid-input'))
  assert.deepEqual(await runLoop(fakes().spec), stopped('invalid-input'))
})

// MUTATION: treat a missing role, a failed lookup or a bad bound as usable and the lane starts with a hole.
test('a missing required seat, failed agent lookup or invalid declared bound is refused before any effect', async () => {
  for (const role of ['planner', 'builder', 'reviewer']) {
    const f = fakes({ unseated: [role] })
    assert.deepEqual(await f.go(), stopped('seat-unmeasured'), role)
    assert.deepEqual(f.calls, [])
  }
  const lookup = fakes({ deps: { resolveAgents: () => { throw new Error('agent definitions are refused') } } })
  assert.deepEqual(await lookup.go(), stopped('seat-unmeasured'))
  assert.deepEqual(lookup.calls, [])
  for (const rounds of [0, -1, 1.5, '2', null, Infinity]) {
    const f = fakes({ deps: { resolveAgents: () => ({ seats: { planner: { rounds }, builder: {}, reviewer: {}, lead: {} } }) } })
    assert.deepEqual(await f.go(), stopped('invalid-input'), String(rounds))
    assert.deepEqual(f.calls, [])
  }
})

// MUTATION: let a mkdir failure continue and the seats write into a task directory that does not exist.
test('a task directory that cannot be made stops the lane before any seat', async () => {
  const f = fakes({ deps: { mkdir: async () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) } } })
  assert.deepEqual(await f.go(), stopped('runner-threw'))
  assert.equal(count(f, 'planner'), 0)
})

// MUTATION: a reason outside the closed enum leaks into the result.
test('every stopped reason is a member of the closed enum', async () => {
  assert.ok(Object.isFrozen(LOOP_REASONS))
  for (const reason of CHECK_REASONS) assert.ok(LOOP_REASONS.includes(reason))
  for (const reason of ['unsupported-shape', 'envelope-refused', 'seat-unmeasured', 'lead-escalated', 'lead-unavailable', 'lead-refused', 'round-bound', 'paths-unmeasured', 'no-progress']) assert.ok(LOOP_REASONS.includes(reason))
  const f = fakes({ suite: { status: 'red', reason: 'free text the enum has never heard of' } })
  assert.deepEqual(await f.go(), stopped('runner-threw'))
})

// MUTATION: forward spec.mutations to the proof and a caller-written declaration replaces the planner's.

// MUTATION: send the caller's list or an unparsed line to commit and a rename end, an odd name or a deletion is left out.
test('the commit receives the paths git reports after the suite, both rename ends included', async () => {
  const cases = [
    ['M  src/a.mjs\0A  new file.txt\0R  renamed.mjs\0old.mjs\0D  deleted.mjs\0', ['src/a.mjs', 'new file.txt', 'renamed.mjs', 'old.mjs', 'deleted.mjs']],
    ['C  copy.mjs\0src.mjs\0', ['copy.mjs', 'src.mjs']],
    ['R  renamed-in-tree.mjs\0before.mjs\0', ['renamed-in-tree.mjs', 'before.mjs']],
    ['M  both.mjs\0A  both.mjs\0', ['both.mjs']],
    ['A  line\nbreak.txt\0A  "quoted".txt\0', ['line\nbreak.txt', '"quoted".txt']],
    ['', []],
  ]
  for (const [paths, files] of cases) {
    const f = fakes({ paths, reviewPaths: paths })
    assert.equal((await f.go()).status, 'done', paths)
    assert.deepEqual(f.seen.commit.files, files, paths)
    const order = f.calls.filter((c) => ['suite', 'paths', 'commit'].includes(c))
    assert.deepEqual(order, ['suite', 'paths', 'commit'])
  }
})

// MUTATION: reuse the first measurement, the caller's list or an unparsed line and a reviewer sees a stale, partial or lost path set.
test('every reviewer turn receives the paths git reports at that round, both rename ends and odd names included', async () => {
  const cases = [
    [' M src/a.mjs\0?? new file.txt\0R  renamed.mjs\0old.mjs\0 D deleted.mjs\0', ['src/a.mjs', 'new file.txt', 'renamed.mjs', 'old.mjs', 'deleted.mjs']],
    ['C  copy.mjs\0src.mjs\0', ['copy.mjs', 'src.mjs']],
    ['MM both.mjs\0A  both.mjs\0', ['both.mjs']],
    ['?? line\nbreak.txt\0?? "quoted".txt\0', ['line\nbreak.txt', '"quoted".txt']],
    ['', []],
  ]
  for (const [reviewPaths, expected] of cases) {
    const f = fakes({ reviewPaths })
    assert.equal((await f.go()).status, 'done', reviewPaths)
    assert.deepEqual(f.requests.filter((r) => r.role === 'reviewer').map((r) => r.changedPaths), [expected], reviewPaths)
  }
  const rounds = fakes({ review: 1, spec: { files: ['caller-lie.mjs'] }, reviewPaths: [' M first.mjs\0', ' M second.mjs\0?? third.txt\0'], paths: 'M  commit-only.mjs\0' })
  assert.equal((await rounds.go()).status, 'done')
  assert.deepEqual(rounds.requests.filter((r) => r.role === 'reviewer').map((r) => r.changedPaths), [['first.mjs'], ['second.mjs', 'third.txt']])
  assert.deepEqual(rounds.seen.commit.files, ['commit-only.mjs'])
  assert.deepEqual(rounds.calls.filter((c) => c.endsWith('paths')), ['review-paths', 'review-paths', 'paths'])
  assert.equal(rounds.requests.filter((r) => r.role !== 'reviewer').some((r) => 'changedPaths' in r), false)
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

// MUTATION: dispatch the reviewer anyway when the status read is unusable and the review runs on an unmeasured path set.
test('a reviewer path read that is denied, interrupted, non-green or malformed stops before the reviewer, suite and commit', async () => {
  const bad = (fields) => ({ reviewResult: { ...green(), stdout: ' M a.mjs\0', ...fields } })
  const cases = {
    'EPERM': { throwCheck: 'review-paths' },
    'ENOENT': bad({ status: 'unmeasured', reason: 'spawn-failed', code: null, stdout: '' }),
    'EINTR': bad({ status: 'unmeasured', reason: 'interrupted', code: null, signal: 'SIGINT' }),
    'red': bad({ status: 'red', reason: 'exit-nonzero', code: 128 }),
    'signal': bad({ signal: 'SIGKILL' }),
    'timeout': bad({ timedOut: true }),
    'nonzero green': bad({ code: 1 }),
    'no stdout': bad({ stdout: undefined }),
    'truncated': bad({ stdout: ' M a.mjs' }),
    'dangling rename': bad({ stdout: 'R  new.mjs\0' }),
    'unsafe': bad({ stdout: '?? ../escape\0' }),
    'git dir': bad({ stdout: ' M .git/config\0' }),
  }
  for (const [name, options] of Object.entries(cases)) {
    const f = fakes(options)
    assert.deepEqual(await f.go(), stopped('paths-unmeasured'), name)
    assert.equal(count(f, 'reviewer'), 0, name)
    for (const effect of ['suite', 'paths', 'commit', 'publish']) assert.equal(f.calls.includes(effect), false, `${name} ${effect}`)
    assert.equal(f.rows.find((r) => r.event === 'verdict' && r.status === 'stopped').reason, 'paths-unmeasured', name)
  }
  const second = fakes({ review: 1, reviewPaths: [' M a.mjs\0', ' M a.mjs'] })
  assert.deepEqual(await second.go(), stopped('paths-unmeasured'))
  assert.equal(count(second, 'reviewer'), 1)
  assert.equal(second.calls.filter((c) => c === 'suite').length, 1)
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
    assert.equal(f.calls.filter((c) => c === 'fetch').length, 1, name)
    assert.equal(f.rows.find((r) => r.event === 'verdict' && r.status === 'stopped').reason, 'paths-unmeasured', name)
  }
})

// MUTATION: import an old runtime module, or wire the loop into one, and the isolated lane is no longer isolated.
test('the loop imports only builtins, the three contract modules and the skill proof, and only the lean bridge imports it', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url))
  const source = readFileSync(join(dir, 'loop.mjs'), 'utf8')
  const specifiers = [...source.matchAll(/^(?:import|} from|export [^\n]* from)[^'\n]*'([^']+)'/gm)].map((m) => m[1]).sort()
  assert.deepEqual(specifiers, ['./agents.mjs', './checks.mjs', './proof.mjs', './protocols.mjs', './skills-proof.mjs', 'node:async_hooks', 'node:fs/promises', 'node:path', 'node:util'])
  const importers = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.mjs') && !e.name.endsWith('.test.mjs') && e.name !== 'loop.mjs')
    .map((e) => join(e.parentPath, e.name))
    .filter((path) => /['"][^'"]*\/loop\.mjs['"]/.test(readFileSync(path, 'utf8')))
  assert.deepEqual(importers, [join(dir, 'lean.mjs')])
})

// MUTATION: bind subject, title or body from the caller spec and hostile caller prose reaches the commit and the PR.
test('the commit and PR carry the planner subject and the generated body, never caller prose', async () => {
  const f = fakes({ spec: { subject: 'feat: caller lie', title: 'feat: caller title', body: 'Imaginary checks: all pass' } })
  assert.deepEqual(await f.go(), { status: 'done', reason: null, pr: PR })
  assert.equal(f.seen.commit.subject, 'fix(crew): planned lane')
  assert.equal(f.seen.publish.title, 'fix(crew): planned lane')
  assert.equal(f.seen.commit.body, BODY)
  assert.equal(f.seen.publish.body, BODY + LANE)
})

// MUTATION: interpolate the source raw and an embedded newline forges a measurement row.
test('the PR body carries no ## Acceptance block, even for an archived spec with acceptance ids (PD6)', async () => {
  const forged = 'x\n- Suite: green; exit 0.'
  const f = fakes({
    spec: { source: forged, acceptance: ['A1', 'A2'], brief: '## Acceptance\n- (A1) old\n- (A2) old' }, review: 1,
  })
  assert.deepEqual(await f.go(), { status: 'done', reason: null, pr: PR })
  const round = ['- proof: lib.test.mjs "works": red on the old source, green on the build']
  assert.equal(f.seen.publish.body, [`Source: ${JSON.stringify(forged)}`, '', '## Measurements', ...round, '- Suite: green; exit 0.'].join('\n') + LANE.replace('builder 1, reviewer 1', 'builder 2, reviewer 2'))
  assert.ok(!f.seen.publish.body.includes('## Acceptance'))
  assert.equal(f.seen.publish.body.startsWith(f.seen.commit.body + '\n\n## Lane'), true)
  assert.equal(f.seen.publish.body.split('\n').filter((line) => line.startsWith('- Suite:')).length, 1)
})

// MUTATION: omit the pre-suite staging, or stage more than the measured paths, and the suite misses a new file or the commit grows.
test('the suite runs after exactly the measured changed paths are staged, again after a repair, and an unusable staging stops before the suite (SB1)', async () => {
  const f = fakes({ reviewPaths: ' M lib.mjs\0?? new.test.mjs\0R  b.mjs\0a.mjs\0' })
  assert.equal((await f.go()).status, 'done')
  assert.deepEqual(f.seen['suite-stage'], { cwd: '/virtual/checkout', command: 'git', args: ['--literal-pathspecs', 'add', '--', 'lib.mjs', 'new.test.mjs'], timeoutMs: 5000 })
  assert.deepEqual(f.calls.slice(f.calls.indexOf('suite-stage')), ['suite-stage', 'checked-tree', 'suite', 'seat:reviewer', 'paths', 'checked-tree', 'commit', 'fetch', 'rebase', 'publish'])
  const r = sequenced([redRun(1), green()])
  assert.equal((await r.go()).status, 'done')
  assert.equal(r.calls.filter((c) => c === 'suite-stage').length, 2)
  const at = r.calls.lastIndexOf('seat:builder')
  assert.deepEqual(r.calls.slice(at), ['seat:builder', 'proof', 'review-paths', 'suite-stage', 'checked-tree', 'suite', 'seat:reviewer', 'paths', 'checked-tree', ...EFFECTS.slice(1)])
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

// MUTATION: publish after a refused suite or proof and a lane that never measured green carries a green body.
test('an unmeasured suite or incomplete proof stops before any commit or publication', async () => {
  const suites = [{ ...green(), status: 'red', code: 1, reason: 'exit-nonzero' }, { ...green(), status: 'unmeasured', code: null, reason: 'timeout', timedOut: true }, { status: 'green', reason: 'timeout' }, { ...green(), code: 3 }]
  for (const suite of suites) {
    const f = fakes({ suite })
    assert.equal((await f.go()).status, 'stopped', JSON.stringify(suite))
    assert.deepEqual([f.seen.commit, f.seen.publish], [undefined, undefined], JSON.stringify(suite))
  }
  const f = fakes({ proof: { status: 'green', reason: null, rows: [] } })
  assert.equal((await f.go()).status, 'stopped')
  assert.deepEqual([f.calls.includes('suite'), f.seen.commit, f.seen.publish], [false, undefined, undefined])
})

const callRow = (id, title, kind, rawInput) => ({ sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: id, title, kind, status: 'in_progress', rawInput } })
// The proof binds a load to the granted path, <checkout>/skills/<name>/SKILL.md (crew/acp/seat.mjs SKILLS_ROOT).
const GRANTED_ALPHA = fileURLToPath(new URL('../skills/alpha/SKILL.md', import.meta.url))
const LOAD = callRow('r1', 'read', 'read', { path: GRANTED_ALPHA })
const DONE = { sessionId: 's', update: { sessionUpdate: 'tool_call_update', toolCallId: 'r1', status: 'completed' } }
const WRITE = callRow('w1', 'write', 'edit', { path: '/c/a.mjs' })
const required = (rows) => ({ recording: () => ({ definition: { agent: 'pi', requires: ['alpha'], skills: ['alpha'], writes: 'repo' }, rows }) })

// MUTATION: skip the proof in seatTurn and a seat that never loaded its required skill advances.
test('a seat whose recording shows every required skill before its first write is accepted', async () => {
  const f = fakes(required([LOAD, DONE, WRITE]))
  assert.equal((await f.go()).status, 'done')
})

// MUTATION: accept a late load and a write before the skill passes.
test('a required skill loaded after the first write, or never, refuses the envelope and nothing advances', async () => {
  for (const rows of [[WRITE, LOAD, DONE], [LOAD, WRITE], [WRITE], [], [{ sessionId: 's', update: { sessionUpdate: 'agent_message_chunk' } }]]) {
    const f = fakes(required(rows))
    assert.deepEqual(await f.go(), stopped('envelope-refused'))
    assert.deepEqual(f.rows.find((r) => r.event === 'envelope').defects, ['required-skills-unproven'])
    assert.deepEqual(f.calls.filter((c) => c !== 'mkdir'), ['seat:planner'])
  }
})

// MUTATION: treat a missing recording as proof.
test('a missing recording refuses when a skill is required and is ignored when none is', async () => {
  const f = fakes({ recording: () => ({ definition: { agent: 'pi', requires: ['alpha'], skills: ['alpha'], writes: 'repo' } }) })
  assert.deepEqual(await f.go(), stopped('envelope-refused'))
  assert.deepEqual(f.rows.find((r) => r.event === 'envelope').defects, ['required-skills-unproven'])
  const none = fakes({ recording: () => ({ definition: { requires: [], writes: 'repo' } }) })
  assert.equal((await none.go()).status, 'done')
})

// MUTATION: let a refused lead envelope through the proof.
test('a lead whose recording does not show its required skill is refused', async () => {
  const f = fakes({ spec: {}, lead: 'bounce', edit: (value) => (value.role === 'planner' ? { ...value, status: 'insufficient' } : value), recording: (r) => (r.role === 'lead' ? { definition: { requires: ['alpha'], writes: 'task-dir' }, rows: [] } : null) })
  assert.deepEqual(await f.go(), stopped('lead-refused'))
})

test('the lane writes one run-start with its identity before the first seat, and repairs, bounces and retries never write another', async () => {
  const f = fakes({ review: 1, deps: { now: Date.now }, edit: (value, request) => (request.role === 'builder' && !request.repair && !f.repaired ? ((f.repaired = true), { ...value, status: 'bogus' }) : value) })
  const before = Date.now()
  const result = await f.go()
  assert.equal(result.status, 'done')
  const starts = f.rows.filter((row) => row.event === 'run-start')
  assert.equal(starts.length, 1)
  assert.equal(f.rows.indexOf(starts[0]), 0, 'the anchor precedes every other row, so before the first seat')
  assert.equal(starts[0].lane, 'lane')
  assert.equal(starts[0].run_id, 'lane')
  assert.ok(starts[0].at >= before && starts[0].at <= Date.now(), 'a wall-clock lane start')
  assert.ok(count(f, 'builder') >= 2, 'the build was repeated or repaired')
})

test('a task dir that cannot be made writes no run-start', async () => {
  const f = fakes({ deps: { mkdir: async () => { throw new Error('denied') } } })
  assert.equal((await f.go()).reason, 'runner-threw')
  assert.equal(f.rows.some((row) => row.event === 'run-start'), false)
})

// MUTATION: treat a red proof as proven.
test('unproven and missing named tests return to the builder, while unmeasured stops', async () => {
  for (const kind of ['red', 'none', 'unmeasured']) {
    let calls = 0
    const f = fakes({ edit: (v) => {
      if (v.role === 'builder' && kind === 'none' && ++calls === 1) v.details.tests = []
      return v
    }, proof: (() => { let n = 0; return () => kind === 'unmeasured' ? { status: 'unmeasured', reason: 'timeout', rows: [] } : kind === 'red' && n++ === 0 ? { status: 'red', reason: 'proof-unproven', rows: [{ file: 'lib.test.mjs', title: 'works', proven: false, base: { state: 'green', reason: null }, build: { state: 'green', reason: null }, reason: 'proof-not-red-on-base' }] } : { status: 'green', reason: null, rows: [{ file: 'lib.test.mjs', title: 'works', proven: true }] } })() })
    const result = await f.go()
    if (kind === 'unmeasured') { assert.deepEqual(result, stopped('timeout')); continue }
    assert.equal(result.status, 'done')
    const turns = f.requests.filter((r) => r.role === 'builder')
    assert.equal(turns.length, 2)
    assert.equal(turns[1].feedback[0].id, kind === 'none' ? 'proof-no-tests' : 'proof-unproven')
    if (kind === 'red') assert.deepEqual([turns[1].feedback[0].tests[0].file, turns[1].feedback[0].tests[0].title], ['lib.test.mjs', 'works'])
  }
})

// MUTATION: keep the previous builder's tests when a later return names none.
test('a builder that names no tests after a review bounce is not proven by the earlier names', async () => {
  let builds = 0, reviews = 0
  const f = fakes({ bounds: { builder: 3, reviewer: 3 }, edit: (v) => {
    if (v.role === 'builder' && ++builds === 2) v.details.tests = []
    if (v.role === 'reviewer' && ++reviews === 1) return { ...v, details: { ...v.details, verdict: 'changes-needed', findings: [finding] } }
    return v
  } })
  assert.equal((await f.go()).status, 'done')
  const turns = f.requests.filter((r) => r.role === 'builder')
  assert.equal(turns.length, 3)
  assert.equal(turns[2].feedback[0].id, 'proof-no-tests')
})

// ---- finish shape (lean plan 3.5): a stopped lane re-entered by its builder ----
const STOP = { reason: 'mutations-survived', observation: { stage: 'mutations', detail: 'A1 survived' } }
const finishSpec = (over = {}) => ({
  shape: 'finish',
  finish: { planPath: '/virtual/task/plan.md', subject: 'fix(crew): planned lane', mutations: [MUTATION], stop: STOP, findings: [finding], turnOffset: 3, ...over },
})
const FINISH_SUCCESS = ['base-paths', 'fetch', 'base-commit', 'rebase', 'base-restore', 'seat:builder', 'proof', 'review-paths', 'suite-stage', 'checked-tree', 'seat:reviewer', 'suite', 'paths', 'checked-tree', 'commit', 'fetch', 'rebase']

// MUTATION: commit the snapshot with the added-then-deleted entry still staged and the rebase refuses a dirty checkout.
test('a finish run drops added-then-deleted index entries before its base snapshot and commits only the build', async () => {
  for (const [stdout, files] of [[' M lib.mjs\0AD scratch.mjs\0', ['lib.mjs']], ['AD scratch.mjs\0', null]]) {
    const f = fakes({ spec: finishSpec(), baseStatus: { ...green(), stdout } })
    assert.equal((await f.go()).status, 'done')
    assert.deepEqual(f.calls.slice(1, f.calls.indexOf('seat:builder')), ['base-paths', 'fetch', 'base-unstage', ...(files ? ['base-commit'] : []), 'rebase', ...(files ? ['base-restore'] : [])])
    assert.deepEqual(f.seen['base-unstage'].args, ['--literal-pathspecs', 'rm', '--cached', '--quiet', '--ignore-unmatch', '--', 'scratch.mjs'])
    if (files) assert.deepEqual(f.seen['base-commit'].files, files)
  }
})

// MUTATION: skip the base-first block and the builder sees the stale base.
test("a finish run brings the uncommitted build onto the current base before the builder's first turn", async () => {
  for (const dirty of [true, false]) {
    const f = fakes({ spec: finishSpec(), baseStatus: { ...green(), stdout: dirty ? ' M lib.mjs\0' : '' } })
    assert.equal((await f.go()).status, 'done')
    const before = f.calls.slice(1, f.calls.indexOf('seat:builder'))
    assert.deepEqual(before, ['base-paths', 'fetch', ...(dirty ? ['base-commit'] : []), 'rebase', ...(dirty ? ['base-restore'] : [])])
    if (dirty) {
      assert.deepEqual(f.seen['base-commit'].files, ['lib.mjs'])
      assert.deepEqual(f.discardArgs[0], ['reset', '--soft', 'c'.repeat(40)])
    }
    assert.equal(f.rows.filter((row) => row.event === 'commit').length, 1)
    assert.equal(f.seen.proof.base, 'HEAD')
  }
})

// MUTATION: drop base-restore on a failed rebase and the build remains committed.
test('a finish run whose base rebase conflicts stops before any seat turn, names the conflicting paths and leaves the build uncommitted', async () => {
  for (const [rebase, reason, restore] of [
    [{ status: 'red', reason: 'rebase-conflict', conflicts: ['lib.mjs'] }, 'rebase-conflict', true],
    [{ status: 'unmeasured', reason: 'cleanup-unproven' }, 'cleanup-unproven', false],
    // A dropped snapshot leaves the branch on the base: no reset to the snapshot's old parent.
    [{ status: 'green', reason: null, head: 'c'.repeat(40), onto: 'c'.repeat(40) }, 'nothing-to-commit', false],
    [{ status: 'green', reason: null, head: 'a'.repeat(40), onto: 'invalid' }, 'runner-threw', true],
  ]) {
    const f = fakes({ spec: finishSpec(), rebase })
    assert.deepEqual(await f.go(), stopped(reason))
    assert.equal(f.requests.length, 0)
    assert.equal(f.calls.includes('base-restore'), restore)
    if (restore) {
      assert.deepEqual(f.discardArgs, [['reset', '--soft', `${'a'.repeat(40)}^`]])
      if (reason === 'rebase-conflict') assert.deepEqual(f.rows.findLast((row) => row.status === 'stopped').observation.conflicts, ['lib.mjs'])
    }
  }
})

// MUTATION: restore the repaired review stop or the old builder grant.
test('a finish review that asks for changes after the suite repair goes back to the builder, and the repaired tree is proven, reviewed and suite-run before ready', async () => {
  const f = sequenced([redRun(), redRun(), green()], { spec: finishSpec(), edit: (v, req) => req.role === 'reviewer' && count(f, 'builder') === 2 ? { ...v, details: { ...v.details, verdict: 'changes-needed', findings: [finding] } } : v })
  assert.equal((await f.go()).status, 'done')
  assert.deepEqual(builderTurns(f)[2].feedback, [finding])
  assert.equal(count(f, 'lead'), 0)
  assert.deepEqual(f.calls.slice(f.calls.lastIndexOf('seat:builder'), f.calls.lastIndexOf('seat:builder') + 7), ['seat:builder', 'proof', 'review-paths', 'suite-stage', 'checked-tree', 'seat:reviewer', 'suite'])
  const report = JSON.parse(f.writes.get('/virtual/task/finish-report.json'))
  assert.deepEqual(report.reviews.map((r) => r.verdict), ['pass', 'changes-needed', 'pass'])
  assert.match(report.body, /Suite: green/)
})

// MUTATION: reject a null plan path or claim a mechanical finish was not reviewed.
test('a mechanical finish runs on its brief with no plan path, is reviewed, and its report never says not reviewed', async () => {
  const f = fakes({ spec: { ...finishSpec({ planPath: null }), tier: 'mechanical' } })
  assert.equal((await f.go()).status, 'done')
  assert.deepEqual(f.requests.map((r) => [r.role, r.planPath]), [['builder', null], ['reviewer', null]])
  assert.doesNotMatch(JSON.parse(f.writes.get('/virtual/task/finish-report.json')).body, /not reviewed/)
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
  assert.ok(JSON.parse(f.writes.get('/virtual/task/finish-report.json')).body.includes('- proof: unmeasured'))
  const standard = fakes()
  assert.equal((await standard.go()).status, 'done')
  assert.equal(standard.seen.commit.body.split('\n').filter((line) => line.startsWith('- proof:')).length, 1)
  assert.doesNotMatch(standard.seen.commit.body, /kill/i)
})

// MUTATION: run the plan stage on a finish run and the planner request appears.
test('a finish run issues no planner turn, and ends after rebase without a PR (FN1, FN2, FN6)', async () => {
  const f = fakes({ spec: finishSpec(), unseated: ['planner'] })
  assert.deepEqual(await f.go(), { status: 'done', reason: null, pr: null })
  assert.deepEqual(f.calls, ['mkdir', ...FINISH_SUCCESS])
  assert.equal(f.rows.filter((r) => r.event === 'run-start').length, 0)
  assert.equal(f.rows.some((r) => r.event === 'pr'), false)
  const ready = f.rows.at(-1)
  assert.equal(ready.event, 'finish-ready')
  assert.equal(ready.status, 'ready-for-operator')
  assert.equal(ready.head, 'a'.repeat(40))
  assert.equal(f.rows.findIndex((r) => r.event === 'finish-ready') > f.rows.findLastIndex((r) => r.stage === 'rebase'), true)
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

// MUTATION: start the first builder feedback empty and the stop reason and findings never reach it.
test('the finish builder first hears the stop reason with its observation, then the open findings; seat ids start past the stopped lane', async () => {
  const f = fakes({ spec: finishSpec(), unseated: ['planner'] })
  await f.go()
  assert.deepEqual(f.requests[0].feedback, [{ id: 'finish-stop', reason: STOP.reason, observation: STOP.observation }, finding])
  assert.equal(f.requests[0].planPath, '/virtual/task/plan.md')
  assert.equal(f.requests[0].id, 'lane.builder.4')
  assert.equal(f.requests[0].role, 'builder')
})

// MUTATION: leave the reviewer at two rounds and the third finish review bounds out.
test('a finish run gives the reviewer three rounds and refuses an unsound finish spec', async () => {
  const f = fakes({ spec: finishSpec(), unseated: ['planner'], review: 2, bounds: { builder: 3 } })
  assert.equal((await f.go()).status, 'done')
  assert.equal(count(f, 'reviewer'), 3)
  for (const bad of [undefined, finishSpec({ planPath: '' }).finish, finishSpec({ stop: {} }).finish, finishSpec({ turnOffset: -1 }).finish, finishSpec({ findings: null }).finish]) {
    const g = fakes({ spec: { shape: 'finish', finish: bad }, unseated: ['planner'] })
    assert.deepEqual(await g.go(), stopped('invalid-input'))
    assert.deepEqual(g.calls, [])
  }
})

// MUTATION: let the lead bounce a spent finish reviewer and a fourth review runs.
test('a finish review that still asks for changes after three rounds stops the run without consulting the lead', async () => {
  const f = fakes({ spec: finishSpec(), unseated: ['planner'], review: 3, bounds: { builder: 4 } })
  assert.deepEqual(await f.go(), stopped('round-bound'))
  assert.equal(count(f, 'reviewer'), 3)
  assert.equal(f.calls.includes('seat:lead'), false)
  assert.equal(f.calls.includes('commit'), false)
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
  assert.deepEqual([ready.subject, ready.reviewRounds, ready.body.includes('## Measurements')], ['fix(crew): planned lane', 2, true])
  assert.equal(ready.body, report.body)
  // SB4: the body names the stop and each review verdict with its findings; a standard body has no Finish section
  assert.ok(report.body.includes('## Finish\n- Stop: mutations-survived: {"stage":"mutations","detail":"A1 survived"}\n- Review 1: changes-needed; findings: R1 (must-fix) at lib.mjs:1: Fix the defect\n- Review 2: pass; findings: none\n'))
  assert.equal(BODY.includes('## Finish'), false)
  assert.equal(Object.hasOwn(ready, 'mutations'), false)

  const g = fakes({ spec: finishSpec({ guidance: 'Fix it first', priorReviewRounds: 2 }), unseated: ['planner'], review: 2, bounds: { builder: 3 } })
  assert.deepEqual(await g.go(), stopped('round-bound'))
  assert.deepEqual(g.requests[0].feedback.slice(0, 2), [{ id: 'finish-stop', reason: STOP.reason, observation: STOP.observation }, { id: 'finish-return', guidance: 'Fix it first' }])
  assert.equal(count(g, 'reviewer'), 1)
  for (const bad of [{ guidance: 5 }, { priorReviewRounds: -1 }, { priorReviewRounds: 1.5 }]) {
    assert.deepEqual(await fakes({ spec: finishSpec(bad), unseated: ['planner'] }).go(), stopped('invalid-input'))
  }
})

// MUTATION: ignore a failed report write and the lane is announced ready without its report.
test('a finish run that cannot write its report emits no finish-ready, and the standard shape writes none', async () => {
  const f = fakes({ spec: finishSpec(), unseated: ['planner'], writeError: 'EACCES' })
  assert.deepEqual(await f.go(), stopped('runner-threw'))
  assert.equal(f.rows.some((r) => r.event === 'finish-ready'), false)
  const std = fakes()
  await std.go()
  assert.equal(std.writes.size, 0)
})

// MUTATION: refuse a lead decision carried by a non-done status and the held role gets no second turn.
test('a lead envelope with status insufficient and decision bounce gives the held role one more turn (LF4)', async () => {
  const f = fakes({ lead: 'bounce', edit: (v, r) => (v.role === 'planner' && r.id.endsWith('.1') ? { ...v, status: 'insufficient' } : v.role === 'lead' ? { ...v, status: 'insufficient' } : v) })
  assert.deepEqual(await f.go(), { status: 'done', reason: null, pr: PR })
  assert.equal(count(f, 'planner'), 2)
  assert.equal(count(f, 'lead'), 1)
})

const MOVED = { status: 'green', reason: null, head: 'b'.repeat(40), onto: 'c'.repeat(40) }
const O = 'd'.repeat(40)
// A check answering from a sequence (the last answer repeats), for proof and suite seams that must differ across calls.
const answers = (...list) => { let n = 0; return () => structuredClone(list[Math.min(n++, list.length - 1)]) }
const moved = (options = {}) => fakes({ rebase: MOVED, spec: { tier: 'mechanical' }, unseated: ['planner', 'reviewer', 'lead'], edit: (v) => { if (v.role === 'builder') v.details.subject = 'fix: mechanical'; return v }, ...options })

// MUTATION: skip the post-rebase proof and suite and a moved head is published unchecked.
test('a rebase that moves the head reruns proof then the suite on the rebased tree before it publishes (RB1)', async () => {
  const f = moved()
  assert.deepEqual(await f.go(), { status: 'done', reason: null, pr: PR })
  const tail = f.calls.slice(f.calls.lastIndexOf('rebase'))
  assert.deepEqual(tail, ['rebase', 'proof', 'suite', 'post-rebase-clean', 'post-rebase-head', 'publish'])
  assert.equal(f.calls.filter((c) => c === 'proof').length, 2)
  assert.equal(f.calls.filter((c) => c === 'suite').length, 2)
  assert.deepEqual(f.seen.suite, { cwd: '/virtual/checkout', command: 'node', args: ['--test', 'lane.test.mjs'], timeoutMs: 5000 })
  assert.equal(f.seen.proof.base, `${MOVED.head}^`)
})

// MUTATION: keep !isFinish on the moved-head recheck and the finish reports without a fresh review.
test('a finish run whose final rebase moves the head puts the build on the new base and proves, reviews and suite-runs it again before ready', async () => {
  const A = 'a'.repeat(40), C = 'c'.repeat(40)
  for (const priorReviewRounds of [0, 2]) {
    const f = fakes({ spec: finishSpec({ priorReviewRounds }), unseated: ['planner'],
      rebase: answers({ ...MOVED, head: A }, { ...MOVED, onto: O }, { ...MOVED, head: C, onto: O }),
      commit: answers({ status: 'green', reason: null, head: A, files: ['lib.mjs'] }, { status: 'green', reason: null, head: C, files: ['lib.mjs'] }) })
    const bases = [], prove = f.deps.proveTests
    f.deps.proveTests = (input) => { bases.push(input.base); return prove(input) }
    const result = await f.go()
    if (priorReviewRounds) {
      assert.deepEqual(result, stopped('round-bound'))
      assert.equal(f.writes.has('/virtual/task/finish-report.json'), false)
      assert.equal(f.rows.some((row) => row.event === 'finish-ready'), false)
      continue
    }
    assert.deepEqual(result, { status: 'done', reason: null, pr: null })
    assert.deepEqual(f.calls.slice(f.calls.indexOf('uncommit')), ['uncommit', 'proof', 'review-paths', 'suite-stage', 'checked-tree', 'seat:reviewer', 'suite', 'paths', 'checked-tree', 'commit', 'fetch', 'rebase'])
    assert.deepEqual(f.discardArgs, [['reset', '--soft', C], ['reset', '--soft', O]])
    assert.deepEqual(bases, ['HEAD', 'HEAD'])
    const report = JSON.parse(f.writes.get('/virtual/task/finish-report.json'))
    assert.deepEqual([report.head, report.reviewRounds, report.reviews.length], [C, 2, 2])
    assert.deepEqual([f.rows.at(-1).event, f.rows.at(-1).head], ['finish-ready', C])
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

test('an unproven post-rebase proof stops before the suite and publication', async () => {
  const f = moved({ proof: answers({ status: 'green', reason: null, rows: [{ file: 'lib.test.mjs', title: 'works', proven: true }] }, { status: 'red', reason: 'proof-unproven', rows: [{ file: 'lib.test.mjs', title: 'works', proven: false }] }) })
  assert.deepEqual(await f.go(), stopped('proof-unproven'))
  assert.equal(f.seen.proof.base, `${MOVED.head}^`)
  assert.equal(f.calls.filter((c) => c === 'suite').length, 1)
  assert.equal(f.calls.includes('publish'), false)
})

// MUTATION: ignore the post-rebase suite result and a red suite still publishes.
test('a red suite after a rebase that moved the head stops with its reason and publishes nothing (RB2)', async () => {
  const red = { ...green(), status: 'red', code: 1, reason: 'exit-nonzero' }
  const f = moved({ suite: answers(green(), red) })
  assert.deepEqual(await f.go(), stopped('exit-nonzero'))
  assert.equal(f.calls.filter((c) => c === 'suite').length, 2)
  assert.equal(f.calls.includes('publish'), false)
  const g = moved({ spec: finishSpec(), unseated: ['planner'], suite: answers(green(), red) })
  assert.deepEqual(await g.go(), stopped('exit-nonzero'))
  assert.equal(g.writes.size, 0)
  assert.equal(g.rows.some((r) => r.event === 'finish-ready'), false)
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
    assert.deepEqual(await f.go(), stopped(variant === 'proof' ? 'proof-unproven' : 'exit-nonzero'), variant)
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
      spawnDetached: (...args) => { spawned.push(args); return 4242 },
      log: () => {},
    }
    if (['suite', 'proof', 'publish'].includes(variant)) {
      assert.doesNotThrow(() => finishLane({ lane: 'lane', root, deps }), variant)
      assert.deepEqual(calls.filter((args) => args[0] === 'reset'), [['reset', '--soft', MOVED.onto]], variant)
      assert.deepEqual(JSON.parse(readFileSync(journal, 'utf8').trim().split('\n').at(-1)), { event: 'finish-uncommit', lane: 'lane', head: MOVED.head, onto: MOVED.onto, committed: 'a'.repeat(40) }, variant)
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

// MUTATION: keep one lead counter for the lane.
test("the lead's bound is per phase: plan routing before the first review never starves the review's or the recheck's consults (b1509)", async () => {
  const A = 'a'.repeat(40), C = 'c'.repeat(40)
  let builds = 0, leads = 0
  const f = sequenced([green(), green(), redRun(), green()], {
    bounds: { lead: 1 }, review: 1, lead: 'bounce',
    rebase: answers({ ...MOVED, head: A }, { ...MOVED, onto: O }, { ...MOVED, head: C }),
    commit: answers({ status: 'green', reason: null, head: A, files: ['lib.mjs'] }, { status: 'green', reason: null, head: C, files: ['lib.mjs'] }),
    edit: (v) => {
      if (v.role === 'builder' && ++builds === 1) v.status = 'insufficient'
      if (v.role === 'lead') v.details.target = ++leads === 1 ? 'planner' : 'builder'
      return v
    },
  })
  assert.equal((await f.go()).status, 'done')
  assert.deepEqual(f.requests.map((r) => r.role), ['planner', 'builder', 'lead', 'planner', 'builder', 'reviewer', 'lead', 'builder', 'reviewer', 'reviewer', 'lead', 'builder', 'reviewer'])
  assert.deepEqual(f.requests.filter((r) => r.role === 'lead').map((r) => r.feedback[0].last), [true, true, true])
})

// MUTATION: count the rebase-forced re-review against the seat's bound.
test('a re-review forced only by a moved-head rebase spends no reviewer or tech-lead round, and a review after a recheck fix does (b1500)', async () => {
  const A = 'a'.repeat(40), C = 'c'.repeat(40)
  const rebase = () => answers({ ...MOVED, head: A }, { ...MOVED, onto: O }, { ...MOVED, head: C })
  const commit = () => answers({ status: 'green', reason: null, head: A, files: ['lib.mjs'] }, { status: 'green', reason: null, head: C, files: ['lib.mjs'] })
  const judge = fakes({ spec: { tier: 'judge' }, review: 1, bounds: { 'tech-lead': 1 }, rebase: rebase(), commit: commit() })
  assert.equal((await judge.go()).status, 'done')
  assert.deepEqual(judge.requests.map((r) => r.role), ['planner', 'builder', 'reviewer', 'builder', 'reviewer', 'tech-lead', 'reviewer', 'tech-lead'])

  // MUTATION: keep the recheck free after a builder fix, or spend an available round on the rebase-only review.
  for (const bound of [1, 2]) {
    const build = sequenced([green(), redRun(), green()], { bounds: { reviewer: bound }, rebase: rebase(), commit: commit() })
    const result = await build.go()
    if (bound === 1) {
      assert.deepEqual(result, stopped('lead-escalated'))
      const held = build.requests.find((r) => r.role === 'lead').feedback[0]
      assert.deepEqual({ role: held.role, reason: held.reason }, { role: 'reviewer', reason: 'round-bound' })
      assert.equal(count(build, 'reviewer'), 2)
    } else {
      assert.equal(result.status, 'done')
      assert.deepEqual(build.requests.map((r) => r.role), ['planner', 'builder', 'reviewer', 'reviewer', 'builder', 'reviewer'])
    }
  }
})

// MUTATION: keep the old post-rebase proof and suite path, without reviewing the rebased change.
test('a build or judge lane whose publishing rebase moves the head reruns the proof, the suite and every review on the rebased change, through a builder fix when red, before it commits again and publishes', async () => {
  const c = 'c'.repeat(40)
  for (const mode of ['build', 'judge', 'red']) {
    const options = {
      spec: { tier: mode === 'judge' ? 'judge' : 'build' }, bounds: { reviewer: 3 },
      rebase: answers({ ...MOVED, head: 'a'.repeat(40) }, { ...MOVED, onto: O }, { ...MOVED, head: c }),
      commit: answers({ status: 'green', reason: null, head: 'a'.repeat(40), files: ['lib.mjs'] }, { status: 'green', reason: null, head: c, files: ['lib.mjs'] }),
    }
    const f = sequenced(mode === 'red' ? [green(), redRun(), green()] : [green(), green()], options)
    const bases = [], prove = f.deps.proveTests
    f.deps.proveTests = (input) => { bases.push(input.base); return prove(input) }
    const result = await f.go()
    const tail = f.calls.slice(f.calls.indexOf('uncommit'))
    const checks = ['proof', 'review-paths', 'suite-stage', 'checked-tree', 'suite', 'seat:reviewer', ...(mode === 'judge' ? ['seat:tech-lead'] : [])]
    assert.deepEqual(tail, ['uncommit', ...checks, ...(mode === 'red' ? ['seat:builder', ...checks] : []), 'paths', 'checked-tree', 'commit', 'fetch', 'rebase', 'publish'], mode)
    assert.equal(result.status, 'done', mode)
    assert.deepEqual(f.discardArgs, [['reset', '--soft', O]])
    assert.deepEqual(bases, Array(mode === 'red' ? 3 : 2).fill('HEAD'))
    assert.ok(!f.calls.includes('post-rebase-clean') && !f.calls.includes('post-rebase-head'))
    if (mode === 'red') assert.ok(builderTurns(f)[1].feedback.some((item) => item.id === 'suite-repair'))
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

// MUTATION: reset to the moved head's parent without checking whether Git dropped the lane commit.
test('a build or judge lane whose publishing rebase drops its commit as already upstream stops without uncommitting the base or publishing', async () => {
  for (const tier of ['build', 'judge']) for (const dropped of [true, false]) {
    const f = fakes({ spec: { tier }, rebase: answers({ ...MOVED, head: 'a'.repeat(40) }, dropped ? { ...MOVED, head: O, onto: O } : { ...MOVED, onto: undefined }) })
    assert.deepEqual(await f.go(), stopped(dropped ? 'nothing-to-commit' : 'runner-threw'))
    assert.equal(f.calls.includes('uncommit'), false)
    assert.deepEqual(f.discardArgs, [])
    assert.equal(f.calls.includes('publish'), false)
    if (dropped) assert.deepEqual(f.rows.findLast((row) => row.status === 'stopped').observation, { head: O, onto: O, committed: 'a'.repeat(40) })
  }
})

// MUTATION: rerun after every rebase and an unchanged head pays an extra proof and suite run.
test('a rebase that leaves the head unchanged runs proof and the suite once (RB3)', async () => {
  const f = fakes()
  assert.deepEqual(await f.go(), { status: 'done', reason: null, pr: PR })
  assert.equal(f.calls.filter((c) => c === 'suite').length, 1)
  assert.equal(f.calls.filter((c) => c === 'proof').length, 1)
})

// MUTATION: drop `at` from emit and journal rows carry no time, so the lean source cannot draw a waterfall.
test('every journaled row carries one read of the injected clock, and a throwing clock never reaches the loop', async () => {
  let ticks = 0
  const f = fakes({ deps: { now: () => 1_700_000_000_000 + ticks++ } })
  await f.go()
  assert.ok(f.rows.length > 8)
  assert.deepEqual(f.rows.map((r) => r.at), f.rows.map((_, i) => 1_700_000_000_000 + i))
  assert.equal(f.rows.filter((r) => r.event === 'run-start').length, 1)
  const plain = fakes()
  await plain.go()
  assert.ok(plain.rows.every((r) => Number.isFinite(r.at)))
  const broken = fakes({ deps: { now: () => { throw new Error('clock') } } })
  await assert.doesNotReject(broken.go())
})

// MUTATION: run suite and review sequentially, or rebase before planning.
test('a build lane rebases after the plan, then runs the suite and the review side by side on one tree', async () => {
  const f = fakes()
  let running = false, overlap = false, release
  const wait = new Promise((resolve) => { release = resolve })
  const seat = f.deps.runSeat
  f.deps.runSeat = async (request, context) => { if (request.role === 'reviewer') { overlap = running; release() } return seat(request, context) }
  f.deps.runSuite = async () => { running = true; await Promise.race([wait, new Promise((resolve) => setTimeout(resolve, 30))]); running = false; return green() }
  assert.equal((await f.go()).status, 'done')
  assert.equal(overlap, true)
  assert.ok(f.calls.indexOf('seat:planner') < f.calls.indexOf('rebase') && f.calls.indexOf('rebase') < f.calls.indexOf('seat:builder'))
  const rows = f.rows.filter((r) => ['suite', 'review'].includes(r.stage))
  assert.deepEqual(rows.filter((r) => r.event === 'stage-start' || r.event === 'stage-end').map((r) => r.event), ['stage-start', 'stage-start', 'stage-end', 'stage-end'])
  assert.ok(rows.filter((r) => r.event === 'check').every((r) => r.stage === 'suite'))
  assert.ok(rows.filter((r) => r.event === 'envelope').every((r) => r.stage === 'review'))
})

// MUTATION: return on the first sibling to end and the lane stops while the other stage is still running.
test('a build lane waits for both parallel stages before it stops on an unmeasured suite or a halted reviewer', async () => {
  const later = () => new Promise((resolve) => setTimeout(resolve, 30))
  const unmeasured = fakes()
  let reviewEnded = false
  const seat = unmeasured.deps.runSeat
  unmeasured.deps.runSeat = async (request, context) => { if (request.role !== 'reviewer') return seat(request, context); await later(); const out = await seat(request, context); reviewEnded = true; return out }
  unmeasured.deps.runSuite = async () => timeoutRun()
  assert.deepEqual(await unmeasured.go(), stopped('timeout'))
  assert.equal(reviewEnded, true)
  assert.equal(count(unmeasured, 'builder'), 1)
  const halted = fakes({ seatThrows: 'reviewer' })
  let suiteEnded = false
  halted.deps.runSuite = async () => { await later(); suiteEnded = true; return green() }
  assert.equal((await halted.go()).status, 'stopped')
  assert.equal(suiteEnded, true)
  assert.equal(halted.calls.includes('commit'), false)
})

// MUTATION: discard either red result or skip a check after the fix.
test('a build lane hands the builder the red suite and the review findings in one fix turn, then proves, runs the suite and reviews again', async () => {
  const f = sequenced([redOut(SPEC_OUT), green()], { review: 1 })
  assert.equal((await f.go()).status, 'done')
  const feedback = builderTurns(f)[1].feedback
  assert.deepEqual(feedback[0], finding)
  assert.deepEqual(feedback[1], { id: 'suite-repair', severity: 'must-fix', summary: 'The full suite is red after your change. Fix the failing tests.', checkout: f.spec.cwd, failingTests: ['anchor spans remain current'], failingFiles: ['skills/qa-test-writing/exhibits.test.mjs:42:1'], outputTail: [SPEC_OUT] })
  assert.deepEqual(f.calls.slice(f.calls.lastIndexOf('seat:builder'), f.calls.indexOf('paths')), ['seat:builder', 'proof', 'review-paths', 'suite-stage', 'checked-tree', 'suite', 'seat:reviewer'])
})

// MUTATION: run a judge review before its predecessor passes.
test('a judge lane runs the suite, then the review, then the second review, each only on a green predecessor', async () => {
  for (const mode of ['suite', 'review']) {
    const f = sequenced(mode === 'suite' ? [redRun(), green()] : [green(), green()], { spec: { tier: 'judge' }, review: mode === 'review' ? 1 : 0 })
    assert.equal((await f.go()).status, 'done')
    if (mode === 'suite') assert.ok(f.calls.indexOf('seat:reviewer') > f.calls.lastIndexOf('suite'))
    else assert.ok(f.calls.indexOf('seat:tech-lead') > f.calls.lastIndexOf('seat:reviewer'))
    assert.ok(f.calls.indexOf('suite') < f.calls.indexOf('seat:reviewer'))
  }
})

// MUTATION: rerun red without a builder, or grant an extra builder round.
test('a red suite on a build or judge lane is never re-run on the unchanged tree and its fix turn counts against the builder bound', async () => {
  for (const tier of ['build', 'judge']) {
    const f = sequenced([redRun(), green()], { spec: { tier } })
    assert.equal((await f.go()).status, 'done')
    assert.equal(f.inputs.length, 2)
    assert.ok(f.calls.indexOf('suite') < f.calls.lastIndexOf('seat:builder') && f.calls.lastIndexOf('seat:builder') < f.calls.lastIndexOf('suite'))
    const bounded = sequenced([redRun(), green()], { spec: { tier }, bounds: { builder: 1 } })
    assert.equal((await bounded.go()).reason, 'lead-escalated')
    assert.equal(count(bounded, 'lead'), 1)
    assert.equal(bounded.inputs.length, 1)
  }
})

// MUTATION: omit passing should-fix findings or include consider findings.
test("a passing review's should-fix findings are listed in the PR body", async () => {
  const f = fakes({ spec: { tier: 'judge' }, edit: (v) => { if (['reviewer', 'tech-lead'].includes(v.role)) v.details.findings = [{ ...finding, id: v.role === 'reviewer' ? 'S1' : 'S2', severity: 'should-fix' }, { ...finding, id: 'C1', severity: 'consider' }]; return v } })
  assert.equal((await f.go()).status, 'done')
  assert.match(f.seen.publish.body, /## Should-fix\n- S1 \(reviewer\) at lib.mjs:1: Fix the defect\n- S2 \(tech-lead\) at lib.mjs:1: Fix the defect/)
  assert.ok(!f.seen.publish.body.includes('C1'))
})

// MUTATION: drop the label and a pre-publication snapshot reads as a total.
test('the PR body reports wall time, rounds per role, suite repairs and lead consults, and an unreadable clock as unmeasured', async () => {
  for (const broken of [false, true]) {
    let ticks = 0
    const f = sequenced([redRun(), green()], { bounds: { builder: 1 }, lead: 'bounce', deps: { now: () => { if (broken) throw new Error('clock'); return ticks++ * 1000 } } })
    assert.equal((await f.go()).status, 'done')
    const wall = broken ? 'unmeasured' : `${(f.rows.find((r) => r.event === 'stage-start' && r.stage === 'publish').at - f.rows[0].at) / 1000} s before publication; publication unmeasured`
    assert.ok(f.seen.publish.body.includes(`- Wall time: ${wall}.`))
    assert.ok(f.seen.publish.body.includes(`- Rounds: planner ${count(f, 'planner')}, builder ${count(f, 'builder')}, reviewer ${count(f, 'reviewer')}, tech-lead ${count(f, 'tech-lead')}.`))
    assert.ok(f.seen.publish.body.includes('- Suite repairs: 1.\n- Lead consults: 1.'))
    assert.ok(!f.seen.commit.body.includes('## Lane'))
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

// MUTATION: force the validity predicate false and an accepted return is refused.
test('a planner return naming existing task-dir files is accepted, a relative path is read against the task dir, and a repair costs no round (PP3)', async () => {
  const f = fakes({ edit: pathed({ plan_path: 'plan.md' }), deps: { stat: regular } })
  assert.equal((await f.go()).status, 'done')
  assert.equal(count(f, 'planner'), 1)
  assert.equal(f.requests[1].planPath, '/virtual/task/plan.md')
  const repaired = fakes({ edit: (v, r) => pathed({ plan_path: r.repair ? '/virtual/task/plan.md' : '/virtual/task/plan.md:1-42' })(v), deps: { stat: regular } })
  assert.equal((await repaired.go()).status, 'done')
  assert.equal(count(repaired, 'planner'), 2)
  assert.equal(repaired.requests[1].id, repaired.requests[0].id)
  assert.equal(repaired.requests[1].returnPath, repaired.requests[0].returnPath)
})
