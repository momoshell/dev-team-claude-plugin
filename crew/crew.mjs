#!/usr/bin/env node
// crew/crew.mjs — crew v3: a self-contained team runtime (zero legacy
// dev-team imports). v3 inverts control: crew/drive.mjs (CODE) runs the
// task loop; the LEAD pane is a judge consulted only at decision points. One cmux workspace per task, booted in a single
// declarative call. A LEAD pane runs the task from inside the workspace —
// it drives the planner/builder/reviewer/tech-lead members, runs the
// validation lanes and the full suite, does the git scope check, and commits.
// The orchestrator (a separate session) does exactly three things: size the
// crew before boot, hand the task to the lead, and — on the lead's final
// envelope — push/PR and talk to the human. Task work never leaves the
// workspace.
//
// Verbs:
//   crew.mjs boot  --task <slug> [--roles lead,planner,builder,reviewer[,tech-lead]]
//                  [--checkout <dir>] [--model-<role> <id>] [--agent-<role> <name>]...
//                  [--headless-all] [--memory-dir <dir>] [--memory-backend <name>]
//                  [--memory-budget-bytes <n>] [--fences <register.json> --lane <name>]
//                  # paired: both or neither
//   crew.mjs run   --task <slug> --brief-file <path> [--variant <name>] [--files-in-scope <a,b>] # hand the task to the lead
//                  [--validation-lane <command>]  # the round validation lane;
//                  # bare --lane is the round validation lane; with --fences it names the fence-register lane
//                  [--plan-rounds <n>] [--build-rounds <n>] [--review-rounds <n>]
//                  [--wait-planner <s>] [--wait-tech-lead <s>] [--wait-builder <s>]
//                  [--wait-reviewer <s>] [--wait-lead <s>]
//                  # per-role seat wait budgets in seconds; an absent flag = drive.mjs WAITS_S
//                  # per-run round budgets; an absent flag = drive.mjs LIMITS
//                  variant names come from crew/drive.mjs's VARIANTS
//   crew.mjs handoff --task <slug> --brief-file <path> # hand the task to the LEAD
//   crew.mjs wait  --task <slug> [--timeout-s N]       # await the LEAD's envelope
//   crew.mjs status --task <slug>
//   crew.mjs teardown --task <slug>
// Each verb refuses a flag it does not read with exit 2; --fences is boot-only,
// and a bare --lane on run is the round validation lane.
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, writeSync,
} from 'node:fs'
import { join, dirname, resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { execSync } from 'node:child_process'

import { cmux, tree, sendLine, renameTab, closeSurface, closeWorkspace, logLine } from './driver.mjs'
import { slug } from './slug.mjs'
import { FINGERPRINT_FILE, fingerprintWithheld, recordTreeFingerprint } from './tree-fingerprint.mjs'
import { driveTask, LIMITS, VARIANTS, VARIANT_NAMES, DEFAULT_VARIANT, validateScopeEntries, WAITS_S, WAIT_FLAGS, resolveWaits, waitsCtx, waitsRecord, RUN_START_EVENT } from './drive.mjs'
import { TASK_PROFILES } from './task-profiles.mjs'
import { ASSURANCES, ASSURANCE_ALIASES, ASSURANCE_ALIAS_OF } from './assurances.mjs'
import { REQUEST_ALIASES, resolveRunConfiguration } from './run-configuration.mjs'
import { limitsCtx, limitsRecord, resolveLimits } from './limits.mjs'
import { reclaimStore } from './reclaim.mjs'
import {
  seatIo, settleSeatTeardown, paneTeardownRows, emitAdapter, saveCrew, resolveWorkerBin, paneAlive, settleSeatRoots, reclaimDescendants, DEFAULT_TRANSPORT, HEADLESS_TRANSPORT, HEADLESS_RPC_TRANSPORT,
} from './seat-io.mjs'
export {
  docOpenArgs, phaseForStage, emitAdapter, waitForEnvelope, resolveWorkerBin,
  DEFAULT_TRANSPORT, HEADLESS_TRANSPORT, HEADLESS_RPC_TRANSPORT, WAIT_POLL_MS, LIVENESS_PROBE_MS,
  LIVENESS_MISSES_TO_DIE,
} from './seat-io.mjs'
import { openRun, recordCellFailure } from '../scripts/factory/emit.mjs'
import { checkoutProtectedPaths } from '../scripts/factory/probe-repo.mjs'
import { gatherFences, laneFenceFor } from '../scripts/factory/make-brief.mjs'
import { REAP_VERDICTS, classifyRecord } from '../scripts/factory/reap-stale.mjs'
import { breakerPolicy, cellHealth, assertCellsClosed } from './breaker.mjs'
import { CELL_RATE_FLOOR, USAGE_ABSENT_CAUSES, escalationCause, openLedger as realOpenLedger } from '../scripts/factory/ledger.mjs'
import {
  DEFAULT_BACKEND, DEFAULT_BUDGET_BYTES, openMemory, renderSection,
} from './memory.mjs'
import {
  CAPABILITY_DELIVERY, EMPTY_GRANTS, assertGrantsBacked, effectiveCapabilities, grantsFor,
  loadCapabilities, refuse, REGISTER_ROOT, resolvedGrantPath, pathExists, pathMessage,
} from './capabilities.mjs'
export { CAPABILITY_DELIVERY, CAPABILITY_REFUSALS, EMPTY_GRANTS, assertGrantsBacked, effectiveCapabilities, grantsFor, loadCapabilities, refuse, validateCapabilities } from './capabilities.mjs'
import { completionLogPath } from './factoryctl.mjs'
import { hostLoad, loadPolicy, assertHostQuiet } from './host-load.mjs'
export { LOAD_ENV, hostLoad, loadPolicy, assertHostQuiet } from './host-load.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROLES_DIR = join(HERE, 'roles')
const SHARED_PROMPT = join(ROLES_DIR, '_shared.md')

export const HEADLESS_TRANSPORTS = Object.freeze([HEADLESS_TRANSPORT, HEADLESS_RPC_TRANSPORT])

// Per-seat defaults. Model is overridable per task (--model-<role>) so the
// orchestrator can size the crew: cheap seats for mechanical work, capable
// seats where judgment lives. Tools are role-scoped; the LEAD alone gets the
// integration surface (Bash for tests+git, no repo Edit — it verifies and
// commits, never authors source).
// `tools` is the seat's auto-approve surface (--allowedTools — inert under
// bypassPermissions, kept for any non-bypass relaunch). `deny` is the seat's
// ENFORCED tool boundary (--disallowedTools holds even under bypass): only
// the builder may Edit, only planner/reviewer may spawn subagents. Note Write
// stays available everywhere — every seat writes envelopes and task-dir
// artifacts — so the REPO boundary for non-builder seats is the git scope
// gate + commit-in-scope, not tool denial.
// `agent` names the adapter (crew/adapters/adapter-<name>.mjs) that fills
// the seat; overridable per task via --agent-<role>, default 'claude'.
// `requires` names the capability keys the charter depends on; a seat whose
// adapter cannot deliver one refuses to boot. The fan-out tool itself is a
// register-backed grant in crew/capabilities.json, not a hardcoded seat
// default. FANOUT_TOOLS is the deny-side set for seats that withhold fan-out.
// Only the PLANNER requires `subagents`, and the asymmetry is
// deliberate: its charter is "domain lead + architect + scout-commander", and
// fan-out discovery IS the third of those. The reviewer's charter — conformance
// to plan, then correctness, plus gate-defect triage and perspective duty —
// names no fan-out, and the roster deliberately seats pi/terra on review at
// `build`/`mechanical` under the ratified review-vendor rule. Requiring it
// there would make two of three tiers unbootable, which is how this landed the
// first time (#144).
// Every fan-out tool name, in ONE place. Task and Agent spawn subagents;
// Workflow fans out wider still — a script that spawns many seats at once —
// and no seat denied the first two was ever denied it. A seat that withholds
// fan-out withholds every name here, so a future fan-out tool is a single
// edit to this line rather than a hunt through per-role deny literals.
export const FANOUT_TOOLS = Object.freeze(['Task', 'Agent', 'Workflow'])
const NO_FANOUT = FANOUT_TOOLS.join(',')

export const SEAT_DEFAULTS = Object.freeze({
  lead: { model: 'opus', tools: 'Read,Glob,Grep,Bash,Write', deny: `Edit,NotebookEdit,${NO_FANOUT}`, requires: [], prompt: 'lead.md', agent: 'claude' },
  planner: { model: 'opus', tools: 'Read,Glob,Grep,Bash,Write', deny: 'Edit,NotebookEdit', requires: ['subagents'], prompt: 'planner.md', agent: 'claude' },
  builder: { model: 'sonnet', tools: 'Read,Edit,Write,Glob,Grep,Bash', deny: NO_FANOUT, requires: [], prompt: 'builder.md', agent: 'claude' },
  reviewer: { model: 'opus', tools: 'Read,Glob,Grep,Bash,Write', deny: 'Edit,NotebookEdit', requires: [], prompt: 'reviewer.md', agent: 'claude' },
  'tech-lead': { model: 'opus', tools: 'Read,Glob,Grep,Bash,Write', deny: `Edit,NotebookEdit,${NO_FANOUT}`, requires: [], prompt: 'tech-lead.md', agent: 'claude' },
})

// The seat's EFFECTIVE auto-approve allowlist: the seat default plus whatever
// the register granted, in that order (identical to adapter-claude's own
// allowedTools() merge, so the composed command is byte-unchanged).
// crew.json records THIS, not the bare default: crew/headless.mjs rebuilds a
// headless worker command from members.<role>.tools alone — grants never reach
// it — so recording the default would silently narrow every factory seat.
export function effectiveTools(role, grants = EMPTY_GRANTS) {
  return [...new Set([...String(SEAT_DEFAULTS[role].tools || '').split(','), ...(grants?.tools || [])].filter(Boolean))].join(',')
}

export const DEFAULT_ROLES = Object.freeze(['lead', 'planner', 'builder', 'reviewer'])
export const MEMORY_ROLES = Object.freeze(['lead', 'planner'])
// Canonical seating order — also layout order (index 0 takes the left half).
// Must stay key-identical to SEAT_DEFAULTS (pinned by a test).
export const ROLE_ORDER = Object.freeze(['lead', 'planner', 'builder', 'reviewer', 'tech-lead'])

// Every FANOUT_TOOLS name this role's seat default withholds. The deny string
// IS the seat's charter boundary, so this is the register-vs-charter comparison
// the boot refusal below makes.
export function deniedFanout(role) {
  const deny = String(SEAT_DEFAULTS[role]?.deny || '').split(',').map((name) => name.trim())
  return FANOUT_TOOLS.filter((tool) => deny.includes(tool))
}

// A register that grants fan-out to a seat whose defaults withhold it is a
// CONTRADICTION between runtime policy and the seat's charter, and it is refused
// at boot rather than resolved in the grant's favour. The deny boundary cannot
// backstop the grant: adapter-pi's translateDeny (crew/adapters/adapter-pi.mjs:109)
// maps every FANOUT_TOOLS name to nothing (PI_TOOL_NAMES, :95-98), so such a
// seat's whole fan-out denial translates to an EMPTY list and seatCommand omits
// --exclude-tools entirely — the grant would arrive with nothing ANDed after it.
// No shipped register grants agents to such a role today, so this is a boundary
// rather than a behaviour change, and capabilities.schema.json still permits the
// grant deliberately — which is exactly why boot has to be the one to refuse it.
export function assertFanoutCoherent(role, grants) {
  const denied = deniedFanout(role)
  if (!denied.length) return grants
  const agents = grants?.agents || []
  if (!agents.length) return grants
  throw refuse('grant-contradicts-deny',
    `seat ${role} is granted fan-out agents [${agents.map((a) => a.name).join(', ')}] by the runtime capability register, but seat ${role} defaults deny ${denied.join(',')} — refusing to boot a seat whose register contradicts its own charter boundary (drop roles.${role}.agents from crew/capabilities.json, or change the seat default that withholds fan-out)`)
}

export async function probeLocalEndpoint(url, { fetchFn = fetch, timeoutMs = 2000 } = {}) {
  try {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) })
    return response?.status < 500
  } catch {
    return false
  }
}

export const ADVISOR_CONFIG_VERSION = 1
export const ADVISOR_BOOT_REFUSALS = Object.freeze([
  'role-unsupported', 'adapter-unsupported', 'transport-unsupported',
  'endpoint-unset', 'endpoint-not-local', 'endpoint-credentials',
  'model-unset', 'model-unsafe', 'endpoint-dead',
])
export const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/

export function classifyAdvisorCell({ endpoint, model } = {}) {
  if (typeof endpoint !== 'string' || endpoint === '') return { reason: 'endpoint-unset' }
  let parsed
  try { parsed = new URL(endpoint) } catch { return { reason: 'endpoint-not-local' } }
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^\/?#]*)/.exec(endpoint)?.[1] || ''
  const hostText = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority
  const rawHost = hostText.startsWith('[') ? hostText.slice(0, hostText.indexOf(']') + 1) : hostText.split(':')[0]
  // #809 (TRD docs/trd-local-models.md §1 fact 2, §4 L1): the advisor endpoint's
  // HOST is not part of the safety boundary — a model served from the operator's
  // second desktop over the LAN is as admissible as one on the local machine. What stays
  // closed is WHAT may be reached: http(s) only, no credentials in the URL, a
  // SAFE_MODEL id — and the authority has to exist at all. The reason token stays
  // `endpoint-not-local` because ADVISOR_BOOT_REFUSALS is a frozen closed
  // vocabulary and crew/pi/extensions/advisor.ts:538 keeps its own copy of this
  // classifier; renaming it here would split the two.
  if (!['http:', 'https:'].includes(parsed.protocol) || rawHost === '') {
    return { reason: 'endpoint-not-local' }
  }
  if (parsed.username || parsed.password) return { reason: 'endpoint-credentials' }
  if (typeof model !== 'string' || model === '') return { reason: 'model-unset' }
  if (!SAFE_MODEL.test(model)) return { reason: 'model-unsafe' }
  return { endpoint: parsed.href, model }
}

// The only endpoint facts a record may carry: host and port. Never a path, never a
// query, never userinfo — a record outlives the boot and a credential in one is a
// leak nobody revokes. Unknown is null, never a guess (#809).
export const ADVISOR_DEFAULT_PORTS = Object.freeze({ 'http:': 80, 'https:': 443 })
export function advisorEndpointOrigin(endpoint) {
  let parsed
  let rawEndpoint
  try { rawEndpoint = String(endpoint || ''); parsed = new URL(rawEndpoint) } catch { return null }
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^\/?#]*)/.exec(rawEndpoint)?.[1] || ''
  if (authority === '' || parsed.hostname === '') return null
  const port = parsed.port === '' ? (ADVISOR_DEFAULT_PORTS[parsed.protocol] ?? null) : Number(parsed.port)
  return { host: parsed.hostname, port }
}

// What a refusal is allowed to say about where it reached. A LAN box that is down
// must name itself in the message and in the ledger detail, and nothing else.
export function advisorEndpointLabel(endpoint) {
  const origin = advisorEndpointOrigin(endpoint)
  return origin ? `${origin.host}:${origin.port ?? 'unknown-port'}` : 'an unset or unparseable endpoint'
}

export function advisorBootRecord({ adapters = {}, env = process.env } = {}) {
  const granted = Object.keys(adapters).filter((role) => adapters[role]?.grants?.advisor === true).sort()
  const rawEndpoint = env?.CREW_ADVISOR_ENDPOINT
  const origin = advisorEndpointOrigin(rawEndpoint)
  let endpoint = rawEndpoint
  // Do not normalize an authority-less raw input into a host before preflight sees it.
  try { if (origin) endpoint = new URL(String(rawEndpoint || '')).href } catch { /* assertAdvisorCellLive gives the refusal */ }
  return {
    granted,
    endpoint,
    endpoint_host: origin?.host ?? null,
    endpoint_port: origin?.port ?? null,
    model: env?.CREW_ADVISOR_MODEL,
    config_version: ADVISOR_CONFIG_VERSION,
  }
}

// The projection the boot JOURNAL carries: host and port identify a dead LAN box,
// and dropping the rest keeps a path or a credential out of a file that outlives
// the boot. crew.json keeps the full record because paneCommand's advisorCell is
// built from it in the same process (#809).
export function advisorJournalRecord(record) {
  return {
    granted: record?.granted ?? [],
    endpoint_host: record?.endpoint_host ?? null,
    endpoint_port: record?.endpoint_port ?? null,
    model: record?.model ?? null,
    config_version: record?.config_version ?? null,
  }
}

function advisorRefusal(reason, role, record) {
  const where = advisorEndpointLabel(record?.endpoint)
  const fix = reason === 'adapter-unsupported'
    ? 'select --agent-builder pi'
    : reason === 'transport-unsupported'
      ? 'use a pane transport'
      : reason.startsWith('endpoint-') || reason.startsWith('model-')
        ? `point CREW_ADVISOR_ENDPOINT at an http(s) endpoint reachable from this machine (this boot reached for ${where}) and CREW_ADVISOR_MODEL at a safe model id`
        : 'use a register-granted builder advisor seat'
  return Object.assign(new Error(`advisor seat ${role} refuses to boot: ${reason} — ${fix}`), {
    reason, code: 'advisor-refusal', role, stage: reason === 'endpoint-dead' ? 'advisor-preflight' : undefined,
  })
}

export async function assertAdvisorCellLive({ record, adapters = {}, taskSlug, probeEndpoint = probeLocalEndpoint, note = noteRunlessCellFailure } = {}) {
  if (!record?.granted?.length) return
  for (const role of record.granted) {
    if (role !== 'builder') throw advisorRefusal('role-unsupported', role, record)
    const adapter = adapters[role]
    if (adapter?.name !== 'pi') throw advisorRefusal('adapter-unsupported', role, record)
    if (adapter?.transport !== DEFAULT_TRANSPORT) throw advisorRefusal('transport-unsupported', role, record)
    const cell = classifyAdvisorCell({ endpoint: record.endpoint, model: record.model })
    if (cell.reason) throw advisorRefusal(cell.reason, role, record)
    let advisorLive = false
    try { advisorLive = await probeEndpoint(record.endpoint) } catch { advisorLive = false }
    if (!advisorLive) {
      const err = advisorRefusal('endpoint-dead', role, record)
      try {
        note({ taskSlug, role, kind: 'boot-refusal', err,
          cell: { agent: 'advisor', provider: 'local', id: record.model,
            model: `local/${record.model}`, effort: null },
          member: { transport: 'local-http' } })
      } catch { /* instrumentation is never load-bearing */ }
      if (!advisorLive) throw advisorRefusal('endpoint-dead', role, record)
    }
  }
}

export function advisorManifest({ briefText, task, runStartedAt }) {
  const lines = String(briefText || '').split(/\r?\n/)
  const marker = lines.findIndex((line) => line.trim().toLowerCase() === 'tripwire tests:')
  if (marker < 0) return null
  const tripwires = []
  for (let i = marker + 1; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (/^broad keys\b/i.test(line)) break
    const match = /^-\s+(.+?)\s+·/.exec(line)
    if (match && match[1].trim()) tripwires.push(match[1].trim())
  }
  if (!tripwires.length) return null
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    task: String(task || ''),
    run_started_at: runStartedAt,
    tripwires,
  }
}

export function assertAdvisorManifest({ granted = [], manifest, written } = {}) {
  if (!granted.length) return
  if (!manifest || manifest.schema_version !== 1 || !Array.isArray(manifest.tripwires) || !manifest.tripwires.length || written !== true) {
    const err = new Error(`advisor manifest is unavailable for a granted run — refusing to start seats without the declared tripwire surface`)
    err.reason = 'advisor-manifest-unavailable'
    throw err
  }
}

// The rule itself lives in the leaf module `slug.mjs`, so daemon.mjs can share
// it without importing this file (which pulls in drive.mjs). Re-exported here
// because this module's own consumers already reach for it by this name.
export { slug }

function pathsFor(taskSlug, checkout) {
  const repo = slug(checkout.split('/').filter(Boolean).pop() || 'repo')
  const dir = join(homedir(), '.crew', repo, taskSlug)
  return { repo, dir, taskDir: join(dir, 'task'), returnsDir: join(dir, 'returns') }
}

function descendantStampStatus(taskDir, expected = 0) {
  const storeDir = join(taskDir, 'descendants')
  if (!existsSync(storeDir)) {
    return Number(expected) > 0
      ? { pending: null, error: new Error(`descendant stamp store disappeared after sweeping ${expected} record(s)`) }
      : { pending: 0, error: null }
  }
  let names
  try { names = readdirSync(storeDir) } catch (err) { return { pending: null, error: err } }
  let pending = 0
  for (const name of names) {
    if (!name.startsWith('.') || !name.endsWith('.active.json') || name.includes('.json.tmp.')) continue
    const path = join(storeDir, name)
    let record
    try { record = JSON.parse(readFileSync(path, 'utf8')) } catch (err) { return { pending: null, error: err } }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      return { pending: null, error: new Error(`descendant record is unreadable at ${path}`) }
    }
    if (record.swept_at == null) pending += 1
  }
  return { pending, error: null }
}

function loadCrew(paths) {
  const p = join(paths.dir, 'crew.json')
  if (!existsSync(p)) throw new Error(`no crew booted for this task (missing ${p})`)
  return JSON.parse(readFileSync(p, 'utf8'))
}

function seatModel(role, args) {
  return args[`model-${role}`] || SEAT_DEFAULTS[role].model
}

function seatAgent(role, args) {
  return args[`agent-${role}`] || SEAT_DEFAULTS[role].agent
}

// Enforce that the resolved adapter can actually deliver what the seat's
// charter needs. Every seat has a non-empty deny list, so an adapter that
// can't enforce it would boot a silently weaker seat. Returns undefined on
// success.

// TRD §4.4: this wiring is deliberately duplicated at each entry point;
// crew.mjs, daemon.mjs and factoryctl.mjs keep the same declarations shape
// because the daemon import firewall forbids a shared owner.
export const RUN_CONFIG_DECLARATIONS = Object.freeze({ profiles: TASK_PROFILES, variantNames: VARIANT_NAMES, assurances: ASSURANCES, assuranceAliases: ASSURANCE_ALIASES })
function flagNamedAliasError(error) {
  if (error?.code !== 'alias_conflict') return error
  error.message = String(error.message).replace(/\b(execution|variant|assurance|tier)=/g, '--$1=')
  return error
}
export function resolveRunConfig(request = {}) {
  return resolveRunConfiguration(request, RUN_CONFIG_DECLARATIONS)
}
export function aliasDeprecationLines(config = {}) {
  const lines = []
  for (const [axis, alias] of Object.entries(REQUEST_ALIASES)) {
    if (config[axis]?.source !== 'alias') continue
    lines.push(`warning: --${alias} is a DEPRECATED alias for --${axis}, removed after one release window (ADR-035 §4): requested ${JSON.stringify(config[axis].requested)}, effective ${JSON.stringify(config[axis].effective)} — pass --${axis} ${config[axis].effective} instead`)
  }
  return lines
}
export function writeAliasDeprecations(config, write) {
  const sink = typeof write === 'function' ? write : (text) => process.stderr.write(text)
  for (const line of aliasDeprecationLines(config)) sink(`${line}\n`)
}
export function assuranceTier(assurance) { return ASSURANCE_ALIAS_OF[assurance] ?? null }
export function persistedRunConfig(crew) {
  const stored = crew?.run_configuration
  if (stored && typeof stored === 'object') return { profile: stored.profile ?? null, assurance: stored.assurance ?? null }
  const derived = resolveRunConfig({ tier: typeof crew?.tier === 'string' ? crew.tier : undefined })
  return { profile: derived.profile, assurance: derived.assurance }
}

export function resolveFilesInScope(args = {}, variant, taskReturn, deps = {}) {
  const raw = args['files-in-scope']
  const exists = deps.existsSync || existsSync
  const read = deps.readFileSync || readFileSync
  const defectsMessage = (defects) => defects.map(({ entry, why }) => `${JSON.stringify(entry)} (${why})`).join(', ')
  if (raw === true) throw new Error('--files-in-scope needs a comma-separated list of repo-relative paths')
  if (raw !== undefined) {
    if (typeof raw !== 'string') throw new Error('--files-in-scope needs a comma-separated list of repo-relative paths')
    const files = raw.split(',').map((entry) => entry.trim()).filter(Boolean)
    if (files.length === 0) throw new Error(`--files-in-scope supplied an empty list ${JSON.stringify(raw)} — an empty scope is never a scope`)
    const defects = validateScopeEntries(files)
    if (defects.length) throw new Error(`--files-in-scope contains unsupported entries: ${defectsMessage(defects)}`)
    return files
  }
  if (VARIANTS[variant]?.sources?.scope !== 'inherited') return null

  const envelopePath = taskReturn || '<missing task return path>'
  if (!taskReturn || !exists(taskReturn)) {
    throw new Error(`cannot inherit files_in_scope for ${variant} run: failing-run envelope ${envelopePath} is missing or unreadable`)
  }
  let envelope
  try { envelope = JSON.parse(String(read(taskReturn, 'utf8'))) }
  catch (err) { throw new Error(`cannot read failing-run envelope ${envelopePath} for ${variant} scope inheritance: ${err?.message || String(err)}`) }
  const details = envelope && typeof envelope === 'object' && !Array.isArray(envelope) && envelope.details && typeof envelope.details === 'object' && !Array.isArray(envelope.details)
    ? envelope.details : null
  if (!details) throw new Error(`failing-run envelope ${envelopePath} for ${variant} scope inheritance has no details object declaring a non-empty scope`)
  // PRESENCE, not truthiness, decides which key is inherited. A finished run's
  // envelope always carries files_committed (what it did) and carries
  // files_in_scope only when the run narrowed its own scope — crew/drive.mjs:2264
  // documents that optional narrowed list. So a files_in_scope key that is
  // present but empty or malformed must REFUSE below rather than fall through:
  // falling through would silently widen the repair to whatever the failing run
  // happened to commit, past the scope it declared. crew/crew.test.mjs pins the
  // present-but-empty refusal beside the two inheriting cases.
  const hasForwardScope = Object.prototype.hasOwnProperty.call(details, 'files_in_scope')
  const files = hasForwardScope ? details.files_in_scope : details.files_committed
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(`failing-run envelope ${envelopePath} for ${variant} scope inheritance declares no non-empty files_in_scope/files_committed list`)
  }
  const defects = validateScopeEntries(files)
  if (defects.length) throw new Error(`inherited scope from ${envelopePath} contains unsupported entries: ${defectsMessage(defects)}`)
  return [...files]
}

// --fences/--lane are the brief compiler's flag names for the SAME register, so the
// orchestrator authors one file and both readers agree. Both or neither: a --lane
// with no register, or a register with no lane, is a boot refusal — never a silently
// unfenced run. Returns null when neither is given, and boot is unchanged.
export function resolveLaneFence(args = {}, deps = {}) {
  const gather = deps.gatherFences || gatherFences
  const forLane = deps.laneFenceFor || laneFenceFor
  const rawLane = args.lane
  const rawFences = args.fences
  if (rawLane === undefined && rawFences === undefined) return null
  if (typeof rawLane !== 'string' || !rawLane.trim()) {
    throw new Error('--lane needs a lane name from the fence register (--fences and --lane are given together or not at all)')
  }
  if (typeof rawFences !== 'string' || !rawFences.trim()) {
    throw new Error('--fences needs a path to the fence register JSON (--fences and --lane are given together or not at all)')
  }
  const lane = rawLane.trim()
  const fenceCheckout = typeof args.checkout === 'string' && args.checkout.trim()
    ? args.checkout : process.cwd()
  return { lane, fence: forLane({ fences: gather({ fencesPath: rawFences, checkout: fenceCheckout }), lane }) }
}

// The ROUND VALIDATION LANE — a different thing from the fence-register lane
// NAME above, which shares the --lane flag. --validation-lane is the spelling
// with no second meaning; a bare --lane keeps working because crew/factoryctl.mjs's
// `run` verb takes --lane and has no --fences flag at all (crew/factoryctl.mjs:192),
// and the daemon forwards it into the child spec unchanged, so a bare --lane is the
// only spelling that path has; but a --lane given WITH --fences is a register key and
// is never handed to the driver as a command.
// Same posture as crew/limits.mjs: validate, refuse from
// a closed set, and record the effective value and where it came from.
// crew/child.mjs carries an identical copy (the import firewall is deliberate)
// and crew/crew.test.mjs pins the two against one shared table.
export const VALIDATION_LANE_REFUSAL = 'invalid-validation-lane'

export function resolveValidationLane({ validationLane, lane, fences } = {}) {
  // An omitted input and an explicit null are the SAME absence. The daemon
  // normalises a missing lane to null (crew/daemon.mjs:1091) and childSpecFor
  // forwards it unconditionally (:948), so a resolver that only knows
  // `undefined` turns every daemon or factoryctl run booted without --lane into
  // a child-preflight escalation. Same shape as crew/limits.mjs:30. `fences`
  // deliberately keeps its `=== undefined` test: it is not a lane value but the
  // PAIRING SIGNAL asking whether --fences was given at all.
  const absent = (raw) => raw === undefined || raw === null
  const clean = (raw, flag) => {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw Object.assign(
        new Error(`--${flag} needs the shell command to run as the round validation lane, got ${JSON.stringify(raw)} [${VALIDATION_LANE_REFUSAL}]`),
        { reason: VALIDATION_LANE_REFUSAL },
      )
    }
    return raw.trim()
  }
  if (!absent(validationLane)) return { lane: clean(validationLane, 'validation-lane'), source: 'validation-lane' }
  if (!absent(lane) && fences === undefined) return { lane: clean(lane, 'lane'), source: 'lane' }
  return { lane: null, source: 'none' }
}

// Which supplied input answers a shape's 'ctx' source, and how a missing one
// refuses. Keyed by the source name crew/variants.mjs declares; today
// SHAPE_SOURCES (crew/drive.mjs:66) permits 'ctx' for `lane` alone.
const CTX_SOURCE_INPUTS = Object.freeze({
  lane: Object.freeze({ flag: 'validation-lane', reason: VALIDATION_LANE_REFUSAL }),
})

// #378 check 3: a partial shape declares where each plan-round product comes
// from, and crew/drive.mjs:1743 escalates a 'ctx' source ctx does not carry --
// correctly, but only after every seat has booted (#145 attempt 2 paid for a
// full judge-tier boot to learn it). The flags alone answer the same question,
// so it is answered HERE, before any state is read, spawned or written. The
// post-boot escalation STAYS as the backstop: this is a second, earlier reader
// of one declaration, never a move.
export function assertCtxSources(variant, { validationLane } = {}) {
  const supplied = { lane: validationLane?.lane ?? null }
  for (const [key, source] of Object.entries(VARIANTS[variant]?.sources || {})) {
    if (source !== 'ctx') continue
    const input = CTX_SOURCE_INPUTS[key]
    if (!input) throw new Error(`variant ${variant} declares sources.${key} "ctx" and this command supplies no such input`)
    if (supplied[key]) continue
    throw Object.assign(
      new Error(`a ${variant} run takes its ${key} from the dispatch (--${input.flag}) and none was supplied [${input.reason}]`),
      { reason: input.reason },
    )
  }
}

export function transportFor(role, args = {}) {
  const headless = String(args.headless === true ? '' : (args.headless || ''))
    .split(',').map((s) => s.trim()).filter(Boolean)
  const rpc = String(args['headless-rpc'] === true ? '' : (args['headless-rpc'] || ''))
    .split(',').map((s) => s.trim()).filter(Boolean)
  if (headless.includes(role) && rpc.includes(role)) {
    throw new Error(`role ${role} is named by both --headless and --headless-rpc`)
  }
  if (rpc.includes(role)) return HEADLESS_RPC_TRANSPORT
  if (headless.includes(role)) return HEADLESS_TRANSPORT
  return DEFAULT_TRANSPORT
}

export function seatTransport({ role, args = {}, adapter, agentName } = {}) {
  const explicit = transportFor(role, args)
  if (explicit !== DEFAULT_TRANSPORT) return explicit
  const raw = args['headless-all']
  if (raw === undefined) return DEFAULT_TRANSPORT
  if (raw !== true && raw !== 'true') throw new Error(`--headless-all takes no value (got ${JSON.stringify(raw)})`)
  const refusals = []
  for (const transport of HEADLESS_TRANSPORTS) {
    try {
      adapter.capabilitiesFor({ transport })
      return transport
    } catch (err) {
      refusals.push(err?.message || String(err))
    }
  }
  const last = refusals.at(-1) || 'unknown refusal'
  throw new Error(`seat ${role}: agent "${agentName}" ships no headless transport — tried ${HEADLESS_TRANSPORTS.join(', ')} (last refusal: ${last})`)
}

export function assertCapabilities(role, agentName, capabilities, allowed = [], requires = SEAT_DEFAULTS[role].requires, { withheld = [] } = {}) {
  if (SEAT_DEFAULTS[role].deny && capabilities?.tool_deny !== true) {
    const err = new Error(`seat ${role} needs tool denial (deny: "${SEAT_DEFAULTS[role].deny}") but agent adapter "${agentName}" declares tool_deny: false — refusing to boot a weaker seat`)
    err.reason = 'capability-shortfall'
    throw err
  }
  for (const cap of requires || []) {
    if (capabilities?.[cap] === true) continue
    if (allowed.includes(cap)) continue
    const err = withheld.includes(cap)
      ? new Error(`seat ${role} requires capability "${cap}" but crew/capabilities.json grants seat ${role} nothing that delivers it (tools: [...], agents: [...]) — refusing to boot a weaker seat (grant it in crew/capabilities.json roles.${role}, or pass --allow-shortfall-${role} ${cap} to boot it degraded on purpose)`)
      : new Error(`seat ${role} requires capability "${cap}" but agent adapter "${agentName}" declares ${cap}: ${JSON.stringify(capabilities?.[cap])} — refusing to boot a weaker seat (pass --allow-shortfall-${role} ${cap} to boot it degraded on purpose)`)
    err.reason = 'capability-shortfall'
    throw err
  }
}

export function seatShortfalls(role, args = {}) {
  const raw = args[`allow-shortfall-${role}`]
  if (raw === true) throw new Error(`--allow-shortfall-${role} needs a capability name (e.g. --allow-shortfall-${role} subagents) — a bare flag would waive every capability`)
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean)
}

export function bootAllocation(roles, args = {}, sources = null, transports = null) {
  const out = {}
  for (const role of roles) {
    const shortfall = seatShortfalls(role, args)
    const transport = transports?.[role]
    const cell = {
      ...(sources?.[role] || {}),
      ...(shortfall.length ? { shortfall } : {}),
      ...(transport !== undefined ? { transport } : {}),
    }
    if (Object.keys(cell).length) out[role] = cell
  }
  return Object.keys(out).length ? out : null
}

// A seat's declared BUDGET fallback chain: the cells to try, in order, when the
// booted cell refuses a turn for budget (crew/headless.mjs classifyRun's
// `budget-refused`). Closed set, the BAND_FLOOR_REFUSALS shape (:645) — every
// member is an operator error caught at BOOT, never a runtime guess.
export const FALLBACK_REFUSALS = Object.freeze([
  'fallback-empty',         // a seat declared `fallback` with no entries at all
  'fallback-self',          // an entry names the seat's OWN provider/id
  'fallback-agent-change',  // an entry names an agent the seat does not run
])

// Closed AT THE CONSTRUCTOR, not merely in the array: a caller branches on
// `err.reason`, so a free-form reason would make "frozen and closed" a claim
// about the enum that no caller can rely on. The posture, and the message shape,
// are refuseBandFloor's (crew/crew.mjs:652-654).
export function refuseFallback(reason, message) {
  if (!FALLBACK_REFUSALS.includes(reason)) throw new Error(`unknown fallback refusal reason ${JSON.stringify(reason)}`)
  return Object.assign(new Error(`${message} [${reason}]`), { reason })
}

// Resolve a roster tier into seated roles, per-seat cells, and a per-field
// provenance map. PURE: sync, no imports, no adapter knowledge — the
// per-adapter model-string translation is a separate step (resolveSeatModels)
// so this function stays testable with a bare roster object.
export function resolveTier(roster, tier, args = {}) {
  const cells = roster?.tiers?.[tier]
  if (!cells) throw new Error(`unknown tier "${tier}" — valid tiers: ${Object.keys(roster?.tiers || {}).join(', ')}`)
  // Canonical order first, then any roster-typo keys ROLE_ORDER doesn't know
  // about — a typo must surface at boot's SEAT_DEFAULTS check, never be
  // silently dropped.
  const order = [...ROLE_ORDER.filter((r) => r in cells), ...Object.keys(cells).filter((r) => !ROLE_ORDER.includes(r))]
  const roles = []
  const seats = {}
  const sources = {}
  for (const role of order) {
    const cell = cells[role]
    if (!cell) continue // null/absent -> not seated
    roles.push(role)
    const agentOverride = args[`agent-${role}`]
    const effortOverride = args[`effort-${role}`]
    const modelOverride = args[`model-${role}`]
    seats[role] = {
      agent: agentOverride || cell.agent,
      effort: effortOverride || cell.effort,
      provider: cell.provider,
      id: cell.id,
      // null = "translate from provider/id"; a flag value is a RAW
      // passthrough, never translated (the operator is speaking their own
      // CLI's namespace).
      model: modelOverride || null,
    }
    if (cell.fallback !== undefined) {
      if (!Array.isArray(cell.fallback) || cell.fallback.length === 0) {
        throw refuseFallback('fallback-empty', `seat ${role} in tier ${tier} declared "fallback" with no entries — omit the key, or name at least one cell, at crew/roster.json tiers.${tier}.${role}.fallback`)
      }
      for (const entry of cell.fallback) {
        if (entry.provider === cell.provider && entry.id === cell.id) {
          throw refuseFallback('fallback-self', `seat ${role} in tier ${tier} lists its OWN cell ${cell.provider}/${cell.id} as a fallback — a refused seat cannot fall back to itself, at crew/roster.json tiers.${tier}.${role}.fallback`)
        }
        if (entry.agent !== seats[role].agent) {
          throw refuseFallback('fallback-agent-change', `seat ${role} in tier ${tier} declares a fallback on agent "${entry.agent}" but the seat runs "${seats[role].agent}" — the agent picks the seat's transport at boot (crew/crew.mjs:501) and is fixed for the run, at crew/roster.json tiers.${tier}.${role}.fallback`)
        }
      }
      seats[role].fallback = cell.fallback.map((entry) => ({ ...entry }))
    }
    sources[role] = {
      agent: agentOverride ? 'override' : 'roster',
      model: modelOverride ? 'override' : 'roster',
      effort: effortOverride ? 'override' : 'roster',
    }
  }
  // A flag naming a role the tier does not seat is a loud throw — silently
  // dropping operator intent is the worse failure.
  for (const key of Object.keys(args)) {
    const m = /^(model|agent|effort)-(.+)$/.exec(key)
    if (m && !roles.includes(m[2])) {
      throw new Error(`--${m[1]}-${m[2]} given but tier ${tier} seats no ${m[2]}`)
    }
  }
  return { roles, seats, sources }
}

// The per-adapter translation step, kept out of the pure resolver: a roster
// cell is translated by the adapter that will run it; a --model-<role>
// override is already the operator's own CLI namespace and passes through
// raw. `adapters` is the {role: {name, adapter}} map resolveAdapters returns.
export function resolveSeatModels(seats, adapters, localProviders = null) {
  const out = {}
  for (const [role, seat] of Object.entries(seats)) {
    // A raw --model-<role> override is the operator's own CLI namespace: it is
    // never translated, AND it invalidates the roster cell it replaced. Keeping
    // that cell's provider/id would make the boot record name a model the seat
    // is not running (#161). Never guess a provider from a raw string — null is
    // the honest answer.
    if (seat.model) { const { fallback, ...rest } = seat; out[role] = { ...rest, provider: null, id: null }; continue }
    const adapter = adapters[role]?.adapter
    // The typeof fallback keeps a third-party adapter without modelString
    // bootable.
    const model = typeof adapter?.modelString === 'function'
      ? adapter.modelString({ provider: seat.provider, id: seat.id, localProviders })
      : seat.id
    // The chain is translated by the ROLE's own adapter, which is legal because
    // an entry may not change agent (resolveTier's fallback-agent-change). An
    // untranslated id is the guessed passthrough adapter-pi refuses (#147/#239),
    // and adapter-pi's own refusal is the honest error for a provider it cannot
    // map (crew/adapters/adapter-pi.mjs:101-108).
    const fallback = Array.isArray(seat.fallback) ? seat.fallback.map((entry) => ({
      ...entry,
      effort: entry.effort ?? seat.effort,
      model: typeof adapter?.modelString === 'function'
        ? adapter.modelString({ provider: entry.provider, id: entry.id, localProviders })
        : entry.id,
    })) : null
    out[role] = fallback ? { ...seat, model, fallback } : { ...seat, model }
  }
  return out
}

// ---- ratified tier band floors (#291) --------------------------------------
// crew/model-ladder.json is a RATIFIED artifact (protected: crew/protected-paths.mjs:12)
// and this slice only ENFORCES it — it authors no policy. The posture is #291's
// and #292's: refuse, never downgrade. The ladder is the RUNTIME's policy, not
// the target checkout's, exactly like roster.json at bootCmd's tier branch.
export const LADDER_PATH = join(HERE, 'model-ladder.json')

// The tiers the ratified ladder must floor and price. The same three the
// artifact's own validator declares (visualizer/server/roster-ladder.mjs:12) and
// enforces (:93-95) — mirrored, not imported: the runtime must not depend on the
// visualizer.
const LADDER_TIERS = Object.freeze(['mechanical', 'build', 'judge'])

// A ratified band member is a full provider/id key in the ROSTER's canonical
// namespace. A bare id is not a member, and neither is an adapter's own CLI
// spelling of one — see bandForRaw.
const LADDER_MEMBER = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/

// The closed set of band-floor refusal reasons — nothing is invented ad hoc.
// It mirrors CAPABILITY_REFUSALS (crew/capabilities.mjs:9) rather than joining
// it: a band floor is not a capability, and capabilities.mjs is not this lane's
// to edit.
export const BAND_FLOOR_REFUSALS = Object.freeze([
  'ladder-unreadable', // the ratified ladder is missing, unparseable or malformed
  'floor-unratified',  // the ladder ratifies no floor band for this tier
  'band-unknown',      // the seat's model is a member of no ratified band
  'band-below-floor',  // the seat's band ranks below its tier's ratified floor
])

export function refuseBandFloor(reason, message) {
  if (!BAND_FLOOR_REFUSALS.includes(reason)) throw new Error(`unknown band floor refusal reason ${JSON.stringify(reason)}`)
  return Object.assign(new Error(`${message} [${reason}]`), { reason })
}

// #419: boot's own closed refusal set. A caller branches on `err.reason` rather
// than parsing prose — the same posture as BAND_FLOOR_REFUSALS above and
// CAPABILITY_REFUSALS (crew/capabilities.mjs:9): the reasons are a frozen enum so
// a caller never string-matches a message.
export const BOOT_DESCENDANT_REFUSALS = Object.freeze([
  'descendants-alive', 'descendants-unknown', 'descendants-evidence-mismatch',
  'descendants-unreclaimed', 'descendants-sweep-failed',
])

// The verdicts reap-stale already adjudicates (scripts/factory/reap-stale.mjs:120),
// mapped onto boot's reasons. UNKNOWN is never treated as fine here.
const VERDICT_REFUSALS = Object.freeze({
  [REAP_VERDICTS.REFUSED_LIVE]: 'descendants-alive',
  [REAP_VERDICTS.REFUSED_UNKNOWN]: 'descendants-unknown',
  [REAP_VERDICTS.REFUSED_MISMATCH]: 'descendants-evidence-mismatch',
})

export function refuseStaleDescendants(reason, { task, detail = null } = {}) {
  if (!BOOT_DESCENDANT_REFUSALS.includes(reason)) throw new Error(`unknown boot descendant refusal: ${reason}`)
  const err = new Error(
    `boot refused for task ${task}: a previous run's workers are still recorded as running or unmeasurable `
    + `[reason: ${reason}]${detail ? ` (${detail})` : ''} — booting a second crew over them is the defect. `
    + `Reclaim them with \`npm run crew:reap -- --reclaim\`, or tear the task down (crew.mjs teardown --task ${task}), then boot again.`,
  )
  err.code = 'stale-descendants'
  err.reason = reason
  throw err
}

// Refusal precedence follows BOOT_DESCENDANT_REFUSALS' own order: alive first,
// then unmeasurable, then an identity that no longer binds. A record that was
// neither reclaimed nor refused but could not be durably stamped is still not a
// clean sweep, so it refuses too rather than seating a crew over it.
export function descendantRefusal(rows, summary) {
  const reasons = new Set()
  for (const row of rows || []) {
    if (row?.event !== 'descendant-reclaim') continue
    const mapped = VERDICT_REFUSALS[classifyRecord(row)]
    if (mapped) reasons.add(mapped)
  }
  for (const reason of BOOT_DESCENDANT_REFUSALS) if (reasons.has(reason)) return reason
  if (!summary) return 'descendants-unreclaimed'
  if (summary.retryable > 0 || summary.record_failed > 0 || summary.snapshot_ok !== true) return 'descendants-unreclaimed'
  return null
}

function ladderRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function unreadableLadder(path, expected, found, where = '') {
  return refuseBandFloor('ladder-unreadable', `the ratified model ladder expected ${expected}, found ${found}, at ${path}${where}`)
}

// THE ONE SEAM. Every band-floor read of the ladder goes through here, so an
// unreadable or malformed ladder is a DIFFERENT refusal from a violated floor:
// a boot must never confuse "policy says no" with "policy is unreadable". The
// shape contract is the artifact's own (visualizer/server/roster-ladder.mjs:64-105):
// schema version, ratification metadata, non-empty valid bands, unique band
// names, unique members, and a floor plus a cost ceiling for every tier.
export function loadLadder({ path = LADDER_PATH, readFile = readFileSync } = {}) {
  let raw
  try { raw = JSON.parse(readFile(path, 'utf8')) } catch (err) {
    throw unreadableLadder(path, 'readable JSON', err.message)
  }
  if (!ladderRecord(raw) || raw.schema_version !== 1) {
    throw unreadableLadder(path, 'a schema_version 1 object', JSON.stringify(ladderRecord(raw) ? raw.schema_version ?? null : typeof raw))
  }
  if (typeof raw.ratified_at !== 'string' || !raw.ratified_at || typeof raw.ratified_by !== 'string' || !raw.ratified_by) {
    throw unreadableLadder(path, 'ratified_at and ratified_by to name the ratification', JSON.stringify({ ratified_at: raw.ratified_at ?? null, ratified_by: raw.ratified_by ?? null }))
  }
  if (!Array.isArray(raw.bands) || !raw.bands.length) {
    throw unreadableLadder(path, 'a non-empty bands array', JSON.stringify(Array.isArray(raw.bands) ? raw.bands.length : raw.bands ?? null))
  }
  if (!ladderRecord(raw.tier_floors) || !ladderRecord(raw.cost_ceilings)) {
    throw unreadableLadder(path, 'tier_floors and cost_ceilings objects', JSON.stringify({ tier_floors: typeof raw.tier_floors, cost_ceilings: typeof raw.cost_ceilings }))
  }
  const ranks = new Map()
  const members = new Map()
  for (const entry of raw.bands) {
    if (!ladderRecord(entry) || typeof entry.band !== 'string' || !entry.band || !Number.isInteger(entry.rank)
      || typeof entry.floor_reference_score !== 'number' || !Number.isFinite(entry.floor_reference_score)
      || !Array.isArray(entry.members) || !entry.members.every((member) => typeof member === 'string' && member)) {
      throw unreadableLadder(path, 'every bands[] entry to name a band, an integer rank, a finite floor_reference_score and a members array of non-empty strings', JSON.stringify(entry ?? null), ' bands[]')
    }
    if (ranks.has(entry.band)) throw unreadableLadder(path, 'each band name once', `band ${JSON.stringify(entry.band)} more than once`, ' bands[]')
    ranks.set(entry.band, entry.rank)
    for (const member of entry.members) {
      if (!LADDER_MEMBER.test(member)) throw unreadableLadder(path, 'every member to be a provider/id key', JSON.stringify(member), ' bands[].members')
      if (members.has(member)) throw unreadableLadder(path, 'each member in exactly one band', `member ${JSON.stringify(member)} in more than one band`, ' bands[].members')
      members.set(member, entry.band)
    }
  }
  for (const tier of LADDER_TIERS) {
    const floor = raw.tier_floors[tier]
    if (typeof floor !== 'string' || !ranks.has(floor)) {
      throw unreadableLadder(path, `tier_floors.${tier} to name a ratified band`, JSON.stringify(floor ?? null), ` tier_floors.${tier}`)
    }
    const ceiling = raw.cost_ceilings[tier]
    if (typeof ceiling !== 'number' || !Number.isFinite(ceiling) || ceiling < 0) {
      throw unreadableLadder(path, `cost_ceilings.${tier} to be a non-negative number`, JSON.stringify(ceiling ?? null), ` cost_ceilings.${tier}`)
    }
  }
  return { path, ranks, members, floors: { ...raw.tier_floors } }
}

// The text a seat names its model by. A roster cell is the canonical
// provider/id; a raw --model-<role> override reaches here with provider AND id
// null (see resolveSeatModels above), so its own never-translated string is all
// there is. Used for the lookup AND for the refusal message.
export function seatModelKey(seat) {
  if (seat?.provider != null && seat?.id != null) return `${seat.provider}/${seat.id}`
  return seat?.model == null ? '' : String(seat.model)
}

// A CANONICAL roster key resolves by exact membership: the roster and the
// ladder share one namespace. Returns {member, band} or null (unknown).
export function bandForMember(ladder, member) {
  if (!member) return null
  return ladder.members.has(member) ? { member, band: ladder.members.get(member) } : null
}

// A RAW --model-<role> string is the ACTIVE ADAPTER's CLI namespace, not a
// ladder key: pi deliberately spells canonical provider "openai" as
// "openai-codex" (crew/adapters/adapter-pi.mjs:81), so textual equality with a
// ladder key is coincidence, not provenance. Resolution therefore runs the
// adapter's OWN existing contract in the only direction it is defined:
// translate every ratified member with modelString and accept the raw value
// only when exactly ONE candidate equals it. A candidate the adapter cannot
// express is skipped, zero or several matches is unknown, and an adapter with
// no modelString proves nothing. The raw override itself is never translated or
// rewritten (#161) — only the ratified members are.
export function bandForRaw(ladder, raw, adapter, localProviders = null) {
  if (!raw) return null
  if (typeof adapter?.modelString !== 'function') return null
  const matches = []
  for (const [member, band] of ladder.members) {
    const slash = member.indexOf('/')
    const provider = member.slice(0, slash)
    const id = member.slice(slash + 1)
    let candidate
    try { candidate = adapter.modelString({ provider, id, localProviders }) } catch { continue }
    if (candidate !== raw) continue
    matches.push({ member, band })
  }
  return matches.length === 1 ? matches[0] : null
}

// One entry point, two provenances: canonical membership for a roster cell,
// adapter-backed translation for a raw override.
export function seatBand(ladder, seat, { adapter = null, localProviders = null } = {}) {
  if (seat?.provider != null && seat?.id != null) return bandForMember(ladder, seatModelKey(seat))
  return bandForRaw(ladder, seatModelKey(seat), adapter, localProviders)
}

// Refuse any seat whose ratified band ranks BELOW its tier's ratified floor.
// Refuse, never downgrade. PURE: the ladder and the adapter context are passed
// in, so a boot and a test exercise one code path. `adapters` is the
// {role: {name, adapter}} map resolveAdapters returns.
export function assertBandFloors(seats, tier, ladder, { adapters = null, localProviders = null } = {}) {
  const floorName = ladder?.floors?.[tier]
  if (typeof floorName !== 'string' || !ladder.ranks.has(floorName)) {
    throw refuseBandFloor('floor-unratified', `tier ${tier} expected a ratified floor band, found ${JSON.stringify(floorName ?? null)}, at ${ladder?.path} tier_floors.${tier}`)
  }
  const floorRank = ladder.ranks.get(floorName)
  for (const [role, seat] of Object.entries(seats || {})) {
    const key = seatModelKey(seat)
    const found = seatBand(ladder, seat, { adapter: adapters?.[role]?.adapter, localProviders })
    if (found === null) {
      throw refuseBandFloor('band-unknown', `seat ${role} expected a model in a ratified band at or above "${floorName}" for tier ${tier}, found ${JSON.stringify(key || null)} proven by no ratified member, at ${ladder.path} bands[].members`)
    }
    const rank = ladder.ranks.get(found.band)
    if (rank < floorRank) {
      throw refuseBandFloor('band-below-floor', `seat ${role} expected band at or above "${floorName}" (rank ${floorRank}) for tier ${tier}, found "${found.band}" (rank ${rank}) for model ${key} (ratified member ${found.member}), at ${ladder.path} tier_floors.${tier}`)
    }
  }
}

// The models granted agent DEFINITIONS pin, as band-checkable records. A def
// with no `model` key contributes nothing: absence is never an error. The def
// JSON is read HERE because grantsFor returns only {name, def}
// (crew/capabilities.mjs:197) and capabilities.mjs is imported BY this file, so
// widening it would put a band question inside the register loader.
export function grantedDefModels(adapters, { readFile = readFileSync, localProviders = null } = {}) {
  const out = []
  for (const [role, seat] of Object.entries(adapters || {})) {
    for (const grant of seat?.grants?.agents || []) {
      let definition
      try { definition = JSON.parse(String(readFile(grant.def, 'utf8'))) } catch { continue }
      const cell = definition?.model
      if (cell === undefined || cell === null) continue
      if (typeof cell === 'string') {
        throw refuse('agent-def-invalid', `seat ${role} agent definition ${grant.name} expected a model cell {provider, id}, found a bare string ${JSON.stringify(cell)} — declare a cell, at ${grant.def}`)
      }
      if (!cell || typeof cell !== 'object' || Array.isArray(cell)
        || typeof cell.provider !== 'string' || !cell.provider.trim()
        || typeof cell.id !== 'string' || !cell.id.trim()) {
        throw refuse('agent-def-invalid', `seat ${role} agent definition ${grant.name} expected a model cell {provider, id}, found ${JSON.stringify(cell)} — declare a cell, at ${grant.def}`)
      }
      const adapter = seat?.adapter
      if (typeof adapter?.modelString !== 'function') {
        throw refuse('grant-unsupported', `seat ${role} agent definition ${grant.name} cannot resolve its model cell because adapter ${seat?.name ?? '<unknown>'} has no modelString — refusing to boot an unresolved model cell`)
      }
      // MUTATION A11: resolving at any id but the cell's own makes grantedDefModels
      // report a model the definition never declared.
      const resolved = adapter.modelString({ provider: cell.provider, id: cell.id, localProviders })
      // MUTATION A12: dropping the push leaves assertDefBandFloors nothing to floor,
      // so a below-floor cell reaches a child unchecked.
      out.push({ role, agent: grant.name, path: grant.def, model: resolved })
    }
  }
  return out
}

// #377: a granted agent definition that PINS a model spawns its child at that
// model, and that string went raw to the child's --model with no band check
// while every SEAT model is floored (#367). Same ratified floor, same closed
// vocabulary, same refuse-never-downgrade posture. The def's string is the
// GRANTING seat's adapter namespace, because that adapter is what composes the
// child's command line (crew/adapters/adapter-pi.mjs:241).
export function assertDefBandFloors(defs, tier, ladder, { adapters = null, localProviders = null } = {}) {
  if (!defs || defs.length === 0) return
  const floorName = ladder?.floors?.[tier]
  if (typeof floorName !== 'string' || !ladder?.ranks?.has(floorName)) {
    throw refuseBandFloor('floor-unratified', `tier ${tier} expected a ratified floor band, found ${JSON.stringify(floorName ?? null)}, at ${ladder?.path} tier_floors.${tier}`)
  }
  const floorRank = ladder.ranks.get(floorName)
  for (const { role, agent, path, model } of defs) {
    const defBand = bandForRaw(ladder, model, adapters?.[role]?.adapter, localProviders)
    if (defBand === null) {
      throw refuseBandFloor('band-unknown', `seat ${role} agent definition ${agent} expected a model in a ratified band at or above "${floorName}" for tier ${tier}, found ${JSON.stringify(model ?? null)} proven by no ratified member, at ${path}`)
    }
    const defRank = ladder.ranks.get(defBand.band)
    if (defRank < floorRank) {
      throw refuseBandFloor('band-below-floor', `seat ${role} agent definition ${agent} expected band at or above "${floorName}" (rank ${floorRank}) for tier ${tier}, found "${defBand.band}" (rank ${defRank}) for model ${model} (ratified member ${defBand.member}), at ${path}`)
    }
  }
}

// ---- shadow seat pick (#291 L2) --------------------------------------------
export const SHADOW_PICK_SCHEMA = 1
export const SHADOW_RATE_FLOOR = CELL_RATE_FLOOR
export const SHADOW_OUTCOMES = Object.freeze(['picked', 'stands', 'abstained', 'no-candidate', 'not-consulted'])
export const SHADOW_EXCLUSIONS = Object.freeze([
  'band-unknown', 'band-below-floor', 'capability-shortfall',
  'agent-unresolved', 'breaker-open', 'vendor-collision',
])
export const SHADOW_ABSENT = Object.freeze({
  cost: USAGE_ABSENT_CAUSES.pane,
  pass_rate: 'no review by this cell was its run\'s first round — UNMEASURED, never a zero rate',
  breaker: 'no breaker policy is configured (CREW_BREAKER_THRESHOLD unset) — candidate cell health is UNMEASURED, never healthy',
  reviews: 'the ledger mirror is degraded or unreadable — first-round pass rates are UNMEASURED, never zero',
})

export function shadowExclusion(reason, detail = null) {
  if (!SHADOW_EXCLUSIONS.includes(reason)) throw new Error(`unknown shadow exclusion reason ${JSON.stringify(reason)}`)
  return { reason, detail }
}

function compareShadowCell(a, b) {
  return `${a.provider}/${a.id}/${a.agent}/${a.effort}`.localeCompare(`${b.provider}/${b.id}/${b.agent}/${b.effort}`)
}

function shadowCell(cell) {
  return {
    provider: cell?.provider ?? null,
    id: cell?.id ?? null,
    agent: cell?.agent ?? null,
    effort: cell?.effort ?? null,
  }
}

function sameShadowCell(a, b) {
  return a?.provider === b?.provider && a?.id === b?.id
    && a?.agent === b?.agent && a?.effort === b?.effort
}

export function shadowCandidates(roster, role) {
  const tiers = roster?.tiers
  if (!tiers || typeof tiers !== 'object' || Array.isArray(tiers)) return []
  const byKey = new Map()
  for (const [tierName, cells] of Object.entries(tiers)) {
    if (!cells || typeof cells !== 'object' || Array.isArray(cells)) continue
    const cell = cells[role]
    if (!cell || typeof cell !== 'object' || Array.isArray(cell)) continue
    const fields = ['provider', 'id', 'agent', 'effort']
    if (fields.some((field) => cell[field] == null)) continue
    const key = `${cell.provider}/${cell.id}/${cell.agent}/${cell.effort}`
    let candidate = byKey.get(key)
    if (!candidate) {
      candidate = {
        provider: cell.provider, id: cell.id, agent: cell.agent, effort: cell.effort,
        tiers: [],
      }
      byKey.set(key, candidate)
    }
    if (!candidate.tiers.includes(tierName)) candidate.tiers.push(tierName)
  }
  return [...byKey.values()].sort(compareShadowCell)
}

function shadowNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function shadowReviewRow(candidate, role, reviewRows) {
  const row = { reviews: 0, first_round_reviews: 0, first_round_passes: 0 }
  for (const review of Array.isArray(reviewRows) ? reviewRows : []) {
    if (!review
      || review.provider !== candidate.provider
      || review.model_id !== candidate.id
      || review.agent !== candidate.agent
      || review.effort !== candidate.effort
      || review.role !== role) continue
    row.reviews += shadowNumber(review.reviews)
    row.first_round_reviews += shadowNumber(review.first_round_reviews)
    row.first_round_passes += shadowNumber(review.first_round_passes)
  }
  row.first_round_pass_rate = row.first_round_reviews === 0
    ? null : row.first_round_passes / row.first_round_reviews
  return row
}

export function shadowPick({ roster, tier, seats, sources = {}, ladder,
  capabilityFit = () => ({ ok: true }), breaker = null, reviewRows = null,
  reviewsAbsent = null }) {
  const absent = { cost: SHADOW_ABSENT.cost }
  if (breaker === null) absent.breaker = SHADOW_ABSENT.breaker
  if (reviewsAbsent) absent.reviews = SHADOW_ABSENT.reviews
  const record = {
    schema_version: SHADOW_PICK_SCHEMA,
    tier,
    decides: false,
    rate_floor: SHADOW_RATE_FLOOR,
    absent,
    seats: {},
  }

  for (const [role, seat] of Object.entries(seats || {})) {
    const seated = sources?.[role]?.model === 'override'
      ? { ...shadowCell(seat), provider: null, id: null }
      : shadowCell(seat)
    if (sources?.[role]?.model === 'override') { /* outcome 'not-consulted' */
      const notConsulted = `--model-${role} names the operator's own model; the picker is not consulted`
      record.seats[role] = {
        outcome: 'not-consulted', seated, picked: null, changes_seat: false,
        why: notConsulted, empty_reason: null,
        not_consulted_reason: notConsulted, candidates: [],
      }
      continue
    }

    const partner = seats['tech-lead'] ?? seats.planner
    const candidates = []
    for (const candidate of shadowCandidates(roster, role)) {
      let band = null
      let excludedBy = null
      const found = bandForMember(ladder, `${candidate.provider}/${candidate.id}`)
      if (found === null) {
        excludedBy = shadowExclusion('band-unknown', `${candidate.provider}/${candidate.id} is not in the ratified model ladder`)
      } else {
        band = found
        const floorRank = ladder.ranks.get(ladder.floors[tier])
        if (ladder.ranks.get(band.band) < floorRank) { /* band-below-floor */
          excludedBy = shadowExclusion('band-below-floor', `${candidate.provider}/${candidate.id} is below the ${tier} floor`)
        }
      }

      if (excludedBy === null) {
        const fit = capabilityFit(role, candidate)
        if (fit?.ok === false) {
          const reason = fit.reason === 'agent-unresolved' ? 'agent-unresolved' : 'capability-shortfall'
          excludedBy = shadowExclusion(reason, fit.detail ?? `candidate ${candidate.agent} cannot satisfy seat ${role}`)
        }
      }

      const cell = (breaker?.cells || []).find((row) => row
        && row.provider === candidate.provider
        && row.model_id === candidate.id
        && row.agent === candidate.agent
        && row.effort === candidate.effort)
      if (excludedBy === null) {
        if (cell && cell.verdict === 'open') { /* breaker-open */
          excludedBy = shadowExclusion('breaker-open', `${candidate.provider}/${candidate.id}/${candidate.agent}/${candidate.effort} is open in the breaker`)
        }
      }
      if (excludedBy === null) {
        if (role === 'reviewer' && partner && candidate.provider === partner.provider) { /* vendor-collision */
          excludedBy = shadowExclusion('vendor-collision', `reviewer ${candidate.provider}/${candidate.id} shares the vendor of the seated review partner`)
        }
      }

      const row = shadowReviewRow(candidate, role, reviewRows)
      const candidateAbsent = { cost_usd: SHADOW_ABSENT.cost }
      if (row.first_round_pass_rate === null) candidateAbsent.first_round_pass_rate = SHADOW_ABSENT.pass_rate
      candidates.push({
        provider: candidate.provider, id: candidate.id, agent: candidate.agent, effort: candidate.effort,
        tiers: [...candidate.tiers], band: band?.band ?? null, eligible: excludedBy === null, excluded_by: excludedBy,
        reviews: row.reviews, first_round_reviews: row.first_round_reviews,
        first_round_passes: row.first_round_passes,
        first_round_pass_rate: row.first_round_pass_rate,
        thin: row.first_round_reviews > 0 && row.first_round_reviews < SHADOW_RATE_FLOOR,
        breaker_verdict: cell?.verdict ?? null,
        cost_usd: null, absent: candidateAbsent,
      })
    }

    const eligible = candidates.filter((candidate) => candidate.excluded_by === null)
    let outcome
    let picked = null
    let why
    let emptyReason = null
    if (eligible.length === 0) {
      outcome = 'no-candidate'
      if (candidates.length === 0) {
        emptyReason = `the roster seats no cell for role ${role} at any tier`
      } else {
        const counts = new Map()
        for (const candidate of candidates) {
          const reason = candidate.excluded_by?.reason
          if (reason) counts.set(reason, (counts.get(reason) || 0) + 1)
        }
        const constraints = SHADOW_EXCLUSIONS
          .filter((reason) => counts.has(reason))
          .map((reason) => `${reason} (${counts.get(reason)})`)
        emptyReason = `no candidate was pickable: ${constraints.join(', ')}`
      }
      why = `${emptyReason}.`
    } else {
      const measured = eligible.filter((candidate) => candidate.first_round_pass_rate !== null && !candidate.thin)
      if (measured.length) {
        measured.sort((a, b) => (b.first_round_pass_rate - a.first_round_pass_rate) || compareShadowCell(a, b))
        const winner = measured[0]
        picked = shadowCell(winner)
        outcome = 'picked'
        why = `the picker ranks ${shadowCellKey(winner)} first on a ${winner.first_round_pass_rate} first-round pass rate across ${winner.first_round_reviews} first-round reviews.`
      } else {
        const seatedCandidate = eligible.find((candidate) => sameShadowCell(candidate, seated))
        if (seatedCandidate) {
          outcome = 'stands'
          picked = shadowCell(seated)
          why = 'no candidate carries a measured non-thin first-round pass rate, so the seated cell stands — a thin or absent sample is not a verdict.'
        } else {
          outcome = 'abstained'
          why = 'the seated cell is itself ineligible and no measured evidence exists, so the picker ranks on nothing rather than guessing.'
        }
      }
    }
    const changesSeat = picked !== null && !sameShadowCell(picked, seated)
    record.seats[role] = {
      outcome, seated, picked, changes_seat: changesSeat, why,
      empty_reason: outcome === 'no-candidate' ? emptyReason : null,
      not_consulted_reason: null, candidates,
    }
  }
  return record
}

function shadowCellKey(cell) {
  return `${cell.provider}/${cell.id}/${cell.agent}/${cell.effort}`
}

function shadowError(err) {
  return { schema_version: SHADOW_PICK_SCHEMA, error: err?.message || String(err) }
}

export async function shadowPickBoot({ roster, tier, seats, sources,
  adapters, registry, ladder, env = process.env, dbPath,
  openLedger = realOpenLedger, existsSync: existsSyncDep = existsSync,
  root = REGISTER_ROOT, pick = shadowPick }) {
  try {
    const candidateAdapters = new Map()
    const agentNames = new Set()
    for (const [role] of Object.entries(seats || {})) {
      if (sources?.[role]?.model === 'override') continue
      for (const candidate of shadowCandidates(roster, role)) agentNames.add(candidate.agent)
    }
    for (const name of agentNames) {
      const file = join(HERE, 'adapters', `adapter-${name}.mjs`)
      try {
        if (!existsSyncDep(file)) {
          candidateAdapters.set(name, { adapter: null, detail: `agent adapter ${name} does not resolve at ${file}` })
          continue
        }
        candidateAdapters.set(name, { adapter: await import(pathToFileURL(file).href), detail: null })
      } catch (err) {
        candidateAdapters.set(name, { adapter: null, detail: `agent adapter ${name} could not be resolved: ${err?.message || String(err)}` })
      }
    }

    const capabilityFit = (role, candidate) => {
      const loaded = candidateAdapters.get(candidate.agent)
      if (!loaded?.adapter) {
        return { ok: false, reason: 'agent-unresolved', detail: loaded?.detail || `agent adapter ${candidate.agent} could not be resolved` }
      }
      try {
        const adapter = loaded.adapter
        const transport = adapters?.[role]?.transport ?? DEFAULT_TRANSPORT
        const grants = grantsFor(registry, role, { root, exists: existsSyncDep, agent: candidate.agent })
        const requires = [...new Set([...(SEAT_DEFAULTS[role].requires || []), ...(grants.requires || [])])]
        const bare = adapter.capabilitiesFor({ transport, grants: EMPTY_GRANTS })
        const declared = adapter.capabilitiesFor({ transport, grants })
        const effective = effectiveCapabilities({ declared, bare, grants })
        const withheld = Object.keys(CAPABILITY_DELIVERY).filter((cap) => declared[cap] === true && effective[cap] !== true)
        assertCapabilities(role, candidate.agent, effective, [], requires, { withheld })
        return { ok: true }
      } catch (err) {
        return { ok: false, reason: 'capability-shortfall', detail: err?.message || String(err) }
      }
    }

    const syntheticSeats = {}
    for (const [role] of Object.entries(seats || {})) {
      if (sources?.[role]?.model === 'override') continue
      for (const [index, candidate] of shadowCandidates(roster, role).entries()) {
        syntheticSeats[`${role}:${index}`] = shadowCell(candidate)
      }
    }
    const breaker = cellHealth({
      policy: breakerPolicy(env), seats: syntheticSeats, dbPath, openLedger,
      existsSync: existsSyncDep,
    })

    let reviewRows = []
    let reviewsAbsent = null
    try {
      const present = dbPath ? existsSyncDep(dbPath) : false
      if (present) {
        let handle = null
        try {
          handle = openLedger({ dbPath, stderr: { write() {} } })
          const rows = handle.cellReviews({})
          const degraded = handle.degraded || Number(handle.stats()?.mirror_errors || 0) > 0
          if (degraded) {
            reviewRows = []
            reviewsAbsent = SHADOW_ABSENT.reviews
          } else {
            reviewRows = Array.isArray(rows) ? rows : []
          }
        } finally {
          try { handle?.close?.() } catch { /* an unreadable mirror stays unreadable */ }
        }
      }
    } catch (err) {
      reviewRows = []
      reviewsAbsent = SHADOW_ABSENT.reviews
    }

    return pick({ roster, tier, seats, sources, ladder, capabilityFit, breaker, reviewRows, reviewsAbsent })
  } catch (err) { return shadowError(err) }
}

// Resolve each role's agent name to its adapter module, by filename — this
// IS the seam: adding an agent means dropping a file in crew/adapters/, not
// editing crew.mjs. Dynamic import() is inherently async. `seats` (optional)
// is a tier's resolved seat map — when present, its agent choice wins over
// the --agent-<role>/SEAT_DEFAULTS flags-or-default path.
export async function resolveAdapters(roles, args, seats = null, deps = {}) {
  const out = {}
  const sourceArgs = args || {}
  for (const key of Object.keys(sourceArgs)) {
    const m = /^allow-shortfall-(.+)$/.exec(key)
    if (m && !roles.includes(m[1])) throw new Error(`--allow-shortfall-${m[1]} given but crew seats no ${m[1]}`)
  }
  const registry = deps.register ? loadCapabilities({ register: deps.register }) : loadCapabilities()
  const root = deps.root ?? REGISTER_ROOT
  const exists = deps.exists || existsSync
  const readFile = deps.readFile || readFileSync
  const probeEndpoint = deps.probeEndpoint || probeLocalEndpoint
  for (const role of roles) {
    try {
      const name = String(seats?.[role]?.agent || seatAgent(role, sourceArgs))
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`invalid agent adapter name "${name}" for seat ${role}`)
      const file = join(HERE, 'adapters', `adapter-${name}.mjs`)
      if (!existsSync(file)) throw new Error(`unknown agent adapter "${name}" for seat ${role}: no such adapter file ${file}`)
      const adapter = await import(pathToFileURL(file).href)
      if (typeof adapter.seatCommand !== 'function') throw new Error(`agent adapter "${name}" for seat ${role} (${file}) does not export a seatCommand function`)
      if (typeof adapter.capabilitiesFor !== 'function') throw new Error(`agent adapter "${name}" for seat ${role} (${file}) does not export a capabilitiesFor function`)
      const transport = seatTransport({ role, args: sourceArgs, adapter, agentName: name })
      const grants = grantsFor(registry, role, { root, exists, agent: name })
      assertGrantsBacked(role, grants, registry, { agent: name })
      assertFanoutCoherent(role, grants)

      let configDir = null
      const provider = seats?.[role]?.provider
      const localProvider = provider && Object.hasOwn(registry.local_providers, provider) ? registry.local_providers[provider] : null
      if (localProvider) {
        const settingsPath = resolvedGrantPath(root, localProvider.settings)
        if (!pathExists(exists, settingsPath)) {
          throw pathMessage('local-settings-missing', role, `local provider ${provider} settings`, 'an existing checkout-relative path', 'missing', settingsPath)
        }
        let live = false
        try { live = await probeEndpoint(localProvider.base_url) } catch { live = false }
        if (!live) {
          throw refuse('local-endpoint-dead', `seat ${role} local provider ${provider} endpoint ${localProvider.base_url} is unavailable — refusing to boot a dead local-provider cell`)
        }
        const capabilities = adapter.capabilitiesFor({ transport })
        if (capabilities.local_provider !== true) {
          throw refuse('grant-unsupported', `seat ${role} local provider ${provider} is not supported by adapter ${name} — refusing to boot a silently weaker seat`)
        }
        configDir = dirname(settingsPath)
      }

      for (const grant of grants.agents || []) {
        let definition
        try { definition = JSON.parse(String(readFile(grant.def, 'utf8'))) } catch { continue }
        const cell = definition?.model
        const defProvider = cell?.provider
        if (!cell || typeof cell !== 'object' || Array.isArray(cell)
          || typeof defProvider !== 'string' || !Object.hasOwn(registry.local_providers, defProvider)) continue
        const defLocal = registry.local_providers[defProvider]
        const defSettingsPath = resolvedGrantPath(root, defLocal.settings)
        // MUTATION A9: neutralising this test boots a definition whose local
        // provider has no settings file.
        if (!pathExists(exists, defSettingsPath)) {
          throw pathMessage('local-settings-missing', role, `agent definition ${grant.name} local provider ${defProvider} settings`, 'an existing checkout-relative path', 'missing', defSettingsPath)
        }
        let defLive = false
        try { defLive = await probeEndpoint(defLocal.base_url) } catch { defLive = false }
        // MUTATION A10: neutralising this test boots a definition pointing at a dead
        // local endpoint.
        if (!defLive) {
          throw refuse('local-endpoint-dead', `seat ${role} agent definition ${grant.name} local provider ${defProvider} endpoint ${defLocal.base_url} is unavailable — refusing to boot a dead local-provider cell`)
        }
        if (adapter.capabilitiesFor({ transport }).local_provider !== true) {
          throw refuse('grant-unsupported', `seat ${role} agent definition ${grant.name} local provider ${defProvider} is not supported by adapter ${name} — refusing to boot a silently weaker seat`)
        }
      }

      const requires = [...new Set([...(SEAT_DEFAULTS[role].requires || []), ...grants.requires])]
      const bare = adapter.capabilitiesFor({ transport, grants: EMPTY_GRANTS })
      const declared = adapter.capabilitiesFor({ transport, grants })
      const effective = effectiveCapabilities({ declared, bare, grants })
      const withheld = Object.keys(CAPABILITY_DELIVERY).filter((cap) => declared[cap] === true && effective[cap] !== true)
      assertCapabilities(role, name, effective, seatShortfalls(role, sourceArgs), requires, { withheld })
      if (transport === HEADLESS_TRANSPORT && typeof adapter.headlessCommand !== 'function') {
        throw new Error(`agent adapter "${name}" for seat ${role} (${file}) does not export a headlessCommand function`)
      }
      out[role] = { name, adapter, transport, grants, configDir }
    } catch (err) {
      if (err.role === undefined) { err.role = role; err.cell = seats?.[role] ?? null }
      throw err
    }
  }
  Object.defineProperty(out, 'registry', { value: registry, enumerable: false })
  return out
}

export function memoryConfig(args = {}) {
  const source = args || {}
  const dir = source['memory-dir'] || process.env.CREW_MEMORY_DIR || null
  if (!dir) return null
  const backend = source['memory-backend'] || process.env.CREW_MEMORY_BACKEND || DEFAULT_BACKEND
  const rawBudget = source['memory-budget-bytes'] || process.env.CREW_MEMORY_BUDGET_BYTES || DEFAULT_BUDGET_BYTES
  const budget = typeof rawBudget === 'number'
    ? rawBudget
    : typeof rawBudget === 'string' && rawBudget.trim() ? Number(rawBudget) : NaN
  const valid = Number.isFinite(budget) && budget >= 0
  return {
    dir, backend,
    budgetBytes: valid ? budget : DEFAULT_BUDGET_BYTES,
    ...(valid ? {} : { reason: 'invalid-budget' }),
  }
}

export function memoryExtracts(roles, args, taskSlug) {
  try {
    const cfg = memoryConfig(args)
    if (!cfg) return { sections: {}, record: null }
    const memory = openMemory(cfg)
    const sections = {}
    const injected = []
    let bytes = 0
    let included = 0
    let dropped = 0
    let reason = cfg.reason || null
    for (const role of roles || []) {
      if (!MEMORY_ROLES.includes(role)) continue
      const extract = memory.context({ task: taskSlug, role })
      bytes += Number(extract.bytes) || 0
      included += Array.isArray(extract.included) ? extract.included.length : 0
      dropped += Array.isArray(extract.dropped) ? extract.dropped.length : 0
      const section = renderSection(extract, { backend: cfg.backend })
      if (section) {
        sections[role] = section
        injected.push(role)
      }
      if (!reason && extract.reason) reason = extract.reason
    }
    return {
      sections,
      record: {
        backend: cfg.backend, dir: cfg.dir, budget_bytes: cfg.budgetBytes,
        injected, bytes, included, dropped, reason,
      },
    }
  } catch (err) {
    return { sections: {}, record: { injected: [], error: err?.message || String(err) } }
  }
}

function writeRolePrompt(role, taskDir, section = '') {
  const seat = SEAT_DEFAULTS[role]
  // --append-system-prompt-file is LAST-WINS, not cumulative (verified against
  // claude 2.1.229): passing shared + role as two flags silently drops shared.
  // So the shared contract and the role card are merged into ONE prompt file
  // per seat, generated in the task dir at boot.
  const merged = join(taskDir, `role-${role}.md`)
  const shared = readFileSync(SHARED_PROMPT, 'utf8')
  const card = readFileSync(join(ROLES_DIR, seat.prompt), 'utf8')
  writeFileSync(merged, `${shared}\n\n${card}${section ? `\n\n${section}` : ''}`)
  return merged
}

function paneCommand(role, args, { taskDir, bootBrief, adapter, tierSeat, grants = EMPTY_GRANTS, configDir = null, advisorCell = null }) {
  const seat = SEAT_DEFAULTS[role]
  const merged = join(taskDir, `role-${role}.md`)
  // effort: per-seat boot flag (--effort-<role> high), OPTIONAL — or, when a
  // --tier was used, the roster's resolved seat (tierSeat), which flags still
  // override. Both shipped adapters declare transport-invariant effort in
  // the resolved profile and map it to their own flag (claude --effort, pi
  // --thinking).
  return adapter.seatCommand({
    role, model: tierSeat?.model || seatModel(role, args), promptFile: merged,
    tools: seat.tools, deny: seat.deny, taskDir, bootBrief,
    effort: tierSeat?.effort || args[`effort-${role}`] || undefined,
    grants, configDir, advisorCell,
  })
}

function stackVertical(nodes) {
  if (nodes.length === 1) return nodes[0]
  const [head, ...rest] = nodes
  return { direction: 'vertical', split: 1 / nodes.length, children: [head, stackVertical(rest)] }
}

// the first seated role takes the left half; the rest stack on the right.
export function composeLayout(roles, mk) {
  const panes = roles.map((r) => ({ pane: { surfaces: [{ type: 'terminal', name: r, command: mk(r) }] } }))
  if (panes.length === 1) return panes[0]
  const [head, ...rest] = panes
  return { direction: 'horizontal', split: 0.42, children: [head, stackVertical(rest)] }
}

// The park's seats are the crew's seated members. sessionId prefers the pane
// surface (what a human would reattach to) and falls back so a headless seat
// still yields a non-blank, unique key; `warm` records whether a live pane
// survived the escalation.
export function parkSeats(crew) {
  return (crew?.roles || [])
    .filter((role) => crew.members?.[role])
    .map((role) => {
      const m = crew.members[role]
      return { role, sessionId: m.surface_id || m.pane_id || `${m.transport}:${role}`, warm: !!m.surface_id }
    })
}

// ADR-029 §4's canonical attention shape, escalation moment. park_id is
// PRESENT on every event, minted or null.
export function escalationAttention({ task, park_id, why, artifacts = [] }) {
  return { kind: 'attention', moment: 'escalation', park_id: park_id ?? null, task, why, artifacts }
}

// Outcome-gated in the function itself, so `done mints nothing` is a property
// of the seam and not of its one call site. Returns {park_id, error}; NEVER
// throws (D2) — a store that cannot be opened or a mint that cannot complete
// is reported, not raised.
export function parkOnOutcome(result, { crew, runId, dir, reason, actor = 'crew', openStore } = {}) {
  if (result?.status !== 'escalation') return { park_id: null, error: null }
  const open = openStore || ((d) => reclaimStore({ dir: d, actor }))
  let res
  try {
    const seats = parkSeats(crew)
    if (!seats.length) return { park_id: null, error: 'no seated members to park' }
    res = open(dir).mintPark({ run_id: runId, seats, reason: reason || '' })
  } catch (err) { return { park_id: null, error: err?.message || String(err) } }
  if (!res?.ok || !res.park?.park_id) return { park_id: null, error: res?.reason || 'mint failed' }
  return { park_id: res.park.park_id, error: null }
}

export async function bootCmd(args, deps = {}) {
  const {
    cmux: cmuxFn = cmux, tree: treeFn = tree, renameTab: renameTabFn = renameTab,
    openLedger: openLedgerDep = null, existsSync: existsSyncDep = null,
    loadavg: loadavgDep = null, cpus: cpusDep = null,
    probeEndpoint: probeEndpointDep = null, register: registerDep = null,
    awaitSeatsReady: awaitSeatsReadyDep = awaitSeatsReady,
  } = deps
  // Capture the invocation environment before async adapter resolution so the
  // breaker and host-load policies cannot be lost while boot is awaiting imports.
  const bootEnv = { ...process.env }
  // TRD §4.4: boot owns profile and assurance; execution belongs to run, so
  // boot deliberately neither resolves nor persists the execution axis here.
  let configuration
  try {
    configuration = resolveRunConfig({ profile: args.profile, assurance: args.assurance, tier: args.tier })
  } catch (err) {
    throw flagNamedAliasError(err)
  }
  const bootConfigRecord = Object.freeze({ profile: configuration.profile, assurance: configuration.assurance })
  writeAliasDeprecations(configuration)
  const taskSlug = slug(args.task)
  const checkout = resolvePath(args.checkout || process.cwd())
  const laneFence = resolveLaneFence(args)
  let roles, tierName = null, tierSeats = null, sources = null, roster = null
  const seatingTier = args.tier !== undefined || args.assurance !== undefined ? assuranceTier(configuration.assurance.effective) : null
  if (seatingTier) {
    if (args.roles) throw new Error('--assurance/--tier and --roles are mutually exclusive: the assurance defines the seating')
    // The roster is the RUNTIME's policy, not the target checkout's. A
    // corrupt/missing roster must name the file and that rule, not throw a
    // bare "Unexpected token".
    const rosterPath = join(HERE, 'roster.json')
    try { roster = JSON.parse(readFileSync(rosterPath, 'utf8')) } catch (err) {
      throw new Error(`--tier needs the crew runtime's own roster at ${rosterPath} (not the target checkout's): ${err.message}`)
    }
    ;({ roles, seats: tierSeats, sources } = resolveTier(roster, String(seatingTier), args))
    tierName = seatingTier
  } else {
    roles = (args.roles ? args.roles.split(',') : [...DEFAULT_ROLES]).map((r) => r.trim())
    if (!roles.includes('lead')) roles = ['lead', ...roles]
  }
  for (const r of roles) if (!SEAT_DEFAULTS[r]) throw new Error(`unknown crew role: ${r}`)
  const headlessNames = String(args.headless === true ? '' : (args.headless || ''))
    .split(',').map((r) => r.trim()).filter(Boolean)
  const rpcNames = String(args['headless-rpc'] === true ? '' : (args['headless-rpc'] || ''))
    .split(',').map((r) => r.trim()).filter(Boolean)
  for (const role of [...headlessNames, ...rpcNames]) if (!roles.includes(role)) {
    throw new Error(`transport role ${role} given but crew seats no ${role}`)
  }
  for (const role of roles) transportFor(role, args) // detects ambiguous lists before cmux boot
  // #309: refuse a saturated HOST the way ADR-032's breaker refuses an open
  // cell. Opt-in (CREW_LOAD_THRESHOLD); with no policy nothing is measured and
  // boot is unchanged. Refuse HERE: before resolveAdapters, before the
  // noteRunlessCellFailure wrapper below, and before pathsFor/mkdirSync or any
  // cmux call, so a refusal leaves no state dir and no workspace behind. Host
  // saturation is not evidence against a cell, so it is never recorded as one.
  const load = hostLoad({
    policy: loadPolicy(bootEnv),
    ...(loadavgDep ? { loadavg: loadavgDep } : {}),
    ...(cpusDep ? { cpus: cpusDep } : {}),
  })
  assertHostQuiet(load)

  // Resolve adapters before touching cmux — a bad --agent-<role> or a
  // capability shortfall must fail before a workspace gets created.
  let adapters
  try {
    adapters = await resolveAdapters(roles, args, tierSeats, registerDep ? { register: registerDep } : {})
  } catch (err) {
    noteRunlessCellFailure({ taskSlug, role: err.role ?? null, kind: 'boot-refusal', err, cell: err.cell ?? null })
    throw err
  }
  const registry = adapters.registry || loadCapabilities()
  const seats = tierSeats ? resolveSeatModels(tierSeats, adapters, registry.local_providers) : null
  // #291: enforce the RATIFIED tier band floors. A below-floor seat is an
  // operator/roster decision, not evidence against a cell, so — like the breaker
  // and host-load refusals — it is NOT recorded as a cell failure, and it fires
  // before the state dir is read or created (existsSync/mkdirSync below) and
  // before any cmux call, so a refusal leaves no state dir and no workspace
  // behind. The adapter map goes in because a raw override is the adapter's own
  // namespace and only that adapter can prove which ratified member it denotes.
  // Only a TIER boot has a ratified floor: tier_floors is keyed by tier, and a
  // --roles boot names none.
  let ladder = null
  if (seats && tierName) {
    ladder = loadLadder()
    assertBandFloors(seats, tierName, ladder, { adapters, localProviders: registry.local_providers })
    // #377: the same floor over the models granted agent DEFINITIONS pin.
    assertDefBandFloors(grantedDefModels(adapters, { localProviders: registry.local_providers }), tierName, ladder, { adapters, localProviders: registry.local_providers })
  }
  // #45 Tier B: opt-in cell breaker. With no policy configured this is a
  // null and the ledger is never opened (acceptance #1). An open cell
  // refuses here, before any state dir or seat exists, and is NOT recorded
  // as a cell failure — a policy decision is not evidence against the cell.
  // An injected opener IS the ledger source, so its dbPath precheck is
  // meaningless; the precheck exists so a real boot never creates a ledger DB
  // as a side effect of the breaker check. Callers can still pin the precheck
  // explicitly through existsSync for a fake or custom ledger.
  const breaker = cellHealth({
    policy: breakerPolicy(bootEnv), seats, dbPath: ledgerDbPath(),
    ...(openLedgerDep ? {
      openLedger: openLedgerDep,
      existsSync: existsSyncDep ?? (() => true),
    } : {}),
  })
  assertCellsClosed(breaker)
  const advisorRecord = advisorBootRecord({ adapters, env: bootEnv })
  await assertAdvisorCellLive({ record: advisorRecord, adapters, taskSlug,
    probeEndpoint: probeEndpointDep || probeLocalEndpoint,
    note: noteRunlessCellFailure })
  const paneRoles = roles.filter((role) => adapters[role].transport === DEFAULT_TRANSPORT)
  const headlessOnly = paneRoles.length === 0
  // #249 / ADR-033: transport follows the MODE, never the seat. A cmux workspace
  // exists so a human can inspect every seat in it, so a piped seat inside one is
  // a mode error, not a configuration. Refuse HERE: after resolveAdapters
  // (transport is unknowable before it) and before pathsFor/mkdirSync or any cmux
  // call, so a refusal leaves no state dir and no workspace behind. Deliberately
  // outside the noteRunlessCellFailure wrapper above — operator misconfiguration
  // is not evidence against a cell (ADR-032's posture).
  if (!headlessOnly) {
    const piped = roles.filter((role) => adapters[role].transport !== DEFAULT_TRANSPORT)
    if (piped.length) {
      const named = piped.map((role) => `${role} (${adapters[role].transport})`).join(', ')
      const err = new Error(
        `mixed transport: this boot would create a cmux workspace, but ${named} would be piped instead of seated in a pane. `
        + 'A workspace exists so a human can inspect EVERY seat in it; a piped seat there is visible only by tailing '
        + 'task/headless-rpc/<role>/stream.jsonl. Pick a mode: drop --headless/--headless-rpc so every seat gets a pane, '
        + 'or pass --headless-all for the factory shape, which creates no workspace at all.'
      )
      err.code = 'mixed-transport'
      throw err
    }
  }
  const workerBin = roles.some((role) => adapters[role].transport === HEADLESS_TRANSPORT) ? resolveWorkerBin(args) : null

  const paths = pathsFor(taskSlug, checkout)
  // The state dir keys on the checkout's BASENAME — two different checkouts
  // sharing a directory name would silently share (and clobber) one crew.
  // Refuse to boot over a live crew that belongs to a different checkout.
  const existing = existsSync(join(paths.dir, 'crew.json'))
    ? JSON.parse(readFileSync(join(paths.dir, 'crew.json'), 'utf8')) : null
  if (existing && existing.checkout !== checkout) {
    throw new Error(`a crew for task ${taskSlug} already exists for a DIFFERENT checkout (${existing.checkout}) — tear it down first or pick another task slug`)
  }

  // #419: reclaim THIS task's stale descendants before any seat exists.
  // Only this task dir: sweeping every task is `npm run crew:reap -- --reclaim`, invoked
  // deliberately by an operator. Composed, never reimplemented — the sweep is
  // idempotent through each record's swept_at (crew/seat-io.mjs:679).
  const journalPath = join(paths.dir, 'journal.jsonl')
  const sweepRows = []
  const sweepLog = (row) => { sweepRows.push(row); logLine(journalPath, row) }
  const sweepFn = deps.reclaimDescendants || reclaimDescendants
  let sweep = null
  let sweepError = null
  try {
    sweep = sweepFn({ taskDir: paths.taskDir, log: sweepLog, deps: deps.descendantDeps || {} })
  } catch (err) { sweepError = err }
  const stamp = sweepError ? { pending: 0, error: null } : descendantStampStatus(
    paths.taskDir, (Number(sweep?.records) || 0) + (Number(sweep?.skipped) || 0),
  )
  const summaryRefusal = sweepError ? 'descendants-sweep-failed' : descendantRefusal(sweepRows, sweep)
  const refusal = summaryRefusal
    || (stamp.error ? 'descendants-sweep-failed' : stamp.pending > 0 ? 'descendants-unreclaimed' : null)
  const sweepFailure = sweepError || stamp.error
  // Recorded on EVERY boot, refused or not: a boot that skipped the check and a
  // boot that found nothing must stay distinguishable after the fact. No stdout —
  // a clean sweep prints nothing.
  logLine(journalPath, {
    at: new Date().toISOString(), event: 'boot-descendant-sweep', task: taskSlug,
    records: sweep?.records ?? null, swept: sweep?.swept ?? null, skipped: sweep?.skipped ?? null,
    retryable: sweep?.retryable ?? null, reclaimed: sweep?.reclaimed ?? null,
    live: sweep?.live ?? null, probe_unknown: sweep?.probe_unknown ?? null,
    identity_refused: sweep?.identity_refused ?? null, snapshot_ok: sweep?.snapshot_ok ?? null,
    refusal: refusal ?? null, ...(sweepFailure ? { error: sweepFailure.message } : {}),
  })
  if (refusal) refuseStaleDescendants(refusal, { task: taskSlug, detail: sweepFailure?.message || null })

  mkdirSync(paths.taskDir, { recursive: true })
  mkdirSync(paths.returnsDir, { recursive: true })

  const bootBrief = `Crew for task ${taskSlug}. Task dir ${paths.taskDir}. Read your role in the system prompt, reply exactly ready: your-role, then wait.`
  const memory = memoryExtracts(roles, args, taskSlug)
  for (const role of roles) writeRolePrompt(role, paths.taskDir, memory.sections[role] || '')
  let workspace = null
  let windowId = null
  const members = {}
  const memberFor = (role, pane = null, surface = null) => ({
    pane_id: pane?.id || null, surface_id: surface?.id || null,
    transport: adapters[role].transport, model: seats?.[role]?.model || seatModel(role, args), agent: adapters[role].name,
    tools: effectiveTools(role, adapters[role].grants), deny: SEAT_DEFAULTS[role].deny,
    ...(seats ? { effort: seats[role].effort, provider: seats[role].provider, id: seats[role].id } : {}),
    ...(seats?.[role]?.fallback ? { fallback: seats[role].fallback } : {}),
  })
  if (headlessOnly) {
    for (const role of roles) members[role] = memberFor(role)
  } else {
    const mk = (role) => paneCommand(role, args, {
      taskDir: paths.taskDir, bootBrief, adapter: adapters[role].adapter, tierSeat: seats?.[role],
      grants: adapters[role].grants, configDir: adapters[role].configDir,
      advisorCell: adapters[role].grants?.advisor === true
        ? { endpoint: advisorRecord.endpoint, model: advisorRecord.model } : null,
    })
    const layout = composeLayout(paneRoles, mk)

    const before = treeFn()
    const res = cmuxFn('new-workspace', ['--name', `crew-${taskSlug}`, '--cwd', checkout, '--layout', JSON.stringify(layout), '--focus', 'true'])
    if (!res.ok) throw new Error(`new-workspace --layout failed: ${res.error.message}`)
    const after = treeFn()

    // Identify OUR workspace by the name we just set, never positionally —
    // "the last unseen id" mis-targets the moment two boots race. Name plus
    // new-since-before must yield exactly one workspace.
    const beforeWs = new Set()
    for (const w of before.windows || []) for (const ws of w.workspaces || []) beforeWs.add(ws.id)
    const candidates = []
    for (const w of after.windows || []) for (const ws of w.workspaces || []) {
      if (!beforeWs.has(ws.id) && (ws.name === undefined || ws.name === `crew-${taskSlug}`)) candidates.push({ ws, windowId: w.id })
    }
    if (candidates.length !== 1) throw new Error(`boot: expected exactly one new crew-${taskSlug} workspace, found ${candidates.length}`)
    const found = candidates[0]
    workspace = found.ws
    windowId = found.windowId
    const panes = workspace.panes || []
    if (panes.length !== paneRoles.length) throw new Error(`boot: expected ${paneRoles.length} panes, found ${panes.length}`)

    // Seat every role by its SURFACE NAME (set in the layout) — positional
    // mapping mis-seats every role silently if the tree's pane order ever
    // differs from layout order. Fall back to position only when the tree
    // carries no surface names at all, and fail loudly on a partial match.
    const byName = new Map()
    for (const p of panes) {
      const s = (p.surfaces || [])[0]
      if (s?.name) byName.set(String(s.name).toLowerCase(), { pane: p, surface: s })
    }
    if (byName.size > 0) {
      for (const role of paneRoles) {
        const hit = byName.get(role)
        if (!hit) throw new Error(`boot: no surface named ${role} in the new workspace (tree names: ${[...byName.keys()].join(', ')})`)
        members[role] = memberFor(role, hit.pane, hit.surface)
      }
    } else {
      paneRoles.forEach((role, i) => {
        const surface = (panes[i].surfaces || [])[0]
        members[role] = memberFor(role, panes[i], surface)
      })
    }
    // Unreachable since #249: the mixed-transport guard above refuses any
    // workspace boot with a non-pane seat. Kept as the symmetric partner of
    // the headlessOnly offender check below.
    for (const role of roles.filter((r) => adapters[r].transport !== DEFAULT_TRANSPORT)) members[role] = memberFor(role)
    for (const role of paneRoles) renameTabFn(members[role].surface_id, role)
  }

  const crew = {
    schema_version: 3, task: taskSlug, checkout,
    workspace_id: workspace ? workspace.id : null, window_id: windowId ?? null,
    roles, members, task_return: join(paths.returnsDir, 'task.json'),
    run_configuration: bootConfigRecord,
    created_at: new Date().toISOString(),
    ...(workerBin ? { claude_bin: workerBin } : {}),
    ...(tierName ? { tier: tierName, seats } : {}),
    ...(laneFence ? { lane_name: laneFence.lane, lane_fence: laneFence.fence } : {}),
    ...(advisorRecord.granted.length ? { advisor: advisorRecord } : {}),
  }
  // crew/daemon.mjs paneSeat() is the consumer: daemon run refuses pane transport.
  if (headlessOnly) {
    const offender = roles.find((role) => !members[role]?.transport || members[role].transport === DEFAULT_TRANSPORT)
    if (offender) throw new Error(`boot: all-headless crew has a missing or pane transport for seat ${offender}`)
  }
  saveCrew(paths, crew)
  const allocation = bootAllocation(roles, args, sources, Object.fromEntries(roles.map((r) => [r, members[r].transport])))
  const shadow = tierName && seats
    ? await shadowPickBoot({ roster, tier: tierName, seats: tierSeats, sources, adapters, registry, ladder, env: bootEnv, dbPath: ledgerDbPath() })
    : null
  logLine(join(paths.dir, 'journal.jsonl'), {
    at: new Date().toISOString(), event: 'boot', roles,
    run_configuration: bootConfigRecord,
    models: Object.fromEntries(roles.map((r) => [r, members[r].model])),
    transports: Object.fromEntries(roles.map((r) => [r, members[r].transport])),
    ...(workerBin ? { claude_bin: workerBin } : {}),
    ...(tierName ? { tier: tierName, seats } : {}),
    ...(allocation ? { allocation } : {}),
    ...(breaker ? { breaker } : {}),
    ...(load ? { load } : {}),
    ...(shadow ? { shadow_pick: shadow } : {}),
    ...(laneFence ? { lane_name: laneFence.lane, fenced_lanes: laneFence.fence.length } : {}),
    capabilities: { schema_version: registry.schema_version, roles: Object.keys(registry.roles) },
    ...(memory.record ? { memory: memory.record } : {}),
    ...(advisorRecord.granted.length ? { advisor: advisorJournalRecord(advisorRecord) } : {}),
  })
  // The seats this boot just launched carry the brief in their argv, so their own
  // ready reply is both due and the only evidence that counts (#741). Gate HERE,
  // after crew.json is on disk: a boot killed at this line leaves a workspace a
  // `crew teardown --task` can still find and close.
  awaitSeatsReadyDep(crew, 'fresh', join(paths.dir, 'journal.jsonl'))
  process.stdout.write(`${JSON.stringify({ workspace_id: workspace ? workspace.id : null, members, task_dir: paths.taskDir, crew_json: join(paths.dir, 'crew.json') })}\n`)
}

function ledgerDbPath() {
  return process.env.DEVTEAM_LEDGER_DB
    || join(process.env.DEVTEAM_LEDGER_DIR || join(homedir(), '.dev-team', 'factory'), 'ledger.db')
}

// A boot refusal and a seat that never came up both happen BEFORE openRun
// (:610) — there is no adw_id to key them on, and the ledger's cell_failures
// table takes a NULL one for exactly this reason. Never load-bearing.
function noteRunlessCellFailure({ taskSlug, role, kind, err, cell = null, member = null }) {
  if (!role) return
  recordCellFailure({
    dbPath: ledgerDbPath(), task_slug: taskSlug, role, kind,
    agent: member?.agent ?? cell?.agent ?? null,
    provider: member?.provider ?? cell?.provider ?? null,
    model_id: member?.id ?? cell?.id ?? null,
    model: member?.model ?? cell?.model ?? null,
    effort: member?.effort ?? cell?.effort ?? null,
    transport: member?.transport ?? null,
    stage: err?.stage ?? null, detail: err?.message ?? null,
  })
}


// Process-level exit codes for `run`, derived from the envelope status and
// nothing else: 0 done, 3 escalation — a run of the loop that WORKED and needs
// a human — and 1 for anything else, which is the unexpected internal error the
// repo's convention reserves it for (scripts/factory/make-brief.mjs:10-12; 2 is
// the usage/refusal code the CLI dispatcher owns). An escalation is not a
// crash: collapsing the two made a preserved plan and a minted park read as
// "failed with exit code 1".
export const RUN_EXIT_CODES = Object.freeze({ done: 0, escalation: 3 })
export const RUN_EXIT_UNEXPECTED = 1
export function runExitCode(result) {
  const status = result?.status
  return typeof status === 'string' && Object.hasOwn(RUN_EXIT_CODES, status)
    ? RUN_EXIT_CODES[status]
    : RUN_EXIT_UNEXPECTED
}

// #779/#774: preserve the legacy status while recording the typed terminal outcome.
export function runOutcome(result) {
  if (result?.status === 'done') return { status: 'ok', outcome: 'success', terminal_reason: null, terminal_actor: null }
  if (result?.status === 'escalation') {
    const { cause, actor } = escalationCause(result?.details?.escalation ?? {})
    return { status: 'aborted', outcome: 'escalated', terminal_reason: cause, terminal_actor: actor }
  }
  return { status: 'aborted', outcome: 'aborted', terminal_reason: typeof result?.status === 'string' ? result.status : null, terminal_actor: 'driver' }
}

// The exit marker (#749, driver half). `run` writes exactly ONE terminal
// line on every exit path this process can reach, so an EMPTY run.log means
// exactly "killed with an uncatchable signal, or hung" and never "unknown".
// The shape is the one factoryctl.mjs:498 already reads back.
export const EXITED_STATUS = 'exited'
// 128 + signal number, the shell's own convention for a signalled death.
export const SIGNAL_EXIT_CODES = Object.freeze({ SIGTERM: 143, SIGINT: 130 })
export const UNCAUGHT_EXIT_CODE = 1

let terminalLineWritten = false
export function terminalLineSeen() { return terminalLineWritten }

// The ONE writer of a terminal line. writeSync(1, …) and not
// process.stdout.write: an 'exit' listener may not defer, and a pipe's async
// write would be dropped on the floor exactly when the marker matters most.
export function writeTerminalLine(payload, write = (text) => writeSync(1, text)) {
  terminalLineWritten = true
  write(`${JSON.stringify(payload)}\n`)
}

// Measured on Node v26.7.0, 2026-08-29: a bare process.on('exit') marker prints
// BEFORE Node's own fatal-exception report even into one merged fd. So the
// stack is printed HERE, first, and the marker follows it — the ordering #749
// asks for, with the stack preserved verbatim.
export function installExitMarker({
  on = (event, handler) => process.on(event, handler),
  write,
  exit = (code) => process.exit(code),
  stderr = (text) => writeSync(2, text),
} = {}) {
  terminalLineWritten = false
  on('uncaughtException', (err) => {
    stderr(`${err && err.stack ? err.stack : String(err)}\n`)
    if (!terminalLineWritten) writeTerminalLine({ status: EXITED_STATUS, code: UNCAUGHT_EXIT_CODE }, write)
    exit(UNCAUGHT_EXIT_CODE)
  })
  on('exit', (code) => {
    if (terminalLineWritten) return
    writeTerminalLine({ status: EXITED_STATUS, code }, write)
  })
  for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
    on(signal, () => {
      if (!terminalLineWritten) writeTerminalLine({ status: EXITED_STATUS, signal }, write)
      exit(SIGNAL_EXIT_CODES[signal])
    })
  }
}

// The completion event (#687). run.log and the journal stay authoritative for
// their own purposes; this is ADDITIVE. One line per finishing run, in a log that
// OUTLIVES the crew dir the run used — because a crew dir is mutable, reusable
// and removable, and the durable record must be none of those.
export function completionRecord({ task, run = null, outcome, commit = null, checkout, crewDir, archived = null, taskReturn, at }) {
  return { at, lane: task, run, outcome, commit, checkout, crew_dir: crewDir, archived, task_return: taskReturn }
}

// APPEND, never write: a second run of the same lane adds a second line and the
// first stays byte-identical. The parent is created because a first run on a new
// machine has no crew root yet. Every failure here is the CALLER's to swallow.
export function appendCompletion(record, deps = {}) {
  const path = deps.path || completionLogPath({ env: deps.env || process.env })
  const append = deps.appendFileSync || appendFileSync
  const mkdir = deps.mkdirSync || mkdirSync
  mkdir(dirname(path), { recursive: true })
  append(path, `${JSON.stringify(record)}\n`)
  return path
}

function completionWarning(err, taskSlug) {
  process.stderr.write(`warning: completion record not appended (${err.message}) — run.log stays the record for ${taskSlug}\n`)
}

// Publication gating is SHAPE-AWARE. "A successful publish tears down" is not a
// repeal of teardown for read-only shapes: crew/variants.mjs declares `scout` as an
// envelope shape with no commit, rebase or publish stage, so requiring details.pr of
// every done run would make every successful scout a permanent live workspace.
export function teardownDecision({ status, variant, published, keep }) {
  if (status !== 'done') return 'escalation'
  if (VARIANTS[variant || DEFAULT_VARIANT]?.execution === 'reviewed' && !published) return 'unpublished'
  if (keep) return 'keep'
  return 'teardown'
}

export function runCmd(args, deps = {}) {
  // Refuse an unknown shape BEFORE any state is read, spawned or written —
  // the same posture as boot's assertCellsClosed and mixed-transport guards.
  const executionRequest = { execution: args.execution, variant: args.variant }
  let executionConfiguration
  try {
    executionConfiguration = resolveRunConfig(executionRequest)
  } catch (err) {
    throw flagNamedAliasError(err)
  }
  // Refuse a malformed budget in the same breath as an unknown shape: before
  // any state is read, spawned or written, and never by falling back to the
  // default (a silently defaulted budget is the ambiguity this flag removes).
  const limits = resolveLimits({ plan_rounds: args['plan-rounds'], build_rounds: args['build-rounds'], review_rounds: args['review-rounds'] })
  const limitsOverlay = limitsCtx(limits)
  // Same posture, same breath: a malformed seat wait budget refuses before any
  // state is read, spawned or written. The deadline a seat is judged against is
  // an orchestrator decision made at dispatch, never one a crew grants itself.
  const waits = resolveWaits({ planner: args['wait-planner'], 'tech-lead': args['wait-tech-lead'], builder: args['wait-builder'], reviewer: args['wait-reviewer'], lead: args['wait-lead'] })
  const waitsOverlay = waitsCtx(waits)
  // Same posture, same breath: a malformed validation lane refuses before any
  // state is read, spawned or written.
  const validationLane = resolveValidationLane({ validationLane: args['validation-lane'], lane: args.lane, fences: args.fences })
  // Same breath again: a shape whose declaration takes an input from the
  // dispatch refuses HERE when the dispatch carries none — before crew state is
  // read and long before a seat is driven.
  assertCtxSources(executionConfiguration.execution.effective, { validationLane })
  const { drive = driveTask, appendCompletion: appendCompletionDep = appendCompletion, awaitSeatsReady: awaitSeatsReadyDep = awaitSeatsReady, writeTerminalLine: writeTerminalLineDep } = deps
  const taskSlug = slug(args.task)
  const checkout = resolvePath(args.checkout || process.cwd())
  const paths = pathsFor(taskSlug, checkout)
  const crew = loadCrew(paths)
  assertSameCheckout(crew, checkout)
  // Resolve twice on purpose: the first pure call refuses malformed dispatch
  // input before state is read; this second call can apply the persisted
  // profile, compatibility matrix and boot-owned provenance to the run.
  const persisted = persistedRunConfig(crew)
  const resolved = resolveRunConfig({ profile: persisted.profile?.effective ?? undefined, ...executionRequest })
  const runConfiguration = Object.freeze({ profile: persisted.profile, execution: resolved.execution, assurance: persisted.assurance })
  writeAliasDeprecations(resolved)
  const variant = runConfiguration.execution.effective
  if (!args['brief-file']) throw new Error('run requires --brief-file <path to the task brief>')
  const briefFile = resolvePath(args['brief-file'])
  if (!existsSync(briefFile)) throw new Error(`brief file not found: ${briefFile}`)
  // The driver assigns planner/builder/reviewer unconditionally — discover a
  // missing seat NOW, not mid-loop after a plan and a build are spent.
  assertSeats(crew, variant)
  const filesInScope = resolveFilesInScope(
    args, variant, crew.task_return ? resolvePath(paths.dir, crew.task_return) : join(paths.returnsDir, 'task.json'),
  )
  // The scope gate reads `git status` as ground truth — a dirty checkout at
  // start would be attributed to the builder and poison every scope verdict.
  const dirty = execSync('git status --porcelain', { cwd: checkout, encoding: 'utf8' }).trim()
  if (dirty) throw new Error(`checkout is dirty — commit or stash before a crew run:\n${dirty.split('\n').slice(0, 10).join('\n')}`)

  const journal = join(paths.dir, 'journal.jsonl'); const head = readHead(checkout); logLine(journal, { at: new Date().toISOString(), event: RUN_START_EVENT, head, variant, task: taskSlug })
  const protectedFloor = checkoutProtectedPaths({ checkout })
  logLine(journal, { at: new Date().toISOString(), event: 'protected-paths',
    basis: protectedFloor.basis, count: protectedFloor.paths.length })
  logLine(journal, { at: new Date().toISOString(), event: 'limits', ...limitsRecord(limits, LIMITS) })
  // The EFFECTIVE per-role seat wait budget and its source, recorded on every
  // run: an expiry escalation reads differently against a budget the operator
  // set than against the default.
  logLine(journal, { at: new Date().toISOString(), event: 'waits', ...waitsRecord(waits, WAITS_S) })
  // The EFFECTIVE round validation lane and its source, recorded on every run:
  // an escalation at the lane stage reads differently when no lane was declared.
  logLine(journal, { at: new Date().toISOString(), event: 'validation-lane', lane: validationLane.lane, source: validationLane.source })
  logLine(journal, { at: new Date().toISOString(), event: 'run-configuration', run_configuration: runConfiguration })
  if (crew.advisor?.granted?.length) {
    const runStartedAt = Date.now()
    const briefText = readFileSync(briefFile, 'utf8')
    const manifest = advisorManifest({ briefText, task: taskSlug, runStartedAt })
    const manifestPath = join(paths.taskDir, 'advisor-manifest.json')
    const temporaryPath = `${manifestPath}.tmp`
    let written = false
    let writeReason = null
    if (manifest) {
      try {
        writeFileSync(temporaryPath, JSON.stringify(manifest))
        renameSync(temporaryPath, manifestPath)
        written = true
      } catch (err) {
        writeReason = 'write-failed'
      }
    } else {
      try { unlinkSync(manifestPath) } catch (err) {
        if (err?.code !== 'ENOENT') writeReason = 'remove-failed'
      }
      writeReason ||= 'tripwire-tests-absent'
    }
    logLine(journal, { at: new Date().toISOString(), event: 'advisor-manifest',
      written, count: manifest?.tripwires?.length || 0, reason: writeReason })
    assertAdvisorManifest({ granted: crew.advisor.granted, manifest, written })
  }
  const laneFence = Array.isArray(crew.lane_fence) ? crew.lane_fence : null
  if (laneFence) {
    logLine(journal, { at: new Date().toISOString(), event: 'lane-fence',
      lane_name: crew.lane_name ?? null, lanes: laneFence.length,
      files: laneFence.reduce((n, record) => n + record.files.length, 0) })
  }
  // Keep the test lane at 30 s per test: the slowest real test is ~25 ms,
  // giving ~1200× headroom even when the machine is saturated by three crews.
  // This is well below seatIo.run's 900 s kill, so a hung test is reported by
  // name as timed out instead of ending as an anonymous SIGTERM.
  // --test-timeout is per-test: it bounds one hung test, not a pathological
  // whole-suite case. A wall-clock bound on the lane would be a driver change,
  // deliberately not done here. Read the suite command from package.json's
  // scripts.test owner; crew/crew.test.mjs pins that both run entrypoints
  // derive from it.
  const ctx = {
    task: taskSlug, briefFile, taskDir: paths.taskDir, checkout, journal, head,
    protectedPaths: protectedFloor.paths,
    protectedPathsBasis: protectedFloor.basis,
    ...(laneFence ? { laneFence, laneName: crew.lane_name ?? null } : {}),
    roles: crew.roles, lane: validationLane.lane, suite: args.suite || packageSuite(), variant,
    publish: { branch: readBranch(checkout) },
    ...(limitsOverlay ? { limits: limitsOverlay } : {}),
    ...(waitsOverlay ? { waits: waitsOverlay } : {}),
    ...(filesInScope ? { files_in_scope: filesInScope } : {}),
  }
  // Run never launches a seat, so chrome is the right evidence HERE; the fresh
  // gate now lives in boot. Seats are TUI processes and the first assignment
  // must not race their boot: characters typed into a pty before the TUI grabs
  // it are silently swallowed (live-hit 2026-08-13 — the leading chunk of the
  // first assignment vanished on both crews). Gate on each seat actually
  // replying ready (or, as a fallback, rendering agent chrome) before driving.
  try {
    awaitSeatsReadyDep(crew, 'warm', journal)
  } catch (err) {
    for (const role of err.roles || []) {
      noteRunlessCellFailure({ taskSlug, role, kind: 'seat-not-ready', err, member: crew.members[role] })
    }
    throw err
  }

  // The factory ledger mirror (#94). openRun() never throws and degrades
  // to an inert emitter; the extra try/catch covers a caller-side surprise
  // (a bad path, an unwritable home) so instrumentation can never take a
  // crew run down. nodeVersion is deliberately NOT passed: openLedger's own
  // default is process.versions.node, and passing process.version silently
  // fails the ledger floor parse and drops every mirror row.
  // Pass the resolved brief so bootProposal reads its optional compiler
  // proposal block; this run's boot record has no brief_file key, so a missing
  // or blockless brief still records null proposal fields.
  let emitter = null
  try {
    emitter = openRun({ stateDir: paths.dir, repoSlug: paths.repo, taskSlug, dbPath: ledgerDbPath(), briefPath: briefFile })
    emitter.startRun()
  } catch { emitter = null }

  const io = seatIo(crew, paths, checkout, emitter, null, args)
  // A throw out of the driver (member timeout, dead pane, git failure) is an
  // OUTCOME, not a stack trace: it must still produce a task envelope, or a
  // concurrent `crew.mjs wait` spins its full timeout for nothing.
  let result
  try {
    result = drive(ctx, io)
  } catch (err) {
    logLine(journal, { at: new Date().toISOString(), event: 'driver-crash', error: err.message })
    result = {
      status: 'escalation',
      summary: `Task ${taskSlug} needs a human: the driver crashed (${err.message})`,
      artifacts: [journal],
      details: { stages: stagesFromJournal(journal), commit: null, dissents: [], escalation: { where: err.stage || 'driver', why: err.message } },
    }
  }
  // Outcome-gated recovery state (#165): an escalation leaves a parked/null
  // park whose seats are this crew's, and the attention event carries its id.
  // A mint failure is loud but non-fatal (ADR-029 §4 amendment): the run still
  // escalates, and the workspace it never tears down stays the fallback
  // context.
  const { park_id, error: parkError } = parkOnOutcome(result, {
    crew, runId: emitter?.adwId || `${taskSlug}-${new Date().toISOString()}`,
    dir: join(paths.dir, 'reclaim'), actor: `crew:${taskSlug}`,
    reason: result.details?.escalation?.why || result.summary || '',
  })
  if (parkError) {
    logLine(journal, { at: new Date().toISOString(), event: 'park-mint-failed', error: parkError })
    process.stderr.write(`warning: could not mint an escalation park (${parkError}) — the workspace at ${paths.dir} is the recovery context\n`)
  }
  if (result.status === 'escalation') {
    const attention = escalationAttention({
      task: taskSlug, park_id,
      why: result.details?.escalation?.why || result.summary || '',
      artifacts: result.artifacts || [],
    })
    logLine(journal, { at: new Date().toISOString(), ...attention })
    try { io.emit?.(attention) } catch { /* instrumentation is never load-bearing */ }
  }
  // The task envelope is written by CODE — same path `wait` watches. It is
  // written BEFORE the seats are settled: a worker that refuses to die must
  // never change the run's recorded outcome.
  writeFileSync(crew.task_return, JSON.stringify(result, null, 2))
  settleSeatTeardown(io)
  try { emitter?.endRun(runOutcome(result)) } catch { /* never load-bearing */ }

  // Outcome-gated lifecycle, in code as policy:
  //   done       -> auto-teardown (archive the record, close the view),
  //                 unless --keep was passed for pane inspection.
  //   escalation -> NEVER teardown: the workspace IS the escalation context
  //                 (warm members, readable panes) the human needs.
  // An archive failure degrades to a warning: it must never turn an
  // already-committed task into a reported error.
  const lifecycle = teardownDecision({ status: result.status, variant, published: Boolean(result.details?.pr), keep: Boolean(args.keep) })
  let archived = null
  if (lifecycle === 'teardown') {
    try { archived = teardownCore(paths, crew, { io }).archived } catch (err) {
      process.stderr.write(`warning: teardown/archive failed (${err.message}) — crew dir left at ${paths.dir}\n`)
    }
  }
  // After archive the envelope moves with the dir — report where it lives now.
  const taskReturn = archived ? crew.task_return.replace(paths.dir, archived) : crew.task_return
  // The completion event, written BEFORE the process can exit and AFTER the
  // archive has moved the envelope, so the record names where it actually lives.
  // Best-effort, exactly the posture the archive failure above takes: a warning,
  // never an error, and never a change to the status, exit code or terminal line.
  const completion = completionRecord({
    task: taskSlug, run: emitter?.adwId ?? null, outcome: result.status,
    commit: result.details?.commit ?? null, checkout, crewDir: paths.dir,
    archived, taskReturn, at: new Date().toISOString(),
  })
  try { appendCompletionDep(completion) } catch (err) { completionWarning(err, taskSlug) }
  writeTerminalLine({ status: result.status, commit: result.details?.commit ?? null, task_return: taskReturn, archived }, writeTerminalLineDep)
  process.exitCode = runExitCode(result)
}

// The run-start anchor. A crew dir's journal is append-only ACROSS runs, so the
// stage list a crashed run's envelope carries must be bounded to the run that
// crashed. This row is that boundary, and it carries the HEAD the run began at.
export { RUN_START_EVENT }

// The checkout's HEAD at run start (#583 §1.4): nothing in crew/ records it
// today, and without it a resume cannot refuse "the worktree has moved on".
export function readHead(checkout, deps = {}) {
  const exec = deps.execSync || execSync
  let out
  try { out = exec('git rev-parse HEAD', { cwd: checkout, encoding: 'utf8' }) }
  catch { return null }              // a git that cannot answer is an ABSENT head, never a dead run
  return String(out).trim() || null
}

export function readBranch(checkout, deps = {}) {
  const exec = deps.execSync || execSync
  let out
  try { out = exec('git symbolic-ref --quiet --short HEAD', { cwd: checkout, encoding: 'utf8' }) }
  catch { return null }
  const branch = String(out).trim()
  return !branch || branch === 'HEAD' ? null : branch
}

// The stage list a crashed run's envelope carries. The driver's `S` dies with
// the throw, so the stages are read back from the journal this run already
// wrote: stage() logs one `{ stage: <label> }` row per entry (crew/drive.mjs)
// and the scan restarts at every run-start row, so only THIS run's stages come
// back. `null` means the journal itself was unreadable — which is not the same
// claim as "no stage ran".
export function stagesFromJournal(path, deps = {}) {
  const read = deps.readFileSync || readFileSync
  let text
  try { text = String(read(path, 'utf8')) } catch { return null }
  const stages = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (row?.event === RUN_START_EVENT) { stages.length = 0; continue }
    if (typeof row?.stage === 'string') stages.push(row.stage)
  }
  return stages
}

// A seat's readiness, layered so it stays agent-agnostic:
// 1. PRIMARY: the seat's own ready reply. Every boot brief instructs exactly
//    `ready: <role>`, and the brief's own text says the literal "your-role",
//    so the echoed brief can never satisfy a real role's pattern.
// 2. FALLBACK: agent TUI chrome, for panes that have scrolled past the reply
//    (re-runs against a long-lived workspace). Loose by design and documented
//    as second-rate evidence: chrome proves the TUI is up, not that the seat
//    read its brief. A false positive costs one assignment typed a beat early;
//    a false negative costs a 120s hang and a killed boot.
export const READY_CHROME = Object.freeze([
  /bypass permissions|shift\+tab to cycle|❯/, // claude
  /\(sub\)|\s•\s/, // pi status line: "$0.000 (sub) … gpt-5.6-luna • high"
])
export function seatReadySignal(screen, role) {
  const s = String(screen || '')
  if (new RegExp(`ready:\\s*${role}\\b`, 'i').test(s)) return 'ready-reply'
  return READY_CHROME.some((re) => re.test(s)) ? 'chrome' : null
}

// A seat launched with the boot brief in its argv is judged in `fresh` mode and
// ONLY its own ready reply clears it: READY_CHROME's claude pattern includes the
// bare `❯`, which the SHELL paints before the agent process exists, so chrome on a
// fresh pane is evidence of a prompt, not of a seat (#741 — 81 of 85 seat-ready
// rows on 2026-08-29 were chrome, inside 50ms of boot, and two lanes had their
// first assignment typed into a pane no agent was reading yet). A re-run against
// a long-lived workspace is judged in `warm` mode, where the reply has scrolled away
// and chrome is the only evidence left. The mode is the CALLER's to state - boot
// launched the seats, run did not - and is never inferred from the screen.
export const SEAT_READY_MODES = Object.freeze(['fresh', 'warm'])
// A fresh reply arrives tens of seconds after launch on a loaded host, and a false
// negative now kills a boot instead of swallowing an assignment; warm keeps the
// 120s it has always had.
export const SEAT_READY_FRESH_TIMEOUT_S = 180
export const SEAT_READY_WARM_TIMEOUT_S = 120

export function awaitSeatsReady(crew, mode, journal = null, deps = {}) {
  if (mode !== 'fresh' && mode !== 'warm') {
    throw new Error(`awaitSeatsReady needs an explicit readiness mode (${SEAT_READY_MODES.join(' or ')}), got ${JSON.stringify(mode ?? null)}`)
  }
  const timeoutS = mode === 'fresh' ? SEAT_READY_FRESH_TIMEOUT_S : SEAT_READY_WARM_TIMEOUT_S
  const cmuxFn = deps.cmux || cmux
  const logLineFn = deps.logLine || logLine
  const now = deps.now || (() => Date.now())
  const sleep = deps.sleep || ((ms) => {
    const sab = new SharedArrayBuffer(4)
    Atomics.wait(new Int32Array(sab), 0, 0, ms)
  })
  const deadline = now() + timeoutS * 1000
  const pending = new Set(Object.keys(crew.members).filter((role) => crew.members[role].surface_id))
  const lastSignal = new Map()
  const recorded = new Set()
  while (pending.size > 0) {
    for (const role of [...pending]) {
      const res = cmuxFn('read-screen', ['--surface', crew.members[role].surface_id, '--lines', '40'])
      const sig = (res.ok && seatReadySignal(res.stdout, role)) || null
      if (!sig) continue
      lastSignal.set(role, sig)
      const accepted = sig === 'ready-reply' || (mode === 'warm' && sig === 'chrome')
      // One row per seat per distinct signal: a rejected chrome match repeats on
      // every poll and the journal is evidence, not a tape of the screen.
      if (journal && !recorded.has(`${role}:${sig}`)) {
        recorded.add(`${role}:${sig}`)
        logLineFn(journal, { at: new Date().toISOString(), event: 'seat-ready', role, signal: sig, mode, accepted })
      }
      if (accepted) pending.delete(role)
    }
    if (pending.size === 0) break
    if (now() > deadline) {
      const detail = [...pending].map((role) => `${role} (last signal: ${lastSignal.get(role) || 'none'})`).join(', ')
      const err = new Error(`seats never became ready within ${timeoutS}s (mode: ${mode}): ${detail}`)
      err.roles = [...pending]
      err.mode = mode
      err.signals = Object.fromEntries([...pending].map((role) => [role, lastSignal.get(role) || null]))
      throw err
    }
    sleep(2000)
  }
}

// A reviewed shape (required_seats: 'tier') has planner/builder/reviewer
// assigned unconditionally by the driver; an ENVELOPE shape declares the seats
// it actually runs (crew/variants.mjs) and crew/drive.mjs runs exactly those,
// so demanding the tier three would refuse a shape this runtime ships. The
// lead is required ONLY if the crew was booted with one: a lead-less crew
// (mechanical tier) is valid, and drive.mjs escalates where it would consult.
export function assertSeats(crew, variant = DEFAULT_VARIANT) {
  const declared = VARIANTS[variant]?.required_seats
  for (const role of Array.isArray(declared) ? declared : ['planner', 'builder', 'reviewer']) {
    if (!crew.members[role]) throw new Error(`v3 run requires a ${role} seat (booted roles: ${crew.roles.join(', ')})`)
  }
  if (crew.roles.includes('lead') && !crew.members.lead) {
    throw new Error(`v3 run requires a lead seat (booted roles: ${crew.roles.join(', ')})`)
  }
}

// pathsFor keys on the checkout BASENAME — assert the crew on disk actually
// belongs to the checkout this command is about to drive against.
function assertSameCheckout(crew, checkout) {
  if (crew.checkout && crew.checkout !== checkout) {
    throw new Error(`this crew was booted for ${crew.checkout}, not ${checkout} — same directory name, different checkout`)
  }
}

// v2 legacy: hand the whole task to the LEAD as the driver (agent-driven).
function handoffCmd(args) {
  const taskSlug = slug(args.task)
  const checkout = resolvePath(args.checkout || process.cwd())
  const paths = pathsFor(taskSlug, checkout)
  const crew = loadCrew(paths)
  assertSameCheckout(crew, checkout)
  if (!args['brief-file']) throw new Error('handoff requires --brief-file <path to the task brief>')
  const briefFile = resolvePath(args['brief-file'])
  if (!existsSync(briefFile)) throw new Error(`brief file not found: ${briefFile}`)
  if (!crew.members.lead) throw new Error(`handoff needs a lead seat; this crew was booted lead-less (roles: ${crew.roles.join(', ')})`)

  const line = `TASK: run this task end to end. Read the brief at ${briefFile} and the crew map at ${join(paths.dir, 'crew.json')}. Drive the crew, verify, commit on green, then write your ReturnEnvelope to ${crew.task_return} and print CREW-DONE lead task`
  sendLine(crew.members.lead.surface_id, line)
  logLine(join(paths.dir, 'journal.jsonl'), { at: new Date().toISOString(), event: 'handoff', brief: briefFile })
  process.stdout.write(`${JSON.stringify({ handed_to: 'lead', task_return: crew.task_return })}\n`)
}

// The newest archived task envelope for a torn-down crew, or null. run's
// auto-teardown moves the whole dir — wait/status must be able to follow it
// rather than reporting "no crew booted" for a task that COMPLETED.
function archivedReturn(paths) {
  const parent = dirname(paths.dir)
  const base = `${paths.dir.split('/').pop()}.archive-`
  if (!existsSync(parent)) return null
  const archives = readdirSync(parent).filter((n) => n.startsWith(base)).sort()
  for (let i = archives.length - 1; i >= 0; i -= 1) {
    const p = join(parent, archives[i], 'returns', 'task.json')
    if (existsSync(p)) return p
  }
  return null
}

// The wait ceiling, closed-set: the same posture as crew/limits.mjs:29-42 and
// crew/drive.mjs:71-84. `Number()` was the defect — Number('abc') is NaN,
// Date.now() < NaN is false, and waitCmd's loop body never ran once, so a
// SETTLED done run was reported as still-running with exit 1 (repro
// docs/audits/2026-08-23/hunt/h2/repro/A-04-timeout-wrong-answer.mjs). 0x10
// silently meant 16 s and Infinity meant unbounded.
export const TIMEOUT_S_REFUSAL = 'invalid-timeout-s'
export const TIMEOUT_S_DEFAULT = 3600
export const TIMEOUT_S_MIN = 1
export const TIMEOUT_S_MAX = 21600   // the WAIT_SECONDS_MAX sibling (crew/drive.mjs:60)
export function resolveTimeoutS(raw) {
  if (raw === undefined || raw === null) return TIMEOUT_S_DEFAULT
  const bad = () => Object.assign(
    new Error(`--timeout-s must be a whole number of seconds between ${TIMEOUT_S_MIN} and ${TIMEOUT_S_MAX}, got ${JSON.stringify(raw)} [${TIMEOUT_S_REFUSAL}]`),
    { reason: TIMEOUT_S_REFUSAL },
  )
  if (typeof raw !== 'number' && typeof raw !== 'string') throw bad()
  const text = typeof raw === 'number' ? String(raw) : raw.trim()
  if (!/^[0-9]+$/.test(text)) throw bad()
  const value = Number(text)
  if (!Number.isInteger(value) || value < TIMEOUT_S_MIN || value > TIMEOUT_S_MAX) throw bad()
  return value
}

function waitCmd(args) {
  const taskSlug = slug(args.task)
  const checkout = resolvePath(args.checkout || process.cwd())
  const paths = pathsFor(taskSlug, checkout)
  // No loadCrew here: the live dir may vanish mid-wait when run auto-tears
  // down on done — poll the live envelope path AND the archive fallback.
  const livePath = join(paths.returnsDir, 'task.json')
  const timeoutMs = resolveTimeoutS(args['timeout-s']) * 1000
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const p of [livePath, archivedReturn(paths)]) {
      if (!p || !existsSync(p)) continue
      let env = null
      try { env = JSON.parse(readFileSync(p, 'utf8')) } catch { env = null }
      if (env && typeof env.status === 'string') {
        process.stdout.write(`${JSON.stringify({ status: env.status, summary: env.summary, artifacts: env.artifacts || [], details: env.details || {}, task_return: p })}\n`)
        return
      }
    }
    const sab = new SharedArrayBuffer(4)
    Atomics.wait(new Int32Array(sab), 0, 0, 5000)
  }
  process.stdout.write(`${JSON.stringify({ status: 'still-running' })}\n`)
  process.exitCode = 1
}

export function seatLiveness(crew, probe = paneAlive) {
  const alive = {}
  for (const [role, m] of Object.entries(crew.members)) alive[role] = m.surface_id ? probe(m.surface_id) : 'headless'
  return alive
}

function statusCmd(args) {
  const taskSlug = slug(args.task)
  const checkout = resolvePath(args.checkout || process.cwd())
  const paths = pathsFor(taskSlug, checkout)
  if (!existsSync(join(paths.dir, 'crew.json'))) {
    const archived = archivedReturn(paths)
    if (archived) { process.stdout.write(`${JSON.stringify({ task: taskSlug, archived: true, task_return: archived })}\n`); return }
  }
  const crew = loadCrew(paths)
  assertSameCheckout(crew, checkout)
  const alive = seatLiveness(crew)
  process.stdout.write(`${JSON.stringify({ task: crew.task, workspace_id: crew.workspace_id, alive })}\n`)
}

// The drain's budgets. STATED DEFAULT, REVISE WHEN MEASURED: #649 asks for a
// bound chosen from measurement and no such measurement exists yet, so these
// numbers are declared defaults and are labelled as such rather than dressed up
// as evidence. Teardown runs AFTER a lane is already terminal, so a seat still
// writing its envelope needs seconds; anything longer is a hang, and the right
// response to a hang is to RECORD it and proceed, never to wait longer.
// Teardown's reliability outranks this feature, which is why both bounds are
// small — stated default, revise when measured.
export const TEARDOWN_DRAIN_MS = 60_000
// The error path — a teardown whose run never reached a `done` envelope — takes
// the shorter bound: nothing is expected to arrive, so waiting buys less, and
// the abnormal path is exactly where a hang is likeliest. Same basis as its
// sibling above: stated default, revise when measured.
export const TEARDOWN_DRAIN_ERROR_MS = 10_000
// One poll per half second, plus a hard poll cap so a clock that never advances
// cannot spin. The bound that DECIDES is the wall clock, never this cap.
const DRAIN_POLL_MS = 500
const DRAIN_MAX_POLLS = Math.ceil(TEARDOWN_DRAIN_MS / DRAIN_POLL_MS)

// The assignments this run made, read the way stagesFromJournal reads stages
// (:1921): the journal is append-only ACROSS runs, so the scan restarts at every
// run-start row and only THIS run's assignments come back. `null` means the
// journal itself was unreadable — which is not the same claim as "nothing was
// assigned".
export function assignmentsFromJournal(path, deps = {}) {
  const read = deps.readFileSync || readFileSync
  let text
  try { text = String(read(path, 'utf8')) } catch { return null }
  const open = new Map()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (row?.event === RUN_START_EVENT) { open.clear(); continue }
    if (typeof row?.assign === 'string' && typeof row?.role === 'string') open.set(row.assign, { id: row.assign, role: row.role })
  }
  return [...open.values()]
}

// The ERROR PATH, decided from evidence rather than from a caller's word: a run
// that reached `done` wrote its task envelope before teardown (:1877), so an
// envelope that is missing, unreadable or not `done` IS the error path. Any
// doubt takes the SHORTER bound — teardown reliability outranks the wait.
function drainErrorPath(returnsDir, deps = {}) {
  const exists = deps.existsSync || existsSync
  const read = deps.readFileSync || readFileSync
  const path = join(returnsDir, 'task.json')
  if (!exists(path)) return true
  try { return JSON.parse(String(read(path, 'utf8')))?.status !== 'done' } catch { return true }
}

// What teardown is about to throw away. An assignment with no envelope file is
// IN FLIGHT — the driver assigns `d<n>` to a role and the seat writes
// `returns/d<n>.<role>.json`, so this is a filesystem question answerable
// synchronously, before anything is closed. Best-effort by contract: the whole
// body is guarded and a fault comes back as a RECORD, never as a throw, because
// a drain that can prevent a teardown is worse than no drain.
function drainForTeardown(paths, deps = {}) {
  try {
    const now = deps.now || (() => Date.now())
    const sleep = deps.sleep || ((ms) => {
      const sab = new SharedArrayBuffer(4)
      Atomics.wait(new Int32Array(sab), 0, 0, ms)
    })
    const exists = deps.existsSync || existsSync
    const returnsDir = paths.returnsDir || join(paths.dir, 'returns')
    const assignments = assignmentsFromJournal(join(paths.dir, 'journal.jsonl'), deps)
    if (!assignments) return null
    const pendingOf = (list) => list.filter((a) => !exists(join(returnsDir, `${a.id}.${a.role}.json`)))
    const inflight = pendingOf(assignments)
    // An empty in-flight set is an ABSENCE, not a measured zero: a teardown that
    // threw nothing away gets no row at all, exactly as a crew with no pane seat
    // gets no sweep line.
    if (!inflight.length) return null
    const errorPath = drainErrorPath(returnsDir, deps)
    const budgetMs = errorPath ? TEARDOWN_DRAIN_ERROR_MS : TEARDOWN_DRAIN_MS
    const startedAt = now()
    const deadline = startedAt + budgetMs
    let open = inflight
    let polls = 0
    while (open.length && now() < deadline && polls < DRAIN_MAX_POLLS) {
      polls += 1
      sleep(DRAIN_POLL_MS)
      open = pendingOf(open)
    }
    return {
      inflight: inflight.length,
      drained: inflight.length - open.length,
      // The archive-stable RELATIVE locator, never the pre-rename absolute path:
      // this row is written before the archive rename.
      abandoned: open.map((a) => ({ id: a.id, role: a.role, return: `returns/${a.id}.${a.role}.json` })),
      waited_ms: now() - startedAt,
      budget_ms: budgetMs,
      error_path: errorPath,
      polls,
    }
  } catch (err) {
    return { inflight: null, drained: null, abandoned: [], waited_ms: null, budget_ms: null, error_path: null, polls: 0, error: err.message }
  }
}

// Archive the crew dir (the durable record: envelopes, journal, artifacts)
// and close the ephemeral view (panes, workspace). Everything evidentiary is
// on disk by contract before this runs — deliverables live in files, never
// pane scrollback.
export function teardownCore(paths, crew, deps = {}) {
  const closeSurfaceFn = deps.closeSurface || closeSurface
  const closeWorkspaceFn = deps.closeWorkspace || closeWorkspace
  const renameSyncFn = deps.renameSync || renameSync
  const paneRowsFn = deps.paneTeardownRows || paneTeardownRows
  const settleFn = deps.settle || settleSeatTeardown
  const io = deps.io || null
  // MEASURE BEFORE THE FIRST CLOSE. What was in flight is a fact about the live
  // crew dir, and the loop below destroys the seats that would still be writing
  // it: a drain bolted on after the closes measures nothing. The ROW is written
  // after the closes because what it records is a FINISHED measurement, and a
  // journal write must never delay a close.
  const drain = drainForTeardown(paths, deps)
  for (const m of Object.values(crew.members)) if (m.surface_id) closeSurfaceFn(m.surface_id)
  if (drain) try { io?.log?.({ at: new Date().toISOString(), event: 'teardown-drain', ...drain }) } catch { /* the journal is never load-bearing */ }
  // The viewer is not in crew.members, so the loop above never sees it, and
  // close-workspace is documented to no-op while a live pane occupies the
  // workspace — close it by id rather than trusting the workspace close.
  if (crew.doc_viewer?.surface_id) closeSurfaceFn(crew.doc_viewer.surface_id)
  if (crew.workspace_id) closeWorkspaceFn(crew.workspace_id)
  // Probe HERE and nowhere else: a live pane is not evidence about a close that
  // has not happened yet, and the journal this settle writes lives in the dir
  // the rename below moves. An empty row list is an ABSENCE, not a measured
  // zero — a crew with no pane seat gets no sweep line at all, because that
  // false zero is the whole defect this records against.
  const rows = paneRowsFn(crew, deps)
  const seats = rows.length
    ? settleFn({ teardown: () => rows, log: io?.log, emit: io?.emit })
    : null
  const seatsAbsent = seats ? null : teardownAbsentCause(crew)
  if (seatsAbsent) try { io?.log?.({ at: new Date().toISOString(), event: 'seat-teardown-absent', cause: seatsAbsent }) } catch { /* the journal is never load-bearing */ }
  const descendantTaskDir = paths.taskDir || join(paths.dir, 'task')
  const settleRootsFn = deps.settleSeatRoots || settleSeatRoots
  const reclaimFn = deps.reclaimDescendants || reclaimDescendants
  let roots = null
  let descendants = null
  try { roots = settleRootsFn({ taskDir: descendantTaskDir, log: io?.log }) }
  catch (err) { try { io?.log?.({ at: new Date().toISOString(), event: 'seat-root-settle-failed', error: err.message }) } catch {} }
  try { descendants = reclaimFn({ taskDir: descendantTaskDir, log: io?.log, emit: io?.emit }) }
  catch (err) { try { io?.log?.({ at: new Date().toISOString(), event: 'descendant-reclaim-failed', error: err.message }) } catch {} }
  // INVARIANT — one writer at a time, CONDITIONALLY. Three sweeps have just run
  // over this crew's writers: the pane seats, then their seat ROOTS, then their
  // descendant groups. Whether they SETTLED them is exactly what
  // fingerprintWithheld below adjudicates, and the invariant holds only on the
  // branch where it does:
  //
  //   withheld === null  -> the three sweeps support that invariant:
  //                         from here until the archive rename the driver (or
  //                         the operator recovering it) is the ONLY thing that
  //                         may write into this checkout, so a later change to
  //                         the tree means a writer nobody accounted for. A
  //                         baseline is recorded, and checkRecordedTree
  //                         (crew/tree-fingerprint.mjs) turns that later change
  //                         from a discovery into a stated fact.
  //   withheld !== null  -> the invariant is UNPROVED — a pane, a seat root or a
  //                         descendant group was not seen dead, or the summary
  //                         cannot tell an unresolved row from a receipt
  //                         failure. NO baseline is recorded, and the cause says
  //                         which. Saying "one writer" here would state as fact
  //                         the opposite of the data beside it.
  //
  // Why this exists: on b175-paneusage a seat still alive during a hand recovery
  // applied one of its own gate kill-mutations here, and it merged by ordering
  // luck alone. The scope gate cannot see that — it adjudicates PATHS, not
  // content, and it runs before a run, never during a recovery. Detect and
  // report: nothing here blocks, kills or reverts.
  //
  // A PROVEN PANE TALLY IS NOT PROOF OF DEATH. `seats` speaks only about panes;
  // `roots` and `descendants` speak about the OS processes behind them, and
  // either sweep can come back null (it threw, :2143-2146) or measured but
  // unresolved. fingerprintWithheld consumes all four, so a still-live seat
  // root can never license a baseline over the tree it is writing.
  //
  // LEASE DECISION: no. A real writer lease — atomic, acquired, its holder
  // nameable — is deliberately NOT built, and the reason is recorded here so
  // the next reader does not re-derive it: this checkout has exactly ONE
  // legitimate writer by design, so the failure mode is never contention
  // between two writers that a lease would arbitrate; it is a seat that should
  // already be dead. A lease would not have stopped b175 either — the stale
  // seat held none to lose and would have written anyway. Detection was what
  // was missing; exclusion was not. Introducing a SECOND legitimate writer is
  // the trigger to revisit this, and it belongs to its own lane.
  //
  // Recording is instrumentation and never load-bearing: a teardown that works
  // today behaves exactly as it does today, plus the record.
  const recordFingerprintFn = deps.recordTreeFingerprint || recordTreeFingerprint
  const withheld = fingerprintWithheld({ seats, seatsAbsent, roots, descendants })
  let fingerprint = null
  try {
    fingerprint = withheld
      ? { recorded: false, path: null, withheld: withheld.cause, detail: withheld.detail }
      : recordFingerprintFn(paths.dir, crew?.checkout ?? null, { task: crew?.task ?? null, seats, roots, descendants }, deps)
  } catch (err) {
    fingerprint = { recorded: false, path: null, error: err.message }
  }
  // The journal row carries the archive-stable RELATIVE name, never the
  // pre-rename absolute path: this row is written before the rename below, and
  // an absolute path that stops existing one line later is not a locator.
  try { io?.log?.({ at: new Date().toISOString(), event: 'tree-fingerprint', recorded: fingerprint.recorded === true, file: fingerprint.recorded === true ? FINGERPRINT_FILE : null, withheld: fingerprint.withheld ?? null, absent: fingerprint.absent ?? null, error: fingerprint.error ?? null }) } catch { /* the journal is never load-bearing */ }
  // Full timestamp, not date-only: a second same-day run of the same slug must never ENOTEMPTY onto the first run's archive.
  const archived = `${paths.dir}.archive-${new Date().toISOString().replace(/[:.]/g, '-')}`
  renameSyncFn(paths.dir, archived)
  // The record moved with the dir, so rebase its locator onto the archive: the
  // absolute path recordTreeFingerprint returned named the pre-rename dir and
  // does not exist any more.
  if (fingerprint?.recorded === true) fingerprint = { ...fingerprint, path: join(archived, FINGERPRINT_FILE), file: FINGERPRINT_FILE }
  return { archived, seats, seats_absent: seatsAbsent, roots, descendants, fingerprint, drain }
}
export function teardownCmd(args, deps = {}) {
  const taskSlug = slug(args.task)
  const checkout = resolvePath(args.checkout || process.cwd())
  const paths = pathsFor(taskSlug, checkout)
  const crew = loadCrew(paths)
  assertSameCheckout(crew, checkout)
  // The run that owned these seats already minted the sidecar in this dir, so
  // openRun ADOPTS its adw_id (scripts/factory/emit.mjs:631) and the rows land
  // on the right run. openRun never throws and degrades to an inert emitter;
  // startRun is deliberately not called — this verb is not a run.
  const openRunFn = deps.openRun || openRun
  let emitter = null
  try { emitter = openRunFn({ stateDir: paths.dir, repoSlug: paths.repo, taskSlug, dbPath: ledgerDbPath() }) } catch { emitter = null }
  const io = deps.io || {
    log: (row) => logLine(join(paths.dir, 'journal.jsonl'), row),
    ...(emitter ? { emit: emitAdapter(emitter, crew) } : {}),
  }
  let record
  try { record = teardownCore(paths, crew, { ...deps, io }) }
  finally { try { emitter?.dispose() } catch { /* instrumentation is never load-bearing */ } }
  const { archived, seats } = record
  const tally = seats ? { seats: seats.seats, proven: seats.proven, failed: seats.failed, unproven: seats.unproven, recorded: seats.recorded, record_failed: seats.record_failed } : null
  process.stdout.write(`${JSON.stringify({ archived, seats: tally, seats_absent: record.seats_absent ?? null, fingerprint: record.fingerprint ?? null })}\n`)
  // A seat this verb could not prove dead — `failed` (measured alive) and
  // `unproven` (unknown) alike — or a row that never reached the ledger, is a
  // RESULT, not a silent success. `proven !== seats` covers both non-proven
  // outcomes with one comparison; do not special-case one of them.
  if (seats && (seats.proven !== seats.seats || seats.recorded !== seats.seats)) process.exitCode = TEARDOWN_EXIT_UNPROVEN
  const d = record.descendants
  if (d && (d.incomplete > 0 || d.record_failed > 0)) process.exitCode = TEARDOWN_EXIT_UNPROVEN
  // An ABSENCE is neither a success nor a measured failure: it gets its own
  // status, and a measured failure above OUTRANKS it — 1 is never downgraded
  // to 4. `!seats` is exactly `rows.length === 0` in teardownCore (:2134-2136).
  if (!seats && process.exitCode !== TEARDOWN_EXIT_UNPROVEN) process.exitCode = TEARDOWN_EXIT_SEATLESS
  return record
}

// Teardown's exit-status vocabulary, the sibling of RUN_EXIT_CODES (:1693).
// `1` is a MEASURED failure — a seat proven alive, a row that never reached the
// ledger. An ABSENCE is weaker evidence than that and must not borrow its
// status, but it must not borrow 0's either: a teardown that measured nothing
// is not a teardown that proved every seat dead, and the operator reading the
// exit status ALONE is the one this distinction exists for.
export const TEARDOWN_EXIT_UNPROVEN = 1
export const TEARDOWN_EXIT_SEATLESS = 4

// The named basis for a sweep that produced no row, in the shape ledger.mjs
// spells its own absences (scripts/factory/ledger.mjs:318). `seats: null` next
// to `archived` is skimmable; a sentence is not.
export const TEARDOWN_ABSENT_CAUSES = Object.freeze({
  headless: 'no seat in this crew carries a pane surface — every member ran on a surface-less transport, so this sweep had nothing to probe and proved nothing; those seat processes are the descendant reclaim\'s to account for, never this tally\'s',
  surface_unrecorded: 'at least one seat records the pane transport (or records no transport at all) yet carries no surface id, so a pane it may still own is INVISIBLE to this sweep — unmeasured, never a measured zero',
  no_members: 'the crew record carries no members at all, so no seat could be probed and nothing about this crew\'s panes was measured — unmeasured, never a measured zero',
})

// The classifier, the sibling of usageAbsentCause (scripts/factory/ledger.mjs:327).
export function teardownAbsentCause(crew) {
  const members = Object.values(crew?.members || {})
  if (members.length === 0) return TEARDOWN_ABSENT_CAUSES.no_members
  return members.every((m) => (m?.transport || DEFAULT_TRANSPORT) !== DEFAULT_TRANSPORT)
    ? TEARDOWN_ABSENT_CAUSES.headless
    : TEARDOWN_ABSENT_CAUSES.surface_unrecorded
}

export class UsageError extends Error { constructor(message) { super(message); this.name = 'UsageError'; this.usage = true } }

// A --flag followed by another --flag (or by nothing) is a BOOLEAN true —
// otherwise `run --brief-file x --keep` silently loses --keep.
export function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i]
    if (!t.startsWith('--')) { out._.push(t); continue }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) { out[t.slice(2)] = true } else { out[t.slice(2)] = next; i += 1 }
  }
  return out
}

export const KNOWN_FLAGS = Object.freeze({
  boot: Object.freeze(['task', 'checkout', 'roles', 'tier', 'fences', 'lane', 'headless', 'headless-rpc', 'headless-all', 'memory-dir', 'memory-backend', 'memory-budget-bytes', 'claude-bin', 'profile', 'assurance']),
  run: Object.freeze(['task', 'checkout', 'brief-file', 'variant', 'execution', 'files-in-scope', 'validation-lane', 'lane', 'plan-rounds', 'build-rounds', 'review-rounds', ...WAIT_FLAGS, 'suite', 'keep', 'claude-bin']),
  handoff: Object.freeze(['task', 'checkout', 'brief-file']),
  wait: Object.freeze(['task', 'checkout', 'timeout-s']),
  status: Object.freeze(['task', 'checkout']),
  teardown: Object.freeze(['task', 'checkout']),
})
// Every flag on every verb declares whether it CARRIES A VALUE or MEANS TRUE.
// A flag with no entry here is a flag with no value contract, and assertUsage
// refuses it rather than letting parseArgs' boolean fallback
// (crew/crew.mjs:2127) decide: `--suite` at the end of an argv line became
// boolean true, Node coerced it into the shell argv, and `/bin/sh -c true`
// exited 0 with empty output — a GREEN full-suite stage that ran nothing
// (#538). Same posture as resolveValidationLane (:419): validate, refuse from
// a closed set, name the flag.
export const FLAG_VALUE_REFUSAL = 'invalid-flag-value'
export const FLAG_VALUE_CONTRACT = Object.freeze({
  task: 'value', checkout: 'value', roles: 'value', tier: 'value',
  fences: 'value', lane: 'value', 'brief-file': 'value', variant: 'value',
  profile: 'value', execution: 'value', assurance: 'value',
  'files-in-scope': 'value', 'validation-lane': 'value',
  'plan-rounds': 'value', 'build-rounds': 'value', 'review-rounds': 'value',
  ...Object.fromEntries(WAIT_FLAGS.map((flag) => [flag, 'value'])),
  suite: 'value', 'claude-bin': 'value', 'timeout-s': 'value',
  'memory-dir': 'value', 'memory-backend': 'value', 'memory-budget-bytes': 'value',
  // --headless and --headless-rpc take a comma-separated ROLE LIST; bare, they
  // degrade to an empty list (:470-474) — a silent no-op, not a boolean.
  headless: 'value', 'headless-rpc': 'value',
  // --headless-all is a switch: seatTransport (:486-488) already refuses any
  // value but true, because it names no roles — it asks every seat to pick a
  // headless transport.
  'headless-all': 'boolean',
  // --keep is a switch: runCmd reads only its truthiness (:1887) to skip the
  // auto-teardown a done run would otherwise perform.
  keep: 'boolean',
})
// The boolean flags, named and exported rather than inlined as exceptions, so
// the argv matrix in crew/crew.test.mjs can be exhaustive by construction.
const BOOLEAN_FLAG_NAMES = Object.freeze(['headless-all', 'keep'])
export const BOOLEAN_FLAGS = Object.freeze(Object.keys(FLAG_VALUE_CONTRACT)
  .filter((flag) => BOOLEAN_FLAG_NAMES.includes(flag) && FLAG_VALUE_CONTRACT[flag] === 'boolean').sort())
export const ROLE_FLAG_PREFIXES = Object.freeze(['model-', 'agent-', 'effort-', 'allow-shortfall-'])
export const REQUIRED_FLAGS = Object.freeze({
  boot: Object.freeze(['task']),
  run: Object.freeze(['task', 'brief-file']),
  handoff: Object.freeze(['task', 'brief-file']),
  wait: Object.freeze(['task']),
  status: Object.freeze(['task']),
  teardown: Object.freeze(['task']),
})
export const BOOT_ONLY_FLAGS = Object.freeze(['fences', 'lane'])

function usageRefusal(message) {
  return Object.assign(new UsageError(message), { reason: FLAG_VALUE_REFUSAL })
}

export function assertUsage(verb, args) {
  const supplied = args && typeof args === 'object' ? args : {}
  const known = KNOWN_FLAGS[verb] || []
  const keys = Object.keys(supplied).filter((key) => key !== '_')
  const misplaced = BOOT_ONLY_FLAGS.filter((flag) => Object.hasOwn(supplied, flag) && !known.includes(flag))
  if (misplaced.length) {
    const names = misplaced.map((flag) => `--${flag}`).join(', ')
    const bootLabel = misplaced.length === 1 ? 'this is a BOOT-time flag' : 'these are BOOT-time flags'
    let message = `crew.mjs ${verb} does not read ${names}: ${bootLabel} — pass it to \`crew.mjs boot\`, which persists it into crew.json (lane_name/lane_fence) and it is the run's single source of fence truth`
    if (verb === 'run' && Object.hasOwn(supplied, 'fences') && Object.hasOwn(supplied, 'lane')) {
      message += ' and --fences is SUPPRESSING the --lane you asked for: with both present resolveValidationLane returns no lane at all'
    }
    throw new UsageError(message)
  }
  const unknown = keys.filter((key) => !known.includes(key) && !(verb === 'boot' && ROLE_FLAG_PREFIXES.some((prefix) => key.startsWith(prefix) && key.length > prefix.length)))
  if (unknown.length) {
    const names = unknown.map((flag) => `--${flag}`).join(', ')
    const knownNames = known.map((flag) => `--${flag}`).join(', ')
    throw new UsageError(`crew.mjs ${verb} does not read ${names}; ${verb} reads: ${knownNames}`)
  }
  for (const flag of keys) {
    const roleOverride = verb === 'boot'
      && ROLE_FLAG_PREFIXES.some((prefix) => flag.startsWith(prefix) && flag.length > prefix.length)
    const contract = FLAG_VALUE_CONTRACT[flag] || (roleOverride ? 'value' : null)
    const value = supplied[flag]
    if (contract === null) {
      throw usageRefusal(`crew.mjs ${verb} declares no value contract for --${flag}: add it to FLAG_VALUE_CONTRACT`)
    }
    if (contract === 'boolean') {
      if (value === true || value === 'true') continue
      throw usageRefusal(`crew.mjs ${verb} --${flag} takes no value, got ${JSON.stringify(value)} [${FLAG_VALUE_REFUSAL}]`)
    }
    if (typeof value !== 'string' || value.trim() === '') {
      throw usageRefusal(`crew.mjs ${verb} --${flag} needs a value, got ${JSON.stringify(value)} [${FLAG_VALUE_REFUSAL}]`)
    }
  }
  for (const flag of REQUIRED_FLAGS[verb] || []) {
    const value = supplied[flag]
    if (value === undefined || value === true || typeof value !== 'string' || !value.trim()) {
      const shape = flag === 'task' ? '<slug>' : flag === 'brief-file' ? '<path to the task brief>' : '<value>'
      throw new UsageError(`crew.mjs ${verb} requires --${flag} ${shape}`)
    }
  }
}

// package.json's scripts.test is the one suite-command owner (#616); this
// resolver reads it rather than repeating its value in a run surface.
export const SUITE_OWNER_PATH = join(HERE, '..', 'package.json')
export const SUITE_REFUSAL = 'suite-unreadable'

export function packageSuite({ path = SUITE_OWNER_PATH, readFile = readFileSync } = {}) {
  let parsed
  try { parsed = JSON.parse(String(readFile(path, 'utf8'))) } catch (err) {
    throw Object.assign(new Error(`cannot read the suite command from ${path}: ${err.message} [${SUITE_REFUSAL}]`), { reason: SUITE_REFUSAL })
  }
  const suite = parsed?.scripts?.test
  if (typeof suite !== 'string' || suite.trim() === '') {
    throw Object.assign(new Error(`${path} declares no scripts.test — the suite command has one owner and it is missing [${SUITE_REFUSAL}]`), { reason: SUITE_REFUSAL })
  }
  return suite.trim()
}

const COMMANDS = { boot: bootCmd, run: runCmd, handoff: handoffCmd, wait: waitCmd, status: statusCmd, teardown: teardownCmd }
const invokedDirectly = process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const [verb, ...rest] = process.argv.slice(2)
  const fn = COMMANDS[verb]
  if (!fn) { process.stderr.write(`usage: crew.mjs <${Object.keys(COMMANDS).join('|')}> --task <slug> ...\n`); process.exit(2) }
  if (verb === 'run') installExitMarker()
  // fn may be async (boot resolves adapters via dynamic import) — a sync
  // try/catch cannot see an async rejection, so a promise result is also
  // routed to `fail` explicitly.
  const fail = (err) => {
    process.stderr.write(`error: ${err.message}\n`)
    process.stdout.write(`${JSON.stringify({ error: err.message })}\n`)
    process.exit(err?.usage === true ? 2 : 1)
  }
  try {
    const parsed = parseArgs(rest)
    assertUsage(verb, parsed)
    const r = fn(parsed)
    if (r && typeof r.then === 'function') r.catch(fail)
  } catch (err) { fail(err) }
}
