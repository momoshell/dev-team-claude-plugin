#!/usr/bin/env node
// scripts/factory/prove-mutations.mjs — the hand mutation proof, executable (#928).
//
// skills/crew-recovery/references/mutation-proof.md is the specification: read the
// declarations from the planner envelope, refuse a baseline that is not green,
// mutate ONE detached worktree per declaration, restore in a `finally`, and verify a
// BYTE DIGEST of the lane tree afterwards. On 2026-09-05 a hand harness threw
// between a write and its restore, read the mutated file back as its next baseline,
// and reported "5 of 5 killed" against a tree its own crash had corrupted. Each
// refusal below is one of the steps that incident skipped.
//
// The gate CONTRACT is not re-implemented here: checkFailureLine, parseGateSummary,
// baselineGateDefect, applyMutationAnchor and validateMutations come from crew/drive.mjs,
// so the hand path and the driver path READ and adjudicate one declaration identically
// or not at all. In particular a red run is adjudicated STRUCTURALLY — a gate that
// printed no readable GATE-SUMMARY, or whose checks THREW, is not a kill however loudly
// it says FAIL — and a declaration SHAPE the driver would reject is never accepted here.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { applyMutationAnchor, baselineGateDefect, checkFailureLine, parseGateSummary, scopeMatcher, validateMutations } from '../../crew/drive.mjs'

export const GATE_SUMMARY_PREFIX = 'GATE-SUMMARY'
export const PROOF_REFUSALS = Object.freeze({
  NO_DECLARATIONS: 'no-declarations',
  DECLARATIONS_INVALID: 'declarations-invalid',
  TREE_UNCOMMITTED: 'tree-uncommitted',
  BASELINE_NOT_GREEN: 'baseline-not-green',
  TREE_NOT_RESTORED: 'tree-not-restored',
})
export const PROOF_OUTCOMES = Object.freeze(['killed', 'survived', 'bind-fail', 'unapplied', 'exempt', 'errored'])
export const RUN_MAX_BUFFER_BYTES = 64 * 1024 * 1024
export const USAGE = 'usage: node scripts/factory/prove-mutations.mjs --envelope <lane>/returns/d1.planner.json [--checkout <dir>] [--gate <command>] [--json] | --diff-config <task-local-json>'

export class ProveUsageError extends Error {
  constructor(message, reason = 'usage') {
    super(message)
    this.name = 'ProveUsageError'
    this.reason = reason
  }
}

// Copied from scripts/factory/closeout.mjs rather than imported: this factory
// boundary keeps the #240 child-environment rule local to each entry point.
// FORCE_COLOR OVERRIDES NO_COLOR, so a colour-neutral child must DELETE it.
export function colourNeutralEnv(base = process.env) {
  const env = { ...base }
  delete env.FORCE_COLOR
  delete env.CLICOLOR_FORCE
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_TEST_WORKER_ID
  env.NO_COLOR = '1'
  return env
}

export function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, '')
}

function readFileOrNull(abs) {
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null
}

// The PRESERVATION read: raw bytes, never decoded — for EVERY entry type. A checkout
// entry is a file's exact bytes, a symlink's target BYTES, a directory, or absent.
// Decoding to UTF-8 anywhere here would map every invalid byte sequence onto U+FFFD and
// make two different corruptions indistinguishable, and a symlink target is as capable
// of carrying non-UTF-8 bytes as a file is.
function readEntryDefault(abs) {
  let st = null
  try { st = lstatSync(abs) } catch { return null }
  if (st.isSymbolicLink()) return { type: 'symlink', target: readlinkSync(abs, { encoding: 'buffer' }) }
  if (st.isDirectory()) return { type: 'dir' }
  if (!st.isFile()) return { type: 'non-regular' }
  return { type: 'file', bytes: readFileSync(abs) }
}

function runGateDefault(gateCmd, cwd) {
  const res = spawnSync('/bin/sh', ['-c', gateCmd], { cwd, encoding: 'utf8', maxBuffer: RUN_MAX_BUFFER_BYTES, env: colourNeutralEnv(process.env) })
  if (res.error) throw new Error(`prove: the gate could not be spawned in ${cwd}: ${res.error.message}`)
  const output = `${res.stdout || ''}${res.stderr || ''}`
  return { ok: res.status === 0, output }
}

// Diff mode deliberately uses the same synchronous child-process primitive as the
// declared proof, but keeps command execution injectable for its fixture lane. A
// result with an error or a null status is not a red test: the command was not a
// completed observation and must remain a typed skip.
export const DIFF_RUN_TIMEOUT_MS = 900_000
function runCommandDefault(command, cwd, options = {}) {
  const res = spawnSync('/bin/sh', ['-c', command], {
    cwd, encoding: 'utf8', maxBuffer: RUN_MAX_BUFFER_BYTES,
    timeout: options.timeout ?? DIFF_RUN_TIMEOUT_MS,
    env: options.env || colourNeutralEnv(process.env),
  })
  const output = `${res.stdout || ''}${res.stderr || ''}`
  return {
    ok: res.status === 0,
    output,
    status: res.status,
    signal: res.signal || null,
    error: res.error ? { code: res.error.code, message: res.error.message } : null,
    completed: !res.error && res.status !== null,
  }
}

function makeWorktreeDefault(checkout, ref) {
  const dir = join(mkdtempSync(join(tmpdir(), 'prove-mutations-')), 'tree')
  const add = spawnSync('git', ['-C', checkout, 'worktree', 'add', '--detach', dir, ref], { encoding: 'utf8' })
  if (add.status !== 0) throw new Error(`prove: git worktree add --detach failed at ${dir}, refusing to mutate the lane tree in place:\n${add.stderr || add.stdout || ''}`)
  return dir
}

function removeWorktreeDefault(checkout, dir) {
  const res = spawnSync('git', ['-C', checkout, 'worktree', 'remove', '--force', dir], { encoding: 'utf8' })
  if (res.status === 0) return { removed: true, why: null }
  return { removed: false, why: res.stderr || res.stdout || `git worktree remove exited ${String(res.status)}` }
}

function headShaDefault(checkout) {
  return execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

// Every tracked and non-ignored untracked path, git metadata excluded by git itself.
// Not the declared mutation targets: a proof that restores what it mutated and leaves
// some OTHER path corrupted has still corrupted the lane tree.
function listPathsDefault(checkout) {
  const out = execFileSync('git', ['-C', checkout, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: RUN_MAX_BUFFER_BYTES })
  return out.split('\0').filter((path) => path.length > 0)
}

// A detached worktree carries only COMMITTED bytes, so ANY uncommitted path — not
// just a declared mutation target — means the gate the proof runs is reading
// something the operator never built.
function dirtyPathsDefault(checkout) {
  const out = execFileSync('git', ['-C', checkout, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8', maxBuffer: RUN_MAX_BUFFER_BYTES })
  return out.split('\n').filter((line) => line.trim().length > 0).map((line) => line.slice(3).trim())
}

export function normalDeps(deps = {}) {
  return {
    runGate: deps.runGate || runGateDefault,
    runCommand: deps.runCommand || runCommandDefault,
    makeWorktree: deps.makeWorktree || makeWorktreeDefault,
    removeWorktree: deps.removeWorktree || removeWorktreeDefault,
    readFile: deps.readFile || readFileOrNull,
    readBytes: deps.readBytes || ((abs) => readFileSync(abs)),
    readEntry: deps.readEntry || readEntryDefault,
    lstat: deps.lstat || lstatSync,
    realpath: deps.realpath || realpathSync,
    writeFile: deps.writeFile || ((abs, text) => writeFileSync(abs, text)),
    headSha: deps.headSha || headShaDefault,
    listPaths: deps.listPaths || listPathsDefault,
    dirtyPaths: deps.dirtyPaths || dirtyPathsDefault,
    stdout: deps.stdout || ((text) => process.stdout.write(text)),
    stderr: deps.stderr || ((text) => process.stderr.write(text)),
  }
}

// Both spellings, because both appear in real envelopes: the driver's own contract
// says `check`, and hand-written declarations have shipped as `id`. The `id` spelling is
// NORMALIZED onto `check` first — a conflicting pair is refused rather than silently
// preferred — and then every remaining declaration goes through the driver's OWN
// validateMutations. That is the same-guarantees premise made literal: a shape the driver
// rejects can never be accepted here, so an entry carrying BOTH `exempt` and mutation
// fields is refused instead of being credited as an exemption that satisfies exit 0.
export function readDeclarations(envelope) {
  const declarations = []
  const refusals = []
  const entries = envelope?.details?.mutations
  if (!Array.isArray(entries)) return { declarations, refusals: [{ check: null, why: 'the envelope carries no details.mutations array' }] }
  const normalized = []
  for (const entry of entries) {
    const spelled = typeof entry?.check === 'string' ? entry.check : null
    const aliased = typeof entry?.id === 'string' ? entry.id : null
    if (spelled !== null && aliased !== null && spelled !== aliased) {
      refusals.push({ check: spelled, why: `the declaration spells its label both check ${JSON.stringify(spelled)} and id ${JSON.stringify(aliased)}, and the two disagree` })
      continue
    }
    const check = spelled ?? aliased
    if (check === null || check.length === 0) {
      refusals.push({ check: null, why: 'a declaration carries neither a check nor an id' })
      continue
    }
    const rest = { ...(entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}) }
    delete rest.id
    normalized.push({ ...rest, check })
  }
  const errors = validateMutations(normalized)
  for (const error of errors) refusals.push({ check: typeof error?.entry?.check === 'string' ? error.entry.check : null, why: error.why })
  const rejected = new Set(errors.map((error) => error?.entry?.check).filter((check) => typeof check === 'string'))
  // An error whose `entry` is not one of the normalized records is a WHOLE-ARRAY verdict
  // (over MUTATIONS_MAX, not an array): nothing in it is individually creditable.
  const wholeArray = errors.some((error) => typeof error?.entry?.check !== 'string')
  for (const entry of normalized) {
    if (wholeArray || rejected.has(entry.check)) continue
    if (typeof entry.exempt === 'string') {
      declarations.push({ check: entry.check, file: null, find: null, replace: null, exempt: entry.exempt })
      continue
    }
    declarations.push({ check: entry.check, file: entry.file, find: entry.find, replace: entry.replace, exempt: null })
  }
  return { declarations, refusals }
}

function bytesDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

// A BYTE fingerprint, never `git diff --stat` and never a decoded string — and that
// holds for a symlink TARGET too, not only for file contents: the incident's stat
// output was identical before and after, which MASKED the leak.
export function entryFingerprint(entry) {
  if (entry === null || entry === undefined) return 'absent'
  if (entry.type === 'symlink') return `symlink:${bytesDigest(entry.target)}`
  if (entry.type === 'dir') return 'dir'
  if (entry.type === 'non-regular') return 'non-regular'
  return `file:${bytesDigest(entry.bytes)}`
}

// The whole non-ignored checkout, plus the declared files so a target can never
// fall out of the snapshot. Recomputed after the loop: a path that ARRIVED or
// VANISHED is a corruption a fixed path list cannot see.
export function inventoryPaths(checkout, files = [], deps = {}) {
  const d = normalDeps(deps)
  const listed = d.listPaths(checkout)
  return [...new Set([...listed, ...files])].sort()
}

export function treeDigest(checkout, paths, deps = {}) {
  const d = normalDeps(deps)
  const parts = [...new Set(paths)].sort().map((rel) => `${rel} ${entryFingerprint(d.readEntry(join(checkout, rel)))}`)
  return createHash('sha256').update(parts.join('\n')).digest('hex')
}

// The COUNT the report needs. The bind DECISION is applyMutationAnchor's, but a
// reader cannot act on "did not bind" without knowing whether it bound zero times
// or many, so this counts exact hits and falls back to whitespace-normalized ones.
export function bindOccurrences(original, find) {
  const text = String(original ?? '')
  const needle = String(find ?? '')
  if (needle.length === 0) return 0
  let hits = 0
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) hits += 1
  if (hits > 0) return hits
  const flat = text.replace(/\s+/g, ' ')
  const flatNeedle = needle.replace(/\s+/g, ' ').trim()
  if (flatNeedle.length === 0) return 0
  for (let at = flat.indexOf(flatNeedle); at !== -1; at = flat.indexOf(flatNeedle, at + 1)) hits += 1
  return hits
}

export function bindLabel(hits) {
  return `BIND-FAIL(${hits})`
}

// Why a GREEN run is not usable as a baseline. null = it is usable. The mirror of
// the driver's baselineGateDefect: exit 0 is not evidence a gate RAN, and a proof
// whose baseline never ran cannot tell a kill from a gate that was broken all along.
export function greenGateDefect(output) {
  const summary = parseGateSummary(output)
  if (!summary) return `the gate printed no readable ${GATE_SUMMARY_PREFIX} line, so exit 0 is not evidence any check ran`
  if (summary.errored > 0) return `${summary.errored} of ${summary.total} checks THREW instead of adjudicating`
  if (summary.failed !== 0) return `the summary reports ${summary.failed} failed checks, which contradicts the zero exit`
  if (!(summary.total > 0)) return 'the summary reports 0 checks in total, so the gate adjudicated nothing'
  return null
}

// The strip is on BOTH sides of the adjudication, never only the mutation side: a gate
// whose GATE-SUMMARY arrives coloured parses to nothing, and an unstripped baseline then
// refuses a green run that ran every check (#240).
export function baselineNotGreen({ ok, output }) {
  if (!ok) return 'the gate exited non-zero on the unmutated scratch tree, so a kill would prove nothing'
  return greenGateDefect(stripAnsi(output))
}

// Why a mutation run is NOT a kill. null = it is one. baselineGateDefect comes from
// the driver: a red gate with no readable summary, or one whose checks threw, is a
// BROKEN gate, and crediting it would be the false positive #928 records.
export function adjudicate(output, check, ok) {
  if (ok) return 'the gate stayed GREEN under the mutation'
  const defect = baselineGateDefect(output)
  if (defect) return `the gate went red but ${defect}, so nothing here adjudicates ${check}`
  if (checkFailureLine(output, check)) return null
  return `the gate went red but printed no "FAIL ${check}" line, so the check that failed is not the one under proof`
}

function unappliedRow(mutation, where) {
  return { check: mutation.check, outcome: 'unapplied', file: mutation.file, summary: null, why: `${mutation.file} does not exist in ${where}` }
}

function bindFailRow(mutation, hits) {
  return { check: mutation.check, outcome: 'bind-fail', file: mutation.file, summary: null, why: `${bindLabel(hits)} the declared find text occurs ${hits} times in ${mutation.file}, so it names no single span to mutate` }
}

function erroredRow(mutation, err) {
  return { check: mutation.check, outcome: 'errored', file: mutation.file, summary: null, why: err?.message || String(err) }
}

// ONE mutation, in a tree the caller owns. The restore is in a `finally` because the
// throw that corrupted the 2026-09-05 tree landed between the write and the restore
// line; nothing else in this file can put those bytes back.
export function proveOne({ dir, mutation, gateCmd, deps = {} }) {
  const d = normalDeps(deps)
  const abs = join(dir, mutation.file)
  const original = d.readFile(abs)
  if (original === null) return unappliedRow(mutation, 'the scratch worktree')
  const bound = applyMutationAnchor(original, mutation.find, mutation.replace)
  if (bound.text === null) return bindFailRow(mutation, bindOccurrences(original, mutation.find))
  let res = null
  try {
    d.writeFile(abs, bound.text)
    res = d.runGate(gateCmd, dir)
  } finally { d.writeFile(abs, original) }
  const output = stripAnsi(res.output)
  const summary = parseGateSummary(output)
  const why = adjudicate(output, mutation.check, res.ok)
  const outcome = why ? 'survived' : 'killed'
  return { check: mutation.check, outcome, file: mutation.file, summary, why }
}

export function countRows(rows, declarations) {
  const of = (outcome) => rows.filter((row) => row.outcome === outcome).length
  return {
    declared: declarations.length,
    bound: of('killed') + of('survived'),
    killed: of('killed'),
    survived: of('survived'),
    bindFail: of('bind-fail'),
    unapplied: of('unapplied'),
    errored: of('errored'),
    exempt: of('exempt'),
  }
}

export function proveMutations({ checkout, declarations = [], invalid = [], gateCmd, deps = {} }) {
  const d = normalDeps(deps)
  const rows = []
  const kept = []
  const files = [...new Set(declarations.filter((entry) => !entry.exempt && entry.file).map((entry) => entry.file))].sort()
  const done = (refusal) => ({ refusal, rows, counts: countRows(rows, declarations), kept, checkout, gateCmd })
  // TERMINAL, and before any worktree or gate: an envelope the reader could not
  // fully read is not a proof of the part it could. Reporting "1 of 1 killed" after
  // silently dropping a second declaration is the shape this refusal removes.
  if (invalid.length > 0) return done({ reason: PROOF_REFUSALS.DECLARATIONS_INVALID, why: `${invalid.length} of ${invalid.length + declarations.length} declarations could not be read: ${invalid.map((entry) => `${JSON.stringify(entry.check ?? null)} — ${entry.why}`).join('; ')}` })
  if (declarations.length === 0) return done({ reason: PROOF_REFUSALS.NO_DECLARATIONS, why: 'the envelope declared no usable mutation, so there is nothing to prove' })
  const dirty = d.dirtyPaths(checkout)
  if (dirty.length > 0) return done({ reason: PROOF_REFUSALS.TREE_UNCOMMITTED, why: `a detached worktree carries only committed bytes, and these checkout paths are uncommitted: ${dirty.join(', ')}` })
  const head = d.headSha(checkout)
  const beforePaths = inventoryPaths(checkout, files, d)
  const before = treeDigest(checkout, beforePaths, d)
  const baseTree = d.makeWorktree(checkout, head)
  let baseline = null
  try { baseline = d.runGate(gateCmd, baseTree) } finally {
    if (baseTree !== checkout) { const gone = d.removeWorktree(checkout, baseTree); if (!gone.removed) kept.push(baseTree) }
  }
  const baselineDefect = baselineNotGreen(baseline)
  if (baselineDefect) return done({ reason: PROOF_REFUSALS.BASELINE_NOT_GREEN, why: `${baselineDefect}:\n${stripAnsi(baseline.output).slice(-2000)}` })
  for (const mutation of declarations) {
    if (mutation.exempt) { rows.push({ check: mutation.check, outcome: 'exempt', file: null, summary: null, why: mutation.exempt }); continue }
    let dir = null
    try {
      dir = d.makeWorktree(checkout, head)
      const original = d.readFile(join(dir, mutation.file))
      if (original === null) { rows.push(unappliedRow(mutation, 'the scratch worktree')); continue }
      const hits = bindOccurrences(original, mutation.find)
      if (hits !== 1) { rows.push(bindFailRow(mutation, hits)); continue }
      rows.push(proveOne({ dir, mutation, gateCmd, deps: d }))
    } catch (err) {
      rows.push(erroredRow(mutation, err))
    } finally {
      if (dir !== null && dir !== checkout) { const gone = d.removeWorktree(checkout, dir); if (!gone.removed) kept.push(dir) }
    }
  }
  const afterPaths = inventoryPaths(checkout, files, d)
  const after = treeDigest(checkout, afterPaths, d)
  if (after !== before) return done({ reason: PROOF_REFUSALS.TREE_NOT_RESTORED, why: `the checkout does not match its pre-proof bytes: digest ${before} became ${after}` })
  return done(null)
}

// ---------------------------------------------------------------------------
// Changed-hunk mutation supplement (#1029)
//
// This mode is intentionally separate from the declared-anchor proof above. The
// driver owns the round baseline, patch bytes, scope and effective cap; this
// module only consumes that closed record and measures the exact hunk it was
// handed. Keeping the parser and runner here synchronous is important: a diff
// proof must not overlap a builder round or silently observe a later generation.
export const DIFF_MUTATION_SUMMARY_PREFIX = 'DIFF-MUTATION-SUMMARY'
export const DIFF_CONFIG_VERSION = 1
export const DIFF_MUTATION_CAP_DEFAULT = 8
export const DIFF_MUTATION_CAP_MIN = 1
export const DIFF_MUTATION_CAP_MAX = 64
export const DIFF_MUTATION_OMITTED_REASON = 'mutants beyond the configured cap are omitted because each mutant runs both the accepted validation lane and gate and large diffs otherwise multiply suite cost; omitted mutants are a blind spot'
export const DIFF_CONFIG_KEYS = Object.freeze(['version', 'checkout', 'patch', 'files_in_scope', 'validation_lane', 'gate_cmd', 'cap', 'generation'])
export const DIFF_SKIP_REASONS = Object.freeze([
  'empty-patch', 'malformed-diff', 'malformed-header', 'malformed-hunk',
  'binary', 'absolute-path', 'traversal-path', 'deleted-file', 'non-mjs',
  'test-file', 'comment-or-blank', 'unsupported-line', 'conditional-unbalanced',
  'unsafe-target:absent', 'unsafe-target:symlink', 'unsafe-target:non-regular',
  'unsafe-target:canonical-escape', 'unsafe-target:metadata-unreadable',
  'unsafe-target:checkout-unreadable', 'target-changed', 'write-failed',
  'runner-unavailable', 'out-of-scope',
])

const DIFF_COMPARISON_ORDER = Object.freeze(['===', '!==', '==', '!=', '<=', '>=', '<', '>'])
const DIFF_COMPARISON_REPLACEMENTS = Object.freeze({
  '===': '!==', '!==': '===', '==': '!=', '!=': '==',
  '<=': '>', '>': '<=', '>=': '<', '<': '>=',
})
const DIFF_OPERATOR_ORDER = Object.freeze({ conditional: 0, comparison: 1, literal: 2, delete: 3 })

const diffTestPath = (path) => /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/.test(path)
  || /(?:\.test|\.spec)\.mjs$/.test(path)
const diffPathReason = (path) => {
  if (path === '/dev/null') return 'dev-null'
  if (typeof path !== 'string' || path.length === 0) return 'malformed-header'
  if (path.startsWith('/') || /^[A-Za-z]:[\/]/.test(path)) return 'absolute-path'
  if (path.includes('\\') || path.split('/').some((part) => part === '.' || part === '..')) return 'traversal-path'
  if (!path.endsWith('.mjs')) return 'non-mjs'
  if (diffTestPath(path)) return 'test-file'
  return null
}

function diffSkip({ path = null, reason, line = null, candidate = null } = {}) {
  return {
    outcome: 'skipped',
    id: candidate?.id ?? null,
    path: path ?? candidate?.path ?? null,
    line: line ?? candidate?.line ?? null,
    operator: candidate?.operator ?? null,
    original: candidate?.original ?? null,
    replacement: candidate?.replacement ?? null,
    skip_reason: reason,
    why: reason,
  }
}

function parseDiffSide(raw) {
  const value = String(raw ?? '').split('\t')[0].trim()
  if (value === '/dev/null') return { path: null, devNull: true, reason: null }
  const path = value.replace(/^[ab]\//, '')
  const reason = diffPathReason(path)
  return { path, devNull: false, reason }
}

function parseDiffHunkHeader(line) {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line)
  if (!match) return null
  const oldStart = Number(match[1])
  const oldCount = match[2] === undefined ? 1 : Number(match[2])
  const newStart = Number(match[3])
  const newCount = match[4] === undefined ? 1 : Number(match[4])
  if (![oldStart, oldCount, newStart, newCount].every((value) => Number.isSafeInteger(value) && value >= 0)) return null
  if ((oldCount > 0 && oldStart < 1) || (newCount > 0 && newStart < 1)) return null
  return { oldStart, oldCount, newStart, newCount }
}

function parseDiffSection(section, sectionIndex) {
  const first = section[0]
  const result = { path: null, added: [], skips: [], order: sectionIndex }
  const skip = (reason, path = result.path) => { result.skips.push(diffSkip({ path, reason })) }
  if (!/^diff --git /.test(first)) { skip('malformed-diff'); return result }
  const names = /^diff --git a\/(.+) b\/(.+)$/.exec(first)
  if (!names || names[1] !== names[2]) { skip('malformed-diff'); return result }
  const declaredPath = names[1]
  const declaredReason = diffPathReason(declaredPath)
  if (declaredReason) { skip(declaredReason, declaredPath); return result }
  result.path = declaredPath
  if (section.some((line) => line === 'Binary files' || line.startsWith('Binary files ') || line === 'GIT binary patch')) {
    skip('binary')
    return result
  }
  const oldHeaderIndex = section.findIndex((line) => line.startsWith('--- '))
  const newHeaderIndex = section.findIndex((line) => line.startsWith('+++ '))
  const oldLines = section.filter((line) => line.startsWith('--- '))
  const newLines = section.filter((line) => line.startsWith('+++ '))
  if (oldLines.length !== 1 || newLines.length !== 1 || oldHeaderIndex < 0 || newHeaderIndex < oldHeaderIndex) { skip('malformed-header'); return result }
  const oldSide = parseDiffSide(oldLines[0].slice(4))
  const newSide = parseDiffSide(newLines[0].slice(4))
  if (!oldSide.devNull && oldSide.reason) { skip(oldSide.reason, oldSide.path); return result }
  if (!newSide.devNull && newSide.reason) { skip(newSide.reason, newSide.path); return result }
  if (oldSide.devNull && newSide.devNull) { skip('malformed-header'); return result }
  if (newSide.devNull) { skip('deleted-file', oldSide.path || declaredPath); return result }
  if ((!oldSide.devNull && oldSide.path !== declaredPath) || newSide.path !== declaredPath) {
    skip('malformed-header', newSide.path || oldSide.path)
    return result
  }
  result.path = newSide.path

  const hunkStarts = []
  for (let index = 0; index < section.length; index += 1) if (section[index].startsWith('@@')) hunkStarts.push(index)
  if (hunkStarts.length === 0) { skip('malformed-hunk'); return result }
  if (hunkStarts.some((index) => index <= newHeaderIndex)) { skip('malformed-hunk'); return result }
  for (let h = 0; h < hunkStarts.length; h += 1) {
    const start = hunkStarts[h]
    const end = h + 1 < hunkStarts.length ? hunkStarts[h + 1] : section.length
    const header = parseDiffHunkHeader(section[start])
    if (!header) { skip('malformed-hunk'); continue }
    let oldSeen = 0
    let newSeen = 0
    let newLine = header.newStart
    let malformed = false
    for (let index = start + 1; index < end; index += 1) {
      const line = section[index]
      if (line === '\\ No newline at end of file') continue
      if (line.startsWith('+')) {
        result.added.push({ lineNumber: newLine, text: line.slice(1), order: [sectionIndex, start, index] })
        newSeen += 1; newLine += 1
      } else if (line.startsWith(' ')) {
        oldSeen += 1; newSeen += 1; newLine += 1
      } else if (line.startsWith('-')) {
        oldSeen += 1
      } else {
        malformed = true
      }
    }
    if (malformed || oldSeen !== header.oldCount || newSeen !== header.newCount) {
      result.added = result.added.filter((entry) => !(entry.order[0] === sectionIndex && entry.order[1] === start))
      skip('malformed-hunk')
    }
  }
  if (result.added.length === 0 && result.skips.length === 0) skip('unsupported-line')
  return result
}

// Parse only the small, deliberately closed unified-zero grammar. A malformed
// section is a skip rather than a reason to guess at a different patch format.
export function parseUnifiedZeroPatch(patch) {
  if (typeof patch !== 'string' || patch.length === 0) return { files: [], skips: [diffSkip({ reason: 'empty-patch' })] }
  const lines = patch.split('\n').map((line) => line.endsWith('\r') ? line.slice(0, -1) : line)
  if (lines.at(-1) === '') lines.pop()
  const starts = lines.map((line, index) => line.startsWith('diff --git ') ? index : -1).filter((index) => index >= 0)
  if (starts.length === 0) return { files: [], skips: [diffSkip({ reason: 'malformed-diff' })] }
  if (lines.slice(0, starts[0]).some((line) => line.trim() !== '')) return { files: [], skips: [diffSkip({ reason: 'malformed-diff' })] }
  const files = []
  const skips = []
  for (let index = 0; index < starts.length; index += 1) {
    const section = lines.slice(starts[index], starts[index + 1] ?? lines.length)
    const parsed = parseDiffSection(section, index)
    if (parsed.files) files.push(...parsed.files)
    if (parsed.path && parsed.added.length > 0) files.push({ path: parsed.path, added: parsed.added, order: parsed.order })
    skips.push(...parsed.skips)
  }
  files.sort((a, b) => a.order - b.order || a.path.localeCompare(b.path))
  return { files, skips }
}

// Friendly aliases keep the pure helper useful to callers that call the input a
// diff rather than a patch. They all return the same closed object.
export const parseDiffPatch = parseUnifiedZeroPatch
export const parseUnifiedPatch = parseUnifiedZeroPatch
export const parseUnifiedDiff = parseUnifiedZeroPatch
export const parseDiff = parseUnifiedZeroPatch

function codeMaskState(line, initialMode = 'code') {
  const chars = String(line).split('')
  let mode = initialMode
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]
    const next = chars[i + 1]
    if (mode === 'line-comment') { chars[i] = ' '; continue }
    if (mode === 'block-comment') {
      if (ch === '*' && next === '/') { chars[i] = ' '; chars[i + 1] = ' '; i += 1; mode = 'code' }
      else chars[i] = ' '
      continue
    }
    if (mode === 'single' || mode === 'double' || mode === 'template') {
      if (ch === '\\') { chars[i] = ' '; if (i + 1 < chars.length) { chars[i + 1] = ' '; i += 1 }; continue }
      if ((mode === 'single' && ch === "'") || (mode === 'double' && ch === '"') || (mode === 'template' && ch === '`')) { chars[i] = ' '; mode = 'code' }
      else chars[i] = ' '
      continue
    }
    if (ch === '/' && next === '/') { chars[i] = ' '; chars[i + 1] = ' '; i += 1; mode = 'line-comment'; continue }
    if (ch === '/' && next === '*') { chars[i] = ' '; chars[i + 1] = ' '; i += 1; mode = 'block-comment'; continue }
    if (ch === "'") { chars[i] = ' '; mode = 'single'; continue }
    if (ch === '"') { chars[i] = ' '; mode = 'double'; continue }
    if (ch === '`') { chars[i] = ' '; mode = 'template'; continue }
  }
  return { masked: chars.join(''), mode: mode === 'line-comment' ? 'code' : mode }
}

function codeMask(line) {
  return codeMaskState(line).masked
}

function balancedCode(text) {
  const masked = codeMask(text)
  const stack = []
  const pairs = { '(': ')', '[': ']', '{': '}' }
  for (const ch of masked) {
    if (pairs[ch]) stack.push(pairs[ch])
    else if (Object.values(pairs).includes(ch)) {
      if (stack.pop() !== ch) return false
    }
  }
  return stack.length === 0
}

function quotedLiterals(line) {
  const found = []
  let mode = 'code'
  let start = -1
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    const next = line[i + 1]
    if (mode === 'line-comment') break
    if (mode === 'block-comment') {
      if (ch === '*' && next === '/') { i += 1; mode = 'code' }
      continue
    }
    if (mode === 'code') {
      if (ch === '/' && next === '/') { mode = 'line-comment'; continue }
      if (ch === '/' && next === '*') { mode = 'block-comment'; i += 1; continue }
      if (ch === "'" || ch === '"') { mode = ch; start = i }
      continue
    }
    if (ch === '\\') { i += 1; continue }
    if (ch === mode) { found.push({ start, end: i + 1, text: line.slice(start, i + 1) }); mode = 'code'; start = -1 }
  }
  return found
}

function mutateQuoted(token) {
  const quote = token[0]
  return `${quote}${quote}`
}

function mutateNumber(token) {
  const value = Number(token)
  if (!Number.isFinite(value)) return null
  return String(value + 1)
}

function lineCandidates(file, entry, maskedOverride = null, modeBefore = 'code') {
  const line = entry.text
  const lineNumber = entry.lineNumber
  const candidates = []
  const skips = []
  const makeCandidate = (operator, path, lineNo, original, replacement, token = null, tokenOffset = null) => {
    const id = createHash('sha256').update(JSON.stringify([path, lineNo, operator, original, replacement])).digest('hex')
    return { id, path, line: lineNo, lineNumber: lineNo, operator, token, token_offset: tokenOffset, original, replacement, patch_order: entry.order }
  }
  const masked = maskedOverride === null ? codeMask(line) : maskedOverride
  const control = /^\s*(?:if|else\s+if|while)\s*\(/.exec(masked)
  const lineBalanced = balancedCode(line)
  let conditional = null
  let conditionEnd = null
  if (control) {
    const open = masked.indexOf('(', control.index)
    let depth = 0
    let close = -1
    for (let i = open; i < masked.length; i += 1) {
      if (masked[i] === '(') depth += 1
      else if (masked[i] === ')') { depth -= 1; if (depth === 0) { close = i; break } }
    }
    if (close < 0) skips.push(diffSkip({ path: file, reason: 'conditional-unbalanced', line: lineNumber }))
    else {
      const inner = line.slice(open + 1, close)
      if (inner.trim() === '' || !balancedCode(inner)) skips.push(diffSkip({ path: file, reason: 'conditional-unbalanced', line: lineNumber }))
      else {
        conditionEnd = close + 1
        conditional = `${line.slice(0, open + 1)}!(${inner})${line.slice(close)}`
      }
    }
  }
  const flipped = conditional
  if (conditional) candidates.push(makeCandidate('conditional', file, lineNumber, line, flipped))

  if (!lineBalanced && !conditional) return { candidates, skips: skips.length > 0 ? skips : [diffSkip({ path: file, reason: 'malformed-hunk', line: lineNumber })] }

  const scanText = !lineBalanced && conditionEnd !== null ? masked.slice(0, conditionEnd) : masked
  const comparison = new RegExp(DIFF_COMPARISON_ORDER.map((operator) => operator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
  for (const match of scanText.matchAll(comparison)) {
    const operator = match[0]
    const at = match.index
    const before = scanText[at - 1]
    const after = scanText[at + operator.length]
    if ((operator === '>' && before === '=') || (operator.length === 1 && (before === operator || after === operator))) continue
    const replacement = DIFF_COMPARISON_REPLACEMENTS[operator]
    if (replacement) {
      const flipped = `${line.slice(0, at)}${replacement}${line.slice(at + operator.length)}`
      candidates.push(makeCandidate('comparison', file, lineNumber, line, flipped, operator, at))
    }
  }

  const literal = /(?<![A-Za-z0-9_$])(?:true|false|null|-?(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?))(?![A-Za-z0-9_$])/g
  for (const match of scanText.matchAll(literal)) {
    const replacement = match[0] === 'true' ? 'false'
      : match[0] === 'false' ? 'true'
        : match[0] === 'null' ? 'undefined' : mutateNumber(match[0])
    if (!replacement || replacement === match[0]) continue
    const changed = `${line.slice(0, match.index)}${replacement}${line.slice(match.index + match[0].length)}`
    candidates.push(makeCandidate('literal', file, lineNumber, line, changed, match[0], match.index))
  }
  if (modeBefore === 'code') for (const token of quotedLiterals(line.slice(0, scanText.length))) {
    const replacement = mutateQuoted(token.text)
    if (replacement === token.text) continue
    const changed = `${line.slice(0, token.start)}${replacement}${line.slice(token.end)}`
    candidates.push(makeCandidate('literal', file, lineNumber, line, changed, token.text, token.start))
  }

  const trimmed = scanText.trim()
  const incomplete = /(?:=>|[=+\-*\/%&|?:<>.,])\s*$/.test(trimmed)
  const declaration = !incomplete && /^(?:export\s+)?(?:const|let|var)\b/.test(trimmed)
  const returnOrThrow = !incomplete && /^(?:return|throw)\b/.test(trimmed)
  const assignment = !incomplete && /^[A-Za-z_$][\w$]*(?:\s*\.[A-Za-z_$][\w$]*|\s*\[[^\]]+\])*\s*(?:=(?!=|>)|\+=|-=|\*=|\/=)\s*(?=\S)/.test(trimmed)
  const call = !incomplete && /^(?:await\s+)?[A-Za-z_$][\w$]*(?:\s*\.[A-Za-z_$][\w$]*|\s*\[[^\]]+\])*\s*\(/.test(trimmed)
  if (lineBalanced && (declaration || returnOrThrow || assignment || (call && !/^\s*(?:if|while|for|switch|catch)\b/.test(trimmed)))) {
    candidates.push(makeCandidate('delete', file, lineNumber, line, '', null, Number.POSITIVE_INFINITY))
  }
  if (candidates.length === 0 && skips.length === 0 && !/^\s*(?:$|\/\/|\*)/.test(masked)) skips.push(diffSkip({ path: file, reason: 'unsupported-line', line: lineNumber }))
  if (candidates.length === 0 && skips.length === 0) skips.push(diffSkip({ path: file, reason: 'comment-or-blank', line: lineNumber }))
  return { candidates, skips }
}

export function makeDiffCandidate(path, line, operator, original, replacement, token = null) {
  const id = createHash('sha256').update(JSON.stringify([path, line, operator, original, replacement])).digest('hex')
  return { id, path, line, lineNumber: line, operator, token, original, replacement, patch_order: null }
}

export function generateDiffCandidates(input) {
  const parsed = typeof input === 'string' ? parseUnifiedZeroPatch(input) : input && Array.isArray(input.files) ? input : { files: [], skips: [diffSkip({ reason: 'malformed-diff' })] }
  const candidates = []
  const skips = [...(Array.isArray(parsed.skips) ? parsed.skips : [])]
  for (const file of parsed.files || []) {
    let mode = 'code'
    for (const added of file.added || []) {
      const masked = codeMaskState(added.text, mode)
      const result = lineCandidates(file.path, added, masked.masked, mode)
      candidates.push(...result.candidates)
      skips.push(...result.skips)
      mode = masked.mode
    }
  }
  candidates.sort((a, b) => {
    const ao = a.patch_order || [0, 0, 0]
    const bo = b.patch_order || [0, 0, 0]
    return ao[0] - bo[0] || ao[1] - bo[1] || ao[2] - bo[2]
      || (DIFF_OPERATOR_ORDER[a.operator] ?? 99) - (DIFF_OPERATOR_ORDER[b.operator] ?? 99)
      || (a.token_offset ?? Number.POSITIVE_INFINITY) - (b.token_offset ?? Number.POSITIVE_INFINITY)
      || String(a.token ?? '').localeCompare(String(b.token ?? ''))
  })
  return { candidates, skips }
}
export const generateCandidates = generateDiffCandidates

function bytesOf(value) {
  try {
    if (Buffer.isBuffer(value)) return Buffer.from(value)
    if (value instanceof Uint8Array) return Buffer.from(value)
    if (typeof value === 'string') return Buffer.from(value)
  } catch {}
  return null
}

function sameBytes(a, b) {
  return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b)
}

function applyDiffCandidate(bytes, candidate) {
  const source = bytesOf(bytes)
  if (!source) return { bytes: null, reason: 'unsafe-target:metadata-unreadable' }
  const text = source.toString('utf8')
  if (!sameBytes(source, Buffer.from(text))) return { bytes: null, reason: 'unsafe-target:metadata-unreadable' }
  const parts = text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter((part) => part !== '') || []
  const index = candidate.line - 1
  if (index < 0 || index >= parts.length) return { bytes: null, reason: 'target-changed' }
  const match = /([^\r\n]*)(\r\n|\n|\r|$)/.exec(parts[index])
  if (!match || match[1] !== candidate.original) return { bytes: null, reason: 'target-changed' }
  parts[index] = `${candidate.replacement}${match[2]}`
  return { bytes: Buffer.from(parts.join('')), reason: null }
}
export { applyDiffCandidate }

function pathInside(child, parent) {
  return parent === sep ? child.startsWith(sep) : child === parent || child.startsWith(`${parent}${sep}`)
}

function diffTargetGuard(config, candidate, d, canonicalCheckout = null) {
  const abs = join(config.checkout, candidate.path)
  let stat
  try { stat = d.lstat(abs) }
  catch (err) {
    return { ok: false, reason: err?.code === 'ENOENT' ? 'unsafe-target:absent' : 'unsafe-target:metadata-unreadable' }
  }
  try {
    if (stat?.isSymbolicLink?.()) return { ok: false, reason: 'unsafe-target:symlink' }
    if (!stat?.isFile?.()) return { ok: false, reason: 'unsafe-target:non-regular' }
  } catch { return { ok: false, reason: 'unsafe-target:metadata-unreadable' } }
  let checkoutPath
  let targetPath
  try {
    checkoutPath = canonicalCheckout || d.realpath(config.checkout)
    targetPath = d.realpath(abs)
  } catch { return { ok: false, reason: 'unsafe-target:metadata-unreadable' } }
  if (!pathInside(targetPath, checkoutPath)) return { ok: false, reason: 'unsafe-target:canonical-escape' }
  return { ok: true, abs, checkout: checkoutPath, target: targetPath }
}

function diffInventory(checkout, d) {
  const paths = inventoryPaths(checkout, [], d)
  return { paths, digest: treeDigest(checkout, paths, d) }
}

function samePathSet(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function normalizeDiffCommandResult(result) {
  if (!result || typeof result !== 'object') return { available: false, why: 'runner-unavailable' }
  if (result.error || result.signal || result.completed === false || result.status === null) return { available: false, why: 'runner-unavailable' }
  if (typeof result.ok !== 'boolean') return { available: false, why: 'runner-unavailable' }
  if (Number.isInteger(result.status) && ((result.status === 0) !== result.ok)) return { available: false, why: 'runner-unavailable' }
  return { available: true, ok: result.ok, output: String(result.output || '') }
}

function runDiffCommand(d, command, checkout) {
  try {
    return normalizeDiffCommandResult(d.runCommand(command, checkout, {
      timeout: DIFF_RUN_TIMEOUT_MS,
      env: colourNeutralEnv(process.env),
    }))
  } catch { return { available: false, why: 'runner-unavailable' } }
}

function diffFatal(why, beforeDigest = null, afterDigest = null) {
  return { reason: 'tree-not-restored', why, before_digest: beforeDigest, after_digest: afterDigest }
}

function countDiffReport(records, generated, omitted, config, totalCandidates, fatal = null, initialSkips = []) {
  const killed = records.filter((row) => row.outcome === 'killed').length
  const survived = records.filter((row) => row.outcome === 'survived').length
  const skipped = initialSkips.length + records.filter((row) => row.outcome === 'skipped').length
  const skipCounts = {}
  for (const row of [...initialSkips, ...records.filter((entry) => entry.outcome === 'skipped')]) {
    const reason = row.skip_reason || 'unknown'
    skipCounts[reason] = (skipCounts[reason] || 0) + 1
  }
  return {
    generation: config.generation,
    cap: config.cap,
    configured_cap: config.cap,
    cap_omitted: omitted,
    total_candidates: totalCandidates,
    generated,
    killed,
    survived,
    skipped,
    omitted,
    omitted_reason: DIFF_MUTATION_OMITTED_REASON,
    blind_spot: omitted > 0 ? DIFF_MUTATION_OMITTED_REASON : null,
    skip_counts: skipCounts,
    mutants: records,
    ...(fatal ? { fatal } : {}),
  }
}

export function validateDiffConfig(config) {
  const errors = []
  if (!config || typeof config !== 'object' || Array.isArray(config)) return ['config must be an object']
  const keys = Object.keys(config)
  if (keys.length !== DIFF_CONFIG_KEYS.length || DIFF_CONFIG_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(config, key))) errors.push(`config keys must be exactly ${DIFF_CONFIG_KEYS.join(', ')}`)
  if (config.version !== DIFF_CONFIG_VERSION) errors.push('config.version must be 1')
  if (typeof config.checkout !== 'string' || !config.checkout.startsWith('/')) errors.push('config.checkout must be an absolute path')
  if (typeof config.patch !== 'string') errors.push('config.patch must be a string')
  if (!Array.isArray(config.files_in_scope) || config.files_in_scope.length === 0 || config.files_in_scope.some((entry) => typeof entry !== 'string' || entry.length === 0)) errors.push('config.files_in_scope must be a non-empty-string array')
  if (typeof config.validation_lane !== 'string') errors.push('config.validation_lane must be a string')
  if (typeof config.gate_cmd !== 'string') errors.push('config.gate_cmd must be a string')
  if (!Number.isInteger(config.cap) || config.cap < DIFF_MUTATION_CAP_MIN || config.cap > DIFF_MUTATION_CAP_MAX) errors.push('config.cap must be an integer between 1 and 64')
  if (!Number.isInteger(config.generation) || config.generation < 1) errors.push('config.generation must be a positive integer')
  return errors
}

export function runDiffMutationProof(config, deps = {}) {
  const d = normalDeps(deps)
  const validation = validateDiffConfig(config)
  if (validation.length > 0) {
    const invalid = { ...config, generation: Number.isInteger(config?.generation) ? config.generation : null, cap: Number.isInteger(config?.cap) ? config.cap : null }
    return countDiffReport([], 0, 0, invalid, 0, { reason: 'config-invalid', why: validation.join('; '), before_digest: null, after_digest: null }, [diffSkip({ reason: 'malformed-diff' })])
  }
  const parsed = parseUnifiedZeroPatch(config.patch)
  const generated = generateDiffCandidates(parsed)
  const records = []
  const admissionSkips = [...generated.skips]
  let canonicalCheckout
  try { canonicalCheckout = d.realpath(config.checkout) }
  catch { canonicalCheckout = null }
  // This is the ONE lexical fence used in both admission and write paths. C1
  // intentionally mutates this statement; the regular outside-fence fixture then
  // reaches the write path while the canonical filesystem guard still blocks aliases.
  const inScope = scopeMatcher(config.files_in_scope)
  const unseenCandidates = []
  for (const candidate of generated.candidates) {
    if (!inScope(candidate.path)) { admissionSkips.push(diffSkip({ candidate, reason: 'out-of-scope' })); continue }
    if (!canonicalCheckout) { admissionSkips.push(diffSkip({ candidate, reason: 'unsafe-target:checkout-unreadable' })); continue }
    const guard = diffTargetGuard(config, candidate, d, canonicalCheckout)
    if (!guard.ok) { admissionSkips.push(diffSkip({ candidate, reason: guard.reason })); continue }
    unseenCandidates.push(candidate)
  }
  const mutantCap = config.cap
  const selected = unseenCandidates.slice(0, mutantCap)
  const omitted = Math.max(0, unseenCandidates.length - selected.length)
  let fatal = null
  let generatedCount = selected.length
  for (const candidate of selected) {
    if (fatal) break
    const initial = `${candidate.path}:${candidate.line}`
    let before
    try { before = diffInventory(config.checkout, d) }
    catch (err) {
      fatal = diffFatal(`inventory-unreadable before ${initial}: ${err?.message ?? String(err)}`)
      break
    }
    const guardBefore = diffTargetGuard(config, candidate, d, canonicalCheckout)
    if (!guardBefore.ok) { records.push(diffSkip({ candidate, reason: guardBefore.reason })); continue }
    let original
    try { original = bytesOf(d.readBytes(guardBefore.abs)) }
    catch { records.push(diffSkip({ candidate, reason: 'unsafe-target:metadata-unreadable' })); continue }
    if (!original) { records.push(diffSkip({ candidate, reason: 'unsafe-target:metadata-unreadable' })); continue }
    const applied = applyDiffCandidate(original, candidate)
    if (applied.reason) { records.push(diffSkip({ candidate, reason: applied.reason })); continue }
    let writeAttempted = false
    let validationResult = null
    let gateResult = null
    let restoreFailure = null
    let runtimeSkip = null
    try {
      if (!inScope(candidate.path)) { runtimeSkip = 'out-of-scope' }
      const guardWrite = runtimeSkip ? { ok: false, reason: runtimeSkip } : diffTargetGuard(config, candidate, d, canonicalCheckout)
      if (!runtimeSkip && !guardWrite.ok) runtimeSkip = guardWrite.reason
      if (!runtimeSkip) {
        let current
        try { current = bytesOf(d.readBytes(guardWrite.abs)) } catch { runtimeSkip = 'unsafe-target:metadata-unreadable' }
        if (!runtimeSkip && !sameBytes(current, original)) runtimeSkip = 'target-changed'
        if (!runtimeSkip) {
          const reapplied = applyDiffCandidate(current, candidate)
          if (reapplied.reason) runtimeSkip = reapplied.reason
          else {
            writeAttempted = true
            d.writeFile(guardWrite.abs, reapplied.bytes)
            validationResult = runDiffCommand(d, config.validation_lane, config.checkout)
            gateResult = runDiffCommand(d, config.gate_cmd, config.checkout)
            if (!validationResult.available || !gateResult.available) runtimeSkip = 'runner-unavailable'
          }
        }
      }
    } catch (err) {
      runtimeSkip = runtimeSkip || 'write-failed'
      if (!writeAttempted) writeAttempted = true
    } finally {
      if (writeAttempted) {
        try {
          if (!inScope(candidate.path)) throw new Error('target left the accepted lexical scope')
          const restoreGuard = diffTargetGuard(config, candidate, d, canonicalCheckout)
          if (!restoreGuard.ok) throw new Error(restoreGuard.reason)
          d.writeFile(restoreGuard.abs, original)
        } catch (err) { restoreFailure = err?.message ?? String(err) }
      }
    }
    let after = null
    try { after = diffInventory(config.checkout, d) }
    catch (err) { after = { paths: null, digest: null, error: err?.message ?? String(err) } }
    if (restoreFailure || !after || !samePathSet(before.paths, after.paths) || before.digest !== after.digest) {
      const why = restoreFailure
        ? `target restore failed for ${initial}: ${restoreFailure}`
        : after?.error
          ? `inventory-unreadable after ${initial}: ${after.error}`
          : !samePathSet(before.paths, after.paths)
            ? `checkout path inventory changed while proving ${initial}`
            : `checkout digest changed while proving ${initial}`
      fatal = diffFatal(why, before.digest, after?.digest ?? null)
      break
    }
    if (runtimeSkip) { records.push(diffSkip({ candidate, reason: runtimeSkip })); continue }
    const outcome = validationResult.ok && gateResult.ok ? 'survived' : 'killed'
    records.push({
      ...candidate, outcome,
      validation_lane: config.validation_lane,
      gate_cmd: config.gate_cmd,
      validation_ok: validationResult.ok,
      gate_ok: gateResult.ok,
      validation_output: validationResult.output,
      gate_output: gateResult.output,
      why: outcome === 'survived' ? 'the validation lane and gate stayed GREEN under the mutation' : 'a completed validation lane or gate run went RED under the mutation',
    })
  }
  return countDiffReport(records, generatedCount, omitted, config, generated.candidates.length, fatal, admissionSkips)
}
export const proveDiffMutations = runDiffMutationProof

function rowLine(row) {
  if (row.outcome === 'killed') return `${row.check} killed (${row.summary?.failed ?? '?'}f/${row.summary?.errored ?? '?'}e) ${row.file}`
  if (row.outcome === 'survived') return `${row.check} SURVIVED ${row.file}: ${row.why}`
  if (row.outcome === 'bind-fail') return `${row.check} ${row.why}`
  if (row.outcome === 'exempt') return `${row.check} exempt: ${row.why}`
  return `${row.check} ${row.outcome.toUpperCase()} ${row.file ?? ''}: ${row.why}`
}

export function formatReport(result, invalid = []) {
  const lines = []
  const counts = result?.counts || {}
  for (const row of result?.rows || []) lines.push(rowLine(row))
  for (const entry of invalid) lines.push(`UNREADABLE ${JSON.stringify(entry.check ?? null)}: ${entry.why}`)
  if (result?.refusal) lines.push(`REFUSED ${result.refusal.reason}: ${result.refusal.why}`)
  for (const dir of result?.kept || []) lines.push(`KEPT ${dir}: the scratch worktree could not be removed, so nothing here is a clean measurement`)
  lines.push(`declared ${counts.declared} · unreadable ${invalid.length} · bound ${counts.bound} · killed ${counts.killed} · survived ${counts.survived} · bind-fail ${counts.bindFail} · unapplied ${counts.unapplied} · errored ${counts.errored} · exempt ${counts.exempt}`)
  return lines
}

export function parseArgs(argv) {
  const flags = { envelope: null, diffConfig: null, checkout: process.cwd(), gate: null, json: false, help: false }
  const seen = { envelope: false, diffConfig: false, checkout: false, gate: false, json: false }
  const rest = [...argv]
  while (rest.length > 0) {
    const arg = rest.shift()
    if (arg === '--help' || arg === '-h') { flags.help = true; continue }
    if (arg === '--json') { flags.json = true; seen.json = true; continue }
    const value = () => {
      const next = rest.shift()
      if (next === undefined) throw new ProveUsageError(`prove: ${arg} needs a value`, 'missing-value')
      return next
    }
    if (arg === '--envelope') { flags.envelope = value(); seen.envelope = true; continue }
    if (arg === '--diff-config') { flags.diffConfig = value(); seen.diffConfig = true; continue }
    if (arg === '--checkout') { flags.checkout = value(); seen.checkout = true; continue }
    if (arg === '--gate') { flags.gate = value(); seen.gate = true; continue }
    throw new ProveUsageError(`prove: unknown argument ${JSON.stringify(arg)}`, 'unknown-flag')
  }
  if (seen.diffConfig && (seen.envelope || seen.checkout || seen.gate || seen.json)) {
    throw new ProveUsageError('prove: --diff-config is mutually exclusive with --envelope, --checkout, --gate, and --json', 'mutually-exclusive')
  }
  if (!flags.help && flags.envelope === null && flags.diffConfig === null) throw new ProveUsageError('prove: --envelope is required', 'missing-envelope')
  return flags
}

export async function main(argv, deps = {}) {
  const d = normalDeps(deps)
  let flags
  try {
    flags = parseArgs(argv)
  } catch (err) {
    if (err instanceof ProveUsageError) { d.stderr(`${err.message} [reason: ${err.reason}]\n${USAGE}\n`); return 2 }
    throw err
  }
  if (flags.help) { d.stdout(`${USAGE}\n`); return 0 }
  if (flags.diffConfig !== null) {
    let report
    let raw = null
    try { raw = d.readFile(flags.diffConfig) } catch (err) {
      report = countDiffReport([], 0, 0, { generation: null, cap: null }, 0,
        { reason: 'config-unreadable', why: `the diff config could not be read: ${err?.message ?? String(err)}`, before_digest: null, after_digest: null },
        [diffSkip({ reason: 'malformed-diff' })])
    }
    if (!report && raw === null) {
      report = countDiffReport([], 0, 0, { generation: null, cap: null }, 0,
        { reason: 'config-absent', why: `no diff config at ${flags.diffConfig}`, before_digest: null, after_digest: null },
        [diffSkip({ reason: 'malformed-diff' })])
    }
    if (!report) {
      let config
      try { config = JSON.parse(raw) } catch (err) {
        report = countDiffReport([], 0, 0, { generation: null, cap: null }, 0,
          { reason: 'config-invalid', why: `the diff config is not JSON: ${err?.message ?? String(err)}`, before_digest: null, after_digest: null },
          [diffSkip({ reason: 'malformed-diff' })])
      }
      if (!report) {
        try { report = runDiffMutationProof(config, d) }
        catch (err) {
          report = countDiffReport([], 0, 0, config, 0, null, [diffSkip({ reason: 'runner-unavailable' })])
          report.runner_unavailable = err?.message ?? String(err)
        }
      }
    }
    d.stdout(`${DIFF_MUTATION_SUMMARY_PREFIX} ${JSON.stringify(report)}\n`)
    return report.fatal?.reason === 'config-invalid' || report.fatal?.reason === 'config-absent' || report.fatal?.reason === 'config-unreadable' ? 2 : report.fatal ? 1 : 0
  }
  const raw = d.readFile(flags.envelope)
  if (raw === null) { d.stderr(`prove: no envelope at ${flags.envelope} [reason: envelope-absent]\n`); return 2 }
  let envelope = null
  try {
    envelope = JSON.parse(raw)
  } catch (err) {
    d.stderr(`prove: ${flags.envelope} is not JSON [reason: envelope-unreadable]: ${err.message}\n`)
    return 2
  }
  const { declarations, refusals } = readDeclarations(envelope)
  for (const refusal of refusals) d.stderr(`prove: unreadable declaration ${JSON.stringify(refusal.check)}: ${refusal.why}\n`)
  const gateCmd = flags.gate || envelope?.details?.gate_cmd || null
  if (!gateCmd) { d.stderr('prove: no gate command — pass --gate or declare details.gate_cmd [reason: gate-absent]\n'); return 2 }
  const result = proveMutations({ checkout: flags.checkout, declarations, invalid: refusals, gateCmd, deps: d })
  if (flags.json) d.stdout(`${JSON.stringify({ ...result, refusals })}\n`)
  else for (const line of formatReport(result, refusals)) d.stdout(`${line}\n`)
  if (result.refusal) return 2
  return result.counts.killed + result.counts.exempt === result.counts.declared && result.kept.length === 0 ? 0 : 1
}

function realpathOr(path) {
  try { return realpathSync(path) } catch { return path }
}

const invokedDirectly = process.argv[1] && realpathOr(process.argv[1]) === realpathOr(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2))
}
