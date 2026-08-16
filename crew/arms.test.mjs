import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync as cpSpawnSync } from 'node:child_process'
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  ARM_APPEND_REASONS, ARM_AXES, ARM_SET_REASONS, ARM_SET_STATUSES,
  armsManifestPath, appendArm, collectArms, readManifest,
} from './arms.mjs'

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
  const manifest = join(root, 'factory', 'arms', 'set-a.jsonl')
  let serial = 0

  const world = {
    root,
    host,
    pin,
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
    deps: { ledger: { taskReadout: () => ({ degraded: false, usage: null, absent: { usage: 'not recorded' } }) } },
  })
  assert.equal(absent.arms[0].cost, 'absent')
  assert.equal(absent.arms[0].cost_absent, 'not recorded')
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
