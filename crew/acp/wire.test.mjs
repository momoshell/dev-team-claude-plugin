import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { scratchDir } from '../../test/helpers.mjs'
import * as wire from './wire.mjs'
import { seatCommandPath, seatCommandRootPrivate, splitFrames } from './wire.mjs'

test('splitFrames preserves LF framing and chunk rest', () => {
  // readline sees three records for the U+2028 trap; byte-level LF sees two.
  const payload = Buffer.from('{"message":"a\u2028b"}\n{"message":"c"}\n')
  const first = splitFrames(payload.subarray(0, 12))
  const second = splitFrames(Buffer.concat([first.rest, payload.subarray(12)]))
  assert.equal(second.lines.length, 2)
  assert.deepEqual(second.lines.map(JSON.parse), [{ message: 'a\u2028b' }, { message: 'c' }])
  assert.equal(splitFrames(Buffer.from('{"x":1}\r\n')).lines[0], '{"x":1}')
})

// MUTATION: restore the inCrewSeatCommandPath export.
test('wire.mjs exports no legacy in-crew command path', () => {
  assert.equal(Object.hasOwn(wire, 'inCrewSeatCommandPath'), false)
  assert.equal(typeof wire.seatCommandPath, 'function')
})

test('seatCommandRootPrivate requires an owned crew-rpc dir with no group or other access', () => {
  const root = scratchDir('wire-private-')
  {
    assert.equal(seatCommandRootPrivate(root), false)
    const top = join(root, 'crew-rpc')
    mkdirSync(top); chmodSync(top, 0o755)
    assert.equal(seatCommandRootPrivate(root), false)
    chmodSync(top, 0o700)
    assert.equal(seatCommandRootPrivate(root), true)
    assert.equal(seatCommandRootPrivate(root, process.getuid() + 1), false)
  }
})


test('RR5 seat command helpers refuse a missing root', () => {
  assert.throws(() => seatCommandPath('/tmp/gate-lane', 'builder'), (err) => err instanceof TypeError && err.message === 'seat command root is required')
  assert.throws(() => seatCommandRootPrivate(), (err) => err instanceof TypeError && err.message === 'seat command root is required')
})
