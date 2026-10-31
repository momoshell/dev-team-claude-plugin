import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync as appendFileSyncReal, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { laneName, main, runBrief, startLane, StartRefusal } from './start.mjs'
import { main as leanMain, runLean } from './lean.mjs'
import { runAcpSeat } from './acp/seat.mjs'
import { parseAgent, validateEnvelope } from './protocols.mjs'
import { resolveAgents } from './agents.mjs'
import { PROVIDER_RESET_SETTLE_MS, PROVIDER_RETRY_MAX, PROVIDER_RETRY_TOTAL_WAIT_MS } from './acp/provider.mjs'
import { scratchDir } from '../test/helpers.mjs'

const AGENTS = fileURLToPath(new URL('./agents/', import.meta.url))

const BRIEF = `---
source: issue 1961
closes: 1961
tier: build
shape: standard
acceptance: [RV1]
out_of_scope: the visualizer
---
## The ask

Refuse roster edits that cannot boot.

## Acceptance

- (RV1) an edit that cannot boot is refused
`

// Every effect is a recorded call; nothing touches git, the disk or a process. The agent
// resolution is injected too; the default resolves the committed definitions.
function fakes({ brief = BRIEF, exists = () => false, worktreeStatus = 0, originHead = 'origin/main', inGit = true, resolve = (tier) => resolveAgents(tier), write = () => {} } = {}) {
  const calls = []
  const deps = {
    readFileSync: () => brief,
    resolveAgents: resolve,
    existsSync: (path) => exists(path),
    mkdirSync: (path) => { calls.push(['mkdir', path]); write('mkdir', path) },
    writeFileSync: (path, text) => { calls.push(['write', path, text]); write('write', path, text) },
    spawnSync: (file, args, options) => {
      calls.push(['spawn', file, args, options?.cwd ?? null])
      if (file === 'git' && args.includes('symbolic-ref')) return originHead ? { status: 0, stdout: `${originHead}\n` } : { status: 1, stdout: '' }
      if (file === 'git' && args.includes('worktree')) return { status: worktreeStatus, stdout: '' }
      if (file === 'git' && args.includes('rev-parse')) return inGit ? { status: 0, stdout: '/repo/checkout\n' } : { status: 128, stdout: '' }
      return { status: 0, stdout: '', stderr: '' }
    },
    spawnDetached: (file, args, options) => { calls.push(['detached', file, args, options]); return 4242 },
    crewRoot: '/home/.crew',
    log: (line) => calls.push(['log', line]),
  }
  return { deps, calls }
}

const effects = (calls) => calls.filter(([kind]) => ['spawn', 'detached', 'mkdir', 'write'].includes(kind))
const written = (calls, suffix) => calls.find(([kind, path]) => kind === 'write' && path.endsWith(suffix))
const spawned = (calls, verb) => calls.find(([kind, , args]) => (kind === 'spawn' || kind === 'detached') && args.includes(verb))

const pipeFixture = `
import { writeSync } from 'node:fs'
const invalid = process.argv[1] === 'invalid'
process.argv[1] = process.execPath
const { main } = await import(${JSON.stringify(new URL('./start.mjs', import.meta.url).href)})
const deps = {
  readFileSync: () => invalid ? ${JSON.stringify(BRIEF)}.replace('tier: build', 'tier: rigorous') : ${JSON.stringify(BRIEF)},
  resolveAgents: () => ({ seats: {} }), existsSync: () => false,
  mkdirSync: () => {}, writeFileSync: () => {},
  spawnSync: () => ({ status: 0, stdout: 'origin/main' }),
  spawnDetached: () => { writeSync(3, 'started\\n'); return 4242 }, crewRoot: '/virtual/crew',
}
const argv = invalid ? ['/d/b1.md', '--check', '--loop', 'lean'] :
  ['/d/b1.md', '--checkout', '/virtual/' + 'x'.repeat(1024 * 1024) + '/checkout', '--loop', 'lean']
process.exitCode = await main(argv, deps)
`

function runPipeChild(mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', pipeFixture, mode], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', started = '', closed = false, timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 10000)
    child.on('error', reject)
    child.stderr.on('data', (data) => { stderr += data })
    child.stdio[3].on('data', (data) => { started += data })
    child.stdout.on('data', (data) => {
      stdout += data
      if (stdout.includes('\n') && !closed) { closed = true; child.stdout.destroy() }
    })
    if (mode === 'invalid') child.stdout.destroy()
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, started, closed, timedOut }) })
  })
}

// MUTATION: change the successful main return to 1 and a started lane reports failure.
test('(SE1) a reader closing stdout after the first line does not crash a started lane', async () => {
  const result = await runPipeChild('pipe')
  assert.equal(result.timedOut, false)
  assert.equal(result.signal, null)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.started, 'started\n')
  assert.equal(result.closed, true)
  assert.match(result.stdout, /^crew start: lane=b1 .*pid=4242\n/)
  assert.equal(result.stderr, '')
})

// MUTATION: change the refusal return to 0 and an invalid brief reports success.
test('(SE2) invalid --check still refuses with stdout closed', async () => {
  const result = await runPipeChild('invalid')
  assert.equal(result.timedOut, false)
  assert.equal(result.signal, null)
  assert.ok(Number.isInteger(result.code) && result.code !== 0)
  assert.match(result.stderr, /brief .* is not a P1 brief:/)
  assert.match(result.stderr, /tier is one of/)
  assert.doesNotMatch(result.stderr, /\n\s+at |Unhandled 'error' event/)
  assert.equal(result.started, '')
})

test('throwing injected loggers do not change start metadata or main status', async () => {
  for (const error of [Object.assign(new Error('EIO'), { code: 'EIO' }), new StartRefusal('output')]) {
    const lane = fakes()
    lane.deps.log = () => { throw error }
    const result = await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: lane.deps })
    assert.equal(result.lane, 'b1')
    assert.equal(result.pid, 4242)
    assert.ok(leanLaunch(lane.calls))
    const run = fakes()
    run.deps.log = () => { throw error }
    assert.equal(await main(['/d/b1.md', '--checkout', '/repo/checkout'], run.deps), 0)
    assert.ok(leanLaunch(run.calls))
  }
})

test('the lane name is the brief file name and must be a slug', () => {
  assert.equal(laneName('/drafts/b1360-lean-entry.md'), 'b1360-lean-entry')
  assert.throws(() => laneName('/drafts/My Brief.md'), StartRefusal)
})

// MUTATION: skip the brief check and a malformed brief starts a lane.
test('a brief with defects is refused before any git call', async () => {
  const { deps, calls } = fakes({ brief: BRIEF.replace('tier: build', 'tier: rigorous') })
  await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps }), /tier is one of mechanical, build, judge/)
  assert.deepEqual(calls.filter(([kind]) => kind !== 'log'), [])
})

test('--check validates the brief and the agent definitions and starts nothing', async () => {
  const { deps, calls } = fakes()
  const result = await startLane({ briefPath: '/d/b1.md', checkout: null, check: true, deps })
  assert.equal(result.checked, true)
  assert.deepEqual(effects(calls), [])
  assert.match(calls.at(-1)[1], /brief ok lane=b1 tier=build shape=standard closes=1961/)
})

test('without origin/HEAD the lane branches from main', async () => {
  const { deps, calls } = fakes({ originHead: null })
  await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps })
  assert.deepEqual(spawned(calls, 'worktree')[2], ['-C', '/repo/checkout', 'worktree', 'add', '-b', 'b1', '/repo/dt-b1', 'main'])
})

test('an existing worktree or a failed worktree add stops the start and launches nothing', async () => {
  const exists = fakes({ exists: (path) => path === '/repo/dt-b1' })
  await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: exists.deps }), /worktree \/repo\/dt-b1 already exists/)
  assert.equal(exists.calls.some(([kind]) => kind === 'detached'), false)
  const failed = fakes({ worktreeStatus: 1 })
  await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: failed.deps }), /git worktree add -b b1 \/repo\/dt-b1 main failed/)
  assert.equal(failed.calls.some(([kind]) => kind === 'detached' || kind === 'write'), false)
})

test('main reports usage, refusals and success as exit codes', async () => {
  assert.equal(await main([], fakes().deps), 2)
  assert.equal(await main(['a.md', 'b.md'], fakes().deps), 2)
  assert.equal(await main(['/d/b1.md', '--check', '--loop', 'lean'], fakes().deps), 0)
  assert.equal(await main(['/d/b1.md', '--checkout', '/repo/checkout', '--loop', 'lean'], fakes({ worktreeStatus: 1 }).deps), 1)
})

// MUTATION: resolve the checkout before --check and a brief cannot be validated outside a repo.
test('--check works outside a git checkout; a real start there is refused', async () => {
  assert.equal(await main(['/d/b1.md', '--check', '--loop', 'lean'], fakes({ inGit: false }).deps), 0)
  assert.equal(await main(['/d/b1.md', '--loop', 'lean'], fakes({ inGit: false }).deps), 2)
})

// MUTATION: drop the bound-issue slot and the run brief carries no bound issue.
test('the run brief carries the header and the bound-issue slot when closes is set', () => {
  const run = runBrief(BRIEF, 1961)
  assert.equal(run.split('\n').slice(0, 2).join('\n'), '# Task\n<!-- crew:bound-issue #1961 -->')
  assert.equal(runBrief(BRIEF.replace('closes: 1961', 'closes: null'), null).split('\n')[1], '')
})

// stderr of main, captured; the exit code is returned beside it.
async function mainWithStderr(argv, deps) {
  let stderr = ''
  const write = process.stderr.write
  process.stderr.write = (text) => { stderr += String(text); return true }
  try { return { code: await main(argv, deps), stderr } } finally { process.stderr.write = write }
}

const LEAN = fileURLToPath(new URL('./lean.mjs', import.meta.url))
const leanLaunch = (calls) => calls.find(([kind, , args]) => kind === 'detached' && args[0] === LEAN)

// MUTATION: force the lean decision false and the lane detaches crew run, with no spec or lean members.
test('--loop lean detaches the bridge on a measured spec and boots nothing', async () => {
  const { deps, calls } = fakes()
  const result = await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', loop: 'lean', deps })
  const launch = leanLaunch(calls)
  assert.deepEqual(launch.slice(1, 3), [process.execPath, [LEAN, '/home/.crew/dt-b1/b1/task/lean.json']])
  assert.equal(launch[3].cwd, '/repo/dt-b1')
  assert.equal(launch[3].log, '/home/.crew/briefs/started/b1.run.log')
  assert.equal(spawned(calls, 'boot'), undefined)
  assert.equal(spawned(calls, 'run'), undefined)
  assert.equal(result.pid, 4242)
  const spec = JSON.parse(written(calls, '/task/lean.json')[2])
  assert.deepEqual(spec, {
    id: 'b1', cwd: '/repo/dt-b1', taskDir: '/home/.crew/dt-b1/b1/task', tier: 'build', shape: 'standard', brief: runBrief(BRIEF, 1961),
    acceptance: ['RV1'], source: 'issue 1961', branch: 'b1', base: 'main', closes: [1961], suite: { command: 'npm', args: ['test'], timeoutMs: 1800000 },
  })
  assert.equal(spec.timeoutMs, undefined)
  const { members } = JSON.parse(written(calls, '/dt-b1/b1/crew.json')[2])
  const { seats } = resolveAgents('build')
  assert.deepEqual(Object.keys(members), Object.keys(seats))
  for (const [role, cell] of Object.entries(seats)) assert.deepEqual(members[role], { agent: cell.agent, model: `${cell.provider}/${cell.id}`, transport: 'lean-acp' })
  const unbound = fakes({ brief: BRIEF.replace('closes: 1961', 'closes: null') })
  await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', loop: 'lean', deps: unbound.deps })
  assert.deepEqual(JSON.parse(written(unbound.calls, '/task/lean.json')[2]).closes, [])
})

// MUTATION: ignore fields.suite and a cargo brief runs npm test; always use it and a brief without suite gets no command.
test('a brief suite line is the lean spec suite, split on whitespace; without one the suite is npm test (SB5, SB6)', async () => {
  const cargo = fakes({ brief: BRIEF.replace('acceptance:', 'suite: cargo test -p power-api\nacceptance:') })
  await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', loop: 'lean', deps: cargo.deps })
  assert.deepEqual(JSON.parse(written(cargo.calls, '/task/lean.json')[2]).suite, { command: 'cargo', args: ['test', '-p', 'power-api'], timeoutMs: 1800000 })
  const plain = fakes()
  await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', loop: 'lean', deps: plain.deps })
  assert.deepEqual(JSON.parse(written(plain.calls, '/task/lean.json')[2]).suite, { command: 'npm', args: ['test'], timeoutMs: 1800000 })
})

// MUTATION: ignore --loop in main and an unknown loop starts a lane.
test('main forwards --loop lean and refuses a missing, duplicate or unknown loop as usage', async () => {
  const lean = fakes()
  assert.equal(await main(['/d/b1.md', '--loop', 'lean', '--checkout', '/repo/checkout'], lean.deps), 0)
  assert.ok(leanLaunch(lean.calls))
  for (const argv of [['/d/b1.md', '--loop'], ['/d/b1.md', '--loop', 'stepped'], ['/d/b1.md', '--loop', 'old'], ['/d/b1.md', '--loop', 'lean', '--loop', 'lean'], ['/d/b1.md', '--loop', '--check'], ['--loop', 'old'], ['--loop', 'lean'], ['/d/b1.md', '--lean']]) {
    const refused = fakes()
    assert.equal((await mainWithStderr(argv, refused.deps)).code, 2, argv.join(' '))
    assert.deepEqual(effects(refused.calls), [], argv.join(' '))
  }
  const plain = fakes()
  await main(['/d/b1.md', '--checkout', '/repo/checkout'], plain.deps)
  assert.ok(leanLaunch(plain.calls))
})

// A start with no --loop is the lean loop, whether it comes through startLane or main.
test('(SW1) a start with no --loop, from startLane or main, runs the lean loop', async () => {
  const viaLane = fakes()
  await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: viaLane.deps })
  const viaMain = fakes()
  assert.equal(await main(['/d/b1.md', '--checkout', '/repo/checkout'], viaMain.deps), 0)
  for (const { calls } of [viaLane, viaMain]) {
    assert.ok(leanLaunch(calls))
    assert.ok(written(calls, '/lean.json'))
    assert.equal(spawned(calls, 'boot'), undefined)
    assert.equal(spawned(calls, 'run'), undefined)
  }
})

// MUTATION: accept any loop value and --loop old starts a lane instead of being refused as usage.
test('(SW3) a loop other than lean, old included, is usage: exit 2 from main, exitCode 2 from startLane, no effects', async () => {
  for (const loop of ['bogus', 'old']) {
    const { deps, calls } = fakes()
    const { code, stderr } = await mainWithStderr(['/d/b1.md', '--loop', loop], deps)
    assert.equal(code, 2)
    assert.equal(stderr, 'usage: crew start <brief.md> [--check] [--checkout <dir>] [--loop lean]\n')
    assert.deepEqual(effects(calls), [])
    await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', loop, deps: fakes().deps }), (error) => error instanceof StartRefusal && error.exitCode === 2 && /--loop takes lean, got/.test(error.message))
  }
})

// MUTATION: validate a --check with fewer checks and a stepped brief, which the lean loop cannot run, passes.
test('(SW4) --check refuses a brief the lean loop cannot run', async () => {
  const lean = fakes({ brief: BRIEF.replace('shape: standard', 'shape: stepped') })
  const { code, stderr } = await mainWithStderr(['/d/b1.md', '--check'], lean.deps)
  assert.equal(code, 1)
  assert.match(stderr, /--loop lean runs the standard shape only/)
  assert.deepEqual(effects(lean.calls), [])
  const finish = fakes({ brief: BRIEF.replace('shape: standard', 'shape: finish') })
  await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', check: true, deps: finish.deps }), /shape finish starts from an escalated lane/)
})

// MUTATION: drop the shape refusal and a stepped brief starts a lean lane that runs only the standard loop.
test('--loop lean refuses a non-standard shape before any git call', async () => {
  const { deps, calls } = fakes({ brief: BRIEF.replace('shape: standard', 'shape: stepped') })
  await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', loop: 'lean', deps }), /--loop lean runs the standard shape only/)
  assert.deepEqual(effects(calls), [])
  await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', loop: 'other', deps: fakes().deps }), /--loop takes lean, got/)
})

test('(LS1) crew/start.mjs imports none of the old driver or roster modules', () => {
  const source = readFileSync(fileURLToPath(new URL('./start.mjs', import.meta.url)), 'utf8')
  assert.doesNotMatch(source, /(?:import\s*\(|from\s+)['"]\.\/(drive|roster|roster-validate|roster-generate|crew)\.mjs['"]/)
})

test('(LS2) a lean --check in a child process loads no old driver, roster or crew module', () => {
  const dir = scratchDir('lean-start-trace-')
  const tracer = join(dir, 'trace.mjs')
  const trace = join(dir, 'trace.log')
  const brief = join(dir, 'b1.md')
  writeFileSync(brief, BRIEF)
  writeFileSync(tracer, `import { registerHooks } from 'node:module'\nimport { appendFileSync } from 'node:fs'\nregisterHooks({ load(url, context, next) { appendFileSync(${JSON.stringify(trace)}, url + '\\n'); return next(url, context) } })\n`)
  const start = fileURLToPath(new URL('./start.mjs', import.meta.url))
  const child = spawnSync(process.execPath, ['--import', tracer, start, brief, '--check', '--loop', 'lean'], { encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  const loaded = readFileSync(trace, 'utf8')
  assert.match(loaded, /crew\/start\.mjs/)
  for (const name of ['drive', 'roster', 'roster-validate', 'roster-generate', 'crew']) assert.equal(loaded.includes(`/crew/${name}.mjs`), false, name)
})

test('(LS3, LS5) a lean start keeps the member shape and writes no roster', async () => {
  const run = fakes()
  const result = await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', loop: 'lean', deps: run.deps })
  assert.equal(result.pid, 4242)
  assert.equal(leanLaunch(run.calls).length > 0, true)
  assert.equal(spawned(run.calls, 'boot'), undefined)
  assert.equal(spawned(run.calls, 'run'), undefined)
  assert.equal(written(run.calls, '.roster.json'), undefined)
  const { members } = JSON.parse(written(run.calls, '/dt-b1/b1/crew.json')[2])
  const { seats, advisor } = resolveAgents('build')
  assert.deepEqual(members, Object.fromEntries(Object.entries(seats).map(([role, cell]) => [role, { agent: cell.agent, model: `${cell.provider}/${cell.id}`, transport: 'lean-acp' }])))
  assert.equal(advisor !== null && 'advisor' in members, false)
})

test('a lean start refuses before any effect when the agent definitions do not resolve or the brief is not P1', async () => {
  const bad = fakes({ resolve: () => { throw new Error('agent definitions are refused: empty') } })
  await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', loop: 'lean', deps: bad.deps }), (error) => error instanceof StartRefusal && /agent definitions/.test(error.message))
  assert.deepEqual(bad.calls.filter(([kind]) => kind !== 'log'), [])
  const defect = fakes({ brief: BRIEF.replace('tier: build', 'tier: rigorous') })
  await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', loop: 'lean', deps: defect.deps }), /tier is one of/)
  assert.deepEqual(defect.calls.filter(([kind]) => kind !== 'log'), [])
})

// MUTATION: swallow the metadata failure and the bridge launches without a spec.
test('a denied lean metadata write stops the launch and names the left worktree', async () => {
  for (const [failing, at] of [['mkdir', 2], ['write', 2], ['write', 3]]) {
    // mkdir 1 and write 1 are the brief snapshot (lean writes no roster); the lean directory and its two files follow.
    const seen = { mkdir: 0, write: 0 }
    const { deps, calls } = fakes({ write: (kind) => { if (++seen[kind] === at && kind === failing) throw Object.assign(new Error('EPERM injected'), { code: 'EPERM' }) } })
    await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', loop: 'lean', deps }), (error) => error instanceof StartRefusal && error.message.includes('EPERM') && /worktree \/repo\/dt-b1 and branch b1 are left for inspection/.test(error.message), `${failing} ${at}`)
    assert.equal(calls.some(([kind]) => kind === 'detached'), false, `${failing} ${at}`)
  }
})

// ---- crew/lean.mjs: the detached bridge, over a fake ACP seat and fake loop checks ----

const LEAN_MUTATION = { check: 'RV1', file: 'src/a.mjs', find: 'before', replace: 'after' }
const GREEN = { status: 'green', reason: null, code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
const EINTR = Object.assign(new Error('turn interrupted'), { code: 'EINTR' })
const EPERM = Object.assign(new Error('denied'), { code: 'EPERM' })

// A lane's whole loop with every outside effect faked: seats answer by envelope id, recordings are real files.
function leanFixture({ tier = 'build', answers = {}, acp, deps = {}, loopDeps = {}, status = ' M src/a.mjs\0' } = {}) {
  const dir = scratchDir('lean-')
  const spec = {
    id: 'lane', cwd: join(dir, 'worktree'), taskDir: join(dir, 'task'), tier, shape: 'standard', brief: BRIEF, acceptance: ['RV1'],
    source: 'issue 1961', branch: 'lane', base: 'main', suite: { command: 'npm', args: ['test'] },
  }
  mkdirSync(spec.cwd, { recursive: true })
  const requests = [], logs = [], reviews = answers.reviews ?? ['pass']
  let review = 0, reads = 0, rebasedHead = null
  const envelope = (role, id) => {
    const n = Number(id.split('.').at(-1))
    const own = answers[`${role}.${n}`]
    const details = role === 'planner' ? { subject: 'fix(crew): publish measured lane results', plan_path: join(spec.taskDir, 'plan.md'), gate_path: join(spec.taskDir, 'gate.mjs'), acceptance: ['RV1'], mutations: [LEAN_MUTATION] }
      : role === 'builder' ? { summary: 'built' }
      : role === 'lead' ? { decision: 'bounce' }
      : { verdict: reviews[review] ?? 'pass', findings: reviews[review++] === 'changes-needed' ? [{ id: 'F1', severity: 'must-fix', location: 'a:1', summary: 'redo-this' }] : [] }
    return { role, id, status: own ?? 'done', summary: 'fixture', details }
  }
  const fakeAcp = acp ?? (async (input) => {
    requests.push(input)
    const id = /^Envelope id: (.+)$/m.exec(input.prompt)[1]
    const path = /^Return path: (.+)$/m.exec(input.prompt)[1]
    // The real seat swallows a failed append and never tells its caller.
    try { input.deps.appendFileSync(input.sessionFile, `${JSON.stringify({ sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `chunk-${id}` } } })}\n`, 'utf8') } catch {}
    mkdirSync(spec.taskDir, { recursive: true })
    // the planner's artifacts exist in the task dir, as the loop requires of its two paths
    if (input.definition.role === 'planner') for (const name of ['plan.md', 'gate.mjs']) writeFileSync(join(spec.taskDir, name), '')
    writeFileSync(path, JSON.stringify(envelope(input.definition.role, id)))
    return { stopReason: 'end_turn', usage: null, refusal: null }
  })
  const options = {
    log: (line) => logs.push(line),
    runAcpSeat: (input) => { if (!acp) return fakeAcp(input); requests.push(input); return fakeAcp(input) },
    loopDeps: {
      journal: async () => {},
      checkBaseline: async () => ({ accepted: true, reason: 'gate-failed', result: { ...GREEN, status: 'red', code: 1, reason: 'gate-failed', failingIds: ['RV1'] } }),
      runGate: async () => GREEN,
      proveMutations: async () => ({ status: 'green', reason: null, rows: [{ check: 'RV1', outcome: 'killed', reason: null }] }),
      runSuite: async () => GREEN,
      commitChanges: async () => ({ status: 'green', reason: null, head: 'a'.repeat(40) }),
      rebaseBranch: async () => ({ status: 'green', reason: null, head: 'b'.repeat(40) }),
      openPullRequest: async () => ({ status: 'green', reason: null, pr: { number: 7, url: 'https://example.test/7' } }),
      // After the rebase the tree is the rebased head and clean; before it, status reads the scripted paths.
      run: async (input) => input.args.includes('rev-parse') ? { ...GREEN, stdout: `${rebasedHead}\n` }
        : input.args.includes('status') ? { ...GREEN, stdout: rebasedHead ? '' : [status].flat()[Math.min(reads++, [status].flat().length - 1)] } : GREEN,
      ...loopDeps,
    },
    ...deps,
  }
  const rebase = options.loopDeps.rebaseBranch
  options.loopDeps.rebaseBranch = async (input) => { const result = await rebase(input); if (result.status === 'green') rebasedHead = result.head; return result }
  const sessionOf = (role, n) => join(spec.taskDir, 'lean', role, `lane.${role}.${n}.jsonl`)
  return { spec, requests, logs, go: () => runLean(spec, options), sessionOf, options }
}
const terminal = (logs) => logs.map((line) => JSON.parse(line)).filter((row) => row.event === 'loop-result')

// MUTATION: send a request without the role's definition, effort, prompt or recording and a seat turn loses it.
test('every turn gets its role definition, the complete brief and P2, and its own recording', async () => {
  const f = leanFixture({ answers: { reviews: ['changes-needed', 'pass'] } })
  const result = await f.go()
  assert.equal(result.status, 'done')
  const roles = ['planner', 'builder', 'reviewer', 'builder', 'reviewer']
  assert.deepEqual(f.requests.map((r) => r.definition.role), roles)
  const { seats } = resolveAgents('build')
  f.requests.forEach((request, index) => {
    const role = roles[index]
    const id = `lane.${role}.${index + 1}`
    const returnPath = join(f.spec.taskDir, `${role}-${index + 1}.json`)
    const source = join(AGENTS, `${role}.md`)
    const { body, fields } = parseAgent(readFileSync(source, 'utf8'))
    const cell = seats[role]
    assert.deepEqual(request.definition, { role, agent: cell.agent, model: `${cell.provider}/${cell.id}`, effort: cell.effort, writes: { ...fields, ...fields.tiers?.build }.writes, skills: [], requires: [], tools: { ...fields, ...fields.tiers?.build }.tools, extensions: { ...fields, ...fields.tiers?.build }.extensions, advisor: { ...fields, ...fields.tiers?.build }.advisor, edit_assist: { ...fields, ...fields.tiers?.build }.edit_assist, codemode: { ...fields, ...fields.tiers?.build }.codemode, wait_s: { ...fields, ...fields.tiers?.build }.wait_s, body })
    assert.equal(request.taskDir, f.spec.taskDir)
    assert.equal(request.cwd, f.spec.cwd)
    assert.notEqual(f.spec.taskDir, request.cwd)
    assert.equal(request.sessionFile, f.sessionOf(role, index + 1))
    for (const wanted of [body, BRIEF, `Envelope id: ${id}`, `Return path: ${returnPath}`, `Task directory: ${f.spec.taskDir}`, `Definition source: ${source}`, 'no submit_envelope', `"role": "${role}"`, `"id": "${id}"`]) {
      assert.ok(request.prompt.includes(wanted), `${id}: ${wanted}`)
    }
    assert.doesNotMatch(request.prompt, /^Charter file/m, id)
    assert.doesNotMatch(request.prompt, /\]\([^)]*roles\//, id)
    const lines = readFileSync(request.sessionFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.deepEqual(lines[0], { type: 'prompt', text: request.prompt })
    assert.equal(lines[1].update.content.text, `chunk-${id}`)
    assert.deepEqual(lines[2], { type: 'turn', stopReason: 'end_turn', usage: null, refusal: null })
    assert.equal(lines.length, 3)
  })
  assert.match(f.requests[0].prompt, /"mutations"/)
  assert.match(f.requests[1].prompt, /"summary"/)
  assert.match(f.requests[2].prompt, /"findings"/)
  assert.doesNotMatch(f.requests[1].prompt, /redo-this/)
  assert.match(f.requests[3].prompt, /redo-this/)
  assert.equal(new Set(f.requests.map((r) => r.sessionFile)).size, 5)
  assert.deepEqual(terminal(f.logs), [{ event: 'loop-result', ...result }])
})

// MUTATION: drop the changed-path section from the reviewer prompt and the reviewer is told nothing about untracked or renamed files.
test('each reviewer prompt lists that round\'s measured paths as JSON-quoted bullets and no other seat gets the section', async () => {
  const f = leanFixture({
    answers: { reviews: ['changes-needed', 'pass'] },
    status: [' M src/a.mjs\0?? untracked file.txt\0?? line\nbreak.txt\0?? "quoted".txt\0R  moved.mjs\0old.mjs\0', '', ' M commit-only.mjs\0'],
  })
  assert.equal((await f.go()).status, 'done')
  const section = (prompt) => (prompt.split('\n## Changed paths\n')[1] ?? '').split('\n## ')[0].split('\n').filter((line) => line.startsWith('- '))
  const reviewers = f.requests.filter((r) => r.definition.role === 'reviewer')
  assert.deepEqual(reviewers.map((r) => section(r.prompt)), [
    ['- "src/a.mjs"', '- "untracked file.txt"', '- "line\\nbreak.txt"', '- "\\"quoted\\".txt"', '- "moved.mjs"', '- "old.mjs"'],
    [],
  ])
  assert.match(reviewers[1].prompt, /^## Changed paths\n\n## Feedback$/m)
  for (const request of f.requests.filter((r) => r.definition.role !== 'reviewer')) assert.doesNotMatch(request.prompt, /## Changed paths/)
  const recorded = JSON.parse(readFileSync(reviewers[0].sessionFile, 'utf8').split('\n')[0])
  assert.equal(recorded.text, reviewers[0].prompt)
})

// MUTATION: derive writes from the role instead of the effective definition and a tier override or edited file is ignored.
test('the writes a seat receives are the effective definition writes, tier override included', async () => {
  const planner = join(AGENTS, 'planner.md')
  const edit = (from, to) => (path, ...args) => {
    const text = readFileSync(path, ...args)
    return path === planner ? text.replace(from, to) : text
  }
  const task = leanFixture({ deps: { readFileSync: edit('writes: task-dir', 'writes: repo') } })
  await task.go()
  assert.deepEqual(task.requests.map((r) => r.definition.writes), ['repo', 'repo', 'task-dir'])
  const tiered = leanFixture({ deps: { readFileSync: edit(/tiers: .*/, 'tiers: {"build":{"writes":"none"}}') } })
  await tiered.go()
  assert.equal(tiered.requests[0].definition.writes, 'none')
  assert.equal(tiered.requests[0].definition.role, 'planner')
})

const memoryDefinition = (line) => (path, ...args) => {
  const text = readFileSync(path, ...args)
  // The shipped definition's own memory field is removed first, so each case states the whole effective value.
  return path === join(AGENTS, 'planner.md') ? text.replace(/^memory: .*\n/m, '').replace(/tiers: .*/, line) : text
}
const populateMemory = (dir, body) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'MEMORY.md'), '- [entry](entry.md)\n')
  writeFileSync(join(dir, 'entry.md'), body)
}

test('effective memory injects lane or override context into the recorded planner prompt', async () => {
  const previous = process.env.CREW_MEMORY_DIR
  try {
    for (const line of ['memory: true\ntiers: {}', 'tiers: {"build":{"memory":true}}', 'memory: false\ntiers: {"build":{"memory":true}}']) {
      delete process.env.CREW_MEMORY_DIR
      const f = leanFixture({ deps: { readFileSync: memoryDefinition(line) } })
      populateMemory(join(f.spec.cwd, '.claude/dev-team/memory'), 'lane judgment')
      assert.equal((await f.go()).status, 'done')
      assert.match(f.requests[0].prompt, /## Team memory[\s\S]*lane judgment/)
      assert.equal(JSON.parse(readFileSync(f.sessionOf('planner', 1), 'utf8').split('\n')[0]).text, f.requests[0].prompt)
    }
    const f = leanFixture({ deps: { readFileSync: memoryDefinition('memory: true\ntiers: {}') } })
    populateMemory(join(f.spec.cwd, '.claude/dev-team/memory'), 'lane judgment')
    process.env.CREW_MEMORY_DIR = join(f.spec.taskDir, 'override')
    populateMemory(process.env.CREW_MEMORY_DIR, 'override judgment')
    assert.equal((await f.go()).status, 'done')
    assert.match(f.requests[0].prompt, /override judgment/)
    assert.doesNotMatch(f.requests[0].prompt, /lane judgment/)
  } finally {
    if (previous === undefined) delete process.env.CREW_MEMORY_DIR
    else process.env.CREW_MEMORY_DIR = previous
  }
})

// MUTATION: drop `memory: true` from crew/agents/planner.md and the shipped planner boots without team memory.
test('the shipped planner definition injects the lane checkout memory', async () => {
  const previous = process.env.CREW_MEMORY_DIR
  try {
    delete process.env.CREW_MEMORY_DIR
    const f = leanFixture()
    populateMemory(join(f.spec.cwd, '.claude/dev-team/memory'), 'shipped judgment')
    assert.equal((await f.go()).status, 'done')
    assert.match(f.requests[0].prompt, /## Team memory[\s\S]*shipped judgment/)
  } finally {
    if (previous === undefined) delete process.env.CREW_MEMORY_DIR
    else process.env.CREW_MEMORY_DIR = previous
  }
})

test('missing memory boots and journals the backend reason without fallback', async () => {
  const previous = process.env.CREW_MEMORY_DIR
  try {
    for (const reason of ['no-dir', 'no-index']) {
      const rows = []
      const f = leanFixture({ deps: { readFileSync: memoryDefinition('memory: true\ntiers: {}') }, loopDeps: reason === 'no-dir' ? { journal: async (row) => rows.push(row) } : { journal: undefined } })
      if (reason === 'no-index') delete f.options.loopDeps.journal
      populateMemory(join(f.spec.cwd, '.claude/dev-team/memory'), 'must not fall back')
      process.env.CREW_MEMORY_DIR = join(f.spec.cwd, 'missing-override')
      if (reason === 'no-index') mkdirSync(process.env.CREW_MEMORY_DIR)
      assert.equal((await f.go()).status, 'done')
      assert.doesNotMatch(f.requests[0].prompt, /## Team memory/)
      const journal = reason === 'no-dir' ? rows : readFileSync(join(f.spec.taskDir, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
      const event = journal.find((row) => row.event === 'memory-empty')
      assert.equal(event.reason, reason)
      assert.equal(event.role, 'planner')
      assert.equal(event.id, 'lane.planner.1')
    }
  } finally {
    if (previous === undefined) delete process.env.CREW_MEMORY_DIR
    else process.env.CREW_MEMORY_DIR = previous
  }
})

test('false or absent effective memory neither injects nor journals memory', async () => {
  const previous = process.env.CREW_MEMORY_DIR
  try {
    for (const line of ['tiers: {}', 'memory: false\ntiers: {}', 'memory: true\ntiers: {"build":{"memory":false}}', 'tiers: {"build":{"memory":false}}', 'tiers: {"judge":{"memory":true}}']) {
      const rows = []
      const f = leanFixture({ deps: { readFileSync: memoryDefinition(line) }, loopDeps: { journal: async (row) => rows.push(row) } })
      process.env.CREW_MEMORY_DIR = join(f.spec.cwd, 'override')
      populateMemory(process.env.CREW_MEMORY_DIR, 'secret judgment')
      assert.equal((await f.go()).status, 'done', line)
      assert.doesNotMatch(f.requests[0].prompt, /## Team memory/)
      assert.equal(rows.some((row) => row.event === 'memory-empty'), false)
    }
  } finally {
    if (previous === undefined) delete process.env.CREW_MEMORY_DIR
    else process.env.CREW_MEMORY_DIR = previous
  }
})

// MUTATION: drop effective.tools from the dispatched definition and an authored tool list never reaches the seat.
test('the tools a seat receives are the effective definition tools, tier override and empty list included, absent when unset', async () => {
  const planner = join(AGENTS, 'planner.md')
  const edit = (from, to) => (path, ...args) => {
    const text = readFileSync(path, ...args)
    return path === planner ? text.replace(from, to) : text
  }
  const planned = async (deps) => {
    const f = leanFixture({ acp: () => { throw new Error('capture ends the fake turn') }, deps })
    await f.go()
    return f.requests[0].definition
  }
  assert.equal(Object.hasOwn(await planned({}), 'tools'), true)
  assert.equal((await planned({})).tools, undefined)
  assert.deepEqual((await planned({ readFileSync: edit('writes: task-dir', 'writes: task-dir\ntools: ["Read","Grep"]') })).tools, ['Read', 'Grep'])
  assert.deepEqual((await planned({ readFileSync: edit(/tiers: .*/, 'tools: ["Read"]\ntiers: {"build":{"tools":["Glob"]}}') })).tools, ['Glob'])
  assert.deepEqual((await planned({ readFileSync: edit('writes: task-dir', 'writes: task-dir\ntools: []') })).tools, [])
})

// MUTATION: drop effective.wait_s from the dispatched definition and an authored deadline never reaches the seat.
test('the wait_s a seat receives is the effective definition value, tier override included, absent when unset', async () => {
  const planner = join(AGENTS, 'planner.md')
  const edit = (from, to) => (path, ...args) => {
    const text = readFileSync(path, ...args)
    return path === planner ? text.replace(from, to) : text
  }
  const planned = async (deps) => {
    const f = leanFixture({ acp: () => { throw new Error('capture ends the fake turn') }, deps })
    await f.go()
    return f.requests[0].definition
  }
  assert.equal(Object.hasOwn(await planned({}), 'wait_s'), true)
  assert.equal((await planned({})).wait_s, undefined)
  assert.equal((await planned({ readFileSync: edit('writes: task-dir', 'writes: task-dir\nwait_s: 7') })).wait_s, 7)
  assert.equal((await planned({ readFileSync: edit(/tiers: .*/, 'wait_s: 7\ntiers: {"build":{"wait_s":3}}') })).wait_s, 3)
})

// MUTATION: read the return file after a failed seat and an envelope written during an expired turn's teardown is accepted.
test('an expired real seat turn stops the lane as seat-unmeasured and its late envelope is never read', async () => {
  const planner = join(AGENTS, 'planner.md')
  let clock = 0, returnPath, envelopeId, reads = 0, laterSeats = 0
  const f = leanFixture({
    deps: {
      readFileSync: (path, ...args) => {
        const text = readFileSync(path, ...args)
        return path === planner ? text.replace('writes: task-dir', 'writes: task-dir\nwait_s: 2') : text
      },
      runAcpSeat: (input) => {
        if (returnPath) { laterSeats++; throw new Error('no later seat may run') }
        returnPath = /^Return path: (.+)$/m.exec(input.prompt)[1]
        envelopeId = /^Envelope id: (.+)$/m.exec(input.prompt)[1]
        const late = () => {
          mkdirSync(f.spec.taskDir, { recursive: true })
          writeFileSync(returnPath, JSON.stringify({ role: 'planner', id: envelopeId, status: 'done', summary: 'late',
            details: { plan_path: join(f.spec.taskDir, 'plan.md'), gate_path: join(f.spec.taskDir, 'gate.mjs'), acceptance: ['RV1'], mutations: [LEAN_MUTATION] } }))
        }
        const client = {
          start() {}, initialize() {}, newSession() {}, setMode() {},
          beginPrompt: () => 5, pollPrompt: () => null,
          cancelPrompt: () => { late(); return true },
          close: () => ({ outcome: 'proven' }),
        }
        return runAcpSeat({ ...input, binaries: { pi: process.execPath, claudeAcp: process.execPath, claude: process.execPath },
          deps: { ...input.deps, clientFactory: () => client, now: () => clock, sleep: (ms) => { clock += ms } } })
      },
    },
    loopDeps: { readFile: async (...args) => { reads++; return readFileSync(...args) } },
  })
  const result = await f.go()
  assert.equal(result.status, 'stopped')
  assert.equal(result.reason, 'seat-unmeasured')
  assert.equal(existsSync(returnPath), true)
  assert.equal(reads, 0)
  assert.equal(laterSeats, 0)
  assert.equal(clock, 2000)
  assert.deepEqual(terminal(f.logs), [{ event: 'loop-result', ...result }])
})

// MUTATION: skip the empty-list refusal in the seat and a toolless Claude seat starts and runs.
test('a Claude seat authored with an empty tools list stops the lane as seat-unmeasured before any process starts', async () => {
  const planner = join(AGENTS, 'planner.md')
  const spawned = [], refusals = []
  const f = leanFixture({
    deps: {
      readFileSync: (path, ...args) => {
        const text = readFileSync(path, ...args)
        return path === planner ? text.replace('writes: task-dir', 'writes: task-dir\ntools: []') : text
      },
      runAcpSeat: (input) => {
        try {
          return runAcpSeat({
            ...input,
            definition: { ...input.definition, agent: 'claude', model: 'anthropic/claude-opus-4-6' },
            binaries: { claudeAcp: process.execPath, claude: process.execPath },
            deps: { ...input.deps, clientDeps: { spawn: (...args) => { spawned.push(args); throw new Error('no process may start') } } },
          })
        } catch (error) { refusals.push(error.code); throw error }
      },
    },
  })
  const result = await f.go()
  assert.deepEqual(result, { status: 'stopped', reason: 'seat-unmeasured', pr: null })
  assert.deepEqual(refusals, ['ACP_EMPTY_TOOLS'])
  assert.equal(spawned.length, 0)
  assert.deepEqual(terminal(f.logs), [{ event: 'loop-result', ...result }])
})

// One planner turn whose ACP result is `turn`; a present return file is written first so a read of it would be visible.
async function oneTurn(turn, { withFile = true, deps = {} } = {}) {
  let reads = 0
  const verdicts = []
  const f = leanFixture({
    acp: async (input) => {
      const path = /^Return path: (.+)$/m.exec(input.prompt)[1]
      const id = /^Envelope id: (.+)$/m.exec(input.prompt)[1]
      try { input.deps.appendFileSync(input.sessionFile, `${JSON.stringify({ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'chunk' } } })}\n`, 'utf8') } catch {}
      if (withFile) {
        mkdirSync(f.spec.taskDir, { recursive: true })
        writeFileSync(path, JSON.stringify({ role: 'planner', id, status: 'done', summary: 'x', details: { subject: 'fix(crew): publish measured lane results', plan_path: 'p', gate_path: 'g', acceptance: ['RV1'], mutations: [LEAN_MUTATION] } }))
      }
      return turn
    },
    deps,
    loopDeps: {
      readFile: async (...args) => { reads++; return readFileSync(...args) },
      journal: async (row) => { if (row.event === 'verdict') verdicts.push(row) },
    },
  })
  const result = await f.go()
  const rows = readFileSync(f.sessionOf('planner', 1), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  return { f, result, reads: () => reads, verdicts, rows }
}

// MUTATION: drop the refusal clause of the turn check and a refused turn falls through to the envelope read.
test('a refused ACP turn stops the lane as seat-unmeasured with the provider cause, never reading the envelope, even one that exists', async () => {
  const refusals = [
    { code: -32000, message: 'account out of credits', errorKind: 'billing_error' },
    { code: null, message: 'quota exhausted', errorKind: null },
  ]
  for (const refusal of refusals) {
    for (const [stopReason, usage] of [[null, null], ['end_turn', { input_tokens: 3 }]]) {
      for (const withFile of [true, false]) {
        const label = `${refusal.message} ${stopReason} ${withFile}`
        const run = await oneTurn({ stopReason, usage, refusal }, { withFile })
        assert.deepEqual(run.result, { status: 'stopped', reason: 'seat-unmeasured', pr: null }, label)
        assert.equal(run.reads(), 0, label)
        assert.equal(run.f.requests.length, 1, label)
        assert.equal(run.verdicts.length, 1, label)
        assert.deepEqual(run.verdicts[0].observation.error, { code: refusal.code, message: refusal.message }, label)
        assert.deepEqual(run.rows.at(-1), { type: 'turn', stopReason, usage, refusal }, label)
        assert.equal(run.rows.length, 3, label)
      }
    }
  }
})

// MUTATION: drop the missing-stop-reason clause and a turn that never measured a stop is accepted on its envelope.
test('an ACP turn with no stop reason (null, empty, absent, no turn at all) is unmeasured before any envelope read', async () => {
  for (const turn of [{ stopReason: null, usage: null, refusal: null }, { stopReason: '', usage: null, refusal: null }, { usage: null, refusal: null }, undefined, null]) {
    const run = await oneTurn(turn)
    const label = JSON.stringify(turn) ?? 'undefined'
    assert.deepEqual(run.result, { status: 'stopped', reason: 'seat-unmeasured', pr: null }, label)
    assert.equal(run.reads(), 0, label)
    assert.deepEqual(run.verdicts[0].observation.error, { code: null, message: 'ACP seat turn returned no stop reason' }, label)
    assert.deepEqual(run.rows.at(-1), { type: 'turn', stopReason: turn?.stopReason ?? null, usage: null, refusal: null }, label)
  }
})

// MUTATION: swallow the failed turn-row append and the cause is lost while the seat still reports a recorded failure.
test('a denied turn-row append still fails the seat and names the recording error; an earlier recording error wins', async () => {
  const refused = { stopReason: null, usage: null, refusal: { code: 1, message: 'refused', errorKind: 'x' } }
  for (const code of ['EPERM', 'EIO', 'EINTR']) {
    const deny = (match, errorCode) => (...args) => {
      if (String(args[1]).includes(match)) throw Object.assign(new Error(`${errorCode} injected`), { code: errorCode })
      return appendFileSyncReal(...args)
    }
    const turnRow = await oneTurn(refused, { deps: { appendFileSync: deny('"type":"turn"', code) } })
    assert.deepEqual(turnRow.result, { status: 'stopped', reason: 'seat-unmeasured', pr: null }, code)
    assert.equal(turnRow.reads(), 0, code)
    assert.equal(turnRow.verdicts[0].observation.error.code, code)
    const earlier = await oneTurn(refused, { deps: { appendFileSync: (...args) => { if (String(args[1]).includes('chunk')) throw Object.assign(new Error('first'), { code }); return deny('"type":"turn"', 'EIO')(...args) } } })
    assert.equal(earlier.verdicts[0].observation.error.code, code)
    assert.equal(earlier.reads(), 0, code)
  }
})

// MUTATION: null the usage in the turn row and an accepted turn loses its measurement.
test('an accepted turn ends with exactly one turn row carrying its usage, and its envelope is read', async () => {
  for (const usage of [{ input_tokens: 5, output_tokens: 2 }, null]) {
    const run = await oneTurn({ stopReason: 'end_turn', usage, refusal: null })
    assert.equal(run.reads() > 0, true)
    assert.equal(run.rows.filter((row) => row.type === 'turn').length, 1)
    assert.deepEqual(run.rows.at(-1), { type: 'turn', stopReason: 'end_turn', usage, refusal: null })
    assert.equal(run.rows.length, 3)
  }
})

// A planner whose first `refusals.length` turns are refused, then accepted; the clock and the wait are virtual.
async function retryRun(refusals, { oversleep = 0 } = {}) {
  const sleeps = [], sessions = []
  let clock = Date.parse('2026-10-26T00:00:00Z'), turns = 0
  const f = leanFixture({
    acp: async (input) => {
      sessions.push(input.sessionFile)
      const path = /^Return path: (.+)$/m.exec(input.prompt)[1]
      const id = /^Envelope id: (.+)$/m.exec(input.prompt)[1]
      const wanted = input.definition.role === 'planner' ? refusals[turns++] : undefined
      const refusal = typeof wanted === 'function' ? wanted(clock) : wanted
      if (refusal) return { stopReason: null, usage: null, refusal }
      mkdirSync(f.spec.taskDir, { recursive: true })
      if (input.definition.role === 'planner') for (const name of ['plan.md', 'gate.mjs']) writeFileSync(join(f.spec.taskDir, name), '')
      const details = input.definition.role === 'planner' ? { subject: 'fix(crew): publish measured lane results', plan_path: 'plan.md', gate_path: 'gate.mjs', acceptance: ['RV1'], mutations: [LEAN_MUTATION] }
        : input.definition.role === 'builder' ? { summary: 'built' } : { verdict: 'pass', findings: [] }
      writeFileSync(path, JSON.stringify({ role: input.definition.role, id, status: 'done', summary: 'x', details }))
      return { stopReason: 'end_turn', usage: { input_tokens: 1 }, refusal: null }
    },
    deps: { now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms + oversleep } },
  })
  const result = await f.go()
  return { f, result, sleeps, sessions }
}
const rateLimit = (at, hours) => {
  const d = new Date(at + hours * 3600000)
  const h = d.getUTCHours()
  return { code: -32000, errorKind: 'rate_limit', message: `resets ${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, '0')}${h < 12 ? 'am' : 'pm'} (UTC)` }
}

// MUTATION: null the classifier result and a rate-limited turn stops the lane instead of retrying.
test('a rate-limited turn is retried in a fresh session after the stated reset and the lane continues', async () => {
  const run = await retryRun([rateLimit(Date.parse('2026-10-26T00:00:00Z'), 2)])
  assert.equal(run.result.status, 'done')
  assert.deepEqual(run.sleeps, [2 * 3600000 + PROVIDER_RESET_SETTLE_MS])
  assert.equal(run.sessions.length, 4)
  assert.equal(new Set(run.sessions).size, 4)
  assert.equal(run.sessions[1], run.f.sessionOf('planner', 1).replace('.jsonl', '.retry-1.jsonl'))
  const rows = (file) => readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(rows(run.sessions[0]).at(-1).refusal.errorKind, 'rate_limit')
  assert.equal(rows(run.sessions[1]).at(-1).stopReason, 'end_turn')
  for (const file of run.sessions) assert.equal(rows(file).filter((row) => row.type === 'turn').length, 1)
})

test('a server error is retried up to the shared attempt bound, then the lane stops as seat-unmeasured', async () => {
  const refusal = { code: -32000, errorKind: 'overloaded', message: 'overloaded' }
  const recovers = await retryRun([refusal])
  assert.equal(recovers.result.status, 'done')
  const spent = await retryRun(Array(PROVIDER_RETRY_MAX + 2).fill(refusal))
  assert.deepEqual(spent.result, { status: 'stopped', reason: 'seat-unmeasured', pr: null })
  assert.equal(spent.sessions.length, PROVIDER_RETRY_MAX + 1)
  assert.equal(spent.sleeps.length, PROVIDER_RETRY_MAX)
})

test('pi overload retries in a fresh session; unknown and resetless usage limit do not retry', async () => {
  const refusal = (errorMessage) => ({ code: -32000, errorKind: 'pi-agent-error', message: 'pi agent run failed', errorMessage })
  const run = await retryRun([refusal('Codex error: Our servers are currently overloaded. Please try again later.')])
  assert.equal(run.result.status, 'done')
  assert.deepEqual(run.sleeps, [60_000])
  assert.equal(run.sessions.length, 4)
  assert.equal(new Set(run.sessions).size, 4)
  assert.equal(run.sessions[1], run.f.sessionOf('planner', 1).replace('.jsonl', '.retry-1.jsonl'))
  for (const message of ['WebSocket error', 'Codex error: The usage limit has been reached']) {
    const stopped = await retryRun([refusal(message)])
    assert.deepEqual(stopped.result, { status: 'stopped', reason: 'seat-unmeasured', pr: null })
    assert.deepEqual([stopped.sleeps.length, stopped.sessions.length], [0, 1])
  }
})

test('a retry never runs past the total wait: a reset beyond it, repeated resets, and an oversleep stop the lane', async () => {
  const at = Date.parse('2026-10-26T00:00:00Z')
  const far = await retryRun([rateLimit(at, 6)])
  assert.equal(far.result.reason, 'seat-unmeasured')
  assert.deepEqual([far.sleeps.length, far.sessions.length], [0, 1])
  const repeated = await retryRun(Array(4).fill((now) => rateLimit(now, 2)))
  assert.equal(repeated.result.reason, 'seat-unmeasured')
  assert.equal(repeated.sleeps.length, 2)
  assert.ok(repeated.sleeps.reduce((a, b) => a + b, 0) <= PROVIDER_RETRY_TOTAL_WAIT_MS)
  const overslept = await retryRun([{ code: -32000, errorKind: 'server_error', message: 'boom' }], { oversleep: PROVIDER_RETRY_TOTAL_WAIT_MS })
  assert.equal(overslept.result.reason, 'seat-unmeasured')
  assert.deepEqual([overslept.sleeps.length, overslept.sessions.length], [1, 1])
})

// MUTATION: neutralise the rmSync of the issued return path before a provider retry and the refused attempt's envelope is accepted.
test("a refused attempt's envelope is not accepted when its retry writes none", async () => {
  const sessions = []
  const f = leanFixture({
    acp: async (input) => {
      sessions.push(input.sessionFile)
      const path = /^Return path: (.+)$/m.exec(input.prompt)[1]
      const id = /^Envelope id: (.+)$/m.exec(input.prompt)[1]
      if (sessions.length === 1) {
        mkdirSync(f.spec.taskDir, { recursive: true })
        const details = { subject: 'fix(crew): publish measured lane results', plan_path: 'p', gate_path: 'g', acceptance: ['RV1'], mutations: [LEAN_MUTATION] }
        writeFileSync(path, JSON.stringify({ role: 'planner', id, status: 'done', summary: 'stale', details }))
        return { stopReason: null, usage: null, refusal: { code: -32000, errorKind: 'overloaded', message: 'overloaded' } }
      }
      return { stopReason: 'end_turn', usage: { input_tokens: 1 }, refusal: null }
    },
    deps: { sleep: async () => {} },
  })
  const result = await f.go()
  assert.equal(sessions.length, 2)
  assert.deepEqual(result, { status: 'stopped', reason: 'seat-unmeasured', pr: null })
})

// MUTATION: route an authentication failure as a server error and it is retried.
test('an authentication failure, even with a parseable reset, stops the lane without a retry', async () => {
  const at = Date.parse('2026-10-26T00:00:00Z')
  for (const errorKind of ['authentication_failed', 'oauth_org_not_allowed', 'verification_required']) {
    const run = await retryRun([{ ...rateLimit(at, 2), errorKind }])
    assert.deepEqual(run.result, { status: 'stopped', reason: 'seat-unmeasured', pr: null }, errorKind)
    assert.deepEqual([run.sleeps.length, run.sessions.length], [0, 1], errorKind)
  }
})

// MUTATION: skip the lead turn's definition and a consulted lead runs with no charter or P2 example.
test('a consulted lead gets its own definition and decision shape', async () => {
  const f = leanFixture({ answers: { 'planner.1': 'insufficient' } })
  const result = await f.go()
  assert.equal(result.status, 'done')
  const roles = f.requests.map((r) => r.definition.role)
  assert.deepEqual(roles.slice(0, 3), ['planner', 'lead', 'planner'])
  const lead = f.requests[1]
  assert.equal(lead.definition.model, `${resolveAgents('build').seats.lead.provider}/${resolveAgents('build').seats.lead.id}`)
  assert.match(lead.prompt, /"decision"/)
  assert.match(lead.prompt, /insufficient/)
  assert.ok(lead.prompt.includes(`Task directory: ${f.spec.taskDir}`))
  assert.equal(lead.sessionFile, f.sessionOf('lead', 2))
})

// MUTATION: resume the refused session or repeat the assignment and a repair is not a fresh, repair-only turn.
test('a schema-refused builder envelope gets one fresh repair-only turn at the same path, then the lane continues', async () => {
  const f = leanFixture()
  const turns = {}
  f.options.runAcpSeat = async (input) => {
    f.requests.push(input)
    const role = input.definition.role
    const id = /^Envelope id: (.+)$/m.exec(input.prompt)[1]
    const path = /^Return path: (.+)$/m.exec(input.prompt)[1]
    const n = turns[role] = (turns[role] ?? 0) + 1
    mkdirSync(f.spec.taskDir, { recursive: true })
    if (role === 'planner') for (const name of ['plan.md', 'gate.mjs']) writeFileSync(join(f.spec.taskDir, name), '')
    const value = { role, id, status: 'done', summary: 'fixture', details: role === 'planner' ? { subject: 'fix(crew): publish measured lane results', plan_path: join(f.spec.taskDir, 'plan.md'), gate_path: join(f.spec.taskDir, 'gate.mjs'), acceptance: ['RV1'], mutations: [LEAN_MUTATION] } : role === 'builder' ? { summary: 'built', ...(n === 1 ? { gaps: [] } : {}) } : { verdict: 'pass', findings: [] } }
    mkdirSync(f.spec.taskDir, { recursive: true })
    writeFileSync(path, JSON.stringify(value))
    return { stopReason: 'end_turn', usage: null, refusal: null }
  }
  const result = await f.go()
  assert.equal(result.status, 'done')
  const builders = f.requests.filter((r) => r.definition.role === 'builder')
  assert.equal(builders.length, 2)
  const [first, repair] = builders
  assert.notEqual(repair.sessionFile, first.sessionFile)
  assert.equal(first.sessionFile, f.sessionOf('builder', 2))
  assert.equal(repair.sessionFile, join(f.spec.taskDir, 'lean', 'builder', 'lane.builder.2.repair.jsonl'))
  for (const field of ['Envelope id', 'Return path']) {
    const pattern = new RegExp(`^${field}: (.+)$`, 'm')
    assert.equal(pattern.exec(repair.prompt)[1], pattern.exec(first.prompt)[1])
  }
  assert.ok(repair.prompt.includes('details.gaps is not a field of builder details'))
  assert.ok(!repair.prompt.includes(first.definition.body))
  assert.ok(!repair.prompt.includes(BRIEF))
  assert.deepEqual(JSON.parse(readFileSync(repair.sessionFile, 'utf8').split('\n')[0]), { type: 'prompt', text: repair.prompt })
  assert.ok(first.prompt.includes(BRIEF), 'the ordinary assignment keeps its full prompt')
})

// MUTATION: restore an old role-charter link or first-generation field in a body and a dispatched prompt carries it.
test('lean prompts contain only the lean contract', async () => {
  const f = leanFixture({ answers: { 'planner.1': 'insufficient' } })
  f.spec.brief = 'Implement the supplied task.'
  assert.equal((await f.go()).status, 'done')
  assert.deepEqual([...new Set(f.requests.map((r) => r.definition.role))].sort(), ['builder', 'lead', 'planner', 'reviewer'])
  for (const { prompt, definition } of f.requests) {
    assert.doesNotMatch(prompt, /^Charter file/m, definition.role)
    assert.doesNotMatch(prompt, /\]\([^)]*roles\//, definition.role)
    // Only the planner states the context the builder's arms read; no other turn names it.
    for (const field of ['gate_cmd', 'validation_lane', 'files_in_scope']) {
      const matcher = new RegExp(`\\b${field}\\b`)
      if (definition.role === 'planner') assert.match(prompt, matcher, `planner: ${field}`)
      else assert.doesNotMatch(prompt, matcher, `${definition.role}: ${field}`)
    }
    for (const field of ['commit_subject', 'closes', 'exemplars', 'exemplars_none', 'consult_questions']) {
      assert.doesNotMatch(prompt, new RegExp(`\\b${field}\\b`), `${definition.role}: ${field}`)
    }
  }
})

test('every lean seat turn carries the brief to the seat, and the planner example it is shown is a valid P2 planner envelope', async () => {
  const f = leanFixture({})
  f.spec.brief = 'Tripwire tests:\n- a.test.mjs · tripwire\nBroad keys\n'
  assert.equal((await f.go()).status, 'done')
  assert.ok(f.requests.length > 0)
  for (const request of f.requests) assert.equal(request.briefText, f.spec.brief, request.definition.role)
  const planner = f.requests.find((request) => request.definition.role === 'planner')
  const example = JSON.parse(planner.prompt.slice(planner.prompt.lastIndexOf('{\n  "role"'), planner.prompt.lastIndexOf('}') + 1))
  assert.deepEqual(validateEnvelope('planner', example).defects, [])
})

// MUTATION: take the effort from the file's base fields and a tier override never reaches the seat.
test('a tier override applies and an unseating override refuses the turn', async () => {
  const mechanical = leanFixture({ tier: 'mechanical' })
  assert.equal((await mechanical.go()).status, 'done')
  assert.equal(mechanical.requests[0].definition.effort, resolveAgents('mechanical').seats.planner.effort)
  assert.notEqual(mechanical.requests[0].definition.effort, parseAgent(readFileSync(join(AGENTS, 'planner.md'), 'utf8')).fields.effort)
  const seat = resolveAgents('build').seats.lead
  const unseated = leanFixture({ tier: 'mechanical', answers: { 'planner.1': 'insufficient' }, loopDeps: { resolveAgents: (tier) => ({ ...resolveAgents(tier), seats: { ...resolveAgents(tier).seats, lead: seat } }) } })
  const result = await unseated.go()
  assert.deepEqual(result, { status: 'stopped', reason: 'lead-refused', pr: null })
  assert.deepEqual(unseated.requests.map((r) => r.definition.role), ['planner'])
})

// MUTATION: append to an existing recording instead of creating it exclusively and an old turn is overwritten or mixed.
test('a recording that already exists is never reused: the turn stops before the seat starts', async () => {
  const f = leanFixture()
  mkdirSync(join(f.spec.taskDir, 'lean', 'planner'), { recursive: true })
  writeFileSync(f.sessionOf('planner', 1), 'earlier turn\n')
  const result = await f.go()
  assert.deepEqual(result, { status: 'stopped', reason: 'seat-unmeasured', pr: null })
  assert.equal(f.requests.length, 0)
  assert.equal(readFileSync(f.sessionOf('planner', 1), 'utf8'), 'earlier turn\n')
  assert.deepEqual(terminal(f.logs), [{ event: 'loop-result', ...result }])
})

// MUTATION: ignore a failed directory or prompt write and the seat runs with nothing recorded.
test('a denied recording directory or initial write stops the turn before the seat starts', async () => {
  for (const effect of ['mkdirSync', 'writeFileSync']) {
    const f = leanFixture({ deps: { [effect]: () => { throw EPERM } } })
    const result = await f.go()
    assert.deepEqual(result, { status: 'stopped', reason: 'seat-unmeasured', pr: null }, effect)
    assert.equal(f.requests.length, 0, effect)
    assert.deepEqual(terminal(f.logs), [{ event: 'loop-result', ...result }], effect)
  }
})

// MUTATION: pass the bridge's append straight through and the seat's swallowed recording failure goes unseen.
test('a recording append that fails, even once, stops the turn although the seat swallowed it', async () => {
  let appends = 0
  const f = leanFixture({ deps: { appendFileSync: (...args) => { if (++appends === 1) throw EPERM; return appendFileSyncReal(...args) } } })
  const result = await f.go()
  assert.deepEqual(result, { status: 'stopped', reason: 'seat-unmeasured', pr: null })
  assert.equal(f.requests.length, 1)
  assert.deepEqual(terminal(f.logs), [{ event: 'loop-result', ...result }])
})

// MUTATION: let a failed permission-row append pass and a decision the lane cannot replay goes unseen.
test('a permission row whose append fails stops the turn like any other recording failure', async () => {
  const acp = async (input) => {
    const id = /^Envelope id: (.+)$/m.exec(input.prompt)[1]
    const row = { kind: 'permission', role: input.definition.role, writes: input.definition.writes, sessionId: 's', tool_call_id: 't', tool: 'edit', title: 'write', option: 'deny', option_kind: 'reject_once' }
    try { input.deps.appendFileSync(input.sessionFile, `${JSON.stringify(row)}\n`, 'utf8') } catch {}
    assert.ok(id)
  }
  const f = leanFixture({ acp, deps: { appendFileSync: (path, text, ...rest) => { if (text.includes('"kind":"permission"')) throw EPERM; return appendFileSyncReal(path, text, ...rest) } } })
  assert.deepEqual(await f.go(), { status: 'stopped', reason: 'seat-unmeasured', pr: null })
  assert.equal(f.requests.length, 1)
})

// MUTATION: treat a thrown or rejected turn as returned and the loop reads a missing envelope as success.
test('a turn that throws or rejects stops with a terminal row', async () => {
  for (const acp of [async () => { throw EINTR }, () => { throw EINTR }]) {
    const f = leanFixture({ acp })
    const result = await f.go()
    assert.deepEqual(result, { status: 'stopped', reason: 'seat-unmeasured', pr: null })
    assert.deepEqual(terminal(f.logs), [{ event: 'loop-result', ...result }])
  }
})

test('the terminal row repeats a stopped loop result and a throwing log is not swallowed', async () => {
  const f = leanFixture({ loopDeps: { run: async () => { throw EPERM } } })
  const result = await f.go()
  assert.deepEqual(result, { status: 'stopped', reason: 'paths-unmeasured', pr: null })
  assert.deepEqual(terminal(f.logs), [{ event: 'loop-result', ...result }])
  const broken = leanFixture({ deps: { log: () => { throw EPERM } } })
  await assert.rejects(broken.go(), (error) => error === EPERM)
})

// MUTATION: launch the loop on an unreadable spec and a seat starts with no input.
test('the bridge entry reads one spec file; a malformed or unreadable spec is one invalid-input row and no seat', async () => {
  const dir = scratchDir('lean-main-')
  const bad = join(dir, 'bad.json')
  writeFileSync(bad, '{"id":')
  const rows = []
  const acp = async () => { throw new Error('a seat was launched') }
  for (const path of [bad, join(dir, 'missing.json')]) {
    assert.equal(await leanMain([path], { log: (line) => rows.push(line), runAcpSeat: acp }), 1)
  }
  assert.deepEqual(rows.map((row) => JSON.parse(row)), Array(2).fill({ event: 'loop-result', status: 'stopped', reason: 'invalid-input', pr: null }))
  assert.equal(await leanMain([], { log: () => {} }), 2)
  assert.equal(await leanMain([bad, bad], { log: () => {} }), 2)
  const good = leanFixture()
  const specPath = join(dir, 'spec.json')
  writeFileSync(specPath, JSON.stringify(good.spec))
  assert.equal(await leanMain([specPath], good.options), 0)
  assert.equal(existsSync(good.sessionOf('planner', 1)), true)
  const stoppedRows = []
  const failing = leanFixture({ loopDeps: { run: async () => { throw EPERM } } })
  const failingPath = join(dir, 'failing.json')
  writeFileSync(failingPath, JSON.stringify(failing.spec))
  assert.equal(await leanMain([failingPath], { ...failing.options, log: (line) => stoppedRows.push(line) }), 1)
  assert.equal(JSON.parse(stoppedRows.at(-1)).reason, 'paths-unmeasured')
})

test('importing the bridge launches nothing', () => {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(LEAN).href)})`], { encoding: 'utf8', timeout: 20000 })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout, '')
})

// MUTATION: drop subject from the planner example and the prompt shows a P2 the loop refuses.
test('the planner prompt example is a valid P2 envelope carrying a subject', async () => {
  const f = leanFixture()
  await f.go()
  const prompt = f.requests[0].prompt
  const start = prompt.indexOf('{', prompt.indexOf('"role": "planner"') - 20)
  const example = JSON.parse(prompt.slice(start, prompt.indexOf('\n}', start) + 2))
  assert.equal(example.role, 'planner')
  assert.deepEqual(validateEnvelope('planner', example).defects, [])
  assert.match(example.details.subject, /^fix\(crew\): /)
})

// MUTATION: invent the subject in startLane and the published source is not the brief's.
test('a started lean spec reaches the PR with its exact P1 source and measured body', async () => {
  const { deps, calls } = fakes()
  await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', loop: 'lean', deps })
  const spec = JSON.parse(written(calls, '/task/lean.json')[2])
  const seen = {}
  const loopDeps = {
    commitChanges: async (input) => { seen.commit = input; return { status: 'green', reason: null, head: 'a'.repeat(40) } },
    openPullRequest: async (input) => { seen.publish = input; return { status: 'green', reason: null, pr: { number: 7 } } },
  }
  const g = leanFixture({ loopDeps })
  g.spec.source = spec.source
  assert.equal((await g.go()).status, 'done')
  assert.equal(seen.commit.subject, 'fix(crew): publish measured lane results')
  assert.equal(seen.publish.title, seen.commit.subject)
  assert.equal(seen.publish.body, ['Source: "issue 1961"', '', '## Acceptance', '- RV1: an edit that cannot boot is refused', '', '## Measurements', '- Baseline gate: red; failing ids: RV1.', '- Gate: green.', '- Mutations: 1/1 killed (RV1: killed).', '- Suite: green; exit 0.'].join('\n'))
  assert.equal(spec.source, 'issue 1961')
})

// MUTATION: drop effective.requires from the dispatched definition and the proof has nothing to check.
test('the requires a seat receives are the effective definition list, tier override included, and its recording decides the envelope', async () => {
  const planner = join(AGENTS, 'planner.md')
  const edit = (from, to) => (path, ...args) => {
    const text = readFileSync(path, ...args)
    return path === planner ? text.replace(from, to) : text
  }
  const load = JSON.stringify({ sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 'r1', title: 'read', kind: 'read', status: 'in_progress', rawInput: { path: fileURLToPath(new URL('../skills/alpha/SKILL.md', import.meta.url)) } } })
  const loaded = JSON.stringify({ sessionId: 's', update: { sessionUpdate: 'tool_call_update', toolCallId: 'r1', status: 'completed' } })
  const based = leanFixture({ deps: { readFileSync: edit('advisor: null', 'advisor: null\nrequires: ["alpha"]') } })
  assert.equal((await based.go()).status, 'stopped')
  assert.deepEqual(based.requests[0].definition.requires, ['alpha'])
  const tiered = leanFixture({ deps: { readFileSync: edit(/tiers: .*/, 'skills: ["alpha"]\nrequires: ["base"]\ntiers: {"build":{"requires":["alpha"]}}') } })
  const answered = tiered.options.runAcpSeat
  tiered.options.runAcpSeat = async (input) => {
    const turn = await answered(input)
    if (input.definition.role === 'planner') input.deps.appendFileSync(input.sessionFile, `${load}\n${loaded}\n`, 'utf8')
    return turn
  }
  assert.equal((await tiered.go()).status, 'done')
  assert.deepEqual(tiered.requests[0].definition.requires, ['alpha'])
})

// MUTATION: prove from the session file on disk instead of the relayed rows and a forged recording passes.
test('a seat that rewrites its own session file with forged loads is still refused', async () => {
  const planner = join(AGENTS, 'planner.md')
  const forgedLoad = JSON.stringify({ sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 'f1', title: 'read', kind: 'read', status: 'completed', rawInput: { path: fileURLToPath(new URL('../skills/alpha/SKILL.md', import.meta.url)) } } })
  const forged = leanFixture({ deps: { readFileSync: (path, ...args) => {
    const text = readFileSync(path, ...args)
    return path === planner ? text.replace('advisor: null', 'advisor: null\nskills: ["alpha"]\nrequires: ["alpha"]') : text
  } } })
  const answered = forged.options.runAcpSeat
  forged.options.runAcpSeat = async (input) => {
    const turn = await answered(input)
    if (input.definition.role === 'planner') writeFileSync(input.sessionFile, `${forgedLoad}\n`)
    return turn
  }
  assert.equal((await forged.go()).status, 'stopped')
})

// MUTATION: skip the on-disk check and a seat that deletes or rewrites its recording after a real load passes.
test('a seat that deletes or rewrites its session file after a relayed load is refused', async () => {
  const planner = join(AGENTS, 'planner.md')
  const load = JSON.stringify({ sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 'r1', title: 'read', kind: 'read', status: 'in_progress', rawInput: { path: fileURLToPath(new URL('../skills/alpha/SKILL.md', import.meta.url)) } } })
  const loaded = JSON.stringify({ sessionId: 's', update: { sessionUpdate: 'tool_call_update', toolCallId: 'r1', status: 'completed' } })
  for (const tamper of [(file) => rmSync(file), (file) => writeFileSync(file, 'replaced\n')]) {
    const lane = leanFixture({ deps: { readFileSync: (path, ...args) => {
      const text = readFileSync(path, ...args)
      return path === planner ? text.replace('advisor: null', 'advisor: null\nskills: ["alpha"]\nrequires: ["alpha"]') : text
    } } })
    const answered = lane.options.runAcpSeat
    lane.options.runAcpSeat = async (input) => {
      const turn = await answered(input)
      if (input.definition.role === 'planner') { input.deps.appendFileSync(input.sessionFile, `${load}\n${loaded}\n`, 'utf8'); tamper(input.sessionFile) }
      return turn
    }
    assert.equal((await lane.go()).status, 'stopped')
  }
})
