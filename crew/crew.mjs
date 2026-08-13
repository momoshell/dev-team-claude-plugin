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
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync,
} from 'node:fs'
import { join, dirname, resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { execSync, execFileSync, spawnSync } from 'node:child_process'

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
// `tools` is the seat's auto-approve surface (--allowedTools — inert under
// bypassPermissions, kept for any non-bypass relaunch). `deny` is the seat's
// ENFORCED tool boundary (--disallowedTools holds even under bypass): only
// the builder may Edit, only planner/reviewer may spawn subagents. Note Write
// stays available everywhere — every seat writes envelopes and task-dir
// artifacts — so the REPO boundary for non-builder seats is the git scope
// gate + commit-in-scope, not tool denial.
export const SEAT_DEFAULTS = Object.freeze({
  lead: { model: 'opus', tools: 'Read,Glob,Grep,Bash,Write', deny: 'Edit,NotebookEdit,Task,Agent', prompt: 'lead.md' },
  planner: { model: 'opus', tools: 'Read,Glob,Grep,Bash,Write,Task', deny: 'Edit,NotebookEdit', prompt: 'planner.md' },
  builder: { model: 'sonnet', tools: 'Read,Edit,Write,Glob,Grep,Bash', deny: 'Task,Agent', prompt: 'builder.md' },
  reviewer: { model: 'opus', tools: 'Read,Glob,Grep,Bash,Write,Task', deny: 'Edit,NotebookEdit', prompt: 'reviewer.md' },
  'tech-lead': { model: 'opus', tools: 'Read,Glob,Grep,Bash,Write', deny: 'Edit,NotebookEdit,Task,Agent', prompt: 'tech-lead.md' },
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
  // --append-system-prompt-file is LAST-WINS, not cumulative (verified against
  // claude 2.1.229): passing shared + role as two flags silently drops shared.
  // So the shared contract and the role card are merged into ONE prompt file
  // per seat, generated in the task dir at boot.
  const merged = join(taskDir, `role-${role}.md`)
  writeFileSync(merged, `${readFileSync(SHARED_PROMPT, 'utf8')}\n\n${readFileSync(join(ROLES_DIR, seat.prompt), 'utf8')}`)
  // `env` (a real binary) sets the vars regardless of how cmux runs the
  // command. DEVTEAM_WORKER=1 keeps any installed dev-team plugin hooks
  // quiet inside the pane (defensive; a no-op when the plugin is absent).
  // bypassPermissions: crew seats run unattended (no human at their pane to
  // approve). The ENFORCED tool boundary is --disallowedTools (it holds even
  // under bypass; --allowedTools is only an auto-approve list and is inert
  // here) — beyond that, containment is the git scope gate, the feature-
  // branch blast radius, and the operator's global deny rules.
  return [
    'env', 'DEVTEAM_WORKER=1', `CREW_ROLE=${role}`, `CREW_TASK_DIR="${taskDir}"`,
    'claude', '--model', seatModel(role, args), '--permission-mode', 'bypassPermissions',
    '--allowedTools', `"${seat.tools}"`,
    '--disallowedTools', `"${seat.deny}"`,
    '--append-system-prompt-file', `"${merged}"`,
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
  const mk = (role) => paneCommand(role, args, { checkout, taskDir: paths.taskDir, bootBrief })
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
      members[role] = { pane_id: hit.pane.id, surface_id: hit.surface.id, model: seatModel(role, args) }
    }
  } else {
    roles.forEach((role, i) => {
      const surface = (panes[i].surfaces || [])[0]
      members[role] = { pane_id: panes[i].id, surface_id: surface.id, model: seatModel(role, args) }
    })
  }
  for (const role of roles) renameTab(members[role].surface_id, role)

  const crew = {
    schema_version: 2, task: taskSlug, checkout,
    workspace_id: workspace.id, window_id: windowId,
    roles, members, task_return: join(paths.returnsDir, 'task.json'),
    created_at: new Date().toISOString(),
  }
  saveCrew(paths, crew)
  logLine(join(paths.dir, 'journal.jsonl'), { at: new Date().toISOString(), event: 'boot', roles, models: Object.fromEntries(roles.map((r) => [r, members[r].model])) })
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
    log(obj) { logLine(join(paths.dir, 'journal.jsonl'), obj) },
    now() { return Date.now() },
  }
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
  // The driver assigns all four core seats unconditionally — discover a
  // missing seat NOW, not mid-loop after a plan and a build are spent.
  for (const role of ['lead', 'planner', 'builder', 'reviewer']) {
    if (!crew.members[role]) throw new Error(`v3 run requires a ${role} seat (booted roles: ${crew.roles.join(', ')})`)
  }
  // The scope gate reads `git status` as ground truth — a dirty checkout at
  // start would be attributed to the builder and poison every scope verdict.
  const dirty = execSync('git status --porcelain', { cwd: checkout, encoding: 'utf8' }).trim()
  if (dirty) throw new Error(`checkout is dirty — commit or stash before a crew run:\n${dirty.split('\n').slice(0, 10).join('\n')}`)

  const journal = join(paths.dir, 'journal.jsonl')
  const ctx = {
    task: taskSlug, briefFile, taskDir: paths.taskDir, checkout, journal,
    roles: crew.roles, lane: args.lane || null, suite: args.suite || 'node --test',
  }
  const io = realIo(crew, paths, checkout)
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
  try { fn(parseArgs(rest)) } catch (err) {
    process.stderr.write(`error: ${err.message}\n`)
    process.stdout.write(`${JSON.stringify({ error: err.message })}\n`)
    process.exit(1)
  }
}
