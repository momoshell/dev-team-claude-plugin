#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const root = process.cwd()
const readmePath = 'docs/audits/2026-09-17/bench/builder/README.md'
const opening = '```BENCH_WORK_ITEM'
const closing = '```'
const canonical = [-1, 2, 3]
const checks = [
  ['B1', checkMarkers],
  ['B2', checkCanonicalWorkItem],
  ['B3', checkOnlyReadmeChanged],
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
    if (!existsSync(join(root, readmePath))) return { ok: false, error: 'builder README is missing' }
    const bytes = readFileSync(join(root, readmePath))
    if (!bytes || bytes.length === 0) return { ok: false, error: 'builder README is empty' }
    return { ok: true, text: bytes.toString('utf8') }
  } catch (error) {
    return { ok: false, error: `builder README could not be read (${diagnostic(error)})` }
  }
}

function block(text) {
  const lines = text.split(/\r?\n/)
  const starts = lines.reduce((found, line, index) => line.trim() === opening ? [...found, index] : found, [])
  const ends = lines.reduce((found, line, index) => line.trim() === closing ? [...found, index] : found, [])
  if (starts.length !== 1) return { ok: false, error: `expected one ${opening} marker, found ${starts.length}` }
  const start = starts[0]
  const end = ends.find((index) => index > start)
  if (end === undefined) return { ok: false, error: 'work-item closing fence is missing' }
  if (ends.length !== 1) return { ok: false, error: `expected one closing fence, found ${ends.length}` }
  if (end <= start + 0) return { ok: false, error: 'work-item fence is empty' }
  return {
    ok: true,
    inner: lines.slice(start + 1, end).join('\n'),
    prefix: lines.slice(0, start + 1).join('\n'),
    suffix: lines.slice(end).join('\n'),
  }
}

function checkMarkers() {
  const read = readReadme()
  if (!read.ok) return read.error
  const parsed = block(read.text)
  return parsed.ok ? true : parsed.error
}

function parseWorkItem(text) {
  const parsed = block(text)
  if (!parsed.ok) return parsed
  const withoutComments = parsed.inner.replace(/<!--[\s\S]*?-->/g, '').trim()
  if (withoutComments === '') return { ok: false, error: 'work-item contains no JSON array' }
  let value
  try {
    value = JSON.parse(withoutComments)
  } catch (error) {
    return { ok: false, error: `work-item JSON is malformed (${diagnostic(error)})` }
  }
  if (!Array.isArray(value) || value.some((item) => !Number.isSafeInteger(item))) return { ok: false, error: 'work-item must be an integer array' }
  return { ok: true, value }
}

function checkCanonicalWorkItem() {
  const read = readReadme()
  if (!read.ok) return read.error
  const parsed = parseWorkItem(read.text)
  if (!parsed.ok) return parsed.error
  if (read.text.includes('PLACEHOLDER')) return 'work-item still contains the explicit placeholder'
  if (JSON.stringify(parsed.value) !== JSON.stringify(canonical)) return `work-item is ${JSON.stringify(parsed.value)}, expected ${JSON.stringify(canonical)}`
  return true
}

function gitDiffNames() {
  let result
  try {
    result = spawnSync('git', ['diff', '--name-only'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch (error) {
    return { ok: false, error: `git diff could not start (${diagnostic(error)})` }
  }
  if (result?.error) return { ok: false, error: `git diff failed (${diagnostic(result.error)})` }
  if (result?.signal) return { ok: false, error: `git diff was interrupted by ${result.signal}` }
  if (result?.status !== 0) return { ok: false, error: `git diff exited ${String(result?.status)}` }
  return { ok: true, names: String(result.stdout || '').split(/\r?\n/).map((name) => name.trim()).filter(Boolean) }
}

function committedReadme() {
  let result
  try {
    result = spawnSync('git', ['show', `HEAD:${readmePath}`], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch (error) {
    return { ok: false, error: `git show could not start (${diagnostic(error)})` }
  }
  if (result?.error) return { ok: false, error: `git show failed (${diagnostic(result.error)})` }
  if (result?.signal) return { ok: false, error: `git show was interrupted by ${result.signal}` }
  if (result?.status !== 0 || typeof result.stdout !== 'string' || result.stdout.length === 0) return { ok: false, error: 'committed builder README scaffold is unreadable' }
  return { ok: true, text: result.stdout }
}

function checkOnlyReadmeChanged() {
  const diff = gitDiffNames()
  if (!diff.ok) return diff.error
  if (diff.names.length !== 1 || diff.names[0] !== readmePath) return `expected git diff to contain only ${readmePath}, found ${diff.names.join(', ') || 'no tracked files'}`
  const current = readReadme()
  if (!current.ok) return current.error
  const committed = committedReadme()
  if (!committed.ok) return committed.error
  const currentBlock = block(current.text)
  const committedBlock = block(committed.text)
  if (!currentBlock.ok || !committedBlock.ok) return 'README scaffold comparison could not resolve one work-item block'
  if (currentBlock.prefix !== committedBlock.prefix || currentBlock.suffix !== committedBlock.suffix) {
    return 'bytes outside BENCH_WORK_ITEM changed'
  }
  return true
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
