#!/usr/bin/env node
// The process a worker pane actually runs. cmux drives a pane by starting
// THIS script (never claude directly) as: node adapter-claude.mjs run
// <abs record path>. This module enforces the five PRE-1C-VERIFY
// preconditions record.mjs's snapshotWorkerPlugin header pins (record.mjs,
// the block above snapshotWorkerPlugin, and the buildArgv header comment
// above it), composes the environment and argv that record.mjs's buildArgv
// hands back, and spawns claude with stdio inherited so the TUI owns the
// pane's tty. Restated here, verbatim in spirit, because the obligation
// travels with the artifact that discharges it:
//   (1) validate the record against dispatch-record.schema.json; refuse on
//       violation.
//   (2) recompute sha256 of role_prompt_path bytes vs
//       record.role_prompt_sha256; refuse on mismatch; role_prompt_path must
//       equal <snapshot>/roles/<role>.txt. Never repaired, never
//       re-snapshotted.
//   (3) walk dirname(dirname(role_prompt_path)) and refuse on any entry
//       outside the closed inventory (roles/<role>.txt, root-level
//       <name>.schema.json referenced by record.return, and exactly
//       WORKER_PLUGIN_MANIFEST's destinations — byte-compared against their
//       plugin-root source, never merely present-checked), any symlink
//       anywhere, any non-regular file, any directory other than roles/,
//       hooks/, .claude-plugin/.
//   (4) read-and-unlink <dirname(env.DEVTEAM_GATE_COUNTER)>/<dispatch_id>.nonce
//       (unlink in a finally, so a partial read still consumes it); absent
//       => refuse.
//   (5) before spawn, sweep the composed argv + env for NONCE_PREFIX and the
//       nonce value itself; a hit throws before any spawn. The nonce is
//       never in the AGENT's argv/env, on any path — this adapter's own log
//       file and stderr never contain it either, though the completion
//       signal (output 2) is a documented, bounded exception: it briefly
//       appears in THIS adapter's own `cmux wait-for -S <token>` child
//       argv (visible to `ps` for that one call's lifetime), never
//       claude's.
//
// A hung orchestrator is a contract violation: every failure path — a
// refused precondition, an ENOENT on spawn, a missing/invalid return, a
// signal — still produces a fresh valid return OR an adapter-written
// blocked return (output 1), and an exit sentinel written exactly once
// followed by a best-effort completion signal (output 2). Output 3 is this
// adapter's own diagnostic log; output 4 is a meaningful exit code that
// holds the pane open on any non-zero result so a human can read it.
//
// Security posture (code-reviewer-deep required per the handover spec):
// buildArgv (record.mjs) is the ONLY argv source — this module never
// appends a flag of its own, so --dangerously-skip-permissions or any
// bypassPermissions variant can only ever reach claude if buildArgv itself
// emitted it (out of this slice's scope; buildArgv is frozen upstream). The
// snapshot tree is never repaired, re-snapshotted or chmod'd — REFUSE is
// the only verdict on a bad snapshot. The nonce is read into a local and
// unlinked before claude exists (ADR-003 Am.1 + Rider E); it is swept out of
// argv/env before spawn and is never passed to logger.log/stderr.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import {
  readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync, statSync, lstatSync,
  readdirSync, appendFileSync, readSync, realpathSync,
} from 'node:fs'
import {
  dirname, join, delimiter, resolve as resolvePath,
} from 'node:path'
import { fileURLToPath } from 'node:url'
import { validate, NONCE_PREFIX } from './contract.mjs'
import { collectFsState, isFresh, validateReturn } from './ladder.mjs'
import { writeBlockedReturn } from './return-lint.mjs'
import { buildArgv, WORKER_PLUGIN_MANIFEST } from './record.mjs'
import { signalToken } from './cmuxctl.mjs'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
// Never derived from the record — the plugin root is this module's OWN
// location (PRE-1C-VERIFY (3)'s closing rule): scripts/cmux/adapter-claude.mjs
// -> scripts/cmux -> scripts -> plugin root.
const PLUGIN_ROOT = dirname(dirname(MODULE_DIR))
const DISPATCH_RECORD_SCHEMA = JSON.parse(readFileSync(join(MODULE_DIR, 'dispatch-record.schema.json'), 'utf8'))

// The single binary-name indirection, mirroring cmuxctl.mjs:20 exactly — no
// other literal 'claude' anywhere in this module or its tests.
export const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude'

const CONTRACT_VERSION = 1
const SUPPORTS_KEYS = [
  'model', 'effort', 'system_prompt_file', 'permission_mode', 'tool_allow_deny',
  'scoped_path_rules', 'non_prompting_mode', 'session_resume', 'headless', 'slash_command_disable',
]

const EXIT_OK = 0
const EXIT_NO_RETURN = 1
const EXIT_REFUSAL = 2
const EXIT_CLI_MISSING = 3

export const USAGE_MESSAGE = 'usage: node adapter-claude.mjs capabilities | run <record-path>'

// ---------------------------------------------------------------------------
// Small shared helpers.
// ---------------------------------------------------------------------------

// Atomic tmp+rename write in the destination directory — conventions.md
// "concurrency-unsafe check-then-act": every write here mirrors record.mjs's
// own writeAtomicBytes, never rm-then-recreate (cmux's ~500ms watcher
// retry).
function writeAtomicBytes(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, path)
}

function isExistingDirectory(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

// makeLogger(stateDir, dispatchId) -> { logPath, log(line) }. Output 3:
// append, mkdir -p, mirrored to stderr. NEVER passed the nonce by any
// caller in this module — the sweep (step 5) is the structural guard; this
// function itself has no nonce-awareness to enforce, by construction.
function makeLogger(stateDir, dispatchId) {
  const logsDir = join(stateDir, 'logs')
  const logPath = join(logsDir, `${dispatchId}.log`)
  return {
    logPath,
    log(line) {
      const stamped = `[${new Date().toISOString()}] adapter-claude: ${line}`
      try {
        mkdirSync(logsDir, { recursive: true })
        appendFileSync(logPath, `${stamped}\n`)
      } catch {
        // The log is diagnostic, not load-bearing — a failure to write it
        // must never be the reason a refusal fails to complete.
      }
      process.stderr.write(`${stamped}\n`)
    },
  }
}

function usage(msg) {
  process.stderr.write(`adapter-claude: ${msg}\n${USAGE_MESSAGE}\n`)
  return EXIT_REFUSAL
}

// ---------------------------------------------------------------------------
// OUTPUT 2 — the exit sentinel + best-effort completion signal. Installed
// lazily, only once we know a real (non-dry-run) `run` is underway, so
// `capabilities`/usage/dry-run invocations never register a process-wide
// signal handler at all. Guarded so exactly one sentinel write and at most
// one signal happen per process, over a normal exit, a refusal exit, or one
// of the three signals below (all of which route through process.exit and
// therefore through this same 'exit' listener — the pr-review-window.sh
// convention: exit code 128 + signal number).
// ---------------------------------------------------------------------------

let handlersInstalled = false
let sentinelWritten = false
let signalDelivered = false
let sentinelState = null // { stateDir, dispatchId, nonce }

function installLifecycleHandlers() {
  if (handlersInstalled) return
  handlersInstalled = true
  process.on('exit', (code) => finalizeSentinel(code))
  process.on('SIGHUP', () => process.exit(129))
  process.on('SIGINT', () => process.exit(130))
  process.on('SIGTERM', () => process.exit(143))
}

function armSentinel(stateDir, dispatchId) {
  sentinelState = { stateDir, dispatchId, nonce: null }
  installLifecycleHandlers()
}

function setSentinelNonce(nonce) {
  if (sentinelState) sentinelState.nonce = nonce
}

function finalizeSentinel(code) {
  if (sentinelWritten) return
  sentinelWritten = true
  if (!sentinelState) return
  const { stateDir, dispatchId, nonce } = sentinelState
  try {
    writeAtomicBytes(join(stateDir, `${dispatchId}.exit`), String(code))
  } catch {
    // best-effort — an 'exit' handler must never throw.
  }
  if (!signalDelivered) {
    signalDelivered = true
    if (nonce) {
      try {
        signalToken(nonce)
      } catch {
        // best-effort, never throws, never logs the token.
      }
    }
  }
}

// holdPaneIfNeeded(code) -> code. OUTPUT 4: on any non-zero result the pane
// is held open by blocking on a single byte from the tty, skipped when
// process.stdin.isTTY is false so tests (and any non-interactive invocation)
// never hang. MF2: finalizeSentinel(code) fires FIRST, at the very top —
// output 2 (the sentinel file + the best-effort completion signal) must be
// on disk/delivered before any human keypress is ever awaited, for every
// non-zero path and the zero path alike. sentinelWritten/signalDelivered
// keep this idempotent, so the later 'exit' listener's own finalizeSentinel
// call (once process.exit eventually runs) always no-ops.
function holdPaneIfNeeded(code) {
  finalizeSentinel(code)
  // TEST-ONLY seam (MF2 ordering proof) — never touched by a real dispatch.
  // test/claude-adapter.test.mjs sets DEVTEAM_ADAPTER_TEST_HOLD_SEAM to a
  // marker path so it can deterministically observe "past finalizeSentinel,
  // still blocked" without needing a real tty: this spins until that marker
  // file exists (or a 5s safety deadline), the exact window a genuine
  // isTTY-gated hold otherwise only offers under a real pane.
  const holdSeam = process.env.DEVTEAM_ADAPTER_TEST_HOLD_SEAM
  if (holdSeam) {
    const sab = new Int32Array(new SharedArrayBuffer(4))
    const deadline = Date.now() + 5000
    while (!existsSync(holdSeam) && Date.now() < deadline) {
      Atomics.wait(sab, 0, 0, 25)
    }
  }
  if (code !== EXIT_OK && process.stdin.isTTY) {
    try {
      const buf = Buffer.alloc(1)
      readSync(0, buf, 0, 1, null)
    } catch {
      // best-effort — never throw while holding a failed pane open.
    }
  }
  return code
}

// ---------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------

function findCliPath(bin) {
  if (bin.includes('/')) {
    const abs = resolvePath(bin)
    return existsSync(abs) ? abs : null
  }
  const dirs = (process.env.PATH || '').split(delimiter)
  for (const dir of dirs) {
    const candidate = join(dir, bin)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function nullSupports() {
  const out = {}
  for (const key of SUPPORTS_KEYS) out[key] = null
  return out
}

// deriveSupportsFromHelp(helpText) -> the six supports keys derivable purely
// from `<cli> --help` text (never fabricated for the two keys that are not:
// scoped_path_rules, non_prompting_mode; those stay null everywhere in this
// module). Absence of a flag is a real derivation (false), not a guess.
function deriveSupportsFromHelp(helpText) {
  const has = (re) => re.test(helpText)
  return {
    model: has(/--model\b/),
    effort: has(/--effort\b/),
    permission_mode: has(/--permission-mode\b/),
    tool_allow_deny: has(/--allowedTools\b/) && has(/--disallowedTools\b/),
    session_resume: has(/--resume\b/) || has(/--continue\b/),
    headless: has(/--print\b/) || has(/(^|\s)-p(\s|,|$)/),
    slash_command_disable: has(/--disable-slash-commands\b/),
  }
}

// probeSystemPromptFile(cliPath) -> boolean. conventions.md 2026-08-01: the
// only probe that works. --version/--help short-circuit and prove nothing,
// so this passes a nonexistent file to --append-system-prompt-file WITH
// NEITHER of those flags and classifies stderr: an "unknown option" style
// message means the flag is unsupported (false); a file-not-found style
// message means the flag IS recognized and the CLI tried (and failed) to
// read it (true). This probe runs in `capabilities` ONLY, never in `run`.
function probeSystemPromptFile(cliPath) {
  const nonexistent = join(tmpdir(), `adapter-claude-probe-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`)
  const result = spawnSync(cliPath, ['--append-system-prompt-file', nonexistent], { encoding: 'utf8', timeout: 10_000 })
  const text = `${result.stdout || ''}\n${result.stderr || ''}`
  if (/unknown option|unrecognized option|unknown flag/i.test(text)) return false
  if (/no such file|not found|enoent|cannot find|does not exist/i.test(text)) return true
  return false
}

function buildCapabilitiesPayload({ cliPath, cliVersion, supports }) {
  return {
    adapter: CLAUDE_BIN,
    contract_version: CONTRACT_VERSION,
    cli: CLAUDE_BIN,
    cli_path: cliPath,
    cli_version: cliVersion,
    supports,
  }
}

function cmdCapabilities() {
  const cliPath = findCliPath(CLAUDE_BIN)
  if (!cliPath) {
    const payload = buildCapabilitiesPayload({ cliPath: null, cliVersion: null, supports: nullSupports() })
    process.stdout.write(`${JSON.stringify(payload)}\n`)
    return EXIT_CLI_MISSING
  }

  const versionResult = spawnSync(cliPath, ['--version'], { encoding: 'utf8', timeout: 10_000 })
  const cliVersion = !versionResult.error && versionResult.status === 0 ? versionResult.stdout.trim() : null

  const helpResult = spawnSync(cliPath, ['--help'], { encoding: 'utf8', timeout: 10_000 })
  const helpText = !helpResult.error ? `${helpResult.stdout || ''}\n${helpResult.stderr || ''}` : ''

  const supports = {
    ...deriveSupportsFromHelp(helpText),
    system_prompt_file: probeSystemPromptFile(cliPath),
    scoped_path_rules: null,
    non_prompting_mode: null,
  }

  const payload = buildCapabilitiesPayload({ cliPath, cliVersion, supports })
  process.stdout.write(`${JSON.stringify(payload)}\n`)
  return EXIT_OK
}

// ---------------------------------------------------------------------------
// PRE-1C-VERIFY (2) — role prompt hash + path identity.
// ---------------------------------------------------------------------------

function verifyRolePromptHash(record) {
  let bytes
  try {
    bytes = readFileSync(record.role_prompt_path)
  } catch (err) {
    throw new Error(`role_prompt_path is unreadable: ${record.role_prompt_path}: ${err.message}`)
  }
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== record.role_prompt_sha256) {
    throw new Error(`role_prompt_path sha256 mismatch at ${record.role_prompt_path}`)
  }
  const expectedPath = join(dirname(dirname(record.role_prompt_path)), 'roles', `${record.role}.txt`)
  if (resolvePath(record.role_prompt_path) !== resolvePath(expectedPath)) {
    throw new Error(`role_prompt_path does not equal <snapshot>/roles/<role>.txt: ${record.role_prompt_path}`)
  }
}

// ---------------------------------------------------------------------------
// PRE-1C-VERIFY (3) — closed snapshot inventory walk.
// ---------------------------------------------------------------------------

// collectSnapshotEntries(snapshotDir) -> [{ rel, st }] — lstat-based (never
// follows a symlink, and never recurses into one either), depth-first,
// relative paths use '/' regardless of platform.
function collectSnapshotEntries(snapshotDir) {
  const entries = []
  function walk(dir, relDir) {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name)
      const rel = relDir ? `${relDir}/${name}` : name
      const st = lstatSync(abs)
      entries.push({ rel, st })
      if (!st.isSymbolicLink() && st.isDirectory()) {
        walk(abs, rel)
      }
    }
  }
  walk(snapshotDir, '')
  return entries
}

// The snapshot is built PER DISPATCH (R1: a long-lived executor's snapshot
// must never share a directory with a concurrent reviewer dispatch's — see
// resolve.mjs's snapshotDirFor), from the FULL roster (snapshotWorkerPlugin
// loops over every roster role, not just the role this record dispatches),
// so a root-level schema file referenced by a DIFFERENT role's return spec
// is a legitimate, expected sibling — never restricted to only this
// record's own return.schema_path. A root-level file is closed-inventory
// membership purely by SHAPE (roster.schema.json's own return.schema
// pattern requires a `.schema.json` suffix); this module has no visibility
// into the full roster to name every distinct one.
const ROOT_SCHEMA_FILENAME_RE = /^[a-z0-9][a-z0-9-]*\.schema\.json$/

// verifySnapshotInventory(record) -> void, throws on any breach. Refuses
// (never repairs, never re-snapshots, never chmods, never deletes) on: any
// symlink anywhere; any non-regular file; any directory other than roles/,
// hooks/, .claude-plugin/; any entry outside the closed inventory
// (roles/<name>.txt, root-level <name>.schema.json, and exactly
// WORKER_PLUGIN_MANIFEST's destinations); any manifest file whose bytes
// differ from its plugin-root source (byte comparison, not a hash
// comparison — a hash collision is not the threat model here, a planted
// extra byte silently accepted by a truncating comparison is); a root-level
// schema whose bytes differ from its plugin-root source (F6 — same
// discipline as the manifest entries, not merely shape-accepted); and (MF4)
// a WORKER_PLUGIN_MANIFEST destination that is simply MISSING from the
// snapshot altogether — the walk above only ever inspects entries that
// exist, so a deleted manifest file would otherwise pass silently. seen
// collects every manifest destination actually observed during the walk;
// after it, every manifest key not in seen is a refusal.
function verifySnapshotInventory(record) {
  const snapshotDir = resolvePath(dirname(dirname(record.role_prompt_path)))
  const entries = collectSnapshotEntries(snapshotDir)
  const seenManifestDest = new Set()

  for (const { rel, st } of entries) {
    if (st.isSymbolicLink()) {
      throw new Error(`snapshot inventory: refused — symlink found at ${rel}`)
    }
    if (st.isDirectory()) {
      if (rel.includes('/') || !['roles', 'hooks', '.claude-plugin'].includes(rel)) {
        throw new Error(`snapshot inventory: refused — unexpected directory: ${rel}`)
      }
      continue
    }
    if (!st.isFile()) {
      throw new Error(`snapshot inventory: refused — non-regular file at ${rel}`)
    }

    if (rel.startsWith('roles/')) {
      if (!/^roles\/[a-z0-9]+(-[a-z0-9]+)*\.txt$/.test(rel)) {
        throw new Error(`snapshot inventory: refused — unexpected file under roles/: ${rel}`)
      }
      continue
    }

    if (Object.prototype.hasOwnProperty.call(WORKER_PLUGIN_MANIFEST, rel)) {
      const srcPath = join(PLUGIN_ROOT, WORKER_PLUGIN_MANIFEST[rel])
      let srcBytes
      try {
        srcBytes = readFileSync(srcPath)
      } catch (err) {
        throw new Error(`snapshot inventory: refused — plugin-root source unreadable for ${rel}: ${err.message}`)
      }
      const destBytes = readFileSync(join(snapshotDir, rel))
      if (!destBytes.equals(srcBytes)) {
        throw new Error(`snapshot inventory: refused — manifest file bytes differ from plugin-root source: ${rel}`)
      }
      seenManifestDest.add(rel)
      continue
    }

    if (!rel.includes('/') && ROOT_SCHEMA_FILENAME_RE.test(rel)) {
      const rootSrcPath = join(PLUGIN_ROOT, rel)
      let rootSrcBytes
      try {
        rootSrcBytes = readFileSync(rootSrcPath)
      } catch (err) {
        throw new Error(`snapshot inventory: refused — plugin-root source unreadable for root schema ${rel}: ${err.message}`)
      }
      const rootDestBytes = readFileSync(join(snapshotDir, rel))
      if (!rootDestBytes.equals(rootSrcBytes)) {
        throw new Error(`snapshot inventory: refused — root schema bytes differ from plugin-root source: ${rel}`)
      }
      continue
    }

    throw new Error(`snapshot inventory: refused — entry outside the closed inventory: ${rel}`)
  }

  for (const dest of Object.keys(WORKER_PLUGIN_MANIFEST)) {
    if (!seenManifestDest.has(dest)) {
      throw new Error(`snapshot inventory: refused — missing manifest destination: ${dest}`)
    }
  }
}

// ---------------------------------------------------------------------------
// PRE-1C-VERIFY (4) — nonce read-and-unlink.
// ---------------------------------------------------------------------------

// readAndUnlinkNonce(stateDir, dispatchId) -> string, throws when absent.
// Unlink runs in a finally so a partial/failed read still consumes the
// sidecar (Rider E: the nonce's confidentiality is bounded by lifetime, not
// location — read and unlink as early as possible, never re-derived).
function readAndUnlinkNonce(stateDir, dispatchId) {
  const noncePath = join(stateDir, `${dispatchId}.nonce`)
  let nonce = null
  let readErr = null
  try {
    nonce = readFileSync(noncePath, 'utf8').trim()
  } catch (err) {
    readErr = err
  } finally {
    try {
      unlinkSync(noncePath)
    } catch {
      // Already gone, or never existed — nothing left to consume.
    }
  }
  if (readErr || !nonce) {
    throw new Error(`nonce sidecar absent or empty: ${noncePath}`)
  }
  return nonce
}

// ---------------------------------------------------------------------------
// EXECUTION — env/argv composition and the step-5 sweep.
// ---------------------------------------------------------------------------

// composeEnv(record) -> object. process.env with every DEVTEAM_ key
// stripped, then exactly the eight record.env pairs overlaid.
function composeEnv(record) {
  const base = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/^DEVTEAM_/.test(key)) continue
    base[key] = value
  }
  return { ...base, ...record.env }
}

// sweepForNonce(argv, env, nonce) -> void, throws before any spawn on a hit.
// `nonce` is null in DRY-RUN (which never reads it) — that mode sweeps for
// NONCE_PREFIX only, never a value it does not have.
function sweepForNonce(argv, env, nonce) {
  const argvBlob = argv.join('\0')
  const envBlob = Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\0')
  if (argvBlob.includes(NONCE_PREFIX) || envBlob.includes(NONCE_PREFIX)) {
    throw new Error('nonce sweep: composed argv/env contains the completion-nonce prefix')
  }
  if (nonce && (argvBlob.includes(nonce) || envBlob.includes(nonce))) {
    throw new Error('nonce sweep: composed argv/env contains the nonce value')
  }
}

// buildNoReturnReason(fsState, fresh, validation) -> string. Reports only
// the first violation's KEYWORD (e.g. 'schema_violation'), never any
// message text derived from the return body itself — this is, incidentally,
// already immune to an MF5-style fence-poisoning attempt (a worker crafting
// its return body to inject fence-breaking bytes into the composed reason)
// since violations[0].keyword is always one of a small fixed enum
// ladder.mjs/return-lint.mjs define, never free text sourced from the
// return body under inspection.
function buildNoReturnReason(fsState, fresh, validation) {
  if (validation.violations.length > 0) return validation.violations[0].keyword
  if (!fresh) return 'stale_or_absent_return'
  return 'no_valid_return'
}

// ---------------------------------------------------------------------------
// DRY-RUN — steps 1-3 only; never reads/unlinks the nonce, never spawns,
// never writes a return or a sentinel.
// ---------------------------------------------------------------------------

function runDryRun(record) {
  try {
    verifyRolePromptHash(record)
    verifySnapshotInventory(record)
    if (!isExistingDirectory(record.cwd)) {
      throw new Error(`record.cwd is not an existing directory: ${record.cwd}`)
    }
    const argv = buildArgv(record)
    sweepForNonce(argv, record.env, null)
    process.stdout.write(`${JSON.stringify({ argv, cwd: record.cwd, env: record.env })}\n`)
    return EXIT_OK
  } catch (err) {
    process.stderr.write(`adapter-claude: dry-run refused: ${err.message}\n`)
    return EXIT_REFUSAL
  }
}

// ---------------------------------------------------------------------------
// run — the verified (non-dry-run) flow. record has already passed
// dispatch-record.schema.json (PRE-1C-VERIFY (1)) by the time this runs.
// ---------------------------------------------------------------------------

function runVerified(record) {
  if (process.env.DEVTEAM_ADAPTER_DRY_RUN === '1') {
    return runDryRun(record)
  }

  const stateDir = dirname(record.env.DEVTEAM_GATE_COUNTER)
  const logger = makeLogger(stateDir, record.dispatch_id)
  armSentinel(stateDir, record.dispatch_id)
  logger.log(`dispatch ${record.dispatch_id} role=${record.role} attempt=${record.attempt} starting`)

  let env
  let argv
  try {
    // SF8: the nonce is read-and-unlinked FIRST, before any other
    // precondition — Rider E's "read and unlink as early as possible" bounds
    // the sidecar's lifetime by the read itself, not by how far verification
    // happens to get. This way the sidecar is already consumed even when a
    // later precondition (hash/inventory) goes on to refuse.
    const nonce = readAndUnlinkNonce(stateDir, record.dispatch_id)
    setSentinelNonce(nonce)
    verifyRolePromptHash(record)
    verifySnapshotInventory(record)
    if (!isExistingDirectory(record.cwd)) {
      throw new Error(`record.cwd is not an existing directory: ${record.cwd}`)
    }
    env = composeEnv(record)
    argv = buildArgv(record)
    sweepForNonce(argv, env, nonce)
  } catch (err) {
    logger.log(`refused: ${err.message}`)
    // MF6: writeBlockedReturn (fix-1c-04) now THROWS on an out-of-task-dir
    // return_path, and any writer can throw on EACCES/ENOSPC — wrapped so
    // neither ever escapes past main() into the bare process.exit at the
    // bottom of this module (which would record sentinel 1 via an uncaught
    // exception and mask a refusal as no_return).
    try {
      writeBlockedReturn(record, `${err.message} — see ${logger.logPath}`)
    } catch {
      // Even output 1 cannot always be guaranteed if return_path's own
      // directory is unwritable — this never throws out of a refusal.
    }
    return holdPaneIfNeeded(EXIT_REFUSAL)
  }

  logger.log(`spawning agent CLI with ${argv.length} argv element(s)`)
  const spawnResult = spawnSync(CLAUDE_BIN, argv, { stdio: 'inherit', env, cwd: record.cwd })

  if (spawnResult.error && spawnResult.error.code === 'ENOENT') {
    logger.log('agent CLI not found on PATH')
    try {
      writeBlockedReturn(record, 'agent CLI claude not found on PATH')
    } catch {
      // best-effort — see the refusal catch above.
    }
    return holdPaneIfNeeded(EXIT_CLI_MISSING)
  }
  if (spawnResult.error) {
    logger.log(`spawn failed: ${spawnResult.error.message}`)
    try {
      writeBlockedReturn(record, `spawn failed: ${spawnResult.error.message} — see ${logger.logPath}`)
    } catch {
      // best-effort — see the refusal catch above.
    }
    return holdPaneIfNeeded(EXIT_REFUSAL)
  }

  const claudeExitCode = spawnResult.status
  logger.log(`agent CLI exited with code ${claudeExitCode}`)

  const fsState = collectFsState({ record, paths: {} })
  const fresh = isFresh(record, fsState.returnStat)
  const validation = validateReturn(record, fsState.returnText)
  const returnOk = fresh && validation.ok

  if (!returnOk) {
    const reason = buildNoReturnReason(fsState, fresh, validation)
    logger.log(`no fresh valid return: ${reason}`)
    // writeBlockedReturn can throw (MF3 containment refusal, or EACCES/ENOSPC
    // on the return dir); a throw here must not skip the pane hold or dump a
    // raw stack trace. The exit code is unchanged either way.
    try {
      writeBlockedReturn(record, `${reason} — see ${logger.logPath}`)
    } catch (err) {
      logger.log(`writeBlockedReturn failed on the no-return path: ${err.message}`)
    }
    return holdPaneIfNeeded(EXIT_NO_RETURN)
  }

  const finalCode = claudeExitCode === 0 ? EXIT_OK : EXIT_NO_RETURN
  if (finalCode !== EXIT_OK) {
    logger.log(`agent CLI exited nonzero (${claudeExitCode}) despite a fresh valid return`)
  }
  return holdPaneIfNeeded(finalCode)
}

// ---------------------------------------------------------------------------
// The salvage path — PRE-1C-VERIFY (1)'s only documented exception. A record
// that parses as JSON but fails dispatch-record.schema.json is salvaged when
// dispatch_id, return_path and env.DEVTEAM_GATE_COUNTER EACH independently
// match their own frozen schema pattern; otherwise no path is known at all
// and the adapter exits 2 with stderr only (outputs 1-2 are structurally
// impossible in that one case).
// ---------------------------------------------------------------------------

function readAndUnlinkNonceBestEffort(stateDir, dispatchId) {
  const noncePath = join(stateDir, `${dispatchId}.nonce`)
  let nonce = null
  try {
    nonce = readFileSync(noncePath, 'utf8').trim()
  } catch {
    nonce = null
  } finally {
    try {
      unlinkSync(noncePath)
    } catch {
      // best-effort
    }
  }
  return nonce || null
}

function writeSalvageBlockedReturn(returnPath, dispatchId, parsed, reason) {
  const envelope = {
    schema_version: 1,
    dispatch_id: dispatchId,
    slice_id: typeof parsed.slice_id === 'string' ? parsed.slice_id : 'unknown',
    attempt: Number.isInteger(parsed.attempt) ? parsed.attempt : 1,
    role: typeof parsed.role === 'string' ? parsed.role : 'unknown',
    produced_at: new Date().toISOString(),
    body: { status: 'blocked', reason },
  }
  try {
    writeAtomicBytes(returnPath, `${JSON.stringify(envelope, null, 2)}\n`)
  } catch {
    // Even output 1 cannot always be guaranteed if return_path's own
    // directory is unwritable — this never throws out of a refusal.
  }
}

function salvageAndRefuse(parsed, violations) {
  const dispatchIdPattern = new RegExp(DISPATCH_RECORD_SCHEMA.properties.dispatch_id.pattern)
  const returnPathPattern = new RegExp(DISPATCH_RECORD_SCHEMA.properties.return_path.pattern)
  const gateCounterPattern = new RegExp(DISPATCH_RECORD_SCHEMA.properties.env.properties.DEVTEAM_GATE_COUNTER.pattern)
  const taskDirPattern = new RegExp(DISPATCH_RECORD_SCHEMA.properties.task_dir.pattern)

  const dispatchId = parsed && typeof parsed.dispatch_id === 'string' ? parsed.dispatch_id : null
  const returnPath = parsed && typeof parsed.return_path === 'string' ? parsed.return_path : null
  const gateCounter = parsed && parsed.env && typeof parsed.env.DEVTEAM_GATE_COUNTER === 'string' ? parsed.env.DEVTEAM_GATE_COUNTER : null
  const taskDir = parsed && typeof parsed.task_dir === 'string' ? parsed.task_dir : null

  const salvageable = Boolean(
    dispatchId && returnPath && gateCounter
    && dispatchIdPattern.test(dispatchId) && returnPathPattern.test(returnPath) && gateCounterPattern.test(gateCounter),
  )

  const detail = violations.map((v) => `${v.path} (${v.keyword})`).join(', ')
  const reason = `record fails dispatch-record.schema.json: ${detail}`

  if (!salvageable) {
    process.stderr.write(`adapter-claude: refused — ${reason} (no salvageable paths)\n`)
    return holdPaneIfNeeded(EXIT_REFUSAL)
  }

  const stateDir = dirname(gateCounter)
  const nonce = readAndUnlinkNonceBestEffort(stateDir, dispatchId)
  armSentinel(stateDir, dispatchId)
  setSentinelNonce(nonce)

  // MF3-salvage: a task_dir that is itself present and pattern-valid gives
  // this salvage path a real containment boundary to check the salvaged
  // return_path against — mirroring writeBlockedReturn's own
  // assertReturnPathWithinTaskDir (return-lint.mjs), inlined here rather
  // than imported since this path deliberately never trusts the record
  // enough to hand it to that function. A missing/invalid task_dir leaves
  // no boundary to check against, so the envelope write proceeds exactly as
  // before — the schema-pattern checks above are the only gate in that
  // case.
  const returnPathWithinTaskDir = !(taskDir && taskDirPattern.test(taskDir))
    || (() => {
      const base = resolvePath(taskDir)
      const candidate = resolvePath(returnPath)
      return candidate === base || candidate.startsWith(`${base}/`)
    })()

  if (returnPathWithinTaskDir) {
    writeSalvageBlockedReturn(returnPath, dispatchId, parsed, reason)
  }
  process.stderr.write(`adapter-claude: refused — ${reason}\n`)
  return holdPaneIfNeeded(EXIT_REFUSAL)
}

// ---------------------------------------------------------------------------
// run <record-path>
// ---------------------------------------------------------------------------

function cmdRun(recordPathArg) {
  const recordPath = resolvePath(recordPathArg)
  let rawText
  try {
    rawText = readFileSync(recordPath, 'utf8')
  } catch (err) {
    process.stderr.write(`adapter-claude: cannot read record at ${recordPath}: ${err.message}\n`)
    return EXIT_REFUSAL
  }

  let parsed
  try {
    parsed = JSON.parse(rawText)
  } catch (err) {
    // The single case where outputs 1-2 are structurally impossible: no
    // dispatch_id/return_path/env is even parseable, so no path is known.
    process.stderr.write(`adapter-claude: record at ${recordPath} is not valid JSON: ${err.message}\n`)
    return EXIT_REFUSAL
  }

  const violations = validate(DISPATCH_RECORD_SCHEMA, parsed)
  if (violations.length > 0) {
    return salvageAndRefuse(parsed, violations)
  }

  return runVerified(parsed)
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function main(argv) {
  const verb = argv[0]
  if (verb === 'capabilities') {
    if (argv.length !== 1) return usage('capabilities takes no arguments')
    return cmdCapabilities()
  }
  if (verb === 'run') {
    if (argv.length !== 2) return usage('run requires exactly one <record-path> argument')
    return cmdRun(argv[1])
  }
  return usage(`unknown verb: ${JSON.stringify(verb)}`)
}

// realpathOr(path) -> string — realpath both sides of the direct-invocation
// check: the ESM loader realpaths import.meta.url while argv[1] stays
// literal, so under a symlinked path component (macOS TMPDIR is /var ->
// /private/var) a literal compare is silently false and the CLI no-ops
// (return-lint.mjs's realpathOr, mirrored exactly here).
function realpathOr(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolvePath(path)
  }
}
const invokedDirectly = process.argv[1] && realpathOr(process.argv[1]) === realpathOr(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)))
}
