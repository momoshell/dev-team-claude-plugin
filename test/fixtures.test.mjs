import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { basename } from 'node:path'
import { slug } from '../crew/crew.mjs'
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
  assert.match(source, /import \{ slug \} from ['"]\.\.\/crew\/crew\.mjs['"]/)
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
