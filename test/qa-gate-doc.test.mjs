// Owner of references/qa-gate.md's Review ladder / Reviewer verdicts /
// consolidation sections. Two sections of the same file are owned elsewhere
// and must NOT be re-asserted here:
//   - '## Noise filtering'  -> test/noise-globs.test.mjs (incl. the `:!`
//     placement guard at :135-144, which already covers THIS section by
//     asserting the token appears nowhere outside the noise section).
//   - '## An optional gate adjunct: browser-verify evidence'
//     -> test/cmux-dispatch-doc.test.mjs:206-231.
// Add qa-gate.md assertions here or to those two files — never to a third.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './helpers.mjs'

const qaGateMd = readFileSync(join(ROOT, 'references', 'qa-gate.md'), 'utf8')
const qaLeadMd = readFileSync(join(ROOT, 'agents', 'qa-lead.md'), 'utf8')

const LADDER_HEADING = '## Review ladder (owned by `dev-team:qa-lead`)'

// Local copy of the same-shaped extractor test/noise-globs.test.mjs already
// uses — an independent oracle is the point here (see test/roster.test.mjs
// :58-61), not shared production code, since the "production" under test is
// prose, not a function.
function extractSection(markdown, headingLine) {
  const lines = markdown.split('\n')
  const start = lines.findIndex((l) => l === headingLine)
  if (start === -1) {
    throw new Error(`heading not found: ${JSON.stringify(headingLine)}`)
  }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

// agents/qa-lead.md's ladder is a numbered step, not a `##` section — slice
// between the step-3 opener and the step-4 opener instead.
function extractQaLeadStep3(markdown) {
  const lines = markdown.split('\n')
  const start = lines.findIndex((l) => l.startsWith('3. **Decide review depth'))
  if (start === -1) {
    throw new Error('qa-lead.md step 3 opener not found')
  }
  const end = lines.findIndex((l, i) => i > start && l.startsWith('4. **Size the gate bundle'))
  if (end === -1) {
    throw new Error('qa-lead.md step 4 opener not found')
  }
  return lines.slice(start, end).join('\n')
}

// --- 1. control ---
test('qa-gate.md: Review ladder section is found and still carries its pre-existing positive marker', () => {
  const section = extractSection(qaGateMd, LADDER_HEADING)
  assert.match(section, /Adversarial panel/)
  assert.throws(() => extractSection(qaGateMd, '## Does not exist, bogus heading'))
})

// --- 2. composition + raise-only ---
test('qa-gate.md: ladder states depth = max(semantic_row, mechanical_floor_row) and that the floor only raises', () => {
  const section = extractSection(qaGateMd, LADDER_HEADING)
  assert.match(section, /depth = max\(semantic_row, mechanical_floor_row\)/)
  assert.match(section, /only ever RAISE|never lower|only raise/i)
})

// --- 3. threshold ---
test('qa-gate.md: ladder states the single 100-changed-lines threshold', () => {
  const section = extractSection(qaGateMd, LADDER_HEADING)
  assert.match(section, /100 changed lines/)
  assert.match(section, /insertions \+ deletions/)
})

// --- 4. measurement instruction ---
test('qa-gate.md: ladder names the measurement (--shortstat in place of --name-only, against the noise section)', () => {
  const section = extractSection(qaGateMd, LADDER_HEADING)
  assert.match(section, /--shortstat/)
  assert.match(section, /--name-only/)
  assert.match(section, /[Nn]oise filtering/)
})

// --- 5. suppression-blind ---
test('qa-gate.md: ladder states the floor measurement is suppression-blind, deliberately', () => {
  const section = extractSection(qaGateMd, LADDER_HEADING)
  assert.match(section, /suppression-blind/)
  assert.match(section, /files_in_scope/)
  assert.match(section, /different diffs|divergence|two different/)
})

// --- 6. reviewer-lane-only ---
test('qa-gate.md: ladder states the floor moves the reviewer lane only, never test-engineer', () => {
  const section = extractSection(qaGateMd, LADDER_HEADING)
  assert.match(section, /reviewer lane/i)
  assert.match(section, /test-engineer/)
  assert.match(section, /own trigger/)
})

// --- 7. doc-prose clarification ---
test('qa-gate.md: ladder clarifies test-engineer\'s "behavior" trigger includes doc-prose behavior', () => {
  const section = extractSection(qaGateMd, LADDER_HEADING)
  assert.match(section, /doc-prose behavior/)
  assert.match(section, /test-engineer/)
})

// --- 8. both rejections recorded ---
test('qa-gate.md: ladder records both rejected options with their reasons', () => {
  const section = extractSection(qaGateMd, LADDER_HEADING)
  assert.match(section, /rejected/i)
  assert.match(section, /panel/)
  assert.match(section, /stacked/)
  assert.match(section, /50 changed files/)
  assert.match(section, /rename/)
})

// --- 9. negative, guarded: no second active "50 changed files" arm ---
test('qa-gate.md: "50 changed files" appears exactly once, inside the rejection sentence, never as a second active arm', () => {
  const section = extractSection(qaGateMd, LADDER_HEADING)
  // Re-assert the positive first so this negative can never run vacuously.
  assert.match(section, /depth = max\(semantic_row, mechanical_floor_row\)/)

  const needle = '50 changed files'
  const firstIndex = section.indexOf(needle)
  assert.notEqual(firstIndex, -1, 'expected "50 changed files" to appear at least once')
  const secondIndex = section.indexOf(needle, firstIndex + needle.length)
  assert.equal(secondIndex, -1, '"50 changed files" must appear exactly once in the ladder section')

  const preceding = section.slice(Math.max(0, firstIndex - 200), firstIndex)
  assert.match(preceding, /reject/i)
})

// --- 10. drift guard between qa-gate.md and qa-lead.md ---
test('qa-gate.md and agents/qa-lead.md state the floor rule identically on every pinned token, after normalization', () => {
  const gateSection = extractSection(qaGateMd, LADDER_HEADING)
  const leadSection = extractQaLeadStep3(qaLeadMd)

  const normalize = (s) => s.replace(/\*/g, '').replace(/\s+/g, ' ')
  const normGate = normalize(gateSection)
  const normLead = normalize(leadSection)

  // Positive markers re-asserted after normalization, before the drift check.
  assert.match(normGate, /Adversarial panel/)
  assert.match(normLead, /Deep triggers \(any\):/)

  const tokens = [
    'more than 100 changed lines',
    'max(semantic_row',
    'suppression-blind',
    'reviewer lane',
    'test-engineer',
  ]
  for (const token of tokens) {
    assert.ok(normGate.includes(token), `qa-gate.md ladder section missing drift-pinned token: ${token}`)
    assert.ok(normLead.includes(token), `qa-lead.md step-3 block missing drift-pinned token: ${token}`)
  }

  // The raise-only clause must hold on both sides, not just qa-gate.md (test 2
  // only asserts it there) — a future edit that drops "raises, never lowers"
  // from qa-lead.md's copy would otherwise go undetected.
  const raiseOnly = /only ever raise|never lower|only raise/i
  assert.match(normGate, raiseOnly, 'qa-gate.md ladder section missing the raise-only clause')
  assert.match(normLead, raiseOnly, 'qa-lead.md step-3 block missing the raise-only clause')
})
