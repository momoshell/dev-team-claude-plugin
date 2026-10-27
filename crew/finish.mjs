// crew finish <lane> — finish a stopped lean lane with its own builder seat (ADR-051's finish shape, lean loop).
//
// Re-enters the lane in its own worktree, on its uncommitted build, with its accepted plan and gate, and starts the
// detached `finish` run: builder triage -> gate -> mutation proof -> review -> suite -> commit -> rebase. It never
// re-plans, never re-runs the baseline and publishes nothing; the operator's publish decision is a later step.
// Refused, with nothing written: `finish-worktree` (the worktree is gone), `finish-premise` (the lane never reached
// a build), `finish-running` (a run re-entered the lane after its stop), `finish-no-build` (no accepted builder
// envelope in the journal).
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateEnvelope } from './protocols.mjs'
import { SLOT_ENV } from './reclaim.mjs'

const HOME = dirname(dirname(fileURLToPath(import.meta.url)))
const LEAN = join(HOME, 'crew', 'lean.mjs')
const LANE = /^[a-z0-9][a-z0-9-]{0,62}$/

export class FinishRefusal extends Error {
  constructor(reason, message) {
    super(message)
    this.reason = reason
  }
}

const defaultDeps = () => ({
  readFileSync, readdirSync, existsSync, statSync, mkdirSync, writeFileSync,
  spawnDetached: (file, args, { cwd, log, env }) => {
    const out = openSync(log, 'a')
    try {
      const child = spawn(file, args, { cwd, env, detached: true, stdio: ['ignore', out, out] })
      child.unref()
      return child.pid
    } finally { closeSync(out) }
  },
  crewRoot: join(homedir(), '.crew'),
  log: (line) => process.stdout.write(`${line}\n`),
})

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function readJson(d, path, what) {
  try { return JSON.parse(d.readFileSync(path, 'utf8')) } catch (error) {
    throw new FinishRefusal('finish-unreadable', `cannot read ${what} ${path}: ${error?.code ?? error?.message}`)
  }
}

export function finishLane({ lane, root, deps = {} }) {
  const d = { ...defaultDeps(), ...deps }
  const crewRoot = root ?? d.crewRoot
  if (typeof lane !== 'string' || !LANE.test(lane)) throw new FinishRefusal('finish-unreadable', `${JSON.stringify(lane)} is not a lane name`)
  const taskDir = join(crewRoot, `dt-${lane}`, lane, 'task')
  const spec = readJson(d, join(taskDir, 'lean.json'), 'the lane spec')
  let journalText
  try { journalText = d.readFileSync(join(taskDir, 'journal.jsonl'), 'utf8') } catch (error) {
    throw new FinishRefusal('finish-unreadable', `cannot read the lane journal: ${error?.code ?? error?.message}`)
  }
  const rows = journalText.split('\n').filter((line) => line.trim() !== '').map((line) => {
    try { return JSON.parse(line) } catch { throw new FinishRefusal('finish-unreadable', 'the lane journal has a malformed row') }
  }).filter(isObject)
  const lastRow = (test) => rows.findLast(test)

  let isDir = false
  try { isDir = typeof spec?.cwd === 'string' && d.statSync(spec.cwd).isDirectory() } catch { isDir = false }
  if (!isDir) throw new FinishRefusal('finish-worktree', `the lane worktree ${spec?.cwd} does not exist`)

  const stopped = lastRow((row) => row.event === 'verdict' && row.status === 'stopped')
  if (!stopped) throw new FinishRefusal('finish-premise', `lane ${lane} has not stopped`)
  // A stop the loop writes after a stage closed carries stage null, so the stage it stopped in is the last one started.
  const stopAt = rows.lastIndexOf(stopped)
  const stoppedIn = rows.slice(0, stopAt).findLast((row) => row.event === 'stage-start')?.stage ?? stopped.stage
  if ([stopped.stage, stoppedIn].some((stage) => stage === 'plan' || stage === 'baseline')) throw new FinishRefusal('finish-premise', `lane ${lane} stopped in the ${stoppedIn} stage, before any build`)
  // A row after the stop means a run has re-entered the lane since: a second finish would race it.
  if (rows.slice(stopAt + 1).some((row) => row.event === 'stage-start' || row.event === 'finish-ready')) throw new FinishRefusal('finish-running', `lane ${lane} has run again since it stopped`)

  const built = rows.some((row) => row.event === 'envelope' && row.role === 'builder' && Array.isArray(row.defects) && row.defects.length === 0 && row.parsed?.status === 'done')
  if (!built) throw new FinishRefusal('finish-no-build', `lane ${lane} has no accepted builder envelope in its journal`)

  let plannerFile = null
  let best = 0
  for (const name of d.readdirSync(taskDir)) {
    const n = /^planner-(\d+)\.json$/.exec(name)
    if (n && Number(n[1]) > best) { best = Number(n[1]); plannerFile = name }
  }
  if (!plannerFile) throw new FinishRefusal('finish-premise', `lane ${lane} has no planner return`)
  const checked = validateEnvelope('planner', readJson(d, join(taskDir, plannerFile), 'the planner return'))
  if (checked.defects.length > 0 || checked.envelope?.status !== 'done') throw new FinishRefusal('finish-premise', `the planner return ${plannerFile} is not an accepted plan`)
  const { subject, plan_path: planPath, gate_path: gatePath, mutations } = checked.envelope.details

  const reviewed = lastRow((row) => row.event === 'verdict' && row.status === 'reviewed')
  const finish = {
    planPath, gatePath, subject, mutations,
    stop: { reason: stopped.reason, observation: stopped.observation ?? null },
    findings: reviewed?.verdict === 'changes-needed' && Array.isArray(reviewed.findings) ? reviewed.findings : [],
    turnOffset: rows.filter((row) => row.event === 'envelope').length,
  }
  const specPath = join(taskDir, 'finish.json')
  const started = join(crewRoot, 'briefs', 'started')
  d.mkdirSync(started, { recursive: true })
  d.writeFileSync(specPath, `${JSON.stringify({ ...spec, shape: 'finish', finish }, null, 2)}\n`)
  const log = join(started, `${lane}.run.log`)
  const env = { ...process.env, [SLOT_ENV.capacity]: '0' }
  const pid = d.spawnDetached(process.execPath, [LEAN, specPath], { cwd: spec.cwd, log, env })
  d.log(`crew finish: lane=${lane} stop=${finish.stop.reason} findings=${finish.findings.length} pid=${pid}`)
  d.log(`  worktree ${spec.cwd}`)
  d.log(`  log      ${log}`)
  d.log(`  spec     ${specPath}`)
  return { lane, worktree: spec.cwd, specPath, pid }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  if (argv.length !== 1 || argv[0].startsWith('--')) {
    process.stderr.write('usage: crew finish <lane>\n')
    return 2
  }
  try {
    finishLane({ lane: argv[0], deps })
    return 0
  } catch (error) {
    if (!(error instanceof FinishRefusal)) throw error
    process.stderr.write(`crew finish: ${error.reason}: ${error.message}\n`)
    return 1
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main()
}
