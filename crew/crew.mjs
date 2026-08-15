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
//                  [--memory-budget-bytes <n>]
//   crew.mjs run   --task <slug> --brief-file <path>   # hand the task to the lead
//   crew.mjs wait  --task <slug> [--timeout-s N]       # await the LEAD's envelope
//   crew.mjs status --task <slug>
//   crew.mjs teardown --task <slug>
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync,
} from 'node:fs'
import { join, dirname, resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { execSync } from 'node:child_process'

import { cmux, tree, sendLine, renameTab, closeSurface, closeWorkspace, logLine } from './driver.mjs'
import { slug } from './slug.mjs'
import { driveTask } from './drive.mjs'
import { reclaimStore } from './reclaim.mjs'
import {
  realIo, saveCrew, resolveWorkerBin, paneAlive, DEFAULT_TRANSPORT, HEADLESS_TRANSPORT, HEADLESS_RPC_TRANSPORT,
} from './realio.mjs'
export {
  docOpenArgs, phaseForStage, emitAdapter, waitForEnvelope, resolveWorkerBin,
  DEFAULT_TRANSPORT, HEADLESS_TRANSPORT, HEADLESS_RPC_TRANSPORT, WAIT_POLL_MS, LIVENESS_PROBE_MS,
  LIVENESS_MISSES_TO_DIE,
} from './realio.mjs'
import { openRun } from '../scripts/factory/emit.mjs'
import {
  DEFAULT_BACKEND, DEFAULT_BUDGET_BYTES, openMemory, renderSection,
} from './memory.mjs'

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
// adapter cannot deliver one refuses to boot.
// Only the PLANNER requires `subagents`, and the asymmetry is deliberate: its
// charter is "domain lead + architect + scout-commander", and fan-out
// discovery IS the third of those. The reviewer's charter — conformance to
// plan, then correctness, plus gate-defect triage and perspective duty — names
// no fan-out, and the roster deliberately seats pi/terra on review at
// `build`/`mechanical` under the ratified review-vendor rule. Requiring it
// there would make two of three tiers unbootable, which is how this landed the
// first time (#144).
export const SEAT_DEFAULTS = Object.freeze({
  lead: { model: 'opus', tools: 'Read,Glob,Grep,Bash,Write', deny: 'Edit,NotebookEdit,Task,Agent', requires: [], prompt: 'lead.md', agent: 'claude' },
  planner: { model: 'opus', tools: 'Read,Glob,Grep,Bash,Write,Task', deny: 'Edit,NotebookEdit', requires: ['subagents'], prompt: 'planner.md', agent: 'claude' },
  builder: { model: 'sonnet', tools: 'Read,Edit,Write,Glob,Grep,Bash', deny: 'Task,Agent', requires: [], prompt: 'builder.md', agent: 'claude' },
  reviewer: { model: 'opus', tools: 'Read,Glob,Grep,Bash,Write,Task', deny: 'Edit,NotebookEdit', requires: [], prompt: 'reviewer.md', agent: 'claude' },
  'tech-lead': { model: 'opus', tools: 'Read,Glob,Grep,Bash,Write', deny: 'Edit,NotebookEdit,Task,Agent', requires: [], prompt: 'tech-lead.md', agent: 'claude' },
})
export const DEFAULT_ROLES = Object.freeze(['lead', 'planner', 'builder', 'reviewer'])
export const MEMORY_ROLES = Object.freeze(['lead', 'planner'])
// Canonical seating order — also layout order (index 0 takes the left half).
// Must stay key-identical to SEAT_DEFAULTS (pinned by a test).
export const ROLE_ORDER = Object.freeze(['lead', 'planner', 'builder', 'reviewer', 'tech-lead'])

// The rule itself lives in the leaf module `slug.mjs`, so daemon.mjs can share
// it without importing this file (which pulls in drive.mjs). Re-exported here
// because this module's own consumers already reach for it by this name.
export { slug }

function pathsFor(taskSlug, checkout) {
  const repo = slug(checkout.split('/').filter(Boolean).pop() || 'repo')
  const dir = join(homedir(), '.crew', repo, taskSlug)
  return { repo, dir, taskDir: join(dir, 'task'), returnsDir: join(dir, 'returns') }
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

export function assertCapabilities(role, agentName, capabilities, allowed = []) {
  if (SEAT_DEFAULTS[role].deny && capabilities?.tool_deny !== true) {
    throw new Error(`seat ${role} needs tool denial (deny: "${SEAT_DEFAULTS[role].deny}") but agent adapter "${agentName}" declares tool_deny: false — refusing to boot a weaker seat`)
  }
  for (const cap of SEAT_DEFAULTS[role].requires || []) {
    if (capabilities?.[cap] === true) continue
    if (allowed.includes(cap)) continue
    throw new Error(`seat ${role} requires capability "${cap}" but agent adapter "${agentName}" declares ${cap}: ${JSON.stringify(capabilities?.[cap])} — refusing to boot a weaker seat (pass --allow-shortfall-${role} ${cap} to boot it degraded on purpose)`)
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
export function resolveSeatModels(seats, adapters) {
  const out = {}
  for (const [role, seat] of Object.entries(seats)) {
    // A raw --model-<role> override is the operator's own CLI namespace: it is
    // never translated, AND it invalidates the roster cell it replaced. Keeping
    // that cell's provider/id would make the boot record name a model the seat
    // is not running (#161). Never guess a provider from a raw string — null is
    // the honest answer.
    if (seat.model) { out[role] = { ...seat, provider: null, id: null }; continue }
    const adapter = adapters[role]?.adapter
    // The typeof fallback keeps a third-party adapter without modelString
    // bootable.
    const model = typeof adapter?.modelString === 'function'
      ? adapter.modelString({ provider: seat.provider, id: seat.id })
      : seat.id
    out[role] = { ...seat, model }
  }
  return out
}

// Resolve each role's agent name to its adapter module, by filename — this
// IS the seam: adding an agent means dropping a file in crew/adapters/, not
// editing crew.mjs. Dynamic import() is inherently async. `seats` (optional)
// is a tier's resolved seat map — when present, its agent choice wins over
// the --agent-<role>/SEAT_DEFAULTS flags-or-default path.
export async function resolveAdapters(roles, args, seats = null) {
  const out = {}
  for (const key of Object.keys(args)) {
    const m = /^allow-shortfall-(.+)$/.exec(key)
    if (m && !roles.includes(m[1])) throw new Error(`--allow-shortfall-${m[1]} given but crew seats no ${m[1]}`)
  }
  for (const role of roles) {
    const name = String(seats?.[role]?.agent || seatAgent(role, args))
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`invalid agent adapter name "${name}" for seat ${role}`)
    const file = join(HERE, 'adapters', `adapter-${name}.mjs`)
    if (!existsSync(file)) throw new Error(`unknown agent adapter "${name}" for seat ${role}: no such adapter file ${file}`)
    const adapter = await import(pathToFileURL(file).href)
    if (typeof adapter.seatCommand !== 'function') throw new Error(`agent adapter "${name}" for seat ${role} (${file}) does not export a seatCommand function`)
    if (typeof adapter.capabilitiesFor !== 'function') throw new Error(`agent adapter "${name}" for seat ${role} (${file}) does not export a capabilitiesFor function`)
    const transport = seatTransport({ role, args, adapter, agentName: name })
    assertCapabilities(role, name, adapter.capabilitiesFor({ transport }), seatShortfalls(role, args))
    if (transport === HEADLESS_TRANSPORT && typeof adapter.headlessCommand !== 'function') {
      throw new Error(`agent adapter "${name}" for seat ${role} (${file}) does not export a headlessCommand function`)
    }
    out[role] = { name, adapter, transport }
  }
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

function paneCommand(role, args, { taskDir, bootBrief, adapter, tierSeat }) {
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
  const { cmux: cmuxFn = cmux, tree: treeFn = tree, renameTab: renameTabFn = renameTab } = deps
  const taskSlug = slug(args.task)
  const checkout = resolvePath(args.checkout || process.cwd())
  let roles, tierName = null, tierSeats = null, sources = null
  if (args.tier) {
    if (args.roles) throw new Error('--tier and --roles are mutually exclusive: the tier defines the seating')
    // The roster is the RUNTIME's policy, not the target checkout's. A
    // corrupt/missing roster must name the file and that rule, not throw a
    // bare "Unexpected token".
    const rosterPath = join(HERE, 'roster.json')
    let roster
    try { roster = JSON.parse(readFileSync(rosterPath, 'utf8')) } catch (err) {
      throw new Error(`--tier needs the crew runtime's own roster at ${rosterPath} (not the target checkout's): ${err.message}`)
    }
    ;({ roles, seats: tierSeats, sources } = resolveTier(roster, String(args.tier), args))
    tierName = String(args.tier)
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
  // Resolve adapters before touching cmux — a bad --agent-<role> or a
  // capability shortfall must fail before a workspace gets created.
  const adapters = await resolveAdapters(roles, args, tierSeats)
  const seats = tierSeats ? resolveSeatModels(tierSeats, adapters) : null
  const paneRoles = roles.filter((role) => adapters[role].transport === DEFAULT_TRANSPORT)
  const headlessOnly = paneRoles.length === 0
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
    tools: SEAT_DEFAULTS[role].tools, deny: SEAT_DEFAULTS[role].deny,
    ...(seats ? { effort: seats[role].effort, provider: seats[role].provider, id: seats[role].id } : {}),
  })
  if (headlessOnly) {
    for (const role of roles) members[role] = memberFor(role)
  } else {
    const mk = (role) => paneCommand(role, args, { taskDir: paths.taskDir, bootBrief, adapter: adapters[role].adapter, tierSeat: seats?.[role] })
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
    for (const role of roles.filter((r) => adapters[r].transport !== DEFAULT_TRANSPORT)) members[role] = memberFor(role)
    for (const role of paneRoles) renameTabFn(members[role].surface_id, role)
  }

  const crew = {
    schema_version: 3, task: taskSlug, checkout,
    workspace_id: workspace ? workspace.id : null, window_id: windowId ?? null,
    roles, members, task_return: join(paths.returnsDir, 'task.json'),
    created_at: new Date().toISOString(),
    ...(workerBin ? { claude_bin: workerBin } : {}),
    ...(tierName ? { tier: tierName, seats } : {}),
  }
  // crew/daemon.mjs paneSeat() is the consumer: daemon run refuses pane transport.
  if (headlessOnly) {
    const offender = roles.find((role) => !members[role]?.transport || members[role].transport === DEFAULT_TRANSPORT)
    if (offender) throw new Error(`boot: all-headless crew has a missing or pane transport for seat ${offender}`)
  }
  saveCrew(paths, crew)
  const allocation = bootAllocation(roles, args, sources, Object.fromEntries(roles.map((r) => [r, members[r].transport])))
  logLine(join(paths.dir, 'journal.jsonl'), {
    at: new Date().toISOString(), event: 'boot', roles,
    models: Object.fromEntries(roles.map((r) => [r, members[r].model])),
    transports: Object.fromEntries(roles.map((r) => [r, members[r].transport])),
    ...(workerBin ? { claude_bin: workerBin } : {}),
    ...(tierName ? { tier: tierName, seats } : {}),
    ...(allocation ? { allocation } : {}),
    ...(memory.record ? { memory: memory.record } : {}),
  })
  process.stdout.write(`${JSON.stringify({ workspace_id: workspace ? workspace.id : null, members, task_dir: paths.taskDir, crew_json: join(paths.dir, 'crew.json') })}\n`)
}

function ledgerDbPath() {
  return process.env.DEVTEAM_LEDGER_DB
    || join(process.env.DEVTEAM_LEDGER_DIR || join(homedir(), '.dev-team', 'factory'), 'ledger.db')
}


function runCmd(args) {
  const taskSlug = slug(args.task)
  const checkout = resolvePath(args.checkout || process.cwd())
  const paths = pathsFor(taskSlug, checkout)
  const crew = loadCrew(paths)
  assertSameCheckout(crew, checkout)
  if (!args['brief-file']) throw new Error('run requires --brief-file <path to the task brief>')
  const briefFile = resolvePath(args['brief-file'])
  if (!existsSync(briefFile)) throw new Error(`brief file not found: ${briefFile}`)
  // The driver assigns planner/builder/reviewer unconditionally — discover a
  // missing seat NOW, not mid-loop after a plan and a build are spent.
  assertSeats(crew)
  // The scope gate reads `git status` as ground truth — a dirty checkout at
  // start would be attributed to the builder and poison every scope verdict.
  const dirty = execSync('git status --porcelain', { cwd: checkout, encoding: 'utf8' }).trim()
  if (dirty) throw new Error(`checkout is dirty — commit or stash before a crew run:\n${dirty.split('\n').slice(0, 10).join('\n')}`)

  const journal = join(paths.dir, 'journal.jsonl')
  // Keep the test lane at 30 s per test: the slowest real test is ~25 ms,
  // giving ~1200× headroom even when the machine is saturated by three crews.
  // This is well below realIo.run's 900 s kill, so a hung test is reported by
  // name as timed out instead of ending as an anonymous SIGTERM.
  // --test-timeout is per-test: it bounds one hung test, not a pathological
  // whole-suite case. A wall-clock bound on the lane would be a driver change,
  // deliberately not done here. Keep this string identical to
  // package.json's scripts.test and crew/child.mjs's default;
  // crew/crew.test.mjs pins the three-way agreement.
  const ctx = {
    task: taskSlug, briefFile, taskDir: paths.taskDir, checkout, journal,
    roles: crew.roles, lane: args.lane || null, suite: args.suite || 'node --test --test-timeout=30000',
  }
  // Seats are TUI processes and the first assignment must not race their
  // boot: characters typed into a pty before the TUI grabs it are silently
  // swallowed (live-hit 2026-08-13 — the leading chunk of the first
  // assignment vanished on both crews). Gate on each seat actually replying
  // ready (or, as a fallback, rendering agent chrome) before driving.
  awaitSeatsReady(crew, 120, journal)

  // The factory ledger mirror (#94). openRun() never throws and degrades
  // to an inert emitter; the extra try/catch covers a caller-side surprise
  // (a bad path, an unwritable home) so instrumentation can never take a
  // crew run down. nodeVersion is deliberately NOT passed: openLedger's own
  // default is process.versions.node, and passing process.version silently
  // fails the ledger floor parse and drops every mirror row.
  let emitter = null
  try {
    emitter = openRun({ stateDir: paths.dir, repoSlug: paths.repo, taskSlug, dbPath: ledgerDbPath() })
    emitter.startRun()
  } catch { emitter = null }

  const io = realIo(crew, paths, checkout, emitter, null, args)
  // A throw out of the driver (member timeout, dead pane, git failure) is an
  // OUTCOME, not a stack trace: it must still produce a task envelope, or a
  // concurrent `crew.mjs wait` spins its full timeout for nothing.
  let result
  try {
    result = driveTask(ctx, io)
  } catch (err) {
    logLine(journal, { at: new Date().toISOString(), event: 'driver-crash', error: err.message })
    result = {
      status: 'escalation',
      summary: `Task ${taskSlug} needs a human: the driver crashed (${err.message})`,
      artifacts: [journal],
      details: { stages: null, commit: null, dissents: [], escalation: { where: err.stage || 'driver', why: err.message } },
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
  try { emitter?.endRun({ status: result.status === 'done' ? 'ok' : 'aborted' }) } catch { /* never load-bearing */ }
  // The task envelope is written by CODE — same path `wait` watches.
  writeFileSync(crew.task_return, JSON.stringify(result, null, 2))

  // Outcome-gated lifecycle, in code as policy:
  //   done       -> auto-teardown (archive the record, close the view),
  //                 unless --keep was passed for pane inspection.
  //   escalation -> NEVER teardown: the workspace IS the escalation context
  //                 (warm members, readable panes) the human needs.
  // An archive failure degrades to a warning: it must never turn an
  // already-committed task into a reported error.
  let archived = null
  if (result.status === 'done' && !args.keep) {
    try { archived = teardownCore(paths, crew) } catch (err) {
      process.stderr.write(`warning: teardown/archive failed (${err.message}) — crew dir left at ${paths.dir}\n`)
    }
  }
  // After archive the envelope moves with the dir — report where it lives now.
  const taskReturn = archived ? crew.task_return.replace(paths.dir, archived) : crew.task_return
  process.stdout.write(`${JSON.stringify({ status: result.status, commit: result.details?.commit ?? null, task_return: taskReturn, archived })}\n`)
  if (result.status !== 'done') process.exitCode = 1
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

export function awaitSeatsReady(crew, timeoutS = 120, journal = null, deps = {}) {
  const cmuxFn = deps.cmux || cmux
  const logLineFn = deps.logLine || logLine
  const now = deps.now || (() => Date.now())
  const sleep = deps.sleep || ((ms) => {
    const sab = new SharedArrayBuffer(4)
    Atomics.wait(new Int32Array(sab), 0, 0, ms)
  })
  const deadline = now() + timeoutS * 1000
  const pending = new Set(Object.keys(crew.members).filter((role) => crew.members[role].surface_id))
  while (pending.size > 0) {
    for (const role of [...pending]) {
      const res = cmuxFn('read-screen', ['--surface', crew.members[role].surface_id, '--lines', '40'])
      const sig = res.ok && seatReadySignal(res.stdout, role)
      if (sig) {
        pending.delete(role)
        if (journal) logLineFn(journal, { at: new Date().toISOString(), event: 'seat-ready', role, signal: sig })
      }
    }
    if (pending.size === 0) break
    if (now() > deadline) {
      throw new Error(`seats never became ready within ${timeoutS}s: ${[...pending].join(', ')}`)
    }
    sleep(2000)
  }
}

// planner/builder/reviewer are assigned unconditionally by the driver. The
// lead is required ONLY if the crew was booted with one: a lead-less crew
// (mechanical tier) is valid, and drive.mjs escalates where it would consult.
export function assertSeats(crew) {
  for (const role of ['planner', 'builder', 'reviewer']) {
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

function waitCmd(args) {
  const taskSlug = slug(args.task)
  const checkout = resolvePath(args.checkout || process.cwd())
  const paths = pathsFor(taskSlug, checkout)
  // No loadCrew here: the live dir may vanish mid-wait when run auto-tears
  // down on done — poll the live envelope path AND the archive fallback.
  const livePath = join(paths.returnsDir, 'task.json')
  const timeoutMs = Number(args['timeout-s'] || 3600) * 1000
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

// Archive the crew dir (the durable record: envelopes, journal, artifacts)
// and close the ephemeral view (panes, workspace). Everything evidentiary is
// on disk by contract before this runs — deliverables live in files, never
// pane scrollback.
export function teardownCore(paths, crew, deps = {}) {
  const closeSurfaceFn = deps.closeSurface || closeSurface
  const closeWorkspaceFn = deps.closeWorkspace || closeWorkspace
  const renameSyncFn = deps.renameSync || renameSync
  for (const m of Object.values(crew.members)) if (m.surface_id) closeSurfaceFn(m.surface_id)
  // The viewer is not in crew.members, so the loop above never sees it, and
  // close-workspace is documented to no-op while a live pane occupies the
  // workspace — close it by id rather than trusting the workspace close.
  if (crew.doc_viewer?.surface_id) closeSurfaceFn(crew.doc_viewer.surface_id)
  if (crew.workspace_id) closeWorkspaceFn(crew.workspace_id)
  // Full timestamp, not date-only: a second same-day run of the same slug
  // must never ENOTEMPTY onto the first run's archive.
  const archived = `${paths.dir}.archive-${new Date().toISOString().replace(/[:.]/g, '-')}`
  renameSyncFn(paths.dir, archived)
  return archived
}

function teardownCmd(args) {
  const taskSlug = slug(args.task)
  const checkout = resolvePath(args.checkout || process.cwd())
  const paths = pathsFor(taskSlug, checkout)
  const crew = loadCrew(paths)
  assertSameCheckout(crew, checkout)
  const archived = teardownCore(paths, crew)
  process.stdout.write(`${JSON.stringify({ archived })}\n`)
}

// A --flag followed by another --flag (or by nothing) is a BOOLEAN true —
// otherwise `run --brief-file x --keep` silently loses --keep.
function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i]
    if (!t.startsWith('--')) { out._.push(t); continue }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) { out[t.slice(2)] = true } else { out[t.slice(2)] = next; i += 1 }
  }
  return out
}

const COMMANDS = { boot: bootCmd, run: runCmd, handoff: handoffCmd, wait: waitCmd, status: statusCmd, teardown: teardownCmd }
const invokedDirectly = process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const [verb, ...rest] = process.argv.slice(2)
  const fn = COMMANDS[verb]
  if (!fn) { process.stderr.write(`usage: crew.mjs <${Object.keys(COMMANDS).join('|')}> --task <slug> ...\n`); process.exit(2) }
  // fn may be async (boot resolves adapters via dynamic import) — a sync
  // try/catch cannot see an async rejection, so a promise result is also
  // routed to `fail` explicitly.
  const fail = (err) => {
    process.stderr.write(`error: ${err.message}\n`)
    process.stdout.write(`${JSON.stringify({ error: err.message })}\n`)
    process.exit(1)
  }
  try {
    const r = fn(parseArgs(rest))
    if (r && typeof r.then === 'function') r.catch(fail)
  } catch (err) { fail(err) }
}
