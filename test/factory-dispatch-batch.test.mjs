import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  BatchRefusal,
  BOOT_TRANSPORT,
  PANE_TRANSPORT,
  COUPLED_SOURCE_UNFENCED,
  REFUSAL_REASONS,
  REQUEST_SUFFIX,
  STALE_READ_ACK,
  checkArrival,
  checkFences,
  crewJsonPath,
  compileLane,
  dispatchBatch,
  main,
  normalDeps,
  parseCliArgs,
  planWorktrees,
  readsFromRefusal,
  readBatch,
  reconcileTier,
  resolveTransport,
  tierFloor,
} from '../scripts/factory/dispatch-batch.mjs'
import { scratchDir } from './helpers.mjs'

const root = scratchDir('factory-dispatch-batch-')
const repoRoot = dirname(dirname(new URL(import.meta.url).pathname))
const compiler = join(repoRoot, 'scripts', 'factory', 'make-brief.mjs')

function put(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

function request(ask = 'measure one owned source behavior', where = ['crew/owned.mjs']) {
  return {
    ask,
    where,
    done_means: 'the focused check reports the measured result',
    out_of_scope: 'unrelated repository behavior',
  }
}

function requestFor(lane, extra = {}) {
  return { ...request(`measure ${lane} source behavior`, [`crew/owned-${lane}.mjs`]), ...extra }
}

function makeBatch(names = ['lane-b', 'lane-a']) {
  const batch = join(root, `batch-${Math.random().toString(36).slice(2)}`)
  mkdirSync(batch, { recursive: true })
  for (const lane of names) put(join(batch, `${lane}${REQUEST_SUFFIX}`), JSON.stringify(request(`measure ${lane} source behavior`)))
  return batch
}

// tier and shape DIFFER: a fixture where they agree passes against the defect.
const briefWithTierAndShape = [
  '## Proposed tier',
  'proposed tier: build',
  'proposed shape: mechanical',
  '```proposal',
  '{',
  '  "shape": "mechanical",',
  '  "strength": "workhorse"',
  '}',
  '```',
].join('\n')

const briefWithBlockOnly = [
  '```proposal',
  '{',
  '  "shape": "judge",',
  '  "strength": "workhorse"',
  '}',
  '```',
].join('\n')

const briefWithQuotedTier = [
  'The ask quotes proposed tier: judge mid-sentence.',
  '## Proposed tier',
  'proposed tier: build',
  '```proposal',
  '{',
  '  "shape": "mechanical",',
  '  "strength": "workhorse"',
  '}',
  '```',
].join('\n')

function entry(lane, files, reads = []) { return { lane, files, reads } }
function refusal(fn, reason) {
  assert.throws(fn, (err) => err instanceof BatchRefusal && err.reason === reason)
}

let gitFixtureCount = 0
function gitFixture() {
  gitFixtureCount += 1
  const dir = join(root, `compiler-git-${gitFixtureCount}`)
  mkdirSync(dir, { recursive: true })
  put(join(dir, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node -e "process.exit(0)"' } }))
  put(join(dir, 'src', 'owned.mjs'), 'export const OWNED = 1\n')
  put(join(dir, 'src', 'coupled.mjs'), "import { OWNED } from './owned.mjs'\nexport const COUPLED = OWNED\n")
  put(join(dir, 'src', 'stale.mjs'), 'export const STALE = 1\n')
  const init = spawnSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  for (const args of [
    ['-C', dir, 'config', 'user.email', 'factory@test.invalid'],
    ['-C', dir, 'config', 'user.name', 'factory test'],
    ['-C', dir, 'add', '.'],
    ['-C', dir, 'commit', '-m', 'fixture'],
  ]) {
    const result = spawnSync('git', args, { encoding: 'utf8' })
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`)
  }
  return dir
}

test('readBatch reads request JSON, normalises where paths, and sorts lanes', () => {
  const batch = makeBatch()
  put(join(batch, `lane-a${REQUEST_SUFFIX}`), JSON.stringify({
    ...request('measure lane-a source behavior'), creates: ['./crew/x.mjs'],
  }))
  const lanes = readBatch({ batchDir: batch })
  assert.deepEqual(lanes.map(({ lane }) => lane), ['lane-a', 'lane-b'])
  assert.equal(lanes[0].name, 'lane-a.request.json')
  assert.deepEqual(lanes[0].where, ['crew/owned.mjs'])
  assert.deepEqual(lanes[0].creates, ['crew/x.mjs'])
  assert.deepEqual(lanes[0].request.creates, ['./crew/x.mjs'])
  assert.equal(lanes[0].request.ask, 'measure lane-a source behavior')
})

test('readBatch refuses an unreadable directory and an empty batch by name', () => {
  refusal(() => readBatch({ batchDir: join(root, 'missing-batch') }), 'batch-unreadable')
  const empty = join(root, 'empty-batch')
  mkdirSync(empty)
  refusal(() => readBatch({ batchDir: empty }), 'batch-empty')
})

test('worktree-exists and branch-taken are first checks with named refusals', () => {
  refusal(() => planWorktrees({
    lanes: ['lane-a'], parentDir: root, checkout: root,
    deps: { existsSync: () => true, spawn: () => ({ status: 1 }) },
  }), 'worktree-exists')
  refusal(() => planWorktrees({
    lanes: ['lane-a'], parentDir: root, checkout: root,
    deps: { existsSync: () => false, spawn: () => ({ status: 0 }) },
  }), 'branch-taken')
})

test('checkFences refuses sibling leakage before any worktree subprocess', () => {
  const fences = [entry('lane-a', ['crew/shared.mjs']), entry('lane-b', ['crew/shared.mjs'])]
  const lanes = [{ lane: 'lane-a', where: ['crew/shared.mjs'] }, { lane: 'lane-b', where: ['crew/shared.mjs'] }]
  refusal(() => checkFences({ fences, lanes }), 'sibling-leak')
})

test('checkFences pins own coverage, register membership, and scope entry shape', () => {
  refusal(() => checkFences({
    fences: [entry('lane-a', ['crew/owned.mjs'])],
    lanes: [{ lane: 'lane-a', where: ['crew/not-owned.mjs'] }],
  }), 'where-outside-fence')
  refusal(() => checkFences({
    fences: [entry('lane-a', ['crew/owned.mjs'])],
    lanes: [{ lane: 'lane-a', where: ['crew/owned.mjs'], creates: ['crew/not-owned.mjs'] }],
  }), 'where-outside-fence')
  refusal(() => checkFences({
    fences: [entry('lane-a', ['crew/owned.mjs'])],
    lanes: [{ lane: 'lane-b', where: ['crew/owned.mjs'] }],
  }), 'lane-unfenced')
  refusal(() => checkFences({
    fences: [entry('lane-a', ['crew/*'])],
    lanes: [{ lane: 'lane-a', where: ['crew/owned.mjs'] }],
  }), 'scope-entry-invalid')
  refusal(() => checkFences({
    fences: [entry('lane-a', [null])],
    lanes: [{ lane: 'lane-a', where: ['null'] }],
  }), 'scope-entry-invalid')
  refusal(() => checkFences({
    fences: [{ lane: 'lane-a', files: 'crew/owned.mjs' }],
    lanes: [{ lane: 'lane-a', where: ['crew/owned.mjs'] }],
  }), 'scope-entry-invalid')
})

test('created paths are covered by the own fence, cannot leak to a sibling, and are reported per lane', () => {
  assert.throws(() => checkFences({
    fences: [
      entry('lane-a', ['skills/crew-dispatch/']),
      entry('lane-b', ['skills/crew-dispatch/references/new.md']),
    ],
    lanes: [{ lane: 'lane-a', where: [], creates: ['./skills/crew-dispatch/references/new.md'] }],
  }), (error) => error instanceof BatchRefusal
    && error.reason === 'sibling-leak'
    && error.message.includes('skills/crew-dispatch/references/new.md'))

  const report = checkFences({
    fences: [entry('lane-a', ['crew/new/']), entry('lane-b', ['docs/reference/'])],
    lanes: [{ lane: 'lane-a', where: [], creates: ['./crew/new/file.mjs'] }],
  })
  assert.deepEqual(report.perLane['lane-a'].creates, ['crew/new/file.mjs'])
})

test('crew state paths and arrival checks use the runtime slug and exact sibling count', () => {
  assert.match(crewJsonPath({ checkout: '/tmp/dt-lane-a', lane: 'lane_a' }), /\/lane-a\/crew\.json$/)
  refusal(() => checkArrival({ crew: { lane_fence: [] }, lane: 'lane-a', batchTotal: 1 }), 'fence-not-arrived')
  refusal(() => checkArrival({ crew: { lane_name: 'lane-a', lane_fence: [] }, lane: 'lane-a', batchTotal: 2 }), 'fence-count-mismatch')
  assert.deepEqual(
    checkArrival({ crew: { lane_name: 'lane-a', lane_fence: [{ lane: 'lane-b', files: [] }] }, lane: 'lane-a', batchTotal: 2 }),
    { lane: 'lane-a', siblings: [{ lane: 'lane-b', files: [] }] },
  )
})

test('tier floor and reconciliation keep the protected path at judge', () => {
  assert.deepEqual(tierFloor({ files: ['crew/drive.mjs'] }), {
    hits: ['crew/drive.mjs'], forced: 'judge', floor: 'judge',
  })
  assert.equal(tierFloor({ files: ['skills/crew-dispatch/references/batch.md'] }).forced, null)
  refusal(() => reconcileTier({ lane: 'lane-a', forced: 'judge', proposed: 'build', requested: 'build' }), 'tier-floor-conflict')
  assert.equal(reconcileTier({ lane: 'lane-a', forced: null, proposed: 'build', requested: 'judge' }).tier, 'judge')
  assert.equal(reconcileTier({ lane: 'lane-a', forced: null, proposed: null, requested: null }).tier, null)
})

test('REFUSAL_REASONS is frozen, unique, and names every reason argument in the source', () => {
  assert.equal(Object.isFrozen(REFUSAL_REASONS), true)
  assert.equal(new Set(REFUSAL_REASONS).size, REFUSAL_REASONS.length)
  const source = readFileSync(join(repoRoot, 'scripts', 'factory', 'dispatch-batch.mjs'), 'utf8')
  const constants = new Map([...source.matchAll(/const\s+([A-Z_]+)\s*=\s*'([^']+)'/g)].map((match) => [match[1], match[2]]))
  const names = []
  for (const line of source.split('\n').filter((line) => line.includes('refuse('))) {
    const match = /,\s*([A-Z_]+)\)/.exec(line)
    if (match) names.push(match[1])
  }
  const thrown = new Set(names.map((name) => constants.get(name)).filter(Boolean))
  assert.deepEqual(new Set(REFUSAL_REASONS), thrown)
})

test('readsFromRefusal parses both compiler refusal shapes from real compiler output', () => {
  const checkout = gitFixture()
  const batch = join(checkout, 'batch')
  mkdirSync(batch)
  put(join(batch, 'lane-a.request.json'), JSON.stringify(request('measure owned source behavior', ['src/owned.mjs'])))
  const out = join(checkout, 'out')
  mkdirSync(out)
  const coupledRegister = join(checkout, 'coupled-register.json')
  put(coupledRegister, JSON.stringify({ lanes: [entry('lane-a', ['src/owned.mjs'], [])] }))
  const coupled = spawnSync(process.execPath, [
    compiler, '--request', join(batch, 'lane-a.request.json'), '--checkout', checkout,
    '--fences', coupledRegister, '--lane', 'lane-a', '--out', join(out, 'coupled.md'), '--force',
  ], { cwd: repoRoot, encoding: 'utf8' })
  assert.notEqual(coupled.status, 0)
  const first = readsFromRefusal(coupled.stderr)
  assert.equal(first.reason, COUPLED_SOURCE_UNFENCED)
  assert.deepEqual(first.files, ['src/coupled.mjs'])

  const staleRegister = join(checkout, 'stale-register.json')
  put(staleRegister, JSON.stringify({ lanes: [entry('lane-a', ['src/owned.mjs', 'src/coupled.mjs'], [{ file: 'src/stale.mjs', why: 'fixture stale acknowledgement' }])] }))
  const stale = spawnSync(process.execPath, [
    compiler, '--request', join(batch, 'lane-a.request.json'), '--checkout', checkout,
    '--fences', staleRegister, '--lane', 'lane-a', '--out', join(out, 'stale.md'), '--force',
  ], { cwd: repoRoot, encoding: 'utf8' })
  assert.notEqual(stale.status, 0)
  const second = readsFromRefusal(stale.stderr)
  assert.equal(second.reason, STALE_READ_ACK)
  assert.deepEqual(second.files, ['src/stale.mjs'])
})

test('dispatchBatch refuses a leaking register before spawning any subprocess', () => {
  const batch = makeBatch(['lane-a', 'lane-b'])
  const spawned = []
  const deps = {
    readdirSync: () => ['lane-a.request.json', 'lane-b.request.json'],
    readFileSync: (path) => {
      const lane = String(path).split('/').pop().replace(REQUEST_SUFFIX, '')
      return JSON.stringify(request(`measure ${lane} source behavior`, ['crew/shared.mjs']))
    },
    existsSync: () => false,
    spawn: (call) => { spawned.push(call); return { status: 0 } },
  }
  refusal(() => dispatchBatch({
    batchDir: batch,
    fences: [entry('lane-a', ['crew/shared.mjs']), entry('lane-b', ['crew/shared.mjs'])],
    checkout: root, parentDir: root, outDir: join(root, 'out'), deps,
  }), 'sibling-leak')
  assert.equal(spawned.length, 0)
})

test('dispatchBatch compiles lanes sequentially and then boots and runs them', () => {
  const batch = makeBatch(['lane-a', 'lane-b'])
  const out = join(root, 'sequential-out')
  const fences = [entry('lane-a', ['crew/owned-a.mjs']), entry('lane-b', ['crew/owned-b.mjs'])]
  const spawned = []
  let compileActive = false
  const deps = {
    existsSync: () => false,
    readdirSync: () => ['lane-a.request.json', 'lane-b.request.json'],
    readFileSync: (path) => {
      const text = String(path)
      if (text.endsWith(REQUEST_SUFFIX)) {
        const lane = text.split('/').pop().replace(REQUEST_SUFFIX, '')
        return JSON.stringify(request(`measure ${lane} source behavior`, [`crew/owned-${lane.slice(-1)}.mjs`]))
      }
      if (text.endsWith('.brief.md')) return '```proposal\n{"shape":"build","strength":null}\n```\n'
      if (text.endsWith('/crew.json')) {
        const parts = text.split('/')
        const lane = parts[parts.length - 2]
        const sibling = lane === 'lane-a' ? 'lane-b' : 'lane-a'
        return JSON.stringify({ lane_name: lane, lane_fence: [{ lane: sibling, files: [] }] })
      }
      throw new Error(`unexpected read ${path}`)
    },
    spawn: (call) => {
      spawned.push(call)
      if (call.args.includes('rev-parse')) return { status: 1, stdout: '', stderr: '' }
      if (call.args.some((arg) => String(arg).endsWith('make-brief.mjs'))) {
        assert.equal(compileActive, false)
        compileActive = true
        compileActive = false
        return { status: 0, stdout: '', stderr: '' }
      }
      return { status: 0, stdout: '', stderr: '' }
    },
    log: () => {},
  }
  const report = dispatchBatch({
    batchDir: batch, fences, checkout: root, parentDir: root, outDir: out,
    tier: 'mechanical', variant: 'full', deps,
  })
  assert.deepEqual(report.lanes.map(({ lane }) => lane), ['lane-a', 'lane-b'])
  const compileCalls = spawned.filter(({ args }) => args.some((arg) => String(arg).endsWith('make-brief.mjs')))
  assert.equal(compileCalls.length, 2)
  assert.equal(spawned.filter(({ args }) => args.includes('worktree')).length, 2)
  const runCalls = spawned.filter(({ args }) => args.includes('run'))
  assert.equal(runCalls.length, 2)
  assert.equal(runCalls.every((call) => call.background === true && String(call.logPath).endsWith('/run.log')), true)
})

function fakedDispatch({ label, names, shaFor, measurementStatus = 0 }) {
  const batch = makeBatch(names)
  for (const lane of names) {
    put(join(batch, `${lane}${REQUEST_SUFFIX}`), JSON.stringify(request(
      `measure ${lane} source behavior`, [`crew/owned-${lane}.mjs`],
    )))
  }
  const out = join(root, `baseline-${label}-out`)
  const parent = join(root, `baseline-${label}-parent`)
  const spawned = []
  const deps = {
    existsSync: () => false,
    readdirSync: () => names.map((lane) => `${lane}${REQUEST_SUFFIX}`),
    readFileSync: (path, encoding) => {
      const text = String(path)
      if (text.endsWith(REQUEST_SUFFIX)) return readFileSync(text, 'utf8')
      if (text.endsWith('.brief.md')) return '```proposal\n{"shape":"build","strength":null}\n```\n'
      if (text.endsWith('/crew.json')) {
        const lane = text.split('/').at(-2)
        const siblings = names.filter((candidate) => candidate !== lane)
        return JSON.stringify({
          lane_name: lane,
          lane_fence: siblings.map((sibling) => ({ lane: sibling, files: [] })),
        })
      }
      return readFileSync(text, encoding || 'utf8')
    },
    spawn: (call) => {
      spawned.push(call)
      const args = (call.args || []).map(String)
      if (args.includes('rev-parse') && args.includes('HEAD')) {
        const index = args.indexOf('-C')
        const target = index === -1 ? String(call.cwd || '') : args[index + 1]
        return { status: 0, stdout: `${shaFor(target)}\n`, stderr: '' }
      }
      if (args.includes('rev-parse')) return { status: 1, stdout: '', stderr: '' }
      if (args.includes('--measure-baseline')) {
        return { status: measurementStatus, stdout: '', stderr: measurementStatus === 0 ? '' : 'measurement failed' }
      }
      return { status: 0, stdout: '', stderr: '' }
    },
    log: () => {},
  }
  const report = dispatchBatch({
    batchDir: batch,
    fences: names.map((lane) => entry(lane, [`crew/owned-${lane}.mjs`])),
    checkout: root,
    parentDir: parent,
    outDir: out,
    tier: 'mechanical',
    variant: 'full',
    deps,
  })
  const measures = spawned.filter(({ args }) => (args || []).map(String).includes('--measure-baseline'))
  const compiles = spawned.filter(({ args }) => {
    const list = (args || []).map(String)
    return list.some((arg) => arg.endsWith('make-brief.mjs')) && list.includes('--request')
  })
  return { report, spawned, measures, compiles }
}

function dispatchFixture({
  label,
  names = ['lane-a', 'lane-b'],
  requests = {},
  fences,
  batchTier = 'mechanical',
  runFlags = {},
  workspaceFor = (lane) => `ws-${lane}`,
} = {}) {
  const batch = join(root, `dispatch-${label}-${Math.random().toString(36).slice(2)}`)
  const parent = join(root, `dispatch-${label}-parent`)
  const out = join(root, `dispatch-${label}-out`)
  mkdirSync(batch, { recursive: true })
  const authored = Object.fromEntries(names.map((lane) => [lane, requests[lane] || requestFor(lane)]))
  for (const lane of names) put(join(batch, `${lane}${REQUEST_SUFFIX}`), JSON.stringify(authored[lane]))
  const spawned = []
  const logs = []
  const laneFences = fences || names.map((lane) => entry(lane, [`crew/owned-${lane}.mjs`]))
  const deps = {
    existsSync: () => false,
    readdirSync: () => names.map((lane) => `${lane}${REQUEST_SUFFIX}`),
    readFileSync: (path, encoding) => {
      const text = String(path)
      if (text.endsWith(REQUEST_SUFFIX) && text.startsWith(batch)) {
        const name = basenameOf(text)
        const lane = name.slice(0, -REQUEST_SUFFIX.length)
        return JSON.stringify(authored[lane])
      }
      if (text.endsWith('.brief.md')) return briefWithBlockOnly
      if (text.endsWith('/crew.json')) {
        const lane = text.split('/').at(-2)
        return JSON.stringify({
          lane_name: lane,
          lane_fence: names.filter((candidate) => candidate !== lane).map((sibling) => ({ lane: sibling, files: [] })),
          workspace_id: workspaceFor(lane),
        })
      }
      return readFileSync(text, encoding || 'utf8')
    },
    spawn: (call) => {
      spawned.push(call)
      const args = (call.args || []).map(String)
      if (args.includes('rev-parse')) return { status: 1, stdout: '', stderr: '' }
      return { status: 0, stdout: '', stderr: '' }
    },
    log: (line) => logs.push(String(line)),
  }
  const report = dispatchBatch({
    batchDir: batch,
    fences: laneFences,
    checkout: root,
    parentDir: parent,
    outDir: out,
    tier: batchTier,
    variant: 'full',
    runFlags,
    deps,
  })
  return { report, spawned, logs, batch, parent, out, fences: laneFences }
}

function basenameOf(path) {
  return String(path).split('/').at(-1)
}

test('a four-lane batch measures the baseline once', () => {
  const names = ['lane-a', 'lane-b', 'lane-c', 'lane-d']
  const result = fakedDispatch({ label: 'four', names, shaFor: () => 'a'.repeat(40) })
  // Measured mechanism: four lanes cost four suite runs before this lane and one after.
  assert.equal(result.measures.length, 1)
  assert.equal(result.compiles.length, 4)
  assert.equal(result.compiles.every(({ args }) => (args || []).map(String).includes('--baseline')), true)
  assert.equal(result.report.lanes.length, 4)
})

test('lanes on different commits fall back to measuring per lane', () => {
  const names = ['lane-a', 'lane-b', 'lane-c']
  const result = fakedDispatch({
    label: 'divergent', names,
    shaFor: (target) => String(target).endsWith('lane-a') ? 'a'.repeat(40) : 'b'.repeat(40),
  })
  assert.equal(result.measures.length, 0)
  assert.equal(result.compiles.length, 3)
  assert.equal(result.compiles.every(({ args }) => !(args || []).map(String).includes('--baseline')), true)
  assert.equal(result.report.lanes.length, 3)
})

test('a failed batch measurement never refuses the batch', () => {
  const names = ['lane-a', 'lane-b', 'lane-c']
  const result = fakedDispatch({
    label: 'failed-measurement', names, shaFor: () => 'a'.repeat(40), measurementStatus: 1,
  })
  assert.equal(result.measures.length, 1)
  assert.equal(result.compiles.length, 3)
  assert.equal(result.compiles.every(({ args }) => !(args || []).map(String).includes('--baseline')), true)
  assert.equal(result.report.lanes.length, 3)
})

test('a single-lane batch takes no separate batch measurement', () => {
  const result = fakedDispatch({ label: 'single', names: ['lane-a'], shaFor: () => 'a'.repeat(40) })
  assert.equal(result.measures.length, 0)
  assert.equal(result.compiles.length, 1)
  assert.equal(result.compiles.every(({ args }) => !(args || []).map(String).includes('--baseline')), true)
  assert.equal(result.report.lanes.length, 1)
})

test('parseCliArgs refuses missing values and unknown flags', () => {
  refusal(() => parseCliArgs(['--tier']), 'batch-unreadable')
  refusal(() => parseCliArgs(['--not-a-flag', 'x']), 'batch-unreadable')
})

test('main loads the fence register, forwards dry-run, and returns a usage code', () => {
  const checkout = gitFixture()
  const batch = join(checkout, 'main-batch')
  mkdirSync(batch)
  put(join(batch, 'lane-a.request.json'), JSON.stringify(request('measure main path behavior', ['src/owned.mjs'])))
  const register = join(checkout, 'main-fences.json')
  put(register, JSON.stringify({ lanes: [entry('lane-a', ['src/owned.mjs'])] }))
  const code = main([
    '--batch', batch,
    '--fences', register,
    '--checkout', checkout,
    '--parent', root,
    '--out', join(root, 'main-out'),
    '--dry-run',
  ], { existsSync: () => false, spawn: () => ({ status: 1 }), log: () => {} })
  assert.equal(code, 0)
  assert.equal(main(['--unknown'], { log: () => {} }), 2)
})

test('an unsupported run variant refuses before any run launch', () => {
  const batch = makeBatch(['lane-a'])
  const spawned = []
  refusal(() => dispatchBatch({
    batchDir: batch,
    fences: [entry('lane-a', ['crew/owned.mjs'])],
    checkout: root,
    parentDir: root,
    outDir: join(root, 'bad-variant-out'),
    variant: 'not-a-variant',
    deps: { existsSync: () => false, spawn: (call) => { spawned.push(call); return { status: 1 } } },
  }), 'run-failed')
  assert.equal(spawned.some(({ args }) => args.includes('run')), false)
})

test('an unsupported run variant refuses BEFORE the branch probe, not after it', () => {
  const batch = makeBatch(['lane-a'])
  const spawned = []
  // Both faults are present at once: the variant is invalid AND the lane branch
  // already exists (the probe answers status 0). Before the preflight was moved
  // above planWorktrees, the git probe ran first and the batch refused
  // `branch-taken` — naming a cause it tripped over instead of the one it
  // measured, and spawning a subprocess to do it (RV3-1).
  refusal(() => dispatchBatch({
    batchDir: batch,
    fences: [entry('lane-a', ['crew/owned.mjs'])],
    checkout: root,
    parentDir: root,
    outDir: join(root, 'variant-before-probe-out'),
    variant: 'not-a-variant',
    deps: { existsSync: () => false, spawn: (call) => { spawned.push(call); return { status: 0 } } },
  }), 'run-failed')
  assert.deepEqual(spawned, [], 'no subprocess may run before the run options are preflighted')
})

test('moving the preflight earlier does not disarm branch-taken for valid run options', () => {
  // The reverse direction: with the variant valid, the same taken branch must
  // still refuse `branch-taken`. A reorder that silenced this would trade one
  // wrong refusal for a missing one.
  const batch = makeBatch(['lane-a'])
  const spawned = []
  refusal(() => dispatchBatch({
    batchDir: batch,
    fences: [entry('lane-a', ['crew/owned.mjs'])],
    checkout: root,
    parentDir: root,
    outDir: join(root, 'valid-variant-taken-branch-out'),
    variant: 'full',
    deps: { existsSync: () => false, spawn: (call) => { spawned.push(call); return { status: 0 } } },
  }), 'branch-taken')
  assert.equal(spawned.some(({ args }) => args.includes('rev-parse')), true)
})

test('--dry-run plans branch probes but creates no worktree', () => {
  const batch = makeBatch(['lane-a'])
  const spawned = []
  const report = dispatchBatch({
    batchDir: batch,
    fences: [entry('lane-a', ['crew/owned.mjs'])],
    checkout: root,
    parentDir: root,
    outDir: join(root, 'dry-run-out'),
    runFlags: { 'dry-run': true },
    deps: { existsSync: () => false, spawn: (call) => { spawned.push(call); return { status: 1 } }, log: () => {} },
  })
  assert.equal(report.dryRun, true)
  assert.equal(spawned.some(({ args }) => args.includes('worktree')), false)
})

test('normalDeps supplies the house-style dependency surface', () => {
  const deps = normalDeps({})
  assert.deepEqual(Object.keys(deps).sort(), ['existsSync', 'log', 'readFileSync', 'readdirSync', 'spawn'])
})

test('compileLane performs at most two passes and carries compiler reads into a retry register', () => {
  const batch = makeBatch(['lane-a'])
  const out = join(root, 'compile-out')
  const register = join(root, 'register.json')
  put(register, JSON.stringify({ lanes: [entry('lane-a', ['crew/owned.mjs'], [])] }))
  const calls = []
  let pass = 0
  const result = compileLane({
    lane: 'lane-a', batchDir: batch, laneDir: root, registerPath: register, outDir: out,
    fences: [entry('lane-a', ['crew/owned.mjs'], [])],
    deps: {
      spawn: (call) => {
        calls.push(call)
        pass += 1
        if (pass === 1) return { status: 2, stderr: 'brief: coupled source(s) outside lane fence: crew/x.mjs · X [reason: coupled-source-unfenced]' }
        return { status: 0, stdout: '', stderr: '' }
      },
      readFileSync: (path) => path.endsWith('.brief.md') ? briefWithTierAndShape : readFileSync(path, 'utf8'),
    },
  })
  assert.equal(calls.length, 2)
  assert.equal(result.proposed, 'build')
  const retry = calls[1].args[calls[1].args.indexOf('--fences') + 1]
  assert.notEqual(retry, register)
  assert.deepEqual(JSON.parse(readFileSync(retry, 'utf8')).lanes[0].reads.map(({ file }) => file), ['crew/x.mjs'])
})

function compileBriefProposal(brief, label) {
  const batch = makeBatch(['lane-a'])
  const out = join(root, `proposal-${label}-out`)
  const register = join(root, `proposal-${label}-register.json`)
  put(register, JSON.stringify({ lanes: [entry('lane-a', ['crew/owned.mjs'], [])] }))
  return compileLane({
    lane: 'lane-a', batchDir: batch, laneDir: root, registerPath: register, outDir: out,
    fences: [entry('lane-a', ['crew/owned.mjs'], [])],
    deps: {
      spawn: () => ({ status: 0, stdout: '', stderr: '' }),
      readFileSync: (path) => String(path).endsWith('.brief.md') ? brief : readFileSync(path, 'utf8'),
    },
  }).proposed
}

test('a proposal block without a tier line never supplies the seating tier', () => {
  assert.equal(compileBriefProposal(briefWithBlockOnly, 'block-only'), null)
})

test('a mid-sentence proposed tier quote does not outrank the compiler line', () => {
  assert.equal(compileBriefProposal(briefWithQuotedTier, 'quoted-tier'), 'build')
})

test('readBatch splits a lane tier and leaves the compiler request schema clean', () => {
  const batch = makeBatch(['lane-a', 'lane-b'])
  put(join(batch, `lane-a${REQUEST_SUFFIX}`), JSON.stringify(requestFor('lane-a', { tier: 'judge' })))
  const lanes = readBatch({ batchDir: batch })
  assert.equal(lanes.find(({ lane }) => lane === 'lane-a').tier, 'judge')
  assert.equal(lanes.find(({ lane }) => lane === 'lane-b').tier, null)
  assert.equal(Object.hasOwn(lanes.find(({ lane }) => lane === 'lane-a').request, 'tier'), false)
})

test('a lane tier seats that lane while a sibling takes the batch default', () => {
  const result = dispatchFixture({
    label: 'lane-tier',
    requests: { 'lane-a': requestFor('lane-a', { tier: 'judge' }) },
    batchTier: 'mechanical',
  })
  const boots = result.spawned.filter(({ args }) => args.includes('boot'))
  const seated = Object.fromEntries(boots.map((call) => {
    const task = call.args[call.args.indexOf('--task') + 1]
    return [task, call.args[call.args.indexOf('--tier') + 1]]
  }))
  assert.deepEqual(seated, { 'lane-a': 'judge', 'lane-b': 'mechanical' })
  const requested = result.logs.filter((line) => line.startsWith('dispatch-batch: lane='))
  assert.ok(requested.some((line) => line.includes('lane=lane-a') && line.includes('requested=judge requested_from=lane')))
  assert.ok(requested.some((line) => line.includes('lane=lane-b') && line.includes('requested=mechanical requested_from=batch')))
})

test('the compiler receives exactly the four schema request keys', () => {
  const result = dispatchFixture({
    label: 'clean-request',
    requests: { 'lane-a': requestFor('lane-a', { tier: 'judge' }) },
  })
  const compiles = result.spawned.filter(({ args }) => args.some((arg) => String(arg).endsWith('make-brief.mjs')))
  assert.equal(compiles.length, 2)
  const expected = ['ask', 'done_means', 'out_of_scope', 'where']
  for (const call of compiles) {
    const path = call.args[call.args.indexOf('--request') + 1]
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, 'utf8'))).sort(), expected)
  }
})

test('creates reaches the compiler as an optional fifth key while tier remains dispatch-only', () => {
  const result = dispatchFixture({
    label: 'creates-request',
    requests: { 'lane-a': requestFor('lane-a', { tier: 'judge', creates: ['./crew/new-a.mjs'] }) },
    fences: [
      entry('lane-a', ['crew/owned-lane-a.mjs', 'crew/new-a.mjs']),
      entry('lane-b', ['crew/owned-lane-b.mjs']),
    ],
  })
  const compiles = result.spawned.filter(({ args }) => args.some((arg) => String(arg).endsWith('make-brief.mjs')))
  const laneA = compiles.find(({ args }) => args.some((arg) => String(arg).endsWith('/lane-a.compile-request.json')))
  const parsed = JSON.parse(readFileSync(laneA.args[laneA.args.indexOf('--request') + 1], 'utf8'))
  assert.deepEqual(Object.keys(parsed).sort(), ['ask', 'creates', 'done_means', 'out_of_scope', 'where'])
  assert.deepEqual(parsed.creates, ['./crew/new-a.mjs'])
  assert.equal(Object.hasOwn(parsed, 'tier'), false)
})

test('a lane tier below its protected floor refuses tier-floor-conflict', () => {
  const requestBody = requestFor('lane-a', { tier: 'mechanical', where: ['crew/drive.mjs'] })
  assert.throws(() => dispatchFixture({
    label: 'floor-conflict',
    names: ['lane-a'],
    requests: { 'lane-a': requestBody },
    fences: [entry('lane-a', ['crew/drive.mjs'])],
  }), (err) => err instanceof BatchRefusal && err.reason === 'tier-floor-conflict')
})

test('an unrecognised lane tier refuses batch-unreadable', () => {
  assert.throws(() => dispatchFixture({
    label: 'unknown-tier',
    names: ['lane-a'],
    requests: { 'lane-a': requestFor('lane-a', { tier: 'operator' }) },
  }), (err) => err instanceof BatchRefusal && err.reason === 'batch-unreadable')
})

test('keep defaults on, --no-keep removes it, and the report states the choice', () => {
  const kept = dispatchFixture({ label: 'keep-default' })
  const keptRuns = kept.spawned.filter(({ args }) => args.includes('run'))
  assert.equal(kept.report.keep, true)
  assert.equal(keptRuns.length, 2)
  assert.equal(keptRuns.every(({ args }) => args.includes('--keep')), true)

  const released = dispatchFixture({ label: 'keep-off', runFlags: { 'no-keep': true } })
  const releasedRuns = released.spawned.filter(({ args }) => args.includes('run'))
  assert.equal(released.report.keep, false)
  assert.equal(releasedRuns.length, 2)
  assert.equal(releasedRuns.every(({ args }) => !args.includes('--keep')), true)
  assert.equal(released.logs.filter((line) => line.startsWith('dispatch-batch: workspaces keep=false')).length, 1)
})

test('parseCliArgs accepts --no-keep as a boolean override', () => {
  assert.deepEqual(parseCliArgs(['--batch', 'b', '--no-keep']), { batch: 'b', 'no-keep': true })
})

test('parseCliArgs accepts both transport flags as booleans and refuses duplicates', () => {
  assert.deepEqual(parseCliArgs(['--batch', 'b', '--panes']), { batch: 'b', panes: true })
  assert.deepEqual(parseCliArgs(['--batch', 'b', '--headless-all']), { batch: 'b', 'headless-all': true })
  refusal(() => parseCliArgs(['--batch', 'b', '--panes', '--panes']), 'batch-unreadable')
  refusal(() => parseCliArgs(['--batch', 'b', '--headless-all', '--headless-all']), 'batch-unreadable')
})

test('resolveTransport defaults headless, selects panes, and refuses conflicting choices', () => {
  assert.equal(resolveTransport(), BOOT_TRANSPORT)
  assert.equal(resolveTransport({ runFlags: { panes: true } }), PANE_TRANSPORT)
  refusal(() => resolveTransport({ runFlags: { panes: true, 'headless-all': true } }), 'transport-conflict')
})

test('default dispatch reports headless transport and every boot carries its flag', () => {
  const result = dispatchFixture({ label: 'default-transport' })
  const boots = result.spawned.filter(({ args }) => args.includes('boot'))
  assert.equal(result.report.transport, BOOT_TRANSPORT)
  assert.equal(boots.every(({ args }) => args.includes('--headless-all')), true)
})

test('--panes dispatch omits transport flags and reports returned workspaces', () => {
  const result = dispatchFixture({ label: 'panes-argv-and-report', runFlags: { panes: true } })
  const boots = result.spawned.filter(({ args }) => args.includes('boot'))
  assert.equal(boots.every(({ args }) => !args.includes('--headless-all') && !args.includes('--panes')), true)
  assert.deepEqual(result.report.lanes.map(({ lane, workspaceId }) => ({ lane, workspaceId })), [
    { lane: 'lane-a', workspaceId: 'ws-lane-a' },
    { lane: 'lane-b', workspaceId: 'ws-lane-b' },
  ])
})

test('--panes dispatch refuses when boot returns a null workspace_id', () => {
  assert.throws(() => dispatchFixture({
    label: 'panes-null-workspace',
    runFlags: { panes: true },
    workspaceFor: () => null,
  }), (err) => err instanceof BatchRefusal
    && err.reason === 'boot-failed'
    && err.message.includes('crew.json workspace_id is null'))
})

test('pane closing output names each returned workspace', () => {
  const result = dispatchFixture({ label: 'panes-closing-output', runFlags: { panes: true } })
  const transport = result.logs.filter((line) => line.startsWith('dispatch-batch: transport='))
  assert.equal(transport.length, 1)
  assert.equal(transport[0].startsWith(`dispatch-batch: transport=${PANE_TRANSPORT}`), true)
  assert.match(transport[0], /lane-a=ws-lane-a/)
  assert.match(transport[0], /lane-b=ws-lane-b/)
  assert.doesNotMatch(transport[0], /workspace_id is null/)
})

test('closing output states the transport, keep policy, and names one teardown command per lane', () => {
  const result = dispatchFixture({ label: 'closing-output' })
  const transport = result.logs.filter((line) => line.startsWith('dispatch-batch: transport='))
  assert.equal(transport.length, 1)
  assert.equal(transport[0].startsWith(`dispatch-batch: transport=${BOOT_TRANSPORT}`), true)
  assert.match(transport[0], /workspace_id is null/)
  const boots = result.spawned.filter(({ args }) => args.includes('boot'))
  assert.equal(boots.length, 2)
  assert.equal(boots.every(({ args }) => args.includes('--headless-all')), true)
  assert.equal(result.logs.filter((line) => line.startsWith('dispatch-batch: workspaces keep=true')).length, 1)
  for (const lane of ['lane-a', 'lane-b']) {
    assert.ok(result.logs.includes(
      `dispatch-batch: teardown lane=${lane} command=node crew/crew.mjs teardown --task ${lane} --checkout ${join(result.parent, `dt-${lane}`)}`,
    ))
  }
})
