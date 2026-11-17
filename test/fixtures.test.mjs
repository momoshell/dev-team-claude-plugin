import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { basename } from 'node:path'
import { assertSlugStable, testCheckout } from './fixtures.mjs'

test('assertSlugStable rejects a mixed-case fixture basename', () => {
  assert.throws(() => assertSlugStable('Checkout-MixedCASE-FJdRQ1'), /Checkout-MixedCASE-FJdRQ1/)
})

test('testCheckout creates a slug-stable checkout for mixed-case prefixes', () => {
  let fixture
  try {
    assert.doesNotThrow(() => { fixture = testCheckout('Checkout-MixedCASE-') })
    assert.ok(fixture)
    assert.equal(basename(fixture.checkout), 'checkout')
  } finally {
    if (fixture) rmSync(fixture.root, { recursive: true, force: true })
  }
})
