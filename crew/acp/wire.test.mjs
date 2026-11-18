import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seatCommandPath, seatCommandRootPrivate } from './wire.mjs'

test('RR5 seat command helpers refuse a missing root', () => {
  assert.throws(() => seatCommandPath('/tmp/gate-lane', 'builder'), (err) => err instanceof TypeError && err.message === 'seat command root is required')
  assert.throws(() => seatCommandRootPrivate(), (err) => err instanceof TypeError && err.message === 'seat command root is required')
})
