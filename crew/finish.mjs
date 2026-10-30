// crew finish <lane> — finish a stopped lean lane with its own builder seat (ADR-051's finish shape, lean loop).
//
// Re-enters the lane in its own worktree, on its uncommitted build, with its accepted plan and gate, and starts the
// detached `finish` run: builder triage -> gate -> mutation proof -> review -> suite -> commit -> rebase. It never
// re-plans, never re-runs the baseline and publishes nothing; the operator's publish decision is a later step:
// `--accept [--notes <file>]` publishes the PR the finish run measured (merging stays the operator's), `--return <file>`
// runs one more finish pass with the file as the builder's guidance (it counts against the three review rounds) and
// `--abandon` ends the lane unpublished. Each appends a `finish-decision` row; a lane takes one decision per ready.
// Refused, with nothing written: `finish-worktree` (the worktree is gone), `finish-premise` (the lane never reached
// a build), `finish-running` (a run re-entered or claimed the lane after its stop), `finish-published` and
// `finish-committed` (nothing uncommitted is left), `finish-no-build` (no schema-valid done or insufficient builder envelope in the journal).
// The PR carries the measured subject and body, and the notes, exactly (the lane's issues ride on trailer lines); gh pr edit
// restores that text where opening rewrote issue tokens or the PR was already open. A decision is refused as `finish-not-ready`
// (the last run did not end finish-ready), `finish-decided` (it already has one), `finish-head-moved` (accept: the checkout is
// no longer the head the run measured) or `finish-publish` (the PR did not open; nothing is recorded, so it can be retried).
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openPullRequest, runSuite } from './checks.mjs'
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
  readFileSync, readdirSync, existsSync, statSync, mkdirSync, writeFileSync, appendFileSync, rmSync, openPullRequest, run: runSuite,
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

// The lane's spec and journal rows.
function loadLane(d, lane, crewRoot) {
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
  return { taskDir, spec, rows }
}

function requireWorktree(d, spec) {
  let isDir = false
  try { isDir = typeof spec?.cwd === 'string' && d.statSync(spec.cwd).isDirectory() } catch { isDir = false }
  if (!isDir) throw new FinishRefusal('finish-worktree', `the lane worktree ${spec?.cwd} does not exist`)
}

// The lane's accepted plan: subject, plan and gate paths and mutation declarations.
function loadPlan(d, lane, taskDir) {
  let plannerFile = null
  let best = 0
  for (const name of d.readdirSync(taskDir)) {
    const n = /^planner-(\d+)\.json$/.exec(name)
    if (n && Number(n[1]) > best) { best = Number(n[1]); plannerFile = name }
  }
  if (!plannerFile) throw new FinishRefusal('finish-premise', `lane ${lane} has no planner return`)
  const checked = validateEnvelope('planner', readJson(d, join(taskDir, plannerFile), 'the planner return'))
  if (checked.defects.length > 0 || checked.envelope?.status !== 'done') throw new FinishRefusal('finish-premise', `the planner return ${plannerFile} is not an accepted plan`)
  return checked.envelope.details
}

// The finish spec for a stop: the stop, the findings still open at that point of the journal, and the turn offset.
function finishFor(rows, stopped, before, plan) {
  const { subject, plan_path: planPath, gate_path: gatePath, mutations } = plan
  const reviewed = rows.slice(0, before).findLast((row) => row.event === 'verdict' && row.status === 'reviewed')
  return {
    planPath, gatePath, subject, mutations,
    stop: { reason: stopped.reason, observation: stopped.observation ?? null },
    findings: reviewed?.verdict === 'changes-needed' && Array.isArray(reviewed.findings) ? reviewed.findings : [],
    turnOffset: rows.filter((row) => row.event === 'envelope').length,
  }
}

// Writes finish.json and spawns the detached run; a launch that fails releases the claim, so the lane can be retried.
function launch(d, { crewRoot, taskDir, spec, finish, claim }) {
  const specPath = join(taskDir, 'finish.json')
  const started = join(crewRoot, 'briefs', 'started')
  const log = join(started, `${spec.id}.run.log`)
  let pid
  try {
    d.mkdirSync(started, { recursive: true })
    d.writeFileSync(specPath, `${JSON.stringify({ ...spec, shape: 'finish', finish }, null, 2)}\n`)
    const env = { ...process.env, [SLOT_ENV.capacity]: '0' }
    pid = d.spawnDetached(process.execPath, [LEAN, specPath], { cwd: spec.cwd, log, env })
  } catch (error) {
    try { d.rmSync(claim, { force: true }) } catch { /* the launch error is the one reported */ }
    throw error
  }
  d.log(`crew finish: lane=${spec.id} stop=${finish.stop.reason} findings=${finish.findings.length} pid=${pid}`)
  d.log(`  worktree ${spec.cwd}`)
  d.log(`  log      ${log}`)
  d.log(`  spec     ${specPath}`)
  return { lane: spec.id, worktree: spec.cwd, specPath, pid }
}

function claimStop(d, lane, taskDir, at) {
  // The claim is exclusive and names the stop it finishes, so two calls before the run's first row cannot both spawn.
  const claim = join(taskDir, `finish-${at}.claim`)
  try { d.writeFileSync(claim, `${process.pid}\n`, { flag: 'wx' }) } catch (error) {
    if (error?.code === 'EEXIST') throw new FinishRefusal('finish-running', `lane ${lane} is already being finished from this stop`)
    throw new FinishRefusal('finish-unreadable', `cannot claim lane ${lane}: ${error?.code ?? error?.message}`)
  }
  return claim
}

export function finishLane({ lane, root, deps = {} }) {
  const d = { ...defaultDeps(), ...deps }
  const crewRoot = root ?? d.crewRoot
  const { taskDir, spec, rows } = loadLane(d, lane, crewRoot)
  requireWorktree(d, spec)

  const stopped = rows.findLast((row) => row.event === 'verdict' && row.status === 'stopped')
  if (!stopped) throw new FinishRefusal('finish-premise', `lane ${lane} has not stopped`)
  // A stop the loop writes after a stage closed carries stage null, so the stage it stopped in is the last one started.
  const stopAt = rows.lastIndexOf(stopped)
  const stoppedIn = rows.slice(0, stopAt).findLast((row) => row.event === 'stage-start')?.stage ?? stopped.stage
  if ([stopped.stage, stoppedIn].some((stage) => stage === 'plan' || stage === 'baseline')) throw new FinishRefusal('finish-premise', `lane ${lane} stopped in the ${stoppedIn} stage, before any build`)
  // A row after the stop means a run has re-entered the lane since: a second finish would race it.
  if (rows.slice(stopAt + 1).some((row) => row.event === 'stage-start' || row.event === 'finish-ready')) throw new FinishRefusal('finish-running', `lane ${lane} has run again since it stopped`)

  // A published or committed lane has no uncommitted build left to finish.
  if (rows.some((row) => row.event === 'pr')) throw new FinishRefusal('finish-published', `lane ${lane} already has a recorded PR`)
  if (rows.some((row) => row.event === 'commit')) throw new FinishRefusal('finish-committed', `lane ${lane} already committed its build`)

  if (!rows.some((row) => row.event === 'envelope' && row.role === 'builder' && Array.isArray(row.defects) && row.defects.length === 0 && ['done', 'insufficient'].includes(row.parsed?.status))) throw new FinishRefusal('finish-no-build', `lane ${lane} has no schema-valid done or insufficient builder envelope in its journal`)

  const finish = finishFor(rows, stopped, stopAt, loadPlan(d, lane, taskDir))
  const claim = claimStop(d, lane, taskDir, stopAt)
  return launch(d, { crewRoot, taskDir, spec, finish, claim })
}

const NOTES_HEADING = '## Operator notes'

function readText(d, file, what) {
  try { return d.readFileSync(file, 'utf8') } catch (error) {
    throw new FinishRefusal('finish-unreadable', `cannot read ${what} ${file}: ${error?.code ?? error?.message}`)
  }
}

// The PR text is the measured text, character for character, plus the lane's issues on trailer lines.
function prBody(body, closes, refs) {
  const open = refs.filter((issue) => !closes.includes(issue))
  const trailers = [...closes.map((issue) => `Closes: #${issue}`), ...(open.length ? [`Refs: ${open.map((issue) => `#${issue}`).join(', ')}`] : [])]
  return [body, trailers.join('\n')].filter((block) => block !== '').join('\n\n')
}

// One decision per ready row: the claim is exclusive and taken before any effect, so overlapping decisions cannot both act.
function claimDecision(d, lane, taskDir, at) {
  const claim = join(taskDir, `finish-decision-${at}.claim`)
  try { d.writeFileSync(claim, `${process.pid}\n`, { flag: 'wx' }) } catch (error) {
    if (error?.code === 'EEXIST') throw new FinishRefusal('finish-decided', `lane ${lane} has a decision in progress or already made on this finish run`)
    throw new FinishRefusal('finish-unreadable', `cannot claim a decision on lane ${lane}: ${error?.code ?? error?.message}`)
  }
  return claim
}

// The operator's decision on a lane whose last run ended finish-ready: accept (publish), return (one more pass) or abandon.
// The claim is kept once the decision is recorded and released on any failure, so a failed decision can be retried.
export async function decideFinish({ lane, root, choice, file, deps = {} }) {
  const d = { ...defaultDeps(), ...deps }
  const crewRoot = root ?? d.crewRoot
  if (!['accept', 'return', 'abandon'].includes(choice)) throw new FinishRefusal('finish-unreadable', `${JSON.stringify(choice)} is not a decision`)
  const { taskDir, spec, rows } = loadLane(d, lane, crewRoot)
  const readyAt = rows.findLastIndex((row) => row.event === 'finish-ready')
  // A run that started or stopped after the ready row means the lane's last run did not end finish-ready.
  if (readyAt < 0 || rows.slice(readyAt + 1).some((row) => row.event === 'stage-start' || (row.event === 'verdict' && row.status === 'stopped'))) throw new FinishRefusal('finish-not-ready', `lane ${lane}'s last run did not end finish-ready`)
  if (rows.slice(readyAt + 1).some((row) => row.event === 'finish-decision')) throw new FinishRefusal('finish-decided', `lane ${lane} already has a decision on this finish run`)
  const ready = rows[readyAt]
  if (choice === 'return' && typeof file !== 'string') throw new FinishRefusal('finish-unreadable', '--return needs a guidance file')

  const claim = claimDecision(d, lane, taskDir, readyAt)
  try {
    const notes = typeof file === 'string' ? readText(d, file, choice === 'return' ? 'the guidance file' : 'the notes file') : null
    const journal = join(taskDir, 'journal.jsonl')
    const decision = () => d.appendFileSync(journal, `${JSON.stringify({ event: 'finish-decision', lane, choice, notesSha256: notes === null ? null : createHash('sha256').update(notes).digest('hex') })}\n`)

    if (choice === 'abandon') {
      decision()
      d.log(`crew finish: lane=${lane} abandoned`)
      return { lane, choice }
    }

    requireWorktree(d, spec)
    if (choice === 'accept') {
      if (typeof ready.subject !== 'string' || typeof ready.body !== 'string') throw new FinishRefusal('finish-not-ready', `lane ${lane}'s finish-ready row carries no measured subject and body`)
      const body = notes === null ? ready.body : `${ready.body}\n\n${NOTES_HEADING}\n\n${notes}`
      const closes = spec.closes ?? []
      const refs = spec.refs ?? []
      // The checkout must still be the commit the finish run measured: the body reports that run, not a later commit.
      // openPullRequest has no expected head, so a HEAD that is unreadable or different publishes nothing.
      const head = await d.run({ cwd: spec.cwd, command: 'git', args: ['rev-parse', 'HEAD'], timeoutMs: 60_000 })
      if (head?.status !== 'green' || String(head.stdout ?? '').trim() !== ready.head) throw new FinishRefusal('finish-head-moved', `lane ${lane}'s checkout is not measured at the finish run's head ${ready.head}; nothing was published`)
      const published = await d.openPullRequest({ cwd: spec.cwd, branch: spec.branch, base: spec.base, title: ready.subject, body, closes, refs })
      if (published?.status !== 'green' || !isObject(published.pr)) throw new FinishRefusal('finish-publish', `the pull request did not open: ${published?.reason ?? 'unmeasured'}`)
      // Every returned PR gets the measured text: openPullRequest rewrites issue tokens ("#42" -> "issue 42"), and a PR it
      // found rather than created (reused, or opened by someone else between its lookup and its create) has its own text.
      const edited = await d.run({ cwd: spec.cwd, command: 'gh', args: ['pr', 'edit', String(published.pr.number), '--title', ready.subject, '--body', prBody(body, closes, refs)], timeoutMs: 60_000 })
      if (edited?.status !== 'green') throw new FinishRefusal('finish-publish', `the pull request ${published.pr.number} (${published.pr.url ?? 'no url'}) is open but could not be updated with the measured text, and is not recorded: ${edited?.reason ?? 'unmeasured'}`)
      d.appendFileSync(journal, `${JSON.stringify({ event: 'pr', lane, stage: 'publish', pr: published.pr })}\n`)
      decision()
      d.log(`crew finish: lane=${lane} published ${published.pr.url ?? ''}`)
      return { lane, choice, pr: published.pr }
    }

    // return: the same finish spec the first pass had, plus the guidance, with the review rounds already spent.
    const stopped = rows.slice(0, readyAt).findLast((row) => row.event === 'verdict' && row.status === 'stopped')
    if (!stopped) throw new FinishRefusal('finish-premise', `lane ${lane} has no stop before its finish-ready row`)
    const plan = loadPlan(d, lane, taskDir)
    // Rounds spent: the journal's own count of reviews since the stop (a ready row from before the count was recorded has none),
    // never less than the ready row's own count. Unknown history is never read as zero.
    const sinceStop = rows.slice(rows.lastIndexOf(stopped) + 1, readyAt)
    const journalReviews = Math.max(
      sinceStop.filter((row) => row.event === 'verdict' && row.status === 'reviewed').length,
      sinceStop.filter((row) => row.event === 'envelope' && row.role === 'reviewer').length,
    )
    const priorReviewRounds = Math.max(journalReviews, Number.isSafeInteger(ready.reviewRounds) && ready.reviewRounds >= 0 ? ready.reviewRounds : 0)
    // The declarations the ready run proved (it may have replaced unbound ones) carry forward; the planner's are the fallback.
    const proven = Array.isArray(ready.mutations) && ready.mutations.every(isObject) ? ready.mutations : plan.mutations
    const finish = {
      ...finishFor(rows, stopped, readyAt, { ...plan, mutations: proven }),
      guidance: notes,
      priorReviewRounds,
    }
    // The ready pass's report no longer describes the lane, so it is retired before the new pass can write its own,
    // and put back if the launch fails. The decision is recorded once the run is launched: a failed launch leaves the
    // lane ready, so the pass can be retried.
    const reportPath = join(taskDir, 'finish-report.json')
    const report = d.existsSync(reportPath) ? d.readFileSync(reportPath, 'utf8') : null
    d.rmSync(reportPath, { force: true })
    let started
    try {
      started = launch(d, { crewRoot, taskDir, spec, finish, claim: claimStop(d, lane, taskDir, readyAt) })
    } catch (error) {
      if (report !== null) try { d.writeFileSync(reportPath, report) } catch { /* the launch error is the one reported */ }
      throw error
    }
    decision()
    return { ...started, choice }
  } catch (error) {
    try { d.rmSync(claim, { force: true }) } catch { /* the decision error is the one reported */ }
    throw error
  }
}

const USAGE = 'usage: crew finish <lane> [--accept [--notes <file>] | --return <file> | --abandon]\n'

// [lane] | [lane, --accept [--notes file]] | [lane, --return file] | [lane, --abandon]
function parseArgs(argv) {
  const [lane, flag, ...rest] = argv
  if (typeof lane !== 'string' || lane.startsWith('--')) return null
  if (flag === undefined) return { lane }
  if (flag === '--abandon' && rest.length === 0) return { lane, choice: 'abandon' }
  if (flag === '--return' && rest.length === 1 && !rest[0].startsWith('--')) return { lane, choice: 'return', file: rest[0] }
  if (flag === '--accept' && rest.length === 0) return { lane, choice: 'accept' }
  if (flag === '--accept' && rest.length === 2 && rest[0] === '--notes' && !rest[1].startsWith('--')) return { lane, choice: 'accept', file: rest[1] }
  return null
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const parsed = parseArgs(argv)
  if (!parsed) {
    process.stderr.write(USAGE)
    return 2
  }
  try {
    if (parsed.choice) await decideFinish({ ...parsed, deps })
    else finishLane({ lane: parsed.lane, deps })
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
