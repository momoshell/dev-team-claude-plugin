// scripts/spec-lint.mjs — mechanical Handover Spec lint, exercised against a
// throwaway fixture project (no network, no live model).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT } from './helpers.mjs'

const SCRIPT = join(ROOT, 'scripts', 'spec-lint.mjs')

const fixture = mkdtempSync(join(tmpdir(), 'spec-lint-'))
mkdirSync(join(fixture, 'src', 'api'), { recursive: true })
mkdirSync(join(fixture, 'scripts'), { recursive: true })
writeFileSync(join(fixture, 'src', 'api', 'items.ts'), 'export {}\n'.repeat(80))
writeFileSync(join(fixture, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n')
writeFileSync(join(fixture, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', typecheck: 'tsc', lint: 'eslint .' } }))
process.on('exit', () => rmSync(fixture, { recursive: true, force: true }))

const baseSpec = {
  task_id: 'be-01',
  domain: 'backend',
  goal: 'g',
  files_in_scope: ['src/api/items.ts'],
  constraints: [],
  acceptance_criteria: ['works'],
  validation_commands: ['npm test', 'npm run typecheck'],
  discovery_context: 'Handlers live in src/api/items.ts:40, pattern to mirror at src/api/items.ts:12.',
  out_of_scope: [],
  depends_on: [],
  interface_contract: 'none',
}

let n = 0
function lint(overrides = {}) {
  const specPath = join(fixture, `spec-${n++}.json`)
  writeFileSync(specPath, JSON.stringify({ ...baseSpec, ...overrides }))
  return spawnSync(process.execPath, [SCRIPT, '--root', fixture, specPath], { encoding: 'utf8' })
}

test('spec-lint.mjs parses (node --check)', () => {
  const r = spawnSync(process.execPath, ['--check', SCRIPT], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
})

test('a complete spec passes', () => {
  const r = lint()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /spec-lint: PASS/)
})

test('reads the spec from stdin with -', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', fixture, '-'], {
    encoding: 'utf8',
    input: JSON.stringify(baseSpec),
  })
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('missing required field fails', () => {
  const spec = { ...baseSpec }
  delete spec.interface_contract
  const specPath = join(fixture, `spec-${n++}.json`)
  writeFileSync(specPath, JSON.stringify(spec))
  const r = spawnSync(process.execPath, [SCRIPT, '--root', fixture, specPath], { encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /missing required field "interface_contract"/)
})

test('glob in files_in_scope fails', () => {
  const r = lint({ files_in_scope: ['src/**/*.ts'] })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /is a glob/)
})

test('prose in files_in_scope fails', () => {
  const r = lint({ files_in_scope: ['the items module'] })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /looks like prose/)
})

test('missing file with existing parent dir is a new-file warning, not a failure', () => {
  const r = lint({ files_in_scope: ['src/api/new-handler.ts'] })
  assert.equal(r.status, 0, r.stdout)
  assert.match(r.stdout, /treated as a new file/)
})

test('missing file with missing parent dir fails', () => {
  const r = lint({ files_in_scope: ['src/nowhere/new.ts'] })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /neither does its parent directory/)
})

test('discovery_context citing a nonexistent file:line fails', () => {
  const r = lint({ discovery_context: 'Mirror the pattern at src/api/missing.ts:10.' })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /file does not exist/)
})

test('discovery_context citing a line beyond EOF fails', () => {
  const r = lint({ discovery_context: 'Mirror the pattern at src/api/items.ts:9999.' })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /file has only/)
})

test('discovery_context citing the true last line passes (lineCount off-by-one)', () => {
  const r = lint({ discovery_context: 'See src/api/items.ts:80 for the pattern.' })
  assert.equal(r.status, 0, r.stdout)
})

test('discovery_context citing one line past the true last line fails (lineCount off-by-one)', () => {
  const r = lint({ discovery_context: 'See src/api/items.ts:81 for the pattern.' })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /file has only 80 lines/)
})

test('discovery_context mentioning a nonexistent bare path fails', () => {
  const r = lint({ discovery_context: 'Rows persist via db.insert() from src/gone/db.ts.' })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /file does not exist/)
})

test('discovery_context mentioning a domain-like bare path is not flagged', () => {
  const r = lint({ discovery_context: 'Pattern from github.com/foo/bar/utils.ts here.' })
  assert.equal(r.status, 0, r.stdout)
})

test('discovery_context citing a nonexistent absolute path fails', () => {
  const r = lint({ discovery_context: 'see /src/api/nope.ts:40 for the shape' })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /file does not exist/)
})

test('discovery_context citing an existing absolute (root-relative) path passes', () => {
  const r = lint({ discovery_context: 'see /src/api/items.ts:40 for the shape' })
  assert.equal(r.status, 0, r.stdout)
})

test('discovery_context with a full URL is not misread as a path citation', () => {
  const r = lint({ discovery_context: 'See https://example.com/docs/api.ts:40 for background.' })
  assert.equal(r.status, 0, r.stdout)
})

test('empty discovery_context with non-empty scope warns but passes', () => {
  const r = lint({ discovery_context: 'none' })
  assert.equal(r.status, 0, r.stdout)
  assert.match(r.stdout, /the coder starts blind/)
})

test('validation command whose npm script is missing fails', () => {
  const r = lint({ validation_commands: ['npm run nonexistent-script'] })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /not in package\.json/)
})

test('validation command whose binary is not on PATH fails', () => {
  const r = lint({ validation_commands: ['definitely-not-a-real-cmd-xyz --flag'] })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /not found on PATH/)
})

test('env-var prefix is skipped when resolving the binary', () => {
  const r = lint({ validation_commands: ['CI=1 node --version'] })
  assert.equal(r.status, 0, r.stdout)
})

test('lowercase env-var prefix is also skipped when resolving the binary', () => {
  const r = lint({ validation_commands: ['npm_config_yes=true node --version'] })
  assert.equal(r.status, 0, r.stdout)
})

test('pnpm without "run" whose script is missing fails', () => {
  const r = lint({ validation_commands: ['pnpm nonexistent-xyz'] })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /not in package\.json/)
})

test('pnpm without "run" whose script exists passes', () => {
  const r = lint({ validation_commands: ['pnpm lint'] })
  assert.equal(r.status, 0, r.stdout)
})

test('yarn without "run" whose script is missing fails', () => {
  const r = lint({ validation_commands: ['yarn nonexistent-xyz'] })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /not in package\.json/)
})

test('yarn without "run" whose script exists passes', () => {
  const r = lint({ validation_commands: ['yarn test'] })
  assert.equal(r.status, 0, r.stdout)
})

test('a package-manager verb (install) is not treated as a script name', () => {
  const r = lint({ validation_commands: ['npm install'] })
  assert.equal(r.status, 0, r.stdout)
})

test('a relative-path command is resolved against --root, not the linter cwd', () => {
  const r = lint({ validation_commands: ['scripts/run.sh'] })
  assert.equal(r.status, 0, r.stdout)
})

test('a nonexistent relative-path command fails', () => {
  const r = lint({ validation_commands: ['scripts/nope.sh'] })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /not found on PATH/)
})

test('invalid JSON exits 2', () => {
  const specPath = join(fixture, `spec-${n++}.json`)
  writeFileSync(specPath, '{not json')
  const r = spawnSync(process.execPath, [SCRIPT, '--root', fixture, specPath], { encoding: 'utf8' })
  assert.equal(r.status, 2)
})
