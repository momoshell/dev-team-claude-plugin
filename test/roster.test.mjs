import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, listAgents, MODEL_ALIASES } from './helpers.mjs'
import { validate, SUBAGENT_ONLY, PANE_ROLES } from '../scripts/cmux/contract.mjs'

const rosterSchema = JSON.parse(readFileSync(join(ROOT, 'scripts/cmux/roster.schema.json'), 'utf8'))
const roster = JSON.parse(readFileSync(join(ROOT, 'scripts/cmux/roster.default.json'), 'utf8'))
const dispatchRecordSchema = JSON.parse(readFileSync(join(ROOT, 'scripts/cmux/dispatch-record.schema.json'), 'utf8'))

// A2 (positive) — the shipped default roster must validate clean against its
// own schema. This fixture is load-bearing: without it, every negative case
// below would pass vacuously against a validator that rejects everything.
test('roster.default.json validates against roster.schema.json', () => {
  assert.deepEqual(validate(rosterSchema, roster), [])
})

// A6 semantic assertions ------------------------------------------------

test('roles ∪ SUBAGENT_ONLY equals the set of agents/*.md basenames (two-directional)', () => {
  const agentNames = new Set(listAgents().map((f) => f.replace(/\.md$/, '')))
  const rosterNames = new Set([...Object.keys(roster.roles), ...SUBAGENT_ONLY])
  assert.deepEqual(rosterNames, agentNames)
})

test('every role\'s profile is a key of profiles', () => {
  const profileNames = new Set(Object.keys(roster.profiles))
  for (const [name, role] of Object.entries(roster.roles)) {
    assert.ok(profileNames.has(role.profile), `role ${name} references unknown profile ${role.profile}`)
  }
})

test('every role\'s model is in MODEL_ALIASES or matches /^claude-/', () => {
  for (const [name, role] of Object.entries(roster.roles)) {
    const ok = MODEL_ALIASES.includes(role.model) || /^claude-/.test(role.model)
    assert.ok(ok, `role ${name} has unrecognized model ${role.model}`)
  }
})

test('the set of roles with pane true equals PANE_ROLES exactly', () => {
  const paneRoles = new Set(Object.entries(roster.roles).filter(([, r]) => r.pane === true).map(([name]) => name))
  assert.deepEqual(paneRoles, new Set(PANE_ROLES))
})

test('no profile description matches /cannot run commands/i', () => {
  for (const [name, profile] of Object.entries(roster.profiles)) {
    assert.ok(!/cannot run commands/i.test(profile.description), `profile ${name} description matches the forbidden phrase`)
  }
})

test('every profile\'s allow contains both returns_write and signals_append', () => {
  for (const [name, profile] of Object.entries(roster.profiles)) {
    assert.ok(profile.allow.includes('returns_write'), `profile ${name} missing returns_write`)
    assert.ok(profile.allow.includes('signals_append'), `profile ${name} missing signals_append`)
  }
})

test('build-validator\'s profile is validator', () => {
  assert.equal(roster.roles['build-validator'].profile, 'validator')
})

// A6 schema meta-tests ----------------------------------------------------

test('roster.schema.json: permission_mode enum is exactly [dontAsk]', () => {
  assert.deepEqual(rosterSchema.properties.profiles.additionalProperties.properties.permission_mode.enum, ['dontAsk'])
})

test('roster.schema.json: Profile node has no deny/tools/disable_slash_commands and additionalProperties is false', () => {
  const profileNode = rosterSchema.properties.profiles.additionalProperties
  assert.equal(profileNode.additionalProperties, false)
  assert.ok(!('deny' in profileNode.properties))
  assert.ok(!('tools' in profileNode.properties))
  assert.ok(!('disable_slash_commands' in profileNode.properties))
})

test('dispatch-record.schema.json: composed profile node has no deny/tools/disable_slash_commands and additionalProperties is false', () => {
  const profileNode = dispatchRecordSchema.properties.profile
  assert.equal(profileNode.additionalProperties, false)
  assert.ok(!('deny' in profileNode.properties))
  assert.ok(!('tools' in profileNode.properties))
  assert.ok(!('disable_slash_commands' in profileNode.properties))
})
