import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { TASK_PROFILES } from './task-profiles.mjs'
import { ASSURANCE_ALIASES, ASSURANCES } from './assurances.mjs'
import { VARIANT_NAMES } from './variants.mjs'
import {
  MIGRATION_DEFAULTS, REQUEST_ALIASES, RESOLUTION_SOURCES,
  RunConfigurationError, resolveRunConfiguration,
} from './run-configuration.mjs'

const PROFILE_KEYS = Object.freeze([
  'implementation', 'bug_fix', 'investigation', 'code_review', 'qa_verification', 'test_authoring',
])
const SHAPE_KEYS = Object.freeze(['full', 'directed', 'scout', 'repair', 'review_only', 'verify_only'])
const COMPATIBLE = Object.freeze({
  implementation: Object.freeze(['full', 'directed']),
  bug_fix: Object.freeze(['full', 'directed', 'repair']),
  investigation: Object.freeze(['scout']),
  code_review: Object.freeze(['review_only']),
  qa_verification: Object.freeze(['verify_only']),
  test_authoring: Object.freeze(['full', 'directed']),
})
const SHAPE_STATUS = Object.freeze({
  full: 'existing',
  directed: 'existing',
  scout: 'existing',
  repair: 'existing',
  review_only: 'declared-pending',
  verify_only: 'declared-pending',
})
const ALIAS_PAIRS = Object.freeze([
  ['mechanical', 'quick'], ['build', 'standard'], ['judge', 'rigorous'],
])

const declarations = {
  profiles: TASK_PROFILES,
  variantNames: VARIANT_NAMES,
  assurances: ASSURANCES,
  assuranceAliases: ASSURANCE_ALIASES,
}

function resolve(request, injected = declarations) {
  return resolveRunConfiguration(request, injected)
}

function refusal(request, injected = declarations) {
  try {
    resolve(request, injected)
    return null
  } catch (error) {
    return error
  }
}

function assertRefusal(request, code, injected = declarations) {
  const error = refusal(request, injected)
  assert.equal(error instanceof RunConfigurationError, true, `expected ${code} refusal, found ${error}`)
  assert.equal(error?.code, code)
  assert.equal(error?.name, 'RunConfigurationError')
  return error
}

function sourceText() {
  return readFileSync(new URL('./run-configuration.mjs', import.meta.url), 'utf8')
}

test('the complete §3.3 compatibility matrix resolves valid pairs explicitly', () => {
  let pairs = 0
  for (const profile of PROFILE_KEYS) {
    for (const execution of COMPATIBLE[profile]) {
      pairs += 1
      const resolved = resolve({ profile, execution })
      assert.deepEqual(resolved.profile, { requested: profile, effective: profile, source: 'explicit' })
      assert.deepEqual(resolved.execution, {
        requested: execution,
        effective: execution,
        source: 'explicit',
        status: SHAPE_STATUS[execution],
      })
      assert.deepEqual(resolved.assurance, {
        requested: null,
        effective: 'standard',
        source: 'migration_default',
      })
    }
  }
  assert.equal(pairs, 10)
})

test('every incompatible matrix pair refuses with selected values and all allowed shapes', () => {
  const invalidPairs = PROFILE_KEYS.flatMap((profile) => SHAPE_KEYS
    .filter((execution) => !COMPATIBLE[profile].includes(execution))
    .map((execution) => [profile, execution]))
  assert.equal(invalidPairs.length, 26)
  for (const [profile, execution] of invalidPairs) {
    const error = assertRefusal({ profile, execution }, 'incompatible_execution')
    const message = String(error.message)
    assert.equal(message.includes(profile), true)
    assert.equal(message.includes(execution), true)
    for (const allowed of COMPATIBLE[profile]) assert.equal(message.includes(allowed), true)
  }
})

test('canonical flags and deprecated aliases conflict from raw own-field presence', () => {
  const executionCases = [
    { execution: 'full', variant: 'full' },
    { execution: 'full', variant: 'directed' },
    { execution: '', variant: 'full' },
    { execution: 'full', variant: '' },
  ]
  for (const request of executionCases) {
    const error = assertRefusal(request, 'alias_conflict')
    assert.equal(error.message.includes('execution'), true)
    assert.equal(error.message.includes('variant'), true)
  }
  const assuranceCases = [
    { assurance: 'standard', tier: 'build' },
    { assurance: 'quick', tier: 'judge' },
    { assurance: '', tier: 'build' },
    { assurance: 'standard', tier: '' },
  ]
  for (const request of assuranceCases) {
    const error = assertRefusal(request, 'alias_conflict')
    assert.equal(error.message.includes('assurance'), true)
    assert.equal(error.message.includes('tier'), true)
  }
})

test('blank execution and assurance flags are malformed when supplied alone', () => {
  for (const field of ['execution', 'variant', 'assurance', 'tier']) {
    const error = assertRefusal({ [field]: '' }, 'invalid_request')
    assert.equal(error.message.includes('blank'), true)
  }
  const recommended = resolve({ profile: 'implementation' })
  assert.equal(recommended.execution.effective, 'full')
  assert.equal(recommended.execution.source, 'profile_recommendation')
  const defaulted = resolve({})
  assert.equal(defaulted.assurance.effective, 'standard')
  assert.equal(defaulted.assurance.source, 'migration_default')
})

test('execution resolves in canonical, alias, profile-recommendation, then migration order', () => {
  const explicit = resolve({ profile: 'implementation', execution: 'directed' })
  assert.deepEqual(explicit.execution, {
    requested: 'directed', effective: 'directed', source: 'explicit', status: 'existing',
  })
  const alias = resolve({ profile: 'implementation', variant: 'directed' })
  assert.deepEqual(alias.execution, {
    requested: 'directed', effective: 'directed', source: 'alias', status: 'existing',
  })
  const recommendation = resolve({ profile: 'implementation' })
  assert.deepEqual(recommendation.execution, {
    requested: null, effective: 'full', source: 'profile_recommendation', status: 'existing',
  })
  const migration = resolve({})
  assert.deepEqual(migration.execution, {
    requested: null, effective: 'full', source: 'migration_default', status: 'existing',
  })
})

test('assurance resolves explicitly, through tier, and by migration default', () => {
  const explicit = resolve({ assurance: 'rigorous' })
  assert.deepEqual(explicit.assurance, {
    requested: 'rigorous', effective: 'rigorous', source: 'explicit',
  })
  for (const [alias, canonical] of ALIAS_PAIRS) {
    const resolved = resolve({ tier: alias })
    assert.deepEqual(resolved.assurance, {
      requested: alias, effective: canonical, source: 'alias',
    })
  }
  const migration = resolve({})
  assert.deepEqual(migration.assurance, {
    requested: null, effective: 'standard', source: 'migration_default',
  })

  const recommendedProfiles = {
    ...TASK_PROFILES,
    implementation: { ...TASK_PROFILES.implementation, recommended_assurance: 'rigorous' },
  }
  const recommended = resolve({ profile: 'implementation' }, { ...declarations, profiles: recommendedProfiles })
  assert.deepEqual(recommended.assurance, {
    requested: null, effective: 'rigorous', source: 'profile_recommendation',
  })
})

test('profile is explicit or legacy-missing and never inferred from free text', () => {
  const requests = [
    {},
    { profile: null },
    { profile: '' },
    { title: 'fix the crashing bug', text: 'implement the review workflow', brief: 'qa verification' },
  ]
  for (const request of requests) {
    const resolved = resolve(request)
    assert.deepEqual(resolved.profile, { requested: null, effective: null, source: 'legacy_missing' })
  }
  const explicit = resolve({ profile: 'investigation' })
  assert.deepEqual(explicit.profile, {
    requested: 'investigation', effective: 'investigation', source: 'explicit',
  })
})

test('unknown values and malformed declaration bundles refuse with vocabulary context', () => {
  const unknownProfile = assertRefusal({ profile: 'not-a-profile' }, 'unknown_profile')
  for (const profile of PROFILE_KEYS) assert.equal(unknownProfile.message.includes(profile), true)

  const unknownExecution = assertRefusal({ execution: 'not-a-shape' }, 'unknown_execution')
  for (const shape of SHAPE_KEYS) assert.equal(unknownExecution.message.includes(shape), true)

  const unknownAssurance = assertRefusal({ assurance: 'not-a-preset' }, 'unknown_assurance')
  for (const name of Object.keys(ASSURANCES)) assert.equal(unknownAssurance.message.includes(name), true)

  for (const [field, value] of [
    ['profile', 1], ['execution', 1], ['variant', 1], ['assurance', 1], ['tier', 1],
  ]) assertRefusal({ [field]: value }, 'invalid_request')
  assertRefusal(null, 'invalid_request')
  assertRefusal([], 'invalid_request')
  assertRefusal({}, 'invalid_declarations', null)
  assertRefusal({}, 'invalid_declarations', [])
  assertRefusal({}, 'invalid_declarations', { profiles: TASK_PROFILES, variantNames: VARIANT_NAMES, assurances: ASSURANCES })
})

test('resolution constants are closed and every resolved source is declared', () => {
  assert.deepEqual(RESOLUTION_SOURCES, [
    'explicit', 'alias', 'profile_recommendation', 'migration_default', 'legacy_missing',
  ])
  assert.deepEqual(MIGRATION_DEFAULTS, { execution: 'full', assurance: 'standard' })
  assert.deepEqual(REQUEST_ALIASES, { execution: 'variant', assurance: 'tier' })
  const resolved = [
    resolve({ profile: 'implementation', execution: 'directed' }),
    resolve({ profile: 'implementation', variant: 'directed' }),
    resolve({ profile: 'implementation' }),
    resolve({}),
  ]
  for (const value of resolved) {
    assert.equal(RESOLUTION_SOURCES.includes(value.profile.source), true)
    assert.equal(RESOLUTION_SOURCES.includes(value.execution.source), true)
    assert.equal(RESOLUTION_SOURCES.includes(value.assurance.source), true)
  }
})

test('execution status is derived from injected variant names, not declaration literals', () => {
  const withPendingShape = {
    ...declarations,
    variantNames: Object.freeze([...VARIANT_NAMES, 'review_only']),
  }
  const existing = resolve({ profile: 'code_review', execution: 'review_only' }, withPendingShape)
  assert.equal(existing.execution.status, 'existing')

  const withoutFull = {
    ...declarations,
    variantNames: Object.freeze(VARIANT_NAMES.filter((name) => name !== 'full')),
  }
  const pending = resolve({ execution: 'full' }, withoutFull)
  assert.equal(pending.execution.status, 'declared-pending')
  assert.equal(pending.execution.effective, 'full')
})

test('resolved axis objects and resolver constants are frozen', () => {
  const resolved = resolve({ profile: 'implementation', execution: 'directed', assurance: 'quick' })
  assert.equal(Object.isFrozen(resolved.profile), true)
  assert.equal(Object.isFrozen(resolved.execution), true)
  assert.equal(Object.isFrozen(resolved.assurance), true)
  assert.equal(Object.isFrozen(RESOLUTION_SOURCES), true)
  assert.equal(Object.isFrozen(MIGRATION_DEFAULTS), true)
  assert.equal(Object.isFrozen(REQUEST_ALIASES), true)
  assert.doesNotMatch(sourceText(), /^\s*import\b/m)
})
