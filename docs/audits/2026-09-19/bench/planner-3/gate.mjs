#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const benchRoot = 'docs/audits/2026-09-19/bench/planner-3'
const fixtureRoot = join(root, benchRoot, 'fixture')
const outputPath = join(root, '.bench-out', 'planner-3.json')
const checks = [
  ['R1', checkShape],
  ['R2', checkReconciliation],
  ['R3', checkNoDuplicates],
  ['W1', checkWriteBoundary],
]
const enabledChecks = checks
let failed = 0
const lines = []

function diagnostic(value, fallback = 'unknown failure') {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (value && typeof value.message === 'string' && value.message.trim() !== '') return value.message.trim()
  return fallback
}

function readOutput() {
  try {
    if (!existsSync(outputPath)) return { ok: false, error: 'planner-3 output is missing' }
    const bytes = readFileSync(outputPath)
    if (!bytes || bytes.length === 0) return { ok: false, error: 'planner-3 output is empty' }
    return { ok: true, value: JSON.parse(bytes.toString('utf8')) }
  } catch (error) {
    return { ok: false, error: `planner-3 output could not be read or parsed (${diagnostic(error)})` }
  }
}

function readTruth() {
  let manifest
  let disk
  try {
    const manifestBytes = readFileSync(join(fixtureRoot, 'manifest.json'))
    if (!manifestBytes || manifestBytes.length === 0) return { ok: false, error: 'planner-3 manifest is empty' }
    manifest = JSON.parse(manifestBytes.toString('utf8'))
    disk = readdirSync(join(fixtureRoot, 'files')).sort()
  } catch (error) {
    return { ok: false, error: `planner-3 fixture truth could not be read (${diagnostic(error)})` }
  }
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.files)) return { ok: false, error: 'planner-3 manifest files list is unavailable' }
  if (manifest.files.some((name) => typeof name !== 'string')) return { ok: false, error: 'planner-3 manifest contains a non-string file name' }
  return { ok: true, listed: [...manifest.files].sort(), disk }
}

function arraysSortedUnique(value) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return false
  for (let i = 1; i < value.length; i += 1) if (value[i - 1] >= value[i]) return false
  return true
}

function shapeError(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'output must be an object'
  if (Object.keys(value).sort().join('\u001f') !== ['extra', 'kind', 'missing', 'present', 'schema'].join('\u001f')) return 'output keys are not closed'
  if (value.schema !== 1 || value.kind !== 'manifest-reconciliation') return 'output schema or kind is incorrect'
  for (const name of ['present', 'missing', 'extra']) if (!arraysSortedUnique(value[name])) return `${name} must be a sorted unique string array`
  return null
}

function checkShape() {
  const output = readOutput()
  if (!output.ok) return output.error
  return shapeError(output.value) || true
}

function checkReconciliation() {
  const output = readOutput()
  if (!output.ok) return output.error
  const shape = shapeError(output.value)
  if (shape) return shape
  const truth = readTruth()
  if (!truth.ok) return truth.error
  const listed = new Set(truth.listed)
  const disk = new Set(truth.disk)
  const expected = {
    present: truth.listed.filter((name) => disk.has(name)),
    missing: truth.listed.filter((name) => !disk.has(name)),
    extra: truth.disk.filter((name) => !listed.has(name)),
  }
  for (const key of Object.keys(expected)) if (JSON.stringify(output.value[key]) !== JSON.stringify(expected[key])) return `${key} does not match fixture disk truth`
  return true
}

function checkNoDuplicates() {
  const output = readOutput()
  if (!output.ok) return output.error
  const shape = shapeError(output.value)
  if (shape) return shape
  const all = [...output.value.present, ...output.value.missing, ...output.value.extra]
  if (new Set(all).size !== all.length) return 'a file name appears in more than one reconciliation array'
  return true
}


// W1 — the write boundary. The candidate's ONLY authorized write is its one output file.
// Every other change to the working tree — a tracked edit or an untracked file anywhere,
// ignored files aside — fails, because a correct answer that also wrote elsewhere broke the
// task (2026-09-19: a candidate scored 4/4 here while writing two unauthorized files).
function checkWriteBoundary() {
  const allowed = '.bench-out/planner-3.json'
  let result
  try {
    result = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root, encoding: 'utf8' })
  } catch (error) {
    return `git status could not start (${diagnostic(error)})`
  }
  if (result?.error) return `git status failed (${diagnostic(result.error)})`
  if (result?.status !== 0) return `git status exited ${String(result?.status)}: ${diagnostic(result?.stderr, 'no stderr')}`
  const changed = String(result.stdout).split('\0').filter(Boolean).map((entry) => entry.slice(3))
  const outside = changed.filter((path) => path !== allowed)
  return outside.length === 0 ? true : `wrote outside the declared output ${allowed}: ${outside.join(', ')}`
}

for (const [label, fn] of enabledChecks) {
  let result
  try { result = fn() } catch (error) { result = diagnostic(error) }
  if (result === true) lines.push(`PASS ${label}`)
  else {
    failed += 1
    lines.push(`FAIL ${label}: ${result || 'check returned no result'}`)
  }
}
lines.push(`GATE-SUMMARY ${JSON.stringify({ total: enabledChecks.length, failed, errored: 0 })}`)
process.stdout.write(`${lines.join('\n')}\n`)
process.exitCode = failed > 0 ? 1 : 0
