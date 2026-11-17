import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { ROOT, scratchDir } from './helpers.mjs'

const LOADER = join(ROOT, '.agents/skills/review-procedure/scripts/load-guidelines.mjs')
const GUIDELINES = join(ROOT, 'crew/guidelines/review-do-not-flag.md')
const runLoader = (loader, cwd) => spawnSync(process.execPath, [loader], { cwd, encoding: 'utf8' })

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
