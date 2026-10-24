import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { laneName, main, runBrief, startLane, StartRefusal } from './start.mjs'
import { acceptanceIds, composeCommitMessage, issueStatementDefect } from './drive.mjs'
import { resolveAgents } from './agents.mjs'
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
