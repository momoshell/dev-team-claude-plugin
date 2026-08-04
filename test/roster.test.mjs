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

// be-06-01 S3 (amended): coherence guard between roster required_sections and
// what the agent definition actually authors. This guard is an INDEPENDENT
// ORACLE, deliberately not sharing code with ladder.checkSections:
//   (1) NO FENCE STRIPPING, asymmetric on purpose — checkSections strips
//       fences because it reads the worker's RETURN BODY, where a fenced
//       heading is an illustration and must not count (backend-notes.md:16);
//       this guard reads an agent DEFINITION, where a fenced block is the
//       output TEMPLATE the model is instructed to emit — agents/plan-
//       reviewer.md:33-50 fences the whole Output Format including
//       `### Must Fix` (:36) and `### Should Fix` (:39); stripping fences
//       here would make the guard unsatisfiable for a role whose roster
//       entry is correct.
//   (2) NO SHARED CODE WITH checkSections — not an import, not a helper,
//       not a re-export. A guard that runs the implementation it is
//       guarding can only prove self-consistency, not correctness — the
//       duplication is the point (ratified vacuity lesson, qa-notes).
//   (3) LEVEL >= 2 AND CASE-FOLDED PREFIX mirror the production rule by
//       specification, not by call. If S1's predicate ever changes, this
//       regex must be changed to match by hand — that hand-edit is the
//       review checkpoint.
// No role is exempted: all six pane+markdown roles must pass this guard as
// written; if one does not, the roster value is wrong, not the guard.
test('every pane+markdown role\'s required_sections is authored in its agents/<role>.md (independent oracle)', () => {
  const HEADING_RE = /^#{2,6}[ \t]+(.+?)[ \t]*$/gm
  for (const [name, role] of Object.entries(roster.roles)) {
    if (role.pane !== true || role.return.kind !== 'markdown') continue
    const body = readFileSync(join(ROOT, 'agents', `${name}.md`), 'utf8')
    const authored = [...body.matchAll(HEADING_RE)].map((m) => m[1].trim())
    for (const req of role.return.required_sections) {
      const needle = req.trim().toLowerCase()
      const satisfied = authored.some((h) => h.toLowerCase().startsWith(needle))
      assert.ok(satisfied, `role ${name} required_sections entry ${JSON.stringify(req)} is not authored as a heading in agents/${name}.md`)
    }
  }
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
