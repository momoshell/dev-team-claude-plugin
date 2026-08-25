import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { basename } from 'node:path'
import { slug } from '../crew/slug.mjs'
import { assertSlugStable, testCheckout } from './fixtures.mjs'

test('assertSlugStable rejects a mixed-case fixture basename', () => {
  assert.throws(() => assertSlugStable('Checkout-MixedCASE-FJdRQ1'), /Checkout-MixedCASE-FJdRQ1/)
})

test('assertSlugStable accepts lowercase basenames regardless of their parent', () => {
  assert.doesNotThrow(() => assertSlugStable('checkout'))
  assert.doesNotThrow(() => assertSlugStable('/tmp/Parent-MixedCASE/checkout'))
})

test('fixture guard imports production slug without copying its rule', () => {
  const source = readFileSync(new URL('./fixtures.mjs', import.meta.url), 'utf8')
  assert.match(source, /import \{ slug \} from ['"]\.\.\/crew\/slug\.mjs['"]/)
  assert.doesNotMatch(source, /toLowerCase/)
})

test('testCheckout creates a slug-stable checkout for mixed-case prefixes', () => {
  let fixture
  try {
    assert.doesNotThrow(() => { fixture = testCheckout('Checkout-MixedCASE-') })
    assert.ok(fixture)
    assert.equal(basename(fixture.checkout), 'checkout')
    assert.equal(basename(fixture.checkout), slug(basename(fixture.checkout)))
  } finally {
    if (fixture) rmSync(fixture.root, { recursive: true, force: true })
  }
})

// The #551 duplication audit's null result, pinned rather than left as prose:
// the audit record is at the foot of ./fixtures.mjs. The tripwire in
// test/helpers.test.mjs catches a re-declared helper by NAME, from its own
// fixed list; this catches ANY export of this module that helpers.mjs already
// owns, whether or not that name was on the list when the list was written.
test('the fixture module re-declares nothing test/helpers.mjs already exports', async () => {
  const fixtures = await import('./fixtures.mjs')
  const helpers = await import('./helpers.mjs')
  const overlap = Object.keys(fixtures).filter((name) => name in helpers)
  assert.deepEqual(overlap, [], 'these fixture exports duplicate test/helpers.mjs — import them instead')
})
