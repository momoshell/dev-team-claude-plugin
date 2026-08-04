import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './helpers.mjs'

const doc = readFileSync(join(ROOT, 'references/cmux-dispatch.md'), 'utf8')
const dispatchSrc = readFileSync(join(ROOT, 'scripts/cmux/dispatch.mjs'), 'utf8')

test('cmux-dispatch.md recommends --max-block-s 570 on the await join', () => {
  assert.ok(doc.includes('--max-block-s 570'))
})

test('cmux-dispatch.md instructs an explicit timeout: 600000 on the wrapping Bash call', () => {
  assert.ok(doc.includes('timeout: 600000'))
})

test('cmux-dispatch.md states the await-lock stale-threshold consequence', () => {
  assert.ok(doc.includes('await-lock stale threshold'))
})

test('the recommended 570 stays strictly under dispatch.mjs\'s own AWAIT_CAP_MAX_S clamp', () => {
  const m = dispatchSrc.match(/const AWAIT_CAP_MAX_S = (\d+)/)
  assert.ok(m, 'AWAIT_CAP_MAX_S not found in dispatch.mjs — source shape changed')
  const capMax = Number(m[1])
  assert.ok(570 < capMax, `recommended 570 must stay under AWAIT_CAP_MAX_S (${capMax})`)
})
