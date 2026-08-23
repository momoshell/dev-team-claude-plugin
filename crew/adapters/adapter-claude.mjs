import { readFileSync as fsReadFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PANE_USAGE_SETTINGS = fileURLToPath(new URL('./claude-usage.settings.json', import.meta.url))

// crew/adapters/adapter-claude.mjs — the claude agent adapter.
//
// An adapter is the seam between a crew seat and the CLI agent that fills it:
// `capabilitiesFor(...)` resolves one frozen profile per (adapter, transport)
// pair, and `seatCommand(...)` composes the pane's command line. crew.mjs resolves the
// adapter by seat.agent (default 'claude', overridable via --agent-<role>)
// and never builds the invocation itself — that composition lives here.
//
// seatCommand's output is no longer byte-identical to the pre-refactor
// paneCommand() in crew.mjs: the per-seat usage settings path is required for
// pane usage measurement (#492). Any change to the string below is a behavior
// change, not a refactor.
const INVARIANT = Object.freeze({
  prompt_file: true, tool_deny: true, unattended: true,
  // The Task tool is available in every claude transport; the seats that need
  // fan-out discovery carry it in their allowlist (crew.mjs SEAT_DEFAULTS).
  subagents: true,
  // claude --effort <low|medium|high|xhigh|max> (verified against the
  // installed CLI 2026-08-13) — the roster's effort dimension is enforceable.
  effort: true,
  // The claude CLI takes a full model id and has no checkout-pinned
  // provider-config seam, so a local-provider cell cannot be honoured here.
  local_provider: false,
})

const PROFILES = Object.freeze({
  pane: Object.freeze({
    // ADR-029 §3:52 — pane stdin is not a supported mid-turn channel.
    interjection: 'none',
    // ADR-029 §3:54 — pane owns no process handle for an abort.
    abort: 'none',
    // ADR-029 §3:54 — pane command passes no --session-id.
    session_resume: false,
    // ADR-029 §3:54 — pane has no client-resumable observation cursor.
    durable_cursor: 'none',
    // #131 — drive.mjs bounce paths reassign a settled pane seat.
    reassign: true,
  }),
  'headless-json': Object.freeze({
    // ADR-029 §3:52 — text stdin is read to EOF before the turn.
    interjection: 'turn',
    // ADR-029 §3:53 — supervisor signal is the supported abort mechanism.
    abort: 'signal',
    // ADR-029 §3:54 — the headless session persists for a later invocation.
    session_resume: true,
    // ADR-029 §3:54 — claude's session file is not a durable cursor.
    durable_cursor: 'none',
    // #131 — no capture establishes reassign for headless-json.
    reassign: false,
  }),
})

export function capabilitiesFor({ transport, grants } = {}) {
  const p = PROFILES[transport]
  if (!p) throw new Error(`adapter-claude: no capability profile for transport "${transport}" (shipped: ${Object.keys(PROFILES).join(', ')}) — refusing a guessed passthrough`)
  return Object.freeze({ ...INVARIANT, ...p })
}

const NO_GRANTS = Object.freeze({ tools: [], extensions: [], agents: [], skills: [], advisor: false })

function allowedTools(tools, grants = NO_GRANTS) {
  return [...new Set([...String(tools || '').split(','), ...(grants?.tools || [])].filter(Boolean))].join(',')
}

function assertSupportedGrants(grants = NO_GRANTS) {
  if ((grants?.extensions?.length ?? 0) > 0 || (grants?.skills?.length ?? 0) > 0) {
    throw Object.assign(
      new Error(`adapter-claude cannot express extension/skill grants ${JSON.stringify({ extensions: grants.extensions, skills: grants.skills })} — refusing to boot a silently weaker seat [grant-unsupported]`),
      { reason: 'grant-unsupported' },
    )
  }
}

function assertNoLocalProvider(configDir) {
  if (configDir !== null && configDir !== undefined) {
    throw Object.assign(
      new Error(`adapter-claude cannot express local-provider configDir ${JSON.stringify(configDir)} — refusing to boot a silently weaker seat [grant-unsupported]`),
      { reason: 'grant-unsupported' },
    )
  }
}

// The claude CLI accepts full model ids, so the roster's {provider,id} pair
// needs no namespace prefix — the id IS the CLI's namespace.
export function modelString({ provider, id, localProviders }) {
  if (localProviders && typeof localProviders === 'object' && Object.hasOwn(localProviders, provider)) {
    throw Object.assign(
      new Error(`adapter-claude cannot express local provider ${JSON.stringify(provider)} — refusing to boot a silently weaker seat [grant-unsupported]`),
      { reason: 'grant-unsupported' },
    )
  }
  return id
}

// The headless-json invocation shape. Returns ARGV (never a shell string):
// crew never assembles agent flags, and argv sidesteps quoting entirely.
// --verbose accompanies --output-format stream-json in every HW-1 capture.
// resume=false CREATES the session (--session-id); resume=true CONTINUES it
// (--resume).
export function headlessCommand({ role, model, promptFile, tools, deny, taskDir,
                                  prompt, sessionId, resume = false, bin, effort, grants = NO_GRANTS, configDir = null }) {
  assertSupportedGrants(grants)
  assertNoLocalProvider(configDir)
  if (!bin || !bin.startsWith('/')) throw new Error(`adapter-claude.headlessCommand: bin must be an ABSOLUTE frozen worker binary path, got ${JSON.stringify(bin)} — refusing to inherit whatever PATH resolves`)
  if (!sessionId) throw new Error('adapter-claude.headlessCommand: sessionId is required (one session per seat)')
  return {
    bin,
    args: [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--model', model,
      '--permission-mode', 'bypassPermissions',
      ...(effort ? ['--effort', effort] : []),
      '--allowedTools', allowedTools(tools, grants),
      '--disallowedTools', deny,
      '--append-system-prompt-file', promptFile,
      ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]),
    ],
    env: { DEVTEAM_WORKER: '1', CREW_ROLE: role, CREW_TASK_DIR: taskDir },
  }
}

export function seatCommand({ role, model, promptFile, tools, deny, taskDir, bootBrief, effort, grants = NO_GRANTS, configDir = null }) {
  assertSupportedGrants(grants)
  assertNoLocalProvider(configDir)
  // `env` (a real binary) sets the vars regardless of how cmux runs the
  // command. DEVTEAM_WORKER=1 keeps any installed dev-team plugin hooks
  // quiet inside the pane (defensive; a no-op when the plugin is absent).
  // bypassPermissions: crew seats run unattended (no human at their pane to
  // approve). The ENFORCED tool boundary is --disallowedTools (it holds even
  // under bypass; --allowedTools is only an auto-approve list and is inert
  // here) — beyond that, containment is the git scope gate, the feature-
  // branch blast radius, and the operator's global deny rules.
  // effort is OPTIONAL: absent, the command stays byte-identical to the
  // pre-effort adapter (the compatibility pin in crew.test.mjs holds).
  return [
    'env', 'DEVTEAM_WORKER=1', `CREW_ROLE=${role}`, `CREW_TASK_DIR="${taskDir}"`,
    'claude', '--model', model, '--permission-mode', 'bypassPermissions',
    '--settings', `"${PANE_USAGE_SETTINGS}"`,
    ...(effort ? ['--effort', `"${effort}"`] : []),
    '--allowedTools', `"${allowedTools(tools, grants)}"`,
    '--disallowedTools', `"${deny}"`,
    '--append-system-prompt-file', `"${promptFile}"`,
    `"${bootBrief}"`,
  ].join(' ')
}

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function paneUsageRecords({ taskDir, role, deps = {} } = {}) {
  if (typeof taskDir !== 'string' || typeof role !== 'string') return []
  let raw
  try {
    const readFileSync = deps.readFileSync ?? fsReadFileSync
    raw = readFileSync(join(taskDir, 'usage', `${role}.jsonl`), 'utf8')
  } catch {
    return []
  }
  let lines
  try { lines = String(raw).split(/\r?\n/) } catch { return [] }
  const records = []
  const seen = new Set()
  for (const line of lines) {
    if (!line.trim()) continue
    let payload
    try { payload = JSON.parse(line) } catch { continue }
    const sessionId = payload && typeof payload === 'object' ? payload.session_id : null
    const transcriptPath = payload && typeof payload === 'object' ? payload.transcript_path : null
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) continue
    if (typeof transcriptPath !== 'string' || !transcriptPath.startsWith('/') || !transcriptPath.endsWith('.jsonl')) continue
    if (seen.has(sessionId)) continue
    seen.add(sessionId)
    records.push({ session_id: sessionId, transcript_path: transcriptPath })
  }
  return records
}
