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
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { applyMutationAnchor, baselineGateDefect, checkFailureLine, parseGateSummary, validateMutations } from '../../crew/drive.mjs'

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
export const USAGE = 'usage: node scripts/factory/prove-mutations.mjs --envelope <lane>/returns/d1.planner.json [--checkout <dir>] [--gate <command>] [--json]'

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
  return { type: 'file', bytes: readFileSync(abs) }
}

function runGateDefault(gateCmd, cwd) {
  const res = spawnSync('/bin/sh', ['-c', gateCmd], { cwd, encoding: 'utf8', maxBuffer: RUN_MAX_BUFFER_BYTES, env: colourNeutralEnv(process.env) })
  if (res.error) throw new Error(`prove: the gate could not be spawned in ${cwd}: ${res.error.message}`)
  const output = `${res.stdout || ''}${res.stderr || ''}`
  return { ok: res.status === 0, output }
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
    makeWorktree: deps.makeWorktree || makeWorktreeDefault,
    removeWorktree: deps.removeWorktree || removeWorktreeDefault,
    readFile: deps.readFile || readFileOrNull,
    readEntry: deps.readEntry || readEntryDefault,
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
  const flags = { envelope: null, checkout: process.cwd(), gate: null, json: false, help: false }
  const rest = [...argv]
  while (rest.length > 0) {
    const arg = rest.shift()
    if (arg === '--help' || arg === '-h') { flags.help = true; continue }
    if (arg === '--json') { flags.json = true; continue }
    const value = () => {
      const next = rest.shift()
      if (next === undefined) throw new ProveUsageError(`prove: ${arg} needs a value`, 'missing-value')
      return next
    }
    if (arg === '--envelope') { flags.envelope = value(); continue }
    if (arg === '--checkout') { flags.checkout = value(); continue }
    if (arg === '--gate') { flags.gate = value(); continue }
    throw new ProveUsageError(`prove: unknown argument ${JSON.stringify(arg)}`, 'unknown-flag')
  }
  if (!flags.help && !flags.envelope) throw new ProveUsageError('prove: --envelope is required', 'missing-envelope')
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
