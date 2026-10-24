import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, rmSync, cpSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_ROLES, TIERS, parseAgent } from './protocols.mjs'
import { resolveAgents } from './agents.mjs'
import { scratchDir } from '../test/helpers.mjs'

const roster = JSON.parse(readFileSync(new URL('./roster.json', import.meta.url), 'utf8'))
const AGENTS_DIR = fileURLToPath(new URL('./agents/', import.meta.url))

// A private copy of the committed definitions, so a test can edit them.
function scratch() {
  const dir = scratchDir('agents-test-')
  cpSync(AGENTS_DIR, dir, { recursive: true })
  return dir
}
function edit(dir, role, change) {
  const path = join(dir, `${role}.md`)
  writeFileSync(path, change(readFileSync(path, 'utf8')))
}
function withScratch(fn) {
  const dir = scratch()
  try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('the five committed definitions parse clean and link their own charter', () => {
  for (const role of AGENT_ROLES) {
    const { fields, body, defects } = parseAgent(readFileSync(join(AGENTS_DIR, `${role}.md`), 'utf8'))
    assert.deepEqual(defects, [], role)
    assert.equal(fields.name, role)
    assert.equal(fields.role, role)
    assert.equal(body, `Read and follow [the ${role} charter](../roles/${role}.md).\n`)
  }
})

// MUTATION: change any model, effort, fallback or null tier in a definition and this tier drifts from the roster.
test('every tier resolves to exactly the roster cells, null roles unseated', () => {
  assert.deepEqual(TIERS, Object.keys(roster.tiers))
  for (const tier of TIERS) {
    const { advisor, ...cells } = roster.tiers[tier]
    const seats = Object.fromEntries(Object.entries(cells).filter(([, cell]) => cell !== null))
    const resolved = resolveAgents(tier)
    assert.deepEqual(resolved, { seats, advisor }, tier)
    assert.deepEqual(Object.keys(resolved.seats), AGENT_ROLES.filter((role) => role in seats), tier)
  }
})

// MUTATION: hardcode the roster cells and an edited definition no longer changes the resolution.
test('an edited definition changes the resolved cell, and only in the tier it overrides', () => withScratch((dir) => {
  edit(dir, 'builder', (text) => text.replace('tiers: {"judge":{"effort":"xhigh"}}', 'tiers: {"judge":{"model":"openai/changed","agent":"pi","effort":"max","fallback":[{"agent":"pi","model":"openai/spare"}]}}'))
  assert.deepEqual(resolveAgents('judge', dir).seats.builder, {
    provider: 'openai', id: 'changed', agent: 'pi', effort: 'max',
    fallback: [{ provider: 'openai', id: 'spare', agent: 'pi', effort: 'max' }],
  })
  assert.deepEqual(resolveAgents('build', dir).seats.builder, roster.tiers.build.builder)
  edit(dir, 'builder', (text) => text.replace('effort: high', 'effort: low'))
  assert.equal(resolveAgents('build', dir).seats.builder.effort, 'low')
}))

test('nothing leaks between calls: every call reads the files afresh and returns its own objects', () => withScratch((dir) => {
  const first = resolveAgents('build', dir)
  first.seats.planner.effort = 'mutated'
  first.seats.lead.fallback.push('mutated')
  const second = resolveAgents('build', dir)
  assert.equal(second.seats.planner.effort, 'high')
  assert.equal(second.seats.lead.fallback.length, 1)
  edit(dir, 'planner', (text) => text.replace('effort: high', 'effort: low'))
  assert.equal(resolveAgents('build', dir).seats.planner.effort, 'low')
}))

// MUTATION: treat a null tier as inherit and the lead is seated in mechanical.
test('a null tier override unseats a role, and a missing one inherits', () => withScratch((dir) => {
  assert.equal('lead' in resolveAgents('mechanical', dir).seats, false)
  assert.equal('lead' in resolveAgents('build', dir).seats, true)
  edit(dir, 'lead', (text) => text.replace('tiers: {"mechanical":null}', 'tiers: {}'))
  assert.equal('lead' in resolveAgents('mechanical', dir).seats, true)
}))

test('a fallback inherits the seat effort, and an empty chain is no fallback key', () => withScratch((dir) => {
  edit(dir, 'lead', (text) => text.replace(',"effort":"high"}]', '}]'))
  assert.equal(resolveAgents('build', dir).seats.lead.fallback[0].effort, 'high')
  edit(dir, 'lead', (text) => text.replace('effort: high', 'effort: low'))
  assert.equal(resolveAgents('build', dir).seats.lead.fallback[0].effort, 'low')
  edit(dir, 'lead', (text) => text.replace(/fallback: .*\n/, 'fallback: []\n'))
  assert.equal('fallback' in resolveAgents('build', dir).seats.lead, false)
}))

// MUTATION: ignore a role's advisor and a declared advisor never reaches the tier.
test('a declared advisor is normalized; null elsewhere does not erase it and a clash refuses', () => withScratch((dir) => {
  const advisor = (model, effort) => `advisor: {"agent":"pi","model":"${model}","effort":"${effort}"}`
  edit(dir, 'reviewer', (text) => text.replace('advisor: null', advisor('openai/gpt-6-luna', 'medium')))
  assert.deepEqual(resolveAgents('build', dir).advisor, { provider: 'openai', id: 'gpt-6-luna', agent: 'pi', effort: 'medium' })
  edit(dir, 'planner', (text) => text.replace('advisor: null', advisor('openai/gpt-6-luna', 'medium')))
  assert.equal(resolveAgents('build', dir).advisor.id, 'gpt-6-luna')
  edit(dir, 'planner', (text) => text.replace(/advisor: .*\n/, advisor('openai/gpt-6-luna', 'high') + '\n'))
  assert.throws(() => resolveAgents('build', dir), /conflicting advisors.*planner.*reviewer/)
  // The lead is unseated in mechanical, so its clashing advisor is not a declaration there.
  edit(dir, 'planner', (text) => text.replace(/advisor: .*\n/, 'advisor: null\n'))
  edit(dir, 'lead', (text) => text.replace('advisor: null', advisor('openai/other', 'low')))
  assert.equal(resolveAgents('mechanical', dir).advisor.id, 'gpt-6-luna')
  assert.throws(() => resolveAgents('build', dir), /conflicting advisors.*lead.*reviewer/)
}))

// MUTATION: skip the identity check and a file seated under another role's name resolves.
test('a malformed, empty, missing or misnamed definition refuses, naming the file', () => withScratch((dir) => {
  assert.throws(() => resolveAgents('ultra', dir), /unknown tier "ultra"/)
  assert.throws(() => resolveAgents('ultra', join(dir, 'does-not-exist')), /unknown tier/)
  edit(dir, 'planner', () => '')
  assert.throws(() => resolveAgents('build', dir), (error) => error.message.includes('planner.md') && error.message.includes('frontmatter'))
  edit(dir, 'planner', () => readFileSync(join(AGENTS_DIR, 'planner.md'), 'utf8'))
  edit(dir, 'builder', (text) => text.replace('effort: high', 'effort: extreme'))
  edit(dir, 'reviewer', (text) => text.replace('name: reviewer', 'name: planner'))
  assert.throws(() => resolveAgents('build', dir), (error) => error.message.includes('builder.md: effort') && error.message.includes('reviewer.md: name and role'))
  rmSync(join(dir, 'tech-lead.md'))
  edit(dir, 'builder', () => readFileSync(join(AGENTS_DIR, 'builder.md'), 'utf8'))
  edit(dir, 'reviewer', () => readFileSync(join(AGENTS_DIR, 'reviewer.md'), 'utf8'))
  assert.throws(() => resolveAgents('judge', dir), (error) => error.code === 'ENOENT' && error.path === join(dir, 'tech-lead.md') && error.cause.code === 'ENOENT')
}))

// A permission error is not reproducible under root; the check is skipped there, not faked.
test('an unreadable definition keeps the filesystem error and is not read as no seat', { skip: process.getuid?.() === 0 }, () => withScratch((dir) => {
  chmodSync(join(dir, 'lead.md'), 0)
  assert.throws(() => resolveAgents('mechanical', dir), (error) => error.code === 'EACCES' && error.cause.code === 'EACCES')
}))
