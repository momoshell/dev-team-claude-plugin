import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  EVIDENCE_KEYS, TASK_PROFILES, TASK_PROFILE_NAMES, executionsFor,
} from './task-profiles.mjs'
import { VARIANT_NAMES } from './variants.mjs'

const PROFILE_KEYS = [
  'implementation', 'bug_fix', 'investigation', 'code_review', 'qa_verification', 'test_authoring',
]
const EXPECTED = {
  implementation: {
    name: 'Implementation',
    outcome: 'A requested behavior or product change',
    recommended_execution: 'full',
    allowed_executions: ['directed'],
  },
  bug_fix: {
    name: 'Bug fix',
    outcome: 'A reproduced defect is removed without regression',
    recommended_execution: 'full',
    allowed_executions: ['directed', 'repair'],
  },
  investigation: {
    name: 'Investigation',
    outcome: 'A read-only, cited answer to a bounded question',
    recommended_execution: 'scout',
    allowed_executions: [],
  },
  code_review: {
    name: 'Code review',
    outcome: 'Actionable findings against a declared change set',
    recommended_execution: 'review_only',
    allowed_executions: [],
  },
  qa_verification: {
    name: 'QA verification',
    outcome: 'A declared behavior is independently checked',
    recommended_execution: 'verify_only',
    allowed_executions: [],
  },
  test_authoring: {
    name: 'Test authoring',
    outcome: 'Tests materially discriminate the intended behavior',
    recommended_execution: 'full',
    allowed_executions: ['directed'],
  },
}

function sourceText() {
  return readFileSync(new URL('./task-profiles.mjs', import.meta.url), 'utf8')
}

test('task profiles carry the closed §3.1 fields and §3.3 compatibility rows', () => {
  assert.deepEqual(TASK_PROFILE_NAMES, PROFILE_KEYS)
  assert.deepEqual(Object.keys(TASK_PROFILES), PROFILE_KEYS)
  for (const key of PROFILE_KEYS) {
    const profile = TASK_PROFILES[key]
    const expected = EXPECTED[key]
    assert.deepEqual({
      name: profile.name,
      outcome: profile.outcome,
      recommended_execution: profile.recommended_execution,
      allowed_executions: profile.allowed_executions,
    }, expected, key)
  }
})

test('profile evidence is a closed vocabulary with no orphan or invented keys', () => {
  const declared = new Set(EVIDENCE_KEYS)
  const union = new Set()
  for (const profile of Object.values(TASK_PROFILES)) {
    for (const evidence of profile.evidence) {
      assert.equal(declared.has(evidence), true, `profile evidence key is undeclared: ${evidence}`)
      union.add(evidence)
    }
  }
  assert.deepEqual([...union].sort(), [...EVIDENCE_KEYS].sort())
  assert.equal(union.size, EVIDENCE_KEYS.length)
})

test('bug-fix repair records the inherited-scope execution condition', () => {
  assert.equal(TASK_PROFILES.bug_fix.execution_conditions.repair, 'a failing run supplies inherited scope')
})

test('the compatibility matrix names only the two pending shapes beside variants', () => {
  const profileShapes = new Set()
  for (const profile of Object.values(TASK_PROFILES)) {
    profileShapes.add(profile.recommended_execution)
    for (const execution of profile.allowed_executions) profileShapes.add(execution)
  }
  const allShapes = new Set([...VARIANT_NAMES, 'review_only', 'verify_only'])
  assert.deepEqual([...profileShapes].sort(), [...allShapes].sort())
  assert.equal(profileShapes.has('review_only'), true)
  assert.equal(profileShapes.has('verify_only'), true)
  assert.equal(VARIANT_NAMES.includes('review_only'), false)
  assert.equal(VARIANT_NAMES.includes('verify_only'), false)
  const source = sourceText()
  assert.equal(source.includes('EXECUTION_SHAPES'), false)
  assert.equal(source.includes('executionStatus'), false)
  assert.doesNotMatch(source, /^\s*import\b/m)
})

test('executionsFor returns the recommendation first and null for an undeclared profile', () => {
  for (const key of PROFILE_KEYS) {
    assert.deepEqual(executionsFor(key), [EXPECTED[key].recommended_execution, ...EXPECTED[key].allowed_executions])
  }
  assert.equal(executionsFor('not-a-profile'), null)
})

test('profile declarations and their nested data are deeply frozen', () => {
  assert.equal(Object.isFrozen(TASK_PROFILES), true)
  assert.equal(Object.isFrozen(TASK_PROFILE_NAMES), true)
  assert.equal(Object.isFrozen(EVIDENCE_KEYS), true)
  for (const key of PROFILE_KEYS) {
    const profile = TASK_PROFILES[key]
    assert.equal(Object.isFrozen(profile), true)
    assert.equal(Object.isFrozen(profile.evidence), true)
    assert.equal(Object.isFrozen(profile.allowed_executions), true)
    assert.equal(Object.isFrozen(profile.execution_conditions), true)
  }
})
