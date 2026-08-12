#!/usr/bin/env node
// Orchestrator-side PreToolUse substrate guard (be-78-02). Fires on every
// Agent-tool dispatch; denies a MAIN-THREAD dispatch of a dev-team: role
// that is both pane-enabled in the merged roster AND rollout-listed in
// the rollout-listed pane roles, when the session's execution mode resolves to cmux — the
// exact admission conjunction scripts/cmux/dispatch.mjs:1507-1514 applies,
// mirrored here so the two paths never disagree about which door is open.
//
// FAIL-OPEN BY CONSTRUCTION (ADR-028, proposed): this file never forces a
// non-zero process exit and never emits permissionDecision "allow" — policy is
// expressed ONLY as exit-0 JSON carrying permissionDecision "deny". Every
// branch that cannot establish positive evidence for a deny falls through
// to allow, including the outer catch. Do not harden any allow branch into
// a deny — an input this spec allows stays allowed.
//
// NO ENTRYPOINT GUARD: main() below runs unconditionally at module load. Do
// not wrap it in an `import.meta.url === pathToFileURL(process.argv[1]).href`
// idiom — if that comparison ever mismatches in production (a symlinked
// plugin path, a cache path resolution) the guard would become silently
// inert, which is the exact risk this file exists to close. Tests spawn
// this file as a subprocess rather than importing it.
import {
  readSync, appendFileSync, mkdirSync, statSync, openSync, closeSync,
} from 'node:fs'
import { isAbsolute, join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { resolveExecutionMode, readDevTeamConfigText } from '../scripts/execution-mode.mjs'
import { loadRoster } from '../scripts/cmux/resolve.mjs'
import { PANE_ROLES } from '../scripts/cmux/contract.mjs'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const TOOL_NAME = 'Agent'
const DEV_TEAM_PREFIX = 'dev-team:'
const SUBAGENT_TYPE_SHAPE_RE = /^[A-Za-z0-9_:-]+$/
const ROLE_REMAINDER_RE = /^[A-Za-z0-9_-]{1,64}$/
const MAX_SUBAGENT_TYPE_LEN = 128
const MAX_STDIN_BYTES = 256 * 1024
const LOG_CEILING_BYTES = 32 * 1024 * 1024

// Frozen vocabulary (AC7), in evaluation order. worker_env is deliberately
// absent: the DEVTEAM_WORKER path writes no log line at all, so a code for
// it would be dead vocabulary.
export const REASON_CODES = Object.freeze([
  'bad_stdin', 'oversize_stdin', 'wrong_tool', 'nested_call', 'bad_subagent_type',
  'not_dev_team', 'bad_cwd', 'unknown_role', 'pane_false', 'not_pane_rollout',
  'mode_not_cmux', 'mode_error', 'roster_error', 'internal_error',
  'node_unresolved', 'log_ceiling_reached', 'denied',
])

const LOG_PATH = join(homedir(), '.dev-team', 'guard', 'dispatch-guard.jsonl')

const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/g

function stripControlChars(s) {
  return String(s).replace(CONTROL_CHAR_RE, '')
}

function capField(value, max) {
  return stripControlChars(value).slice(0, max)
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function nowIso() {
  return new Date().toISOString()
}

// Bounded stdin read: a 256 KiB + 1 buffer, stop the moment it is full.
// Deliberately NOT readFileSync(0) — an unbounded read against a hostile or
// misbehaving caller is the oversize_stdin hazard this closes.
function readStdinBounded(maxBytes) {
  const buf = Buffer.alloc(maxBytes + 1)
  let total = 0
  try {
    while (total < buf.length) {
      const n = readSync(0, buf, total, buf.length - total, null)
      if (n === 0) break
      total += n
    }
  } catch {
    // Treat any stdin read failure as end-of-input; JSON.parse on whatever
    // was collected will fail closed to bad_stdin.
  }
  return { buf, total, truncated: total >= buf.length }
}

function baseResult(decision, reasonCode, fields = {}) {
  return {
    decision,
    reason_code: reasonCode,
    tool_name: fields.tool_name ?? null,
    role: fields.role ?? null,
    mode: fields.mode ?? null,
    mode_source: fields.mode_source ?? null,
    cwd: fields.cwd ?? null,
    session_id: fields.session_id ?? null,
  }
}

// evaluate() -> decision result. Steps 2-10 of the evaluation order
// (discovery_context); each expected-throw point (JSON.parse,
// resolveExecutionMode, loadRoster) is caught locally so its own reason
// code survives — only a genuinely unexpected exception reaches main()'s
// outer catch as internal_error.
function evaluate() {
  const { buf, total, truncated } = readStdinBounded(MAX_STDIN_BYTES)
  if (truncated) {
    return baseResult('allow', 'oversize_stdin')
  }

  let input
  try {
    input = JSON.parse(buf.subarray(0, total).toString('utf8'))
  } catch {
    return baseResult('allow', 'bad_stdin')
  }
  if (!isPlainObject(input)) {
    return baseResult('allow', 'bad_stdin')
  }

  const toolName = typeof input.tool_name === 'string' ? capField(input.tool_name, 64) : null
  const sessionId = typeof input.session_id === 'string' ? capField(input.session_id, 128) : null

  if (input.tool_name !== TOOL_NAME) {
    return baseResult('allow', 'wrong_tool', { tool_name: toolName, session_id: sessionId })
  }
  if (Object.prototype.hasOwnProperty.call(input, 'agent_id') || Object.prototype.hasOwnProperty.call(input, 'agent_type')) {
    return baseResult('allow', 'nested_call', { tool_name: toolName, session_id: sessionId })
  }

  const subagentType = isPlainObject(input.tool_input) ? input.tool_input.subagent_type : undefined
  if (
    typeof subagentType !== 'string'
    || subagentType.length > MAX_SUBAGENT_TYPE_LEN
    || !SUBAGENT_TYPE_SHAPE_RE.test(subagentType)
  ) {
    return baseResult('allow', 'bad_subagent_type', { tool_name: toolName, session_id: sessionId })
  }
  if (!subagentType.startsWith(DEV_TEAM_PREFIX)) {
    return baseResult('allow', 'not_dev_team', { tool_name: toolName, session_id: sessionId })
  }
  const roleCandidate = subagentType.slice(DEV_TEAM_PREFIX.length)
  if (!ROLE_REMAINDER_RE.test(roleCandidate)) {
    return baseResult('allow', 'bad_subagent_type', { tool_name: toolName, session_id: sessionId })
  }
  const role = roleCandidate

  if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd)) {
    return baseResult('allow', 'bad_cwd', { tool_name: toolName, session_id: sessionId, role })
  }
  const cwd = capField(input.cwd, 512)

  let modeResult
  try {
    modeResult = resolveExecutionMode({
      projectConfigText: readDevTeamConfigText(input.cwd),
      homeConfigText: readDevTeamConfigText(homedir()),
    })
  } catch {
    return baseResult('allow', 'mode_error', { tool_name: toolName, session_id: sessionId, role, cwd })
  }
  if (modeResult.mode !== 'cmux') {
    return baseResult('allow', 'mode_not_cmux', {
      tool_name: toolName, session_id: sessionId, role, cwd, mode: modeResult.mode, mode_source: modeResult.source,
    })
  }

  let loaded
  try {
    // session: null — deliberate. The session layer is delivered only as
    // the `session` key of dispatch.mjs's --config sidecar and is
    // unreachable from a hook, so the guard sees 3 of the roster's 4
    // layers, never 4.
    loaded = loadRoster({ pluginRoot: PLUGIN_ROOT, home: homedir(), primaryCheckout: input.cwd, session: null })
  } catch {
    return baseResult('allow', 'roster_error', {
      tool_name: toolName, session_id: sessionId, role, cwd, mode: modeResult.mode, mode_source: modeResult.source,
    })
  }

  const common = {
    tool_name: toolName, session_id: sessionId, role, cwd, mode: modeResult.mode, mode_source: modeResult.source,
  }
  // hasOwnProperty (not a bare index): a role literally named __proto__ /
  // constructor / toString would otherwise resolve an INHERITED Object member
  // (truthy) and skip the unknown_role branch — decision stays allow either
  // way, but the reason_code would mislabel as pane_false (lens A, 2026-08-12).
  const roleEntry = isPlainObject(loaded.roster.roles)
    && Object.prototype.hasOwnProperty.call(loaded.roster.roles, role)
    ? loaded.roster.roles[role] : undefined
  if (!roleEntry) {
    return baseResult('allow', 'unknown_role', common)
  }
  // The first conjunct reads the MERGED roster's pane property; the rollout
  // list appears ONLY beside that read, in the same boolean expression,
  // never as a standalone membership test (conventions.md 2026-08-08: a
  // permission gate keyed on a config value's NAME rather than the GRANT it
  // resolves to is fail-open the moment that config is user-overridable).
  const paneEnabled = roleEntry.pane === true
  const rolloutListed = PANE_ROLES.includes(role)
  if (!paneEnabled || !rolloutListed) {
    return baseResult('allow', paneEnabled ? 'not_pane_rollout' : 'pane_false', common)
  }

  return baseResult('deny', 'denied', common)
}

// buildDenyReason(role, source) -> the permissionDecisionReason template.
// Only two values are interpolated (the validated role token and source, a
// MODE_SOURCES member); both are control-char-stripped and length-capped
// before interpolation.
export function buildDenyReason(role, source) {
  const safeRole = capField(role, 64)
  const safeSource = capField(source, 32)
  return [
    `dev-team: Agent-tool dispatch of dev-team:${safeRole} denied — execution mode is cmux (source: ${safeSource}), and this role is pane-enabled in that mode.`,
    `Corrective path: first bind a task workspace (dispatch.mjs workspace); then place the slice spec at the canonical path dispatch.mjs derives for that slice — the --spec value must be byte-exactly that path and the file must already exist; then run dispatch.mjs dispatch --slice <id> --role ${safeRole} --spec <that path>; then join with await --all. Read the cmux dispatch reference first.`,
    'this call will be denied identically on every retry, do not retry it — use the command above, or switch substrate with /dev-team:team mode agent-tool',
    'Scope: Explore and pane:false roles (code-reviewer, code-reviewer-deep, build-validator, test-engineer, doc-writer) are unaffected.',
  ].join(' ')
}

function buildDenySystemMessage(role) {
  const safeRole = capField(role, 64)
  return `dev-team: Agent-tool dispatch of dev-team:${safeRole} denied (substrate is cmux) — see permissionDecisionReason for the required command.`
}

function emit(result) {
  if (result.decision !== 'deny') {
    process.stdout.write('')
    return
  }
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: buildDenyReason(result.role, result.mode_source),
    },
    systemMessage: buildDenySystemMessage(result.role),
  }
  process.stdout.write(JSON.stringify(payload))
}

// appendDecisionLog(line) — a write failure can NEVER alter the already-
// computed decision or exit code, so every failure mode here is swallowed.
function appendDecisionLog(line) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true })
    let size = 0
    try {
      size = statSync(LOG_PATH).size
    } catch {
      size = 0
    }
    if (size >= LOG_CEILING_BYTES) {
      let tail = ''
      try {
        const fd = openSync(LOG_PATH, 'r')
        const len = Math.min(256, size)
        const tailBuf = Buffer.alloc(len)
        readSync(fd, tailBuf, 0, len, size - len)
        closeSync(fd)
        tail = tailBuf.toString('utf8')
      } catch {
        tail = ''
      }
      if (!tail.includes('log_ceiling_reached')) {
        const marker = {
          ts: nowIso(), decision: 'none', reason_code: 'log_ceiling_reached',
          tool_name: null, role: null, mode: null, mode_source: null, cwd: null, session_id: null,
        }
        appendFileSync(LOG_PATH, `${JSON.stringify(marker)}\n`)
      }
      return
    }
    appendFileSync(LOG_PATH, `${JSON.stringify(line)}\n`)
  } catch {
    // Never let a logging failure surface — see the comment above.
  }
}

function main() {
  if (typeof process.env.DEVTEAM_WORKER === 'string' && process.env.DEVTEAM_WORKER.length > 0) {
    process.exitCode = 0
    return
  }

  let result
  try {
    result = evaluate()
  } catch {
    result = baseResult('allow', 'internal_error')
  }

  appendDecisionLog({
    ts: nowIso(),
    decision: result.decision,
    reason_code: result.reason_code,
    tool_name: result.tool_name,
    role: result.role,
    mode: result.mode,
    mode_source: result.mode_source,
    cwd: result.cwd,
    session_id: result.session_id,
  })

  emit(result)
  process.exitCode = 0
}

main()
