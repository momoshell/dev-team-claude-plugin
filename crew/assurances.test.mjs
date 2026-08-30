import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ASSURANCE_ALIASES, ASSURANCE_ALIAS_OF, ASSURANCE_NAMES, ASSURANCES,
  DEFAULT_ASSURANCE, assuranceRank, canonicalAssurance,
} from './assurances.mjs'

const NAMES = ['quick', 'standard', 'rigorous']
const ALIASES = ['mechanical', 'build', 'judge']

function sourceText() {
  return readFileSync(new URL('./assurances.mjs', import.meta.url), 'utf8')
}

test('assurance presets are closed and ordered from quick to rigorous', () => {
  assert.deepEqual(ASSURANCE_NAMES, NAMES)
  assert.deepEqual(Object.keys(ASSURANCES), NAMES)
  assert.deepEqual(Object.keys(ASSURANCE_ALIASES), ALIASES)
  assert.deepEqual(Object.keys(ASSURANCE_ALIAS_OF), NAMES)
  assert.deepEqual(NAMES.map((name) => assuranceRank(name)), [0, 1, 2])
})

test('preset aliases have one literal source and agree in both directions', () => {
  const sourceAliases = [...sourceText().matchAll(/^\s*alias:\s*['"]([^'"]+)['"]/gm)].map((match) => match[1])
  assert.deepEqual(sourceAliases, ALIASES)
  for (const [index, name] of NAMES.entries()) {
    const alias = ASSURANCES[name].alias
    assert.equal(ASSURANCE_ALIASES[alias], name)
    assert.equal(ASSURANCE_ALIAS_OF[name], alias)
    assert.equal(canonicalAssurance(alias), name)
    assert.equal(canonicalAssurance(name), name)
    assert.equal(sourceAliases[index], alias)
  }
  assert.equal(Object.keys(ASSURANCE_ALIASES).length, NAMES.length)
  assert.equal(canonicalAssurance('not-declared'), null)
  assert.equal(canonicalAssurance(null), null)
  assert.equal(canonicalAssurance(42), null)
})

test('assurance ranks accept aliases and reject unknown values', () => {
  assert.deepEqual(ALIASES.map((alias) => assuranceRank(alias)), [0, 1, 2])
  assert.equal(assuranceRank('not-declared'), null)
  assert.equal(assuranceRank(null), null)
  assert.equal(DEFAULT_ASSURANCE, 'standard')
})

test('assurance declarations do not serialize staffing vocabulary', () => {
  const staffing = /\b(?:planner|builder|reviewer|tech[ _-]?lead|lead|seat|seats|roster|model|effort)\b/i
  assert.equal(staffing.test('planner, builder, reviewer; no lead'), true)
  assert.equal(staffing.test(JSON.stringify(ASSURANCES)), false)
})

test('assurance declarations and derived maps are deeply frozen and import-free', () => {
  assert.equal(Object.isFrozen(ASSURANCES), true)
  assert.equal(Object.isFrozen(ASSURANCE_NAMES), true)
  assert.equal(Object.isFrozen(ASSURANCE_ALIASES), true)
  assert.equal(Object.isFrozen(ASSURANCE_ALIAS_OF), true)
  for (const name of NAMES) assert.equal(Object.isFrozen(ASSURANCES[name]), true)
  assert.doesNotMatch(sourceText(), /^\s*import\b/m)
})
