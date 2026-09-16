import { test } from 'node:test'

import assert from 'node:assert/strict'

import { scratchDir } from './helpers.mjs'

import {
  CELL_FAILURE_KINDS, CELL_FAILURE_ATTRIBUTIONS, CELL_RATE_FLOOR, TURN_TRANSPORTS,
} from '../scripts/factory/ledger.mjs'

import { writeTurnsCorpusJournal, turnsCorpusPayload, builderTurnRole, fixture } from './factory-ledger.test.mjs'



test('cell failure attributions are a frozen axis separate from failure kinds', () => {
  assert.equal(Object.isFrozen(CELL_FAILURE_ATTRIBUTIONS), true)
  assert.deepEqual([...CELL_FAILURE_ATTRIBUTIONS], ['cell', 'host'])
  assert.equal([...CELL_FAILURE_ATTRIBUTIONS].some((value) => CELL_FAILURE_KINDS.includes(value)), false)
})

test('A1 turns breakdown separates two transports', () => {
  const root = scratchDir('turns-corpus-a1-')
  const entries = Array.from({ length: CELL_RATE_FLOOR }, (_, index) => ({ turns: index + 1, status: index < 3 ? 'insufficient' : 'done' }))
  writeTurnsCorpusJournal(root, 'json', entries, { transport: 'headless-json' })
  writeTurnsCorpusJournal(root, 'rpc', entries.map((entry, index) => ({ ...entry, status: index < 7 ? 'insufficient' : 'done' })), { transport: 'headless-rpc' })
  const role = builderTurnRole(turnsCorpusPayload(root))
  const json = role.by_transport.find((entry) => entry.transport === 'headless-json')
  const rpc = role.by_transport.find((entry) => entry.transport === 'headless-rpc')
  assert.deepEqual({ numerator: json.insufficient_with_turns.numerator, denominator: json.insufficient_with_turns.denominator }, { numerator: 3, denominator: CELL_RATE_FLOOR })
  assert.deepEqual({ numerator: rpc.insufficient_with_turns.numerator, denominator: rpc.insufficient_with_turns.denominator }, { numerator: 7, denominator: CELL_RATE_FLOOR })
  assert.notEqual(json.insufficient_with_turns.numerator, rpc.insufficient_with_turns.numerator)
})

test('C1 every turns rate carries numerator and denominator', () => {
  const root = scratchDir('turns-corpus-c1-')
  writeTurnsCorpusJournal(root, 'lane', Array.from({ length: CELL_RATE_FLOOR }, (_, index) => ({ turns: index % 2, status: index % 3 === 0 ? 'insufficient' : 'done' })))
  const payload = turnsCorpusPayload(root)
  for (const role of payload.by_role) {
    for (const axis of ['by_transport', 'by_provider', 'by_model']) {
      for (const cell of role[axis]) {
        for (const name of ['insufficient_with_turns', 'zero_turn', 'overlap']) {
          const rate = cell[name]
          if (rate.rate === null) continue
          assert.ok(Number.isFinite(rate.numerator) && Number.isInteger(rate.numerator))
          assert.ok(Number.isFinite(rate.denominator) && Number.isInteger(rate.denominator))
        }
      }
    }
  }
})

test('D1 below-floor turns cell is unmeasured with named floor', () => {
  const root = scratchDir('turns-corpus-d1-')
  writeTurnsCorpusJournal(root, 'lane', Array.from({ length: CELL_RATE_FLOOR - 1 }, () => ({ turns: 1, status: 'done' })))
  const cell = builderTurnRole(turnsCorpusPayload(root)).by_transport.find((entry) => entry.transport === 'headless-json')
  assert.equal(cell.zero_turn.rate, null)
  assert.equal(cell.zero_turn.measured, false)
  assert.equal(cell.zero_turn.denominator, CELL_RATE_FLOOR - 1)
  assert.match(cell.zero_turn.reason, new RegExp(String(CELL_RATE_FLOOR)))
})

test('F1 absent transport is unmeasured instead of zero', () => {
  const root = scratchDir('turns-corpus-f1-')
  writeTurnsCorpusJournal(root, 'lane', [{ turns: 1, status: 'done' }], { transport: 'headless-rpc' })
  const role = builderTurnRole(turnsCorpusPayload(root))
  assert.deepEqual(role.by_transport.map((entry) => entry.transport).sort(), [...TURN_TRANSPORTS].sort())
  const absent = role.by_transport.find((entry) => entry.transport === 'headless-json')
  assert.equal(absent.zero_turn.denominator, 0)
  assert.equal(absent.zero_turn.rate, null)
  assert.equal(absent.zero_turn.measured, false)
  assert.match(absent.zero_turn.reason, new RegExp(String(CELL_RATE_FLOOR)))
})
