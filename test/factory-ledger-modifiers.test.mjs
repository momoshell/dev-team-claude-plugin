import { test } from 'node:test'

import assert from 'node:assert/strict'

import {
  MODIFIER_ATTEMPT_OUTCOMES, MUTATION_ANCHOR_CORRECTIONS, MUTATION_ANCHOR_REFUSALS, ADVISOR_AB_INCOMPLETE_REASONS,
} from '../scripts/factory/ledger.mjs'

import { MODIFIER_OUTCOMES, MUTATION_CORRECTION_OUTCOMES, MUTATION_CORRECTION_REFUSALS } from '../crew/drive.mjs'

import { fixture } from './factory-ledger.test.mjs'



test('modifier attempt outcome register stays equal to the driver enum', () => {
  assert.deepEqual(MODIFIER_ATTEMPT_OUTCOMES, MODIFIER_OUTCOMES)
})

test('ADVISOR_AB_INCOMPLETE_REASONS is the exact frozen vocabulary', () => {
  assert.deepEqual([...ADVISOR_AB_INCOMPLETE_REASONS], [
    'envelope-missing', 'envelope-unreadable', 'envelope-role-mismatch',
    'dispatch-id-mismatch', 'dispatch-not-attested', 'findings-absent',
    'finding-malformed', 'duplicate-key', 'unadjudicated-finding',
    'skipped-finding', 'note-not-in-journal', 'note-not-injected',
    'adjudication-malformed', 'adjudication-unknown-dispatch',
    'adjudication-unknown-finding', 'duplicate-adjudication',
    'numerator-exceeds-denominator',
  ])
  assert.equal(Object.isFrozen(ADVISOR_AB_INCOMPLETE_REASONS), true)
})

test('F1', () => {
  assert.deepEqual(MUTATION_ANCHOR_CORRECTIONS, MUTATION_CORRECTION_OUTCOMES)
  assert.deepEqual(MUTATION_ANCHOR_REFUSALS, MUTATION_CORRECTION_REFUSALS)
})
