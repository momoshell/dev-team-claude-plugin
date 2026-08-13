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

import { execSync, spawnSync } from 'node:child_process'

import { cmux, tree, locate, sendLine, renameTab, closeSurface, closeWorkspace, logLine, assignmentLine } from './driver.mjs'
import { driveTask } from './drive.mjs'

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
  // bypassPermissions: crew seats run unattended (no human at their pane to
  // approve), sandboxed by their --allowedTools list; the workspace/checkout is
  // the blast radius. Same posture as the reference team-boot implementations.
  return [
    'env', 'DEVTEAM_WORKER=1', `CREW_ROLE=${role}`, `CREW_TASK_DIR=${taskDir}`,
    'claude', '--model', seatModel(role, args), '--permission-mode', 'bypassPermissions',
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

// v3: the deterministic driver runs the task loop (code disposes); the lead
// pane is consulted only at decision points. This IS `run` now; the v2
// agent-driven handoff survives as `handoff` for comparison runs.
function realIo(crew, paths, checkout) {
  let seq = 0
  return {
    assign({ role, briefFile }) {
      const m = crew.members[role]
      if (!m) throw new Error(`role ${role} not seated in this crew`)
      seq += 1
      const id = `d${seq}`
      const returnPath = join(paths.returnsDir, `${id}.${role}.json`)
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
      return { ok: res.status === 0, output: `${res.stdout || ''}${res.stderr || ''}` }
    },
    changedFiles() {
      const out = execSync('git status --porcelain', { cwd: checkout, encoding: 'utf8' })
      return out.split('\n').filter(Boolean).map((l) => l.slice(3).trim()).filter(Boolean)
    },
    commit(files, message) {
      execSync(`git add -- ${files.map((f) => `'${f}'`).join(' ')}`, { cwd: checkout })
      execSync('git commit -q -F -', { cwd: checkout, input: message })
      return execSync('git rev-parse --short HEAD', { cwd: checkout, encoding: 'utf8' }).trim()
    },
    log(obj) { logLine(join(paths.dir, 'journal.jsonl'), obj) },
    now() { return Date.now() },
  }
}

function runCmd(args) {
  const taskSlug = slug(args.task)
  const checkout = resolvePath(args.checkout || process.cwd())
  const paths = pathsFor(taskSlug, checkout)
  const crew = loadCrew(paths)
  if (!args['brief-file']) throw new Error('run requires --brief-file <path to the task brief>')
  const briefFile = resolvePath(args['brief-file'])
  if (!existsSync(briefFile)) throw new Error(`brief file not found: ${briefFile}`)
  if (!crew.members.lead) throw new Error('v3 run requires a lead seat (the decision judge)')

  const ctx = {
    task: taskSlug, briefFile, taskDir: paths.taskDir, checkout,
    roles: crew.roles, lane: args.lane || null, suite: args.suite || 'node --test',
  }
  const io = realIo(crew, paths, checkout)
  const result = driveTask(ctx, io)
  // The task envelope is written by CODE — same path `wait` watches.
  writeFileSync(crew.lead_return, JSON.stringify(result, null, 2))

  // Outcome-gated lifecycle, in code as policy:
  //   done       -> auto-teardown (archive the record, close the view),
  //                 unless --keep was passed for pane inspection.
  //   escalation -> NEVER teardown: the workspace IS the escalation context
  //                 (warm members, readable panes) the human needs.
  let archived = null
  if (result.status === 'done' && args.keep === undefined) {
    archived = teardownCore(paths, crew)
  }
  // After archive the envelope moves with the dir — report where it lives now.
  const taskReturn = archived ? crew.lead_return.replace(paths.dir, archived) : crew.lead_return
  process.stdout.write(`${JSON.stringify({ status: result.status, commit: result.details?.commit ?? null, task_return: taskReturn, archived })}\n`)
  if (result.status !== 'done') process.exitCode = 1
}

// v2 legacy: hand the whole task to the LEAD as the driver (agent-driven).
function handoffCmd(args) {
  const taskSlug = slug(args.task)
  const checkout = resolvePath(args.checkout || process.cwd())
  const paths = pathsFor(taskSlug, checkout)
  const crew = loadCrew(paths)
  if (!args['brief-file']) throw new Error('handoff requires --brief-file <path to the task brief>')
  const briefFile = resolvePath(args['brief-file'])
  if (!existsSync(briefFile)) throw new Error(`brief file not found: ${briefFile}`)

  const line = `TASK: run this task end to end. Read the brief at ${briefFile} and the crew map at ${join(paths.dir, 'crew.json')}. Drive the crew, verify, commit on green, then write your ReturnEnvelope to ${crew.lead_return} and print CREW-DONE lead task`
  sendLine(crew.members.lead.surface_id, line)
  logLine(join(paths.dir, 'crew.log'), { at: new Date().toISOString(), event: 'handoff', brief: briefFile })
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

// Archive the crew dir (the durable record: envelopes, journal, artifacts)
// and close the ephemeral view (panes, workspace). Everything evidentiary is
// on disk by contract before this runs — deliverables live in files, never
// pane scrollback.
function teardownCore(paths, crew) {
  for (const m of Object.values(crew.members)) closeSurface(m.surface_id)
  closeWorkspace(crew.workspace_id)
  const archived = `${paths.dir}.archive-${new Date().toISOString().slice(0, 10)}`
  renameSync(paths.dir, archived)
  return archived
}

function teardownCmd(args) {
  const taskSlug = slug(args.task)
  const checkout = resolvePath(args.checkout || process.cwd())
  const paths = pathsFor(taskSlug, checkout)
  const crew = loadCrew(paths)
  const archived = teardownCore(paths, crew)
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

const COMMANDS = { boot: bootCmd, run: runCmd, handoff: handoffCmd, wait: waitCmd, status: statusCmd, teardown: teardownCmd }
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
