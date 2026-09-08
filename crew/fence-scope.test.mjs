import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fenceScopeContains, fenceScopesIntersect, parseFenceScope, validateFenceScope } from './fence-scope.mjs'

test('A1 fencescope parser distinguishes a span from a whole file', () => {
  const file = parseFenceScope('src/widget.mjs')
  const span = parseFenceScope('src/widget.mjs:10-12')
  assert.deepEqual(file, { kind: 'file', entry: 'src/widget.mjs', path: 'src/widget.mjs' })
  assert.deepEqual(span, { kind: 'span', entry: 'src/widget.mjs:10-12', path: 'src/widget.mjs', start: 10, end: 12 })
  assert.notEqual(file.kind, span.kind)
  assert.ok(Object.isFrozen(file))
  assert.ok(Object.isFrozen(span))
})

test('B1a fencescope intersection includes a shared boundary', () => {
  const left = parseFenceScope('src/widget.mjs:10-12')
  const right = parseFenceScope('src/widget.mjs:12-15')
  assert.equal(fenceScopesIntersect(left, right), true)
  assert.equal(fenceScopeContains(left, { kind: 'span', path: 'src/widget.mjs', start: 10, end: 12 }), true)
})

test('B1b fencescope intersection rejects disjoint spans', () => {
  assert.equal(fenceScopesIntersect(parseFenceScope('src/widget.mjs:10-12'), parseFenceScope('src/widget.mjs:13-15')), false)
  assert.equal(fenceScopesIntersect(parseFenceScope('src/widget.mjs:10-12'), parseFenceScope('other.mjs:10-12')), false)
})

test('C1a fence scope leaf is import free', () => {
  const source = readFileSync(new URL('./fence-scope.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /^\s*(?:import\s|export\s+[^\n]*\sfrom\s)/m)
  assert.doesNotMatch(source, /\bimport\s*\(/)
})

test('fencescope invalid path and syntax cases fail closed', () => {
  for (const entry of ['', 'src/*.mjs', '/src/widget.mjs', './src/widget.mjs', 'src/../widget.mjs', 'src/widget.mjs:0-2', 'src/widget.mjs:-1-2', 'src/widget.mjs:1-2-3', 'src/widget.mjs:1:2']) {
    assert.equal(parseFenceScope(entry).kind, 'invalid', entry)
  }
  assert.equal(parseFenceScope('src/widget.mjs:01-2').kind, 'invalid')
  assert.equal(parseFenceScope('src/widget.mjs:+1-2').kind, 'invalid')
})

test('validateFenceScope rejects reversed, unreadable, and past-EOF spans', () => {
  const valid = validateFenceScope('src/widget.mjs:2-4', 4)
  assert.equal(valid.reason, undefined)
  assert.equal(validateFenceScope('src/widget.mjs:4-2', 4).reason, 'span start 4 is after end 2')
  assert.equal(validateFenceScope('src/widget.mjs:2-5', 4).reason, 'span end 5 is past base EOF 4')
  assert.match(validateFenceScope('src/widget.mjs:1-2', null).reason, /line count/)
})
