import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scratchDir } from '../test/helpers.mjs'
import { JSON_STATES, readJsonAt, readJsonTri } from './json-leaf.mjs'

test('absent and falsy paths are absent', () => {
  const dir = scratchDir('json-leaf-absent-')
  const missing = join(dir, 'missing.json')
  assert.equal(readJsonTri(missing), null)
  assert.deepEqual(readJsonAt(missing), { state: JSON_STATES.ABSENT, raw: null, value: null })
  assert.equal(readJsonTri(null), null)
  assert.equal(readJsonAt('').state, JSON_STATES.ABSENT)
})

test('malformed bytes are unreadable and retain their raw bytes', () => {
  const dir = scratchDir('json-leaf-malformed-')
  const path = join(dir, 'bad.json')
  writeFileSync(path, '{not json')
  assert.equal(readJsonTri(path), undefined)
  assert.deepEqual(readJsonAt(path), { state: JSON_STATES.UNREADABLE, raw: '{not json', value: null })
})

test('absent and unreadable are distinct states', () => {
  const dir = scratchDir('json-leaf-distinct-')
  const missing = join(dir, 'missing.json')
  const bad = join(dir, 'bad.json')
  writeFileSync(bad, '{broken')
  assert.notEqual(readJsonAt(missing).state, readJsonAt(bad).state)
  assert.equal(readJsonAt(missing).state, JSON_STATES.ABSENT)
  assert.equal(readJsonAt(bad).state, JSON_STATES.UNREADABLE)
})

test('a directory where a file is expected is unreadable', () => {
  const dir = scratchDir('json-leaf-directory-')
  const path = join(dir, 'as-dir.json')
  mkdirSync(path)
  assert.equal(readJsonTri(path), undefined)
  assert.equal(readJsonAt(path).state, JSON_STATES.UNREADABLE)
  assert.equal(readJsonAt(path).raw, null)
})

test('valid objects and arrays pass without a leaf shape filter', () => {
  const dir = scratchDir('json-leaf-shapes-')
  const objectPath = join(dir, 'object.json')
  const arrayPath = join(dir, 'array.json')
  writeFileSync(objectPath, '{"a":1}')
  writeFileSync(arrayPath, '[1,2,3]')
  assert.deepEqual(readJsonTri(objectPath), { a: 1 })
  assert.deepEqual(readJsonTri(arrayPath), [1, 2, 3])
  assert.equal(readJsonAt(objectPath).state, JSON_STATES.VALUE)
})

test('injected filesystem dependencies are honoured', () => {
  const seen = { exists: 0, read: 0 }
  const path = '/json-leaf/injected.json'
  const result = readJsonAt(path, {
    existsSync: (candidate) => { seen.exists += 1; assert.equal(candidate, path); return true },
    readFileSync: (candidate, encoding) => { seen.read += 1; assert.equal(candidate, path); assert.equal(encoding, 'utf8'); return '{"injected":true}' },
  })
  assert.deepEqual(result, { state: JSON_STATES.VALUE, raw: '{"injected":true}', value: { injected: true } })
  assert.deepEqual(seen, { exists: 1, read: 1 })
})

test('literal null bytes remain a VALUE in readJsonAt', () => {
  const dir = scratchDir('json-leaf-null-')
  const path = join(dir, 'null.json')
  writeFileSync(path, 'null')
  const result = readJsonAt(path)
  assert.equal(result.state, JSON_STATES.VALUE)
  assert.equal(result.raw, 'null')
  assert.equal(result.value, null)
  assert.equal(readJsonTri(path), null)
})
