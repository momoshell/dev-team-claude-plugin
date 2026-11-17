import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROVIDER_BACKOFF_LADDER_MS, PROVIDER_FAILURE_KINDS, PROVIDER_RESET_ABSENT, PROVIDER_RESET_SETTLE_MS, PROVIDER_RETRY_ACTIONS,
  PROVIDER_RETRY_MAX, PROVIDER_RETRY_TOTAL_WAIT_MS, acpProviderFailureKind, acpTextReset, providerRetryDecision,
} from './provider.mjs'

test('pi provider messages classify only measured failures and retain retry policy', () => {
  const overload = 'Codex error: Our servers are currently overloaded. Please try again later.'
  const limit = 'Codex error: The usage limit has been reached'
  const serverKind = acpProviderFailureKind('pi-agent-error', overload)
  const limitKind = acpProviderFailureKind('pi-agent-error', limit)
  assert.equal(serverKind, PROVIDER_FAILURE_KINDS.SERVER_ERROR)
  assert.equal(limitKind, PROVIDER_FAILURE_KINDS.RATE_LIMIT)
  assert.equal(providerRetryDecision({ kind: serverKind }).action, 'backoff')
  assert.equal(providerRetryDecision({ kind: serverKind }).retry, true)
  assert.equal(providerRetryDecision({ kind: limitKind }).action, 'park')
  assert.equal(providerRetryDecision({ kind: limitKind }).retry, false)
  for (const message of ['unrecognised', undefined, null, 42, {}, `${overload} `]) assert.equal(acpProviderFailureKind('pi-agent-error', message), null)
  for (const message of [overload, limit]) assert.equal(acpProviderFailureKind('other', message), null)
  assert.equal(acpProviderFailureKind('rate_limit', overload), PROVIDER_FAILURE_KINDS.RATE_LIMIT)
  assert.equal(acpProviderFailureKind('overloaded', limit), PROVIDER_FAILURE_KINDS.SERVER_ERROR)
  assert.equal(acpProviderFailureKind('authentication_failed', overload), PROVIDER_FAILURE_KINDS.AUTHENTICATION_FAILED)
})

test('ACP text reset resolves strict wall-clock rollover and DST instants', () => {
  const rows = [
    ['resets 11pm (Europe/Belgrade)', '2026-10-10T20:28:54Z', '2026-10-10T21:00:00Z'],
    ['resets 11:40pm (Europe/Belgrade)', '2026-10-05T21:39:00Z', '2026-10-05T21:40:00Z'],
    ['resets 11pm (Europe/Belgrade)', '2026-10-10T21:00:00Z', '2026-10-11T21:00:00Z'],
    ['resets 12am (Europe/Belgrade)', '2026-10-10T20:00:00Z', '2026-10-10T22:00:00Z'],
    ['resets 12pm (Europe/Belgrade)', '2026-10-10T08:00:00Z', '2026-10-10T10:00:00Z'],
    ['resets 3am (Europe/Belgrade)', '2026-10-25T00:00:00Z', '2026-10-25T02:00:00Z'],
    ['resets 2:30am (Europe/Belgrade)', '2026-10-25T01:00:00Z', '2026-10-25T01:30:00Z'],
    ['resets 2:30am (Europe/Belgrade)', '2026-03-28T23:00:00Z', '2026-03-30T00:30:00Z'],
    ['resets 11pm (America/New_York)', '2026-10-10T20:00:00Z', '2026-10-11T03:00:00Z'],
    ['resets 11:40pm (Asia/Kolkata)', '2026-10-10T12:00:00Z', '2026-10-10T18:10:00Z'],
  ]
  for (const [text, at, expected] of rows) assert.deepEqual(acpTextReset(text, Date.parse(at)), { at_ms: Date.parse(expected), absent_reason: null })
  const reason = PROVIDER_RESET_ABSENT.ACP_TEXT_UNPARSEABLE
  for (const text of [null, '', 'resets 13pm (UTC)', 'resets 11:99pm (UTC)', 'resets 11pmx (UTC)', 'resets 11pm (Not/AZone)']) assert.deepEqual(acpTextReset(text, Date.parse('2026-01-01T00:00:00Z')), { at_ms: null, absent_reason: reason })
  for (const at of [NaN, Infinity, 8.64e15 + 1]) assert.deepEqual(acpTextReset('resets 11pm (UTC)', at), { at_ms: null, absent_reason: reason })
})

test('#887 provider retry decisions consume kind, attempt, and total-wait bounds', () => {
  assert.equal(PROVIDER_BACKOFF_LADDER_MS.length, PROVIDER_RETRY_MAX)
  assert.ok(PROVIDER_BACKOFF_LADDER_MS.every((wait) => wait >= 60_000))
  assert.equal(PROVIDER_RETRY_ACTIONS[PROVIDER_FAILURE_KINDS.SERVER_ERROR], 'backoff')
  assert.equal(PROVIDER_RETRY_ACTIONS[PROVIDER_FAILURE_KINDS.RATE_LIMIT], 'park')
  assert.equal(PROVIDER_RETRY_ACTIONS[PROVIDER_FAILURE_KINDS.AUTHENTICATION_FAILED], 'refuse')

  const parked = providerRetryDecision({ kind: PROVIDER_FAILURE_KINDS.RATE_LIMIT, reset: { at_ms: 1000 }, at: 1000 })
  assert.equal(parked.retry, true)
  assert.equal(parked.waited_on, 'reset-time')
  assert.equal(parked.wait_ms, 60_000)
  const past = providerRetryDecision({ kind: PROVIDER_FAILURE_KINDS.RATE_LIMIT, reset: { at_ms: 1000 }, at: 100_000 })
  assert.equal(past.retry, true)
  assert.equal(past.wait_ms, 0)
  assert.equal(past.waited_on, 'reset-time')
  const unknown = providerRetryDecision({ kind: PROVIDER_FAILURE_KINDS.RATE_LIMIT, reset: { at_ms: null, absent_reason: PROVIDER_RESET_ABSENT.NO_FRAME } })
  assert.equal(unknown.retry, false)
  assert.equal(unknown.attempts_spent, 0)
  assert.match(unknown.why, /no reset time/)
  const auth = providerRetryDecision({ kind: PROVIDER_FAILURE_KINDS.AUTHENTICATION_FAILED })
  assert.equal(auth.retry, false)
  assert.equal(auth.action, 'refuse')
  const spent = providerRetryDecision({ kind: PROVIDER_FAILURE_KINDS.SERVER_ERROR, attempts: PROVIDER_RETRY_MAX })
  assert.equal(spent.retry, false)
  assert.equal(spent.attempts_spent, PROVIDER_RETRY_MAX)
  const none = providerRetryDecision({ kind: null })
  assert.equal(none.retry, false)
  assert.equal(none.action, 'none')
  const exactTotalWait = providerRetryDecision({
    kind: PROVIDER_FAILURE_KINDS.RATE_LIMIT,
    reset: { at_ms: PROVIDER_RETRY_TOTAL_WAIT_MS - PROVIDER_RESET_SETTLE_MS }, at: 0,
  })
  assert.equal(exactTotalWait.retry, true)
  assert.equal(exactTotalWait.wait_ms, PROVIDER_RETRY_TOTAL_WAIT_MS)
  const beyondTotalWait = providerRetryDecision({
    kind: PROVIDER_FAILURE_KINDS.RATE_LIMIT,
    reset: { at_ms: PROVIDER_RETRY_TOTAL_WAIT_MS - PROVIDER_RESET_SETTLE_MS }, waitedMs: 1, at: 0,
  })
  assert.equal(beyondTotalWait.retry, false)
  assert.match(beyondTotalWait.why, /further out than the total wait/)
})
