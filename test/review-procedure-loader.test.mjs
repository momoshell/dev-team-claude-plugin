import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { ROOT, scratchDir } from './helpers.mjs'
import { pinnedKey } from '../skills/qa-test-writing/anchor-pin.mjs'

const LOADER = join(ROOT, '.agents/skills/review-procedure/scripts/load-guidelines.mjs')
const GUIDELINES = join(ROOT, 'crew/guidelines/review-do-not-flag.md')
const EMPTY_MARKER = 'no reviewer guidelines were loaded'
const PR_REVIEW = join(ROOT, 'skills/pr-review/anchors.json')
const pin = (expected) => pinnedKey({ manifestPath: PR_REVIEW, expected })
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

test('posture.md names the continuation gate on the shipped panel', () => {
  const text = readFileSync(join(ROOT, 'skills/pr-review/references/posture.md'), 'utf8')
  assert.ok(text.includes('ctx.continuation'))
  assert.ok(text.includes(pin('const panel = ctx.continuation === true ? panelSeats(seatList) : null')))
})

test('posture.md names the tech-lead seat gate on the shipped panel', () => {
  const text = readFileSync(join(ROOT, 'skills/pr-review/references/posture.md'), 'utf8')
  assert.ok(text.includes('without a seated tech-lead'))
  assert.ok(text.includes(pin('export function panelSeats(seated) {')))
})

test('no review-skill document calls the shipped panel parked', () => {
  const docs = [
    'skills/pr-review/SKILL.md',
    'skills/pr-review/references/posture.md',
    'skills/pr-review/references/evidence.md',
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
