#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const readmePath = 'docs/audits/2026-09-19/bench/builder-3/README.md'
const readmeAbsolute = join(root, readmePath)
const opening = '```BENCH_WORK_ITEM'
const closing = '```'
const expectedRows = [
  '| model | band |',
  '| gemma4-31b | basement |',
  '| gpt-oss-20b | basement |',
  '| qwen3.8-27b | basement |',
]
const expectedPrefix = '# Builder bench 3 — markdown table sync\n\nThis builder bench measures markdown table row sync by sorting model rows while preserving the documented schema.\nkind: markdown-table-sync\n\nCandidates edit only the fenced work item below; all bytes outside that block are fixed.\n\n```BENCH_WORK_ITEM'
const expectedSuffix = '```\n'
const checks = [
  ['T1', checkFence],
  ['T2', checkCanonical],
  ['T3', checkScaffold],
]
const enabledChecks = checks
let failed = 0
const lines = []

function diagnostic(value, fallback = 'unknown failure') {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (value && typeof value.message === 'string' && value.message.trim() !== '') return value.message.trim()
  return fallback
}

function readReadme() {
  try {
    if (!existsSync(readmeAbsolute)) return { ok: false, error: 'builder-3 README is missing' }
    const bytes = readFileSync(readmeAbsolute)
    if (!bytes || bytes.length === 0) return { ok: false, error: 'builder-3 README is empty' }
    return { ok: true, text: bytes.toString('utf8') }
  } catch (error) {
    return { ok: false, error: `builder-3 README could not be read (${diagnostic(error)})` }
  }
}

function block(text) {
  const source = text.split(/\r?\n/)
  const starts = source.reduce((found, line, index) => line.trim() === opening ? [...found, index] : found, [])
  const ends = source.reduce((found, line, index) => line.trim() === closing ? [...found, index] : found, [])
  if (starts.length !== 1 || ends.length !== 1) return { ok: false, error: `expected one work-item pair, found ${starts.length} opening and ${ends.length} closing fences` }
  if (ends[0] <= starts[0]) return { ok: false, error: 'work-item closing fence precedes opening fence' }
  return { ok: true, inner: source.slice(starts[0] + 1, ends[0]).join('\n'), prefix: source.slice(0, starts[0] + 1).join('\n'), suffix: source.slice(ends[0]).join('\n') }
}

function parsed() {
  const read = readReadme()
  if (!read.ok) return read
  const value = block(read.text)
  return value.ok ? { ok: true, value } : value
}

function checkFence() {
  const value = parsed()
  return value.ok ? true : value.error
}

function checkCanonical() {
  const value = parsed()
  if (!value.ok) return value.error
  const withoutComments = value.value.inner.replace(/<!--[\s\S]*?-->/g, '')
  const actual = withoutComments.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (value.value.inner.includes('PLACEHOLDER')) return 'work item still contains PLACEHOLDER'
  if (JSON.stringify(actual) !== JSON.stringify(expectedRows)) return `table rows are ${JSON.stringify(actual)}, expected ${JSON.stringify(expectedRows)}`
  return true
}

function checkScaffold() {
  const value = parsed()
  if (!value.ok) return value.error
  if (value.value.prefix !== expectedPrefix) return 'bytes before work item changed'
  if (value.value.suffix !== expectedSuffix) return 'bytes after work item changed'
  return true
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
