import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveAgents } from './agents.mjs'
import { scratchDir } from '../test/helpers.mjs'

const AGENTS_DIR = fileURLToPath(new URL('./agents/', import.meta.url))

// A private copy of the committed definitions, so a test can edit them.
function scratch() {
  const dir = scratchDir('agents-test-')
  cpSync(AGENTS_DIR, dir, { recursive: true })
  return dir
}
function edit(dir, role, change) {
  const path = join(dir, `${role}.md`)
  writeFileSync(path, change(readFileSync(path, 'utf8')))
}
function withScratch(fn) {
  const dir = scratch()
  try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('charter copies of subject and review limits match protocol rules', () => {
  const source = readFileSync(new URL('./protocols.mjs', import.meta.url), 'utf8')
  const types = [...source.match(/const SUBJECT_TYPES = Object\.freeze\(\[([^\]]+)\]/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  const subjectLimit = source.match(/subject: \[\(v\) => typeof v === 'string' && v\.length <= (\d+)/)[1]
  for (const role of ['planner', 'builder']) {
    const body = readFileSync(join(AGENTS_DIR, `${role}.md`), 'utf8')
    const list = body.match(/The type is one of ([^.]+)\./)[1]
    assert.deepEqual([...list.matchAll(/`([^`]+)`/g)].map((m) => m[1]), types)
    assert.ok(body.includes(`at most ${subjectLimit} characters`))
  }
  const reviewer = readFileSync(join(AGENTS_DIR, 'reviewer.md'), 'utf8')
  const findings = Number(source.match(/v\.length > (\d+)\) defects\.push\('details\.findings/)[1])
  const modes = Number(source.match(/failure_modes: \[\(v\) => Array\.isArray\(v\) && v\.length <= (\d+)/)[1])
  assert.equal(findings, 5)
  assert.equal(modes, 3)
  assert.match(reviewer, /list at most five/)
  assert.match(reviewer, /List up to three `failure_modes`/)
})

// MUTATION: drop the rounds copy in resolveAgents and a declared bound never reaches the seat.
test('a declared rounds bound reaches the seat, a tier override replaces it, and an omitted one adds no key', () => withScratch((dir) => {
  assert.equal(Object.values(resolveAgents('build', dir).seats).some((seat) => 'rounds' in seat), false)
  edit(dir, 'builder', (text) => text.replace('role: builder\n', 'role: builder\nrounds: 1\n').replace('{"effort":"xhigh"}', '{"effort":"xhigh","rounds":3}'))
  assert.equal(resolveAgents('build', dir).seats.builder.rounds, 1)
  assert.equal(resolveAgents('judge', dir).seats.builder.rounds, 3)
  assert.equal('rounds' in resolveAgents('build', dir).seats.planner, false)
}))

// MUTATION: skip the identity check and a file seated under another role's name resolves.
test('a malformed, empty, missing or misnamed definition refuses, naming the file', () => withScratch((dir) => {
  assert.throws(() => resolveAgents('ultra', dir), /unknown tier "ultra"/)
  assert.throws(() => resolveAgents('ultra', join(dir, 'does-not-exist')), /unknown tier/)
  edit(dir, 'planner', () => '')
  assert.throws(() => resolveAgents('build', dir), (error) => error.message.includes('planner.md') && error.message.includes('frontmatter'))
  edit(dir, 'planner', () => readFileSync(join(AGENTS_DIR, 'planner.md'), 'utf8'))
  edit(dir, 'builder', (text) => text.replace('effort: high', 'effort: extreme'))
  edit(dir, 'reviewer', (text) => text.replace('name: reviewer', 'name: planner'))
  assert.throws(() => resolveAgents('build', dir), (error) => error.message.includes('builder.md: effort') && error.message.includes('reviewer.md: name and role'))
  rmSync(join(dir, 'tech-lead.md'))
  edit(dir, 'builder', () => readFileSync(join(AGENTS_DIR, 'builder.md'), 'utf8'))
  edit(dir, 'reviewer', () => readFileSync(join(AGENTS_DIR, 'reviewer.md'), 'utf8'))
  assert.throws(() => resolveAgents('judge', dir), (error) => error.code === 'ENOENT' && error.path === join(dir, 'tech-lead.md') && error.cause.code === 'ENOENT')
}))
