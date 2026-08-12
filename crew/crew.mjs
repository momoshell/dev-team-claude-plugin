#!/usr/bin/env node
// crew/crew.mjs — crew v2: a self-contained team runtime (zero legacy
// dev-team imports). One cmux workspace per task, booted in a single
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
//                  [--checkout <dir>] [--model-<role> <id>]...
//   crew.mjs run   --task <slug> --brief-file <path>   # hand the task to the lead
//   crew.mjs wait  --task <slug> [--timeout-s N]       # await the LEAD's envelope
//   crew.mjs status --task <slug>
//   crew.mjs teardown --task <slug>
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
} from 'node:fs'
import { join, dirname, resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { cmux, tree, locate, sendLine, renameTab, closeSurface, closeWorkspace, logLine } from './driver.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROLES_DIR = join(HERE, 'roles')
const SHARED_PROMPT = join(ROLES_DIR, '_shared.md')

// Per-seat defaults. Model is overridable per task (--model-<role>) so the
// orchestrator can size the crew: cheap seats for mechanical work, capable
// seats where judgment lives. Tools are role-scoped; the LEAD alone gets the
// integration surface (Bash for tests+git, no repo Edit — it verifies and
// commits, never authors source).
export const SEAT_DEFAULTS = Object.freeze({
  lead: { model: 'opus', tools: 'Read,Glob,Grep,Bash,Write', prompt: 'lead.md' },
  planner: { model: 'opus', tools: 'Read,Glob,Grep,Bash,Write,Task', prompt: 'planner.md' },
  builder: { model: 'sonnet', tools: 'Read,Edit,Write,Glob,Grep,Bash', prompt: 'builder.md' },
  reviewer: { model: 'opus', tools: 'Read,Glob,Grep,Bash,Write,Task', prompt: 'reviewer.md' },
  'tech-lead': { model: 'opus', tools: 'Read,Glob,Grep,Bash,Write', prompt: 'tech-lead.md' },
})
export const DEFAULT_ROLES = Object.freeze(['lead', 'planner', 'builder', 'reviewer'])

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

function paneCommand(role, args, { checkout, taskDir, bootBrief }) {
  const seat = SEAT_DEFAULTS[role]
  const rolePrompt = join(ROLES_DIR, seat.prompt)
  // `env` (a real binary) sets the vars regardless of how cmux runs the
  // command. DEVTEAM_WORKER=1 keeps any installed dev-team plugin hooks
  // quiet inside the pane (defensive; a no-op when the plugin is absent).
  return [
    'env', 'DEVTEAM_WORKER=1', `CREW_ROLE=${role}`, `CREW_TASK_DIR=${taskDir}`,
    'claude', '--model', seatModel(role, args), '--permission-mode', 'acceptEdits',
    '--allowedTools', `"${seat.tools}"`,
    '--append-system-prompt-file', `"${SHARED_PROMPT}"`,
    '--append-system-prompt-file', `"${rolePrompt}"`,
    `"${bootBrief}"`,
  ].join(' ')
}

function stackVertical(nodes) {
  if (nodes.length === 1) return nodes[0]
  const [head, ...rest] = nodes
  return { direction: 'vertical', split: 1 / nodes.length, children: [head, stackVertical(rest)] }
}

// lead takes the left half; members stack on the right.
export function composeLayout(roles, mk) {
  const panes = roles.map((r) => ({ pane: { surfaces: [{ type: 'terminal', name: r, command: mk(r) }] } }))
  if (panes.length === 1) return panes[0]
  const [head, ...rest] = panes
  return { direction: 'horizontal', split: 0.42, children: [head, stackVertical(rest)] }
}

function bootCmd(args) {
  const taskSlug = slug(args.task)
  const checkout = resolvePath(args.checkout || process.cwd())
  let roles = (args.roles ? args.roles.split(',') : [...DEFAULT_ROLES]).map((r) => r.trim())
  if (!roles.includes('lead')) roles = ['lead', ...roles]
  for (const r of roles) if (!SEAT_DEFAULTS[r]) throw new Error(`unknown crew role: ${r}`)

  const paths = pathsFor(taskSlug, checkout)
  mkdirSync(paths.taskDir, { recursive: true })
  mkdirSync(paths.returnsDir, { recursive: true })

  const bootBrief = `Crew for task ${taskSlug}. Task dir ${paths.taskDir}. Read your role in the system prompt, reply exactly ready: your-role, then wait.`
  const mk = (role) => paneCommand(role, args, { checkout, taskDir: paths.taskDir, bootBrief })
  const layout = composeLayout(roles, mk)

  const before = tree()
  const res = cmux('new-workspace', ['--name', `crew-${taskSlug}`, '--cwd', checkout, '--layout', JSON.stringify(layout), '--focus', 'true'])
  if (!res.ok) throw new Error(`new-workspace --layout failed: ${res.error.message}`)
  const after = tree()

  const beforeWs = new Set()
  for (const w of before.windows || []) for (const ws of w.workspaces || []) beforeWs.add(ws.id)
  let workspace = null; let windowId = null
  for (const w of after.windows || []) for (const ws of w.workspaces || []) {
    if (!beforeWs.has(ws.id)) { workspace = ws; windowId = w.id }
  }
  if (!workspace) throw new Error('boot: new crew workspace not found in tree')
  const panes = workspace.panes || []
  if (panes.length !== roles.length) throw new Error(`boot: expected ${roles.length} panes, found ${panes.length}`)

  const members = {}
  roles.forEach((role, i) => {
    const surface = (panes[i].surfaces || [])[0]
    members[role] = { pane_id: panes[i].id, surface_id: surface.id, model: seatModel(role, args) }
  })
  for (const role of roles) renameTab(members[role].surface_id, role)

  const crew = {
    schema_version: 2, task: taskSlug, checkout,
    workspace_id: workspace.id, window_id: windowId,
    roles, members, lead_return: join(paths.returnsDir, 'lead.json'),
    created_at: new Date().toISOString(),
  }
  saveCrew(paths, crew)
  logLine(join(paths.dir, 'crew.log'), { at: new Date().toISOString(), event: 'boot', roles, models: Object.fromEntries(roles.map((r) => [r, members[r].model])) })
  process.stdout.write(`${JSON.stringify({ workspace_id: workspace.id, members, task_dir: paths.taskDir, crew_json: join(paths.dir, 'crew.json') })}\n`)
}

// Hand the whole task to the LEAD (the only assignment the orchestrator makes).
function runCmd(args) {
  const taskSlug = slug(args.task)
  const checkout = resolvePath(args.checkout || process.cwd())
  const paths = pathsFor(taskSlug, checkout)
  const crew = loadCrew(paths)
  if (!args['brief-file']) throw new Error('run requires --brief-file <path to the task brief>')
  const briefFile = resolvePath(args['brief-file'])
  if (!existsSync(briefFile)) throw new Error(`brief file not found: ${briefFile}`)

  const line = `TASK: run this task end to end. Read the brief at ${briefFile} and the crew map at ${join(paths.dir, 'crew.json')}. Drive the crew, verify, commit on green, then write your ReturnEnvelope to ${crew.lead_return} and print CREW-DONE lead task`
  sendLine(crew.members.lead.surface_id, line)
  logLine(join(paths.dir, 'crew.log'), { at: new Date().toISOString(), event: 'run', brief: briefFile })
  process.stdout.write(`${JSON.stringify({ handed_to: 'lead', lead_return: crew.lead_return })}\n`)
}

function waitCmd(args) {
  const taskSlug = slug(args.task)
  const checkout = resolvePath(args.checkout || process.cwd())
  const paths = pathsFor(taskSlug, checkout)
  const crew = loadCrew(paths)
  const timeoutMs = Number(args['timeout-s'] || 3600) * 1000
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(crew.lead_return)) {
      let env = null
      try { env = JSON.parse(readFileSync(crew.lead_return, 'utf8')) } catch { env = null }
      if (env && typeof env.status === 'string') {
        process.stdout.write(`${JSON.stringify({ status: env.status, summary: env.summary, artifacts: env.artifacts || [], details: env.details || {} })}\n`)
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
  const crew = loadCrew(paths)
  const t = tree()
  const alive = {}
  for (const [role, m] of Object.entries(crew.members)) alive[role] = !!locate(t, m.surface_id)
  process.stdout.write(`${JSON.stringify({ task: crew.task, workspace_id: crew.workspace_id, alive })}\n`)
}

function teardownCmd(args) {
  const taskSlug = slug(args.task)
  const checkout = resolvePath(args.checkout || process.cwd())
  const paths = pathsFor(taskSlug, checkout)
  const crew = loadCrew(paths)
  for (const m of Object.values(crew.members)) closeSurface(m.surface_id)
  closeWorkspace(crew.workspace_id)
  const archived = `${paths.dir}.archive-${new Date().toISOString().slice(0, 10)}`
  renameSync(paths.dir, archived)
  process.stdout.write(`${JSON.stringify({ archived })}\n`)
}

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i]
    if (t.startsWith('--')) { out[t.slice(2)] = argv[i + 1]; i += 1 } else out._.push(t)
  }
  return out
}

const COMMANDS = { boot: bootCmd, run: runCmd, wait: waitCmd, status: statusCmd, teardown: teardownCmd }
const invokedDirectly = process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const [verb, ...rest] = process.argv.slice(2)
  const fn = COMMANDS[verb]
  if (!fn) { process.stderr.write(`usage: crew.mjs <${Object.keys(COMMANDS).join('|')}> --task <slug> ...\n`); process.exit(2) }
  try { fn(parseArgs(rest)) } catch (err) {
    process.stderr.write(`error: ${err.message}\n`)
    process.stdout.write(`${JSON.stringify({ error: err.message })}\n`)
    process.exit(1)
  }
}
