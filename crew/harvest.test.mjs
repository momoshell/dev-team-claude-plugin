import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync as cpSpawnSync } from 'node:child_process'
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  factoryRef, harvestRun, HARVEST_REASONS, HARVEST_STATUSES,
} from './harvest.mjs'

const ID = '11111111-2222-3333-4444-555555555555'

function git(repoDir, ...args) {
  return execFileSync('git', [
    '-c', 'user.email=crew@example.invalid',
    '-c', 'user.name=Crew Test',
    '-c', 'protocol.file.allow=always',
    '-C', repoDir, ...args,
  ], { encoding: 'utf8' })
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
  const root = mkdtempSync(join(tmpdir(), 'crew-harvest-'))
  const host = join(root, 'host')
  mkdirSync(host)
  git(host, 'init', '-q', '-b', 'main')
  writeFileSync(join(host, 'seed.txt'), 'seed\n')
  git(host, 'add', 'seed.txt')
  git(host, 'commit', '-q', '-m', 'base')
  const pin = git(host, 'rev-parse', 'HEAD').trim()
  const run = join(root, 'run')
  git(host, 'worktree', 'add', '-q', run, '-b', 'run-branch')

  return {
    root,
    host,
    run,
    pin,
    commit(message) {
      writeFileSync(join(run, `${message}.txt`), `${message}\n`)
      git(run, 'add', '--', `${message}.txt`)
      git(run, 'commit', '-q', '-m', message)
      return git(run, 'rev-parse', 'HEAD').trim()
    },
    ref(adwId = ID) {
      const result = gitResult(host, 'rev-parse', '--verify', '--quiet', `refs/factory/${adwId}`)
      return result.status === 0 ? result.stdout.trim() : null
    },
    refs() {
      const output = git(host, 'for-each-ref', '--format=%(refname) %(objectname)').trim()
      return output ? output.split('\n').sort() : []
    },
    done() { rmSync(root, { recursive: true, force: true }) },
  }
}

function withWorld(fn) {
  const world = makeWorld()
  try { return fn(world) } finally { world.done() }
}

const expectedReasons = [
  'adw-id-invalid', 'checkout-missing', 'pin-unknown', 'pin-missing',
  'branch-unresolved', 'not-descendant', 'non-fast-forward', 'fetch-failed',
]

const expectedStatuses = {
  CREATED: 'created', UPDATED: 'updated', UNCHANGED: 'unchanged', EMPTY: 'empty',
}

test('factoryRef and the exported vocabularies have the documented frozen shapes', () => {
  assert.equal(factoryRef(ID), `refs/factory/${ID}`)
  assert.equal(Object.isFrozen(HARVEST_REASONS), true)
  assert.equal(Object.isFrozen(HARVEST_STATUSES), true)
  assert.deepEqual(HARVEST_REASONS, expectedReasons)
  assert.deepEqual(HARVEST_STATUSES, expectedStatuses)
})

test('harvest creates a factory ref at the run tip and reports the range size', () => {
  withWorld((world) => {
    world.commit('one')
    const head = world.commit('two')
    const result = harvestRun({ repo: world.host, checkout: world.run, adwId: ID, pin: world.pin })
    assert.equal(result.ok, true)
    assert.equal(result.status, HARVEST_STATUSES.CREATED)
    assert.equal(result.ref, `refs/factory/${ID}`)
    assert.equal(result.commits, 2)
    assert.equal(result.head, head)
    assert.equal(world.ref(), head)
  })
})

test('the fetch source stays pinned to the checked head for a leading-plus branch', () => {
  withWorld((world) => {
    const tree = git(world.host, 'write-tree').trim()
    const unrelated = git(world.host, 'commit-tree', tree, '-m', 'unrelated').trim()
    git(world.host, 'update-ref', 'refs/heads/run', unrelated)
    git(world.run, 'branch', '-m', '+run')
    const head = world.commit('one')
    const result = harvestRun({ repo: world.host, checkout: world.run, adwId: ID, pin: world.pin })
    assert.equal(result.ok, true)
    assert.equal(result.status, HARVEST_STATUSES.CREATED)
    assert.equal(result.head, head)
    assert.equal(world.ref(), head)
    assert.equal(gitResult(world.host, 'merge-base', '--is-ancestor', world.pin, `refs/factory/${ID}`).status, 0)
  })
})

test('a harvested factory ref remains descended from the pin', () => {
  withWorld((world) => {
    world.commit('one')
    harvestRun({ repo: world.host, checkout: world.run, adwId: ID, pin: world.pin })
    const result = gitResult(world.host, 'merge-base', '--is-ancestor', world.pin, `refs/factory/${ID}`)
    assert.equal(result.status, 0)
  })
})

test('an unrelated run history is refused without writing a ref', () => {
  withWorld((world) => {
    git(world.run, 'checkout', '-q', '--orphan', 'unrelated')
    git(world.run, 'rm', '-q', '-rf', '--', '.')
    writeFileSync(join(world.run, 'other.txt'), 'other\n')
    git(world.run, 'add', '--', 'other.txt')
    git(world.run, 'commit', '-q', '-m', 'unrelated root')
    const result = harvestRun({ repo: world.host, checkout: world.run, adwId: ID, pin: world.pin })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'not-descendant')
    assert.equal(world.ref(), null)
  })
})

test('a run with no commits returns empty and writes no ref', () => {
  withWorld((world) => {
    const result = harvestRun({ repo: world.host, checkout: world.run, adwId: ID, pin: world.pin })
    assert.equal(result.ok, true)
    assert.equal(result.status, HARVEST_STATUSES.EMPTY)
    assert.equal(result.ref, null)
    assert.equal(result.commits, 0)
    assert.equal(world.ref(), null)
  })
})

test('a repeat harvest reports unchanged and preserves the ref byte-for-byte', () => {
  withWorld((world) => {
    world.commit('one')
    const first = harvestRun({ repo: world.host, checkout: world.run, adwId: ID, pin: world.pin })
    const before = world.ref()
    const second = harvestRun({ repo: world.host, checkout: world.run, adwId: ID, pin: world.pin })
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.equal(second.status, HARVEST_STATUSES.UNCHANGED)
    assert.equal(world.ref(), before)
  })
})

test('an advanced run updates the ref and keeps the pin as an ancestor', () => {
  withWorld((world) => {
    world.commit('one')
    harvestRun({ repo: world.host, checkout: world.run, adwId: ID, pin: world.pin })
    const head = world.commit('two')
    const result = harvestRun({ repo: world.host, checkout: world.run, adwId: ID, pin: world.pin })
    assert.equal(result.ok, true)
    assert.equal(result.status, HARVEST_STATUSES.UPDATED)
    assert.equal(world.ref(), head)
    assert.equal(gitResult(world.host, 'merge-base', '--is-ancestor', world.pin, `refs/factory/${ID}`).status, 0)
  })
})

test('a rewound and recommitted run is refused as non-fast-forward', () => {
  withWorld((world) => {
    world.commit('one')
    harvestRun({ repo: world.host, checkout: world.run, adwId: ID, pin: world.pin })
    const before = world.ref()
    git(world.run, 'reset', '-q', '--hard', 'HEAD~1')
    world.commit('alternative')
    const result = harvestRun({ repo: world.host, checkout: world.run, adwId: ID, pin: world.pin })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'non-fast-forward')
    assert.equal(world.ref(), before)
  })
})

test('harvest leaves the run checkout unchanged and adds only factory refs', () => {
  withWorld((world) => {
    world.commit('one')
    writeFileSync(join(world.run, 'untracked.txt'), 'dirty\n')
    const beforeHead = git(world.run, 'rev-parse', 'HEAD').trim()
    const beforeBranch = git(world.run, 'symbolic-ref', '--short', 'HEAD').trim()
    const beforeStatus = git(world.run, 'status', '--porcelain', '-uall')
    const beforeRefs = new Set(world.refs())
    const result = harvestRun({ repo: world.host, checkout: world.run, adwId: ID, pin: world.pin })
    assert.equal(result.ok, true)
    assert.equal(git(world.run, 'rev-parse', 'HEAD').trim(), beforeHead)
    assert.equal(git(world.run, 'symbolic-ref', '--short', 'HEAD').trim(), beforeBranch)
    assert.equal(git(world.run, 'status', '--porcelain', '-uall'), beforeStatus)
    const added = world.refs().filter((ref) => !beforeRefs.has(ref))
    assert.equal(added.every((ref) => ref.startsWith('refs/factory/')), true)
  })
})

test('named refusals write no factory refs', () => {
  withWorld((world) => {
    const before = world.refs()
    for (const badId of ['bad id', '', Symbol('bad')]) {
      const result = harvestRun({ repo: world.host, checkout: world.run, adwId: badId, pin: world.pin })
      assert.equal(HARVEST_REASONS.includes(result.reason), true)
      assert.equal(result.reason, 'adw-id-invalid')
      assert.deepEqual(world.refs(), before)
    }

    const checkoutMissing = harvestRun({ repo: world.host, checkout: join(world.root, 'missing'), adwId: ID, pin: world.pin })
    assert.equal(HARVEST_REASONS.includes(checkoutMissing.reason), true)
    assert.equal(checkoutMissing.reason, 'checkout-missing')
    assert.deepEqual(world.refs(), before)

    const pinUnknown = harvestRun({ repo: world.host, checkout: world.run, adwId: ID, pin: null })
    assert.equal(HARVEST_REASONS.includes(pinUnknown.reason), true)
    assert.equal(pinUnknown.reason, 'pin-unknown')
    assert.deepEqual(world.refs(), before)

    const pinMissing = harvestRun({
      repo: world.host,
      checkout: world.run,
      adwId: ID,
      pin: 'ffffffffffffffffffffffffffffffffffffffff',
    })
    assert.equal(HARVEST_REASONS.includes(pinMissing.reason), true)
    assert.equal(pinMissing.reason, 'pin-missing')
    assert.deepEqual(world.refs(), before)

    git(world.run, 'checkout', '-q', '--detach', 'HEAD')
    const branchUnresolved = harvestRun({ repo: world.host, checkout: world.run, adwId: ID, pin: world.pin })
    assert.equal(HARVEST_REASONS.includes(branchUnresolved.reason), true)
    assert.equal(branchUnresolved.reason, 'branch-unresolved')
    assert.deepEqual(world.refs(), before)
  })
})

test('crewDir supplies checkout and then supplies the recorded base pin', () => {
  withWorld((world) => {
    const crewDir = join(world.root, 'crew')
    mkdirSync(crewDir)
    const crewPath = join(crewDir, 'crew.json')
    writeFileSync(crewPath, JSON.stringify({ schema_version: 3, task: 'task', checkout: world.run }))
    world.commit('one')

    const first = harvestRun({ crewDir, repo: world.host, adwId: ID, pin: world.pin })
    assert.equal(first.ok, true)
    assert.equal(first.pin, world.pin)

    writeFileSync(crewPath, JSON.stringify({ schema_version: 3, task: 'task', checkout: world.run, base: world.pin }))
    const second = harvestRun({ crewDir, repo: world.host, adwId: ID })
    assert.equal(second.ok, true)
    assert.equal(second.status, HARVEST_STATUSES.UNCHANGED)
    assert.equal(second.pin, world.pin)
  })
})

test('harvestRun routes every git command through the injected spawnSync seam', () => {
  withWorld((world) => {
    world.commit('one')
    let calls = 0
    const result = harvestRun({
      repo: world.host,
      checkout: world.run,
      adwId: ID,
      pin: world.pin,
      deps: {
        spawnSync(...args) {
          calls += 1
          return cpSpawnSync(...args)
        },
      },
    })
    assert.equal(result.ok, true)
    assert.ok(calls > 0)
  })
})
