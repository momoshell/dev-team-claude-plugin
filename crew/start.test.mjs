import { test } from 'node:test'
import assert from 'node:assert/strict'
import { laneName, main, runBrief, startLane, StartRefusal } from './start.mjs'
import { acceptanceIds, composeCommitMessage, issueStatementDefect } from './drive.mjs'

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

// Every effect is a recorded call; nothing touches git, the disk or a process.
function fakes({ brief = BRIEF, exists = () => false, bootStatus = 0, worktreeStatus = 0, originHead = 'origin/main', inGit = true, driverReads } = {}) {
  const calls = []
  const deps = {
    readFileSync: () => brief,
    existsSync: (path) => exists(path),
    mkdirSync: (path) => calls.push(['mkdir', path]),
    writeFileSync: (path, text) => calls.push(['write', path, text]),
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

const spawned = (calls, verb) => calls.find(([kind, , args]) => (kind === 'spawn' || kind === 'detached') && args.includes(verb))

test('the lane name is the brief file name and must be a slug', () => {
  assert.equal(laneName('/drafts/b1360-lean-entry.md'), 'b1360-lean-entry')
  assert.throws(() => laneName('/drafts/My Brief.md'), StartRefusal)
})

// MUTATION: skip the brief check and a malformed brief boots a crew.
test('a brief with defects is refused before any git or boot call', () => {
  const { deps, calls } = fakes({ brief: BRIEF.replace('tier: build', 'tier: rigorous') })
  assert.throws(() => startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps }), /tier is one of mechanical, build, judge/)
  assert.deepEqual(calls.filter(([kind]) => kind !== 'log'), [])
})

test('--check validates and starts nothing', () => {
  const { deps, calls } = fakes()
  const result = startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', check: true, deps })
  assert.equal(result.checked, true)
  assert.deepEqual(calls.filter(([kind]) => kind !== 'log'), [])
  assert.match(calls.at(-1)[1], /brief ok lane=b1 tier=build shape=standard closes=1961/)
})

// MUTATION: boot before the worktree, or run before boot, and the crew lands in the wrong checkout.
test('a good brief makes the worktree from the default branch, boots headless at its tier, then runs detached on a snapshot', () => {
  const { deps, calls } = fakes()
  const result = startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps })
  assert.equal(result.worktree, '/repo/dt-b1')
  assert.equal(result.pid, 4242)
  const order = calls.filter(([kind]) => kind === 'spawn' || kind === 'detached' || kind === 'write').map(([kind, file, args]) => kind === 'write' ? 'write' : `${kind}:${file === 'git' ? args[2] : args[1]}`)
  assert.deepEqual(order, ['spawn:symbolic-ref', 'spawn:worktree', 'write', `spawn:boot`, 'detached:run'])
  assert.deepEqual(spawned(calls, 'worktree')[2], ['-C', '/repo/checkout', 'worktree', 'add', '-b', 'b1', '/repo/dt-b1', 'main'])
  const boot = spawned(calls, 'boot')[2]
  assert.deepEqual(boot.slice(1, 8), ['boot', '--task', 'b1', '--checkout', '/repo/dt-b1', '--tier', 'build'])
  assert.ok(boot.includes('--headless-all'))
  assert.equal(spawned(calls, 'boot')[3], '/repo/dt-b1')
  const run = spawned(calls, 'run')
  assert.deepEqual(run[2].slice(1, 9), ['run', '--task', 'b1', '--checkout', '/repo/dt-b1', '--brief-file', '/home/.crew/briefs/started/b1.md', '--keep'])
  assert.equal(run[2].includes('--execution'), false)
  assert.deepEqual(run[3], { cwd: '/repo/dt-b1', log: '/home/.crew/briefs/started/b1.run.log' })
  assert.deepEqual(calls.find(([kind]) => kind === 'write'), ['write', '/home/.crew/briefs/started/b1.md', runBrief(BRIEF, 1961)])
})

// MUTATION: drop the shape mapping and a stepped brief runs single-chunk.
test('a stepped brief runs with --execution stepped; a finish brief is refused', () => {
  const { deps, calls } = fakes({ brief: BRIEF.replace('shape: standard', 'shape: stepped') })
  startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps })
  assert.deepEqual(spawned(calls, 'run')[2].slice(-2), ['--execution', 'stepped'])
  const finish = fakes({ brief: BRIEF.replace('shape: standard', 'shape: finish') })
  assert.throws(() => startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: finish.deps }), /shape finish starts from an escalated lane/)
})

test('without origin/HEAD the lane branches from main', () => {
  const { deps, calls } = fakes({ originHead: null })
  startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps })
  assert.equal(spawned(calls, 'worktree')[2].at(-1), 'main')
})

// MUTATION: drop the exists check and git worktree add fails late, or a live lane is reused.
test('an existing worktree, a failed worktree add or a refused boot stop the start and run nothing', () => {
  const taken = fakes({ exists: (path) => path === '/repo/dt-b1' })
  assert.throws(() => startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: taken.deps }), /worktree \/repo\/dt-b1 already exists/)
  const broken = fakes({ worktreeStatus: 128 })
  assert.throws(() => startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: broken.deps }), /git worktree add -b b1 \/repo\/dt-b1 main failed/)
  const refused = fakes({ bootStatus: 1 })
  assert.throws(() => startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: refused.deps }), /crew boot refused lane b1 \(exit 1\):\nseat-floor-conflict/)
  for (const { calls } of [taken, broken, refused]) assert.equal(calls.some(([kind]) => kind === 'detached'), false)
})

test('main reports usage, refusals and success as exit codes', () => {
  assert.equal(main([], fakes().deps), 2)
  assert.equal(main(['a.md', 'b.md'], fakes().deps), 2)
  assert.equal(main(['/d/b1.md', '--check'], fakes().deps), 0)
  assert.equal(main(['/d/b1.md', '--checkout', '/repo/checkout'], fakes({ bootStatus: 1 }).deps), 1)
})

// MUTATION: resolve the checkout before --check and a brief cannot be validated outside a repo.
test('--check works outside a git checkout; a real start there is refused', () => {
  assert.equal(main(['/d/b1.md', '--check'], fakes({ inGit: false }).deps), 0)
  assert.equal(main(['/d/b1.md'], fakes({ inGit: false }).deps), 2)
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
test('a brief the driver reads differently is refused before any git call', () => {
  const { deps, calls } = fakes({ driverReads: () => ({ acceptance: null, bound: '1961' }) })
  assert.throws(() => startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', check: true, deps }), /the driver reads brief \/d\/b1.md differently: acceptance null/)
  assert.deepEqual(calls.filter(([kind]) => kind !== 'log'), [])
})
