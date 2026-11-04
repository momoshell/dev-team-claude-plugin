import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { ONBOARD_REASONS, requireOnboarded } from './onboard.mjs'

test('requireOnboarded distinguishes missing and stale project records', () => {
  const suite = 'npm test', proof = []
  const hash = createHash('sha256').update(JSON.stringify([suite, proof])).digest('hex')
  const valid = { suite, proof, onboarded: { hash } }
  assert.deepEqual(ONBOARD_REASONS, ['not-onboarded', 'onboarding-stale'])
  assert.ok(Object.isFrozen(ONBOARD_REASONS))
  assert.deepEqual(requireOnboarded('/repo', () => JSON.stringify(valid)), { suite, proof, hash })
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
