// This module is the forked child's entry point; it exists so the long-lived
// server process never loads drive.mjs/realio.mjs, and runner imports belong
// here and nowhere else.
import {
  readFileSync as fsReadFileSync,
  writeFileSync as fsWriteFileSync,
  existsSync as fsExistsSync,
  mkdirSync as fsMkdirSync,
} from 'node:fs'
import { execSync as cpExecSync } from 'node:child_process'
import { basename, join, resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { driveTask as defaultDriveTask } from './drive.mjs'
import { realIo as defaultRealIo } from './realio.mjs'
import { openRun } from '../scripts/factory/emit.mjs'
import { paneSeat, isObject } from './daemon.mjs'
import { slugOrNull } from './slug.mjs'

const SELF_PATH = fileURLToPath(import.meta.url)

function childArguments(argv) {
  if (isObject(argv) && !Array.isArray(argv)) return argv
  const values = Array.isArray(argv) ? argv : process.argv.slice(2)
  const index = values.indexOf('--run-child')
  const raw = index >= 0 ? values[index + 1] : values[0]
  if (!raw) throw new Error('run child requires a JSON run specification')
  try { return JSON.parse(raw) }
  catch (err) { throw new Error(`invalid run-child specification: ${err.message}`) }
}

function ledgerDbPath(env) {
  return env.DEVTEAM_LEDGER_DB
    || join(env.DEVTEAM_LEDGER_DIR || join(homedir(), '.dev-team', 'factory'), 'ledger.db')
}

function ledgerSidecarDbPath(crewDir, exists, read) {
  const path = join(crewDir, 'ledger', 'run.json')
  if (!exists(path)) return null
  try {
    const sidecar = JSON.parse(String(read(path, 'utf8')))
    return typeof sidecar?.db_path === 'string' ? sidecar.db_path : null
  } catch { return null }
}

export function runChild(argv, injected = {}) {
  const spec = childArguments(argv)
  const read = injected.readFileSync || fsReadFileSync
  const write = injected.writeFileSync || fsWriteFileSync
  const existsChild = injected.existsSync || fsExistsSync
  const mkdir = injected.mkdirSync || fsMkdirSync
  const exec = injected.execSync || cpExecSync
  // `harness` decides how a preflight failure is REPORTED — rethrown for a
  // test driving runChild directly, or written as an escalation envelope in
  // production. It deliberately no longer decides WHETHER preflight runs.
  const harness = !!(injected.driveTask || injected.realIo)
  // Preflight runs UNLESS a caller opts out explicitly. Deriving this from
  // `harness` meant "I supplied a fake io" silently also meant "skip the seat,
  // brief, checkout-identity and dirty-tree guards" — and DI is the crew's
  // universal seam. Only tests inject today, so nothing shipped weaker; the
  // switch was wrong-way-round for the first caller who injects in production.
  const strictPreflight = injected.preflight !== false
  const crewDir = resolvePath(spec.crew_dir)
  const crewPath = join(crewDir, 'crew.json')
  let crew
  try { crew = JSON.parse(String(read(crewPath, 'utf8'))) } catch (err) { throw new Error(`cannot read crew.json at ${crewPath}: ${err.message}`) }
  const roles = crew.roles || Object.keys(crew.members || {})
  const taskDir = join(crewDir, 'task')
  const returnsDir = join(crewDir, 'returns')
  const taskReturn = resolvePath(crewDir, spec.task_return || crew.task_return || join('returns', 'task.json'))
  const checkout = resolvePath(spec.checkout || crew.checkout || process.cwd())
  const briefFile = spec.brief_file || spec.briefFile
  const ctx = {
    task: spec.task || crew.task, briefFile: briefFile ? resolvePath(briefFile) : null,
    taskDir, checkout, journal: join(crewDir, 'journal.jsonl'),
    roles: roles.filter((role) => role !== 'lead'),
    continuation: spec.continuation === true,
    seatedRoles: [...roles],
    // This is the same lane as package.json's scripts.test; reasoning lives in
    // crew/crew.mjs's ctx block, and crew/crew.test.mjs pins the agreement.
    lane: spec.lane || null, suite: spec.suite || 'node --test --test-timeout=30000',
    ...(spec.variant ? { variant: spec.variant } : {}),
  }
  const failure = (err) => ({
    status: 'escalation', summary: `Task ${ctx.task} needs a human: the driver crashed (${err.message})`,
    artifacts: [ctx.journal], details: { stages: null, commit: null, dissents: [], escalation: { where: err.stage || 'child-preflight', why: err.message } },
  })
  let result
  let emitter = null
  try {
    const pane = paneSeat(crew)
    if (pane) throw new Error(`daemon run refuses pane transport for seat ${pane}`)
    if (strictPreflight) {
      for (const role of ['planner', 'builder', 'reviewer']) if (!crew.members?.[role]) throw new Error(`v3 run requires a ${role} seat (booted roles: ${roles.join(', ')})`)
      if (roles.includes('lead') && !crew.members?.lead) throw new Error(`v3 run requires a lead seat (booted roles: ${roles.join(', ')})`)
      if (!briefFile) throw new Error('run requires --brief-file <path to the task brief>')
      if (!existsChild(ctx.briefFile)) throw new Error(`brief file not found: ${ctx.briefFile}`)
      if (crew.checkout && resolvePath(crew.checkout) !== checkout) throw new Error(`this crew was booted for ${resolvePath(crew.checkout)}, not ${checkout} — same directory name, different checkout`)
      if (spec.continuation !== true) {
        // The daemon's regrant hook is the sole caller that sets continuation:
        // it resumes ON TOP OF the escalated round's uncommitted work.
        const dirty = String(exec('git status --porcelain', { cwd: checkout, encoding: 'utf8' }) || '').trim()
        if (dirty) throw new Error(`checkout is dirty — commit or stash before a crew run:\n${dirty.split('\n').slice(0, 10).join('\n')}`)
      }
    }
    mkdir(taskDir, { recursive: true }); mkdir(returnsDir, { recursive: true })
    const realIo = injected.realIo || defaultRealIo
    const driveTask = injected.driveTask || defaultDriveTask
    const noCmux = injected.realIoDeps || {
      cmux: () => ({ ok: true }), tree: () => ({ windows: [] }), locate: () => null,
      sendLine: () => {}, closeSurface: () => {},
    }
    // Keep daemon-forked runs in the factory ledger too. openRun deliberately
    // adopts a crew-local ledger/run.json's db_path. That identity is
    // load-bearing only for a configured ceiling: feature-off instrumentation
    // must keep adopting its sidecar and must never become an admission refusal.
    // nodeVersion is deliberately not passed: openRun's own default is
    // process.versions.node.
    const dbPath = spec.ledger_db || ledgerDbPath(injected.env || process.env)
    const enforceBudgetLedger = spec.budget_enabled === true
    let sidecarDbPath = ledgerSidecarDbPath(crewDir, existsChild, read)
    if (!enforceBudgetLedger || sidecarDbPath == null || sidecarDbPath === dbPath) {
      try {
        emitter = openRun({
          stateDir: crewDir,
          repoSlug: slugOrNull(basename(checkout)) || 'repo',
          taskSlug: slugOrNull(ctx.task) || 'task',
          dbPath,
        })
        // Re-read after openRun's own locked adopt/create decision so a sidecar
        // changed between the first read and the open cannot redirect budgeted
        // work away from the ledger the daemon reads.
        sidecarDbPath = emitter?.sidecar?.()?.db_path ?? null
        if (!enforceBudgetLedger || sidecarDbPath == null || sidecarDbPath === dbPath) {
          emitter.startRun()
          emitter.linkRun(spec.run_id, { crewDir })
        }
      } catch { emitter = null }
    }
    if (enforceBudgetLedger && sidecarDbPath && sidecarDbPath !== dbPath) {
      emitter = null
      const err = new Error(`ledger sidecar at ${join(crewDir, 'ledger', 'run.json')} targets ${sidecarDbPath}, not the daemon ledger ${dbPath} — refusing to run with a mismatched budget ledger; boot a fresh crew or repair the stale sidecar`)
      err.stage = 'ledger-sidecar'
      result = failure(err)
    } else {
      const io = realIo(crew, { dir: crewDir, taskDir, returnsDir }, checkout, emitter, injected.adapters || null, spec, noCmux)
      try { result = driveTask(ctx, io) } catch (err) { result = failure(err) }
    }
  } catch (err) {
    if (harness) throw err
    result = failure(err)
  }
  try { emitter?.endRun({ status: result.status === 'done' ? 'ok' : 'aborted' }) } catch { /* never load-bearing */ }
  write(taskReturn, JSON.stringify(result, null, 2))
  const mirror = join(returnsDir, 'task.json')
  if (taskReturn !== mirror) {
    try { write(mirror, JSON.stringify(result, null, 2)) } catch { /* the run's own envelope is the record; the mirror is a convenience for wait/status/visualizer */ }
  }
  return result
}

const invokedDirectly = process.argv[1] && resolvePath(process.argv[1]) === resolvePath(SELF_PATH)
if (invokedDirectly && process.argv.includes('--run-child')) {
  try { runChild(process.argv.slice(2)) }
  catch (err) { process.stderr.write(`error: ${err.message}\n`); process.exitCode = 1 }
}
