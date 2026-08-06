// Pure, I/O-light resolution layer the cmux dispatcher builds on: four-layer
// roster precedence + resolveRole, expandGrants (capability tokens ->
// claude permission-rule strings) and every filesystem path derivation for
// the task/state/worktree trees, including worktree derivation. No cmux
// calls, no git, no process spawn, no record writing — this file only reads
// roster JSON off disk and computes strings. Security-load-bearing: this is
// where every path-traversal and permission-rule-shape hazard is closed.
import { readFileSync, existsSync, lstatSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
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

// snapshotDirFor(paths, dispatchId) -> the per-dispatch worker-plugin
// snapshot directory, <stateDir>/worker-plugin/<dispatch_id>. paths.snapshotDir
// (<stateDir>/worker-plugin) stays the PARENT — a long-lived executor
// worker's snapshot must never share a directory (and therefore never share
// hooks/*.sh) with a concurrent reviewer dispatch's snapshot (contract #9 /
// R1), so every dispatch gets its own subdirectory under the same parent.
// It stays UNDER stateDir, so teardown's wholesale stateDir archive/delete
// still sweeps it with no teardown change. dispatchId is validated the same
// way record.mjs's assertLowerHexId validates every id it accepts (non-empty,
// no uppercase) before being joined into the path.
export function snapshotDirFor(paths, dispatchId) {
  if (typeof dispatchId !== 'string' || dispatchId === '' || /[A-Z]/.test(dispatchId)) {
    throw new Error(`snapshotDirFor: dispatch_id must be a lowercase id, got: ${JSON.stringify(dispatchId)}`)
  }
  return assertSafePath(join(paths.snapshotDir, dispatchId))
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

// sidecarPaths(paths, dispatchId) -> the five flat, dispatch_id-keyed
// sidecar files living directly under STATE_DIR. `collapsed` (be-11-03) is
// written immediately after a successful collapse-on-close terminal-surface
// close and gates the stale-terminal-surface skip in both closeCmd's repeat
// runs and statusCmd's re-mount loop. Teardown's existing wholesale stateDir
// sweep collects it for free — no new cleanup path needed.
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
    collapsed: `${base}.collapsed`,
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

// ---------------------------------------------------------------------------
// be-11-05 (ADR-018) — opt-in workspace env-file injection. File-level
// primitives only: the declared-key allowlist (env_file_keys) itself lives in
// config.md and is read by dispatch.mjs, beside readExecutionMode; this
// module owns the reserved-key backstop, the strict refuse-never-repair
// parser, and the content hash the reuse-branch discriminator compares.
// ---------------------------------------------------------------------------

// Exact-match reserved keys: never overridable regardless of env_file_keys.
// HOME/XDG_CONFIG_HOME relocate ~/.gitconfig (core.hooksPath/sshCommand/
// aliases — arbitrary execution, the same sink GIT_ reserves, just via the
// config FILE rather than a GIT_ var) and where ~/.claude itself is read;
// ZDOTDIR redirects .zshrc (arbitrary code in every pane — zsh is macOS's
// default shell, same class as the already-reserved SHELL/BASH_ENV/ENV, more
// reachable on the actual target platform); PROMPT_COMMAND is bash's
// equivalent hook. HTTPS_PROXY/HTTP_PROXY/ALL_PROXY/SSL_CERT_FILE/
// CURL_CA_BUNDLE/REQUESTS_CA_BUNDLE are the traffic-interception family — a
// proxy plus a trusted CA is a full TLS MITM of the same API traffic the
// ANTHROPIC_ prefix below already worries about redirecting.
export const ENV_FILE_RESERVED_EXACT = Object.freeze([
  'PATH', 'NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'ENV', 'SHELL', 'IFS',
  'HOME', 'XDG_CONFIG_HOME', 'ZDOTDIR', 'PROMPT_COMMAND',
  'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'SSL_CERT_FILE', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE',
])

// Prefix-reserved key families. THIS LIST IS NOT COMPLETE AND CANNOT BE — it
// is a non-overridable BACKSTOP only, never the primary control. The primary
// control is env_file_keys (a declared, closed allowlist in config.md,
// dispatch.mjs's own readEnvFileKeys) — conventions.md 2026-08-01 "prefer a
// whitelist to a blacklist" is what makes an incomplete backstop acceptable
// here: Layer 1 already refuses every UNDECLARED key, so this list only needs
// to close the highest-severity known hazards a declaring operator might
// still reach for. One-line rationale each:
//   ANTHROPIC_ — *_BASE_URL/*_API_URL/*_AUTH_TOKEN silently REDIRECT traffic,
//     which is worse than clobbering a key (that fails loudly instead).
//   CLAUDE_    — CLAUDE_BIN redirects which binary the adapter executes.
//   DEVTEAM_   — this repo's own env contract (DEVTEAM_WORKER, ...); never
//     worker- or config-overridable.
//   CMUX_      — CMUX_BIN redirects which binary the dispatcher executes
//     (this repo's own mockability seam).
//   DYLD_      — DYLD_INSERT_LIBRARIES preloads a shared library (macOS).
//   LD_        — LD_PRELOAD preloads a shared library (Linux).
//   NODE_      — NODE_OPTIONS/NODE_PATH inject code via --require or module
//     resolution.
//   GIT_       — GIT_SSH_COMMAND/GIT_EXTERNAL_DIFF/GIT_CONFIG_* turn a
//     permitted `Bash(git diff *)` grant into arbitrary execution.
//   npm_config_ — npm_config_node_options/npm_config_script_shell are
//     honoured when a worker runs `npm test` under its validation_commands
//     grant.
export const ENV_FILE_RESERVED_PREFIXES = Object.freeze([
  'ANTHROPIC_', 'CLAUDE_', 'DEVTEAM_', 'CMUX_', 'DYLD_', 'LD_', 'NODE_', 'GIT_', 'npm_config_',
])

// QA fix (case-insensitivity, proven RCE): env var NAMES are case-sensitive
// to the OS, but several real CONSUMERS of these specific names normalize
// case before honouring them — npm matches `npm_config_*` via
// `/^npm_config_/i`, so a declared `NPM_CONFIG_SCRIPT_SHELL` (the common CI
// spelling) would pass an exact-byte prefix check yet still be honoured by
// npm when a worker runs `npm test` under its validation_commands grant,
// handing an attacker-chosen shell straight past the backstop. Every
// exact/prefix comparison below is therefore case-INSENSITIVE (compare
// upper-cased forms) — over-blocking a legitimately-cased declared key is
// the safe direction; under-blocking a dangerous case variant is the bug.
const ENV_FILE_RESERVED_EXACT_UPPER = Object.freeze(ENV_FILE_RESERVED_EXACT.map((k) => k.toUpperCase()))
const ENV_FILE_RESERVED_PREFIXES_UPPER = Object.freeze(ENV_FILE_RESERVED_PREFIXES.map((p) => p.toUpperCase()))

// isReservedEnvKey(key) -> { reserved: false } | { reserved: true, matched }.
// `matched` names the exact key or prefix family that fired — surfaced by
// dispatch.mjs's refusal message so an operator sees WHICH rule caught it,
// not just that something did.
function isReservedEnvKey(key) {
  const upperKey = key.toUpperCase()
  const exactHit = ENV_FILE_RESERVED_EXACT_UPPER.includes(upperKey)
  if (exactHit) {
    return { reserved: true, matched: ENV_FILE_RESERVED_EXACT[ENV_FILE_RESERVED_EXACT_UPPER.indexOf(upperKey)] }
  }
  const prefixIdx = ENV_FILE_RESERVED_PREFIXES_UPPER.findIndex((p) => upperKey.startsWith(p))
  if (prefixIdx >= 0) {
    return { reserved: true, matched: ENV_FILE_RESERVED_PREFIXES[prefixIdx] }
  }
  return { reserved: false, matched: null }
}

const ENV_FILE_LINE_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/
// QA fix (whitelist-over-blacklist, conventions.md 2026-08-01 — the same
// rule this module already cites for the reserved prefixes): accept ONLY
// tab + printable ASCII (0x20-0x7E) anywhere on a line; refuse anything
// else. This closes every C0/DEL control byte, U+0085 (NEL — some line
// splitters, e.g. Python/Java, treat it as a line break), U+2028/U+2029
// (line/paragraph separator), NBSP, homoglyphs, a mid-file BOM, and U+FFFD
// in ONE rule, as an explicit guarantee rather than the prior incidental
// side effect of a denylist regex a future "cleanup" could silently
// reopen. Any embedded character outside this charset anywhere on a line
// refuses the WHOLE file (governing principle: "we parse to predict what
// cmux will apply, not to consume" — an unverified construct is refused
// outright, never repaired or skipped).
const ENV_FILE_LINE_CHARSET_RE = /^[\t\x20-\x7E]*$/
const MAX_ENV_FILE_BYTES = 64 * 1024

// parseEnvFile(absPath, { declaredKeys }) -> { ok: true, keys: string[],
// sha256: string } | { ok: false, reason, line?, key?, matched? }. NEVER
// returns a parsed value and NEVER includes line content or a value in a
// refusal — only a key name, a matched reserved family, or a 1-based line
// number (env files carry secrets; same hygiene class as never logging the
// completion nonce). Refuses the ENTIRE file on the first offending line —
// never repairs, never skips a line, never accepts a partial parse.
//
// QA fix (TOCTOU): the file is read into a Buffer exactly ONCE. sha256 is
// computed over that SAME buffer the parse itself validated — a caller that
// separately re-reads-and-hashes could stamp workspace.json with the hash of
// bytes the parser never saw (a file swapped between two reads). Callers
// must use the returned sha256, never re-hash the path themselves.
//
// Accepted forms only, after stripping a leading BOM and normalizing
// CRLF->LF: blank lines, `#` comments, and `KEY=VALUE` where KEY matches
// ^[A-Za-z_][A-Za-z0-9_]*$. Refuses on: `export `-prefixed lines, a quoted
// value (double, single, OR backtick — dotenv v16+ treats backtick as a
// third, multiline-supporting quote character), a trailing-backslash
// continuation (checked against the value with trailing whitespace trimmed
// first, so `FOO=bar\ ` — backslash then a trailing space — cannot smuggle
// a continuation past a consumer that trims before testing), any character
// outside the whitelisted charset, a duplicate key, or any line matching
// none of the accepted forms — all of these are constructs whose cmux-side
// semantics this module has not verified, and a parse divergence between us
// and cmux would be a silent bypass of the whole gate.
//
// File-level refusals (env_file_unreadable, one reason for all of them —
// never a silent degrade to no-injection): a non-absolute path, a missing
// file, a non-regular file (lstatSync, not statSync, so a symlink at the
// configured path is refused rather than followed), an unreadable file, or
// a file exceeding 64 KiB.
export function parseEnvFile(absPath, { declaredKeys } = {}) {
  if (typeof absPath !== 'string' || !isAbsolute(absPath)) {
    return { ok: false, reason: 'env_file_unreadable' }
  }
  let stat
  try {
    stat = lstatSync(absPath)
  } catch {
    return { ok: false, reason: 'env_file_unreadable' }
  }
  if (!stat.isFile() || stat.size > MAX_ENV_FILE_BYTES) {
    return { ok: false, reason: 'env_file_unreadable' }
  }
  let buf
  try {
    buf = readFileSync(absPath)
  } catch {
    return { ok: false, reason: 'env_file_unreadable' }
  }
  const sha256 = createHash('sha256').update(buf).digest('hex')

  let raw = buf.toString('utf8')
  if (raw.charCodeAt(0) === 0xFEFF) {
    raw = raw.slice(1)
  }
  raw = raw.replace(/\r\n/g, '\n')

  const declared = new Set(Array.isArray(declaredKeys) ? declaredKeys : [])
  const seenKeys = new Set()
  const keys = []
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const lineNo = i + 1
    if (!ENV_FILE_LINE_CHARSET_RE.test(line)) {
      return { ok: false, reason: 'env_file_parse_error', line: lineNo }
    }
    if (/^\s*$/.test(line)) continue
    if (line.startsWith('#')) continue
    const match = ENV_FILE_LINE_RE.exec(line)
    if (!match) {
      return { ok: false, reason: 'env_file_parse_error', line: lineNo }
    }
    const [, key, value] = match
    if (value.includes('"') || value.includes("'") || value.includes('`') || value.trimEnd().endsWith('\\')) {
      return { ok: false, reason: 'env_file_parse_error', line: lineNo }
    }
    if (seenKeys.has(key)) {
      return { ok: false, reason: 'env_file_parse_error', line: lineNo }
    }
    seenKeys.add(key)
    keys.push(key)
  }

  // Reserved beats declared: checked as its own, unconditional pass BEFORE
  // the undeclared-key pass — a key that is BOTH listed in env_file_keys AND
  // matches the backstop still refuses.
  for (const key of keys) {
    const reservedCheck = isReservedEnvKey(key)
    if (reservedCheck.reserved) {
      return { ok: false, reason: 'env_file_reserved_key', key, matched: reservedCheck.matched }
    }
  }
  for (const key of keys) {
    if (!declared.has(key)) {
      return { ok: false, reason: 'env_file_undeclared_key', key }
    }
  }

  return { ok: true, keys, sha256 }
}

// hashEnvFile(absPath) -> sha256 hex digest of the RAW file bytes,
// pre-normalization. Retained as a standalone utility (tests, or a caller
// that genuinely needs the hash without a full parse) — but parseEnvFile's
// OWN caller (dispatch.mjs's workspaceCmd) must use the sha256 parseEnvFile
// itself returns, never call this a second time against the same path (see
// parseEnvFile's own TOCTOU comment above).
export function hashEnvFile(absPath) {
  const buf = readFileSync(absPath)
  return createHash('sha256').update(buf).digest('hex')
}
