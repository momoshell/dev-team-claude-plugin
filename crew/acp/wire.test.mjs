import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { scratchDir } from '../../test/helpers.mjs'
import { inCrewSeatCommandPath, seatCommandPath, seatCommandRootPrivate, shq, splitFrames } from './wire.mjs'

test('shq round-trips a single quote as a shell token', () => {
  assert.equal(shq("a'b"), "'a'\\''b'")
})

test('splitFrames preserves LF framing and chunk rest', () => {
  // readline sees three records for the U+2028 trap; byte-level LF sees two.
  const payload = Buffer.from('{"message":"a\u2028b"}\n{"message":"c"}\n')
  const first = splitFrames(payload.subarray(0, 12))
  const second = splitFrames(Buffer.concat([first.rest, payload.subarray(12)]))
  assert.equal(second.lines.length, 2)
  assert.deepEqual(second.lines.map(JSON.parse), [{ message: 'a\u2028b' }, { message: 'c' }])
  assert.equal(splitFrames(Buffer.from('{"x":1}\r\n')).lines[0], '{"x":1}')
})

test('inCrewSeatCommandPath keeps the legacy in-crew command path', () => {
  assert.equal(inCrewSeatCommandPath('/c', 'builder'), join('/c', 'rpc', 'builder', 'cmd.fifo'))
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

test('FO2 runtime key is outside the crew dir, hashed, and exactly 132 chars for the stated example', () => {
  const root48 = '/' + 'x'.repeat(47)
  assert.equal(root48.length, 48)
  const p = seatCommandPath(join('/lanes', 'b1285-builderloopguard'), 'tech-lead', root48)
  assert.equal(p.startsWith(root48 + '/'), true)
  assert.equal(p.startsWith(join('/lanes', 'b1285-builderloopguard')), false)
  assert.equal(p.length, 132)
  assert.equal(p.endsWith('/cmd.fifo'), true)
  assert.notEqual(seatCommandPath('/a/lane', 'builder', root48), seatCommandPath('/b/lane', 'builder', root48))
})

test('FO7 same-named lanes whose short digests collide still get distinct command FIFOs', () => {
  // The first 8 hex digits of sha256 match for these two crew dirs (b3ceb385).
  const a = seatCommandPath('/tmp/review-parent-10740/lane', 'builder', '/run')
  const b = seatCommandPath('/tmp/review-parent-33667/lane', 'builder', '/run')
  assert.notEqual(a, b)
  assert.match(a, /^\/run\/crew-rpc\/lane-[0-9a-f]{32}\/builder\/cmd\.fifo$/)
})

// MUTATION FO8: drop the 48-char prefix cap and a long lane slug overruns NAME_MAX.
test('FO8 a long lane slug keeps the runtime key directory under NAME_MAX', () => {
  const slug = 'b' + 'x'.repeat(229)
  const p = seatCommandPath(join('/lanes', slug), 'builder', '/run')
  const keyDir = p.split('/').at(-3)
  assert.equal(keyDir.length, 48 + 1 + 32)
  assert.equal(keyDir.startsWith(slug.slice(0, 48) + '-'), true)
  assert.notEqual(p, seatCommandPath(join('/lanes', slug + 'y'), 'builder', '/run'))
})


test('RR5 seat command helpers refuse a missing root', () => {
  assert.throws(() => seatCommandPath('/tmp/gate-lane', 'builder'), (err) => err instanceof TypeError && err.message === 'seat command root is required')
  assert.throws(() => seatCommandRootPrivate(), (err) => err instanceof TypeError && err.message === 'seat command root is required')
})
