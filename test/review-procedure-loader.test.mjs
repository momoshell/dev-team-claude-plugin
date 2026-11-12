import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { ROOT, scratchDir } from './helpers.mjs'

const LOADER = join(ROOT, '.agents/skills/review-procedure/scripts/load-guidelines.mjs')
const GUIDELINES = join(ROOT, 'crew/guidelines/review-do-not-flag.md')
const EMPTY_MARKER = 'no reviewer guidelines were loaded'
const runLoader = (loader, cwd) => spawnSync(process.execPath, [loader], { cwd, encoding: 'utf8' })

function emptyLoaderRun() {
  const root = scratchDir('b391-empty-')
  const loader = join(root, '.agents/skills/review-procedure/scripts/load-guidelines.mjs')
  mkdirSync(dirname(loader), { recursive: true })
  writeFileSync(loader, readFileSync(LOADER))
  const cwd = join(root, 'child')
  mkdirSync(cwd)
  return runLoader(loader, cwd)
}

test('the loader prints the repo guidelines byte-for-byte from the repo root', () => {
  const result = runLoader(LOADER, ROOT)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, readFileSync(GUIDELINES, 'utf8'))
  assert.equal(result.stderr, '')
})

test("the loader finds the plugin's guidelines from a directory outside the checkout", () => {
  const outside = scratchDir('b391-outside-')
  const result = runLoader(LOADER, outside)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, readFileSync(GUIDELINES, 'utf8'))
})

test("a copy in the repo under review overrides the plugin's own", () => {
  const root = scratchDir('b391-override-')
  const guidelines = join(root, 'crew/guidelines/review-do-not-flag.md')
  const sentinel = '# Target repository guidelines\n- Leave this target repository alone.\n'
  mkdirSync(dirname(guidelines), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{}\n')
  writeFileSync(guidelines, sentinel)
  const result = runLoader(LOADER, root)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, sentinel)
  assert.equal(result.stdout.includes('# Reviewer guidelines — do not flag'), false)
})

test('with no guidelines reachable the loader states an empty list and exits 0', () => {
  const result = emptyLoaderRun()
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.includes(EMPTY_MARKER))
})

test('the stated empty list names the file it could not load', () => {
  const result = emptyLoaderRun()
  assert.match(result.stdout, /crew\/guidelines\/review-do-not-flag\.md/)
})

test('the stated empty list is a blind spot, not a broken-checkout claim', () => {
  const result = emptyLoaderRun()
  const out = `${result.stdout}${result.stderr}`
  assert.match(out, /blind spot/)
  assert.equal(/broken checkout/i.test(out), false)
})

test('posture.md names the lean tier posture: one reviewer per round at the lane tier', () => {
  const text = readFileSync(join(ROOT, 'skills/pr-review/references/posture.md'), 'utf8')
  assert.ok(text.includes('One reviewer per round is the standing posture'))
  assert.ok(text.includes('`TIERS` in `crew/protocols.mjs`'))
  assert.equal(text.includes('crew/drive.mjs'), false)
})

test('posture.md names the automatic judge second review, with no panel', () => {
  const text = readFileSync(join(ROOT, 'skills/pr-review/references/posture.md'), 'utf8')
  assert.ok(text.includes("judge loop's automatic\nsecond review"))
  assert.ok(text.includes('after the reviewer passes and the suite is green'))
  assert.ok(text.includes('never two reviewers on one round'))
})

test('no review-skill document calls the shipped panel parked', () => {
  const docs = [
    'skills/pr-review/SKILL.md',
    'skills/pr-review/references/posture.md',
    'skills/pr-review/references/evidence.md',
    'skills/pr-review/references/falsification.md',
    '.agents/skills/review-procedure/SKILL.md',
  ]
  const needles = ['parked', 'has never', 'pretending it runs', 'broken checkout']
  const offenders = []
  for (const doc of docs) {
    const text = readFileSync(join(ROOT, doc), 'utf8')
    for (const needle of needles) if (text.includes(needle)) offenders.push(`${doc}: ${needle}`)
  }
  assert.deepEqual(offenders, [])
})

test('S5-7: the procedure tells a /review session which steps apply', () => {
  const text = readFileSync(join(ROOT, '.agents/skills/review-procedure/SKILL.md'), 'utf8')
  const section = text.split('## In a `/review` session')[1]?.split('\n## ')[0]
  assert.ok(section)
  for (const phrase of ['Builder report', 'step 2', 'step 5', 'conversation']) assert.ok(section.includes(phrase), phrase)
})

test('S5-8: do-not-flag names the lane task dir and lists only deferred remedies', () => {
  const finish = readFileSync(join(ROOT, 'crew/finish.mjs'), 'utf8')
  const text = readFileSync(GUIDELINES, 'utf8')
  assert.ok(finish.includes("join(crewRoot, `dt-${lane}`, lane, 'task')"))
  assert.ok(text.includes('`~/.crew/dt-<lane>/<lane>/task`'))
  assert.ok(!text.includes('~/.crew/<repo>/<task>/task'))
  assert.doesNotMatch(text, /can now be built|cannot be built in this slice/i)
})

test('BB3 review guidelines contain no brittle module line citations', () => {
  const text = readFileSync(GUIDELINES, 'utf8')
  const found = text.match(/[A-Za-z0-9_./-]+\.mjs:\d+/g) ?? []
  assert.deepEqual(found, [])
})

// MUTATION: cite the retired scope gate.
test('BB4: do-not-flag cites no retired mechanism', () => {
  const text = readFileSync(GUIDELINES, 'utf8')
  assert.doesNotMatch(text, /Method step|gate\.mjs|scope (gate|check)/i)
})

// MUTATION: restore journal results or the old review artifact.
test('RP1: the procedure judges the plan criteria and returns the reviewer envelope', () => {
  const text = readFileSync(join(ROOT, '.agents/skills/review-procedure/SKILL.md'), 'utf8')
  assert.match(text, /Tasks/)
  assert.match(text, /Criteria/)
  assert.match(text, /envelope/)
  assert.doesNotMatch(text, /Changes|validation-lane|review\.md/)
})

// MUTATION: restore the old crew/checks.mjs line in posture.md.
test('RP3: posture.md states the tier rules reviewer.md and the loop enforce', () => {
  const reviewer = readFileSync(join(ROOT, 'crew/agents/reviewer.md'), 'utf8')
  const posture = readFileSync(join(ROOT, 'skills/pr-review/references/posture.md'), 'utf8').replace(/\s+/g, ' ')
  assert.doesNotMatch(reviewer.split('---')[1], /^tiers:/m)
  for (const text of ['declares no `tiers` key', 'matches `PROTECTED` in `crew/loop.mjs`', 'the loop also raises it after the build']) assert.ok(posture.includes(text))
  for (const text of ['crew/checks.mjs', 'never after the build', 'raises it at the judge tier']) assert.equal(posture.includes(text), false)
})

// MUTATION: restore "the charter names it and does not restate it."
test('RP4: do-not-flag is labelled the /review procedure only', () => {
  const guideline = readFileSync(GUIDELINES, 'utf8').replace(/\s+/g, ' ')
  const reviewer = readFileSync(join(ROOT, 'crew/agents/reviewer.md'), 'utf8').replace(/\s+/g, ' ')
  for (const text of ["the `/review` command's procedure only", 'commands/review.md', 'No lane seat receives it']) assert.ok(guideline.includes(text))
  assert.equal(guideline.includes('the charter names it'), false)
  assert.equal(reviewer.includes('review-do-not-flag'), false)
})

// MUTATION: RP2 restores "The loop runs the proof and suite, in parallel with this review on a build lane."
test('RP2: step 2 orders the proof before review and runs only the suite beside it on build', () => {
  const text = readFileSync(join(ROOT, '.agents/skills/review-procedure/SKILL.md'), 'utf8')
  const step = text.split('\n2. ')[1].split('\n3. ')[0].replace(/\s+/g, ' ')
  assert.doesNotMatch(step, /proof and (the )?suite, in parallel/i)
  assert.match(step, /proved[^.]*before this review/i)
  assert.match(step, /Only the suite runs beside this review, and only on a build lane/)
})
