// Dispatch-record builder: the artifact every worker's permissions, prompt
// and identity derive from. Owns the three-state atomic lifecycle (create ->
// bind -> terminate), the per-dispatch worker-plugin snapshot, the claude argv
// builder, and three structural invariants the evidence layer (be-1b-D)
// depends on and cannot establish for itself: (slice_id, attempt) uniqueness
// per dispatch, exclusive create over an unoccupied return_path, and
// millisecond-precision timestamps. Zero dependencies beyond node builtins.
import { randomUUID, createHash } from 'node:crypto'
import {
  readFileSync, writeFileSync, renameSync, linkSync, unlinkSync, mkdirSync, existsSync, readdirSync,
} from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  validate, DISALLOWED_TOOLS, CMUX_ALLOWS, NONCE_PREFIX, OUTCOMES, SLICE_ID_RE, TOOLS, PROTECTED_PATH_COMPONENTS,
} from './contract.mjs'
import {
  stemOf, specPathFor, returnPathFor, signalsPathFor, recordPathFor, sidecarPaths, deriveWorktree, composeProfile,
} from './resolve.mjs'

const SCHEMA_DIR = dirname(fileURLToPath(import.meta.url))
let cachedDispatchRecordSchema = null
function loadDispatchRecordSchema() {
  if (!cachedDispatchRecordSchema) {
    cachedDispatchRecordSchema = JSON.parse(readFileSync(join(SCHEMA_DIR, 'dispatch-record.schema.json'), 'utf8'))
  }
  return cachedDispatchRecordSchema
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// Thrown by writeRecord when record.return_path is already occupied. NEVER
// deletes/truncates/overwrites that file — a leftover return is evidence,
// not garbage; the caller (be-1b-E) resolves it by bumping the attempt.
export class StaleReturnError extends Error {
  constructor(path) {
    super(`writeRecord: refused — return_path is already occupied (bump the attempt to remedy): ${path}`)
    this.name = 'StaleReturnError'
    this.path = path
  }
}

// Thrown by readRecord (and therefore by bindRecord/terminateRecord/
// listRecords, which all route through it) when the parsed object fails
// dispatch-record.schema.json. trust M4: a record is re-read off a
// worker-writable tree (G13); this closes the "unvalidated JSON.parse
// re-read" hole by refusing rather than trusting the bytes verbatim.
export class RecordInvalidError extends Error {
  constructor(path, violations) {
    super(`readRecord: record at ${path} fails dispatch-record.schema.json: ${violations.map((v) => `${v.path} (${v.keyword})`).join(', ')}`)
    this.name = 'RecordInvalidError'
    this.path = path
    this.violations = violations
  }
}

// Thrown by withRecordLock (and therefore by bindRecord/terminateRecord)
// when another writer holds a fresh (non-stale) lock on the same record.
export class RecordLockError extends Error {
  constructor(path) {
    super(`withRecordLock: refused — record at ${path} is locked by another writer`)
    this.name = 'RecordLockError'
    this.path = path
  }
}

// ---------------------------------------------------------------------------
// Small internal helpers
// ---------------------------------------------------------------------------

function assertLowerHexId(id, label) {
  if (typeof id !== 'string' || id === '' || /[A-Z]/.test(id)) {
    throw new Error(`record: ${label} must be a lowercase id, got: ${JSON.stringify(id)}`)
  }
  return id
}

function assertSliceId(sliceId) {
  if (typeof sliceId !== 'string' || !SLICE_ID_RE.test(sliceId)) {
    throw new Error(`record: slice_id fails SLICE_ID_RE: ${JSON.stringify(sliceId)}`)
  }
  return sliceId
}

// Atomic tmp+rename write, always in the SAME directory as the destination
// (never a different filesystem, never a different directory's mtime
// semantics). Creates the destination directory if missing.
function writeAtomicBytes(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, path)
}

function writeAtomicJson(path, obj) {
  writeAtomicBytes(path, `${JSON.stringify(obj, null, 2)}\n`)
}

// trust M5-B: every derived snapshot path is joined from a roster role/profile
// KEY, which roster.schema.json cannot constrain (no `propertyNames` in the
// keyword budget). loadRoster (resolve.mjs) now rejects such keys upstream —
// this is defense-in-depth for a caller that builds `roles`/`profiles`
// without going through loadRoster.
//
// path.join() NORMALIZES `..` away at call time — join('<pluginRoot>',
// 'agents', '../../../../tmp/evil.md') resolves straight to '/tmp/evil.md',
// with NO literal '..' segment surviving in the result. A post-join scan for
// a '..' segment (the shape of resolve.mjs's private assertSafePath, built
// for already-slugified path components) is therefore a no-op against this
// exact attack. The real gate is CONTAINMENT: resolve both the candidate and
// its intended parent directory and require the candidate to still live
// under it. Throws before any read or write reaches the filesystem; also
// refuses a protected path component surviving in the resolved result
// (defense-in-depth against a legitimate-looking but sensitive target).
function assertWithinDir(baseDir, candidatePath, label) {
  const base = resolvePath(baseDir)
  const candidate = resolvePath(candidatePath)
  if (candidate !== base && !candidate.startsWith(`${base}/`)) {
    throw new Error(`snapshotWorkerPlugin: ${label} escapes its containing directory ${base}: ${candidatePath}`)
  }
  const segments = candidate.split('/')
  for (const component of PROTECTED_PATH_COMPONENTS) {
    if (segments.includes(component)) {
      throw new Error(`snapshotWorkerPlugin: ${label} contains a protected component (${component}): ${candidatePath}`)
    }
  }
  return candidatePath
}

// ---------------------------------------------------------------------------
// L-16 millisecond timestamps — the ONE helper every timestamp this module
// writes goes through. new Date(t).toISOString() always emits three
// fractional digits; the regex assertion is kept anyway as a regression
// guard (it only ever fires if a future edit routes a pre-formatted string
// through here). be-1b-D compares Math.floor(mtimeMs) > Date.parse(created_at)
// STRICTLY — a second-granularity created_at would open a ~1s window in
// which a stale return reads as fresh, which is exactly what this guards.
export function isoMs(t) {
  if (typeof t !== 'number' && !(t instanceof Date)) {
    throw new Error(`isoMs: expected an epoch-ms number or a Date, got ${typeof t}: ${JSON.stringify(t)}`)
  }
  const iso = new Date(t).toISOString()
  if (!/\.\d{3}Z$/.test(iso)) {
    throw new Error(`isoMs: produced a timestamp without a millisecond group: ${iso}`)
  }
  return iso
}

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------

export function newDispatchId() {
  return randomUUID()
}

export function attnTokenFor(dispatchId) {
  assertLowerHexId(dispatchId, 'dispatch_id')
  return `devteam-${dispatchId}-attn`
}

// ---------------------------------------------------------------------------
// assertNoNonce — scans SERIALIZED RECORD BYTES ONLY. Never schema bytes,
// never a schema+record blob: dispatch-record.schema.json's own description
// embeds the literal nonce-prefix text (documenting the very prohibition
// this function enforces), so a scan spanning schema bytes self-trips. The
// nonce has no representable field on this record; its absence is asserted
// by substring scan, never carried.
export function assertNoNonce(record) {
  const bytes = JSON.stringify(record)
  if (bytes.includes(NONCE_PREFIX)) {
    throw new Error('assertNoNonce: record bytes contain the completion-nonce prefix')
  }
}

// ---------------------------------------------------------------------------
// Static profile addenda (ADR-009 Am.1 byte-stability: frozen, static text —
// identical inputs must produce byte-identical prompt files). Re-review N1:
// the record is parent-side, so this addendum is the worker's ONLY
// instruction channel for the ReturnEnvelope contract and the agreement
// tuple (pinned U-3).
// ---------------------------------------------------------------------------

function returnEnvelopeAddendum(postconditionText) {
  return `## Returning your result

Write your ReturnEnvelope as JSON to the exact return_path you were given. The
envelope has exactly these keys: schema_version, dispatch_id, slice_id,
attempt, role, produced_at, body.

The parent rejects your return if its dispatch_id, slice_id, attempt, or role
does not match the ones you were dispatched with — all four must agree.
dispatch_id arrives in your kickoff line; slice_id and attempt are derivable
from the return_path filename stem (<slice_id>.<attempt>.json).

Write exactly one file, at return_path — never a sibling's, and never a
different attempt's.

## Signalling progress

You have exactly two cmux verbs available: \`cmux notify\` (post a short
status message) and \`cmux wait-for -S\` (block until a named signal is set).
Use only these two; no other cmux subcommand is available to you.

## Postcondition

${postconditionText}
`
}

export const PROFILE_ADDENDA = {
  executor: returnEnvelopeAddendum('Your worktree is expected to carry changes when you finish (postcondition: changes_expected) — the parent does not require a clean git status.'),
  validator: returnEnvelopeAddendum('Your worktree must be clean when you finish (postcondition: clean) — you validate, you do not edit.'),
  judgment: returnEnvelopeAddendum('Your worktree must be clean when you finish (postcondition: clean) — you read and reason, you do not edit.'),
}

function stripFrontmatter(src) {
  const m = src.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return m ? src.slice(m[0].length) : src
}

// returnContractAddendum(pluginRoot, returnSpec) -> string. Static,
// record-independent addendum sourced from be-1c-01's
// scripts/cmux/prompts/return-contract.{json,markdown}.md, selected by
// returnSpec.kind. For markdown roles, one static line enumerating the
// role's required_sections (and, when verdict_block is true, the
// verdict-block requirement) is appended — this is ROSTER data (fixed per
// role, not per-dispatch), so it stays a pure function of pluginRoot/role
// and preserves byte-stability (A10).
function returnContractAddendum(pluginRoot, returnSpec) {
  const filename = returnSpec.kind === 'json'
    ? join('scripts', 'cmux', 'prompts', 'return-contract.json.md')
    : join('scripts', 'cmux', 'prompts', 'return-contract.markdown.md')
  const text = readFileSync(join(pluginRoot, filename), 'utf8').trimEnd()
  if (returnSpec.kind !== 'markdown') {
    return text
  }
  const sections = (returnSpec.required_sections || []).join(', ')
  const verdictNote = returnSpec.verdict_block
    ? ' A Verdict section must carry exactly one fenced json block matching {verdict, findings}.'
    : ''
  return `${text}\n\nRequired sections for this role: ${sections}.${verdictNote}`
}

// composeRolePrompt(pluginRoot, role, profileName, returnSpec) -> string. The
// role body (agents/<role>.md, frontmatter stripped), the static profile
// addendum, and the return-contract addendum matching returnSpec.kind
// (`{ kind, required_sections?, verdict_block? }`, i.e. roleDef.return from
// the roster). Pure function of its inputs, so byte-stability across
// dispatches (A10) and idempotent re-snapshotting both fall out for free.
export function composeRolePrompt(pluginRoot, role, profileName, returnSpec) {
  const addendum = PROFILE_ADDENDA[profileName]
  if (!addendum) {
    throw new Error(`composeRolePrompt: unknown profile: ${JSON.stringify(profileName)}`)
  }
  if (!returnSpec || (returnSpec.kind !== 'json' && returnSpec.kind !== 'markdown')) {
    throw new Error(`composeRolePrompt: unknown return kind: ${JSON.stringify(returnSpec && returnSpec.kind)}`)
  }
  const src = readFileSync(join(pluginRoot, 'agents', `${role}.md`), 'utf8')
  const body = stripFrontmatter(src).trimEnd()
  const returnAddendum = returnContractAddendum(pluginRoot, returnSpec)
  return `${body}\n\n${addendum}\n${returnAddendum}\n`
}

// ---------------------------------------------------------------------------
// PRE-1C-VERIFY (D-3, pinned by backend-lead 2026-08-02): named precondition
// the 1c adapter MUST enforce before exec'ing claude against this snapshot
// and this record. Copied verbatim here so the obligation travels with the
// artifact it constrains — 1b's job is to make every one of these checks
// POSSIBLE (closed inventory, sha256 on the record, nonce sidecar, no argv/
// env/log leak); 1c's job is to RUN them.
//   (1) validate the record against dispatch-record.schema.json, refuse on
//       violation.
//   (2) recompute sha256 of role_prompt_path bytes vs record.role_prompt_sha256,
//       refuse on mismatch, never repair.
//   (3) walk dirname(dirname(role_prompt_path)) and refuse on any entry
//       outside the closed inventory (roles/<role>.txt + referenced
//       return-schema filenames + 1c's own hooks/ + .claude-plugin/), any
//       symlink, any non-regular file.
//   (4) read-and-unlink <dirname(env.DEVTEAM_GATE_COUNTER)>/<dispatch_id>.nonce,
//       absent → refuse.
//   (5) never log/argv/env the nonce.
// 1b obligations discharged here: (a) snapshot inventory closed & enumerable
// (exactly roles/<role>.txt per roster role + one file per distinct
// referenced return schema, nothing else); (b) role/profile key charset
// (trust M5, defense-in-depth via assertWithinDir — loadRoster is the
// primary gate); (c) D-1 repointing — record.return.schema_path names the
// PLUGIN-ROOT source file, never a path under this snapshot tree, so a
// worker rewriting its own --plugin-dir snapshot cannot forge the schema a
// future classify() re-reads.
// ---------------------------------------------------------------------------

// WORKER_PLUGIN_MANIFEST: snapshot-relative destination -> plugin-root-
// relative source. The closed, exhaustive allow-list of every hooks/ and
// .claude-plugin/ file the per-dispatch --plugin-dir snapshot ships (conventions.md
// "prefer a whitelist to a blacklist" — a positive allow-list, never a glob,
// the same discipline test/schema.test.mjs's hardcoded list follows). The
// eleventh entry, hooks/dispatch-record.schema.json (added 2026-08-02 on an
// empirically verified gap): return-lint.mjs line 27 reads
// join(MODULE_DIR, 'dispatch-record.schema.json') at module-evaluation time
// to validate the record before trusting any field, so without this entry
// the copied import closure is ENOENT on import.
export const WORKER_PLUGIN_MANIFEST = Object.freeze({
  '.claude-plugin/plugin.json': 'scripts/cmux/worker-plugin/.claude-plugin/plugin.json',
  'hooks/hooks.json': 'scripts/cmux/worker-plugin/hooks/hooks.json',
  'hooks/return-gate.sh': 'scripts/cmux/return-gate.sh',
  'hooks/gate-mode.sh': 'scripts/cmux/gate-mode.sh',
  'hooks/return-lint.mjs': 'scripts/cmux/return-lint.mjs',
  'hooks/ladder.mjs': 'scripts/cmux/ladder.mjs',
  'hooks/resolve.mjs': 'scripts/cmux/resolve.mjs',
  'hooks/contract.mjs': 'scripts/cmux/contract.mjs',
  'hooks/return-envelope.schema.json': 'scripts/cmux/return-envelope.schema.json',
  'hooks/signal-record.schema.json': 'scripts/cmux/signal-record.schema.json',
  'hooks/dispatch-record.schema.json': 'scripts/cmux/dispatch-record.schema.json',
})

// snapshotWorkerPlugin({ pluginRoot, snapshotDir, roles, profiles }) ->
// { roles: { <role>: { path, sha256 } }, schemas: { <filename>: path },
//   plugin: { <destRel>: { path, sha256 } } }
// `roles` is a roster-shaped map (role -> { profile, return, ... }); `profiles`
// is a roster-shaped map (profile name -> profile def), used only to assert
// every referenced profile actually exists. Idempotent: composeRolePrompt and
// the WORKER_PLUGIN_MANIFEST copy loop are both pure functions of on-disk
// source, so re-running yields byte-identical files and identical sha256.
// --plugin-dir points at this snapshot (ADR-009 Am.1), never the
// version-pinned marketplace cache. D-1: `schemas[filename]` is the
// PLUGIN-ROOT source path (not the snapshot copy) — the copy is still
// written into the snapshot for 1c's self-containment, but nothing on the
// record ever points a completion decision back at worker-writable bytes.
export function snapshotWorkerPlugin({ pluginRoot, snapshotDir, roles, profiles }) {
  const result = { roles: {}, schemas: {}, plugin: {} }

  // Roles first, deliberately: trust M5-B relies on every role/profile being
  // validated (and every path containment-checked) before ANY filesystem
  // effect — including the manifest copy — so a hostile role key still
  // throws before touching disk anywhere in this snapshot.
  for (const [role, roleDef] of Object.entries(roles)) {
    const profileName = roleDef.profile
    if (!profiles[profileName]) {
      throw new Error(`snapshotWorkerPlugin: role ${role} references unknown profile ${JSON.stringify(profileName)}`)
    }

    const agentsDir = join(pluginRoot, 'agents')
    const rolesDir = join(snapshotDir, 'roles')
    const agentSrcPath = join(agentsDir, `${role}.md`)
    const promptPath = join(rolesDir, `${role}.txt`)
    assertWithinDir(agentsDir, agentSrcPath, `agents source path for role ${JSON.stringify(role)}`)
    assertWithinDir(rolesDir, promptPath, `role prompt path for role ${JSON.stringify(role)}`)

    const promptText = composeRolePrompt(pluginRoot, role, profileName, roleDef.return)
    writeAtomicBytes(promptPath, promptText)
    result.roles[role] = { path: promptPath, sha256: createHash('sha256').update(promptText).digest('hex') }

    if (roleDef.return && roleDef.return.kind === 'json' && roleDef.return.schema) {
      const filename = roleDef.return.schema
      const srcPath = join(pluginRoot, filename)
      const destPath = join(snapshotDir, filename)
      assertWithinDir(pluginRoot, srcPath, `schema source path for ${JSON.stringify(filename)}`)
      assertWithinDir(snapshotDir, destPath, `schema dest path for ${JSON.stringify(filename)}`)
      if (!result.schemas[filename]) {
        const bytes = readFileSync(srcPath)
        writeAtomicBytes(destPath, bytes)
        result.schemas[filename] = srcPath
      }
    }
  }

  for (const [destRel, srcRel] of Object.entries(WORKER_PLUGIN_MANIFEST)) {
    const srcPath = join(pluginRoot, srcRel)
    const destPath = join(snapshotDir, destRel)
    assertWithinDir(pluginRoot, srcPath, `plugin manifest source path for ${JSON.stringify(destRel)}`)
    assertWithinDir(snapshotDir, destPath, `plugin manifest dest path for ${JSON.stringify(destRel)}`)
    const bytes = readFileSync(srcPath)
    writeAtomicBytes(destPath, bytes)
    result.plugin[destRel] = { path: destPath, sha256: createHash('sha256').update(bytes).digest('hex') }
  }

  return result
}

// ---------------------------------------------------------------------------
// kickoff / env — the worker's only reliable channel for its own dispatch
// identity and paths (the record itself is parent-side and worker-unreadable
// via tool calls).
// ---------------------------------------------------------------------------

function buildKickoff({ dispatchId, taskDir, specPath, returnPath, signalsPath, attnParent, attnUpstream }) {
  const kickoff = `Dispatch ${dispatchId}. task_dir=${taskDir} spec_path=${specPath} return_path=${returnPath} signals_path=${signalsPath} attn_parent=${attnParent} attn_upstream=${attnUpstream}. Read spec_path, do the work, write your ReturnEnvelope to return_path, then run: cmux notify --title ${attnParent} -- done`
  if (/[\n\r]/.test(kickoff)) {
    throw new Error('buildKickoff: composed kickoff must be a single line')
  }
  if (kickoff.length > 4000) {
    throw new Error('buildKickoff: composed kickoff exceeds the 4000-char limit')
  }
  if (kickoff.includes(NONCE_PREFIX)) {
    throw new Error('buildKickoff: composed kickoff must never contain the completion-nonce prefix')
  }
  return kickoff
}

function buildEnv({ role, taskId, dispatchId, taskDir, recordPath, signalLogPath, gatePath }) {
  return {
    DEVTEAM_WORKER: '1',
    DEVTEAM_ROLE: role,
    DEVTEAM_TASK_ID: taskId,
    DEVTEAM_DISPATCH_ID: dispatchId,
    DEVTEAM_TASK_DIR: taskDir,
    DEVTEAM_DISPATCH_RECORD: recordPath,
    DEVTEAM_SIGNAL_LOG: signalLogPath,
    DEVTEAM_GATE_COUNTER: gatePath,
  }
}

// ---------------------------------------------------------------------------
// Structural path invariants (L-15's sibling for buildRecord itself): the
// frozen ABS pattern (^/[^/].*$) admits a `..` segment; this builder is the
// layer that refuses it. "Prefer structural impossibility to a test
// assertion" (conventions.md) — these are refusals, not downstream checks.
// ---------------------------------------------------------------------------

const PATH_FIELDS = ['task_dir', 'spec_path', 'return_path', 'signals_path', 'primary_checkout', 'role_prompt_path', 'cwd']

function assertNoDotDotSegment(p, label) {
  if (typeof p !== 'string' || p.split('/').includes('..')) {
    throw new Error(`buildRecord: path field ${label} contains a traversal segment: ${JSON.stringify(p)}`)
  }
}

function assertStructuralPathInvariants(record) {
  for (const field of PATH_FIELDS) {
    assertNoDotDotSegment(record[field], field)
  }
  if (record.return.schema_path) {
    assertNoDotDotSegment(record.return.schema_path, 'return.schema_path')
  }
  if (record.worktree) {
    assertNoDotDotSegment(record.worktree.path, 'worktree.path')
    if (record.worktree.path === record.primary_checkout) {
      throw new Error('buildRecord: worktree.path must not equal primary_checkout')
    }
  }
  const taskDir = record.task_dir
  const checkout = record.primary_checkout
  if (taskDir === checkout || taskDir.startsWith(`${checkout}/`) || checkout.startsWith(`${taskDir}/`)) {
    throw new Error('buildRecord: task_dir must be outside every checkout')
  }
}

// resolveMaxTurnsOrThrow({ config, resolved, defaults }) -> null (or throws).
// Single source of truth for the three-source max_turns resolution
// (config override -> role override -> roster default) shared by
// dispatchCmd (hoisted before any worktree/snapshot side effect) and
// buildRecord (a correctness backstop for callers that construct a record
// directly, e.g. tests). max_turns stays schema-present as integer|null but
// is inert by refusal — see ADR-017 in architecture-notes.md.
export function resolveMaxTurnsOrThrow({ config = {}, resolved, defaults }) {
  const maxTurns = config.maxTurns !== undefined
    ? config.maxTurns
    : (resolved.max_turns !== undefined ? resolved.max_turns : defaults.max_turns)
  if (maxTurns !== null) {
    throw new Error(
      'max_turns is set to ' + maxTurns + ' but gate-side turn-budget enforcement ' +
      'is not implemented (see ADR-017 in architecture-notes.md) — the CLI turn ' +
      'cap flag emission was removed as unreachable/unenforceable; use timeout_s ' +
      'to bound a runaway worker instead'
    )
  }
  return maxTurns
}

// buildRecord(ctx, { role, sliceId, attempt, spec }) -> record (create state:
// surface/bound_at/ended_at/outcome all null). ctx = { roots, paths, roster,
// resolved, pluginRoot, taskId, taskSlug, repoSlug, primaryCheckout,
// snapshot, config, now, dispatchId, attnUpstream }. `spec` is the Handover
// Spec for this dispatch (its validation_commands feed the composed
// profile's validation_commands grant). `config` carries dispatch-level
// overrides the ladder (be-1b-E) decides: createdByDispatcher, sourceSliceId,
// maxGateBlocks, timeoutS, maxTurns — all optional, defaulting from the
// resolved role / roster.defaults.
export function buildRecord(ctx, { role, sliceId, attempt, spec }) {
  const {
    roots, paths, roster, resolved, pluginRoot, taskId, taskSlug, repoSlug,
    primaryCheckout, snapshot, config = {}, now, dispatchId, attnUpstream,
  } = ctx
  assertLowerHexId(dispatchId, 'dispatch_id')
  assertSliceId(sliceId)
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 99) {
    throw new Error(`buildRecord: attempt must be an integer in [1, 99]: ${JSON.stringify(attempt)}`)
  }

  const stem = stemOf(sliceId, attempt)
  const worktree = deriveWorktree({
    roots,
    repoSlug,
    taskSlug,
    sliceId,
    isolation: resolved.isolation,
    createdByDispatcher: config.createdByDispatcher ?? true,
    sourceSliceId: config.sourceSliceId ?? null,
  })
  const cwd = worktree ? worktree.path : primaryCheckout

  const profileDef = roster.profiles[resolved.profile]
  if (!profileDef) {
    throw new Error(`buildRecord: role ${role} references unknown profile ${JSON.stringify(resolved.profile)}`)
  }
  const composedProfile = composeProfile('claude', {
    name: resolved.profile,
    profile: profileDef,
    ctx: {
      taskDir: paths.taskDir,
      stem,
      worktreePath: worktree ? worktree.path : null,
      validationCommands: (spec && spec.validation_commands) || [],
    },
  })
  for (const literal of CMUX_ALLOWS) {
    if (!composedProfile.allow.includes(literal)) {
      throw new Error(`buildRecord: composed profile.allow is missing the frozen literal: ${literal}`)
    }
  }

  const roleSnapshot = snapshot.roles[role]
  if (!roleSnapshot) {
    throw new Error(`buildRecord: no snapshot entry for role ${JSON.stringify(role)}`)
  }

  const returnSpec = resolved.return
  const schemaPath = returnSpec.kind === 'json' ? snapshot.schemas[returnSpec.schema] : null
  if (returnSpec.kind === 'json' && !schemaPath) {
    throw new Error(`buildRecord: no snapshotted schema for ${JSON.stringify(returnSpec.schema)}`)
  }

  const specPath = specPathFor(paths, sliceId)
  const returnPath = returnPathFor(paths, stem)
  const signalsPath = signalsPathFor(paths, stem)
  const recordPath = recordPathFor(paths, stem)
  const sidecars = sidecarPaths(paths, dispatchId)

  const attnParent = attnTokenFor(dispatchId)
  const attnUpstreamFinal = attnUpstream || attnParent

  const env = buildEnv({
    role, taskId, dispatchId, taskDir: paths.taskDir, recordPath,
    signalLogPath: sidecars.signalLog, gatePath: sidecars.gate,
  })

  const kickoff = buildKickoff({
    dispatchId, taskDir: paths.taskDir, specPath, returnPath, signalsPath,
    attnParent, attnUpstream: attnUpstreamFinal,
  })

  const maxGateBlocks = config.maxGateBlocks ?? roster.defaults.max_gate_blocks
  const timeoutS = config.timeoutS ?? resolved.timeout_s ?? roster.defaults.timeout_s
  const maxTurns = resolveMaxTurnsOrThrow({ config, resolved, defaults: roster.defaults })

  const record = {
    schema_version: 2,
    dispatch_id: dispatchId,
    slice_id: sliceId,
    attempt,
    task_id: taskId,
    task_slug: taskSlug,
    repo_slug: repoSlug,
    role,
    agent: resolved.agent ?? roster.defaults.agent,
    model: resolved.model,
    effort: resolved.effort ?? null,
    tools: TOOLS,
    disallowed_tools: DISALLOWED_TOOLS,
    flags: { strict_mcp_config: true, disable_slash_commands: true },
    profile: composedProfile,
    role_prompt_path: roleSnapshot.path,
    role_prompt_sha256: roleSnapshot.sha256,
    return: {
      kind: returnSpec.kind,
      schema_path: schemaPath,
      required_sections: returnSpec.required_sections || [],
      verdict_block: returnSpec.verdict_block || false,
    },
    task_dir: paths.taskDir,
    spec_path: specPath,
    return_path: returnPath,
    signals_path: signalsPath,
    primary_checkout: primaryCheckout,
    isolation: resolved.isolation,
    worktree,
    cwd,
    env,
    attn_parent: attnParent,
    attn_upstream: attnUpstreamFinal,
    kickoff,
    gate: { max_blocks: maxGateBlocks },
    timeout_s: timeoutS,
    max_turns: maxTurns,
    surface: null,
    created_at: isoMs(now),
    bound_at: null,
    ended_at: null,
    outcome: null,
  }

  assertStructuralPathInvariants(record)
  assertNoNonce(record)

  return record
}

// ---------------------------------------------------------------------------
// buildArgv — carries all nine hard rules. Two composition details the S22f
// smoke does not pin down are named constants so a future smoke can flip
// them with a one-line change:
// ---------------------------------------------------------------------------

// UNVERIFIED — S22f did not test a comma-joined --tools value against a
// space-separated alternative. Flip to 'space' if a future smoke shows
// otherwise.
const TOOLS_JOIN = 'comma'

// UNVERIFIED — S22f only exercised a single --add-dir target (the worktree
// under test). Flip this function's body if a future smoke requires more
// than the task dir.
const ADD_DIRS = (record) => [record.task_dir]

// PRE-1C-VERIFY (D-3): this argv is the last dev-team-owned artifact before
// 1c's adapter spawns claude. The adapter's own precondition list is carried
// in full at snapshotWorkerPlugin's header, above — buildArgv's contribution
// is closing hard rule 2 as a runtime refusal (not just a test assertion):
// step (5) of that list ("never log/argv/env the nonce") is unenforceable by
// this module (it has no nonce field to check), but a newline/CR anywhere in
// argv is exactly the shape a smuggled token or an injected line would take,
// so it is swept and refused below regardless of source.
//
// buildArgv(record) -> string[]. Rule 7 (--append-system-prompt-file
// existence) is an adapter-init probe owned by 1c (be-1b-C is a separate
// slice) — this module never spawns claude, so that rule is not tested here.
export function buildArgv(record) {
  const argv = []
  argv.push('--model', record.model)
  if (record.effort !== null) {
    argv.push('--effort', record.effort)
  }
  argv.push('--permission-mode', record.profile.permission_mode)
  // Hard rule 2: the role prompt is passed as a PATH, never as bytes.
  argv.push('--append-system-prompt-file', record.role_prompt_path)
  argv.push('--tools', TOOLS_JOIN === 'comma' ? record.tools.join(',') : record.tools.join(' '))
  // Hard rule 3: each permission rule is its own argv element.
  argv.push('--allowedTools', ...record.profile.allow)
  argv.push('--disallowedTools', ...record.disallowed_tools)
  if (record.flags.strict_mcp_config) {
    argv.push('--strict-mcp-config')
  }
  if (record.flags.disable_slash_commands) {
    argv.push('--disable-slash-commands')
  }
  // --plugin-dir points at the per-dispatch snapshot, derived from
  // role_prompt_path (<snapshotDir>/roles/<role>.txt), never the
  // version-pinned marketplace cache (ADR-009 Am.1).
  argv.push('--plugin-dir', dirname(dirname(record.role_prompt_path)))
  argv.push('--add-dir', ...ADD_DIRS(record))
  // Hard rule 1: a bare -- immediately before the prompt positional. Its
  // absence fails SILENTLY (SessionStart fires, UserPromptSubmit never
  // does, indefinite idle — conventions.md).
  argv.push('--', record.kickoff)

  // trust S2-B: hard rule 2 enforced as a runtime refusal, not just a test
  // assertion — every element (model, effort, rule strings, kickoff, …) is
  // swept for \n/\r. roster.schema.json's `model` pattern (`\S`, unanchored)
  // does not exclude an embedded newline, so this is a real gap this closes.
  for (const el of argv) {
    if (/[\n\r]/.test(el)) {
      throw new Error(`buildArgv: refused — argv element contains a newline or carriage return: ${JSON.stringify(el)}`)
    }
  }

  return argv
}

// ---------------------------------------------------------------------------
// Record I/O and the three-state lifecycle
// ---------------------------------------------------------------------------

// readRecord(path) -> record. trust M4: a record is worker-writable state
// (G13, same uid) that is re-read on every classify/close/status call — this
// validates the parsed object against dispatch-record.schema.json and
// refuses (RecordInvalidError, carrying the violations) rather than trusting
// arbitrary bytes verbatim. Every other lifecycle function in this module
// (bindRecord, terminateRecord, listRecords) routes through this, so the
// guarantee is universal, not per-callsite.
export function readRecord(path) {
  const record = JSON.parse(readFileSync(path, 'utf8'))
  const violations = validate(loadDispatchRecordSchema(), record)
  if (violations.length > 0) {
    throw new RecordInvalidError(path, violations)
  }
  return record
}

const RECORD_ENTRY_RE = /^[a-z][a-z0-9-]*\.[0-9]{1,2}\.json$/

// listRecords(dispatchDir, { onUnreadable }) -> record[]. Ignores *.tmp,
// *.json.tmp, dotfiles and subdirectories — an interrupted (tmp,
// not-yet-renamed) write is never parsed as a record (L-32). lifecycle M5:
// a per-entry try/catch means one damaged/schema-invalid committed record
// (filesystem corruption, a hand edit, RecordInvalidError) is reported to
// `onUnreadable({ path, error })` and skipped, rather than throwing out of
// every recovery verb (status/await/close/teardown) built on this. Optional
// second argument — omitting it is fully backward compatible.
export function listRecords(dispatchDir, { onUnreadable } = {}) {
  let entries
  try {
    entries = readdirSync(dispatchDir, { withFileTypes: true })
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
  const records = []
  for (const entry of entries) {
    if (!entry.isFile() || !RECORD_ENTRY_RE.test(entry.name)) {
      continue
    }
    const entryPath = join(dispatchDir, entry.name)
    try {
      records.push(readRecord(entryPath))
    } catch (e) {
      if (typeof onUnreadable === 'function') {
        onUnreadable({ path: entryPath, error: e })
      }
    }
  }
  return records
}

// nextAttempt(dispatchDir, sliceId) -> integer. 1 when the slice has no
// record, 1 + max(existing attempt for that slice) otherwise — reading ONLY
// entries named <sliceId>.<n>.json. Throws above the frozen maximum of 99
// (pinned U-1: a retry ALWAYS bumps attempt).
export function nextAttempt(dispatchDir, sliceId) {
  assertSliceId(sliceId)
  let entries
  try {
    entries = readdirSync(dispatchDir)
  } catch (e) {
    if (e.code === 'ENOENT') entries = []
    else throw e
  }
  const re = new RegExp(`^${sliceId}\\.([0-9]{1,2})\\.json$`)
  let max = 0
  for (const entry of entries) {
    const m = entry.match(re)
    if (m) {
      max = Math.max(max, Number(m[1]))
    }
  }
  const next = max + 1
  if (next > 99) {
    throw new Error(`nextAttempt: next attempt for slice ${sliceId} would exceed the frozen maximum of 99`)
  }
  return next
}

// writeRecord(record, path) -> record. State CREATE. GENUINELY exclusive
// (lifecycle M3): writeFileSync(tmp) -> linkSync(tmp, path) -> unlink(tmp).
// linkSync is an atomic filesystem primitive that fails EEXIST if `path`
// already exists — unlike the prior existsSync-then-rename pair (a
// check-then-act TOCTOU: renameSync unconditionally clobbers an existing
// file), two concurrent writers for the same stem now have exactly one
// winner; the loser's tmp file is still unlinked and its record is never
// touched. This also fixes nextAttempt's race for free — the loser gets
// EEXIST and must retry with a bumped attempt, never a silent overwrite.
// Refuses (throws StaleReturnError) when record.return_path already exists
// on disk (L-15) — never deletes/truncates/overwrites it. initGateCounter is
// only ever invoked after both refusals have been cleared, so it
// structurally cannot run on a refused create.
export function writeRecord(record, path) {
  if (existsSync(record.return_path)) {
    throw new StaleReturnError(record.return_path)
  }
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`)
  try {
    linkSync(tmp, path)
  } catch (e) {
    if (e.code === 'EEXIST') {
      throw new Error(`writeRecord: refused — a record already exists at ${path}`)
    }
    throw e
  } finally {
    unlinkSync(tmp)
  }
  initGateCounter({ stateDir: dirname(record.env.DEVTEAM_GATE_COUNTER) }, record.dispatch_id)
  return record
}

// ---------------------------------------------------------------------------
// withRecordLock — lifecycle M4. bindRecord and terminateRecord are both a
// read -> monotonicity-check -> write sequence with nothing serializing
// concurrent writers; this closes that TOCTOU the same way writeRecord's
// exclusive create closes M3, via an exclusive-create sidecar (`<path>.lock`)
// rather than a rename race.
// ---------------------------------------------------------------------------

const LOCK_STALE_MS = 30_000

function readLockOrNull(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch {
    // Corrupt/unreadable lock content is treated as STALE, not a wedge — a
    // lock file is disposable coordination state, never evidence.
    return null
  }
}

function isStaleLock(lockPath) {
  const lock = readLockOrNull(lockPath)
  if (!lock || typeof lock.started_at !== 'number') {
    return true
  }
  return Date.now() - lock.started_at > LOCK_STALE_MS
}

// withRecordLock(path, fn) -> fn()'s return value. Exclusive-creates
// `<path>.lock` ('wx') carrying { pid, started_at }. A lock older than
// LOCK_STALE_MS (or unreadable/corrupt) is stolen as stale rather than
// treated as a wedge; a fresh lock refuses immediately with
// RecordLockError. Released in `finally` ONLY when the on-disk lock still
// carries THIS holder's exact pid + started_at — a superseded holder that
// wakes up late must never delete a successor's lock.
export function withRecordLock(path, fn) {
  const lockPath = `${path}.lock`
  const holder = { pid: process.pid, started_at: Date.now() }
  let acquired = false
  for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
    try {
      writeFileSync(lockPath, JSON.stringify(holder), { flag: 'wx' })
      acquired = true
    } catch (e) {
      if (e.code !== 'EEXIST') {
        throw e
      }
      if (attempt === 0 && isStaleLock(lockPath)) {
        try {
          unlinkSync(lockPath)
        } catch {
          // Lost the race to steal it — fall through to the retry, which
          // refuses cleanly if the new holder already won.
        }
        continue
      }
      throw new RecordLockError(path)
    }
  }
  if (!acquired) {
    throw new RecordLockError(path)
  }
  try {
    return fn()
  } finally {
    const current = readLockOrNull(lockPath)
    if (current && current.pid === holder.pid && current.started_at === holder.started_at) {
      try {
        unlinkSync(lockPath)
      } catch {
        // Already gone — nothing to release.
      }
    }
  }
}

// bindRecord(path, { workspace_id, pane_id, surface_id, now }) -> record.
// State BIND: surface + bound_at set. `now` (epoch-ms | Date) defaults to
// Date.now(). Monotone: throws if the record is already bound. Runs its
// read -> check -> write inside withRecordLock (lifecycle M4); a concurrent
// writer throws RecordLockError rather than racing.
export function bindRecord(path, { workspace_id, pane_id, surface_id, now = Date.now() }) {
  assertLowerHexId(workspace_id, 'workspace_id')
  assertLowerHexId(pane_id, 'pane_id')
  assertLowerHexId(surface_id, 'surface_id')
  return withRecordLock(path, () => {
    const record = readRecord(path)
    if (record.surface !== null || record.bound_at !== null) {
      throw new Error(`bindRecord: record at ${path} is already bound`)
    }
    const updated = {
      ...record,
      surface: { workspace_id, pane_id, surface_id },
      bound_at: isoMs(now),
    }
    writeAtomicJson(path, updated)
    return updated
  })
}

// terminateRecord(path, outcome, now, { allowUnbound }) -> record. State
// TERMINATE: outcome + ended_at set. Refuses an outcome outside the frozen
// OUTCOMES enum (including null, which would be a monotonicity regression:
// outcome would go from set-at-terminate back to null — structurally
// impossible here). Throws if already terminated. lifecycle M2-B: an unbound
// record refuses every outcome EXCEPT 'aborted' when the caller explicitly
// passes { allowUnbound: true } — bind is not a precondition for abandonment
// (a dispatch that dies between record-create and bind must still reach a
// terminal state). Runs inside withRecordLock (lifecycle M4).
export function terminateRecord(path, outcome, now = Date.now(), { allowUnbound = false } = {}) {
  if (!OUTCOMES.includes(outcome)) {
    throw new Error(`terminateRecord: outcome must be one of ${JSON.stringify(OUTCOMES)}, got ${JSON.stringify(outcome)}`)
  }
  return withRecordLock(path, () => {
    const record = readRecord(path)
    const isUnbound = record.surface === null || record.bound_at === null
    if (isUnbound && !(allowUnbound && outcome === 'aborted')) {
      throw new Error(`terminateRecord: record at ${path} has not been bound`)
    }
    if (record.outcome !== null || record.ended_at !== null) {
      throw new Error(`terminateRecord: record at ${path} is already terminated`)
    }
    const updated = { ...record, outcome, ended_at: isoMs(now) }
    writeAtomicJson(path, updated)
    return updated
  })
}

// initGateCounter(paths, dispatchId) -> string (the gate path). Creates
// <state>/<dispatch_id>.gate containing '0' at record-create time; the
// consuming Stop hook is 1c's. writeRecord calls this itself (deriving
// `paths.stateDir` from the record's own DEVTEAM_GATE_COUNTER env value) so
// it structurally cannot run on a refused create.
export function initGateCounter(paths, dispatchId) {
  const gatePath = sidecarPaths(paths, dispatchId).gate
  writeAtomicBytes(gatePath, '0')
  return gatePath
}
