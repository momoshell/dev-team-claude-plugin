import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT } from '../../test/helpers.mjs'
import { isDistinctive, lineCarries, MIN_EXPECTED_LENGTH } from '../qa-test-writing/anchor-pin.mjs'

const HERE = fileURLToPath(new URL('./', import.meta.url))
const MANIFEST_OWNER = 'skills/frontend-svelte/anchors.json'
const MANIFEST = join(ROOT, MANIFEST_OWNER)
const FLOOR = { minAnchors: 54 }

// The shipped ANCHOR_PATTERN cannot see .svelte (anchor-pin.mjs:8), so this
// skill parses its own citations: .svelte added, hyphen and en-dash ranges,
// and comma lists. Shape mirrors the acceptance gate's superset parser.
const CITE_RE = /([A-Za-z0-9_.$/-]+\.(?:svelte|mjs|ts|js|json|md|sh|yml)):(\d+)(?:([–-])(\d+))?((?:,\d+)*)/g

function skillDocs() {
  const docs = []
  const skill = join(HERE, 'SKILL.md')
  if (existsSync(skill) && !statSync(skill).isDirectory()) docs.push(skill)
  const refs = join(HERE, 'references')
  if (existsSync(refs) && statSync(refs).isDirectory()) {
    for (const name of readdirSync(refs).sort()) {
      const path = join(refs, name)
      if (name.endsWith('.md') && !statSync(path).isDirectory()) docs.push(path)
    }
  }
  return docs
}

function endpointsOf(match) {
  const [, rel, first, sep, second, commas] = match
  const out = []
  const firstOffset = match.index + rel.length + 1
  out.push({ key: `${rel}:${first}`, rel, line: Number(first), offset: firstOffset, length: first.length })
  let cursor = firstOffset + first.length
  if (second !== undefined) {
    cursor += sep.length
    out.push({ key: `${rel}:${second}`, rel, line: Number(second), offset: cursor, length: second.length })
    cursor += second.length
  }
  if (commas) {
    for (const c of commas.split(',').filter(Boolean)) {
      cursor += 1
      out.push({ key: `${rel}:${c}`, rel, line: Number(c), offset: cursor, length: c.length })
      cursor += c.length
    }
  }
  return out
}

function trackedSet() {
  try {
    const out = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' })
    return { tracked: new Set(out.split('\0').filter(Boolean)) }
  } catch {
    return { failure: 'tracked set is unreadable (git ls-files failed)' }
  }
}

function readLines(rel) {
  try {
    const target = join(ROOT, rel)
    if (!existsSync(target) || statSync(target).isDirectory()) return { failure: `${rel}: target file is missing` }
    return { lines: readFileSync(target, 'utf8').split('\n') }
  } catch {
    return { failure: `${rel}: target could not be read` }
  }
}

function checkSkill() {
  const failures = []
  const shifted = []
  let manifest
  try {
    manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  } catch {
    return { failures: [`could not read anchor manifest ${MANIFEST_OWNER}`], shifted, cited: new Set(), keys: [] }
  }
  const keys = Object.keys(manifest)
  const { tracked, failure: trackedFailure } = trackedSet()
  if (trackedFailure) failures.push(trackedFailure)
  const cited = new Set()
  for (const doc of skillDocs()) {
    let text
    try {
      text = readFileSync(doc, 'utf8')
    } catch {
      failures.push(`${doc}: citation doc could not be read`)
      continue
    }
    CITE_RE.lastIndex = 0
    for (const match of text.matchAll(CITE_RE)) {
      for (const endpoint of endpointsOf(match)) {
        cited.add(endpoint.key)
        if (tracked && !tracked.has(endpoint.rel)) {
          failures.push(`${endpoint.key}: target is not tracked`)
          continue
        }
        const { lines, failure } = readLines(endpoint.rel)
        if (failure) {
          failures.push(`${endpoint.key}: ${failure}`)
          continue
        }
        if (endpoint.line < 1 || endpoint.line > lines.length) {
          failures.push(`${endpoint.key}: cited line is past end-of-file (${lines.length} lines)`)
          continue
        }
        if (!Object.hasOwn(manifest, endpoint.key)) {
          failures.push(`${endpoint.key}: manifest has no entry`)
          continue
        }
        const expected = manifest[endpoint.key]
        if (!isDistinctive(lines, expected)) {
          failures.push(`${endpoint.key}: expected must be at least ${MIN_EXPECTED_LENGTH} non-space characters and occur on exactly one target line`)
          continue
        }
        if (lineCarries(lines[endpoint.line - 1], expected)) continue
        const at = lines.findIndex((line) => lineCarries(line, expected)) + 1
        shifted.push({ doc, key: endpoint.key, rel: endpoint.rel, from: endpoint.line, to: at, nextKey: `${endpoint.rel}:${at}` })
      }
    }
  }
  for (const key of keys) {
    if (!cited.has(key)) failures.push(`${key}: manifest entry is orphaned (no citation)`)
  }
  return { failures, shifted, cited, keys }
}

function docSpans() {
  const perDoc = new Map()
  for (const doc of skillDocs()) {
    const text = readFileSync(doc, 'utf8')
    CITE_RE.lastIndex = 0
    const spans = []
    for (const match of text.matchAll(CITE_RE)) spans.push(...endpointsOf(match))
    perDoc.set(doc, { text, spans })
  }
  return perDoc
}

function repairAll() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const perDoc = docSpans()
  const citedByKey = new Map()
  for (const [doc, { spans }] of perDoc) {
    for (const span of spans) {
      if (!citedByKey.has(span.key)) citedByKey.set(span.key, [])
      citedByKey.get(span.key).push({ doc, ...span })
    }
  }
  const failures = []
  const shifted = []
  const docEdits = new Map()
  const editDoc = (doc, offset, length, next) => {
    if (!docEdits.has(doc)) docEdits.set(doc, [])
    docEdits.get(doc).push({ offset, length, next })
  }
  const locate = (rel, expected) => {
    const { lines, failure } = readLines(rel)
    if (failure) return { failure }
    const found = []
    for (let i = 0; i < lines.length; i += 1) if (lineCarries(lines[i], expected)) found.push(i + 1)
    return { found }
  }
  for (const [key, expected] of Object.entries(manifest)) {
    const cut = key.lastIndexOf(':')
    const rel = key.slice(0, cut)
    const from = Number(key.slice(cut + 1))
    if (typeof expected !== 'string' || expected.replace(/\s/g, '').length < MIN_EXPECTED_LENGTH) {
      failures.push(`${key}: expected is too short to relocate`)
      continue
    }
    const { found, failure } = locate(rel, expected)
    if (failure) {
      failures.push(`${key}: ${failure}`)
      continue
    }
    if (found.length === 0) {
      failures.push(`${key}: content appears nowhere in ${rel}; this is rot, not a shift`)
      continue
    }
    if (found.length > 1) {
      failures.push(`${key}: content occurs ${found.length} times in ${rel}; no unique home to relocate to`)
      continue
    }
    const to = found[0]
    if (to === from) continue
    const nextKey = `${rel}:${to}`
    const moved = (citedByKey.get(key) || []).filter((span) => span.line === from)
    if (moved.length === 0) {
      failures.push(`${key}: content moved to line ${to} but no citation carries the stale line; cite ${from} by hand and re-run repair`)
      continue
    }
    for (const span of moved) editDoc(span.doc, span.offset, span.length, String(to))
    if (Object.hasOwn(manifest, nextKey)) {
      if (manifest[nextKey] !== expected) {
        failures.push(`${key}: cannot relocate to ${nextKey}, which pins different content`)
        continue
      }
      delete manifest[key]
    } else {
      delete manifest[key]
      manifest[nextKey] = expected
    }
    shifted.push({ key, rel, from, to, nextKey, doc: moved.length === 1 ? moved[0].doc : null })
  }
  const freshKeys = new Set(Object.keys(manifest))
  for (const [citedKey] of citedByKey) {
    if (freshKeys.has(citedKey)) continue
    if (shifted.some((shift) => shift.key === citedKey)) continue
    failures.push(`${citedKey}: manifest has no entry`)
  }
  for (const key of Object.keys(manifest)) {
    if (!citedByKey.has(key) && !shifted.some((shift) => shift.nextKey === key)) failures.push(`${key}: manifest entry is orphaned (no citation)`)
  }
  if (failures.length > 0) throw new Error(`repair refused: ${failures[0]}`)
  if (shifted.length === 0) return []
  for (const [doc, edits] of docEdits) {
    let text = perDoc.get(doc).text
    for (const edit of edits.sort((a, b) => b.offset - a.offset)) {
      text = text.slice(0, edit.offset) + edit.next + text.slice(edit.offset + edit.length)
    }
    writeFileSync(doc, text)
  }
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
  return shifted
}

if (process.argv.includes('--repair-all')) {
  const shifted = repairAll()
  for (const shift of shifted) console.log(`shifted ${shift.key} -> line ${shift.to}`)
  console.log(`repaired ${shifted.length} shifted pin(s)`)
}

// Mutation killed: move any cited source line, or delete a citing line, and
// this test reddens — the pin carries content, not just shape.
test('every frontend-svelte path:line anchor carries what the prose claims', () => {
  const { failures, shifted, cited } = checkSkill()
  assert.deepEqual(failures, [])
  assert.deepEqual(shifted.map((shift) => `${shift.key} -> ${shift.to}`), [], 'a shifted pin must be relocated, not tolerated — repair with: node skills/frontend-svelte/exhibits.test.mjs --repair-all')
  assert.ok(cited.size >= FLOOR.minAnchors)
})

// Mutation killed: restating the old :global(p) claim, or dropping the pinned
// selector from the prose, must make this test fail — the manifest pin alone
// cannot see prose truth (RV1-1).
test('frontend-svelte scoped-styles prose names the pinned selector', () => {
  const text = readFileSync(join(HERE, 'references/components.md'), 'utf8')
  assert.ok(text.includes('.evidence :global(.markdown-document)'), 'prose must name the selector the manifest pins')
  assert.equal(text.includes(':global(p)'), false, 'no :global(p) rule exists under visualizer/')
})

// Mutation killed: changing any census figure in the prose must make this test
// fail — the figures are measured on this tree and nothing else guards them (RV1-2).
test('frontend-svelte prose census figures match the measured tree', () => {
  const scope = join(ROOT, 'visualizer/web/src')
  const files = []
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && entry.name.endsWith('.svelte')) files.push(path)
    }
  }
  visit(scope)
  const sources = files.map((file) => readFileSync(file, 'utf8'))
  const occurrences = (pattern) => sources.reduce((total, source) => total + source.split(pattern).length - 1, 0)
  const carriers = (pattern) => sources.filter((source) => source.includes(pattern)).length
  for (const [pattern, occ, hits] of [['{#snippet', 3, 3], ['{@render', 19, 3], ['onclick=', 70, 19], ['on:click', 0, 0], ['$state(', 142, 22], ['$derived', 171, 29], ['$props()', 25, 25], ['$effect', 31, 19], ['$bindable(', 5, 3]]) {
    assert.equal(occurrences(pattern), occ, `${pattern} occurrences`)
    assert.equal(carriers(pattern), hits, `${pattern} files`)
  }
  const components = readFileSync(join(HERE, 'references/components.md'), 'utf8')
  for (const phrase of ['`{#snippet` 3 times in 3 files', '`{@render` 19 times in 3 files', '70 across 19 files', '`$state(` 142 times in 22 files', '`$derived` 171 times in 29 files', '`$props()` 25 times in 25 files', '`$effect` 31 times in 19 files', '`$bindable(` 5 times in 3 files', 'visualizer/web/src/**/*.svelte, 34 files']) {
    assert.ok(components.includes(phrase), `components.md must carry ${phrase}`)
  }
  assert.ok(readFileSync(join(HERE, 'references/structure.md'), 'utf8').includes('33 `.svelte` components'), 'structure.md must carry the lib component count')
})
// Mutation killed: giving the shell a filter-ownership clause again must make
// this test fail — App.svelte declares no filter state, and the uncited clause
// is invisible to the content pins (RV2-1).
test('frontend-svelte shell ownership names no filter state', () => {
  const text = readFileSync(join(HERE, 'references/structure.md'), 'utf8')
  const start = text.indexOf('owns hash route state')
  assert.notEqual(start, -1, 'ownership sentence is missing')
  const end = text.indexOf('It passes shaped rows', start)
  assert.notEqual(end, -1, 'ownership sentence terminator is missing')
  assert.equal(text.slice(start, end).includes('filter'), false, 'App.svelte owns no filter state')
})

// Mutation killed: lower the minAnchors floor and the manifest size no longer
// equals it; delete a citing line and the cited set drops below it.
test('the frontend-svelte manifest meets its floor with no orphans', () => {
  const { failures, cited, keys } = checkSkill()
  assert.deepEqual(failures, [])
  assert.equal(keys.length, FLOOR.minAnchors)
  assert.ok(cited.size >= FLOOR.minAnchors)
})
