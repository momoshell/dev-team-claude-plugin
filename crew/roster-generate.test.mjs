import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveAgents } from './agents.mjs'
import { ROSTER_PATH, generateRoster, main } from './roster-generate.mjs'
import { scratchDir } from '../test/helpers.mjs'

const AGENTS_DIR = fileURLToPath(new URL('./agents/', import.meta.url))
const committed = readFileSync(ROSTER_PATH, 'utf8')

// A private copy of the definitions and the roster, so a test can edit either.
function withScratch(fn) {
  const dir = scratchDir('roster-generate-test-')
  try {
    cpSync(AGENTS_DIR, join(dir, 'agents'), { recursive: true })
    writeFileSync(join(dir, 'roster.json'), committed)
    const edit = (role, change) => { const path = join(dir, 'agents', `${role}.md`); writeFileSync(path, change(readFileSync(path, 'utf8'))) }
    return fn({ dir, edit, resolve: (tier) => resolveAgents(tier, join(dir, 'agents')), path: join(dir, 'roster.json') })
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
const quiet = () => {}

// MUTATION: edit any committed definition without regenerating and the bytes differ.
test('the committed roster.json is exactly what the committed definitions generate', () => {
  assert.equal(generateRoster(committed), committed)
})

// MUTATION: write the template's cells back instead of the resolved ones and the edit never reaches the file.
test('an edited definition changes its cell in the generated roster, and only that cell', () => withScratch(({ edit, resolve }) => {
  edit('builder', (text) => text.replace('effort: high', 'effort: low'))
  const before = JSON.parse(committed)
  const after = JSON.parse(generateRoster(committed, resolve))
  assert.equal(after.tiers.build.builder.effort, 'low')
  assert.equal(after.tiers.mechanical.builder.effort, 'low')
  assert.equal(after.tiers.judge.builder.effort, before.tiers.judge.builder.effort)
  after.tiers.build.builder.effort = after.tiers.mechanical.builder.effort = 'high'
  assert.deepEqual(after, before)
}))

// MUTATION: drop the null fill and a role the definitions unseat disappears from its tier.
test('a role a definition unseats at a tier stays listed as null', () => withScratch(({ edit, resolve }) => {
  edit('reviewer', (text) => text.replace(/^tiers: .*$/m, (line) => line.replace('{', '{"mechanical":null,')))
  const tiers = JSON.parse(generateRoster(committed, resolve)).tiers
  assert.deepEqual(Object.keys(tiers.mechanical), ['advisor', 'lead', 'planner', 'builder', 'reviewer'])
  assert.equal(tiers.mechanical.reviewer, null)
  assert.notEqual(tiers.build.reviewer, null)
}))

// MUTATION: write on --check and the drifted file is changed by a check.
test('--check reports drift with exit 1 and leaves the file alone; generate writes it', () => withScratch(({ edit, resolve, path }) => {
  edit('planner', (text) => text.replace(/^effort: \w+$/m, 'effort: low'))
  assert.equal(main(['generate', '--check'], { path, resolve, log: quiet }), 1)
  assert.equal(readFileSync(path, 'utf8'), committed)
  assert.equal(main(['generate'], { path, resolve, log: quiet }), 0)
  assert.notEqual(readFileSync(path, 'utf8'), committed)
  assert.equal(main(['generate', '--check'], { path, resolve, log: quiet }), 0)
}))

// MUTATION: accept any argv and a typo regenerates the roster.
test('anything but generate [--check] is a usage error that writes nothing', () => withScratch(({ resolve, path }) => {
  for (const argv of [[], ['gen'], ['generate', '--force']]) {
    assert.equal(main(argv, { path, resolve, log: quiet }), 2, JSON.stringify(argv))
  }
  assert.equal(readFileSync(path, 'utf8'), committed)
}))
