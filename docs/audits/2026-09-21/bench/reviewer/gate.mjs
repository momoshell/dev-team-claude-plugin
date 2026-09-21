#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const root = process.cwd()
const outputName = '.bench-out/reviewer-review.json'
const outputPath = join(root, outputName)
const expectedKeys = ['findings', 'schema', 'verdict']
const expectedFindingKeys = ['id', 'line', 'message', 'path', 'severity']
const checks = [
  ['R1', checkShape],
  ['R2', checkGradedFinding],
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
    if (!existsSync(outputPath)) return { ok: false, error: 'reviewer-review.json is missing' }
    const bytes = readFileSync(outputPath)
    if (!bytes || bytes.length === 0) return { ok: false, error: 'reviewer-review.json is empty' }
    return { ok: true, value: JSON.parse(bytes.toString('utf8')) }
  } catch (error) {
    return { ok: false, error: `reviewer-review.json could not be read or parsed (${diagnostic(error)})` }
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
  if (Object.keys(value).sort().join('\u001f') !== expectedKeys.join('\u001f')) return 'output keys are not closed'
  if (value.schema !== 1) return 'output schema must be 1'
  if (value.verdict !== 'pass' && value.verdict !== 'request-changes') return 'output verdict is not pass or request-changes'
  if (!Array.isArray(value.findings)) return 'output findings must be an array'
  for (const finding of value.findings) {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return 'every finding must be an object'
    if (Object.keys(finding).sort().join('\u001f') !== expectedFindingKeys.join('\u001f')) return 'every finding must have exactly id, severity, path, line and message'
    if (typeof finding.id !== 'string' || finding.id.trim() === '') return 'every finding id must be a nonblank string'
    if (finding.severity !== 'major' && finding.severity !== 'minor') return 'every finding severity is not major or minor'
    if (typeof finding.path !== 'string' || finding.path.trim() === '') return 'every finding path must be a nonblank string'
    if (!Number.isSafeInteger(finding.line) || finding.line < 1) return 'every finding line must be a positive integer'
    if (!oneLine(finding.message)) return 'every finding message must be one nonblank line'
  }
  return true
}

function checkGradedFinding() {
  const output = readOutput()
  if (!output.ok) return output.error
  const value = output.value
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.findings)) {
    return 'output findings are unavailable for grading'
  }
  if (value.verdict !== 'request-changes') return 'verdict must be request-changes for the contract-violating implementation'
  if (value.findings.length !== 1) return `expected exactly one finding, found ${value.findings.length}`
  const finding = value.findings[0]
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return 'the finding must be an object'
  if (Object.keys(finding).sort().join('\u001f') !== expectedFindingKeys.join('\u001f')) return 'the finding keys are not closed'
  if (finding.id !== 'R1') return `finding id is ${JSON.stringify(finding.id)}, expected R1`
  if (finding.severity !== 'major') return 'finding R1 must be major for the line-4 contract violation'
  if (finding.path !== 'lib/retry.mjs') return `finding path is ${JSON.stringify(finding.path)}, expected lib/retry.mjs`
  if (finding.line !== 4) return `finding line is ${String(finding.line)}, expected 4`
  if (!oneLine(finding.message)) return 'finding R1 message must be one nonblank line'
  return true
}

// W1 — the write boundary. The candidate's ONLY authorized write is its one output file.
// Every other change to the working tree — a tracked edit or an untracked file anywhere,
// ignored files aside — fails, because a correct answer that also wrote elsewhere broke the
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
