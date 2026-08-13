import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assignmentLine, assertSafeLine, pickNeedle } from './driver.mjs'

const GOOD = {
  id: 'p1',
  role: 'planner',
  briefFile: '/Users/x/.crew/demo/task/brief-planner.md',
  returnPath: '/Users/x/.crew/demo/returns/planner.json',
  taskDir: '/Users/x/.crew/demo/task',
}

test('assignmentLine returns the exact expected string', () => {
  assert.equal(
    assignmentLine(GOOD),
    'ASSIGNMENT p1: read your brief at /Users/x/.crew/demo/task/brief-planner.md. Task dir: /Users/x/.crew/demo/task. Write your ReturnEnvelope to /Users/x/.crew/demo/returns/planner.json then print exactly: CREW-DONE planner p1'
  )
})

test('relative briefFile throws', () => {
  assert.throws(() => assignmentLine({ ...GOOD, briefFile: 'brief-planner.md' }), /assignmentLine: briefFile/)
  assert.throws(() => assignmentLine({ ...GOOD, briefFile: './task/brief-planner.md' }), /assignmentLine: briefFile/)
})

test('disallowed character in briefFile throws', () => {
  assert.throws(() => assignmentLine({ ...GOOD, briefFile: '/Users/x/demo/brief planner.md' }), /assignmentLine: briefFile/)
  assert.throws(() => assignmentLine({ ...GOOD, briefFile: '/Users/x/demo,extra/brief.md' }), /assignmentLine: briefFile/)
})

test('every path field is guarded: taskDir', () => {
  assert.throws(() => assignmentLine({ ...GOOD, taskDir: '/Users/x/demo task' }), /assignmentLine: taskDir/)
  assert.throws(() => assignmentLine({ ...GOOD, taskDir: 'demo/task' }), /assignmentLine: taskDir/)
})

test('every path field is guarded: returnPath', () => {
  assert.throws(() => assignmentLine({ ...GOOD, returnPath: '/Users/x/demo returns/planner.json' }), /assignmentLine: returnPath/)
  assert.throws(() => assignmentLine({ ...GOOD, returnPath: 'returns/planner.json' }), /assignmentLine: returnPath/)
})

test('id and role are guarded', () => {
  assert.throws(() => assignmentLine({ ...GOOD, id: 'p 1' }), /assignmentLine: id/)
  assert.throws(() => assignmentLine({ ...GOOD, role: 'plan,ner' }), /assignmentLine: role/)
})

test('round-trip: composed line always passes assertSafeLine', () => {
  assert.doesNotThrow(() => assertSafeLine(assignmentLine(GOOD)))
  assert.doesNotThrow(() => assertSafeLine(assignmentLine({
    id: 'tech-lead',
    role: 'tech-lead',
    briefFile: '/srv/dev-team_2/.crew/v0.1.92/task/brief-tech-lead.md',
    returnPath: '/srv/dev-team_2/.crew/v0.1.92/returns/tech-lead.json',
    taskDir: '/srv/dev-team_2/.crew/v0.1.92/task',
  })))
})

test('missing field throws', () => {
  assert.throws(() => assignmentLine({}), /assignmentLine: id/)
})

test('dot-only id and role throw', () => {
  for (const bad of ['.', '..', '...']) {
    assert.throws(() => assignmentLine({ ...GOOD, id: bad }), /assignmentLine: id/)
    assert.throws(() => assignmentLine({ ...GOOD, role: bad }), /assignmentLine: role/)
  }
})

test('the thrown message names the offending token', () => {
  assert.throws(() => assignmentLine({ ...GOOD, id: '..' }), /assignmentLine: id .*: \.\.$/)
  assert.throws(() => assignmentLine({ ...GOOD, role: '...' }), /assignmentLine: role .*: \.\.\.$/)
})

test('path separators in id and role throw', () => {
  assert.throws(() => assignmentLine({ ...GOOD, id: '../x' }), /assignmentLine: id/)
  assert.throws(() => assignmentLine({ ...GOOD, role: 'a/b' }), /assignmentLine: role/)
  assert.throws(() => assignmentLine({ ...GOOD, id: 'a\\b' }), /assignmentLine: id/)
})

test('legitimate tokens still compose', () => {
  for (const id of ['a1', 'd12', 'p1', 'v0.1.97']) {
    assert.doesNotThrow(() => assignmentLine({ ...GOOD, id }))
  }
  assert.doesNotThrow(() => assignmentLine({ ...GOOD, id: 'tech-lead', role: 'tech-lead' }))
})

test('pickNeedle chooses from the line TAIL — the input-box viewport scrolls to the end, hiding the head', () => {
  const line = assignmentLine({
    id: 'd1', role: 'planner',
    briefFile: '/private/tmp/some-very-long-scratchpad-path-that-wraps-many-columns/brief-95-adapter-seam.md',
    returnPath: '/Users/x/.crew/repo/task/returns/d1.planner.json',
    taskDir: '/Users/x/.crew/repo/task/task',
  })
  const needle = pickNeedle(line)
  assert.equal(needle, '/Users/x/.crew/repo/task/returns/d1.planner.json')
  // the head-positioned brief path must NEVER be the needle, however long
  assert.notEqual(needle, line.split(/\s+/).reduce((a, b) => (b.length > a.length ? b : a), ''))
})
