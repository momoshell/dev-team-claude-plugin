import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBrief, BRIEF_FIELDS, TIERS, SHAPES } from './protocols.mjs'

const brief = (overrides = {}, body = null) => {
  const fields = { source: 'issue 1961', closes: '1961', tier: 'build', shape: 'standard', acceptance: '[RV1, RV2]', out_of_scope: 'the visualizer', ...overrides }
  const front = Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`).join('\n')
  return `---\n${front}\n---\n${body ?? '# Ask\n\nRefuse roster edits that cannot boot.\n\nCloses #1961\n\n## Acceptance\n\n- (RV1) an edit that cannot boot is refused\n- (RV2) a bootable edit is accepted\n'}`
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
  assert.match(body, /^# Ask/)
})

test('a brief that closes nothing parses with closes null and no Closes line', () => {
  const { fields, defects } = parseBrief(brief({ closes: 'null' }, '# Ask\n\nTidy.\n\n## Acceptance\n\n- (RV1) a\n- (RV2) b\n'))
  assert.deepEqual(defects, [])
  assert.equal(fields.closes, null)
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

// MUTATION: accept any tier or shape string and a typo boots on the wrong seats.
test('tier and shape come from their closed lists', () => {
  assert.ok(parseBrief(brief({ tier: 'rigorous' })).defects.includes('tier is one of mechanical, build, judge'))
  assert.ok(parseBrief(brief({ shape: 'chunked' })).defects.includes('shape is one of standard, stepped, finish'))
})

// MUTATION: compare the acceptance ids as sets, or not at all, and a gate id with no item passes.
test('acceptance ids must open the ## Acceptance items in order', () => {
  const { defects } = parseBrief(brief({ acceptance: '[RV1, RV3]' }))
  assert.ok(defects.includes('the ## Acceptance items open with (RV1) (RV2), not the frontmatter ids (RV1) (RV3)'))
  assert.ok(parseBrief(brief({ acceptance: '[RV1, RV1]' })).defects.includes('acceptance repeats an id'))
  assert.ok(parseBrief(brief({ acceptance: '[]' })).defects.some((line) => line.startsWith('acceptance lists the gate ids')))
})

// MUTATION: drop the Closes-line check and a lane with closes set ships a PR that closes nothing.
test('closes and the body Closes line agree', () => {
  const noLine = brief({}, '# Ask\n\nDo it.\n\n## Acceptance\n\n- (RV1) a\n- (RV2) b\n')
  assert.ok(parseBrief(noLine).defects.includes('the body carries the line "Closes #1961" alone, exactly once'))
  const extraLine = brief({ closes: 'null' })
  assert.ok(parseBrief(extraLine).defects.includes('closes is null but the body carries a Closes line'))
  assert.ok(parseBrief(brief({ closes: '0' })).defects.includes('closes is null or one issue number'))
})

// MUTATION: allow other #N in the body and the driver can bind the lane to the wrong issue.
test('no issue or PR number other than the Closes line appears in the body', () => {
  const body = '# Ask\n\nFollows PR #1968.\n\nCloses #1961\n\n## Acceptance\n\n- (RV1) a\n- (RV2) b\n'
  assert.ok(parseBrief(brief({}, body)).defects.includes('the body names #1968; write "issue N" or "PR N" instead, so nothing but the Closes line binds an issue'))
})
