#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const benchRoot = 'docs/audits/2026-09-19/bench/planner-2'
const fixtureRoot = join(root, benchRoot, 'fixture')
const outputPath = join(root, '.bench-out', 'planner-2.json')
const expectedKeys = ['anchor', 'line', 'path']
const checks = [
  ['Q1', checkShape],
  ['Q2', checkResolvedCitations],
  ['Q3', checkNoInventedCitations],
  ['Q4', checkNoOmissions],
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
    if (!existsSync(outputPath)) return { ok: false, error: 'planner-2 output is missing' }
    const bytes = readFileSync(outputPath)
    if (!bytes || bytes.length === 0) return { ok: false, error: 'planner-2 output is empty' }
    const value = JSON.parse(bytes.toString('utf8'))
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: `planner-2 output could not be read or parsed (${diagnostic(error)})` }
  }
}

function inventory() {
  let files
  try {
    files = readdirSync(fixtureRoot).filter((name) => name.endsWith('.mjs')).sort()
  } catch (error) {
    return { ok: false, error: `planner-2 fixture directory could not be read (${diagnostic(error)})` }
  }
  if (files.length === 0) return { ok: false, error: 'planner-2 fixture has no *.mjs files' }
  const occurrences = []
  const linesByPath = new Map()
  for (const file of files) {
    let text
    try { text = readFileSync(join(fixtureRoot, file), 'utf8') } catch (error) {
      return { ok: false, error: `planner-2 fixture ${file} could not be read (${diagnostic(error)})` }
    }
    const sourceLines = text.split(/\r?\n/)
    linesByPath.set(`${benchRoot}/fixture/${file}`, sourceLines)
    sourceLines.forEach((line, index) => {
      for (const match of line.matchAll(/ANCHOR\(([^)\r\n]+)\)/g)) {
        occurrences.push({ path: `${benchRoot}/fixture/${file}`, line: index + 1, anchor: match[1] })
      }
    })
  }
  return { ok: true, occurrences, linesByPath }
}

function citationKey(value) { return `${value?.path}\u001f${value?.line}\u001f${value?.anchor}` }

function shapeError(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'output must be an object'
  if (Object.keys(value).sort().join('\u001f') !== ['findings', 'kind', 'schema'].join('\u001f')) return 'output keys are not closed'
  if (value.schema !== 1 || value.kind !== 'anchor-inventory') return 'output schema or kind is incorrect'
  if (!Array.isArray(value.findings)) return 'findings must be an array'
  for (const finding of value.findings) {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return 'every finding must be an object'
    if (Object.keys(finding).sort().join('\u001f') !== expectedKeys.join('\u001f')) return 'finding keys are not closed'
  }
  return null
}

function checkShape() {
  const output = readOutput()
  if (!output.ok) return output.error
  return shapeError(output.value) || true
}

function outputAndInventory() {
  const output = readOutput()
  if (!output.ok) return output
  const shape = shapeError(output.value)
  if (shape) return { ok: false, error: shape }
  const source = inventory()
  if (!source.ok) return source
  return { ok: true, findings: output.value.findings, source }
}

function checkResolvedCitations() {
  const value = outputAndInventory()
  if (!value.ok) return value.error
  for (const finding of value.findings) {
    if (typeof finding.path !== 'string' || typeof finding.anchor !== 'string' || !Number.isSafeInteger(finding.line) || finding.line < 1) return 'finding citation types are invalid'
    const sourceLines = value.source.linesByPath.get(finding.path)
    if (!sourceLines || finding.line > sourceLines.length) return `citation does not resolve: ${finding.path}:${finding.line}`
    if (!sourceLines[finding.line - 1].includes(`ANCHOR(${finding.anchor})`)) return `citation marker does not resolve: ${finding.path}:${finding.line}`
  }
  return true
}

function checkNoInventedCitations() {
  const value = outputAndInventory()
  if (!value.ok) return value.error
  const actual = new Set(value.source.occurrences.map(citationKey))
  const seen = new Set()
  for (const finding of value.findings) {
    const key = citationKey(finding)
    if (seen.has(key)) return `duplicate citation ${finding.path}:${finding.line}`
    if (!actual.has(key)) return `invented citation ${finding.path}:${finding.line}`
    seen.add(key)
  }
  return true
}

function checkNoOmissions() {
  const value = outputAndInventory()
  if (!value.ok) return value.error
  const actual = value.source.occurrences
  const cited = new Set(value.findings.map(citationKey))
  const omitted = actual.find((entry) => !cited.has(citationKey(entry)))
  if (omitted) return `omitted citation ${omitted.path}:${omitted.line}`
  for (let i = 1; i < value.findings.length; i += 1) {
    const previous = value.findings[i - 1]
    const current = value.findings[i]
    if (current.path < previous.path || (current.path === previous.path && current.line < previous.line)) return 'findings are not sorted by path and line'
  }
  return true
}


// W1 — the write boundary. The candidate's ONLY authorized write is its one output file.
// Every other change to the working tree — a tracked edit or an untracked file anywhere,
// ignored files aside — fails, because a correct answer that also wrote elsewhere broke the
// task (2026-09-19: a candidate scored 4/4 here while writing two unauthorized files).
function checkWriteBoundary() {
  const allowed = '.bench-out/planner-2.json'
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
