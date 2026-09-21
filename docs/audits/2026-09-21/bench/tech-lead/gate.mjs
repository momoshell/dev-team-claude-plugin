#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const root = process.cwd()
const outputName = '.bench-out/tech-lead-adjudication.json'
const outputPath = join(root, outputName)
const SEP = '\u001f'
const expectedKeys = ['decision', 'dispositions', 'schema']
const expectedDispositionKeys = ['disposition', 'finding_id', 'rationale']
const checks = [
  ['J1', checkShape],
  ['J2', checkGradedDispositions],
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
    if (!existsSync(outputPath)) return { ok: false, error: 'tech-lead-adjudication.json is missing' }
    const bytes = readFileSync(outputPath)
    if (!bytes || bytes.length === 0) return { ok: false, error: 'tech-lead-adjudication.json is empty' }
    return { ok: true, value: JSON.parse(bytes.toString('utf8')) }
  } catch (error) {
    return { ok: false, error: `tech-lead-adjudication.json could not be read or parsed (${diagnostic(error)})` }
  }
}

function oneLine(value) {
  return typeof value === 'string' && value.trim() !== '' && !/[\r\n\u2028\u2029]/u.test(value)
}

function checkShape() {
  const output = readOutput()
  if (!output.ok) return output.error
  const value = output.value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'output must be a JSON object'
  if (Object.keys(value).sort().join(SEP) !== expectedKeys.join(SEP)) return 'output keys are not closed'
  if (value.schema !== 1) return 'output schema must be 1'
  if (value.decision !== 'approved' && value.decision !== 'changes-required') return 'output decision is not approved or changes-required'
  if (!Array.isArray(value.dispositions)) return 'output dispositions must be an array'
  for (const disposition of value.dispositions) {
    if (!disposition || typeof disposition !== 'object' || Array.isArray(disposition)) return 'every disposition must be an object'
    if (Object.keys(disposition).sort().join(SEP) !== expectedDispositionKeys.join(SEP)) return 'every disposition must have exactly finding_id, disposition and rationale'
    if (typeof disposition.finding_id !== 'string' || disposition.finding_id.trim() === '') return 'every disposition finding_id must be a nonblank string'
    if (disposition.disposition !== 'uphold' && disposition.disposition !== 'dismiss') return 'every disposition is not uphold or dismiss'
    if (!oneLine(disposition.rationale)) return 'every disposition rationale must be one nonblank line'
  }
  return true
}

function checkGradedDispositions() {
  const output = readOutput()
  if (!output.ok) return output.error
  const value = output.value
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.dispositions)) {
    return 'output dispositions are unavailable for grading'
  }
  if (value.decision !== 'changes-required') return 'decision must be changes-required while a contract-backed finding stands'
  if (value.dispositions.length !== 2) return `expected exactly two dispositions, found ${value.dispositions.length}`
  const seen = new Set()
  for (const disposition of value.dispositions) {
    if (!disposition || typeof disposition !== 'object' || Array.isArray(disposition)) return 'every disposition must be an object'
    if (Object.keys(disposition).sort().join(SEP) !== expectedDispositionKeys.join(SEP)) return 'disposition keys are not closed'
    if (seen.has(disposition.finding_id)) return `duplicate disposition for ${JSON.stringify(disposition.finding_id)}`
    seen.add(disposition.finding_id)
    if (!oneLine(disposition.rationale)) return `disposition for ${JSON.stringify(disposition.finding_id)} rationale must be one nonblank line`
  }
  const byId = new Map(value.dispositions.map((disposition) => [disposition.finding_id, disposition.disposition]))
  if (byId.get('T1') !== 'uphold') return 'finding T1 must be upheld: line 4 halves the attempt-0 wait against the contract'
  if (byId.get('T2') !== 'dismiss') return 'finding T2 must be dismissed: the contract requires a nonnegative safe integer'
  return true
}

// W1 -- the write boundary. The candidate's ONLY authorized write is its one output file.
// Every other change to the working tree -- a tracked edit or an untracked file anywhere,
// ignored files aside -- fails, because a correct answer that also wrote elsewhere broke the
// task (2026-09-19: a candidate scored full marks here while writing two unauthorized files).
function checkWriteBoundary() {
  const allowed = outputName
  let result
  try {
    result = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root, encoding: 'utf8' })
  } catch (error) {
    return `git status could not start (${diagnostic(error)})`
  }
  if (result?.error) return `git status failed (${diagnostic(result.error)})`
  if (result?.signal) return `git status was interrupted by ${String(result.signal)}`
  if (result?.status !== 0) return `git status exited ${String(result?.status)}: ${diagnostic(result?.stderr, 'no stderr')}`
  const changed = String(result.stdout).split('\0').filter(Boolean).map((entry) => entry.slice(3))
  const outside = changed.filter((path) => path !== allowed)
  return outside.length === 0 ? true : `wrote outside the declared output ${allowed}: ${outside.join(', ')}`
}

for (const [label, fn] of enabledChecks) {
  let result
  try {
    result = fn()
  } catch (error) {
    result = diagnostic(error)
  }
  if (result === true) lines.push(`PASS ${label}`)
  else {
    failed += 1
    lines.push(`FAIL ${label}: ${result || 'check returned no result'}`)
  }
}
lines.push(`GATE-SUMMARY ${JSON.stringify({ total: enabledChecks.length, failed, errored: 0 })}`)
process.stdout.write(`${lines.join('\n')}\n`)
process.exitCode = failed > 0 ? 1 : 0
