#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { isAbsolute, join, relative, resolve } from 'node:path'

const root = process.cwd()
const benchRoot = 'docs/audits/2026-09-17/bench'
const outputPath = join(root, '.bench-out', 'planner-scout.json')
const target = ['bench', 'sha', 'mismatch'].join('-')
const expectedKeys = ['classification', 'line', 'path']
const checks = [
  ['P1', checkShape],
  ['P2', checkResolvedCitations],
  ['P3', checkNoInventedCitations],
  ['P4', checkNoOmissionsOrSourceEdits],
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
    if (!existsSync(outputPath)) return { ok: false, error: 'planner-scout.json is missing' }
    const bytes = readFileSync(outputPath)
    if (!bytes || bytes.length === 0) return { ok: false, error: 'planner-scout.json is empty' }
    return { ok: true, value: JSON.parse(bytes.toString('utf8')) }
  } catch (error) {
    return { ok: false, error: `planner-scout.json could not be read or parsed (${diagnostic(error)})` }
  }
}

function trackedMjs() {
  let result
  try {
    result = spawnSync('git', ['ls-files', '-z'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
  } catch (error) {
    return { ok: false, error: `git ls-files could not start (${diagnostic(error)})` }
  }
  if (result?.error) return { ok: false, error: `git ls-files failed (${diagnostic(result.error)})` }
  if (result?.signal) return { ok: false, error: `git ls-files was interrupted by ${result.signal}` }
  if (result?.status !== 0) return { ok: false, error: `git ls-files exited ${String(result?.status)}` }
  const stdout = typeof result?.stdout === 'string' ? result.stdout : ''
  const files = stdout.split('\0').filter((file) => file.endsWith('.mjs'))
    .filter((file) => {
      const segments = file.split('/')
      return !segments.includes('.git') && !segments.includes('node_modules') && !segments.includes('.bench-out')
    })
    .filter((file) => file !== benchRoot && !file.startsWith(`${benchRoot}/`))
  if (files.length === 0) return { ok: false, error: 'git ls-files returned no tracked *.mjs files after exclusions' }
  return { ok: true, files }
}

function inventory() {
  const listed = trackedMjs()
  if (!listed.ok) return listed
  const occurrences = []
  const linesByPath = new Map()
  for (const file of listed.files) {
    let text
    try {
      text = readFileSync(join(root, file), 'utf8')
    } catch (error) {
      return { ok: false, error: `tracked source ${file} could not be read (${diagnostic(error)})` }
    }
    const sourceLines = text.split(/\r?\n/)
    linesByPath.set(file, sourceLines)
    sourceLines.forEach((line, index) => {
      if (line.includes(target)) occurrences.push({ path: file, line: index + 1 })
    })
  }
  return { ok: true, files: listed.files, occurrences, linesByPath }
}

function citationKey(finding) {
  return `${finding?.path}\u001f${finding?.line}`
}

function safeCitation(finding, source) {
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return 'finding is not an object'
  if (Object.keys(finding).sort().join('\u001f') !== expectedKeys.join('\u001f')) return 'finding keys are not closed'
  if (typeof finding.path !== 'string' || finding.path.trim() === '') return 'finding path is blank'
  if (isAbsolute(finding.path) || finding.path.includes('\0')) return `finding path ${JSON.stringify(finding.path)} is not repository-relative`
  const absolute = resolve(root, finding.path)
  const escaped = relative(root, absolute)
  if (escaped === '..' || escaped.startsWith(`..${'/'}`) || isAbsolute(escaped)) return `finding path ${JSON.stringify(finding.path)} escapes the checkout`
  if (!source.files.includes(finding.path)) return `finding path ${JSON.stringify(finding.path)} is not a tracked eligible *.mjs file`
  if (!Number.isSafeInteger(finding.line) || finding.line < 1) return `finding line ${String(finding.line)} is not a positive integer`
  const sourceLines = source.linesByPath.get(finding.path)
  if (!sourceLines || finding.line > sourceLines.length) return `finding ${finding.path}:${finding.line} is outside the file`
  if (!sourceLines[finding.line - 1].includes(target)) return `finding ${finding.path}:${finding.line} does not contain the target`
  if (typeof finding.classification !== 'string' || finding.classification.trim() === '') return `finding ${finding.path}:${finding.line} has a blank classification`
  if (/[\r\n\u2028\u2029]/u.test(finding.classification)) return `finding ${finding.path}:${finding.line} classification is not one line`
  return null
}

function checkShape() {
  const output = readOutput()
  if (!output.ok) return output.error
  const value = output.value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'output must be a JSON object'
  if (Object.keys(value).sort().join('\u001f') !== ['findings', 'schema', 'target'].join('\u001f')) return 'output keys are not closed'
  if (value.schema !== 1) return 'output schema must be 1'
  if (value.target !== target) return 'output target is not bench-sha-mismatch'
  if (!Array.isArray(value.findings)) return 'output findings must be an array'
  for (const finding of value.findings) {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return 'every finding must be an object'
    if (Object.keys(finding).sort().join('\u001f') !== expectedKeys.join('\u001f')) return 'every finding must have exactly path, line and classification'
  }
  return true
}

function outputAndInventory() {
  const output = readOutput()
  if (!output.ok) return { ok: false, error: output.error }
  if (!output.value || typeof output.value !== 'object' || Array.isArray(output.value) || !Array.isArray(output.value.findings)) {
    return { ok: false, error: 'output findings are unavailable for citation checks' }
  }
  const source = inventory()
  if (!source.ok) return source
  return { ok: true, findings: output.value.findings, source }
}

function checkResolvedCitations() {
  const value = outputAndInventory()
  if (!value.ok) return value.error
  for (const finding of value.findings) {
    const error = safeCitation(finding, value.source)
    if (error) return error
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
    if (seen.has(key)) return `duplicate citation ${finding?.path}:${finding?.line}`
    seen.add(key)
    if (!actual.has(key)) return `invented citation ${finding?.path}:${finding?.line}`
  }
  return true
}

function gitDiffNames() {
  let result
  try {
    result = spawnSync('git', ['diff', 'HEAD', '--name-only'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  } catch (error) {
    return { ok: false, error: `git diff could not start (${diagnostic(error)})` }
  }
  if (result?.error) return { ok: false, error: `git diff failed (${diagnostic(result.error)})` }
  if (result?.signal) return { ok: false, error: `git diff was interrupted by ${result.signal}` }
  if (result?.status !== 0) return { ok: false, error: `git diff exited ${String(result?.status)}` }
  const names = String(result.stdout || '').split(/\r?\n/).map((name) => name.trim()).filter(Boolean)
  return { ok: true, names }
}

function checkNoOmissionsOrSourceEdits() {
  const value = outputAndInventory()
  if (!value.ok) return value.error
  const cited = new Set()
  for (const finding of value.findings) {
    if (safeCitation(finding, value.source) === null) cited.add(citationKey(finding))
  }
  const omitted = value.source.occurrences.find((occurrence) => !cited.has(citationKey(occurrence)))
  if (omitted) return `omitted occurrence ${omitted.path}:${omitted.line}`
  const diff = gitDiffNames()
  if (!diff.ok) return diff.error
  if (diff.names.length > 0) return `scout changed tracked files: ${diff.names.join(', ')}`
  let artifacts
  try {
    artifacts = readdirSync(join(root, '.bench-out'))
  } catch (error) {
    return `.bench-out could not be read (${diagnostic(error)})`
  }
  if (!artifacts.includes('planner-scout.json')) return 'planner-scout.json is not present in .bench-out'
  if (artifacts.some((name) => name !== 'planner-scout.json')) return `scout wrote unauthorized .bench-out artifacts: ${artifacts.filter((name) => name !== 'planner-scout.json').join(', ')}`
  return true
}


// W1 — the write boundary. The candidate's ONLY authorized write is its one output file.
// Every other change to the working tree — a tracked edit or an untracked file anywhere,
// ignored files aside — fails, because a correct answer that also wrote elsewhere broke the
// task (2026-09-19: a candidate scored 4/4 here while writing two unauthorized files).
function checkWriteBoundary() {
  const allowed = '.bench-out/planner-scout.json'
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
