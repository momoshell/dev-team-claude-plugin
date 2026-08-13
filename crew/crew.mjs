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

import { execSync, execFileSync, spawnSync } from 'node:child_process'

import { cmux, tree, locate, sendLine, renameTab, closeSurface, closeWorkspace, logLine, assignmentLine } from './driver.mjs'
import { driveTask } from './drive.mjs'
import { openRun } from '../scripts/factory/emit.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROLES_DIR = join(HERE, 'roles')
const SHARED_PROMPT = join(ROLES_DIR, '_shared.md')

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
export const SEAT_DEFAULTS = Object.freeze({
  lead: { model: 'opus', tools: 'Read,Glob,Grep,Bash,Write', deny: 'Edit,NotebookEdit,Task,Agent', prompt: 'lead.md', agent: 'claude' },
  planner: { model: 'opus', tools: 'Read,Glob,Grep,Bash,Write,Task', deny: 'Edit,NotebookEdit', prompt: 'planner.md', agent: 'claude' },
  builder: { model: 'sonnet', tools: 'Read,Edit,Write,Glob,Grep,Bash', deny: 'Task,Agent', prompt: 'builder.md', agent: 'claude' },
  reviewer: { model: 'opus', tools: 'Read,Glob,Grep,Bash,Write,Task', deny: 'Edit,NotebookEdit', prompt: 'reviewer.md', agent: 'claude' },
  'tech-lead': { model: 'opus', tools: 'Read,Glob,Grep,Bash,Write', deny: 'Edit,NotebookEdit,Task,Agent', prompt: 'tech-lead.md', agent: 'claude' },
})
export const DEFAULT_ROLES = Object.freeze(['lead', 'planner', 'builder', 'reviewer'])
// Canonical seating order — also layout order (index 0 takes the left half).
// Must stay key-identical to SEAT_DEFAULTS (pinned by a test).
export const ROLE_ORDER = Object.freeze(['lead', 'planner', 'builder', 'reviewer', 'tech-lead'])

function slug(s) {
  const out = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!out) throw new Error(`slug: empty/degenerate input ${JSON.stringify(s)}`)
  return out
}

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

function saveCrew(paths, crew) {
  const p = join(paths.dir, 'crew.json')
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(crew, null, 2))
  renameSync(tmp, p)
}

function seatModel(role, args) {
  return args[`model-${role}`] || SEAT_DEFAULTS[role].model
}

function seatAgent(role, args) {
  return args[`agent-${role}`] || SEAT_DEFAULTS[role].agent
}

// Enforce that the resolved adapter can actually deliver what the seat's
// charter needs. Only tool_deny has a real consequence today: every seat has
// a non-empty deny list, so an adapter that can't enforce it would boot a
// silently weaker seat. Returns undefined on success.
export function assertCapabilities(role, agentName, capabilities) {
  if (SEAT_DEFAULTS[role].deny && capabilities?.tool_deny !== true) {
    throw new Error(`seat ${role} needs tool denial (deny: "${SEAT_DEFAULTS[role].deny}") but agent adapter "${agentName}" declares tool_deny: false — refusing to boot a weaker seat`)
  }
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
    const adapter = adapters[role]?.adapter
    // The typeof fallback keeps a third-party adapter without modelString
    // bootable.
    const model = seat.model || (typeof adapter?.modelString === 'function'
      ? adapter.modelString({ provider: seat.provider, id: seat.id })
      : seat.id)
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
  for (const role of roles) {
    const name = String(seats?.[role]?.agent || seatAgent(role, args))
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`invalid agent adapter name "${name}" for seat ${role}`)
    const file = join(HERE, 'adapters', `adapter-${name}.mjs`)
    if (!existsSync(file)) throw new Error(`unknown agent adapter "${name}" for seat ${role}: no such adapter file ${file}`)
    const adapter = await import(pathToFileURL(file).href)
    if (typeof adapter.seatCommand !== 'function') throw new Error(`agent adapter "${name}" for seat ${role} (${file}) does not export a seatCommand function`)
    assertCapabilities(role, name, adapter.capabilities)
    out[role] = { name, adapter }
  }
  return out
}

function paneCommand(role, args, { taskDir, bootBrief, adapter, tierSeat }) {
  const seat = SEAT_DEFAULTS[role]
  // --append-system-prompt-file is LAST-WINS, not cumulative (verified against
  // claude 2.1.229): passing shared + role as two flags silently drops shared.
  // So the shared contract and the role card are merged into ONE prompt file
  // per seat, generated in the task dir at boot.
  const merged = join(taskDir, `role-${role}.md`)
  writeFileSync(merged, `${readFileSync(SHARED_PROMPT, 'utf8')}\n\n${readFileSync(join(ROLES_DIR, seat.prompt), 'utf8')}`)
  // effort: per-seat boot flag (--effort-<role> high), OPTIONAL — or, when a
  // --tier was used, the roster's resolved seat (tierSeat), which flags still
  // override. Both shipped adapters declare capabilities.effort and map it
  // to their own flag (claude --effort, pi --thinking).
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

async function bootCmd(args) {
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
  // Resolve adapters before touching cmux — a bad --agent-<role> or a
  // capability shortfall must fail before a workspace gets created.
  const adapters = await resolveAdapters(roles, args, tierSeats)
  const seats = tierSeats ? resolveSeatModels(tierSeats, adapters) : null

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
  const mk = (role) => paneCommand(role, args, { taskDir: paths.taskDir, bootBrief, adapter: adapters[role].adapter, tierSeat: seats?.[role] })
  const layout = composeLayout(roles, mk)

  const before = tree()
  const res = cmux('new-workspace', ['--name', `crew-${taskSlug}`, '--cwd', checkout, '--layout', JSON.stringify(layout), '--focus', 'true'])
  if (!res.ok) throw new Error(`new-workspace --layout failed: ${res.error.message}`)
  const after = tree()

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
  const { ws: workspace, windowId } = candidates[0]
  const panes = workspace.panes || []
  if (panes.length !== roles.length) throw new Error(`boot: expected ${roles.length} panes, found ${panes.length}`)

  // Seat every role by its SURFACE NAME (set in the layout) — positional
  // mapping mis-seats every role silently if the tree's pane order ever
  // differs from layout order. Fall back to position only when the tree
  // carries no surface names at all, and fail loudly on a partial match.
  const members = {}
  const byName = new Map()
  for (const p of panes) {
    const s = (p.surfaces || [])[0]
    if (s?.name) byName.set(String(s.name).toLowerCase(), { pane: p, surface: s })
  }
  if (byName.size > 0) {
    for (const role of roles) {
      const hit = byName.get(role)
      if (!hit) throw new Error(`boot: no surface named ${role} in the new workspace (tree names: ${[...byName.keys()].join(', ')})`)
      members[role] = {
        pane_id: hit.pane.id, surface_id: hit.surface.id, model: seats?.[role]?.model || seatModel(role, args), agent: adapters[role].name,
        ...(seats ? { effort: seats[role].effort, provider: seats[role].provider, id: seats[role].id } : {}),
      }
    }
  } else {
    roles.forEach((role, i) => {
      const surface = (panes[i].surfaces || [])[0]
      members[role] = {
        pane_id: panes[i].id, surface_id: surface.id, model: seats?.[role]?.model || seatModel(role, args), agent: adapters[role].name,
        ...(seats ? { effort: seats[role].effort, provider: seats[role].provider, id: seats[role].id } : {}),
      }
    })
  }
  for (const role of roles) renameTab(members[role].surface_id, role)

  const crew = {
    schema_version: 2, task: taskSlug, checkout,
    workspace_id: workspace.id, window_id: windowId,
    roles, members, task_return: join(paths.returnsDir, 'task.json'),
    created_at: new Date().toISOString(),
    ...(tierName ? { tier: tierName, seats } : {}),
  }
  saveCrew(paths, crew)
  logLine(join(paths.dir, 'journal.jsonl'), {
    at: new Date().toISOString(), event: 'boot', roles, models: Object.fromEntries(roles.map((r) => [r, members[r].model])),
    ...(tierName ? { tier: tierName, seats, allocation: sources } : {}),
  })
  process.stdout.write(`${JSON.stringify({ workspace_id: workspace.id, members, task_dir: paths.taskDir, crew_json: join(paths.dir, 'crew.json') })}\n`)
}

// The mount grammar, isolated so a test can pin it. On cmux build 102
// `markdown open`'s --workspace/--window are TARGETS: naming them plants the
// viewer in the CREW's workspace instead of whatever the human happens to be
// focused on (the PR #92 regression). --focus false: a viewer never steals
// focus. No --surface: build 102 has no context flag for the source surface,
// so that rung was never cross-window-verified.
export function docOpenArgs({ path, workspaceId, windowId }) {
  return ['open', path, '--workspace', workspaceId, '--window', windowId, '--direction', 'down', '--focus', 'false']
}

// Surface ids present in `after` but not in `before` — the only recovery path
// for a cmux verb that creates a surface without printing its id.
function newSurfaceIds(before, after) {
  const seen = new Set()
  for (const w of before.windows || []) for (const ws of w.workspaces || []) for (const p of ws.panes || []) for (const s of p.surfaces || []) seen.add(s.id)
  const fresh = []
  for (const w of after.windows || []) for (const ws of w.workspaces || []) for (const p of ws.panes || []) for (const s of p.surfaces || []) if (!seen.has(s.id)) fresh.push(s.id)
  return fresh
}

export function phaseForStage(label) {
  const head = String(label ?? '').split(':')[0]
  if (head === 'plan' || head === 'check') return 'planning'
  if (['build', 'scope-gate', 'lane', 'gate', 'gate-baseline', 'gate-repair', 'gate-reverify'].includes(head)) return 'build'
  if (head === 'review') return 'review'
  if (head === 'suite' || head === 'commit') return 'finish'
  if (head === 'done') return 'done'
  if (head === 'escalate') return 'escalation'
  return 'build'
}

export function emitAdapter(emitter) {
  const record = (type, payload) => emitter.emit((handle, nextSeq) => handle.recordEvent({
    adw_id: emitter.adwId, type, seq: nextSeq('event'), payload,
  }))
  return (event) => {
    if (!event || typeof event !== 'object') return
    if (event.kind === 'stage') {
      emitter.phaseTransition(phaseForStage(event.label))
      record('log', { level: 'info', message: event.label })
    } else if (event.kind === 'assign') {
      record('agent_start', { role: event.role, dispatch_id: event.id })
    } else if (event.kind === 'envelope') {
      record('agent_end', { role: event.role, outcome: event.status, dispatch_id: event.id })
    } else if (event.kind === 'decision') {
      record('decision', { decided: event.decided, why: event.why })
    } else if (event.kind === 'dissent') {
      record('decision', {
        decided: event.lead_decision,
        why: `dissent from ${event.from}`,
        alternatives: [event.recommendation],
      })
    }
  }
}

function ledgerDbPath() {
  return process.env.DEVTEAM_LEDGER_DB
    || join(process.env.DEVTEAM_LEDGER_DIR || join(homedir(), '.dev-team', 'factory'), 'ledger.db')
}

// v3: the deterministic driver runs the task loop (code disposes); the lead
// pane is consulted only at decision points. This IS `run` now; the v2
// agent-driven handoff survives as `handoff` for comparison runs.
function realIo(crew, paths, checkout, emitter) {
  let seq = 0
  const io = {
    assign({ role, briefFile }) {
      const m = crew.members[role]
      if (!m) throw new Error(`role ${role} not seated in this crew`)
      seq += 1
      const id = `d${seq}`
      const returnPath = join(paths.returnsDir, `${id}.${role}.json`)
      // Anti-replay: seq restarts every process, so a crashed/escalated run
      // leaves files a re-run's wait() would instantly (and wrongly) accept.
      if (existsSync(returnPath)) unlinkSync(returnPath)
      sendLine(m.surface_id, assignmentLine({ id, role, briefFile, returnPath, taskDir: paths.taskDir }))
      return { id, returnPath }
    },
    wait(returnPath, timeoutS) {
      const deadline = Date.now() + timeoutS * 1000
      while (Date.now() < deadline) {
        if (existsSync(returnPath)) {
          try { return JSON.parse(readFileSync(returnPath, 'utf8')) } catch { /* partial write; retry */ }
        }
        const sab = new SharedArrayBuffer(4)
        Atomics.wait(new Int32Array(sab), 0, 0, 5000)
      }
      return null
    },
    writeFile(path, content) { writeFileSync(path, content) },
    readFile(path) { return existsSync(path) ? readFileSync(path, 'utf8') : null },
    run(cmd) {
      const res = spawnSync('/bin/sh', ['-c', cmd], { cwd: checkout, encoding: 'utf8', timeout: 900_000 })
      // A timeout kill or a spawn failure must be legible in the output a
      // bounce brief pastes verbatim — never an empty "Failures:" block.
      let output = `${res.stdout || ''}${res.stderr || ''}`
      if (res.error) output += `\n[spawn error: ${res.error.message}]`
      if (res.signal) output += `\n[killed by ${res.signal}${res.signal === 'SIGTERM' ? ' — likely the 900s run timeout' : ''}]`
      return { ok: res.status === 0, output }
    },
    // Prove a command red on the PRE-BUILD tree: set the working changes
    // aside, run, restore. The pop lives in a finally so a throwing command
    // can never leave the builder's work stashed, and a failed round-trip
    // throws loudly rather than silently reporting a result from the wrong
    // tree (runCmd turns the throw into an escalation envelope).
    runClean(cmd) {
      const dirty = execSync('git status --porcelain -uall', { cwd: checkout, encoding: 'utf8' }).trim()
      if (!dirty) return this.run(cmd) // nothing to set aside — the tree IS pristine
      const push = spawnSync('git', ['stash', 'push', '--include-untracked', '-m', 'crew:runClean'], { cwd: checkout, encoding: 'utf8' })
      if (push.status !== 0) throw new Error(`runClean: git stash push failed, refusing to judge a gate against the wrong tree:\n${push.stderr || push.stdout || ''}`)
      try {
        return this.run(cmd)
      } finally {
        const pop = spawnSync('git', ['stash', 'pop'], { cwd: checkout, encoding: 'utf8' })
        if (pop.status !== 0) throw new Error(`runClean: git stash pop FAILED — the checkout is half-restored and the builder's work is in the stash (git stash list):\n${pop.stderr || pop.stdout || ''}`)
      }
    },
    changedFiles() {
      // -z: NUL-delimited, no quoting of paths with spaces; -uall: untracked
      // files individually, never a collapsed '?? dir/'. Rename/copy entries
      // ('R'/'C' in X) carry the ORIGINAL path as the following NUL record —
      // both sides are real changes the scope gate must see.
      const out = execSync('git status --porcelain -uall -z', { cwd: checkout, encoding: 'utf8' })
      const parts = out.split('\0')
      const files = []
      for (let i = 0; i < parts.length; i += 1) {
        const entry = parts[i]
        if (!entry) continue
        files.push(entry.slice(3))
        if (entry[0] === 'R' || entry[0] === 'C') { i += 1; if (parts[i]) files.push(parts[i]) }
      }
      return files
    },
    commit(files, message) {
      // argv-form git (no shell string: planner-supplied paths are data, not
      // syntax), staging only what actually changed within scope — a planned-
      // but-never-created path must not crash the run after a green suite.
      const changed = this.changedFiles()
      const present = files.filter((f) => changed.includes(f))
      if (present.length === 0) throw new Error('commit: nothing in scope actually changed — refusing an empty commit')
      execFileSync('git', ['add', '--', ...present], { cwd: checkout })
      execFileSync('git', ['commit', '-q', '-F', '-'], { cwd: checkout, input: message })
      return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim()
    },
    status(label) {
      // Workspace pill: glanceable "which code stage is running" for the
      // humans watching. Best-effort — a pill failure never touches the loop.
      cmux('set-status', ['crew-stage', label, '--workspace', crew.workspace_id])
    },
    // Mount the plan of record in cmux's live-watching markdown viewer, ONCE.
    // The viewer follows the file, and the plan path is stable for the whole
    // task, so a revision needs no remount — this is a no-op after the first
    // call. Idempotency is persisted on crew.doc_viewer so a re-run against a
    // still-standing (escalated) workspace does not mount a second pane.
    // Best-effort like status(): a mount failure warns and returns.
    showDoc(path) {
      try {
        if (crew.doc_viewer?.path === path) return
        if (crew.doc_viewer?.surface_id) closeSurface(crew.doc_viewer.surface_id)
        const before = tree()
        const res = cmux('markdown', docOpenArgs({ path, workspaceId: crew.workspace_id, windowId: crew.window_id }))
        if (!res.ok) throw new Error(res.error.message)
        // markdown open prints no id — recover it by tree diff. An ambiguous
        // diff still records the mount (surface_id null) so the singleton
        // guard holds; only the teardown close is lost.
        const surfaceId = newSurfaceIds(before, tree())
        crew.doc_viewer = { path, surface_id: surfaceId.length === 1 ? surfaceId[0] : null }
        saveCrew(paths, crew)
        logLine(join(paths.dir, 'journal.jsonl'), { at: new Date().toISOString(), event: 'doc-viewer', path, surface_id: crew.doc_viewer.surface_id })
      } catch (err) {
        process.stderr.write(`warning: plan viewer mount failed (${err.message}) — continuing\n`)
      }
    },
    log(obj) { logLine(join(paths.dir, 'journal.jsonl'), obj) },
    now() { return Date.now() },
  }
  if (emitter) io.emit = emitAdapter(emitter)
  return io
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
  const ctx = {
    task: taskSlug, briefFile, taskDir: paths.taskDir, checkout, journal,
    roles: crew.roles, lane: args.lane || null, suite: args.suite || 'node --test',
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

  const io = realIo(crew, paths, checkout, emitter)
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

function awaitSeatsReady(crew, timeoutS = 120, journal = null) {
  const deadline = Date.now() + timeoutS * 1000
  const pending = new Set(Object.keys(crew.members))
  while (pending.size > 0) {
    for (const role of [...pending]) {
      const res = cmux('read-screen', ['--surface', crew.members[role].surface_id, '--lines', '40'])
      const sig = res.ok && seatReadySignal(res.stdout, role)
      if (sig) {
        pending.delete(role)
        if (journal) logLine(journal, { at: new Date().toISOString(), event: 'seat-ready', role, signal: sig })
      }
    }
    if (pending.size === 0) break
    if (Date.now() > deadline) {
      throw new Error(`seats never became ready within ${timeoutS}s: ${[...pending].join(', ')}`)
    }
    const sab = new SharedArrayBuffer(4)
    Atomics.wait(new Int32Array(sab), 0, 0, 2000)
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
  const t = tree()
  const alive = {}
  for (const [role, m] of Object.entries(crew.members)) alive[role] = !!locate(t, m.surface_id)
  process.stdout.write(`${JSON.stringify({ task: crew.task, workspace_id: crew.workspace_id, alive })}\n`)
}

// Archive the crew dir (the durable record: envelopes, journal, artifacts)
// and close the ephemeral view (panes, workspace). Everything evidentiary is
// on disk by contract before this runs — deliverables live in files, never
// pane scrollback.
function teardownCore(paths, crew) {
  for (const m of Object.values(crew.members)) closeSurface(m.surface_id)
  // The viewer is not in crew.members, so the loop above never sees it, and
  // close-workspace is documented to no-op while a live pane occupies the
  // workspace — close it by id rather than trusting the workspace close.
  if (crew.doc_viewer?.surface_id) closeSurface(crew.doc_viewer.surface_id)
  closeWorkspace(crew.workspace_id)
  // Full timestamp, not date-only: a second same-day run of the same slug
  // must never ENOTEMPTY onto the first run's archive.
  const archived = `${paths.dir}.archive-${new Date().toISOString().replace(/[:.]/g, '-')}`
  renameSync(paths.dir, archived)
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
