import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync as cpSpawnSync } from 'node:child_process'
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  ARM_APPEND_REASONS, ARM_AXES, ARM_SET_REASONS, ARM_SET_STATUSES,
  ARM_SPAWN_DEFAULT_N, ARM_SPAWN_MAX_N, ARM_SPAWN_REASONS, ARM_SPAWN_STATUSES,
  armsManifestPath, appendArm, collectArms, factoryctlSpawner, readManifest, spawnArmSet,
} from './arms.mjs'
import { openLedger } from '../scripts/factory/ledger.mjs'

const ID_A = '11111111-2222-3333-4444-555555555555'
const ID_B = '22222222-3333-4444-5555-666666666666'
const ID_C = '33333333-4444-5555-6666-777777777777'

function git(repoDir, ...args) {
  return execFileSync('git', [
    '-c', 'user.email=crew@example.invalid',
    '-c', 'user.name=Crew Test',
    '-c', 'protocol.file.allow=always',
    '-C', repoDir, ...args,
  ], { encoding: 'utf8' }).trim()
}

function gitResult(repoDir, ...args) {
  return cpSpawnSync('git', [
    '-c', 'user.email=crew@example.invalid',
    '-c', 'user.name=Crew Test',
    '-c', 'protocol.file.allow=always',
    '-C', repoDir, ...args,
  ], { encoding: 'utf8' })
}

function makeWorld() {
  const root = mkdtempSync(join(tmpdir(), 'crew-arms-'))
  const host = join(root, 'host')
  mkdirSync(host)
  git(host, 'init', '-q', '-b', 'main')
  writeFileSync(join(host, 'seed.txt'), 'seed\n')
  git(host, 'add', 'seed.txt')
  git(host, 'commit', '-q', '-m', 'base')
  const pin = git(host, 'rev-parse', 'HEAD')
  writeFileSync(join(host, 'other.txt'), 'other\n')
  git(host, 'add', 'other.txt')
  git(host, 'commit', '-q', '-m', 'other')
  const other = git(host, 'rev-parse', 'HEAD')
  git(host, 'checkout', '-q', '-B', 'main', pin)
  const manifest = join(root, 'factory', 'arms', 'set-a.jsonl')
  let serial = 0

  const world = {
    root,
    host,
    pin,
    other,
    manifest,
    arm(adwId, { base = pin, commits = 1 } = {}) {
      const run = join(root, `run-${serial += 1}`)
      git(host, 'worktree', 'add', '-q', '--detach', run, base)
      git(run, 'checkout', '-q', '-b', `branch-${serial}`)
      for (let index = 0; index < commits; index += 1) {
        const name = `${adwId}-${index}.txt`
        writeFileSync(join(run, name), `${adwId}-${index}\n`)
        git(run, 'add', '--', name)
        git(run, 'commit', '-q', '-m', `${adwId}-${index}`)
      }
      const crewDir = join(root, `crew-${serial}`)
      mkdirSync(crewDir, { recursive: true })
      writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({ checkout: run, base }))
      return { adwId, run, crewDir, base }
    },
    refs() {
      const output = git(host, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/factory/')
      return output ? output.split('\n').sort() : []
    },
    ref(adwId) {
      const result = gitResult(host, 'rev-parse', '--verify', '--quiet', `refs/factory/${adwId}`)
      return result.status === 0 ? result.stdout.trim() : null
    },
    done() { rmSync(root, { recursive: true, force: true }) },
  }
  return world
}

function withWorld(fn) {
  const world = makeWorld()
  try { return fn(world) } finally { world.done() }
}

function recordingSpawner(world, { failOnIndex = null, onCall = null } = {}) {
  const calls = []
  const spawn = (input = {}) => {
    calls.push(input)
    if (onCall) onCall(input, calls.length)
    if (failOnIndex !== null && calls.length === failOnIndex) {
      return { ok: false, reason: 'spawn-failed', message: 'injected spawner failure' }
    }
    const crewDir = join(world.root, `spawned-crew-${calls.length}`)
    mkdirSync(crewDir, { recursive: true })
    writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({
      checkout: input.checkout, base: world.pin,
    }))
    const adwId = `1111111${calls.length}-2222-3333-4444-55555555555${calls.length}`
    return { ok: true, adwId, crewDir }
  }
  return { spawn, calls }
}

function manifestLines(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => line.trim())
}

function add(world, arm, { axes = {}, pin = world.pin, setId = 'set-a' } = {}) {
  return appendArm({
    manifestPath: world.manifest,
    setId,
    adwId: arm.adwId,
    axes,
    pin,
    crewDir: arm.crewDir,
    checkout: null,
  })
}

function assertAppendOk(result) {
  assert.equal(result.ok, true, JSON.stringify(result))
  return result.arm
}

const expectedAppendReasons = [
  'set-id-invalid', 'adw-id-invalid', 'axes-invalid', 'axis-unknown',
  'pin-missing', 'crew-dir-missing', 'duplicate-arm', 'write-failed',
]
const expectedSetReasons = [
  'manifest-missing', 'manifest-empty', 'manifest-unreadable',
  'set-id-mismatch', 'duplicate-arm', 'pin-unresolved', 'pin-drift',
  'pin-mismatch',
]

test('arm vocabularies are frozen and have the documented values', () => {
  assert.equal(Object.isFrozen(ARM_AXES), true)
  assert.equal(Object.isFrozen(ARM_APPEND_REASONS), true)
  assert.equal(Object.isFrozen(ARM_SET_STATUSES), true)
  assert.equal(Object.isFrozen(ARM_SET_REASONS), true)
  assert.deepEqual(ARM_AXES, ['prompt', 'roster', 'model'])
  assert.deepEqual(ARM_APPEND_REASONS, expectedAppendReasons)
  assert.deepEqual(ARM_SET_STATUSES, { COLLECTED: 'collected', REFUSED: 'refused' })
  assert.deepEqual(ARM_SET_REASONS, expectedSetReasons)
})

test('spawn vocabularies are frozen and the cap bounds the default', () => {
  assert.equal(Object.isFrozen(ARM_SPAWN_STATUSES), true)
  assert.equal(Object.isFrozen(ARM_SPAWN_REASONS), true)
  assert.deepEqual(ARM_SPAWN_STATUSES, { SPAWNED: 'spawned', PARTIAL: 'partial', REFUSED: 'refused' })
  assert.deepEqual(ARM_SPAWN_REASONS, [
    'set-id-invalid', 'n-invalid', 'n-over-cap', 'repo-missing',
    'worktree-root-missing', 'worktree-exists', 'manifest-path-invalid',
    'axes-invalid', 'axis-unknown', 'pin-unresolved', 'worktree-failed',
    'arm-pin-mismatch', 'spawn-failed', 'spawn-id-missing', 'append-failed',
  ])
  assert.ok(ARM_SPAWN_DEFAULT_N >= 1)
  assert.ok(ARM_SPAWN_DEFAULT_N <= ARM_SPAWN_MAX_N)
})

test('spawnArmSet creates distinct branch worktrees at one pin', () => withWorld((world) => {
  const worktreeRoot = join(world.root, 'worktrees')
  const { spawn, calls } = recordingSpawner(world)
  const result = spawnArmSet({
    repo: world.host,
    worktreeRoot,
    manifestPath: world.manifest,
    setId: 'set-a',
    pin: world.pin,
    n: 2,
    brief: join(world.root, 'brief.md'),
    tier: 'test',
    spawn,
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.status, 'spawned')
  assert.equal(result.count, 2)
  assert.equal(calls.length, 2)
  assert.equal(result.pin, world.pin)
  const listed = git(world.host, 'worktree', 'list')
  for (const [offset, arm] of result.arms.entries()) {
    assert.equal(arm.index, offset + 1)
    assert.equal(existsSync(arm.checkout), true)
    assert.equal(git(arm.checkout, 'rev-parse', 'HEAD'), world.pin)
    assert.equal(git(arm.checkout, 'branch', '--show-current'), `arms/set-a/${String(offset + 1).padStart(2, '0')}`)
    assert.ok(listed.includes(arm.checkout), `${arm.checkout} not in worktree list`)
  }
  assert.equal(manifestLines(world.manifest).length, 2)
}))

test('spawnArmSet appends each arm before invoking the next spawner call', () => withWorld((world) => {
  const observed = []
  const { spawn } = recordingSpawner(world, {
    onCall: () => { observed.push(manifestLines(world.manifest).length) },
  })
  const result = spawnArmSet({
    repo: world.host, worktreeRoot: join(world.root, 'worktrees'),
    manifestPath: world.manifest, setId: 'set-a', pin: world.pin, n: 2, spawn,
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(observed, [0, 1])
  assert.equal(manifestLines(world.manifest).length, 2)
}))

test('spawnArmSet output remains collectable after work in both worktrees', () => withWorld((world) => {
  const { spawn } = recordingSpawner(world)
  const result = spawnArmSet({
    repo: world.host, worktreeRoot: join(world.root, 'worktrees'),
    manifestPath: world.manifest, setId: 'set-a', pin: world.pin, n: 2, spawn,
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  for (const arm of result.arms) {
    const file = join(arm.checkout, `${arm.adw_id}.txt`)
    writeFileSync(file, 'work\n')
    git(arm.checkout, 'add', '--', file)
    git(arm.checkout, 'commit', '-q', '-m', 'arm work')
  }
  const report = collectArms({ manifestPath: world.manifest, repo: world.host })
  assert.equal(report.ok, true, JSON.stringify(report))
  assert.equal(report.counts.created, 2)
  assert.equal(report.pin, world.pin)
}))

test('spawnArmSet rejects over-cap before creating paths or calling the spawner', () => withWorld((world) => {
  let calls = 0
  const worktreeRoot = join(world.root, 'worktrees')
  const result = spawnArmSet({
    repo: world.host, worktreeRoot, manifestPath: world.manifest,
    setId: 'set-a', pin: world.pin, n: ARM_SPAWN_MAX_N + 1,
    spawn: () => { calls += 1; return { ok: true } },
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 'refused')
  assert.equal(result.reason, 'n-over-cap')
  assert.match(result.message, /n.*cap/)
  assert.equal(calls, 0)
  assert.equal(existsSync(world.manifest), false)
  assert.equal(existsSync(worktreeRoot), false)
}))

test('spawnArmSet detects a worktree that lands off the shared pin', () => withWorld((world) => {
  const { spawn } = recordingSpawner(world)
  const rigged = (command, args, options) => {
    const argv = [...args]
    if (command === 'git' && argv.includes('worktree') && argv.includes('add')) {
      const pinIndex = argv.indexOf(world.pin)
      if (pinIndex >= 0) argv[pinIndex] = world.other
    }
    return cpSpawnSync(command, argv, options)
  }
  const result = spawnArmSet({
    repo: world.host, worktreeRoot: join(world.root, 'worktrees'),
    manifestPath: world.manifest, setId: 'set-a', pin: world.pin, n: 1,
    spawn, deps: { spawnSync: rigged },
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 'partial')
  assert.equal(result.failed.reason, 'arm-pin-mismatch')
  assert.match(JSON.stringify(result), new RegExp(`${world.pin}.*${world.other}|${world.other}.*${world.pin}`))
}))

test('spawnArmSet keeps both worktrees when the second spawner call fails', () => withWorld((world) => {
  const worktreeRoot = join(world.root, 'worktrees')
  const { spawn, calls } = recordingSpawner(world, { failOnIndex: 2 })
  const result = spawnArmSet({
    repo: world.host, worktreeRoot, manifestPath: world.manifest,
    setId: 'set-a', pin: world.pin, n: 2, spawn,
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 'partial')
  assert.equal(result.failed.index, 2)
  assert.equal(result.failed.phase, 'spawn')
  assert.equal(result.failed.reason, 'spawn-failed')
  assert.equal(calls.length, 2)
  assert.equal(result.arms.length, 1)
  assert.equal(manifestLines(world.manifest).length, 1)
  assert.equal(existsSync(join(worktreeRoot, 'set-a-arm01')), true)
  assert.equal(existsSync(join(worktreeRoot, 'set-a-arm02')), true)
}))

test('spawn axes reject unknown values and factoryctl refuses model without a child', () => withWorld((world) => {
  let calls = 0
  const worktreeRoot = join(world.root, 'worktrees')
  const result = spawnArmSet({
    repo: world.host, worktreeRoot, manifestPath: world.manifest,
    setId: 'set-a', pin: world.pin, n: 1,
    arms: [{ axes: { temperature: 'hot' } }],
    spawn: () => { calls += 1; return { ok: true } },
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 'refused')
  assert.equal(result.reason, 'axis-unknown')
  assert.equal(calls, 0)
  assert.equal(existsSync(world.manifest), false)
  assert.equal(existsSync(worktreeRoot), false)

  let childCalls = 0
  const model = factoryctlSpawner({
    axes: { model: 'opus' },
    deps: { spawnSync: () => { childCalls += 1; throw new Error('should not shell') } },
  })
  assert.equal(model.ok, false)
  assert.equal(model.reason, 'axis-unsupported')
  assert.equal(childCalls, 0)
}))

test('spawnArmSet sends all git commands through the injected seam', () => withWorld((world) => {
  const seen = []
  const { spawn } = recordingSpawner(world)
  const spawnSync = (command, args, options) => {
    seen.push([command, ...args])
    return cpSpawnSync(command, args, options)
  }
  const result = spawnArmSet({
    repo: world.host, worktreeRoot: join(world.root, 'worktrees'),
    manifestPath: world.manifest, setId: 'set-a', pin: world.pin, n: 2,
    spawn, deps: { spawnSync },
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok(seen.length >= 5)
  assert.ok(seen.every((argv) => argv[0] === 'git'))
  assert.ok(seen.every((argv) => !['push', 'remove', 'prune'].some((word) => argv.includes(word))))
}))

test('armsManifestPath composes the factory convention and rejects invalid set ids', () => {
  assert.equal(armsManifestPath({ factoryRoot: '/tmp/factory', setId: 'set.a-1' }), '/tmp/factory/arms/set.a-1.jsonl')
  assert.equal(armsManifestPath({ factoryRoot: '/tmp/factory', setId: 'bad id' }), null)
  assert.equal(armsManifestPath({ factoryRoot: '/tmp/factory', setId: '' }), null)
})

test('two arms append one at a time and read back in append order', () => withWorld((world) => {
  const a = world.arm(ID_A)
  const b = world.arm(ID_B)
  assertAppendOk(add(world, a, { axes: { prompt: 'p1', model: 'opus' } }))
  assertAppendOk(add(world, b, { axes: { roster: 'r2' }, pin: world.pin }))

  const script = `import { readManifest } from ${JSON.stringify(new URL('./arms.mjs', import.meta.url).href)}
process.stdout.write(JSON.stringify(readManifest({ manifestPath: ${JSON.stringify(world.manifest)} })))`
  const child = cpSpawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  const result = JSON.parse(child.stdout)
  assert.equal(result.ok, true)
  assert.equal(result.setId, 'set-a')
  assert.equal(result.skipped, 0)
  assert.deepEqual(result.arms.map((arm) => arm.adw_id), [ID_A, ID_B])
  assert.deepEqual(result.arms.map((arm) => arm.axes), [{ prompt: 'p1', model: 'opus' }, { roster: 'r2' }])
  assert.deepEqual(result.arms.map((arm) => arm.pin), [world.pin, world.pin])
}))

test('a torn trailing JSONL line is skipped without losing earlier arms', () => withWorld((world) => {
  const a = world.arm(ID_A)
  assertAppendOk(add(world, a))
  appendFileSync(world.manifest, '{"kind":"arm","set_id":"set-a"')
  const result = readManifest({ manifestPath: world.manifest })
  assert.equal(result.ok, true)
  assert.equal(result.arms.length, 1)
  assert.equal(result.arms[0].adw_id, ID_A)
  assert.equal(result.skipped, 1)
}))

test('append separates a recovered torn tail and later arms remain readable', () => withWorld((world) => {
  const a = world.arm(ID_A)
  const b = world.arm(ID_B)
  const c = world.arm(ID_C)
  assertAppendOk(add(world, a))
  appendFileSync(world.manifest, '{')
  assertAppendOk(add(world, b))
  assertAppendOk(add(world, c))
  const result = readManifest({ manifestPath: world.manifest })
  assert.equal(result.ok, true)
  assert.equal(result.skipped, 1)
  assert.deepEqual(result.arms.map((arm) => arm.adw_id), [ID_A, ID_B, ID_C])
}))

test('an unknown axis refuses before writing a line', () => withWorld((world) => {
  const a = world.arm(ID_A)
  const result = add(world, a, { axes: { temperature: 'hot' } })
  assert.deepEqual(result, { ok: false, reason: 'axis-unknown' })
  assert.equal(existsSync(world.manifest), false)
}))

test('invalid axes, pins, and crew directories return named append refusals', () => withWorld((world) => {
  const a = world.arm(ID_A)
  assert.deepEqual(add(world, a, { axes: null }), { ok: false, reason: 'axes-invalid' })
  assert.deepEqual(add(world, a, { pin: '' }), { ok: false, reason: 'pin-missing' })
  assert.deepEqual(appendArm({
    manifestPath: world.manifest, setId: 'set-a', adwId: ID_A,
    axes: {}, pin: world.pin, crewDir: join(world.root, 'missing'),
  }), { ok: false, reason: 'crew-dir-missing' })
  assert.deepEqual(appendArm({
    manifestPath: world.manifest, setId: 'bad id', adwId: ID_A,
    axes: {}, pin: world.pin, crewDir: a.crewDir,
  }), { ok: false, reason: 'set-id-invalid' })
  assert.deepEqual(appendArm({
    manifestPath: world.manifest, setId: 'set-a', adwId: 'bad id',
    axes: {}, pin: world.pin, crewDir: a.crewDir,
  }), { ok: false, reason: 'adw-id-invalid' })
}))

test('a duplicate adw_id refuses and leaves the manifest byte-identical', () => withWorld((world) => {
  const a = world.arm(ID_A)
  assertAppendOk(add(world, a, { axes: { model: 'opus' } }))
  const before = readFileSync(world.manifest, 'utf8')
  const result = add(world, a, { axes: { model: 'sonnet' } })
  assert.deepEqual(result, { ok: false, reason: 'duplicate-arm' })
  assert.equal(readFileSync(world.manifest, 'utf8'), before)
}))

test('collectArms harvests every arm into descended factory refs', () => withWorld((world) => {
  const a = world.arm(ID_A)
  const b = world.arm(ID_B)
  assertAppendOk(add(world, a, { axes: { model: 'opus' } }))
  assertAppendOk(add(world, b, { axes: { model: 'sonnet' } }))
  const report = collectArms({ manifestPath: world.manifest, repo: world.host })
  assert.equal(report.ok, true)
  assert.equal(report.status, 'collected')
  assert.equal(report.counts.created, 2)
  for (const id of [ID_A, ID_B]) {
    assert.ok(world.ref(id))
    assert.equal(gitResult(world.host, 'merge-base', '--is-ancestor', world.pin, `refs/factory/${id}`).status, 0)
  }
}))

test('a mixed-pin manifest refuses the whole set before writing refs', () => withWorld((world) => {
  const a = world.arm(ID_A)
  writeFileSync(join(world.host, 'drift.txt'), 'drift\n')
  git(world.host, 'add', 'drift.txt')
  git(world.host, 'commit', '-q', '-m', 'drift')
  const otherPin = git(world.host, 'rev-parse', 'HEAD')
  const b = world.arm(ID_B, { base: otherPin })
  assertAppendOk(add(world, a, { pin: world.pin }))
  assertAppendOk(add(world, b, { pin: otherPin }))
  const report = collectArms({ manifestPath: world.manifest, repo: world.host })
  assert.equal(report.ok, false)
  assert.equal(report.status, 'refused')
  assert.equal(report.reason, 'pin-mismatch')
  assert.match(JSON.stringify(report), new RegExp(`${world.pin}.*${otherPin}|${otherPin}.*${world.pin}`))
  assert.deepEqual(world.refs(), [])
}))

test('a manifest pin that drifts from crew.json base is refused without a ref', () => withWorld((world) => {
  const a = world.arm(ID_A)
  writeFileSync(join(world.host, 'drift.txt'), 'drift\n')
  git(world.host, 'add', 'drift.txt')
  git(world.host, 'commit', '-q', '-m', 'drift')
  const otherPin = git(world.host, 'rev-parse', 'HEAD')
  writeFileSync(join(a.crewDir, 'crew.json'), JSON.stringify({ checkout: a.run, base: otherPin }))
  assertAppendOk(add(world, a, { pin: world.pin }))
  const report = collectArms({ manifestPath: world.manifest, repo: world.host })
  assert.equal(report.ok, false)
  assert.equal(report.status, 'refused')
  assert.equal(report.reason, 'pin-drift')
  assert.match(JSON.stringify(report), new RegExp(`${world.pin}.*${otherPin}|${otherPin}.*${world.pin}`))
  assert.deepEqual(world.refs(), [])
}))

test('a malformed crew.json is treated like an absent crew.json', () => withWorld((world) => {
  const a = world.arm(ID_A)
  assertAppendOk(add(world, a))
  unlinkSync(join(a.crewDir, 'crew.json'))
  const absent = collectArms({ manifestPath: world.manifest, repo: world.host })
  writeFileSync(join(a.crewDir, 'crew.json'), '{not json')
  const malformed = collectArms({ manifestPath: world.manifest, repo: world.host })
  assert.deepEqual(malformed, absent)
}))

test('collectArms probes crew.json exactly once and preserves pin drift refusal', () => withWorld((world) => {
  const a = world.arm(ID_A)
  writeFileSync(join(world.host, 'drift.txt'), 'drift\n')
  git(world.host, 'add', 'drift.txt')
  git(world.host, 'commit', '-q', '-m', 'drift')
  const otherPin = git(world.host, 'rev-parse', 'HEAD')
  writeFileSync(join(a.crewDir, 'crew.json'), JSON.stringify({ checkout: a.run, base: otherPin }))
  assertAppendOk(add(world, a, { pin: world.pin }))
  const target = join(a.crewDir, 'crew.json')
  let probes = 0
  const result = collectArms({
    manifestPath: world.manifest,
    repo: world.host,
    deps: { existsSync(path) {
      if (String(path) === target) probes += 1
      return existsSync(path)
    } },
  })
  assert.equal(probes, 1)
  assert.equal(result.reason, 'pin-drift')
}))

test('an empty arm is collected while a sibling still creates its ref', () => withWorld((world) => {
  const a = world.arm(ID_A)
  const b = world.arm(ID_B, { commits: 0 })
  assertAppendOk(add(world, a))
  assertAppendOk(add(world, b))
  const report = collectArms({ manifestPath: world.manifest, repo: world.host })
  const empty = report.arms.find((arm) => arm.adw_id === ID_B)
  assert.equal(report.ok, true)
  assert.equal(report.status, 'collected')
  assert.equal(empty.harvest.status, 'empty')
  assert.equal(empty.harvest.ref, null)
  assert.equal(report.counts.empty, 1)
  assert.equal(report.counts.refused, 0)
  assert.ok(world.ref(ID_A))
  assert.equal(world.ref(ID_B), null)
}))

test('a non-descendant arm is reported as an arm refusal', () => withWorld((world) => {
  const orphan = join(world.root, 'orphan')
  mkdirSync(orphan)
  git(orphan, 'init', '-q', '-b', 'orphan')
  writeFileSync(join(orphan, 'orphan.txt'), 'orphan\n')
  git(orphan, 'add', 'orphan.txt')
  git(orphan, 'commit', '-q', '-m', 'orphan')
  git(orphan, 'fetch', '-q', '--no-tags', world.host, `${world.pin}:refs/pins/base`)
  const crewDir = join(world.root, 'crew-orphan')
  mkdirSync(crewDir)
  writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({ checkout: orphan, base: world.pin }))
  const a = { adwId: '33333333-4444-5555-6666-777777777777', crewDir }
  assertAppendOk(appendArm({
    manifestPath: world.manifest, setId: 'set-a', adwId: a.adwId,
    axes: {}, pin: world.pin, crewDir,
  }))
  const report = collectArms({ manifestPath: world.manifest, repo: world.host })
  assert.equal(report.ok, true)
  assert.equal(report.status, 'collected')
  assert.equal(report.counts.refused, 1)
  assert.deepEqual(report.refused_arms, [a.adwId])
  assert.equal(report.arms[0].harvest.reason, 'not-descendant')
  assert.equal(world.ref(a.adwId), null)
}))

test('collectArms is idempotent and repeat statuses are unchanged', () => withWorld((world) => {
  const a = world.arm(ID_A)
  const b = world.arm(ID_B, { commits: 0 })
  assertAppendOk(add(world, a))
  assertAppendOk(add(world, b))
  const first = collectArms({ manifestPath: world.manifest, repo: world.host })
  const before = world.refs()
  const second = collectArms({ manifestPath: world.manifest, repo: world.host })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(second.counts.unchanged, 1)
  assert.equal(second.counts.empty, 1)
  assert.deepEqual(world.refs(), before)
}))

test('cost is absent without a ledger and measured when usage is supplied', () => withWorld((world) => {
  const a = world.arm(ID_A)
  assertAppendOk(add(world, a))
  const without = collectArms({ manifestPath: world.manifest, repo: world.host })
  assert.equal(without.arms[0].cost, 'absent')
  assert.equal(typeof without.arms[0].cost_absent, 'string')
  const ledger = {
    taskReadout() {
      return {
        degraded: false,
        adw_id: ID_A,
        usage: {
          agent_sessions: 3,
          billed_input_tokens: 11,
          billed_output_tokens: 22,
          billed_cache_write_tokens: 33,
          billed_cache_read_tokens: 44,
        },
        absent: {},
      }
    },
  }
  const withLedger = collectArms({ manifestPath: world.manifest, repo: world.host, deps: { ledger } })
  assert.deepEqual(withLedger.arms[0].cost, ledger.taskReadout().usage)
  const absent = collectArms({
    manifestPath: world.manifest,
    repo: world.host,
    deps: { ledger: { taskReadout: () => ({ degraded: false, adw_id: ID_A, usage: null, absent: { usage: 'not recorded' } }) } },
  })
  assert.equal(absent.arms[0].cost, 'absent')
  assert.equal(absent.arms[0].cost_absent, 'not recorded')
}))

test('collectArms resolves linked usage and refuses an unlinked task_slug guess', () => withWorld((world) => {
  const linked = world.arm(ID_A)
  const guessed = world.arm(ID_B)
  assertAppendOk(add(world, linked))
  assertAppendOk(add(world, guessed))

  const dbPath = join(world.root, 'ledger', 'ledger.db')
  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  try {
    if (ledger.degraded) return
    ledger.startSession({ adw_id: ID_A, repo_slug: 'repo', task_slug: 'linked-arm' })
    ledger.linkRun({ run_id: 'daemon-arm-A', adw_id: ID_A, crew_dir: linked.crewDir })
    ledger.startAgentSession({
      adw_id: ID_A, dispatch_id: 'dispatch-arm-A', role: 'builder', model: 'sonnet',
      claude_session_id: 'session-arm-A', transcript_path: '/tmp/session-arm-A.jsonl',
    })
    ledger.endAgentSession({
      adw_id: ID_A, claude_session_id: 'session-arm-A', context_tokens: 100, context_window: 200000,
      raw_read_tokens: 10, raw_written_tokens: 20, billed_input_tokens: 11, billed_output_tokens: 22,
      billed_cache_write_tokens: 33, billed_cache_read_tokens: 44,
    })
    ledger.startSession({ adw_id: 'session-for-slug-guess', repo_slug: 'repo', task_slug: ID_B })

    const report = collectArms({ manifestPath: world.manifest, repo: world.host, deps: { ledger } })
    assert.equal(report.ok, true, JSON.stringify(report))
    const measured = report.arms.find((arm) => arm.adw_id === ID_A)
    assert.deepEqual(measured.cost, {
      agent_sessions: 1, billed_input_tokens: 11, billed_output_tokens: 22,
      billed_cache_write_tokens: 33, billed_cache_read_tokens: 44,
    })
    const guessedArm = report.arms.find((arm) => arm.adw_id === ID_B)
    assert.equal(guessedArm.cost, 'absent')
    assert.match(guessedArm.cost_absent, /task_slug match is not a run identity/)
  } finally { ledger.close() }
}))

test('all collection git commands use the injected spawnSync seam', () => withWorld((world) => {
  const a = world.arm(ID_A)
  assertAppendOk(add(world, a))
  const seen = []
  const spawn = (command, args, options) => {
    seen.push([command, ...args])
    return cpSpawnSync(command, args, options)
  }
  const report = collectArms({ manifestPath: world.manifest, repo: world.host, deps: { spawnSync: spawn } })
  assert.equal(report.ok, true)
  assert.ok(seen.length > 0)
  assert.ok(seen.every((argv) => argv[0] === 'git'))
}))

test('missing and empty manifests are named refusals and never throw', () => withWorld((world) => {
  const missing = readManifest({ manifestPath: join(world.root, 'missing.jsonl') })
  assert.deepEqual(missing, { ok: false, reason: 'manifest-missing' })
  mkdirSync(dirname(world.manifest), { recursive: true })
  writeFileSync(world.manifest, '')
  const empty = readManifest({ manifestPath: world.manifest })
  assert.deepEqual(empty, { ok: false, reason: 'manifest-empty' })
  const collected = collectArms({ manifestPath: join(world.root, 'missing.jsonl'), repo: world.host })
  assert.equal(collected.ok, false)
  assert.equal(collected.status, 'refused')
  assert.equal(collected.reason, 'manifest-missing')
}))

test('the collection source has no push invocation', () => {
  const source = readFileSync(new URL('./arms.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /['"`]push['"`]|git\s+push/)
})
