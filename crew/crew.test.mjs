import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composeLayout, SEAT_DEFAULTS, DEFAULT_ROLES } from './crew.mjs'

// cmux build-102 rejects layouts whose split nodes are not strictly binary
// and whose single-pane trees are anything but a bare leaf ("Invalid
// layout"). composeLayout exists to satisfy exactly that grammar, so these
// pins are load-bearing: a refactor to n-ary children boots nothing.

const mk = (role) => `run-${role}`

function assertBinary(node) {
  if (node.pane) {
    assert.equal(node.pane.surfaces.length, 1)
    return 1
  }
  assert.ok(['horizontal', 'vertical'].includes(node.direction))
  assert.equal(node.children.length, 2, 'split nodes must be strictly binary')
  return node.children.reduce((n, c) => n + assertBinary(c), 0)
}

test('single role composes a bare leaf, not a wrapped split', () => {
  const layout = composeLayout(['lead'], mk)
  assert.ok(layout.pane, 'one pane must be a bare leaf')
  assert.equal(layout.pane.surfaces[0].name, 'lead')
  assert.equal(layout.pane.surfaces[0].command, 'run-lead')
})

test('multi-role layout is strictly binary with every seat present once', () => {
  for (const roles of [DEFAULT_ROLES, [...DEFAULT_ROLES, 'tech-lead'], ['lead', 'builder']]) {
    const layout = composeLayout([...roles], mk)
    assert.equal(assertBinary(layout), roles.length)
  }
})

test('lead takes the left half; members stack vertically on the right', () => {
  const layout = composeLayout([...DEFAULT_ROLES], mk)
  assert.equal(layout.direction, 'horizontal')
  assert.equal(layout.children[0].pane.surfaces[0].name, 'lead')
  let right = layout.children[1]
  const names = []
  while (right.children) {
    assert.equal(right.direction, 'vertical')
    names.push(right.children[0].pane.surfaces[0].name)
    right = right.children[1]
  }
  names.push(right.pane.surfaces[0].name)
  assert.deepEqual(names, ['planner', 'builder', 'reviewer'])
})

test('every default role has a seat definition; builder is the only Edit seat and carries no Task', () => {
  for (const r of DEFAULT_ROLES) assert.ok(SEAT_DEFAULTS[r], `missing seat: ${r}`)
  for (const [role, seat] of Object.entries(SEAT_DEFAULTS)) {
    if (role === 'builder') {
      assert.match(seat.tools, /Edit/)
      assert.doesNotMatch(seat.tools, /Task/, 'builder must stay subagent-free (transcript reducer relies on it)')
    } else {
      assert.doesNotMatch(seat.tools, /Edit/, `${role} must not write the repo`)
    }
  }
})

test('seat deny lists are the ENFORCED boundary: only the builder may Edit, the builder never gets subagents', () => {
  // --allowedTools is inert under bypassPermissions (verified live); the
  // --disallowedTools deny list is what actually holds. These pins keep the
  // charter real: drop a deny entry and the posture in README becomes a lie.
  for (const [role, seat] of Object.entries(SEAT_DEFAULTS)) {
    assert.ok(seat.deny, `${role} has no deny list — under bypassPermissions it would be unconstrained`)
    if (role === 'builder') {
      assert.match(seat.deny, /Task/), assert.match(seat.deny, /Agent/)
      assert.doesNotMatch(seat.deny, /Edit/, 'the builder is the one seat that MUST keep Edit')
    } else {
      assert.match(seat.deny, /Edit/, `${role} must be tool-denied Edit, not just un-allowed`)
      assert.match(seat.deny, /NotebookEdit/)
    }
  }
})
