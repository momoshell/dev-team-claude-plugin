// The skill's documented findings shape and crew/pi/agents/scout.json's are ONE
// contract. This check reads both and compares each against a literal written
// here, so neither side can move without a deliberate edit to this file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT as REPO } from '../../test/helpers.mjs'
import { FINDING_DISPOSITIONS, FINDING_ID_SHAPE } from '../../crew/drive.mjs'

const HERE = fileURLToPath(new URL('./', import.meta.url))
const SCOUT = join(REPO, 'crew/pi/agents/scout.json')
const DOC = join(HERE, 'references/findings-shape.md')
const CHARTER = join(REPO, 'crew/roles/reviewer.md')

const TOP_KEYS = ['summary', 'findings', 'gaps']
const FINDING_KEYS = ['claim', 'evidence', 'confidence']
const CONFIDENCE_ENUM = '"verified" | "assumed"'
const MANDATORY = '`confidence` is not optional'
const CLOSED = 'No other keys are permitted'

// Collect `"key":` tokens at a fixed brace/bracket depth, in source order.
function keysAtDepth(block, wantDepth) {
  const keys = []
  let depth = 0
  for (let i = 0; i < block.length; i += 1) {
    const ch = block[i]
    if (ch === '{' || ch === '[') depth += 1
    else if (ch === '}' || ch === ']') depth -= 1
    else if (ch === '"') {
      const end = block.indexOf('"', i + 1)
      if (end < 0) break
      if (depth === wantDepth && /^\s*:/.test(block.slice(end + 1))) keys.push(block.slice(i + 1, end))
      i = end
    }
  }
  return keys
}

function blockFrom(text, from) {
  const start = text.indexOf(from)
  assert.ok(start >= 0, `no shape block starting ${JSON.stringify(from)}`)
  let depth = 0
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') { depth -= 1; if (depth === 0) return text.slice(start, i + 1) }
  }
  throw new Error('unterminated shape block')
}

const scoutPrompt = JSON.parse(readFileSync(SCOUT, 'utf8')).prompt
const doc = readFileSync(DOC, 'utf8')
const docBlock = (doc.match(/```json\n([\s\S]*?)```/) || [])[1]

test('scout.json defines the shape the skill documents', () => {
  const block = blockFrom(scoutPrompt, '{\n  "summary"')
  assert.deepEqual(keysAtDepth(block, 1), TOP_KEYS)
  assert.deepEqual(keysAtDepth(block, 3), FINDING_KEYS)
  assert.ok(scoutPrompt.includes(CONFIDENCE_ENUM))
  assert.ok(scoutPrompt.includes(MANDATORY))
  assert.ok(scoutPrompt.includes(CLOSED))
})

test('the skill documents that shape and no other', () => {
  assert.ok(docBlock, 'references/findings-shape.md carries no fenced json block')
  assert.deepEqual(keysAtDepth(docBlock, 1), TOP_KEYS)
  assert.deepEqual(keysAtDepth(docBlock, 3), FINDING_KEYS)
  assert.ok(doc.includes(CONFIDENCE_ENUM))
  assert.ok(doc.includes(MANDATORY))
  assert.ok(doc.includes(CLOSED))
})

test('the skill names the definition it is pinned to', () => {
  assert.ok(doc.includes('crew/pi/agents/scout.json'))
  assert.ok(doc.includes('skills/pr-review/findings-shape.test.mjs'))
})

test('the skill documents the reviewer finding disposition', () => {
  const enumLine = '`auto-fix` · `ask-user` · `no-op`'
  assert.equal(doc.includes(enumLine), true)
  const values = [...enumLine.matchAll(/`([^`]+)`/g)].map((match) => match[1])
  assert.deepEqual(values, [...FINDING_DISPOSITIONS])
})

test('the skill and the reviewer charter agree on the disposition set', () => {
  const charter = readFileSync(CHARTER, 'utf8')
  const line = charter.split('\n').find((entry) => entry.includes('"disposition":'))
  assert.ok(line)
  const values = [...line.slice(line.indexOf(':') + 1).matchAll(/"([^"]+)"/g)].map((match) => match[1])
  assert.deepEqual(values, [...FINDING_DISPOSITIONS])
})

test('the skill states the disposition window and the pass/must-fix refusal', () => {
  assert.match(doc, /`disposition` field is optional in this release and required from the next/i)
  assert.match(doc, /`pass` may\s+not carry a `must-fix`/)
})

test('the skill and the charter state the same finding-id shape', () => {
  const charter = readFileSync(CHARTER, 'utf8')
  const shape = String(FINDING_ID_SHAPE).slice(1, -1)
  assert.equal(doc.includes(shape), true)
  assert.equal(charter.includes(shape), true)
  assert.equal(shape, '^[A-Za-z0-9_-]{1,64}$')
})

test('every worked example in the skill conforms to the shape', () => {
  const files = [join(HERE, 'SKILL.md')]
  for (const name of readdirSync(join(HERE, 'references'))) if (name.endsWith('.md')) files.push(join(HERE, 'references', name))
  let examples = 0
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(/```json\n([\s\S]*?)```/g)) {
      let parsed
      try { parsed = JSON.parse(match[1]) } catch { continue }
      if (!parsed || !Array.isArray(parsed.findings)) continue
      examples += 1
      assert.deepEqual(Object.keys(parsed).filter((k) => !TOP_KEYS.includes(k)), [], `${file}: example carries a key the contract forbids`)
      assert.equal(typeof parsed.summary, 'string')
      for (const finding of parsed.findings) {
        assert.deepEqual(Object.keys(finding).sort(), [...FINDING_KEYS].sort(), `${file}: finding keys must be exactly ${FINDING_KEYS}`)
        assert.ok(Array.isArray(finding.evidence) && finding.evidence.length, `${file}: evidence must be a non-empty list`)
        assert.ok(['verified', 'assumed'].includes(finding.confidence), `${file}: confidence must be verified or assumed`)
      }
    }
  }
  assert.ok(examples >= 1, 'the skill carries no worked example of the shape')
})
