#!/usr/bin/env node
// scripts/cmux/crew.mjs — the crew runtime (v1): a whole team booted into ONE
// cmux workspace at task start, driven by the orchestrator with single-line
// assignments, returning ReturnEnvelope files per assignment.
//
// Model (see crew-roles/*.md for the per-pane charters):
//   planner    domain lead + architect + scout-commander (opus, read-only repo)
//   builder    the only repo-writing role; tests are part of building (sonnet)
//   reviewer   read-only judge of conformance + correctness (opus)
//   tech-lead  optional plan adversary, different model/effort (tier-gated)
//
// Verbs:
//   node crew.mjs boot     --task <slug> [--roles planner,builder,reviewer[,tech-lead]] [--checkout <dir>]
//   node crew.mjs assign   --task <slug> --role <role> --brief "<single line, safe charset>" [--files <p1,p2>]
//   node crew.mjs wait     --task <slug> --id <assignment-id> [--timeout-s N]
//   node crew.mjs status   --task <slug>
//   node crew.mjs teardown --task <slug>
//
// Design notes:
// - Panes boot via `new-workspace --layout` with a per-surface command — the
//   whole crew materializes at creation (workspace is created focused, so
//   shells/agents boot immediately; lazy-materialization fix family, PR #87).
// - Assignments ride cmuxctl's sendLine (verified-send: readiness poll, echo
//   exactly-once, ctrl+u-guarded retype, throw on failure) — the SAFE_LINE_RE
//   charset is the assignment-line law; briefs are pointers, files carry the
//   real content.
// - Results are ReturnEnvelope FILES; the worker's CREW-DONE chat line is only
//   a human-visible signal. wait() polls the envelope file (v1; event-driven
//   accelerator can come later) and validates its JSON shape.
// - This is an ADDITIVE runtime beside dispatch.mjs, not a replacement (yet):
//   no dispatch records, no roster resolution — crew state lives in one
//   crew.json sidecar under ~/.dev-team/crew/<repo>/<task>/.
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync,
} from 'node:fs'
import { join, dirname, resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

import {
  cmux, tree, sendLine, renameTab, closeSurface, closeWorkspace,
} from './cmuxctl.mjs'
import { slugify } from './contract.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROLES_DIR = join(HERE, 'crew-roles')
const SHARED_PROMPT = join(ROLES_DIR, '_shared.md')

// Role table: model/tools per pane. tech-lead deliberately defaults to a
// different effort profile than the planner (the compounded-effect consult);
// point it at a genuinely different model via --tech-lead-model when one is
// available to the CLI.
export const CREW_ROLES = Object.freeze({
  planner: Object.freeze({
    model: 'opus',
    tools: 'Read,Glob,Grep,Bash,Write,Task',
    promptFile: 'planner.md',
  }),
  builder: Object.freeze({
    model: 'sonnet',
    tools: 'Read,Edit,Write,Glob,Grep,Bash',
    promptFile: 'builder.md',
  }),
  reviewer: Object.freeze({
    model: 'opus',
    tools: 'Read,Glob,Grep,Bash,Write',
    promptFile: 'reviewer.md',
  }),
  'tech-lead': Object.freeze({
    model: 'opus',
    tools: 'Read,Glob,Grep,Bash,Write',
    promptFile: 'tech-lead.md',
  }),
})
export const DEFAULT_ROLES = Object.freeze(['planner', 'builder', 'reviewer'])

// Assignment-line charset: sendLine's SAFE_LINE_RE is the enforcing check;
// this pre-validation exists to give a crew-flavored error before dispatch.
const BRIEF_RE = /^[A-Za-z0-9 _.,:;=/@'+-]+$/

function crewRoot(repoSlug, taskSlug) {
  return join(homedir(), '.dev-team', 'crew', repoSlug, taskSlug)
}

function repoSlugFrom(checkout) {
  return slugify(checkout.split('/').filter(Boolean).pop() || 'repo')
}

function loadCrew(paths) {
  const p = join(paths.dir, 'crew.json')
  if (!existsSync(p)) throw new Error(`no crew booted for this task (missing ${p})`)
  return JSON.parse(readFileSync(p, 'utf8'))
}

function saveCrew(paths, crew) {
  // tmp+rename: the crew file backs status reads; never rm-then-recreate.
  const p = join(paths.dir, 'crew.json')
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(crew, null, 2))
  renameSync(tmp, p)
}

function pathsFor(taskSlug, checkout) {
  const repoSlug = repoSlugFrom(checkout)
  const dir = crewRoot(repoSlug, slugify(taskSlug))
  return { repoSlug, dir, returnsDir: join(dir, 'returns'), taskDir: join(dir, 'task') }
}

// --- layout composition ------------------------------------------------------
// planner takes the left half; the remaining roles stack vertically on the
// right (mirrors the example team layout: lead-left, workers-right).
function paneFor(role, cfg, { checkout, taskDir, bootBrief }) {
  const rolePrompt = join(ROLES_DIR, cfg.promptFile)
  // `env` (a binary, not shell syntax) carries the vars whether or not cmux
  // shells the command. DEVTEAM_WORKER=1 suppresses the orchestration
  // SessionStart injection AND the #78 dispatch guard inside the pane.
  const command = [
    'env', 'DEVTEAM_WORKER=1', `DEVTEAM_CREW_ROLE=${role}`, `DEVTEAM_CREW_TASK_DIR=${taskDir}`,
    'claude',
    '--model', cfg.model,
    '--permission-mode', 'acceptEdits',
    '--allowedTools', `"${cfg.tools}"`,
    '--append-system-prompt-file', `"${SHARED_PROMPT}"`,
    '--append-system-prompt-file', `"${rolePrompt}"`,
    `"${bootBrief}"`,
  ].join(' ')
  return { pane: { surfaces: [{ type: 'terminal', name: role, command }] } }
}

// Split nodes are BINARY (the example's 2x2 is nested binary splits) and a
// single pane is a bare leaf — never a one-child split node.
function stackVertical(nodes) {
  if (nodes.length === 1) return nodes[0]
  const [head, ...rest] = nodes
  return { direction: 'vertical', split: 1 / nodes.length, children: [head, stackVertical(rest)] }
}

export function composeLayout(roles, ctx) {
  const panes = roles.map((r) => paneFor(r, CREW_ROLES[r], ctx))
  if (panes.length === 1) return panes[0]
  const [head, ...rest] = panes
  return { direction: 'horizontal', split: 0.5, children: [head, stackVertical(rest)] }
}

// --- verbs -------------------------------------------------------------------

function bootCmd(args) {
  const taskSlug = slugify(args.task)
  const checkout = resolvePath(args.checkout || process.cwd())
  const roles = (args.roles ? args.roles.split(',') : [...DEFAULT_ROLES]).map((r) => r.trim())
  for (const r of roles) if (!CREW_ROLES[r]) throw new Error(`unknown crew role: ${r}`)

  const paths = pathsFor(taskSlug, checkout)
  mkdirSync(paths.returnsDir, { recursive: true })
  mkdirSync(paths.taskDir, { recursive: true })

  const bootBrief = `You are the crew for task ${taskSlug}. Task dir: ${paths.taskDir}. Read your role instructions in the system prompt, reply exactly ready: <your-role>, then wait for assignments.`
  const layout = composeLayout(roles, { checkout, taskDir: paths.taskDir, bootBrief })

  const before = tree({ all: true })
  // Boot into the caller's current window: the crew lives where the
  // operator already looks, and a focused creation materializes every
  // pane's agent immediately (PR #87 family).
  const res = cmux('new-workspace', [
    '--name', `crew-${taskSlug}`, '--cwd', checkout,
    '--layout', JSON.stringify(layout), '--focus', 'true',
  ])
  if (!res.ok) throw new Error(`new-workspace --layout failed: ${res.error?.message}`)
  const after = tree({ all: true })

  // Recover ids by diffing: the new workspace is the one absent from `before`.
  const beforeWs = new Set()
  for (const w of before.windows || []) for (const ws of w.workspaces || []) beforeWs.add(ws.id)
  let workspace = null
  for (const w of after.windows || []) {
    for (const ws of w.workspaces || []) if (!beforeWs.has(ws.id)) workspace = ws
  }
  if (!workspace) throw new Error('boot: could not locate the new crew workspace in the tree')

  // Map panes -> roles by layout order (cmux preserves layout ordering in the
  // tree; verified live at boot smoke — if this ever drifts, match by the
  // surface title/name instead).
  const panes = workspace.panes || []
  if (panes.length !== roles.length) {
    throw new Error(`boot: expected ${roles.length} panes, found ${panes.length}`)
  }
  const members = {}
  roles.forEach((role, i) => {
    const pane = panes[i]
    const surface = (pane.surfaces || [])[0]
    members[role] = { pane_id: pane.id, surface_id: surface.id }
  })

  const crew = {
    schema_version: 1,
    task: taskSlug, checkout, workspace_id: workspace.id,
    roles, members, assignments: [], next_assignment: 1,
    created_at: new Date().toISOString(),
  }
  saveCrew(paths, crew)

  for (const role of roles) renameTab(members[role].surface_id, `${role}`)

  process.stdout.write(`${JSON.stringify({ workspace_id: workspace.id, members, task_dir: paths.taskDir })}\n`)
}

function assignCmd(args) {
  const taskSlug = slugify(args.task)
  const checkout = resolvePath(args.checkout || process.cwd())
  const paths = pathsFor(taskSlug, checkout)
  const crew = loadCrew(paths)
  const role = args.role
  if (!crew.members[role]) throw new Error(`role ${role} is not part of this crew (${crew.roles.join(', ')})`)
  if (!args.brief || !BRIEF_RE.test(args.brief)) {
    throw new Error(`brief must be a single line within the safe charset [A-Za-z0-9 _.,:;=/@'+-] — put real content in files and point at them`)
  }

  const id = `a${crew.next_assignment}`
  const returnPath = join(paths.returnsDir, `${id}.${role}.json`)
  const filesClause = args.files ? ` Read: ${args.files.split(',').join(' and ')}.` : ''
  const line = `ASSIGNMENT ${id}: ${args.brief}.${filesClause} Task dir: ${paths.taskDir}. Write your ReturnEnvelope to ${returnPath} then print exactly: CREW-DONE ${role} ${id}`

  sendLine(crew.members[role].surface_id, line)

  crew.assignments.push({ id, role, brief: args.brief, return_path: returnPath, assigned_at: new Date().toISOString(), status: 'assigned' })
  crew.next_assignment += 1
  saveCrew(paths, crew)
  process.stdout.write(`${JSON.stringify({ assignment_id: id, role, return_path: returnPath })}\n`)
}

function waitCmd(args) {
  const taskSlug = slugify(args.task)
  const checkout = resolvePath(args.checkout || process.cwd())
  const paths = pathsFor(taskSlug, checkout)
  const crew = loadCrew(paths)
  const a = crew.assignments.find((x) => x.id === args.id)
  if (!a) throw new Error(`unknown assignment id ${args.id}`)
  const timeoutMs = Number(args['timeout-s'] || 1800) * 1000
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (existsSync(a.return_path)) {
      let env
      try { env = JSON.parse(readFileSync(a.return_path, 'utf8')) } catch { env = null }
      if (env && env.assignment_id === a.id && typeof env.status === 'string') {
        a.status = env.status
        saveCrew(paths, crew)
        process.stdout.write(`${JSON.stringify({ assignment_id: a.id, status: env.status, summary: env.summary, artifacts: env.artifacts || [], details: env.details || {} })}\n`)
        return
      }
    }
    const sab = new SharedArrayBuffer(4)
    Atomics.wait(new Int32Array(sab), 0, 0, 5000)
  }
  process.stdout.write(`${JSON.stringify({ assignment_id: a.id, status: 'still-running' })}\n`)
  process.exitCode = 1
}

function statusCmd(args) {
  const taskSlug = slugify(args.task)
  const checkout = resolvePath(args.checkout || process.cwd())
  const paths = pathsFor(taskSlug, checkout)
  const crew = loadCrew(paths)
  const t = tree({ all: true })
  const alive = {}
  for (const [role, m] of Object.entries(crew.members)) {
    let found = false
    for (const w of t.windows || []) for (const ws of w.workspaces || []) for (const p of ws.panes || []) {
      for (const s of p.surfaces || []) if (s.id === m.surface_id.toLowerCase()) found = true
    }
    alive[role] = found
  }
  process.stdout.write(`${JSON.stringify({ task: crew.task, workspace_id: crew.workspace_id, alive, assignments: crew.assignments })}\n`)
}

function teardownCmd(args) {
  const taskSlug = slugify(args.task)
  const checkout = resolvePath(args.checkout || process.cwd())
  const paths = pathsFor(taskSlug, checkout)
  const crew = loadCrew(paths)
  for (const m of Object.values(crew.members)) closeSurface(m.surface_id)
  closeWorkspace(crew.workspace_id)
  const archived = `${paths.dir}.archive-${new Date().toISOString().slice(0, 10)}`
  renameSync(paths.dir, archived)
  process.stdout.write(`${JSON.stringify({ archived })}\n`)
}

// --- CLI ---------------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i]
    if (t.startsWith('--')) { out[t.slice(2)] = argv[i + 1]; i += 1 } else out._.push(t)
  }
  return out
}

const COMMANDS = { boot: bootCmd, assign: assignCmd, wait: waitCmd, status: statusCmd, teardown: teardownCmd }

const invokedDirectly = process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const [verb, ...rest] = process.argv.slice(2)
  const fn = COMMANDS[verb]
  if (!fn) {
    process.stderr.write(`usage: crew.mjs <${Object.keys(COMMANDS).join('|')}> --task <slug> ...\n`)
    process.exit(2)
  }
  try {
    fn(parseArgs(rest))
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`)
    process.stdout.write(`${JSON.stringify({ error: err.message })}\n`)
    process.exit(1)
  }
}
