import { test } from 'node:test'

import assert from 'node:assert/strict'

import {
  isoMs, DRIVER_GONE_THRESHOLD_MS, SESSION_STATUS_ABSENT, projectSessions,
} from '../scripts/factory/ledger.mjs'

import { fixture } from './factory-ledger.test.mjs'



test('T1: isoMs is symmetric across the number-to-string replay boundary', () => {
  for (const value of [0, 1, 1000, Date.now(), 253402300799999]) {
    const once = isoMs(value)
    assert.equal(isoMs(once), once, `isoMs round-trip changed ${value}`)
  }
})

test('C1: an old heartbeat never changes settlement', () => {
  assert.equal(DRIVER_GONE_THRESHOLD_MS, 60_000)
  assert.equal(Object.isFrozen(SESSION_STATUS_ABSENT), true)
  const now = Date.parse('2026-09-11T12:00:00.000Z')
  const before = [
    { adw_id: 'fresh', status: 'running', ended_at: null, outcome: null, terminal_reason: null, last_heartbeat_at: isoMs(now - DRIVER_GONE_THRESHOLD_MS + 1) },
    { adw_id: 'stale', status: 'running', ended_at: null, outcome: null, terminal_reason: null, last_heartbeat_at: isoMs(now - DRIVER_GONE_THRESHOLD_MS) },
    { adw_id: 'terminal', status: 'ok', ended_at: isoMs(now - 1), outcome: 'success', terminal_reason: 'natural-completion', last_heartbeat_at: isoMs(now - 2 * DRIVER_GONE_THRESHOLD_MS) },
    { adw_id: 'missing-heartbeat', status: 'running', ended_at: null, last_heartbeat_at: null },
    { adw_id: 'invalid-heartbeat', status: 'running', ended_at: null, last_heartbeat_at: 'not-a-timestamp' },
  ]
  const projected = projectSessions(before, { now })
  assert.deepEqual(projected, before)
  assert.notStrictEqual(projected[1], before[1])
  assert.equal(projected[1].status, 'running')
  assert.equal(projected[1].ended_at, null)
  assert.equal(projected[1].outcome, null)
  assert.equal(projected[1].terminal_reason, null)
})
