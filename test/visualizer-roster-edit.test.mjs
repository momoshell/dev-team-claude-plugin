import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadSeatSchema, proposeEdit } from '../visualizer/server/roster-edit.mjs'

const rosterPath = join(process.cwd(), 'crew', 'roster.json')
const schemaPath = join(process.cwd(), 'crew', 'roster.schema.json')
const rosterText = readFileSync(rosterPath, 'utf8')
const roster = JSON.parse(rosterText)

function edit(input = {}) {
  return proposeEdit({
    rosterText,
    rosterPath: 'crew/roster.json',
    tier: 'build',
    role: 'reviewer',
    cell: { ...roster.tiers.build.reviewer, effort: 'high' },
    ...input,
  })
}

function assertRefused(result, code) {
  assert.equal(result.ok, false)
  assert.equal(result.diff, null)
  assert.ok(result.refusals.some((refusal) => refusal.code === code), `${code} refusal missing`)
  return result.refusals.find((refusal) => refusal.code === code).message
}

test('the runtime roster is byte-exactly canonical JSON', () => {
  assert.equal(rosterText, JSON.stringify(roster, null, 2))
  assert.equal(rosterText.endsWith('\n'), false)
})

test('a legal edit produces one unified hunk and an applyable diff', () => {
  const result = edit()
  assert.equal(result.ok, true)
  assert.match(result.diff, /^--- a\/crew\/roster\.json$/m)
  assert.match(result.diff, /^\+\+\+ b\/crew\/roster\.json$/m)
  assert.equal(result.diff.match(/^@@/gm).length, 1)
  const dir = mkdtempSync(join(tmpdir(), 'roster-edit-'))
  try {
    const crew = join(dir, 'crew')
    const patchPath = join(dir, 'edit.patch')
    mkdirSync(crew, { recursive: true })
    copyFileSync(rosterPath, join(crew, 'roster.json'))
    writeFileSync(patchPath, result.diff)
    execFileSync('patch', ['-p1', '-i', patchPath], { cwd: dir, stdio: 'pipe' })
    const expected = structuredClone(roster)
    expected.tiers.build.reviewer.effort = 'high'
    assert.equal(readFileSync(join(crew, 'roster.json'), 'utf8'), JSON.stringify(expected, null, 2))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an identity edit returns an empty diff', () => {
  const result = edit({ cell: roster.tiers.build.reviewer })
  assert.equal(result.ok, true)
  assert.equal(result.diff, '')
  assert.deepEqual(result.before, result.after)
})

test('unknown tier is refused using resolveTier wording', () => {
  const message = assertRefused(edit({ tier: 'nope' }), 'unknown_tier')
  assert.match(message, /unknown tier "nope"/)
  assert.match(message, /mechanical, build, judge/)
  assert.match(message, /crew\/crew\.mjs resolveTier/)
})

test('unknown role is refused before a proposal is composed', () => {
  const message = assertRefused(edit({ role: 'operator' }), 'unknown_role')
  assert.match(message, /crew\/crew\.mjs:438 unknown crew role/)
})

test('unseating a required role is refused', () => {
  const message = assertRefused(edit({ role: 'planner', cell: null }), 'unseat_refused')
  assert.match(message, /resolveTier.*would not seat.*planner\/builder\/reviewer/)
})

test('mechanical lead cannot be seated', () => {
  const message = assertRefused(edit({ tier: 'mechanical', role: 'lead' }), 'mechanical_lead')
  assert.match(message, /mechanical\.lead.*null/)
  assert.match(message, /roster-refresh\.test\.mjs:125-128/)
})

test('cell shape violations name their field', () => {
  const badEnum = edit({ cell: { ...roster.tiers.build.reviewer, effort: 'bogus' } })
  assert.match(assertRefused(badEnum, 'cell_shape'), /effort/)
  const extra = edit({ cell: { ...roster.tiers.build.reviewer, extra: true } })
  assert.match(assertRefused(extra, 'cell_shape'), /additional properties/)
  const missing = { ...roster.tiers.build.reviewer }
  delete missing.agent
  assert.match(assertRefused(edit({ cell: missing }), 'cell_shape'), /agent.*missing/)
})

test('an unknown model is refused without exposing its catalog record', () => {
  const message = assertRefused(edit({ cell: { provider: 'openai', id: 'gpt-9.9-nope', agent: 'pi', effort: 'high' } }), 'unknown_model')
  assert.match(message, /openai\/gpt-9\.9-nope/)
  assert.doesNotMatch(JSON.stringify(edit({ cell: { provider: 'openai', id: 'gpt-9.9-nope', agent: 'pi', effort: 'high' } })), /cost_in_per_mtok|cost_out_per_mtok|usd|spend/i)
})

test('cross-vendor pairing is checked when the reviewer changes', () => {
  const message = assertRefused(edit({ cell: { provider: 'anthropic', id: 'claude-opus-5', agent: 'claude', effort: 'high' } }), 'cross_vendor')
  assert.match(message, /cross-vendor/)
  assert.match(message, /build/)
  assert.match(message, /planner/)
  assert.match(message, /anthropic/)
})

test('cross-vendor pairing is checked when the planner changes', () => {
  const message = assertRefused(edit({ role: 'planner', cell: { provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'max' } }), 'cross_vendor')
  assert.match(message, /cross-vendor/)
  assert.match(message, /planner/)
})

test('judge keeps tech-lead and planner on different vendors', () => {
  const message = assertRefused(edit({ tier: 'judge', role: 'planner', cell: { provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'max' } }), 'judge_vendor_split')
  assert.match(message, /tech-lead.*planner/)
  assert.match(message, /roster-refresh\.test\.mjs:130-132/)
})

test('an unreadable roster refuses before parsing or diffing', () => {
  const result = proposeEdit({ rosterText: null, rosterPath: '/tmp/missing-roster.json', readError: 'unable to read roster: ENOENT, at /tmp/missing-roster.json', tier: 'build', role: 'reviewer', cell: roster.tiers.build.reviewer })
  const message = assertRefused(result, 'roster_unreadable')
  assert.match(message, /\/tmp\/missing-roster\.json/)
})

test('seat enums are loaded from the supplied schema', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roster-schema-'))
  try {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
    schema.$defs.seat.properties.effort.enum = schema.$defs.seat.properties.effort.enum.filter((value) => value !== 'xhigh')
    const modified = join(dir, 'roster.schema.json')
    writeFileSync(modified, JSON.stringify(schema, null, 2))
    const message = assertRefused(edit({ seatSchema: loadSeatSchema(modified), cell: { ...roster.tiers.build.reviewer, effort: 'xhigh' } }), 'cell_shape')
    assert.match(message, /xhigh/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
