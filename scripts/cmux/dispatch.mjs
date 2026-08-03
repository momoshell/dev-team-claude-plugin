#!/usr/bin/env node
// The cmux dispatcher CLI: wires resolve.mjs (paths/roster), record.mjs
// (dispatch-record lifecycle), cmuxctl.mjs (the cmux boundary) and ladder.mjs
// (evidence/outcome) into the seven lifecycle verbs. This is the ONLY file in
// the repo that spawns processes, touches git, or measures wall-clock time.
//
// usage:
//   node dispatch.mjs preflight  --task <slug> [--force]
//   node dispatch.mjs workspace  --task <slug>
//   node dispatch.mjs dispatch   --task <slug> --slice <slice_id> --role <role> --spec <path> [--attempt N] [--settle-ms N]
//   node dispatch.mjs await      --task <slug> --all <dispatch_id...> [--max-block-s N]
//   node dispatch.mjs close      --task <slug> --dispatch <dispatch_id>
//   node dispatch.mjs status     --task <slug>
//   node dispatch.mjs teardown   --task <slug> [--keep-artifacts]
//
// Common options: --checkout <primary-checkout-dir> --repo <repo-slug>
//   --root <task-artifacts-root> --config <path-to-json>
//
// Every verb prints one JSON object to stdout (machine-readable) plus human
// lines to stderr. Exit 0 = success, 1 = operational failure, 2 = usage
// error or lock contention.
//
// Zero dependencies: node builtins only.
import { spawnSync, execFileSync } from 'node:child_process'
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync,
  unlinkSync, rmSync, realpathSync,
} from 'node:fs'
import { dirname, join, resolve as resolvePath, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

import {
  resolveRoots, taskPaths, stemOf, specPathFor, renderPathFor, sidecarPaths, deriveWorktree, loadRoster,
  snapshotDirFor,
} from './resolve.mjs'
import {
  snapshotWorkerPlugin, newDispatchId, isoMs, nextAttempt,
  buildRecord, writeRecord, bindRecord, terminateRecord, withRecordLock,
  listRecords, StaleReturnError,
} from './record.mjs'
import {
  PreflightError, isValidPreflightCache,
  preflight, ensureTeamWindow, ensureWorkspace, createPane, sendLine, renameTab,
  closeSurface, closeWorkspace, mountDocTab, findDocTabSurface, reorderDocTabFirst,
  PHASES, setPhase, readEvents, tree,
} from './cmuxctl.mjs'
import {
  collectFsState, classify, reconcile, evaluatePostcondition, validateReturn, renderReturn,
} from './ladder.mjs'
import { shouldArchive, slugify, NONCE_PREFIX, PANE_ROLES, WORKER_BLOCKED_STATUSES } from './contract.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_PLUGIN_ROOT = resolvePath(HERE, '..', '..')

// ---------------------------------------------------------------------------
// EXECUTION MODE (A10 config-key half).
// ---------------------------------------------------------------------------

const EXECUTION_MODE_LINE_RE = /^execution_mode:\s*(.*)$/gm

// canonical accepted values (whitelist, not a blacklist) — widening this
// requires a deliberate edit to the EXECUTION_MODES drift-guard test too.
export const EXECUTION_MODES = Object.freeze(['agent-tool', 'cmux'])
// legacy spellings normalized on read; 'subagent' predates the agent-tool
// rename (issue #5) but must keep working.
export const EXECUTION_MODE_ALIASES = Object.freeze({ subagent: 'agent-tool' })
export const DEFAULT_EXECUTION_MODE = 'agent-tool'

// note for assertExecutionModeCmux (below): because 'subagent' normalizes to
// 'agent-tool' here, a config saying `execution_mode: subagent` now produces
// a gate refusal naming "agent-tool" — intended, since the mode IS
// agent-tool and subagent is only a spelling of it.
// trust C2: a config.md with MORE THAN ONE `execution_mode:` line (a fenced
// example quoting the key is the obvious case) is ambiguous — refusing
// beats silently matching whichever line the regex found first.
export function readExecutionMode(configText) {
  const matches = [...(configText || '').matchAll(EXECUTION_MODE_LINE_RE)]
  if (matches.length > 1) {
    throw new Error(`readExecutionMode: config text contains ${matches.length} 'execution_mode:' lines — ambiguous (a fenced example?), refusing`)
  }
  if (matches.length === 0) return DEFAULT_EXECUTION_MODE
  const raw = matches[0][1].trim()
  const value = EXECUTION_MODE_ALIASES[raw] ?? raw
  if (!EXECUTION_MODES.includes(value)) {
    // quote the RAW configured spelling, not the normalized one, so the
    // operator sees what their file actually says.
    throw new Error(`readExecutionMode: unknown execution_mode value: ${JSON.stringify(raw)}`)
  }
  return value
}

// ---------------------------------------------------------------------------
// OUTCOME MAPPING — single documented table, evaluated in order.
// ---------------------------------------------------------------------------

// OUTCOME_WORKER_BLOCKED(body status) -> the dedicated terminal outcome (added
// to OUTCOMES + the schema by fix-1c-00) for a worker-side refusal/exhaustion
// (MF1); keyed strictly on the envelope body status, never the .exit sentinel (U-4).
export const OUTCOME_WORKER_BLOCKED = 'blocked'

export const OUTCOME_MAPPING = [
  // RESIDUAL (pre-reviewer-panes, issue #6): bodyStatus is null for a markdown
  // (reviewer/validator) return, so a blocked markdown body falls through to
  // completed->ok here. Harmless while PANE_ROLES is coder-only (json bodies):
  // reviewers carry their own non-pass verdict inside the return. Revisit when
  // reviewer roles become pane-dispatched.
  { row: 'worker_blocked', outcome: OUTCOME_WORKER_BLOCKED, when: (c) => c.state === 'completed' && WORKER_BLOCKED_STATUSES.includes(c.bodyStatus) },
  { row: 'completed', outcome: 'ok', when: (c) => c.state === 'completed' },
  { row: 'exit_nonzero', outcome: 'exit_nonzero', when: (c, fsState) => fsState && fsState.exitSentinel != null && fsState.exitSentinel !== '0' },
  { row: 'timeout', outcome: 'timeout', when: (c) => c.state === 'timeout' },
  { row: 'invalid_return', outcome: 'invalid_return', when: (c, fsState) => fsState && fsState.returnPathKind === 'file' },
  { row: 'no_return', outcome: 'no_return', when: () => true },
]

// mapOutcome(classification, fsState) -> OUTCOMES member (never 'ok' unless
// classification.state === 'completed'; see OUTCOME_MAPPING row order above).
export function mapOutcome(classification, fsState) {
  for (const row of OUTCOME_MAPPING) {
    if (row.when(classification, fsState)) return row.outcome
  }
  return 'no_return'
}

// applyPostconditionOverride(outcome, postconditionResult) -> outcome.
// A violated 'clean' postcondition overrides ok with refused_postcondition;
// it never demotes an already-non-ok outcome.
export function applyPostconditionOverride(outcome, postconditionResult) {
  if (outcome === 'ok' && postconditionResult && !postconditionResult.ok) {
    return 'refused_postcondition'
  }
  return outcome
}

// ---------------------------------------------------------------------------
// Small I/O helpers.
// ---------------------------------------------------------------------------

export class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
  }
}

export class OperationalError extends Error {
  constructor(message) {
    super(message)
    this.name = 'OperationalError'
  }
}

function log(line) {
  process.stderr.write(`${line}\n`)
}

function readJsonOrNull(path) {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

// trust S5-E: await.lock/workspace.json/worktrees.json all live in
// stateDir, which a worker's own Bash subprocess can reach (G13, same uid).
// A malformed one is treated as ABSENT + a loud warning — never a throw,
// never trusted as-is. (events.cursor is a bare integer, not JSON — its own
// reader already fails safe via `Number(text) || 0`.)
function readJsonOrWarn(path, label) {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    log(`${label}: malformed JSON at ${path} — treating as absent (${err.message})`)
    return null
  }
}

function writeJsonAtomic(path, obj) {
  writeTextAtomic(path, `${JSON.stringify(obj, null, 2)}\n`)
}

// trust S6: events.cursor is the one state write in this file that used to
// skip the tmp+rename discipline every other write here follows — a crash
// mid-write would leave a partial value (low blast radius, since a garbage
// cursor just fails safe to a full replay via `Number(text) || 0`, but there
// is no reason for it to be the exception).
function writeTextAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}

// ---------------------------------------------------------------------------
// Argv parsing — a minimal, dependency-free `--flag value` / `--flag` /
// `--flag a b c...` (greedy list, terminated by the next --flag) parser.
// ---------------------------------------------------------------------------

const LIST_FLAGS = new Set(['--all'])
const BOOLEAN_FLAGS = new Set(['--force', '--keep-artifacts'])

export function parseArgs(argv) {
  const out = {}
  let i = 0
  while (i < argv.length) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      throw new UsageError(`unexpected positional argument: ${token}`)
    }
    const key = token.slice(2)
    if (BOOLEAN_FLAGS.has(token)) {
      out[key] = true
      i += 1
      continue
    }
    if (LIST_FLAGS.has(token)) {
      const values = []
      i += 1
      while (i < argv.length && !argv[i].startsWith('--')) {
        values.push(argv[i])
        i += 1
      }
      out[key] = values
      continue
    }
    const value = argv[i + 1]
    if (value === undefined) {
      throw new UsageError(`flag ${token} requires a value`)
    }
    out[key] = value
    i += 2
  }
  return out
}

// ---------------------------------------------------------------------------
// Context assembly — every path derivation goes through resolve.mjs; nothing
// here computes a path itself.
// ---------------------------------------------------------------------------

// buildContext(args) -> { roots, paths, roster, primaryCheckout, repoSlug,
// taskSlug, pluginRoot, config }. `args` is the already-parsed CLI flags;
// `--config <path>` is an optional JSON sidecar carrying dispatch-level
// overrides (worktree_prep, session roster overrides, per-dispatch
// maxGateBlocks/timeoutS/maxTurns) — none of which this file invents shapes
// for beyond what buildRecord's ctx.config already accepts.
export function buildContext(args) {
  if (!args.task) {
    throw new UsageError('--task <slug> is required')
  }
  const primaryCheckout = args.checkout ? resolvePath(args.checkout) : process.cwd()
  const pluginRoot = args['plugin-root'] ? resolvePath(args['plugin-root']) : DEFAULT_PLUGIN_ROOT
  const repoSlug = args.repo || basename(primaryCheckout)
  // trust M6: the RAW --task value is stored NOWHERE — every downstream use
  // (workspace --name, record.task_id/task_slug, the archive path) reads
  // ctx.taskSlug, so slugifying it once, here, closes every one of those
  // traversal paths at the single source rather than per-callsite.
  const taskSlug = slugify(args.task)
  const taskArtifactsRoot = args.root ? resolvePath(args.root) : undefined
  const fileConfig = args.config ? readJsonOrNull(resolvePath(args.config)) || {} : {}

  const roots = resolveRoots({ taskArtifactsRoot })
  const paths = taskPaths({ roots, repoSlug, taskSlug })

  // lifecycle S12: if the LIVE roster no longer even parses (a schema
  // violation introduced after dispatch), every verb — including read-only
  // `status` — would otherwise be hostage to a file unrelated to any
  // already-dispatched record. Fall back to roster.snapshot.json when it
  // exists; a dispatch that needs a genuinely valid live roster (buildRecord
  // reads ctx.roster) still gets the frozen-at-dispatch-time shape, which is
  // exactly what S12 asks for anyway.
  let roster
  try {
    ({ roster } = loadRoster({
      pluginRoot,
      home: process.env.HOME || process.env.USERPROFILE || '/root',
      primaryCheckout,
      session: fileConfig.session || null,
    }))
  } catch (err) {
    const snapshot = readJsonOrWarn(paths.rosterSnapshotPath, 'roster.snapshot.json')
    if (!snapshot) throw err
    log(`buildContext: the live roster is invalid (${err.message}) — falling back to roster.snapshot.json`)
    roster = snapshot
  }

  return { roots, paths, roster, primaryCheckout, repoSlug, taskSlug, pluginRoot, config: fileConfig }
}

// readTaskRoster(ctx, sliceIds) -> [{ role, cli }] shaped for preflight()'s
// adapter-presence check — one entry per distinct role actually in play.
function rosterForPreflight(roster) {
  const entries = []
  const seen = new Set()
  for (const [role, def] of Object.entries(roster.roles || {})) {
    const agent = def.agent || roster.defaults.agent
    // The adapter CLI is a fixed convention: <agent>-code for every non-claude
    // agent; 'claude' itself is always on PATH inside a Claude Code session.
    const cli = agent === 'claude' ? 'claude' : `${agent}-code`
    if (seen.has(role)) continue
    seen.add(role)
    entries.push({ role, cli })
  }
  return entries
}

// ---------------------------------------------------------------------------
// Git worktree management. Every invocation is execFileSync with an argv
// array (never a shell string) — cmux gotcha (1) applies to git too:
// unpiped, array-form spawns are the only reliable way to get real exit
// codes and never hit a shell-interpolation hazard.
// ---------------------------------------------------------------------------

function gitOutput(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function gitOk(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return res.status === 0
}

function readWorktreesIndex(path) {
  return readJsonOrWarn(path, 'worktrees.json') || {}
}

function writeWorktreesIndex(path, index) {
  writeJsonAtomic(path, index)
}

function gitBranchExists(branch, cwd) {
  return gitOk(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd)
}

// isDispatcherWorktree(path, primaryCheckout) -> boolean. Destructive removal
// is permitted ONLY on a path proven to be a dispatcher-created worktree: it
// IS a worktree, it SHARES the primary checkout's git-common-dir, and it is
// NOT the primary checkout itself. Anything else refuses (returns false) —
// this is never a --force decision.
// realpath both sides before comparing: a symlinked tmpdir (macOS's /tmp ->
// /private/tmp) would otherwise make an identical git-common-dir compare
// unequal purely because of the invoking cwd's symlink resolution.
function realResolve(base, maybeRelative) {
  return realpathSync(resolvePath(base, maybeRelative))
}

export function isDispatcherWorktree(path, primaryCheckout) {
  try {
    if (realpathSync(path) === realpathSync(primaryCheckout)) return false
    if (!existsSync(path)) return false
    const isWt = gitOutput(['rev-parse', '--is-inside-work-tree'], path) === 'true'
    if (!isWt) return false
    const commonHere = realResolve(path, gitOutput(['rev-parse', '--git-common-dir'], path))
    const commonPrimary = realResolve(primaryCheckout, gitOutput(['rev-parse', '--git-common-dir'], primaryCheckout))
    return commonHere === commonPrimary
  } catch {
    return false
  }
}

// ensureWorktree(paths, roots, repoSlug, taskSlug, sliceId, primaryCheckout,
// dispatchId) -> worktree descriptor { path, branch, created_by_dispatcher,
// source_slice_id }. Keyed by slice_id ONLY (never task_id, never attempt) —
// a second attempt of the same slice reuses the identical worktree (pinned
// U-1: the attempt bumps, the worktree never does). The attempts list at
// <state>/worktrees.json gains the new dispatch_id either way.
//
// lifecycle S5: the whole read-modify-write against worktrees.json runs
// inside withRecordLock (the same exclusive-create-sidecar primitive
// record.mjs uses for a record's own lock) — two concurrent dispatches of
// DIFFERENT slices no longer lose one entry to an interleaved read.
// lifecycle S6: a reused index entry is re-verified isDispatcherWorktree
// before being trusted (a hand-edited or stale index entry must not grant
// removal/reuse just because a path string exists); a fresh derive checks
// for an EXISTING `dt/<task>/<slice>` branch (left behind by a prior
// teardown) and reuses it via `worktree add <path> <branch>` (no `-b`)
// instead of failing on "branch already exists".
export function ensureWorktree({ roots, repoSlug, taskSlug, sliceId, primaryCheckout, dispatchId, worktreesIndexPath }) {
  const derived = deriveWorktree({
    roots, repoSlug, taskSlug, sliceId, isolation: 'worktree', createdByDispatcher: true, sourceSliceId: null,
  })

  // withRecordLock's exclusive-create lock sidecar needs its parent
  // directory to already exist — unlike writeJsonAtomic, `writeFileSync(...,
  // { flag: 'wx' })` never creates missing directories itself.
  mkdirSync(dirname(worktreesIndexPath), { recursive: true })

  return withRecordLock(worktreesIndexPath, () => {
    const index = readWorktreesIndex(worktreesIndexPath)
    const existing = index[sliceId]

    if (existing && existsSync(existing.path)) {
      if (!isDispatcherWorktree(existing.path, primaryCheckout)) {
        throw new OperationalError(`refused: worktrees.json entry for slice ${JSON.stringify(sliceId)} does not point at a dispatcher-owned worktree: ${existing.path}`)
      }
      existing.attempts = [...(existing.attempts || []), dispatchId]
      index[sliceId] = existing
      writeWorktreesIndex(worktreesIndexPath, index)
      return { path: existing.path, branch: existing.branch, created_by_dispatcher: existing.created_by_dispatcher, source_slice_id: existing.source_slice_id }
    }

    mkdirSync(dirname(derived.path), { recursive: true })
    if (gitBranchExists(derived.branch, primaryCheckout)) {
      execFileSync('git', ['worktree', 'add', derived.path, derived.branch], { cwd: primaryCheckout, encoding: 'utf8' })
    } else {
      execFileSync('git', ['worktree', 'add', '-b', derived.branch, derived.path], { cwd: primaryCheckout, encoding: 'utf8' })
    }

    index[sliceId] = {
      path: derived.path,
      branch: derived.branch,
      created_by_dispatcher: true,
      source_slice_id: null,
      attempts: [dispatchId],
    }
    writeWorktreesIndex(worktreesIndexPath, index)
    return derived
  })
}

// isWorktreeCleanAndMerged(path, primaryCheckout, branch) -> boolean.
function isWorktreeCleanAndMerged(path, primaryCheckout, branch) {
  if (!isDispatcherWorktree(path, primaryCheckout)) return false
  const porcelain = gitOutput(['status', '--porcelain'], path)
  if (porcelain.length > 0) return false
  const merged = gitOutput(['branch', '--merged'], primaryCheckout)
    .split('\n')
    .map((l) => l.replace(/^[*+]?\s+/, '').trim())
  return merged.includes(branch)
}

// removeWorktreeIfCleanAndMerged(sliceId, entry, primaryCheckout,
// worktreesIndexPath, roots) -> { removed, reason }. NEVER --force. A dirty
// or unmerged worktree is kept and reported, never deleted. lifecycle S7:
// removal additionally requires entry.created_by_dispatcher === true AND
// the path to live under roots.worktreesRoot — isDispatcherWorktree alone
// (git-common-dir equality) is true for ANY worktree of the same repo,
// including a user-owned one; nothing else in this file is what keeps such
// a worktree safe, since the index is a plain editable JSON file.
export function removeWorktreeIfCleanAndMerged({ sliceId, entry, primaryCheckout, worktreesIndexPath, roots }) {
  if (entry.created_by_dispatcher !== true) {
    return { removed: false, reason: 'not_created_by_dispatcher' }
  }
  if (!isUnderWorktreesRoot(entry.path, roots.worktreesRoot)) {
    return { removed: false, reason: 'outside_worktrees_root' }
  }
  if (!isWorktreeCleanAndMerged(entry.path, primaryCheckout, entry.branch)) {
    return { removed: false, reason: 'dirty_or_unmerged' }
  }
  if (!gitOk(['worktree', 'remove', entry.path], primaryCheckout)) {
    return { removed: false, reason: 'git_worktree_remove_failed' }
  }
  return withRecordLock(worktreesIndexPath, () => {
    const index = readWorktreesIndex(worktreesIndexPath)
    delete index[sliceId]
    writeWorktreesIndex(worktreesIndexPath, index)
    return { removed: true, reason: null }
  })
}

function isUnderWorktreesRoot(path, worktreesRoot) {
  const p = resolvePath(path)
  const root = resolvePath(worktreesRoot)
  return p === root || p.startsWith(`${root}/`)
}

// ---------------------------------------------------------------------------
// Completion nonce — conventions.md "unguessable per-run nonce delivered out
// of band": written 0600 to <state>/<dispatch_id>.nonce, never logged, never
// placed in argv/env/kickoff/task dir (assertNoNonce covers the record; this
// function is the only writer of the file itself). NEVER an env var — macOS
// `ps eww` exposes exec-time environment.
// ---------------------------------------------------------------------------

export function writeCompletionNonce(noncePath) {
  mkdirSync(dirname(noncePath), { recursive: true })
  const value = `${NONCE_PREFIX}${randomBytes(32).toString('hex')}`
  writeFileSync(noncePath, value, { mode: 0o600 })
  chmodSync(noncePath, 0o600)
}

// ---------------------------------------------------------------------------
// Execution-mode gate — every mutating verb refuses when execution_mode is
// not 'cmux'. `configText` is the raw text of .claude/dev-team/config.md
// (or '' if absent) — readExecutionMode owns the parse.
// ---------------------------------------------------------------------------

const MUTATING_VERBS = new Set(['workspace', 'dispatch', 'await', 'close', 'teardown', 'phase'])

function assertExecutionModeCmux(verb, configText) {
  if (!MUTATING_VERBS.has(verb)) return
  const mode = readExecutionMode(configText)
  if (mode !== 'cmux') {
    throw new OperationalError(
      `refused: execution_mode is ${JSON.stringify(mode)}, not "cmux" — set execution_mode: cmux in .claude/dev-team/config.md to use the cmux dispatcher`,
    )
  }
}

function readConfigText(primaryCheckout) {
  const p = join(primaryCheckout, '.claude', 'dev-team', 'config.md')
  if (!existsSync(p)) return ''
  return readFileSync(p, 'utf8')
}

// ---------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------

export function preflightCmd(args, ctx) {
  const { paths, primaryCheckout, roster } = ctx
  const rosterEntries = rosterForPreflight(roster)
  const worktreesIndex = readWorktreesIndex(paths.worktreesIndexPath)
  const worktreeDirs = Object.values(worktreesIndex).map((w) => w.path)

  const preflightJson = preflight({
    roster: rosterEntries,
    paths: { taskDir: paths.taskDir, worktreeDirs },
    primaryCheckout,
    taskArtifactsRoot: paths.stateDir,
    force: Boolean(args.force),
  })

  return { code: 0, json: preflightJson }
}

// lifecycle S14: preflight.json lives in stateDir (worker-reachable, G13) —
// every direct reader in this file (not just cmuxctl.preflight()'s own
// non-force read) must treat a malformed OR shape-invalid cache as absent,
// never as a throw and never as truth. Reuses cmuxctl.mjs's own
// isValidPreflightCache so the shape check has a single definition site.
function readPreflightCache(cachePath) {
  const cached = readJsonOrWarn(cachePath, 'preflight.json')
  if (!cached || !isValidPreflightCache(cached)) {
    if (cached) log(`preflight.json at ${cachePath} fails the frozen cache shape — treating as absent`)
    return null
  }
  return cached
}

function loadPreflightOrRefuse(paths) {
  const cachePath = join(paths.stateDir, 'preflight.json')
  const cached = readPreflightCache(cachePath)
  if (!cached) {
    throw new OperationalError('refused: no cached preflight.json — run `preflight` first')
  }
  return { cached, cachePath }
}

// ---------------------------------------------------------------------------
// workspace
// ---------------------------------------------------------------------------

export function workspaceCmd(args, ctx) {
  const { paths, primaryCheckout, taskSlug } = ctx
  const { cached, cachePath } = loadPreflightOrRefuse(paths)

  const windowId = ensureTeamWindow(cached)
  if (cached.team_window_id !== windowId) {
    writeJsonAtomic(cachePath, { ...cached, team_window_id: windowId })
  }

  const { workspaceId, initialSurfaceId } = ensureWorkspace({ windowId, taskSlug, cwd: primaryCheckout })

  const before = tree({ all: true })
  const win = (before.windows || []).find((w) => w.id === windowId)
  const ws = win?.workspaces?.find((w) => w.id === workspaceId)
  const initialPaneId = ws?.panes?.[0]?.id ?? null

  // lifecycle M1: ALWAYS rewrite workspace.json from the ensureWorkspace
  // result, never only-if-absent. ensureWorkspace re-finds the workspace by
  // TITLE and returns whatever cmux-assigned id currently exists (correct
  // even across a cmux restart, where the old id is dead but the file on
  // disk would otherwise still hold it forever) — write-once made a cmux
  // restart a permanent wedge (every subsequent `dispatch` reads the stale
  // dead id and throws createPane's "workspace is gone" error).
  const workspaceStatePath = join(paths.stateDir, 'workspace.json')
  writeJsonAtomic(workspaceStatePath, {
    window_id: windowId, workspace_id: workspaceId,
    initial_pane_id: initialPaneId, initial_surface_id: initialSurfaceId,
  })

  // S9 phase pill: entering `workspace` is the 'planning' phase.
  // setPhase('planning', { workspaceId }) is provably non-throwing here
  // ('planning' is always valid and workspaceId is always freshly minted
  // above) — wrapped anyway (qa should-fix) so a future change to setPhase
  // itself can never turn a successful `workspace` into a reported failure;
  // any throw is swallowed and logged loudly instead.
  try {
    setPhase('planning', { workspaceId })
  } catch (err) {
    log(`workspace: setPhase('planning') failed — phase pill not updated: ${err.message}`)
  }

  return { code: 0, json: { window_id: windowId, workspace_id: workspaceId, initial_surface_id: initialSurfaceId } }
}

// ---------------------------------------------------------------------------
// dependency prep — dispatcher-side, before the worker's kickoff, never a
// worker grant (ADR-013 named consequence 1). `prepCommands` is an array of
// argv arrays ([cmd, ...args]) so no shell is ever invoked.
// ---------------------------------------------------------------------------

function runDependencyPrep(worktreePath, prepCommands) {
  const logLines = []
  for (const command of prepCommands) {
    if (!Array.isArray(command) || command.length === 0 || !command.every((t) => typeof t === 'string')) {
      throw new UsageError(`worktree_prep entries must be non-empty argv arrays of strings: ${JSON.stringify(command)}`)
    }
    const res = spawnSync(command[0], command.slice(1), { cwd: worktreePath, encoding: 'utf8' })
    logLines.push(`$ ${command.join(' ')}`)
    if (res.stdout) logLines.push(res.stdout.trimEnd())
    if (res.stderr) logLines.push(res.stderr.trimEnd())
    const status = res.status ?? (res.error ? 1 : 0)
    if (status !== 0) {
      return { ok: false, log: logLines.join('\n') }
    }
  }
  return { ok: true, log: logLines.join('\n') }
}

// ---------------------------------------------------------------------------
// Adapter launch line — what actually gets typed into the pane. This is the
// launch contract be-1c-04's adapter-claude.mjs documents: `<execPath>
// <pluginRoot>/scripts/cmux/adapter-claude.mjs run <recordPath>`. Composed
// here (not inline at the sendLine call site) so it is independently
// unit-testable and so a hostile component is refused with a NAMED cause —
// sendLine's own assertSafeLine (cmuxctl.mjs) would otherwise catch the same
// hazard only as an opaque "interpolated path failed the charset check"
// symptom. process.execPath (never the bare string 'node') is the dispatcher
// process's own node — the pane's shell PATH is not ours to assume.
// ---------------------------------------------------------------------------

const ADAPTER_LAUNCH_CHARSET_RE = /^[A-Za-z0-9._/-]+$/

export function adapterLaunchLine({ execPath, pluginRoot, recordPath }) {
  for (const [name, value] of [['execPath', execPath], ['pluginRoot', pluginRoot], ['recordPath', recordPath]]) {
    if (typeof value !== 'string' || !ADAPTER_LAUNCH_CHARSET_RE.test(value)) {
      throw new Error(`adapterLaunchLine: refused — ${name} contains a character outside ^[A-Za-z0-9._/-]+$: ${JSON.stringify(value)}`)
    }
    if (!value.startsWith('/')) {
      throw new Error(`adapterLaunchLine: refused — ${name} must be an absolute path (leading '/'): ${JSON.stringify(value)}`)
    }
  }
  const adapterPath = join(pluginRoot, 'scripts', 'cmux', 'adapter-claude.mjs')
  return `${execPath} ${adapterPath} run ${recordPath}`
}

// ---------------------------------------------------------------------------
// dispatch — the 11-step sequence (see acceptance criteria).
// ---------------------------------------------------------------------------

export function dispatchCmd(args, ctx) {
  const { roots, paths, roster, primaryCheckout, repoSlug, taskSlug, pluginRoot, config } = ctx

  if (!args.slice || !args.role || !args.spec) {
    throw new UsageError('dispatch requires --slice <slice_id> --role <role> --spec <path>')
  }
  const role = args.role
  const sliceId = args.slice
  const specPath = resolvePath(args.spec)

  // (1) resolve the role and refuse if it is not pane-enabled (Phase-1 gate).
  const resolved = roster.roles[role]
  if (!resolved) {
    throw new OperationalError(`refused: unknown role ${JSON.stringify(role)}`)
  }
  if (!resolved.pane || !PANE_ROLES.includes(role)) {
    throw new OperationalError(`refused: role ${JSON.stringify(role)} is not pane-enabled in this rollout (PANE_ROLES: ${PANE_ROLES.join(', ')})`)
  }

  // trust S4: --spec must resolve to EXACTLY specPathFor(paths, sliceId) —
  // never an arbitrary path. Without this, the audit trail (record.spec_path,
  // always specPathFor-derived) could name a different file than the one
  // whose validation_commands were actually expanded into the worker's Bash
  // grants moments later. #7's entry branch copies specs into specDir before
  // dispatching, so this is never a caller-facing burden beyond that copy.
  const requiredSpecPath = specPathFor(paths, sliceId)
  if (specPath !== requiredSpecPath) {
    throw new OperationalError(`refused: --spec must be exactly ${requiredSpecPath} (got ${specPath})`)
  }
  if (!existsSync(specPath)) {
    throw new UsageError(`--spec path does not exist: ${specPath}`)
  }
  const spec = JSON.parse(readFileSync(specPath, 'utf8'))

  // lifecycle M1/M2-E: the workspace.json read AND a fresh-tree liveness
  // check are hoisted ABOVE any record write. A no-workspace dispatch or a
  // dispatch against a workspace.json left stale by a cmux restart now
  // refuses here — before writeRecord, before ANY cmux invocation beyond
  // the one `tree` call the liveness check itself makes, and crucially
  // before a record ever exists on disk to strand in create state.
  const workspaceStatePath = join(paths.stateDir, 'workspace.json')
  const workspaceState = readJsonOrWarn(workspaceStatePath, 'workspace.json')
  if (!workspaceState) {
    throw new OperationalError('refused: no workspace bound for this task — run `workspace` first')
  }
  const liveTree = tree({ all: true })
  const liveWindow = (liveTree.windows || []).find((w) => w.id === workspaceState.window_id)
  const liveWorkspace = liveWindow?.workspaces?.find((w) => w.id === workspaceState.workspace_id)
  if (!liveWorkspace) {
    throw new OperationalError('refused: stale workspace — re-run workspace')
  }

  // (2) derive the attempt.
  const attempt = args.attempt ? Number(args.attempt) : nextAttempt(paths.dispatchDir, sliceId)

  // (3) create-or-reuse the worktree when isolation is 'worktree'.
  const dispatchId = newDispatchId()
  let worktreeInfo = null
  if (resolved.isolation === 'worktree') {
    worktreeInfo = ensureWorktree({
      roots, repoSlug, taskSlug, sliceId, primaryCheckout, dispatchId,
      worktreesIndexPath: paths.worktreesIndexPath,
    })
  }

  const roles = roster.roles
  const profiles = roster.profiles
  const snapshot = snapshotWorkerPlugin({ pluginRoot, snapshotDir: snapshotDirFor(paths, dispatchId), roles, profiles })

  const recordCtx = {
    roots, paths, roster, resolved, pluginRoot,
    taskId: taskSlug, taskSlug, repoSlug, primaryCheckout, snapshot,
    config: {
      createdByDispatcher: worktreeInfo ? worktreeInfo.created_by_dispatcher : undefined,
      sourceSliceId: worktreeInfo ? worktreeInfo.source_slice_id : undefined,
      maxGateBlocks: config.maxGateBlocks,
      timeoutS: config.timeoutS,
      maxTurns: config.maxTurns,
    },
    now: Date.now(),
    dispatchId,
    attnUpstream: config.attnUpstream || null,
  }

  const record = buildRecord(recordCtx, { role, sliceId, attempt, spec })
  const stem = stemOf(sliceId, attempt)
  const recordPath = join(paths.dispatchDir, `${stem}.json`)

  // lifecycle S12: roster.snapshot.json is written ONCE, at first dispatch
  // (atomic, create-if-absent — a later dispatch in the same task never
  // overwrites it). status/close read role info from this snapshot in
  // preference to the live, mutable roster, so an edit to
  // .claude/dev-team/roster.json between dispatch and close cannot flip
  // doc_tab (or anything else) out from under an already-dispatched record.
  if (!existsSync(paths.rosterSnapshotPath)) {
    writeJsonAtomic(paths.rosterSnapshotPath, roster)
  }

  // (4) buildRecord + writeRecord (state create) + initGateCounter.
  // writeRecord itself throws StaleReturnError (a leftover return at
  // return_path) or a plain Error (an occupied record path, i.e. its own
  // exclusive-create EEXIST loser) — both are the ONLY two cases that get
  // the "bump --attempt" remedy; any other failure (EACCES, ENOSPC, ...)
  // surfaces verbatim rather than sending an operator down the wrong path.
  try {
    writeRecord(record, recordPath)
  } catch (err) {
    const isAttemptCollision = err instanceof StaleReturnError || /a record already exists at/.test(err.message)
    throw new OperationalError(isAttemptCollision ? `refused: ${err.message} (bump --attempt to remedy)` : `refused: ${err.message}`)
  }
  const sidecars = sidecarPaths(paths, dispatchId)

  // (5)-(7): parent-render the placeholder, create the pane, and bind — all
  // inside one try/catch. lifecycle M2-E: any failure in this window (a
  // failed doc-tab placeholder write, `new-pane` failing, a bind race) must
  // never leave the record stranded in an unbound, non-terminable create
  // state — it is terminated 'aborted' (allowUnbound: true, since bind never
  // happened). trust S6: the doc-tab placeholder is written with { flag:
  // 'wx' } — a pre-planted symlink at that path (the worker knows task_dir
  // and the next stem) is refused, never followed.
  const icon = resolved.icon || roster.defaults.icon || 'robot'
  let bound
  let paneId
  let surfaceId
  try {
    // (5) parent-render the placeholder returns/<stem>.md for doc-tab roles only.
    if (resolved.doc_tab) {
      const placeholderPath = renderPathFor(record)
      mkdirSync(dirname(placeholderPath), { recursive: true })
      writeFileSync(placeholderPath, `# ${icon} ${role} — working…\n`, { flag: 'wx' })
    }

    // (6) create the pane. The workspace's own initial surface is reserved
    // for the workspace itself (created by `workspace`, never reused by a
    // dispatch) — every dispatch gets its own dedicated pane via createPane.
    const created = createPane({ workspaceId: workspaceState.workspace_id })
    paneId = created.paneId
    surfaceId = created.surfaceId

    // (7) bindRecord with the pane/surface/workspace ids.
    bound = bindRecord(recordPath, {
      workspace_id: workspaceState.workspace_id, pane_id: paneId, surface_id: surfaceId,
    })
  } catch (err) {
    terminateRecord(recordPath, 'aborted', Date.now(), { allowUnbound: true })
    unlinkIfExists(sidecars.nonce)
    throw new OperationalError(`refused: dispatch aborted before bind (${err.message})`)
  }

  // Dependency prep runs dispatcher-side, in the fresh worktree, before the
  // kickoff — never a worker grant. Absent config = no prep, no error.
  // trust S6: the prep log is written with { flag: 'wx' } too.
  const prepCommands = config.worktree_prep
  if (Array.isArray(prepCommands) && prepCommands.length > 0) {
    if (!worktreeInfo) {
      throw new OperationalError('refused: worktree_prep configured but role isolation is not "worktree"')
    }
    const prep = runDependencyPrep(worktreeInfo.path, prepCommands)
    const logPath = join(paths.logsDir, `${stem}.prep.log`)
    mkdirSync(dirname(logPath), { recursive: true })
    writeFileSync(logPath, prep.log, { flag: 'wx' })
    if (!prep.ok) {
      closeSurface(surfaceId)
      terminateRecord(recordPath, 'aborted')
      // trust M3 / D-2: the nonce has not been written yet at this point
      // (it moves to immediately before sendLine, below) — this unlink is
      // therefore a no-op today, but it is kept so this abort path stays
      // correct if the nonce's write site ever moves earlier again.
      unlinkIfExists(sidecars.nonce)
      throw new OperationalError(`refused: worktree_prep failed in ${worktreeInfo.path} — see ${logPath}`)
    }
  }

  // (8) rename-tab to '{icon} {role} · {model}'.
  renameTab(surfaceId, `${icon} ${role} · ${resolved.model}`)

  // trust M3 / D-2 (pinned 2026-08-02): the completion nonce is written as
  // LATE as possible — immediately before the kickoff that actually starts
  // the worker — rather than at record-create time. This minimizes the
  // window in which the nonce sits on disk (still G13-reachable by a
  // sibling dispatch's own Bash subprocess; the ladder re-derivation is the
  // real control, this only shrinks the residual). Never logged, never
  // returned, never placed in argv/env/kickoff/task dir.
  writeCompletionNonce(sidecars.nonce)

  // (9) sendLine the adapter launch line (send THEN send-key enter — cmuxctl
  // owns this) — this is what actually starts an agent in the pane;
  // record.kickoff itself is unchanged and reaches the model via
  // adapter-claude.mjs's buildArgv-derived `--` positional, not the pane
  // shell. trust M3 residual (i): a sendLine refusal (its own charset gate,
  // or adapterLaunchLine's own refusal above it) must not leave the nonce on
  // disk against an unterminated record — the record is already bound at
  // this point, so no allowUnbound is needed. The cleanup itself is wrapped
  // separately: every field the kickoff embeds (task_dir/spec_path/
  // return_path/signals_path via frozen path charsets, attn_parent/
  // attn_upstream via the frozen devteam-<uuid>-attn pattern) is
  // independently charset-constrained upstream, and pluginRoot/recordPath are
  // both resolvePath-derived, so this throw path has no known reachable
  // trigger through the public CLI today — it exists for defense-in-depth
  // against a future kickoff/launch-composition change, and must not itself
  // crash uninformatively if a secondary failure (e.g. the record having
  // become otherwise unreadable) hits terminateRecord.
  try {
    sendLine(surfaceId, adapterLaunchLine({ execPath: process.execPath, pluginRoot, recordPath }))
  } catch (err) {
    unlinkIfExists(sidecars.nonce)
    try {
      terminateRecord(recordPath, 'aborted')
    } catch (terminateErr) {
      log(`dispatch: sendLine failed and the abort-terminate itself failed: ${terminateErr.message}`)
    }
    throw new OperationalError(`refused: sendLine failed after bind (${err.message})`)
  }

  // (10) mount the doc tab for doc_tab roles.
  if (resolved.doc_tab) {
    mountDocTab({ renderPath: renderPathFor(record), paneId, terminalSurfaceId: surfaceId })
  }

  // S9 phase pill: a successful dispatch is the 'building' phase. This
  // runs AFTER sendLine/bindRecord — a worker is already live at this
  // point, so an unguarded throw here (however unlikely today) must never
  // report a failed dispatch for a live worker. Swallowed and logged loudly.
  try {
    setPhase('building', { workspaceId: workspaceState.workspace_id })
  } catch (err) {
    log(`dispatch: setPhase('building') failed — phase pill not updated: ${err.message}`)
  }

  // (11) print result and exit — non-blocking, never waits for the worker.
  return {
    code: 0,
    json: {
      dispatch_id: bound.dispatch_id,
      workspace_id: workspaceState.workspace_id,
      pane_id: paneId,
      surface_id: surfaceId,
      attempt,
      attn_parent: bound.attn_parent,
      timeout_s: bound.timeout_s,
    },
  }
}

// ---------------------------------------------------------------------------
// await — poll-first, chunked, single-writer.
// ---------------------------------------------------------------------------

function unlinkIfExists(path) {
  try {
    unlinkSync(path)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
}

function readTextOrNull(path) {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

function findRecordByDispatchId(dispatchDir, dispatchId) {
  return listRecords(dispatchDir).find((r) => r.dispatch_id === dispatchId) || null
}

function defaultSleep(ms) {
  const sab = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(sab), 0, 0, ms)
}

const AWAIT_TICK_MS_DEFAULT = 4000
const AWAIT_CAP_DEFAULT_S = 120
const AWAIT_CAP_MIN_S = 5
const AWAIT_CAP_MAX_S = 600
const AWAIT_LOCK_STALE_MULTIPLIER = 2

// lifecycle S2: the await lock is acquired via exclusive-create ('wx'), the
// same primitive record.mjs's withRecordLock uses for a record's own lock —
// no check-then-act window. A lock that is missing, unparseable, or older
// than 2x the requested cap is STALE and is broken (logged, unlinked) rather
// than treated as a wedge; an unparseable lock is never a throw. Only the
// FIRST attempt may steal a stale lock — a second EEXIST after that refuses
// cleanly rather than looping.
function tryAcquireAwaitLock(lockPath, holder, capS) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(lockPath, JSON.stringify(holder), { flag: 'wx' })
      return { acquired: true }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      const existing = readJsonOrWarn(lockPath, 'await.lock')
      const startedMs = existing ? Date.parse(existing.started_at) : NaN
      const isStale = !existing || !Number.isFinite(startedMs) || Date.now() - startedMs > capS * AWAIT_LOCK_STALE_MULTIPLIER * 1000
      if (attempt === 0 && isStale) {
        log(`await: breaking ${existing ? `stale lock held by pid ${existing.pid}` : 'an unparseable/corrupt lock'} at await.lock`)
        unlinkIfExists(lockPath)
        continue
      }
      return { acquired: false, holder: existing }
    }
  }
  return { acquired: false, holder: readJsonOrWarn(lockPath, 'await.lock') }
}

// awaitCmd(args, ctx, deps) -> { code, json }. deps = { now, sleep, tickMs }
// are overridable so tests never sleep real wall-clock time; production
// callers get real Date.now / a real settle via SharedArrayBuffer+Atomics.
export function awaitCmd(args, ctx, deps = {}) {
  const { paths } = ctx
  const now = deps.now || Date.now
  const sleep = deps.sleep || defaultSleep
  const tickMs = deps.tickMs ?? AWAIT_TICK_MS_DEFAULT

  const ids = args.all
  if (!ids || ids.length === 0) {
    throw new UsageError('await requires --all <dispatch_id...>')
  }

  // lifecycle S1: a non-finite --max-block-s (a non-numeric string, NaN)
  // must never reach the elapsed/cap comparisons below — Number('abc') is
  // NaN, `elapsed >= NaN*1000` is never true, and `sleep(Math.max(NaN,0))`
  // coerces to a zero-length wait, i.e. an unbounded busy loop holding the
  // lock. A floor of 5s also keeps `--max-block-s 0` from disabling the
  // single-writer lock outright (age > 0 would break ANY lock).
  let capS = AWAIT_CAP_DEFAULT_S
  if (args['max-block-s'] !== undefined) {
    const requested = Number(args['max-block-s'])
    if (!Number.isFinite(requested)) {
      throw new UsageError(`--max-block-s must be a finite number, got ${JSON.stringify(args['max-block-s'])}`)
    }
    capS = Math.min(Math.max(requested, AWAIT_CAP_MIN_S), AWAIT_CAP_MAX_S)
  }

  const lockPath = paths.lockPath
  const startMs = now()
  const holder = { pid: process.pid, started_at: isoMs(startMs) }
  const acquireResult = tryAcquireAwaitLock(lockPath, holder, capS)
  if (!acquireResult.acquired) {
    return { code: 2, json: { error: 'lock_held', holder: acquireResult.holder } }
  }

  try {
    let cursor = Number(readTextOrNull(paths.cursorPath)) || 0
    let eventsDisabled = false
    const remaining = new Set(ids)

    let isFirstTick = true
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // lifecycle S3: each id's record is re-read from disk EVERY tick
      // (never cached across the loop) — a record terminated concurrently
      // by `close` or the prep-abort path must be visible on the very next
      // tick, not invisible for the rest of the cap window.
      const resolvedNow = []
      for (const id of [...remaining]) {
        const record = findRecordByDispatchId(paths.dispatchDir, id)
        if (!record) {
          remaining.delete(id)
          continue
        }
        const sidecars = sidecarPaths(paths, id)
        const fsState = collectFsState({ record, paths: { exitPath: sidecars.exit, gatePath: sidecars.gate } })
        const classification = classify({ record, fsState, tree: null, now: now(), quietState: null, topIdle: null })
        if (classification.state !== 'running' && classification.state !== 'attention') {
          resolvedNow.push({ id, record, classification, fsState })
        }
      }

      // NOTE (deliberate, do not "fix" back): the spec's own criteria are
      // mutually inconsistent here — one wording says the events catch-up
      // runs "per tick", another pins the invocation bound at dispatches +
      // ceil(elapsed/cap) + 2. This module keeps the bound: the bounded
      // events catch-up runs ONCE per await() INVOCATION (on the first
      // tick, after the fs collection above), never once per internal
      // polling tick — the bound only holds if a chunked join's total cmux
      // calls scale with the number of chunked await() calls, not with the
      // number of ticks inside any one of them. `eventsDisabled` is
      // therefore write-only per call (set at most once, on that single
      // attempt) — its name describes "no more attempts this call", not an
      // ongoing per-tick state machine.
      if (isFirstTick && !eventsDisabled) {
        const evRes = readEvents({ afterSeq: cursor, limit: 500, timeoutMs: 5000 })
        if (evRes.unavailable) {
          eventsDisabled = true
          log("await: cmux events catch-up failed on this call's single attempt — the events channel (and the quiet timer with it) is unavailable for the rest of this call")
        } else {
          cursor = evRes.seq
        }
      }
      isFirstTick = false

      if (resolvedNow.length > 0) {
        for (const r of resolvedNow) remaining.delete(r.id)
        writeTextAtomic(paths.cursorPath, String(cursor))
        // S8: render + present the doc tab for every dispatch that just
        // resolved 'completed', immediately before this return. Never a
        // resolution failure — presentReturn itself never throws.
        for (const r of resolvedNow) {
          if (r.classification.state === 'completed') {
            presentReturn(r.record, roleDefForRecovery(ctx, r.record.role))
          }
        }
        // NOTE (S4, resolution durability — intentionally deferred): await
        // reports a resolution but does not itself call terminateRecord —
        // `close` (or #7's own protocol) is the one that writes the
        // terminal transition. Between this return and that later `close`,
        // the return file could in principle be replaced; deciding WHO
        // terminates on await's behalf (and whether that is even safe
        // without racing a concurrent close) is #7's protocol call, not a
        // change this file makes unilaterally.
        return {
          code: 0,
          json: {
            resolved: resolvedNow.map((r) => ({ dispatch_id: r.id, state: r.classification.state, warnings: r.classification.warnings })),
            remaining: [...remaining],
          },
        }
      }

      const elapsedMs = now() - startMs
      if (elapsedMs >= capS * 1000) {
        writeTextAtomic(paths.cursorPath, String(cursor))
        return { code: 0, json: { status: 'still-running', remaining: [...remaining] } }
      }

      sleep(Math.min(tickMs, Math.max(capS * 1000 - elapsedMs, 0)))
    }
  } finally {
    // lifecycle S2: release ONLY if the on-disk lock still carries THIS
    // holder's exact pid + started_at — a superseded holder that wakes up
    // late (suspend/resume) must never delete a successor's lock.
    const current = readJsonOrWarn(lockPath, 'await.lock')
    if (current && current.pid === holder.pid && current.started_at === holder.started_at) {
      unlinkIfExists(lockPath)
    }
  }
}

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

// gitPorcelain(worktreePath) -> string | null. null (never '') means "could
// not be verified" (missing path, git error) — the caller must treat that
// as UNVERIFIABLE, never as a clean bill, so a gone-or-broken worktree can
// never silently pass a 'clean' postcondition.
function gitPorcelain(worktreePath) {
  if (!worktreePath || !existsSync(worktreePath)) return null
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd: worktreePath, encoding: 'utf8' })
  } catch {
    return null
  }
}

// paneExistsInTree(liveTree, paneId) -> boolean. Mirrors cmuxctl.mjs's own
// locate() shape (tree === { windows: [{ workspaces: [{ panes: [{ id,
// surfaces }] }] }] }) without importing that module-private helper — used
// by statusCmd's re-mount guard to skip a record whose bound pane is
// already gone from the ALREADY-fetched liveTree (fix for the qa should-fix
// on the re-mount loop walking terminal/pane-gone records every poll).
function paneExistsInTree(liveTree, paneId) {
  if (!liveTree) return false
  for (const w of liveTree.windows || []) {
    for (const ws of w.workspaces || []) {
      for (const p of ws.panes || []) {
        if (p.id === paneId) return true
      }
    }
  }
  return false
}

// lifecycle S12: role info (doc_tab, etc.) is read from roster.snapshot.json
// in PREFERENCE to the live, mutable roster — the snapshot is written once,
// at first dispatch, so an edit to the live roster after that point (or a
// live roster that no longer even parses) cannot change how an
// already-dispatched record is recovered. Falls back to the live roster,
// loudly, only when the snapshot is missing/unreadable/lacks the role.
function roleDefForRecovery(ctx, role) {
  const snapshot = readJsonOrWarn(ctx.paths.rosterSnapshotPath, 'roster.snapshot.json')
  if (snapshot && snapshot.roles && snapshot.roles[role]) {
    return snapshot.roles[role]
  }
  log(`roster.snapshot.json is missing, unreadable, or lacks role ${JSON.stringify(role)} — falling back to the live roster (may have drifted since dispatch)`)
  return (ctx.roster.roles || {})[role] || {}
}

// ---------------------------------------------------------------------------
// presentReturn — S8: render the validated markdown return into the doc tab
// and make that tab the pane's first tab on return. Module-local, never
// exported to workers. NEVER throws, NEVER focuses; a failure logs one line
// and is NOT a resolution failure — it must never fail a dispatch, a
// resolution, or a close. Does NOT call terminateRecord (who-terminates
// after await resolves stays #7's call, dispatch.mjs:1025-1032).
// ---------------------------------------------------------------------------
function presentReturn(record, roleDef) {
  try {
    if (!record.surface) return { rendered: false, presented: false }
    if (!roleDef || !roleDef.doc_tab) return { rendered: false, presented: false }

    // Re-read record.return_path (never trust an already-classified
    // envelope from an earlier tick) and re-validate read-only.
    const returnText = readTextOrNull(record.return_path)
    const validation = validateReturn(record, returnText)
    if (!validation.ok || record.return.kind !== 'markdown') {
      return { rendered: false, presented: false }
    }

    // renderReturn's first call site anywhere (ladder.mjs:434) — only on a
    // fresh, envelope-valid, kind:'markdown' return.
    renderReturn(record, validation.envelope)

    const paneId = record.surface.pane_id
    const terminalSurfaceId = record.surface.surface_id
    const liveTreeSnapshot = tree({ all: true })
    const found = findDocTabSurface(liveTreeSnapshot, { paneId, terminalSurfaceId })
    // Fail CLOSED on ambiguity: an ambiguous pane (>=2 markdown candidates)
    // must never be treated as "not mounted" — that read is exactly what let
    // an ambiguous pane accumulate panels forever. Skip the mount (the
    // divergent direction) and log loudly instead of guessing which surface
    // to reorder.
    let presented
    if (found.ambiguous) {
      log(`presentReturn: dispatch ${record.dispatch_id} pane ${paneId} has an ambiguous doc-tab candidate set — skipping mount/reorder`)
      presented = false
    } else if (found.id) {
      presented = reorderDocTabFirst({ paneId, terminalSurfaceId })
    } else {
      presented = mountDocTab({ renderPath: renderPathFor(record), paneId, terminalSurfaceId }) != null
    }

    return { rendered: true, presented }
  } catch (err) {
    log(`presentReturn: unexpected failure for dispatch ${record.dispatch_id}: ${err.message} — a doc-tab failure is never a resolution failure`)
    return { rendered: false, presented: false }
  }
}

export function closeCmd(args, ctx) {
  const { paths } = ctx
  if (!args.dispatch) {
    throw new UsageError('close requires --dispatch <dispatch_id>')
  }
  const record = findRecordByDispatchId(paths.dispatchDir, args.dispatch)
  if (!record) {
    throw new OperationalError(`refused: no record found for dispatch_id ${args.dispatch}`)
  }
  const recordPath = join(paths.dispatchDir, `${stemOf(record.slice_id, record.attempt)}.json`)
  const sidecars = sidecarPaths(paths, record.dispatch_id)
  const fsState = collectFsState({ record, paths: { exitPath: sidecars.exit, gatePath: sidecars.gate } })
  const classification = classify({ record, fsState, tree: null, now: Date.now(), quietState: null, topIdle: null })

  let outcome
  let postconditionResult = null
  if (record.outcome !== null) {
    outcome = record.outcome
    // trust M4: a terminal record is NEVER re-derived (classify()'s own
    // step 0 short-circuits to `terminal` and this branch trusts
    // record.outcome verbatim) — but ladder.mjs's classify() independently
    // flags a stored outcome:"ok" that the completion evaluation cannot
    // corroborate (no fresh valid return on disk to back it up) with
    // `terminal_outcome_uncorroborated`. This is a read-only refusal to
    // REPORT a forged success clean — it never rewrites the record.
    if (classification.warnings.some((w) => w.includes('terminal_outcome_uncorroborated'))) {
      log(`close: refused — record ${recordPath} claims outcome "ok" but that is not corroborated by the completion evaluation (terminal_outcome_uncorroborated)`)
    }
  } else {
    outcome = mapOutcome(classification, fsState)
    const worktreePath = record.worktree ? record.worktree.path : record.primary_checkout
    const porcelain = gitPorcelain(worktreePath)
    if (porcelain === null) {
      classification.warnings.push(`postcondition_unverifiable: could not read git status for ${worktreePath}`)
    } else {
      postconditionResult = evaluatePostcondition(record.profile, porcelain)
      outcome = applyPostconditionOverride(outcome, postconditionResult)
      if (outcome === 'refused_postcondition') {
        log(`close: dispatch ${record.dispatch_id} violated its 'clean' postcondition — offending: ${JSON.stringify(postconditionResult.offending)}`)
      }
    }
    terminateRecord(recordPath, outcome)
  }
  // trust M3 / D-2: the completion nonce's lifetime ends here, at the
  // terminal transition — it has done its job (or the dispatch never
  // reached it) and must not linger on disk any longer than this.
  // Deliberately outside the if/else (idempotent): the already-terminal
  // short-circuit branch must also unlink, or a worker that forges a
  // terminal record would keep its nonce on disk until teardown.
  unlinkIfExists(sidecars.nonce)

  // Every topology verb re-resolves its id from a fresh tree --json and
  // no-ops loudly if gone (cmuxctl's requireTargetPresent already logs).
  const roleDef = roleDefForRecovery(ctx, record.role)
  if (record.surface) {
    if (roleDef.doc_tab) {
      // doc-tab roles keep the terminal surface; re-ordering the doc tab
      // first is a within-pane selection (never focus-pane / window focus).
      // S8: render + present the return one more time on close (idempotent
      // — a no-op if presentReturn already ran from awaitCmd) so the doc
      // tab is current even if `close` is invoked without a prior `await`.
      presentReturn(record, roleDef)
      log(`close: dispatch ${record.dispatch_id} is a doc-tab role — terminal surface kept`)
    } else {
      closeSurface(record.surface.surface_id)
    }
  }

  const uncorroborated = classification.warnings.some((w) => w.includes('terminal_outcome_uncorroborated'))
  return {
    code: outcome === 'ok' && !uncorroborated ? 0 : 1,
    json: {
      dispatch_id: record.dispatch_id,
      outcome,
      warnings: classification.warnings,
      postcondition: postconditionResult,
    },
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export function statusCmd(args, ctx) {
  const { paths, taskSlug } = ctx
  // lifecycle M5-E: a single unreadable committed record (filesystem
  // corruption, a hand edit, a schema violation readRecord now refuses) must
  // never wedge `status` — it is reported in the unreadable array below
  // (never as a RECOVERY_ROWS entry: reconcile describes DISPATCHES, and an
  // unparseable file is not one) and skipped, so every OTHER record still
  // reconstructs normally.
  const unreadable = []
  const records = listRecords(paths.dispatchDir, {
    onUnreadable: ({ path, error }) => unreadable.push({ path, error: error.message }),
  })

  // lifecycle S10: git status --porcelain runs per record's own worktree so
  // reconcile's crashed-row "worktree has uncommitted changes" warning is
  // actually reachable from production `status` — collectFsState itself
  // never invokes git; this is the one caller that supplies worktreeDirty.
  const fsStateByDispatch = {}
  for (const record of records) {
    const sidecars = sidecarPaths(paths, record.dispatch_id)
    const worktreePath = record.worktree ? record.worktree.path : null
    const porcelain = worktreePath ? gitPorcelain(worktreePath) : null
    fsStateByDispatch[record.dispatch_id] = collectFsState({
      record,
      paths: { exitPath: sidecars.exit, gatePath: sidecars.gate, worktreeDirty: Boolean(porcelain && porcelain.trim().length > 0) },
    })
  }

  let liveTree = null
  try {
    liveTree = tree({ all: true })
  } catch {
    liveTree = null
  }

  const rows = reconcile({ records, fsState: fsStateByDispatch, tree: liveTree, now: Date.now() })

  // Re-mount doc tabs from files when the panel is gone (S20: markdown
  // panels do not survive a cmux restart). A role only reaches here with a
  // bound surface if it is pane-enabled; doc_tab-without-pane roles never
  // bind a surface, so this loop is a structural no-op for them.
  for (const record of records) {
    const roleDef = roleDefForRecovery(ctx, record.role)
    if (!roleDef.doc_tab || !record.surface) continue
    if (!liveTree) continue
    const paneId = record.surface.pane_id
    const terminalSurfaceId = record.surface.surface_id
    // Gate on pane liveness ALONE, never on record.outcome. closeCmd
    // deliberately KEEPS a doc-tab role's terminal surface and pane (never
    // closeSurface for those), so a record that already closed 'ok' can
    // still have a perfectly live pane whose doc tab needs recovering after
    // a cmux restart (S20) — "the architecture-package viewer stays open
    // for the whole task" is a design invariant, not just a while-running
    // one. The bound pane itself must still be present in the
    // ALREADY-fetched liveTree — a pane gone from the tree (not just its
    // doc-tab surface) is nothing this loop can safely re-mount into, and
    // is exactly the noise case (a torn-down/aborted record) this check
    // suppresses instead.
    if (!paneExistsInTree(liveTree, paneId)) continue
    // S8 double-mount guard: findDocTabSurface against the ALREADY-fetched
    // liveTree (never a fresh re-fetch here) — a doc tab already present
    // skips mountDocTab outright. Without this, every `status` call would
    // mount another panel for every pane+doc_tab role (S4 made six such
    // roles; before that this loop was a structural no-op). An AMBIGUOUS
    // pane (>=2 markdown candidates) is fail-CLOSED: skip the mount and log
    // loudly rather than guess or pile on a third panel — mounting is the
    // divergent direction, skipping self-corrects.
    const found = findDocTabSurface(liveTree, { paneId, terminalSurfaceId })
    if (found.ambiguous) {
      log(`status: dispatch ${record.dispatch_id} pane ${paneId} has an ambiguous doc-tab candidate set — skipping re-mount`)
      continue
    }
    if (!found.id) {
      mountDocTab({ renderPath: renderPathFor(record), paneId, terminalSurfaceId })
    }
  }

  for (const row of rows) {
    const warnPart = row.warnings.length ? ` warnings=${row.warnings.join(';')}` : ''
    log(`status: ${row.dispatch_id} ${row.row} state=${row.state}${warnPart}`)
  }
  for (const u of unreadable) {
    log(`status: unreadable record at ${u.path}: ${u.error}`)
  }

  const statusJson = { task_slug: taskSlug, generated_at: new Date().toISOString(), rows, unreadable }
  writeJsonAtomic(paths.statusPath, statusJson)
  return { code: 0, json: statusJson }
}

// ---------------------------------------------------------------------------
// teardown
// ---------------------------------------------------------------------------

export function teardownCmd(args, ctx) {
  const { roots, paths, primaryCheckout, taskSlug } = ctx
  const preflightCache = readPreflightCache(join(paths.stateDir, 'preflight.json')) || {}
  const workspaceState = readJsonOrWarn(join(paths.stateDir, 'workspace.json'), 'workspace.json')

  if (workspaceState) {
    const before = tree({ all: true })
    const win = (before.windows || []).find((w) => w.id === workspaceState.window_id)
    const ws = win?.workspaces?.find((w) => w.id === workspaceState.workspace_id)
    const surfaceIds = (ws?.panes || []).flatMap((p) => p.surfaces || []).map((s) => s.id)
    for (const surfaceId of surfaceIds) {
      closeSurface(surfaceId)
    }
    // preflight.json's `methods` are live RPC-style dotted names
    // (workspace.close, ...), never CLI verb names — close_workspace_available
    // is the boolean preflight() already derived from VERB_METHODS for us.
    if (preflightCache.close_workspace_available) {
      closeWorkspace(workspaceState.workspace_id)
    } else {
      log('teardown: close-workspace is not available per the cached preflight — no-op')
    }
    tree({ all: true }) // verify
  }

  const records = listRecords(paths.dispatchDir)
  const archive = Boolean(args['keep-artifacts']) || shouldArchive({ outcome: 'ok' }, records)

  // The worktree index lives under stateDir — it MUST be read and
  // reconciled before stateDir itself is archived/deleted below.
  const index = readWorktreesIndex(paths.worktreesIndexPath)
  const leftoverWorktrees = []
  for (const [sliceId, entry] of Object.entries(index)) {
    const res = removeWorktreeIfCleanAndMerged({ sliceId, entry, primaryCheckout, worktreesIndexPath: paths.worktreesIndexPath, roots })
    if (!res.removed) {
      leftoverWorktrees.push({ slice_id: sliceId, path: entry.path, reason: res.reason })
      log(`teardown: kept worktree for slice ${sliceId} (${res.reason}): ${entry.path}`)
    }
  }

  const dateStr = new Date().toISOString().slice(0, 10)
  const taskDirAction = archiveOrDelete(paths.taskDir, join(roots.tasksRoot, '.archive', `${taskSlug}-${dateStr}`), archive)
  // lifecycle S8: stateDir (0600 completion nonces, dispatch records,
  // preflight.json, workspace.json, worktrees.json, events.cursor) is swept
  // alongside taskDir — this is what makes M1's workspace.json fix durable
  // (nothing survives teardown to go stale) and closes trust M3/D-2's
  // "nothing ever unlinks this" gap for any nonce that somehow outlived
  // dispatch/close (e.g. an aborted-before-terminate crash).
  const stateDirAction = archiveOrDelete(paths.stateDir, join(roots.stateRoot, '.archive', `${taskSlug}-${dateStr}`), archive)

  return { code: 0, json: { task_dir: taskDirAction, state_dir: stateDirAction, leftover_worktrees: leftoverWorktrees } }
}

// lifecycle S9: the archive directory name is uniquified on collision
// (<slug>-<date>, then -2, -3, ...) — a same-day second teardown of the same
// task must never throw ENOTEMPTY partway through (after surfaces are
// already closed).
function uniquifyDir(baseDir) {
  if (!existsSync(baseDir)) return baseDir
  for (let n = 2; ; n += 1) {
    const candidate = `${baseDir}-${n}`
    if (!existsSync(candidate)) return candidate
  }
}

function archiveOrDelete(dir, archiveBaseDir, archive) {
  if (!existsSync(dir)) {
    return { archived: false, deleted: false }
  }
  if (archive) {
    const archiveDir = uniquifyDir(archiveBaseDir)
    mkdirSync(dirname(archiveDir), { recursive: true })
    renameSync(dir, archiveDir)
    return { archived: true, path: archiveDir }
  }
  rmSync(dir, { recursive: true, force: false })
  return { archived: false, deleted: true }
}

// ---------------------------------------------------------------------------
// phase — S9. `phase --set <planning|building|gate>`. 'gate' is never fired
// from code (only OUTCOME_MAPPING/workspaceCmd/dispatchCmd fire 'planning'/
// 'building') — the orchestrator invokes `phase --set gate` directly.
// ---------------------------------------------------------------------------

export function phaseCmd(args, ctx) {
  const { paths } = ctx
  if (!args.set) {
    throw new UsageError('phase requires --set <planning|building|gate>')
  }
  if (!PHASES.includes(args.set)) {
    throw new UsageError(`phase: --set must be one of ${PHASES.join('|')}, got ${JSON.stringify(args.set)}`)
  }
  const workspaceState = readJsonOrWarn(join(paths.stateDir, 'workspace.json'), 'workspace.json')
  if (!workspaceState) {
    throw new OperationalError('refused: no workspace bound for this task — run `workspace` first')
  }
  setPhase(args.set, { workspaceId: workspaceState.workspace_id })
  return { code: 0, json: { phase: args.set } }
}

// ---------------------------------------------------------------------------
// CLI entry point.
// ---------------------------------------------------------------------------

const COMMANDS = {
  preflight: preflightCmd,
  workspace: workspaceCmd,
  dispatch: dispatchCmd,
  await: awaitCmd,
  close: closeCmd,
  status: statusCmd,
  teardown: teardownCmd,
  phase: phaseCmd,
}

function printResult(result) {
  process.stdout.write(`${JSON.stringify(result.json)}\n`)
}

// main(argv) -> exit code. argv excludes 'node' and the script path.
export function main(argv) {
  const [verb, ...rest] = argv
  if (!verb || !COMMANDS[verb]) {
    log(`usage: node dispatch.mjs <${Object.keys(COMMANDS).join('|')}> [options]`)
    return 2
  }

  let args
  try {
    args = parseArgs(rest)
  } catch (err) {
    log(`usage error: ${err.message}`)
    return 2
  }

  let ctx
  try {
    ctx = buildContext(args)
  } catch (err) {
    log(`usage error: ${err.message}`)
    return err instanceof UsageError ? 2 : 1
  }

  try {
    assertExecutionModeCmux(verb, readConfigText(ctx.primaryCheckout))
  } catch (err) {
    log(err.message)
    printResult({ code: 1, json: { error: err.message } })
    return 1
  }

  let result
  try {
    result = COMMANDS[verb](args, ctx)
  } catch (err) {
    if (err instanceof UsageError) {
      log(`usage error: ${err.message}`)
      return 2
    }
    if (err instanceof PreflightError) {
      log(err.message)
      printResult({ code: 1, json: { error: err.code, message: err.message } })
      return 1
    }
    log(`error: ${err.message}`)
    printResult({ code: 1, json: { error: err.message } })
    return 1
  }

  printResult(result)
  return result.code
}

const invokedDirectly = process.argv[1] && resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)))
}
