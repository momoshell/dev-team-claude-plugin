// Pure, I/O-light resolution layer the cmux dispatcher builds on: four-layer
// roster precedence + resolveRole, expandGrants (capability tokens ->
// claude permission-rule strings) and every filesystem path derivation for
// the task/state/worktree trees, including worktree derivation. No cmux
// calls, no git, no process spawn, no record writing — this file only reads
// roster JSON off disk and computes strings. Security-load-bearing: this is
// where every path-traversal and permission-rule-shape hazard is closed.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  validate, slugify,
  CMUX_ALLOWS, GRANT_TOKENS, CMD_RE, SLICE_ID_RE, PROTECTED_PATH_COMPONENTS,
} from './contract.mjs'

// task_artifacts_root charset (re-review N8): every rule-feeding path
// descends from this root, and a root containing `)` or a space would pass
// the frozen ABS field pattern (`^/[^/].*$`) yet break composed RULE
// strings, so the root itself is charset-constrained here.
const ROOT_CHARSET_RE = /^\/[A-Za-z0-9._/-]+$/

// roster.schema.json's `roles`/`profiles` maps are open-keyed with no key
// constraint (`propertyNames` isn't in the keyword BUDGET, so the schema
// literally cannot express this — the code is the layer). A key is joined
// straight into filesystem paths downstream (snapshotWorkerPlugin), so a key
// like '../../../../tmp/evil' is a traversal primitive, not just a label.
const ROLE_PROFILE_KEY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

// The permission-rule shape frozen in dispatch-record.schema.json's
// profile.allow items pattern. Not exported from contract.mjs (it is a
// schema-level constraint, not a runtime constant), so it is a local literal
// mirroring that pattern exactly — asserted per emitted rule in
// composeProfile as a second, independent gate on top of expandGrants'
// construction-by-template.
const RULE_RE = /^(Edit|Read)\(\/\/[^)]+\)$|^Bash\([^)]+\)$/

// Interpreter/shell names that would turn a validation-command Bash rule
// into unrestricted command execution under `dontAsk` (trust S3).
const SHELL_FIRST_TOKENS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'env', 'eval', 'exec', 'source'])
const FIRST_TOKEN_RE = /^[a-z][a-z0-9_.-]*$/

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// A derived path must contain neither a `..` segment (the frozen ABS
// pattern `^/[^/].*$` admits it) nor a PROTECTED_PATH_COMPONENTS component
// (matched literal-component-only, so this is a distinct check). Throws;
// never silently sanitizes.
function assertSafePath(p) {
  const segments = p.split('/')
  if (segments.includes('..')) {
    throw new Error(`resolve: path contains a traversal segment: ${p}`)
  }
  for (const component of PROTECTED_PATH_COMPONENTS) {
    if (segments.includes(component)) {
      throw new Error(`resolve: path contains a protected component (${component}): ${p}`)
    }
  }
  return p
}

function assertSliceId(sliceId) {
  if (typeof sliceId !== 'string' || !SLICE_ID_RE.test(sliceId)) {
    throw new Error(`resolve: slice_id fails SLICE_ID_RE: ${JSON.stringify(sliceId)}`)
  }
  return sliceId
}

// resolveRoots({ taskArtifactsRoot }) -> { root, tasksRoot, stateRoot, worktreesRoot }
// root defaults to ~/.dev-team, overridable by taskArtifactsRoot.
export function resolveRoots({ taskArtifactsRoot } = {}) {
  const root = taskArtifactsRoot || join(homedir(), '.dev-team')
  if (!ROOT_CHARSET_RE.test(root)) {
    throw new Error(`resolveRoots: task_artifacts_root fails the frozen charset: ${JSON.stringify(root)}`)
  }
  assertSafePath(root)
  return {
    root,
    tasksRoot: assertSafePath(join(root, 'tasks')),
    stateRoot: assertSafePath(join(root, 'state')),
    worktreesRoot: assertSafePath(join(root, 'worktrees')),
  }
}

// taskPaths({ roots, repoSlug, taskSlug }) -> the frozen task/state layout.
// repoSlug/taskSlug are re-derived through slugify() here (idempotent for an
// already-clean slug) so a degenerate caller input throws rather than
// silently producing a collapsed path segment.
export function taskPaths({ roots, repoSlug, taskSlug }) {
  const repo = slugify(repoSlug)
  const task = slugify(taskSlug)
  const taskDir = assertSafePath(join(roots.tasksRoot, repo, task))
  const stateDir = assertSafePath(join(roots.stateRoot, repo, task))
  return {
    taskDir,
    specDir: join(taskDir, 'spec'),
    returnsDir: join(taskDir, 'returns'),
    signalsDir: join(taskDir, 'signals'),
    renderDir: join(taskDir, 'render'),
    stateDir,
    dispatchDir: join(stateDir, 'dispatch'),
    snapshotDir: join(stateDir, 'worker-plugin'),
    logsDir: join(stateDir, 'logs'),
    preflightPath: join(stateDir, 'preflight.json'),
    statusPath: join(stateDir, 'status.json'),
    cursorPath: join(stateDir, 'events.cursor'),
    lockPath: join(stateDir, 'await.lock'),
    worktreesIndexPath: join(stateDir, 'worktrees.json'),
    rosterSnapshotPath: join(stateDir, 'roster.snapshot.json'),
  }
}

// stemOf(sliceId, attempt) -> `${sliceId}.${attempt}` (spec/ is stem-free).
export function stemOf(sliceId, attempt) {
  assertSliceId(sliceId)
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 99) {
    throw new Error(`stemOf: attempt must be an integer in [1, 99]: ${JSON.stringify(attempt)}`)
  }
  return `${sliceId}.${attempt}`
}

export function specPathFor(paths, sliceId) {
  assertSliceId(sliceId)
  return join(paths.specDir, `${sliceId}.json`)
}

export function returnPathFor(paths, stem) {
  return join(paths.returnsDir, `${stem}.json`)
}

export function signalsPathFor(paths, stem) {
  return join(paths.signalsDir, `${stem}.jsonl`)
}

export function recordPathFor(paths, stem) {
  return join(paths.dispatchDir, `${stem}.json`)
}

// renderPathFor(record) -> the SINGLE derivation site for returns/<stem>.md.
// If the S25f fallback ever relocates this to <TASK_DIR>/render/<stem>.md,
// only this function's body changes (U-12 condition iii).
export function renderPathFor(record) {
  const stem = stemOf(record.slice_id, record.attempt)
  return join(record.task_dir, 'returns', `${stem}.md`)
}

// sidecarPaths(paths, dispatchId) -> the four flat, dispatch_id-keyed
// sidecar files living directly under STATE_DIR.
export function sidecarPaths(paths, dispatchId) {
  if (typeof dispatchId !== 'string' || dispatchId === '') {
    throw new Error('sidecarPaths: dispatchId must be a non-empty string')
  }
  const base = join(paths.stateDir, dispatchId)
  return {
    exit: `${base}.exit`,
    gate: `${base}.gate`,
    nonce: `${base}.nonce`,
    signalLog: `${base}.signal-log`,
  }
}

// deriveWorktree({ roots, repoSlug, taskSlug, sliceId, isolation,
// createdByDispatcher, sourceSliceId }) -> worktree|null. Null iff isolation
// is "primary". Otherwise keyed to slice_id (never task_id, never attempt),
// so every attempt of the same slice reuses the identical path and branch.
export function deriveWorktree({ roots, repoSlug, taskSlug, sliceId, isolation, createdByDispatcher, sourceSliceId }) {
  if (isolation !== 'worktree' && isolation !== 'primary') {
    throw new Error(`deriveWorktree: isolation must be "worktree" or "primary", got ${JSON.stringify(isolation)}`)
  }
  if (isolation === 'primary') {
    return null
  }

  assertSliceId(sliceId)
  if (typeof createdByDispatcher !== 'boolean') {
    throw new Error('deriveWorktree: createdByDispatcher must be a boolean')
  }
  if (createdByDispatcher) {
    if (sourceSliceId !== null && sourceSliceId !== undefined) {
      throw new Error('deriveWorktree: source_slice_id must be null when created_by_dispatcher is true')
    }
  } else if (typeof sourceSliceId !== 'string' || !SLICE_ID_RE.test(sourceSliceId)) {
    throw new Error('deriveWorktree: source_slice_id must name a valid slice when created_by_dispatcher is false')
  }

  const repo = slugify(repoSlug)
  const task = slugify(taskSlug)
  const path = assertSafePath(join(roots.worktreesRoot, repo, task, sliceId))

  return {
    path,
    branch: `dt/${task}/${sliceId}`,
    created_by_dispatcher: createdByDispatcher,
    source_slice_id: createdByDispatcher ? null : sourceSliceId,
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function readJsonOrEmpty(path) {
  if (!existsSync(path)) {
    return {}
  }
  return readJson(path)
}

// Recursive merge: plain-object values merge key by key; array values
// (tools, allow, required_sections, …) replace wholesale, never concatenate
// or merge element-wise.
function deepMergeRoster(base, override) {
  if (!isPlainObject(override)) {
    return base
  }
  const merged = { ...base }
  for (const key of Object.keys(override)) {
    const overrideValue = override[key]
    const baseValue = merged[key]
    if (Array.isArray(overrideValue)) {
      merged[key] = overrideValue
    } else if (isPlainObject(overrideValue) && isPlainObject(baseValue)) {
      merged[key] = deepMergeRoster(baseValue, overrideValue)
    } else {
      merged[key] = overrideValue
    }
  }
  return merged
}

// Every key of a merged roster's `roles`/`profiles` map must be a clean slug
// — it is joined straight into snapshot filesystem paths downstream. Throws
// naming the offending key; never sanitizes.
function assertKeysSafe(obj, label) {
  if (!isPlainObject(obj)) {
    return
  }
  for (const key of Object.keys(obj)) {
    if (!ROLE_PROFILE_KEY_RE.test(key)) {
      throw new Error(`loadRoster: ${label} key fails the frozen charset: ${JSON.stringify(key)}`)
    }
  }
}

// loadRoster({ pluginRoot, home, primaryCheckout, session }) -> { roster, layers }
// Four layers, lowest -> highest precedence:
//   <pluginRoot>/scripts/cmux/roster.default.json
//   <home>/.claude/dev-team/roster.json (optional)
//   <primaryCheckout>/.claude/dev-team/roster.json (optional)
//   session (object or null; reserved — null is a no-op)
// A malformed merged roster (schema violation) throws, naming the
// Violation's path and keyword.
export function loadRoster({ pluginRoot, home, primaryCheckout, session }) {
  const rosterSchema = readJson(join(pluginRoot, 'scripts/cmux/roster.schema.json'))
  const layers = [
    readJsonOrEmpty(join(pluginRoot, 'scripts/cmux/roster.default.json')),
    readJsonOrEmpty(join(home, '.claude/dev-team/roster.json')),
    readJsonOrEmpty(join(primaryCheckout, '.claude/dev-team/roster.json')),
    session || {},
  ]
  const merged = layers.reduce((acc, layer) => deepMergeRoster(acc, layer), {})

  assertKeysSafe(merged.profiles, 'profiles')
  assertKeysSafe(merged.roles, 'roles')

  const violations = validate(rosterSchema, merged)
  if (violations.length > 0) {
    const first = violations[0]
    throw new Error(`loadRoster: merged roster is invalid at ${first.path} (${first.keyword}): ${first.message}`)
  }

  return { roster: merged, layers }
}

// resolveRole(role, { plugin, user, project, session }) -> ResolvedRole
// Last-writer-wins per property across the four layers; `return` deep-merges
// instead of being replaced wholesale. A null/undefined layer is a no-op.
export function resolveRole(role, { plugin, user, project, session } = {}) {
  const layers = [plugin, user, project, session]
  let resolved = {}
  for (const layer of layers) {
    if (!isPlainObject(layer)) {
      continue
    }
    for (const key of Object.keys(layer)) {
      if (key === 'return') {
        resolved.return = { ...(resolved.return || {}), ...layer.return }
      } else {
        resolved[key] = layer[key]
      }
    }
  }
  return resolved
}

// assertValidationCommands(cmds) -> string[] (trimmed). Refuses the WHOLE
// set — throws a named RefusalError naming the first offending command —
// rather than dropping it and proceeding with a narrower, silently
// vacuous-green lane.
export class RefusalError extends Error {
  constructor(command) {
    super(`refused: validation command fails the frozen whitelist or contains a traversal segment: ${JSON.stringify(command)}`)
    this.name = 'RefusalError'
    this.command = command
  }
}

// The CMD_RE charset admits interpreters (`bash -c`) and absolute-path
// scripts (`/tmp/x.sh`) — under `dontAsk` those are equivalent to
// unrestricted Bash. This is a second, narrower gate on the command's first
// whitespace-delimited token: no leading '/' (the charset already excludes
// it) and not a shell/interpreter name.
function assertFirstTokenSafe(cmd) {
  const firstToken = cmd.split(/\s+/)[0] || ''
  if (!FIRST_TOKEN_RE.test(firstToken) || SHELL_FIRST_TOKENS.has(firstToken)) {
    throw new RefusalError(cmd)
  }
}

export function assertValidationCommands(cmds) {
  if (!Array.isArray(cmds)) {
    throw new Error('assertValidationCommands: cmds must be an array')
  }
  const trimmed = cmds.map((c) => (typeof c === 'string' ? c.trim() : c))
  for (const cmd of trimmed) {
    if (typeof cmd !== 'string' || !CMD_RE.test(cmd) || cmd.includes('..')) {
      throw new RefusalError(cmd)
    }
    assertFirstTokenSafe(cmd)
  }
  return trimmed
}

// expandGrants(agent, tokens, ctx) -> string[]. ctx = { taskDir, stem,
// worktreePath, validationCommands }. Every ctx path already begins with a
// single '/', so the rule builder prepends exactly ONE more slash to reach
// the permission-rule `//`-anchor — never string-concatenated in a way that
// could produce '///'. Emits deterministically in GRANT_TOKENS order.
export function expandGrants(agent, tokens, ctx) {
  if (agent !== 'claude') {
    throw new Error(`expandGrants: unknown agent: ${JSON.stringify(agent)}`)
  }
  if (!Array.isArray(tokens)) {
    throw new Error('expandGrants: tokens must be an array')
  }
  for (const token of tokens) {
    if (!GRANT_TOKENS.includes(token)) {
      throw new Error(`expandGrants: unknown grant token: ${JSON.stringify(token)}`)
    }
  }

  const rules = []
  for (const token of GRANT_TOKENS) {
    if (!tokens.includes(token)) {
      continue
    }
    if (token === 'returns_write') {
      rules.push(`Edit(/${ctx.taskDir}/returns/${ctx.stem}.json)`)
    } else if (token === 'signals_append') {
      rules.push(`Edit(/${ctx.taskDir}/signals/${ctx.stem}.jsonl)`)
    } else if (token === 'worktree_write') {
      if (typeof ctx.worktreePath !== 'string' || ctx.worktreePath === '') {
        throw new Error('expandGrants: worktree_write requires a non-null ctx.worktreePath (isolation "primary" has no worktree — that role must not carry this token)')
      }
      rules.push(`Edit(/${ctx.worktreePath}/**)`)
    } else if (token === 'validation_commands') {
      const commands = assertValidationCommands(ctx.validationCommands || [])
      for (const cmd of commands) {
        rules.push(`Bash(${cmd} *)`)
      }
    }
  }
  return rules
}

// composeProfile(agent, { name, profile, ctx }) -> the composed profile
// matching dispatch-record.schema.json's C.1 shape. `allow` always ends
// with both CMUX_ALLOWS literals byte-identically, after the expanded
// grant-token rules (also in GRANT_TOKENS order).
export function composeProfile(agent, { name, profile, ctx }) {
  const grants = [...profile.allow]
  const expanded = expandGrants(agent, grants, ctx)
  const allow = [...expanded, ...CMUX_ALLOWS]
  for (const rule of allow) {
    assertRuleShape(rule)
  }
  return {
    name,
    permission_mode: 'dontAsk',
    grants,
    allow,
    postcondition: profile.postcondition,
    postcondition_ignore: profile.postcondition_ignore || [],
  }
}

// A second, independent gate on every rule composeProfile is about to ship
// in a record — belt-and-braces alongside expandGrants' construction, since
// this is the exact literal a `dontAsk` claude session executes against.
function assertRuleShape(rule) {
  if (!RULE_RE.test(rule)) {
    throw new Error(`composeProfile: emitted rule fails the frozen shape: ${JSON.stringify(rule)}`)
  }
  return rule
}
