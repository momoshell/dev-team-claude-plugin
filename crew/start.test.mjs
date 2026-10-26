import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync as appendFileSyncReal, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { laneName, main, runBrief, startLane, StartRefusal } from './start.mjs'
import { main as leanMain, runLean } from './lean.mjs'
import { runAcpSeat } from './acp/seat.mjs'
import { parseAgent, validateEnvelope } from './protocols.mjs'
import { acceptanceIds, composeCommitMessage, issueStatementDefect } from './drive.mjs'
import { resolveAgents } from './agents.mjs'
import { PROVIDER_RESET_SETTLE_MS, PROVIDER_RETRY_MAX, PROVIDER_RETRY_TOTAL_WAIT_MS } from './headless.mjs'
import { bootRefusals } from './roster-validate.mjs'
import { normalizeRoster, serializeRosterV2 } from './roster.mjs'
import { scratchDir } from '../test/helpers.mjs'

const AGENTS = fileURLToPath(new URL('./agents/', import.meta.url))
const ROSTER = fileURLToPath(new URL('./roster.json', import.meta.url))
const TEMPLATE_TEXT = readFileSync(ROSTER, 'utf8')
const TEMPLATE = JSON.parse(TEMPLATE_TEXT)

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

// Every effect is a recorded call; nothing touches git, the disk or a process. The roster
// metadata read and the agent resolution are injected too; the default resolves the committed definitions.
function fakes({ brief = BRIEF, exists = () => false, bootStatus = 0, worktreeStatus = 0, originHead = 'origin/main', inGit = true, driverReads, rosterText = TEMPLATE_TEXT, resolve = (tier) => resolveAgents(tier), refusals = async () => [], write = () => {} } = {}) {
  const calls = []
  const deps = {
    readFileSync: (path) => path === ROSTER ? rosterText : brief,
    resolveAgents: resolve,
    bootRefusals: async (roster) => { calls.push(['validate', structuredClone(roster)]); return refusals(roster) },
    existsSync: (path) => exists(path),
    mkdirSync: (path) => { calls.push(['mkdir', path]); write('mkdir', path) },
    writeFileSync: (path, text) => { calls.push(['write', path, text]); write('write', path, text) },
    ...(driverReads ? { driverReads } : {}),
    spawnSync: (file, args, options) => {
      calls.push(['spawn', file, args, options?.cwd ?? null])
      if (file === 'git' && args.includes('symbolic-ref')) return originHead ? { status: 0, stdout: `${originHead}\n` } : { status: 1, stdout: '' }
      if (file === 'git' && args.includes('worktree')) return { status: worktreeStatus, stdout: '' }
      if (file === 'git' && args.includes('rev-parse')) return inGit ? { status: 0, stdout: '/repo/checkout\n' } : { status: 128, stdout: '' }
      return { status: bootStatus, stdout: '', stderr: bootStatus ? 'seat-floor-conflict' : '' }
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

test('the lane name is the brief file name and must be a slug', () => {
  assert.equal(laneName('/drafts/b1360-lean-entry.md'), 'b1360-lean-entry')
  assert.throws(() => laneName('/drafts/My Brief.md'), StartRefusal)
})

// MUTATION: skip the brief check and a malformed brief boots a crew.
test('a brief with defects is refused before any git or boot call', async () => {
  const { deps, calls } = fakes({ brief: BRIEF.replace('tier: build', 'tier: rigorous') })
  await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps }), /tier is one of mechanical, build, judge/)
  assert.deepEqual(calls.filter(([kind]) => kind !== 'log'), [])
})

test('--check validates the brief and the generated roster and starts nothing', async () => {
  const { deps, calls } = fakes()
  const result = await startLane({ briefPath: '/d/b1.md', checkout: null, check: true, deps })
  assert.equal(result.checked, true)
  assert.deepEqual(calls.filter(([kind]) => kind !== 'log'), [['validate', calls.find(([kind]) => kind === 'validate')[1]]])
  assert.deepEqual(effects(calls), [])
  assert.match(calls.at(-1)[1], /brief ok lane=b1 tier=build shape=standard closes=1961/)
})

// MUTATION: boot before the worktree, or run before boot, and the crew lands in the wrong checkout.
test('a good brief makes the worktree from the default branch, boots headless at its tier, then runs detached on a snapshot', async () => {
  const { deps, calls } = fakes()
  const result = await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps })
  assert.equal(result.worktree, '/repo/dt-b1')
  assert.equal(result.pid, 4242)
  const order = calls.filter(([kind]) => kind === 'spawn' || kind === 'detached' || kind === 'write').map(([kind, file, args]) => kind === 'write' ? 'write' : `${kind}:${file === 'git' ? args[2] : args[1]}`)
  assert.deepEqual(order, ['spawn:symbolic-ref', 'spawn:worktree', 'write', 'write', 'spawn:boot', 'detached:run'])
  assert.deepEqual(spawned(calls, 'worktree')[2], ['-C', '/repo/checkout', 'worktree', 'add', '-b', 'b1', '/repo/dt-b1', 'main'])
  const boot = spawned(calls, 'boot')[2]
  assert.deepEqual(boot.slice(1, 8), ['boot', '--task', 'b1', '--checkout', '/repo/dt-b1', '--tier', 'build'])
  assert.ok(boot.includes('--headless-all'))
  assert.equal(spawned(calls, 'boot')[3], '/repo/dt-b1')
  const run = spawned(calls, 'run')
  assert.deepEqual(run[2].slice(1, 9), ['run', '--task', 'b1', '--checkout', '/repo/dt-b1', '--brief-file', '/home/.crew/briefs/started/b1.md', '--keep'])
  assert.equal(run[2].includes('--execution'), false)
  const { env, ...where } = run[3]
  assert.deepEqual(where, { cwd: '/repo/dt-b1', log: '/home/.crew/briefs/started/b1.run.log' })
  // MUTATION: drop the env and the run queues for a suite slot shared with every project on the host.
  assert.equal(env.CREW_SUITE_SLOTS, '0')
  assert.equal(env.PATH, process.env.PATH)
  assert.deepEqual(written(calls, '/b1.md'), ['write', '/home/.crew/briefs/started/b1.md', runBrief(BRIEF, 1961)])
  assert.equal(result.rosterPath, '/home/.crew/briefs/started/b1.roster.json')
})

// MUTATION: drop the shape mapping and a stepped brief runs single-chunk.
test('a stepped brief runs with --execution stepped; a finish brief is refused', async () => {
  const { deps, calls } = fakes({ brief: BRIEF.replace('shape: standard', 'shape: stepped') })
  await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps })
  assert.deepEqual(spawned(calls, 'run')[2].slice(-2), ['--execution', 'stepped'])
  const finish = fakes({ brief: BRIEF.replace('shape: standard', 'shape: finish') })
  await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: finish.deps }), /shape finish starts from an escalated lane/)
})

test('without origin/HEAD the lane branches from main', async () => {
  const { deps, calls } = fakes({ originHead: null })
  await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps })
  assert.equal(spawned(calls, 'worktree')[2].at(-1), 'main')
})

// MUTATION: drop the exists check and git worktree add fails late, or a live lane is reused.
test('an existing worktree, a failed worktree add or a refused boot stop the start and run nothing', async () => {
  const taken = fakes({ exists: (path) => path === '/repo/dt-b1' })
  await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: taken.deps }), /worktree \/repo\/dt-b1 already exists/)
  const broken = fakes({ worktreeStatus: 128 })
  await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: broken.deps }), /git worktree add -b b1 \/repo\/dt-b1 main failed/)
  const refused = fakes({ bootStatus: 1 })
  await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: refused.deps }), /crew boot refused lane b1 \(exit 1\):\nseat-floor-conflict/)
  for (const { calls } of [taken, broken, refused]) assert.equal(calls.some(([kind]) => kind === 'detached'), false)
})

test('main reports usage, refusals and success as exit codes', async () => {
  assert.equal(await main([], fakes().deps), 2)
  assert.equal(await main(['a.md', 'b.md'], fakes().deps), 2)
  assert.equal(await main(['/d/b1.md', '--check'], fakes().deps), 0)
  assert.equal(await main(['/d/b1.md', '--checkout', '/repo/checkout'], fakes({ bootStatus: 1 }).deps), 1)
})

// MUTATION: resolve the checkout before --check and a brief cannot be validated outside a repo.
test('--check works outside a git checkout; a real start there is refused', async () => {
  assert.equal(await main(['/d/b1.md', '--check'], fakes({ inGit: false }).deps), 0)
  assert.equal(await main(['/d/b1.md'], fakes({ inGit: false }).deps), 2)
})

// MUTATION: drop the bound-issue slot and the driver publishes the lane with no Closes trailer.
test('the run brief carries the driver header, and the driver reads it as P1 says', () => {
  const run = runBrief(BRIEF, 1961)
  assert.equal(run.split('\n').slice(0, 2).join('\n'), '# Task\n<!-- crew:bound-issue #1961 -->')
  assert.deepEqual(acceptanceIds(run), ['RV1'])
  assert.match(issueStatementDefect({ brief: run, details: {} }), /issue-bound lane must declare/)
  assert.match(composeCommitMessage({ task: 'b1', planEnv: { summary: 'refuse', details: { issues: ['1961'] } }, builderEnv: { summary: 'done' }, brief: run }), /^Closes: #1961$/m)
  assert.equal(runBrief(BRIEF.replace('closes: 1961', 'closes: null'), null).split('\n')[1], '')
})

// MUTATION: skip the driver check and a brief the driver reads differently starts a lane.
test('a brief the driver reads differently is refused before any git call', async () => {
  const { deps, calls } = fakes({ driverReads: () => ({ acceptance: null, bound: '1961' }) })
  await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', check: true, deps }), /the driver reads brief \/d\/b1.md differently: acceptance null/)
  assert.deepEqual(calls.filter(([kind]) => kind !== 'log'), [])
})

// stderr of main, captured; the exit code is returned beside it.
async function mainWithStderr(argv, deps) {
  let stderr = ''
  const write = process.stderr.write
  process.stderr.write = (text) => { stderr += String(text); return true }
  try { return { code: await main(argv, deps), stderr } } finally { process.stderr.write = write }
}

const privateAgents = (edit) => {
  const dir = scratchDir('start-agents-')
  cpSync(AGENTS, dir, { recursive: true })
  const path = join(dir, 'builder.md')
  writeFileSync(path, edit(readFileSync(path, 'utf8')))
  return dir
}
// A builder definition declaring a pi advisor: boot refuses it in every tier and transport.
const refusedAgents = () => privateAgents((text) => text.replace('advisor: null', 'advisor: {"agent":"pi","model":"openai/gpt-6.1-sol","effort":"medium"}'))

// MUTATION: boot the legacy roster.json and a definition edit never reaches the crew.
test('boot reads the validated roster written beside the brief, and a definition edit changes the seat', async () => {
  const dir = privateAgents((text) => text.replace('effort: high', 'effort: medium'))
  const { deps, calls } = fakes({ resolve: (tier) => resolveAgents(tier, dir) })
  const result = await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps })
  const boot = spawned(calls, 'boot')[2]
  assert.equal(boot[boot.indexOf('--roster') + 1], '/home/.crew/briefs/started/b1.roster.json')
  const [, path, text] = written(calls, '.roster.json')
  assert.equal(path, result.rosterPath)
  assert.equal(text.endsWith('\n'), true)
  assert.deepEqual(normalizeRoster(JSON.parse(text)), calls.find(([kind]) => kind === 'validate')[1])
  assert.equal(JSON.parse(text).tiers.build.builder.effort, 'medium')
  assert.equal(TEMPLATE.tiers.build.builder.effort, 'high')
  const at = (match) => calls.findIndex(match)
  assert.ok(at(([kind, file]) => kind === 'write' && file.endsWith('.roster.json')) < at(([kind, , args]) => kind === 'spawn' && args.includes('boot')))
})

// MUTATION: read the template raw, or copy its schema_version beside a tiers container, and
// a roster the editor saved as v2 refuses every start that boot would have accepted.
test('a v2 template generates a v2 roster that keeps its policy and boots the same seats', async () => {
  const policy = { transports: {} }
  const rosterText = serializeRosterV2({ ...normalizeRoster(TEMPLATE), policy })
  const { deps, calls } = fakes({ rosterText })
  await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps })
  const written = JSON.parse(calls.find(([kind, path]) => kind === 'write' && path.endsWith('.roster.json'))[2])
  assert.equal(written.schema_version, 2)
  assert.deepEqual(written.policy, policy)
  assert.deepEqual(normalizeRoster(written).tiers, TEMPLATE.tiers)
  assert.ok(spawned(calls, 'boot'))
})

// MUTATION: drop the null-key filling and mechanical loses its lead:null key.
test('the committed definitions generate the committed roster tiers, schema_version and models', async () => {
  const { deps, calls } = fakes()
  await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps })
  const roster = JSON.parse(written(calls, '.roster.json')[2])
  assert.deepEqual(roster.tiers, TEMPLATE.tiers)
  assert.equal(roster.tiers.mechanical.lead, null)
  assert.equal('tech-lead' in roster.tiers.build, false)
  assert.equal(roster.schema_version, TEMPLATE.schema_version)
  assert.deepEqual(roster.models, TEMPLATE.models)
})

test('definitions decide which roles are seated: a new seat is added, an unseated legacy role is nulled', async () => {
  const seat = { agent: 'claude', effort: 'high', provider: 'anthropic', id: 'claude-x' }
  const resolve = (tier) => {
    const { seats, advisor } = resolveAgents(tier)
    if (tier === 'build') return { seats: { ...seats, 'tech-lead': seat }, advisor }
    if (tier === 'judge') { const { reviewer, ...rest } = seats; return { seats: rest, advisor } }
    return { seats, advisor }
  }
  const { deps, calls } = fakes({ resolve })
  await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps })
  const { tiers } = JSON.parse(written(calls, '.roster.json')[2])
  assert.deepEqual(tiers.build['tech-lead'], seat)
  assert.equal(tiers.judge.reviewer, null)
  assert.deepEqual(tiers.judge.builder, TEMPLATE.tiers.judge.builder)
})

// MUTATION: report a generic refusal and the tier, transport, role and message are lost.
test('actual boot refusals reach stderr one record per line and fail --check', async () => {
  const dir = refusedAgents()
  const expected = await bootRefusals(JSON.parse(JSON.stringify({ ...TEMPLATE, tiers: Object.fromEntries(['mechanical', 'build', 'judge'].map((tier) => {
    const { seats, advisor } = resolveAgents(tier, dir)
    return [tier, { ...Object.fromEntries(Object.keys(TEMPLATE.tiers[tier]).filter((role) => role !== 'advisor').map((role) => [role, seats[role] ?? null])), ...seats, advisor }]
  })) })))
  assert.equal(expected.length, 6)
  const { deps, calls } = fakes({ resolve: (tier) => resolveAgents(tier, dir), refusals: bootRefusals })
  const { code, stderr } = await mainWithStderr(['/d/b1.md', '--check'], deps)
  assert.notEqual(code, 0)
  const rows = stderr.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line))
  for (const wanted of expected) assert.ok(rows.some((row) => ['tier', 'transport', 'role', 'message'].every((key) => row[key] === wanted[key])), JSON.stringify(wanted))
  assert.deepEqual(effects(calls), [])
})

test('every injected refusal record survives, including one with no role', async () => {
  const records = [
    { code: 'boot_refused', reason: null, tier: 'build', transport: 'default', role: 'builder', message: 'first' },
    { code: 'boot_refused', reason: null, tier: 'judge', transport: 'headless-all', role: null, message: 'second' },
  ]
  const { deps } = fakes({ refusals: async () => records })
  const { code, stderr } = await mainWithStderr(['/d/b1.md', '--check'], deps)
  assert.equal(code, 1)
  assert.deepEqual(stderr.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line)), records)
})

// MUTATION: disable the refusal guard and git, boot and the snapshot run for a roster that cannot boot.
test('a refused roster stops a real start before any git, boot, run or write, with an explicit or implicit checkout', async () => {
  const dir = refusedAgents()
  for (const argv of [['/d/b1.md'], ['/d/b1.md', '--checkout', '/repo/checkout']]) {
    const { deps, calls } = fakes({ resolve: (tier) => resolveAgents(tier, dir), refusals: bootRefusals })
    const { code } = await mainWithStderr(argv, deps)
    assert.equal(code, 1, argv.join(' '))
    assert.deepEqual(effects(calls), [], argv.join(' '))
  }
})

test('a refusal in a tier the brief does not select still refuses the start', async () => {
  const refusals = async (roster) => roster.tiers.judge.reviewer === null ? [] : [{ tier: 'judge', transport: 'default', role: 'reviewer', message: 'judge only' }]
  const { deps, calls } = fakes({ refusals })
  await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps }), /judge only/)
  assert.deepEqual(effects(calls), [])
})

test('no effect happens while the validation is still pending', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const { deps, calls } = fakes({ refusals: () => gate })
  const started = startLane({ briefPath: '/d/b1.md', checkout: null, deps })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(effects(calls), [])
  release([{ tier: 'build', transport: 'default', role: null, message: 'late' }])
  await assert.rejects(started, /late/)
  assert.deepEqual(effects(calls), [])
})

test('an implicit checkout is discovered after validation; outside git the start is refused with exit 2', async () => {
  const inside = fakes()
  const { code } = await mainWithStderr(['/d/b1.md'], inside.deps)
  assert.equal(code, 0)
  const order = inside.calls.map(([kind, file, args]) => kind === 'spawn' ? `spawn:${args.includes('rev-parse') ? 'rev-parse' : ''}` : kind).filter((kind) => kind === 'validate' || kind === 'spawn:rev-parse')
  assert.deepEqual(order, ['validate', 'spawn:rev-parse'])
  const outside = fakes({ inGit: false })
  const result = await mainWithStderr(['/d/b1.md'], outside.deps)
  assert.equal(result.code, 2)
  assert.match(result.stderr, /not inside a git checkout; pass --checkout <dir>/)
  assert.equal(outside.calls.some(([kind]) => kind === 'write' || kind === 'detached'), false)
})

test('unreadable, empty or malformed roster metadata and definitions, and a throwing validator, refuse before any effect', async () => {
  const denied = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
  const cases = [
    [{ rosterText: '' }, /cannot generate the roster from the agent definitions/],
    [{ rosterText: '{"schema_version":' }, /cannot generate the roster from the agent definitions/],
    [{ rosterText: '{"schema_version":1,"models":{}}' }, /cannot generate the roster from the agent definitions/],
    [{ resolve: () => { throw denied } }, /cannot generate the roster from the agent definitions: EPERM/],
    [{ resolve: () => { throw new Error('agent definitions are refused: empty') } }, /agent definitions are refused: empty/],
    [{ refusals: async () => { throw new Error('validator crashed') } }, /cannot check the generated roster: validator crashed/],
  ]
  for (const [options, message] of cases) {
    const { deps, calls } = fakes(options)
    await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps }), (error) => error instanceof StartRefusal && message.test(error.message))
    assert.deepEqual(effects(calls), [], String(message))
  }
  assert.equal(await main(['/d/b1.md', '--check'], fakes({ rosterText: '' }).deps), 1)
})

// MUTATION: swallow the snapshot failure and boot runs against a roster that was never written.
test('a denied or partial snapshot write stops boot and run and names the left worktree', async () => {
  for (const failing of ['mkdir', 'write']) {
    for (const code of ['EPERM', 'ENOENT']) {
      let writes = 0
      const { deps, calls } = fakes({ write: (kind) => {
        if (kind === failing && (kind === 'mkdir' || ++writes === 2)) throw Object.assign(new Error(`${code} injected`), { code })
      } })
      await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps }), (error) => error instanceof StartRefusal && error.message.includes(code) && /worktree \/repo\/dt-b1 and branch b1 are left for inspection/.test(error.message) && error.cause.code === code)
      assert.equal(spawned(calls, 'boot'), undefined)
      assert.equal(spawned(calls, 'run'), undefined)
    }
  }
})

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

// MUTATION: ignore --loop in main and the flag starts the legacy run.
test('main forwards --loop lean and refuses a missing, duplicate or unknown loop as usage', async () => {
  const lean = fakes()
  assert.equal(await main(['/d/b1.md', '--loop', 'lean', '--checkout', '/repo/checkout'], lean.deps), 0)
  assert.ok(leanLaunch(lean.calls))
  for (const argv of [['/d/b1.md', '--loop'], ['/d/b1.md', '--loop', 'stepped'], ['/d/b1.md', '--loop', 'lean', '--loop', 'lean'], ['/d/b1.md', '--loop', '--check'], ['--loop', 'lean'], ['/d/b1.md', '--lean']]) {
    const refused = fakes()
    assert.equal((await mainWithStderr(argv, refused.deps)).code, 2, argv.join(' '))
    assert.deepEqual(effects(refused.calls), [], argv.join(' '))
  }
  const plain = fakes()
  await main(['/d/b1.md', '--checkout', '/repo/checkout'], plain.deps)
  assert.equal(leanLaunch(plain.calls), undefined)
  assert.ok(spawned(plain.calls, 'run'))
})

// MUTATION: drop the shape refusal and a stepped brief starts a lean lane that runs only the standard loop.
test('--loop lean refuses a non-standard shape before any git call', async () => {
  const { deps, calls } = fakes({ brief: BRIEF.replace('shape: standard', 'shape: stepped') })
  await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', loop: 'lean', deps }), /--loop lean runs the standard shape only/)
  assert.deepEqual(effects(calls), [])
  await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', loop: 'other', deps: fakes().deps }), /--loop takes lean/)
})

// MUTATION: swallow the metadata failure and the bridge launches without a spec.
test('a denied lean metadata write stops the launch and names the left worktree', async () => {
  for (const [failing, at] of [['mkdir', 2], ['write', 3], ['write', 4]]) {
    // mkdir 1 and write 1-2 are the existing snapshot; the lean directory and its two files follow.
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
  let review = 0, reads = 0
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
      run: async (input) => input.args.includes('status') ? { ...GREEN, stdout: [status].flat()[Math.min(reads++, [status].flat().length - 1)] } : GREEN,
      ...loopDeps,
    },
    ...deps,
  }
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
    assert.deepEqual(request.definition, { role, agent: cell.agent, model: `${cell.provider}/${cell.id}`, effort: cell.effort, writes: { ...fields, ...fields.tiers?.build }.writes, skills: [], requires: [], tools: { ...fields, ...fields.tiers?.build }.tools, wait_s: { ...fields, ...fields.tiers?.build }.wait_s, body })
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
      const details = input.definition.role === 'planner' ? { subject: 'fix(crew): publish measured lane results', plan_path: 'p', gate_path: 'g', acceptance: ['RV1'], mutations: [LEAN_MUTATION] }
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
    for (const field of ['gate_cmd', 'validation_lane', 'files_in_scope', 'commit_subject', 'closes', 'exemplars', 'exemplars_none', 'consult_questions']) {
      assert.doesNotMatch(prompt, new RegExp(`\\b${field}\\b`), `${definition.role}: ${field}`)
    }
  }
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
  assert.equal(seen.publish.body, ['Source: "issue 1961"', '', '## Acceptance', '- RV1', '', '## Measurements', '- Baseline gate: red; failing ids: RV1.', '- Gate: green.', '- Mutations: 1/1 killed (RV1: killed).', '- Suite: green; exit 0.'].join('\n'))
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
