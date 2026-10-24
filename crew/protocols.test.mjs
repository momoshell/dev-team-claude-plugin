import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBrief, BRIEF_FIELDS, TIERS, SHAPES } from './protocols.mjs'

const BODY = '## The ask\n\nRefuse roster edits that cannot boot.\n\n## Acceptance\n\n- (RV1) an edit that cannot boot is refused\n- (RV2) a bootable edit is accepted\n'
const brief = (overrides = {}, body = BODY) => {
  const fields = { source: 'issue 1961', closes: '1961', tier: 'build', shape: 'standard', acceptance: '[RV1, RV2]', out_of_scope: 'the visualizer', ...overrides }
  const front = Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`).join('\n')
  return `---\n${front}\n---\n${body}`
}

test('P1 vocabularies are the ADR-052 fields, tiers and shapes', () => {
  assert.deepEqual(BRIEF_FIELDS, ['source', 'closes', 'tier', 'shape', 'acceptance', 'out_of_scope'])
  assert.deepEqual(TIERS, ['mechanical', 'build', 'judge'])
  assert.deepEqual(SHAPES, ['standard', 'stepped', 'finish'])
})

test('a well-formed brief parses with no defects', () => {
  const { fields, body, defects } = parseBrief(brief())
  assert.deepEqual(defects, [])
  assert.deepEqual(fields, { source: 'issue 1961', closes: 1961, tier: 'build', shape: 'standard', acceptance: ['RV1', 'RV2'], out_of_scope: 'the visualizer' })
  assert.match(body, /^## The ask/)
  assert.equal(parseBrief(brief({ closes: 'null' })).fields.closes, null)
})

// MUTATION: drop the frontmatter-open check and a plain markdown brief reaches field parsing.
test('a brief without frontmatter is refused', () => {
  assert.deepEqual(parseBrief('# Ask\n').defects, ['the brief does not open with a --- frontmatter block'])
  assert.deepEqual(parseBrief('---\nsource: x\n').defects, ['the frontmatter block is never closed with ---'])
})

// MUTATION: skip the unknown-field check and a misspelt field is silently ignored.
test('unknown and missing fields are refused by name', () => {
  const { defects } = parseBrief(brief({ tier: undefined, lane: 'b1' }))
  assert.ok(defects.includes('unknown field lane; the fields are source, closes, tier, shape, acceptance, out_of_scope'))
  assert.ok(defects.includes('missing field tier'))
})

// MUTATION: accept any tier, shape or closes value and a typo boots on the wrong seats or binds no issue.
test('tier, shape and closes take only their closed values', () => {
  assert.ok(parseBrief(brief({ tier: 'rigorous' })).defects.includes('tier is one of mechanical, build, judge'))
  assert.ok(parseBrief(brief({ shape: 'chunked' })).defects.includes('shape is one of standard, stepped, finish'))
  assert.ok(parseBrief(brief({ closes: '0' })).defects.includes('closes is null or one issue number'))
})

// MUTATION: compare the acceptance ids as sets, or not at all, and a gate id with no item passes.
test('acceptance ids must open the ## Acceptance items in order', () => {
  assert.ok(parseBrief(brief({ acceptance: '[RV1, RV3]' })).defects.includes('the ## Acceptance items open with (RV1) (RV2), not the frontmatter ids (RV1) (RV3)'))
  assert.ok(parseBrief(brief({ acceptance: '[RV1, RV1]' })).defects.includes('acceptance repeats an id'))
  assert.ok(parseBrief(brief({ acceptance: '[]' })).defects.some((line) => line.startsWith('acceptance lists the gate ids')))
})

// MUTATION: read items inside a fence, or close a fence on a line with trailing text, and a brief with no enforceable ids validates.
test('acceptance items inside a fence are examples, and only a bare marker closes a fence', () => {
  const fenced = '## Acceptance\n\n```\n- (RV1) a\n- (RV2) b\n```\n'
  assert.ok(parseBrief(brief({}, fenced)).defects.includes('the ## Acceptance items open with (none), not the frontmatter ids (RV1) (RV2)'))
  const trailing = '## Acceptance\n\n```\nexample\n``` trailing\n- (RV1) a\n- (RV2) b\n```\n'
  assert.ok(parseBrief(brief({}, trailing)).defects.includes('the ## Acceptance items open with (none), not the frontmatter ids (RV1) (RV2)'))
})

// MUTATION: merge repeated sections and the validator approves ids the driver never reads.
test('a repeated section is refused, because the driver reads only the first', () => {
  const twice = '## Acceptance\n\n- (RV1) a\n\n## Acceptance\n\n- (RV2) b\n'
  assert.ok(parseBrief(brief({}, twice)).defects.includes('the body repeats ## Acceptance; the driver reads only the first'))
})

// MUTATION: allow #N in the body and something other than closes can bind an issue.
test('the body names no issue or PR number; closes is the only binding', () => {
  const body = BODY.replace('cannot boot.', 'cannot boot, after PR #1968.\n\nCloses #1961')
  assert.ok(parseBrief(brief({}, body)).defects.includes('the body names #1968, #1961; write "issue N" or "PR N", because closes is the only issue binding'))
})
