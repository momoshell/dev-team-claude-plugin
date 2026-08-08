#!/usr/bin/env node
// The Option C gate kernel for issue #28 (B1). One CLI call collapses
// spec-lint, validation, scope compliance, claim-checking and verdict
// consistency into a single tool call, emitting one JSON GateReport on
// stdout and human lines on stderr.
//
// This file itself stays PURE: every check (checkArtifacts, checkFilesNonEmpty,
// checkJsonParses, checkDiffMatchesClaims, checkScopeCompliance, checkSpecLint,
// checkTestsPass, checkVerdictConsistent) is a function over already-collected
// inputs. runChecks(ctx, io) is the one seam where impurity is INJECTED — via
// io.touchedPaths, io.runValidationCommand, io.lintSpec, io.readArtifact,
// io.extractVerdictBlock — defaulting to the real evidence.mjs / spec-lint.mjs
// / return-lint.mjs wiring. Directory listing and baseline read/write (plain
// fs, no spawn, no git) live in the CLI glue (baselineCmd/checkCmd) below,
// same posture dispatch.mjs's own commands take.
//
// This tool NEVER validates a return, NEVER writes an envelope, NEVER touches
// a dispatch-record outcome field, and NEVER rolls anything back — it
// reports; the caller decides. It checks AFTER a dispatch is already
// confirmed `completed` by the parent's own completion authority
// (return-lint.mjs / ladder.mjs) — that predicate is never reimplemented
// here, and this file never imports either of those two modules' schemas.
//
// usage:
//   node gates.mjs baseline --task <slug> --slice <slice_id> [--reason <text>] [--checkout <dir>] [--repo <slug>] [--root <dir>]
//   node gates.mjs check    --task <slug> --slice <slice_id> [--checks a,b,c] [--checkout <dir>] [--repo <slug>] [--root <dir>]
//
// Exit codes: 0 = no violations · 1 = violations present (read hard_fail from
// the JSON) · 2 = usage/operational error.
//
// Import direction: chain -> cmux only. Zero dependencies: node builtins plus
// this repo's own modules only.
import { readdirSync, statSync, readFileSync, mkdirSync, realpathSync } from 'node:fs'
import { join, dirname, basename, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveRoots, taskPaths, specPathFor } from '../cmux/resolve.mjs'
import { slugify, SLICE_ID_RE } from '../cmux/contract.mjs'
import { lintSpec } from '../spec-lint.mjs'
import { extractVerdictBlock, VERDICT_SECTION_MISSING } from '../cmux/return-lint.mjs'
import {
  captureBaseline, readBaseline, writeBaselineExclusive, touchedPaths, runValidationCommand,
  GATE_RUN_TIMEOUT_MS, EvidenceError, isDirectoryShapedPath,
} from './evidence.mjs'

// ---------------------------------------------------------------------------
// Frozen closed allow-lists (conventions.md 2026-08-01: "prefer structural
// impossibility to a test assertion, and a whitelist to a blacklist").
// ---------------------------------------------------------------------------

export const CHECK_NAMES = Object.freeze([
  'artifacts_exist', 'files_non_empty', 'json_parses', 'diff_matches_claims',
  'scope_compliance', 'spec_lint', 'tests_pass', 'verdict_consistent',
])

// PROTECTED_PREFIXES answers "did a coder touch the memory single-writer
// surface" (ADR-016's first mechanical backstop). Deliberately NOT unified
// with contract.mjs's PROTECTED_PATH_COMPONENTS — that answers a DIFFERENT
// question (where a dispatcher may SITE an agent-writable directory) at a
// DIFFERENT time (path derivation, resolve.mjs's assertSafePath). scripts/**
// and hooks/** are this repo's own product and are deliberately NOT
// protected here. Exactly two entries, exact-prefix, glob-free: a two-entry
// exact-prefix list can be verified correct by reading it; a glob engine
// cannot. scope_compliance and diff_matches_claims are the two checks that
// can hard_fail:true — scope_compliance on an actual protected-path touch
// (this exact-prefix logic), and BOTH of them additionally hard_fail on an
// evidence-loss event (io.touchedPaths throwing, e.g. git_unavailable),
// since losing the ability to compute the touched set at all is itself a
// security-boundary-adjacent failure that must never be silently reported
// clean. spec_lint and tests_pass NEVER hard_fail, even when their own io
// call (io.lintSpec / io.runValidationCommand) throws — both stay
// correctable, matching checkSpecLint's own documented policy below.
export const PROTECTED_PREFIXES = Object.freeze(['.claude/dev-team/memory/', '.claude/dev-team/config.md'])

// isProtectedPath(p) checks the protected relation in BOTH directions:
//   1. p is at/under a protected prefix (the original, already-correct
//      direction — a regular file or a directory-shaped touch whose own
//      path is inside the protected surface).
//   2. p is a directory-shaped STRICT ANCESTOR of a protected prefix (e.g.
//      p === '.claude/' when a protected prefix is '.claude/dev-team/
//      memory/') — this direction exists because git's `--ignored=matching`
//      collapses a wholly-ignored directory to a single trailing-slash path
//      at WHATEVER level is wholly ignored, including a level strictly
//      above a protected prefix. A collapsed ancestor's true contents are
//      unknown/unverifiable (its children could be anything, including a
//      protected file) — per this file's own "a check that cannot see the
//      tree must never report clean" philosophy (evidence.mjs header), an
//      opaque ancestor must be treated as a protected hit, never routed to
//      the ordinary/ignored-advisory channel. A non-directory-shaped p (no
//      trailing slash) can never be an ancestor of anything and skips this
//      direction entirely — only isDirectoryShapedPath(p) reaches it.
function isProtectedPath(p) {
  const pIsDir = isDirectoryShapedPath(p)
  for (const prefix of PROTECTED_PREFIXES) {
    if (prefix.endsWith('/')) {
      if (p.startsWith(prefix)) return true
    } else if (p === prefix) {
      return true
    }
    if (pIsDir && p !== prefix && prefix.startsWith(p)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// CLI argument parsing. No --key=value form (that gotcha desynced
// dispatch.mjs's shared parser once already), no unknown-flag tolerance,
// --checks never silently drops an unrecognized name.
// ---------------------------------------------------------------------------

export class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
  }
}

export const USAGE_MESSAGE = [
  'usage: node gates.mjs baseline --task <slug> --slice <slice_id> [--reason <text>] [--checkout <dir>] [--repo <slug>] [--root <dir>]',
  '       node gates.mjs check    --task <slug> --slice <slice_id> [--checks a,b,c] [--checkout <dir>] [--repo <slug>] [--root <dir>]',
].join('\n')

const SUBCOMMANDS = Object.freeze(['baseline', 'check'])
const COMMON_FLAGS = ['--checkout', '--repo', '--root']
const SUBCOMMAND_FLAGS = Object.freeze({
  baseline: Object.freeze([...COMMON_FLAGS, '--task', '--slice', '--reason']),
  check: Object.freeze([...COMMON_FLAGS, '--task', '--slice', '--checks']),
})
const REQUIRED_FLAGS = Object.freeze({
  baseline: Object.freeze(['--task', '--slice']),
  check: Object.freeze(['--task', '--slice']),
})

// parseArgs(argv) -> { subcommand, options }. argv excludes 'node' and the
// script path. Throws UsageError, naming the exact offending token, on: an
// unknown subcommand, a --flag=value token, an unrecognized flag for the
// subcommand, a missing required flag, or an unknown --checks name.
export function parseArgs(argv) {
  const [subcommand, ...rest] = argv
  if (!SUBCOMMANDS.includes(subcommand)) {
    throw new UsageError(`gates: unknown subcommand: ${JSON.stringify(subcommand)} (expected one of ${SUBCOMMANDS.join('|')})`)
  }
  const allowed = new Set(SUBCOMMAND_FLAGS[subcommand])
  const options = {}
  let i = 0
  while (i < rest.length) {
    const token = rest[i]
    if (!token.startsWith('--')) {
      throw new UsageError(`gates: unexpected positional argument: ${JSON.stringify(token)}`)
    }
    if (token.includes('=')) {
      throw new UsageError(`gates: "--flag=value" form is not supported, use "${token.split('=')[0]} <value>": ${JSON.stringify(token)}`)
    }
    if (!allowed.has(token)) {
      throw new UsageError(`gates: unknown flag for "${subcommand}": ${JSON.stringify(token)}`)
    }
    const value = rest[i + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`gates: flag ${token} requires a value`)
    }
    options[token.slice(2)] = value
    i += 2
  }
  for (const flag of REQUIRED_FLAGS[subcommand]) {
    if (!(flag.slice(2) in options)) {
      throw new UsageError(`gates: missing required flag: ${flag}`)
    }
  }
  if (subcommand === 'check' && options.checks !== undefined) {
    const names = options.checks.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    if (names.length === 0) {
      throw new UsageError('gates: --checks requires at least one check name')
    }
    for (const name of names) {
      if (!CHECK_NAMES.includes(name)) {
        throw new UsageError(`gates: --checks names an unknown check: ${JSON.stringify(name)} (expected one of ${CHECK_NAMES.join(',')})`)
      }
    }
  }
  return { subcommand, options }
}

// ---------------------------------------------------------------------------
// Path derivation — every path goes through resolve.mjs; nothing here
// computes a stateDir/taskDir path itself.
// ---------------------------------------------------------------------------

// baselinePathFor(paths, sliceId) -> <stateDir>/chain/baseline.<slice_id>.json.
// Lives UNDER stateDir, so teardown's existing wholesale stateDir sweep
// collects it with no teardown change.
export function baselinePathFor(paths, sliceId) {
  return join(paths.stateDir, 'chain', `baseline.${sliceId}.json`)
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// listReturnCandidates(returnsDir, sliceId) -> absolute paths of every
// returns/<sliceId>.<attempt>.{json,md} present. Absent returnsDir yields [],
// never a throw — a fresh task with no returns yet is legal input to `check`
// (artifacts_exist then correctly reports zero return files).
function listReturnCandidates(returnsDir, sliceId) {
  let names
  try {
    names = readdirSync(returnsDir)
  } catch {
    return []
  }
  const re = new RegExp(`^${escapeRegExp(sliceId)}\\.(\\d+)\\.(json|md)$`)
  return names.filter((n) => re.test(n)).sort().map((n) => join(returnsDir, n))
}

// buildCliContext(options) -> { root, repoSlug, taskSlug, task, slice, paths }.
// Mirrors dispatch.mjs's buildContext (dispatch.mjs:21-22's common options),
// minus the roster machinery this CLI never needs.
function buildCliContext(options) {
  const root = options.checkout ? resolvePath(options.checkout) : process.cwd()
  const repoSlug = options.repo || basename(root)
  const taskSlug = slugify(options.task)
  if (typeof options.slice !== 'string' || !SLICE_ID_RE.test(options.slice)) {
    throw new UsageError(`gates: --slice fails the frozen slice-id shape: ${JSON.stringify(options.slice)}`)
  }
  const taskArtifactsRoot = options.root ? resolvePath(options.root) : undefined
  const roots = resolveRoots({ taskArtifactsRoot })
  const paths = taskPaths({ roots, repoSlug, taskSlug })
  return { root, repoSlug, taskSlug, task: taskSlug, slice: options.slice, paths }
}

// ---------------------------------------------------------------------------
// Default (real) io wiring. Every function here does real IO; nothing in
// runChecks below calls fs/spawnSync/git directly — everything routes
// through this object (or an injected replacement).
// ---------------------------------------------------------------------------

function realReadArtifact(path) {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return { path, exists: false, sizeBytes: null, text: null }
    const text = readFileSync(path, 'utf8')
    return { path, exists: true, sizeBytes: stat.size, text }
  } catch {
    return { path, exists: false, sizeBytes: null, text: null }
  }
}

const DEFAULT_IO = Object.freeze({
  touchedPaths,
  runValidationCommand,
  lintSpec,
  readArtifact: realReadArtifact,
  extractVerdictBlock,
})

// ---------------------------------------------------------------------------
// Pure check functions. Every one takes already-collected inputs and returns
// a Check ({ item, ok, hard_fail, note }) or Check[] — never touches disk,
// spawns a process, or calls git.
// ---------------------------------------------------------------------------

function formatBytes(n) {
  const size = n ?? 0
  if (size < 1024) return `${size}B`
  return `${(size / 1024).toFixed(1)}KB`
}

// artifacts_exist: EVERY resolved artifact (the spec plus every discovered
// return file) must exist, and at least one return file must be present —
// zero return files makes this ok:false even when the spec itself exists.
export function checkArtifacts(items) {
  const item = 'artifacts_exist'
  const returnItems = items.filter((i) => i.kind !== 'spec')
  const ok = items.length > 0 && items.every((i) => i.exists) && returnItems.length > 0
  const notes = items.map((i) => `${basename(i.path)}: ${i.exists ? `exists, ${formatBytes(i.sizeBytes)}` : 'missing'}`)
  const note = returnItems.length === 0
    ? `no return files found for this slice; ${notes.join('; ')}`
    : notes.join('; ')
  return { item, ok, hard_fail: false, note }
}

// files_non_empty: every resolved artifact must exist AND be non-empty.
export function checkFilesNonEmpty(items) {
  const item = 'files_non_empty'
  const ok = items.length > 0 && items.every((i) => i.exists && (i.sizeBytes ?? 0) > 0)
  const note = items.map((i) => `${basename(i.path)}: ${i.exists ? `${i.sizeBytes ?? 0} byte(s)` : 'missing'}`).join('; ')
  return { item, ok, hard_fail: false, note }
}

// json_parses: .json artifacts only. `.md` returns are EXPLICITLY excluded
// (they are the rendered markdown mirror, not JSON) and the note says so —
// never a silent skip.
export function checkJsonParses(items) {
  const item = 'json_parses'
  const relevant = items.filter((i) => !i.excluded)
  const ok = relevant.length > 0 && relevant.every((i) => i.jsonOk === true)
  const excludedNames = items.filter((i) => i.excluded).map((i) => basename(i.path))
  const parts = relevant.map((i) => `${basename(i.path)}: ${i.jsonOk ? 'parses' : 'does not parse'}`)
  if (excludedNames.length > 0) {
    parts.push(`excluded from this check (not JSON, they are the rendered markdown mirror): ${excludedNames.join(', ')}`)
  }
  return { item, ok, hard_fail: false, note: parts.join('; ') }
}

function normalizeClaimPath(entry) {
  let token = entry.trim().split(/\s+/)[0] || ''
  token = token.replace(/\\/g, '/')
  if (token.startsWith('./')) token = token.slice(2)
  return token
}

// collectClaims(returnArtifacts) -> string[] | null. Aggregates the leading
// token of every body.changes[] entry across every JSON return artifact that
// carries a structured changes array. null means NO return artifact carried
// one (e.g. every discovered return is markdown-kind) — the caller reports
// this explicitly, never as a silent empty pass.
export function collectClaims(returnArtifacts) {
  let sawStructured = false
  const claims = []
  for (const a of returnArtifacts) {
    if (a.kind !== 'return-json' || !a.exists || typeof a.text !== 'string') continue
    let parsed
    try {
      parsed = JSON.parse(a.text)
    } catch {
      continue
    }
    const body = parsed && parsed.body
    if (body && typeof body === 'object' && !Array.isArray(body) && Array.isArray(body.changes)) {
      sawStructured = true
      for (const entry of body.changes) {
        if (typeof entry === 'string') claims.push(normalizeClaimPath(entry))
      }
    }
  }
  return sawStructured ? claims : null
}

// diff_matches_claims: every claimed path must appear in the touched set.
// Unmatched -> ok:false, hard_fail:false, naming EVERY unmatched path.
export function checkDiffMatchesClaims(claims, touchedPathList) {
  const item = 'diff_matches_claims'
  if (claims === null) {
    return { item, ok: true, hard_fail: false, note: 'no structured changes were claimed (every discovered return is markdown-kind, or none carried a body.changes array)' }
  }
  const touchedSet = new Set(touchedPathList)
  const unmatched = claims.filter((p) => !touchedSet.has(p))
  if (unmatched.length > 0) {
    return { item, ok: false, hard_fail: false, note: `claimed but not present in the touched set: ${unmatched.join(', ')}` }
  }
  return {
    item,
    ok: true,
    hard_fail: false,
    note: `${claims.length} claimed path(s) all appear in the touched set: ${claims.join(', ') || '(none claimed)'}`,
  }
}

// scope_compliance: the PROTECTED half (hard_fail — a security control, the
// one mechanical backstop for the memory single-writer rule) and the
// ORDINARY half (a correctable warning, never hard_fail). `filesInScope`
// membership NEVER exempts a protected path — the protected check runs
// independently of it. `touchedPathList` must be the UNFILTERED touched set
// (conventions.md 2026-08-01: "filters apply to what an agent reads, never
// to what a check verifies") — no noise-glob filtering is ever applied here.
// `ignoredPathList` (optional, from touchedPaths's sources.ignored — QA
// round-2 fix #2) is a SEPARATE advisory channel only: a non-protected touch
// that is also ignored (git's `!!` status marker, e.g. this repo's own
// `*.lock`/`._*` classes) is excluded from the ordinary out-of-scope warning
// and named in a distinct "advisory" note instead, so a legitimate
// ignored-file class stops spamming this check on every run. It NEVER
// exempts a protected path — the protected check is checked first, always,
// regardless of ignored status.
export function checkScopeCompliance(touchedPathList, filesInScope, ignoredPathList = []) {
  const item = 'scope_compliance'
  const scopeSet = new Set(filesInScope)
  const ignoredSet = new Set(ignoredPathList)
  const protectedHits = []
  const outOfScopeHits = []
  const ignoredAdvisory = []
  for (const p of touchedPathList) {
    if (isProtectedPath(p)) {
      protectedHits.push(p)
      continue
    }
    if (scopeSet.has(p)) continue
    if (ignoredSet.has(p)) {
      ignoredAdvisory.push(p)
    } else {
      outOfScopeHits.push(p)
    }
  }
  const advisoryPart = ignoredAdvisory.length > 0
    ? `advisory: ignored, non-protected touch(es) excluded from the out-of-scope warning channel: ${ignoredAdvisory.join(', ')}`
    : null
  if (protectedHits.length === 0 && outOfScopeHits.length === 0) {
    // A directory-shaped ignored-advisory entry is a collapsed git status
    // path (see isDirectoryShapedPath) whose individual contents were NEVER
    // inspected — "all within scope" would misleadingly imply otherwise, so
    // that case gets an explicit caveat appended to the same note.
    const hasDirAdvisory = ignoredAdvisory.some((p) => isDirectoryShapedPath(p))
    const dirCaveat = hasDirAdvisory
      ? ' (a directory-shaped ignored entry above is a collapsed git status path — its individual contents were not inspected)'
      : ''
    const parts = [`${touchedPathList.length} touched path(s), all within scope: ${touchedPathList.join(', ') || '(none touched)'}${dirCaveat}`]
    if (advisoryPart) parts.push(advisoryPart)
    return { item, ok: true, hard_fail: false, note: parts.join('; ') }
  }
  const parts = []
  if (protectedHits.length > 0) parts.push(`protected-path touch(es): ${protectedHits.join(', ')}`)
  if (outOfScopeHits.length > 0) parts.push(`out-of-scope touch(es): ${outOfScopeHits.join(', ')}`)
  if (advisoryPart) parts.push(advisoryPart)
  return { item, ok: false, hard_fail: protectedHits.length > 0, note: parts.join('; ') }
}

// spec_lint: delegates to lintSpec(spec, root) — NEVER main(), which writes
// to stdout and would corrupt this CLI's single-JSON-line stdout contract.
// A spec-lint failure is correctable, never hard_fail — including when
// io.lintSpec itself throws (runChecks converts that throw into an ok:false,
// hard_fail:false spec_lint Check, never hard_fail:true; only
// scope_compliance/diff_matches_claims hard-fail on evidence-loss).
export function checkSpecLint(lintResult) {
  const item = 'spec_lint'
  const ok = lintResult.ok === true
  const failures = lintResult.failures || []
  const warnings = lintResult.warnings || []
  const detail = failures.map((f) => `${f.check}: ${f.detail}`).join('; ')
  const note = `${failures.length} failure(s), ${warnings.length} warning(s)${detail ? ` — ${detail}` : ''}`
  return { item, ok, hard_fail: false, note }
}

// tests_pass is a check FACTORY: one NAMED check per validation command,
// item id `tests_pass(<cmd>)`, never merged. Every command already ran
// independently (the caller invoked io.runValidationCommand once per
// command with no short-circuiting) — this only renders the already-run
// RunResult. `classified` is read directly off the injected RunResult and
// never re-derived here (timeout/missing_binary/refused stay distinct
// outcomes named in the note).
export function checkTestsPass(entries) {
  return entries.map(({ cmd, result }) => {
    const item = `tests_pass(${cmd})`
    const ok = result.classified === 'exit' && result.code === 0
    if (ok) {
      return { item, ok, hard_fail: false, note: `"${cmd}" passed (exit 0, ${result.elapsed_ms}ms)` }
    }
    const tail = (result.tail || '').trim()
    const evidence = tail.length > 0 ? tail.slice(0, 500) : '(no output captured)'
    return {
      item,
      ok: false,
      hard_fail: false,
      note: `"${cmd}" ${result.classified} (code=${result.code === null ? 'null' : result.code}, ${result.elapsed_ms}ms)${result.note ? ` — ${result.note}` : ''} — tail: ${evidence}`,
    }
  })
}

// verdict_consistent is CONSISTENCY-REFUTATION ONLY — never a quality
// judgment, never a rewrite, never a panel aggregation. One INDEPENDENT
// check per reviewer envelope, item id `verdict_consistent(<stem>)`.
//   Variant A: verdict 'pass' with any critical finding -> hard_fail:true.
//   Variant B: verdict 'changes-needed' with zero findings -> ok:true (the
//     blocking reasoning may live in Must-fix prose the verdict block
//     cannot see) — this is NOT `ok = verdict !== 'pass'` and NOT
//     `ok = !findings.some(critical)`, both of which a naive reading of
//     qa-gate.md's "critical findings block" rule would produce.
//
// VERDICT_SECTION_MISSING is skipped entirely — it means "this return has no
// Verdict section at all", which is the NORMAL, legitimate shape for most
// non-reviewer roles (leads, plan-reviewer, qa-lead, ... — anything with
// verdict_block unset/false in the roster). Treating that as a violation
// would fabricate one on every valid non-reviewer return. The other four
// failure keywords (VERDICT_BLOCK_MISSING/MULTIPLE/UNPARSEABLE/INVALID) all
// mean "this WAS clearly meant to be a verdict return but it's malformed",
// and stay ok:false.
export function checkVerdictConsistent(entries) {
  const verdictBearing = entries.filter(
    ({ verdictResult }) => !(verdictResult.ok === false && verdictResult.keyword === VERDICT_SECTION_MISSING),
  )
  return verdictBearing.map(({ stem, verdictResult }) => {
    const item = `verdict_consistent(${stem})`
    if (!verdictResult.ok) {
      return { item, ok: false, hard_fail: false, note: `verdict block unreadable (${verdictResult.keyword}): ${verdictResult.message}` }
    }
    const { verdict, findings } = verdictResult
    const findingList = Array.isArray(findings) ? findings : []
    const criticals = findingList.filter((f) => f && f.severity === 'critical')
    if (verdict === 'pass' && criticals.length > 0) {
      const named = criticals.map((f) => `${f.file}:${f.line === null || f.line === undefined ? '?' : f.line} ${f.summary}`).join('; ')
      return { item, ok: false, hard_fail: true, note: `verdict is "pass" but ${criticals.length} critical finding(s) are present: ${named}` }
    }
    if (verdict === 'changes-needed' && findingList.length === 0) {
      return { item, ok: true, hard_fail: false, note: 'changes-needed with 0 findings - blocking reasoning may be in Must-fix prose' }
    }
    return { item, ok: true, hard_fail: false, note: `verdict "${verdict}" is self-consistent (${findingList.length} finding(s))` }
  })
}

// ---------------------------------------------------------------------------
// buildReport: pure aggregation. hard_fail and violations are DERIVED, never
// independently computed.
// ---------------------------------------------------------------------------

export function buildReport({ task, slice, checks }) {
  const hard_fail = checks.some((c) => c.hard_fail === true)
  const violations = checks
    .filter((c) => c.ok === false)
    .map((c) => ({ item: c.item, hard_fail: c.hard_fail, note: c.note }))
  return { task, slice, checks, hard_fail, violations }
}

// ---------------------------------------------------------------------------
// runChecks(ctx, io) — the ONE seam where impurity is injected. ctx carries
// only already-collected data (paths, the baseline object or null, the list
// of candidate return file paths, an optional enabled-checks set) — nothing
// in this function calls fs/spawnSync/git directly; every side effect goes
// through io.
// ---------------------------------------------------------------------------

function enabled(ctx, name) {
  return !ctx.enabledChecks || ctx.enabledChecks.has(name)
}

export function runChecks(ctx, io = DEFAULT_IO) {
  const checks = []

  const specArtifact = { path: ctx.specPath, kind: 'spec', ...io.readArtifact(ctx.specPath) }
  let specObj = null
  let specParseError = null
  if (specArtifact.exists) {
    try {
      specObj = JSON.parse(specArtifact.text)
    } catch (err) {
      specParseError = err.message
    }
  }

  const returnArtifacts = ctx.returnCandidatePaths.map((p) => {
    const kind = p.endsWith('.md') ? 'return-md' : 'return-json'
    return { kind, ...io.readArtifact(p) }
  })

  const allItems = [specArtifact, ...returnArtifacts]

  if (enabled(ctx, 'artifacts_exist')) checks.push(checkArtifacts(allItems))
  if (enabled(ctx, 'files_non_empty')) checks.push(checkFilesNonEmpty(allItems))

  if (enabled(ctx, 'json_parses')) {
    const jsonItems = allItems.map((it) => {
      if (it.kind === 'return-md') return { ...it, excluded: true, jsonOk: null }
      if (!it.exists) return { ...it, excluded: false, jsonOk: false }
      try {
        JSON.parse(it.text)
        return { ...it, excluded: false, jsonOk: true }
      } catch {
        return { ...it, excluded: false, jsonOk: false }
      }
    })
    checks.push(checkJsonParses(jsonItems))
  }

  const needsTouched = enabled(ctx, 'diff_matches_claims') || enabled(ctx, 'scope_compliance')
  if (needsTouched) {
    if (!ctx.baseline) {
      // FAIL-CLOSED: `check` never lazily captures a baseline. Both
      // baseline-dependent checks hard-fail, naming the expected path and
      // the remediation, rather than silently reporting an empty touched
      // set (which would read as a clean pass on an out-of-scope or
      // protected-path edit).
      const note = `no baseline found at ${ctx.baselinePath} — run "gates.mjs baseline --task ${ctx.task} --slice ${ctx.slice}" before "gates.mjs check" (a baseline is never captured lazily at check time)`
      if (enabled(ctx, 'diff_matches_claims')) checks.push({ item: 'diff_matches_claims', ok: false, hard_fail: true, note })
      if (enabled(ctx, 'scope_compliance')) checks.push({ item: 'scope_compliance', ok: false, hard_fail: true, note })
    } else {
      // A thrown EvidenceError (git_unavailable, status_unparseable — both
      // plausible against a worktree a coder is still actively mutating) or
      // any other fs throw must never propagate out of runChecks and
      // discard every already-computed check above — it becomes a reported
      // hard_fail Check instead, preserving "it reports; the caller
      // decides" even on an evidence-layer failure.
      let touched = null
      try {
        touched = io.touchedPaths({ cwd: ctx.root, baseline: ctx.baseline })
      } catch (err) {
        const note = `io.touchedPaths threw (${(err && err.code) || (err && err.name) || 'Error'}): ${err && err.message}`
        if (enabled(ctx, 'diff_matches_claims')) checks.push({ item: 'diff_matches_claims', ok: false, hard_fail: true, note })
        if (enabled(ctx, 'scope_compliance')) checks.push({ item: 'scope_compliance', ok: false, hard_fail: true, note })
      }
      if (touched) {
        if (enabled(ctx, 'diff_matches_claims')) {
          const claims = collectClaims(returnArtifacts)
          checks.push(checkDiffMatchesClaims(claims, touched.paths))
        }
        if (enabled(ctx, 'scope_compliance')) {
          const filesInScope = Array.isArray(specObj && specObj.files_in_scope) ? specObj.files_in_scope : []
          checks.push(checkScopeCompliance(touched.paths, filesInScope, touched.sources.ignored))
        }
      }
    }
  }

  if (enabled(ctx, 'spec_lint')) {
    if (!specObj) {
      checks.push({
        item: 'spec_lint',
        ok: false,
        hard_fail: false,
        note: `spec at ${ctx.specPath} is missing or not valid JSON${specParseError ? `: ${specParseError}` : ''}`,
      })
    } else {
      try {
        const lintResult = io.lintSpec(specObj, ctx.root)
        checks.push(checkSpecLint(lintResult))
      } catch (err) {
        // hard_fail:false — spec_lint is documented as correctable, never
        // hard_fail, and that holds even when io.lintSpec itself throws (QA
        // round-2 fix #3): unlike io.touchedPaths, losing spec-lint is not
        // an evidence-loss event on a security-boundary-adjacent check.
        checks.push({
          item: 'spec_lint',
          ok: false,
          hard_fail: false,
          note: `io.lintSpec threw (${(err && err.code) || (err && err.name) || 'Error'}): ${err && err.message}`,
        })
      }
    }
  }

  if (enabled(ctx, 'tests_pass')) {
    const validationCommands = Array.isArray(specObj && specObj.validation_commands) ? specObj.validation_commands : []
    if (validationCommands.length === 0) {
      checks.push({
        item: 'tests_pass',
        ok: false,
        hard_fail: false,
        note: 'spec has no validation_commands to run (or the spec itself is missing/unparseable)',
      })
    } else {
      const entries = []
      for (const [idx, cmd] of validationCommands.entries()) {
        try {
          entries.push({
            cmd,
            result: io.runValidationCommand({
              cmd,
              cwd: ctx.root,
              timeoutMs: ctx.timeoutMs,
              logPath: join(ctx.logDir, `tests-pass-${idx}.log`),
            }),
          })
        } catch (err) {
          // hard_fail:false — tests_pass never hard_fails, even when
          // io.runValidationCommand itself throws (QA round-2 fix #3): a
          // throw here is distinct from its normal contract of returning an
          // ok:false RunResult, but it is still not an evidence-loss event
          // on a security-boundary-adjacent check the way an io.touchedPaths
          // throw is.
          checks.push({
            item: `tests_pass(${cmd})`,
            ok: false,
            hard_fail: false,
            note: `io.runValidationCommand threw (${(err && err.code) || (err && err.name) || 'Error'}): ${err && err.message}`,
          })
        }
      }
      for (const check of checkTestsPass(entries)) checks.push(check)
    }
  }

  if (enabled(ctx, 'verdict_consistent')) {
    const reviewerEntries = []
    for (const a of returnArtifacts) {
      if (a.kind !== 'return-json' || !a.exists || typeof a.text !== 'string') continue
      let parsed
      try {
        parsed = JSON.parse(a.text)
      } catch {
        continue
      }
      if (typeof parsed?.body !== 'string') continue
      const stem = basename(a.path).replace(/\.json$/, '')
      reviewerEntries.push({ stem, verdictResult: io.extractVerdictBlock(parsed.body) })
    }
    const verdictChecks = checkVerdictConsistent(reviewerEntries)
    if (verdictChecks.length === 0) {
      // Mirrors checkDiffMatchesClaims's own precedent for "this evidence
      // class does not apply to the returns present" (a markdown-kind
      // return with no structured `changes` claimed) being a PASS with an
      // explanatory note, never a fabricated violation (QA round-2 fix #4)
      // — a coder-slice or lead-slice run (all-markdown, no reviewer
      // envelope) must be able to reach exit 0 under default --checks.
      // Still never collapses to checks:[] though — that would read as
      // "nothing wrong" for the WRONG reason (nothing evaluated at all).
      // Mirrors tests_pass's explicit zero-validation-commands Check and
      // checkArtifacts's explicit zero-return-files fail: an
      // evaluated-nothing state is itself always reported, just as ok:true
      // ("not applicable here"), never ok:false ("a violation").
      checks.push({
        item: 'verdict_consistent',
        ok: true,
        hard_fail: false,
        note: `no verdict-bearing envelope found among the returns scanned in ${ctx.returnsDir || '(returns directory unknown)'}`,
      })
    } else {
      for (const check of verdictChecks) checks.push(check)
    }
  }

  return checks
}

// ---------------------------------------------------------------------------
// CLI glue (impure): baseline / check subcommands, main(argv).
// ---------------------------------------------------------------------------

function log(msg) {
  process.stderr.write(`${msg}\n`)
}

function baselineCmd(options) {
  const ctx = buildCliContext(options)
  const baselinePath = baselinePathFor(ctx.paths, ctx.slice)
  mkdirSync(dirname(baselinePath), { recursive: true })
  const baseline = captureBaseline({ cwd: ctx.root, reason: options.reason || '' })
  // writeBaselineExclusive throws EvidenceError('baseline_exists') rather
  // than overwrite an existing baseline for this slice — an overwrite at
  // gate time is exactly what a bypass looks like.
  writeBaselineExclusive(baselinePath, baseline)
  log(`gates: baseline captured for ${ctx.task}/${ctx.slice} at ${baselinePath} (anchor ${baseline.anchor_sha})`)
  process.stdout.write(`${JSON.stringify({ ok: true, task: ctx.task, slice: ctx.slice, baseline_path: baselinePath, anchor_sha: baseline.anchor_sha })}\n`)
  return 0
}

function checkCmd(options) {
  const ctx = buildCliContext(options)
  const baselinePath = baselinePathFor(ctx.paths, ctx.slice)
  const baseline = readBaseline(baselinePath) // null iff absent; throws EvidenceError on a corrupt one (fail closed)

  const specPath = specPathFor(ctx.paths, ctx.slice)
  const returnCandidatePaths = listReturnCandidates(ctx.paths.returnsDir, ctx.slice)
  const logDir = join(ctx.paths.stateDir, 'chain', 'logs')
  mkdirSync(logDir, { recursive: true })

  const enabledChecks = options.checks
    ? new Set(options.checks.split(',').map((s) => s.trim()).filter((s) => s.length > 0))
    : null

  const runCtx = {
    task: ctx.task,
    slice: ctx.slice,
    root: ctx.root,
    specPath,
    returnCandidatePaths,
    returnsDir: ctx.paths.returnsDir,
    baseline,
    baselinePath,
    timeoutMs: GATE_RUN_TIMEOUT_MS,
    logDir,
    enabledChecks,
  }

  const checks = runChecks(runCtx, DEFAULT_IO)
  const report = buildReport({ task: ctx.task, slice: ctx.slice, checks })

  // GateReport is emitted as exactly ONE line of JSON on stdout and nothing
  // else — every human line goes to stderr (mirrors dispatch.mjs:24-26 and
  // spec-lint.mjs --json).
  process.stdout.write(`${JSON.stringify(report)}\n`)
  log(`gates: check complete for ${ctx.task}/${ctx.slice} — ${report.violations.length} violation(s), hard_fail=${report.hard_fail}`)
  return report.violations.length === 0 ? 0 : 1
}

// main(argv) -> exit code. argv excludes 'node' and the script path. ALWAYS
// returns its exit code — never calls process.exit itself.
export function main(argv) {
  try {
    const { subcommand, options } = parseArgs(argv)
    return subcommand === 'baseline' ? baselineCmd(options) : checkCmd(options)
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n${USAGE_MESSAGE}\n`)
      return 2
    }
    if (err instanceof EvidenceError) {
      process.stderr.write(`gates: ${err.code}: ${err.message}\n`)
      return 2
    }
    process.stderr.write(`${err.stack}\n`)
    return 2
  }
}

// realpathOr(path) -> string — realpath both sides of the direct-invocation
// check: the ESM loader realpaths import.meta.url while argv[1] stays
// literal, so under a symlinked path component (macOS TMPDIR is /var ->
// /private/var) a literal compare is silently false and the CLI no-ops.
function realpathOr(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolvePath(path)
  }
}

const invokedDirectly = process.argv[1] && realpathOr(process.argv[1]) === realpathOr(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  // process.exitCode, not process.exit: stdout is a pipe when a consumer
  // spawns this CLI (its whole purpose), and pipe writes are asynchronous —
  // process.exit() tears the process down before Node flushes the buffer,
  // silently truncating a large --json payload.
  process.exitCode = main(process.argv.slice(2))
}
