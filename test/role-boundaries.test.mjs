// Owner of the doctrine pins for: agents/coder.md's body (Scope discipline,
// How you work, Pre-Return Self-Check), agents/qa-lead.md's test-attribution
// bullet in ## Boundaries, and handover-spec.md's test-ownership prose (##
// Fields, ## Self-check). Two things are owned elsewhere and must NOT be
// re-asserted here:
//   - handover-spec.md's pre-existing "discovery_context + files_in_scope +
//     noise" self-check bullet -> test/noise-globs.test.mjs (lines ~162-166).
//   - agent-file frontmatter validity -> test/agents.test.mjs.
//   - general schema validity -> test/schema.test.mjs.
// A later task (doc-18-02) extends this file with a manifest pin covering
// all agents/*.md files' shared norm bullet — that is appended as its own
// test() block below, not folded into these.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, listAgents } from './helpers.mjs'

const coderMd = readFileSync(join(ROOT, 'agents', 'coder.md'), 'utf8')
const qaLeadMd = readFileSync(join(ROOT, 'agents', 'qa-lead.md'), 'utf8')
const handoverSpecMd = readFileSync(join(ROOT, 'handover-spec.md'), 'utf8')
const handoverSpecSchema = JSON.parse(readFileSync(join(ROOT, 'handover-spec.schema.json'), 'utf8'))
const coderReturnSchema = JSON.parse(readFileSync(join(ROOT, 'coder-return.schema.json'), 'utf8'))

// Local oracle — an independent copy of the same-shaped extractor other test
// files use (test/qa-gate-doc.test.mjs:30-53), never production code, since
// the "production" under test here is prose, not a function.
function extractSection(markdown, headingLine) {
  const lines = markdown.split('\n')
  const start = lines.findIndex((l) => l === headingLine)
  if (start === -1) {
    throw new Error(`heading not found: ${JSON.stringify(headingLine)}`)
  }
  let end = lines.length
  let inFence = false
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (!inFence && lines[i].startsWith('## ')) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

test('agents/coder.md: Scope discipline forbids test files not in files_in_scope', () => {
  const section = extractSection(coderMd, '## Scope discipline')
  assert.ok(section.includes('unless that exact path is in `files_in_scope`'))
})

test('agents/coder.md: Scope discipline forbids running a broader validation suite', () => {
  const section = extractSection(coderMd, '## Scope discipline')
  assert.ok(section.includes('not a broader suite'))
})

test('agents/coder.md: Pre-Return Self-Check gates negative tests on scope, and the old unconditional wording is gone', () => {
  const section = extractSection(coderMd, '## Pre-Return Self-Check')
  assert.ok(section.includes('Only when a test file is in `files_in_scope`'))
  assert.ok(
    !coderMd.includes('Did you add or update negative tests when the spec asks for risky behavior coverage?'),
    'the old unconditional test-authoring invitation must be gone from the whole file'
  )
})

test('agents/coder.md: How you work says return immediately once validation passes', () => {
  const section = extractSection(coderMd, '## How you work')
  assert.ok(section.includes('your turn is over'))
})

test('handover-spec.md: Fields section names files_in_scope as the test-ownership decision', () => {
  const section = extractSection(handoverSpecMd, '## Fields')
  assert.ok(section.includes('also the test-ownership decision'))
  assert.ok(section.includes('There is no `test_ownership` field'))
})

test('handover-spec.md: Self-check section sharpens the coverage bullet with test-ownership language', () => {
  const section = extractSection(handoverSpecMd, '## Self-check (before emitting)')
  assert.ok(section.includes('Test coverage specifically'))
})

test('test ownership stays a files_in_scope convention, not a schema field', () => {
  assert.ok(
    !Object.prototype.hasOwnProperty.call(handoverSpecSchema.properties, 'test_ownership'),
    'handover-spec.schema.json must not gain a test_ownership property'
  )
  const testyProps = Object.keys(coderReturnSchema.properties).filter((k) => /test/i.test(k))
  assert.deepEqual(testyProps, [], 'coder-return.schema.json must not gain a test-named property')
})

test('agents/qa-lead.md: Boundaries names the coder as a test owner when the spec lists a test file', () => {
  const section = extractSection(qaLeadMd, '## Boundaries')
  assert.ok(section.includes('or the coder when the spec lists a test file'))
})

// doc-18-02: manifest pin for the shared "one deliverable, then return" bullet
// across every agents/*.md file's final section (## Boundaries or ## Rules).
const ONE_DELIVERABLE_BULLET =
  "- **One deliverable, then return.** Produce exactly what your own contract/output format defines as your artifact — even when that's a structured package with several named parts — then end your turn. Work beyond that, however useful it seems, belongs to a different agent the orchestrator dispatches, not to you."

test('non-vacuity guard: listAgents() finds at least 14 agent files', () => {
  assert.ok(listAgents().length >= 14, 'listAgents() must not have shrunk below the per-file test manifest below')
})

for (const file of listAgents()) {
  test(`agents/${file}: contains the shared "one deliverable, then return" bullet`, () => {
    const md = readFileSync(join(ROOT, 'agents', file), 'utf8')
    assert.ok(md.includes(ONE_DELIVERABLE_BULLET), `${file} is missing the byte-identical shared bullet`)
  })
}

// Fence-aware last-top-level-heading finder, mirroring extractSection's own
// inFence tracking above — a '## '-looking line inside a triple-backtick
// fence (e.g. an example block) is not a real heading.
function findLastTopLevelHeadingIndex(lines) {
  let lastHeadingIndex = -1
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (!inFence && lines[i].startsWith('## ')) lastHeadingIndex = i
  }
  return lastHeadingIndex
}

for (const file of listAgents()) {
  test(`agents/${file}: the shared bullet lives in the file's final Boundaries/Rules section`, () => {
    const md = readFileSync(join(ROOT, 'agents', file), 'utf8')
    const lines = md.split('\n')
    const lastHeadingIndex = findLastTopLevelHeadingIndex(lines)
    assert.ok(lastHeadingIndex !== -1, `${file} has no top-level '## ' heading`)
    const headingText = lines[lastHeadingIndex]
    assert.ok(
      headingText === '## Boundaries' || headingText === '## Rules',
      `${file}: final section heading must be '## Boundaries' or '## Rules', found ${JSON.stringify(headingText)}`
    )
    const bulletIndex = lines.findIndex((l) => l.includes(ONE_DELIVERABLE_BULLET))
    assert.ok(bulletIndex !== -1, `${file} is missing the shared bullet`)
    assert.ok(
      bulletIndex > lastHeadingIndex,
      `${file}: shared bullet (line ${bulletIndex + 1}) must appear after the last '## ' heading (line ${lastHeadingIndex + 1})`
    )
  })
}
