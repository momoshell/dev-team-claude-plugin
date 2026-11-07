import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ONBOARD_REASONS, OnboardRefusal, checkOnboarding, projectHash, requireOnboarded } from './onboard.mjs'
import { git, scratchDir } from '../test/helpers.mjs'

test('projectHash changes when a proof entry gains a list command', () => {
  const entry = { match: '*.xml', run: 'node run.mjs' }
  const project = { suite: 'npm test', proof: [entry] }
  assert.notEqual(projectHash(project), projectHash({ ...project, proof: [{ ...entry, list: 'node list.mjs' }] }))
})

// MUTATION: hash an absent list as null and every project onboarded before list existed reads stale.
test('projectHash of an entry without list matches the hash recorded before list existed', () => {
  const proof = [{ match: 'crates/**', run: 'sh tools/crew-proof.sh {file} {title} {report}' }, { match: 'ui/**', setup: 'npm ci', run: 'vitest {file}' }]
  const before = createHash('sha256').update(JSON.stringify(['sh tools/crew-suite.sh', proof.map((e) => [e.match, e.setup ?? null, e.run])])).digest('hex')
  assert.equal(projectHash({ suite: 'sh tools/crew-suite.sh', proof }), before)
  assert.doesNotThrow(() => requireOnboarded('/repo', () => JSON.stringify({ suite: 'sh tools/crew-suite.sh', proof, onboarded: { hash: before } })))
})

test('requireOnboarded distinguishes missing and stale project records', () => {
  const suite = 'npm test', proof = []
  const hash = createHash('sha256').update(JSON.stringify([suite, proof])).digest('hex')
  const valid = { suite, proof, onboarded: { hash } }
  assert.deepEqual(ONBOARD_REASONS, ['not-onboarded', 'onboarding-stale'])
  assert.ok(Object.isFrozen(ONBOARD_REASONS))
  assert.deepEqual(requireOnboarded('/repo', () => JSON.stringify(valid)), { suite, proof, hash, suiteTimeoutMs: 1800000, proofTimeoutMs: 120000 })
  for (const [input, reason] of [
    [null, 'not-onboarded'], [{ suite, proof }, 'not-onboarded'],
    ['{', 'onboarding-stale'], [{ ...valid, suite: 'cargo test' }, 'onboarding-stale'],
    [{ ...valid, suite: '"npm test"' }, 'onboarding-stale'], [{ ...valid, proof: null }, 'onboarding-stale'],
    [{ ...valid, onboarded: null }, 'onboarding-stale'],
  ]) {
    const read = () => { if (input === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return typeof input === 'string' ? input : JSON.stringify(input) }
    assert.throws(() => requireOnboarded('/repo', read), (error) => error.reason === reason && error.message.includes('/onboard'))
  }
})

test('requireOnboarded returns a configured suiteTimeoutMs, defaults an absent one to 1800000, and refuses invalid values as onboarding-stale', () => {
  const suite = 'npm test', proof = []
  const hash = createHash('sha256').update(JSON.stringify([suite, proof])).digest('hex')
  const project = { suite, proof, onboarded: { hash } }
  for (const [field, expected] of [[{}, 1800000], [{ suiteTimeoutMs: 1 }, 1], [{ suiteTimeoutMs: 2147483647 }, 2147483647], [{ suiteTimeoutMs: 3600000 }, 3600000]]) {
    assert.deepEqual(requireOnboarded('/repo', () => JSON.stringify({ ...project, ...field })), { suite, proof, hash, suiteTimeoutMs: expected, proofTimeoutMs: 120000 })
  }
  for (const value of [null, 0, -1, 1.5, 2147483648, Number.MAX_SAFE_INTEGER + 1, '1000', true, [], {}]) {
    assert.throws(() => requireOnboarded('/repo', () => JSON.stringify({ ...project, suiteTimeoutMs: value })), (error) => error.reason === 'onboarding-stale')
  }
})

test('requireOnboarded returns a configured proofTimeoutMs, defaults an absent one to 120000, and refuses invalid values as onboarding-stale', () => {
  const suite = 'npm test', proof = []
  const hash = createHash('sha256').update(JSON.stringify([suite, proof])).digest('hex')
  const project = { suite, proof, onboarded: { hash } }
  for (const [field, expected] of [[{}, 120000], [{ proofTimeoutMs: 1 }, 1], [{ proofTimeoutMs: 2147483647 }, 2147483647], [{ proofTimeoutMs: 360000 }, 360000]]) {
    assert.equal(requireOnboarded('/repo', () => JSON.stringify({ ...project, ...field })).proofTimeoutMs, expected)
  }
  for (const value of [null, 0, -1, 1.5, 2147483648, Number.MAX_SAFE_INTEGER + 1, '1000', true, [], {}]) {
    assert.throws(() => requireOnboarded('/repo', () => JSON.stringify({ ...project, proofTimeoutMs: value })), (error) => error instanceof OnboardRefusal && error.reason === 'onboarding-stale')
  }
})

test('checkOnboarding records a configured proofTimeoutMs in project.json and refuses an invalid one without writing it', async () => {
  for (const [field, status] of [[{ proofTimeoutMs: 360000 }, 'green'], [{}, 'green'], [{ proofTimeoutMs: 0 }, 'red']]) {
    const repo = scratchDir('onboard-proof-timeout-')
    git(repo, 'init'); writeFileSync(join(repo, 'initial'), 'initial')
    git(repo, 'add', 'initial'); git(repo, 'commit', '-m', 'initial')
    const draft = join(repo, 'draft.json'), target = join(repo, '.crew', 'project.json')
    writeFileSync(draft, JSON.stringify({ suite: 'npm test', proof: [], ...field }))
    assert.equal((await checkOnboarding({ checkout: repo, draft })).status, status)
    assert.equal(existsSync(target), status === 'green')
    if (status === 'green') {
      const project = JSON.parse(readFileSync(target, 'utf8'))
      assert.equal(Object.hasOwn(project, 'proofTimeoutMs'), Object.hasOwn(field, 'proofTimeoutMs'))
      assert.equal(project.proofTimeoutMs, field.proofTimeoutMs)
      assert.equal(requireOnboarded(repo).proofTimeoutMs, field.proofTimeoutMs ?? 120000)
    }
  }
})

test('checkOnboarding records a configured suiteTimeoutMs in project.json and refuses an invalid one without writing it', async () => {
  for (const [value, status] of [[3600000, 'green'], [0, 'red']]) {
    const repo = scratchDir('onboard-timeout-')
    git(repo, 'init')
    writeFileSync(join(repo, 'initial'), 'initial')
    git(repo, 'add', 'initial')
    git(repo, 'commit', '-m', 'initial')
    const draft = join(repo, 'draft.json'), target = join(repo, '.crew', 'project.json')
    writeFileSync(draft, JSON.stringify({ suite: 'npm test', proof: [], suiteTimeoutMs: value }))
    assert.equal((await checkOnboarding({ checkout: repo, draft })).status, status)
    assert.equal(existsSync(target), status === 'green')
    if (status === 'green') {
      assert.equal(JSON.parse(readFileSync(target, 'utf8')).suiteTimeoutMs, value)
      assert.equal(requireOnboarded(repo).suiteTimeoutMs, value)
    }
  }
})
