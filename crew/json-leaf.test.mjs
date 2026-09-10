import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

test('B1 recovered assignment lookup reads the superseding envelope', () => {
  const dir = scratchDir('json-leaf-recovered-')
  const canonical = join(dir, 'canonical.json')
  const successor = join(dir, 'd1.reask.builder.json')
  const journal = join(dir, 'journal.jsonl')
  const canonicalRaw = '{"assignment_id":"d1","role":"builder","status":"done","summary":"bad\nline"}'
  const successorRaw = '{"assignment_id":"d1","role":"builder","status":"done","summary":"recovered"}'
  writeFileSync(canonical, canonicalRaw)
  writeFileSync(successor, successorRaw)
  writeFileSync(journal, `${JSON.stringify({
    event: 'envelope-reask', outcome: 'recovered', unusable_return_path: canonical, superseding_return_path: successor,
  })}\n`)

  assert.deepEqual(readJsonAt(canonical), { state: JSON_STATES.UNREADABLE, raw: canonicalRaw, value: null })
  assert.deepEqual(readJsonAt(canonical, { journalPath: journal }), {
    state: JSON_STATES.VALUE, raw: successorRaw, value: { assignment_id: 'd1', role: 'builder', status: 'done', summary: 'recovered' },
  })
})

test('E1 ordinary assignment lookup is unchanged', () => {
  const dir = scratchDir('json-leaf-fallback-')
  const canonical = join(dir, 'canonical.json')
  const unreadable = join(dir, 'unreadable-journal')
  const empty = join(dir, 'empty-journal.jsonl')
  const malformed = join(dir, 'malformed-journal.jsonl')
  const unrelated = join(dir, 'unrelated-journal.jsonl')
  const nonRecovered = join(dir, 'non-recovered-journal.jsonl')
  const canonicalRaw = '{"assignment_id":"d1","role":"builder","status":"done","summary":"ordinary"}'
  const expected = { state: JSON_STATES.VALUE, raw: canonicalRaw, value: { assignment_id: 'd1', role: 'builder', status: 'done', summary: 'ordinary' } }
  writeFileSync(canonical, canonicalRaw)
  mkdirSync(unreadable)
  writeFileSync(empty, '')
  writeFileSync(malformed, '{not a journal row\n')
  writeFileSync(unrelated, `${JSON.stringify({
    event: 'envelope-reask', outcome: 'recovered', unusable_return_path: join(dir, 'other.json'), superseding_return_path: join(dir, 'fabricated.json'),
  })}\n`)
  writeFileSync(nonRecovered, `${JSON.stringify({
    event: 'envelope-reask', outcome: 'failed', unusable_return_path: canonical, superseding_return_path: join(dir, 'fabricated.json'),
  })}\n`)

  const scenarios = [
    {},
    { journalPath: unreadable },
    { journalPath: empty },
    { journalPath: malformed },
    { journalPath: unrelated },
    { journalPath: nonRecovered },
  ]
  for (const deps of scenarios) {
    let result
    assert.doesNotThrow(() => { result = readJsonAt(canonical, deps) })
    assert.deepEqual(result, expected)
  }
})

test('F1 assignment lookup never authors either envelope', () => {
  const dir = scratchDir('json-leaf-read-only-')
  const canonical = join(dir, 'canonical.json')
  const successor = join(dir, 'd1.reask.builder.json')
  const journal = join(dir, 'journal.jsonl')
  const canonicalRaw = '{"assignment_id":"d1","role":"builder","status":"done","summary":"bad\nline"}'
  const successorRaw = '{"assignment_id":"d1","role":"builder","status":"done","summary":"recovered"}'
  const journalRaw = `${JSON.stringify({
    event: 'envelope-reask', outcome: 'recovered', unusable_return_path: canonical, superseding_return_path: successor,
  })}\n`
  writeFileSync(canonical, canonicalRaw)
  writeFileSync(successor, successorRaw)
  writeFileSync(journal, journalRaw)
  const before = [canonical, successor, journal].map((path) => readFileSync(path))

  const result = readJsonAt(canonical, { journalPath: journal })
  const after = [canonical, successor, journal].map((path) => readFileSync(path))

  assert.equal(result.state, JSON_STATES.VALUE)
  assert.equal(result.raw, successorRaw)
  assert.deepEqual(after, before)
})
