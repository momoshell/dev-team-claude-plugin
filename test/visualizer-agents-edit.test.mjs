import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { proposeAgentEdit } from '../visualizer/server/agents-edit.mjs'
import { ROOT, scratchDir } from './helpers.mjs'
import { parseAgent } from '../crew/protocols.mjs'
import { resolveAgents } from '../crew/agents.mjs'

const PATH = 'crew/agents/planner.md'
const text = readFileSync(PATH, 'utf8')
const changed = (diff, sign) => diff.split('\n').filter((l) => l.startsWith(sign) && !l.startsWith(sign.repeat(3)))

test('base model and effort edits touch one frontmatter line and parse clean', () => {
  for (const [field, value] of [['effort', 'max'], ['model', 'openai/gpt-6-luna']]) {
    const r = proposeAgentEdit({ agentText: text, role: 'planner', field, value })
    assert.equal(r.ok, true)
    assert.equal(changed(r.diff, '-').length, 1)
    assert.match(changed(r.diff, '+')[0], new RegExp(`^\\+${field}: `))
    assert.deepEqual(parseAgent(r.afterText).defects, [])
    assert.equal(r.after, value)
  }
})

test('tier override sets and clears one cell for that tier only', () => {
  const scratch = scratchDir('agents-edit-')
  try {
    cpSync(join(ROOT, 'crew/agents'), scratch, { recursive: true })
    const base = resolveAgents('build', scratch)
    const set = proposeAgentEdit({ agentText: text, role: 'planner', tier: 'judge', field: 'effort', value: 'max' })
    assert.equal(set.ok, true)
    assert.equal(changed(set.diff, '-').length, 1)
    writeFileSync(join(scratch, 'planner.md'), set.afterText)
    assert.equal(resolveAgents('judge', scratch).seats.planner.effort, 'max')
    assert.deepEqual(resolveAgents('build', scratch), base)
    const cleared = proposeAgentEdit({ agentText: set.afterText, role: 'planner', tier: 'judge', field: 'effort', value: null })
    assert.equal(cleared.ok, true)
    assert.equal(cleared.before, 'max')
    assert.equal(parseAgent(cleared.afterText).fields.tiers.judge?.effort, undefined)
    writeFileSync(join(scratch, 'planner.md'), cleared.afterText)
    assert.equal(resolveAgents('judge', scratch).seats.planner.effort, parseAgent(text).fields.effort)
    assert.deepEqual(resolveAgents('build', scratch), base)
    writeFileSync(join(scratch, 'planner.md'), text)
    const m = proposeAgentEdit({ agentText: text, role: 'planner', tier: 'judge', field: 'model', value: 'openai/gpt-6-luna' })
    assert.equal(m.ok, true)
    writeFileSync(join(scratch, 'planner.md'), m.afterText)
    assert.equal(resolveAgents('judge', scratch).seats.planner.id, 'gpt-6-luna')
    assert.deepEqual(resolveAgents('build', scratch), base)
    const mc = proposeAgentEdit({ agentText: m.afterText, role: 'planner', tier: 'judge', field: 'model', value: null })
    assert.equal(mc.ok, true)
    writeFileSync(join(scratch, 'planner.md'), mc.afterText)
    const [prov, id] = parseAgent(text).fields.model.split('/')
    assert.equal(resolveAgents('judge', scratch).seats.planner.id, id)
    assert.equal(resolveAgents('judge', scratch).seats.planner.provider, prov)
    assert.deepEqual(resolveAgents('build', scratch), base)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})

test('an override on an unseated (null) tier reseats that tier only; clearing it is a no-op', () => {
  const lead = readFileSync(join(ROOT, 'crew/agents/lead.md'), 'utf8')
  const scratch = scratchDir('agents-edit-')
  try {
    cpSync(join(ROOT, 'crew/agents'), scratch, { recursive: true })
    const base = resolveAgents('build', scratch)
    const r = proposeAgentEdit({ agentText: lead, role: 'lead', tier: 'mechanical', field: 'effort', value: 'max' })
    assert.equal(r.ok, true, JSON.stringify(r.refusals))
    assert.equal(changed(r.diff, '-').length, 1)
    assert.deepEqual(parseAgent(r.afterText).defects, [])
    writeFileSync(join(scratch, 'lead.md'), r.afterText)
    assert.equal(resolveAgents('mechanical', scratch).seats.lead.effort, 'max')
    assert.deepEqual(resolveAgents('build', scratch), base)
    const none = proposeAgentEdit({ agentText: lead, role: 'lead', tier: 'mechanical', field: 'effort', value: null })
    assert.equal(none.ok, true)
    assert.equal(none.diff, '')
    assert.equal(none.afterText, lead)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})

test('parser-refused values return the defect text and a null diff', () => {
  const cases = [
    [{ role: 'planner', field: 'effort', value: 'extreme' }, /effort is one of/],
    [{ role: 'planner', field: 'model', value: 'badmodel' }, /model is provider\/id/],
    [{ role: 'planner', tier: 'ultra', field: 'effort', value: 'max' }, /tiers\.ultra is not a tier/],
    [{ role: 'nobody', field: 'effort', value: 'max' }, /role is one of/],
    [{ role: 'planner', field: 'effort', value: 'max\nmodel: x/y' }, /single-line/],
    [{ role: 'planner', field: 'name', value: 'x' }, /editable fields/],
  ]
  for (const [input, pattern] of cases) {
    const r = proposeAgentEdit({ agentText: text, ...input })
    assert.equal(r.ok, false)
    assert.equal(r.diff, null)
    assert.match(r.refusals.map((x) => x.message).join(' '), pattern)
  }
})

test('clearing an unknown tier is refused with the parser defect, with or without a tiers line', () => {
  const noTiers = text.split('\n').filter((l) => !l.startsWith('tiers:')).join('\n')
  assert.equal(parseAgent(noTiers).fields.tiers, undefined)
  for (const agentText of [text, noTiers]) {
    for (const field of ['effort', 'model']) {
      const r = proposeAgentEdit({ agentText, role: 'planner', tier: 'ultra', field, value: null })
      assert.equal(r.ok, false)
      assert.equal(r.diff, null)
      assert.match(r.refusals.map((x) => x.message).join(' '), /tiers\.ultra is not a tier/)
    }
  }
  const known = proposeAgentEdit({ agentText: noTiers, role: 'planner', tier: 'build', field: 'effort', value: null })
  assert.equal(known.ok, true)
  assert.equal(known.diff, '')
})

test('an unreadable agent file is a named null, not an empty diff', () => {
  const r = proposeAgentEdit({ agentText: null, readError: 'unable to read agent definition: ENOENT, at crew/agents/planner.md', role: 'planner', field: 'model', value: 'a/b' })
  assert.equal(r.ok, false)
  assert.equal(r.diff, null)
  assert.equal(r.afterText, null)
  assert.match(r.refusals[0].message, /ENOENT.*planner\.md/)
  assert.match(proposeAgentEdit({ agentText: null, role: 'planner', field: 'model', value: 'a/b' }).refusals[0].message, /crew\/agents\/planner\.md/)
})
