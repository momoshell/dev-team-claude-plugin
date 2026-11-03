// crew finish <lane> — finish a stopped lean lane with its own builder seat (ADR-051's finish shape, lean loop).
//
// Re-enters the lane in its own worktree and starts the detached `finish` run: rebase onto the current base ->
// builder triage -> proof -> review -> suite -> commit -> rebase. A base conflict stops before any seat, leaving
// the build uncommitted. A mechanical lane is finished on its brief. Only the checked tree is committed; a rebase
// that moves the head repeats proof, review and suite. It never re-plans, re-runs the baseline or publishes; the
// operator's publish decision is a later step:
// `--accept [--notes <file>]` publishes the PR the finish run measured (merging stays the operator's),
// `--return <file>` runs one more finish pass with the file as the builder's guidance (it counts against the three
// review rounds) and
// `--abandon` ends the lane unpublished. Each appends a `finish-decision` row; a lane takes one decision per ready.
// Refused, with nothing written: `finish-worktree` (the worktree is gone), `finish-premise` (the lane never reached
// a build), `finish-running` (a run re-entered or claimed the lane after its stop), `finish-published` and
// `finish-committed` (the build is committed and cannot be proven to be the unpublished HEAD), `finish-no-build`
// (no schema-valid done or insufficient builder envelope in the journal). A claim whose run is provably gone is
// taken over; a provably dead open tail is stopped as `run-died`. A committed, unpushed build at HEAD, as committed or as the journal-recorded one-commit rebase,
// is uncommitted and recorded as `finish-uncommit` before launch; a rebased build is reset onto its rebase base.
// The PR's measured subject, body and notes have issue tokens rewritten as in openPullRequest; issue numbers ride
// only on trailer lines.
// A decision is refused as `finish-not-ready` (the last run did not end finish-ready), `finish-decided` (it already
// has one), `finish-head-moved` (accept: the checkout is no longer the head the run measured) or `finish-publish`
// (the PR did not open; nothing is recorded, so it can be retried), or `finish-rounds-spent` (return has no review
// rounds left).
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FINISH_REVIEW_ROUNDS, composeLanePrBody, openPullRequest, runSuite, withoutIssueTokens } from './checks.mjs'
import { TIERS, validateEnvelope } from './protocols.mjs'
import { deadRun, probeAlive, writeRunPid } from './run-pid.mjs'

const HOME = dirname(dirname(fileURLToPath(import.meta.url)))
const LEAN = join(HOME, 'crew', 'lean.mjs')
const LANE = /^[a-z0-9][a-z0-9-]{0,62}$/

export const FINISH_REASONS = Object.freeze([
  'finish-unreadable', 'finish-worktree', 'finish-premise', 'finish-running', 'finish-published', 'finish-committed',
  'finish-no-build', 'finish-not-ready', 'finish-decided', 'finish-head-moved', 'finish-publish', 'finish-rounds-spent',
])

export class FinishRefusal extends Error {
  constructor(reason, message) {
    super(message)
    if (!FINISH_REASONS.includes(reason)) throw new TypeError(`unknown finish refusal: ${reason}`)
    this.reason = reason
  }
}

const defaultDeps = () => ({
  readFileSync, readdirSync, existsSync, statSync, mkdirSync, writeFileSync, appendFileSync, rmSync, openPullRequest, run: runSuite,
  alive: probeAlive,
  git: (cwd, args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })
    return { status: r.status === 0 && !r.error ? 'green' : 'red', stdout: r.stdout ?? '' }
  },
  spawnDetached: (file, args, { cwd, log, env }) => {
    const out = openSync(log, 'a')
    try {
      const child = spawn(file, args, { cwd, env, detached: true, stdio: ['ignore', out, out] })
      child.on('error', () => {})
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
  const recordedTier = spec.tier
  // ADR-055 §7: a recorded raise survives a finish run.
  for (const row of rows) if (row.event === 'tier-raised' && TIERS.includes(row.to) && TIERS.indexOf(row.to) > TIERS.indexOf(spec.tier)) spec.tier = row.to
  return { taskDir, spec, rows, recordedTier }
}

function requireWorktree(d, spec) {
  let isDir = false
  try { isDir = typeof spec?.cwd === 'string' && d.statSync(spec.cwd).isDirectory() } catch { isDir = false }
  if (!isDir) throw new FinishRefusal('finish-worktree', `the lane worktree ${spec?.cwd} does not exist`)
}

// The lane's accepted plan and subject, including archived planner returns. Newest first, a planner file that is a
// valid done return is resumed when the journal records it as accepted, or when the journal records no planner
// envelope at all (an older journal). One the journal records as refused is skipped. One the journal does not mention
// while it records others is ambiguous (journal writes are not load-bearing, so a missing row proves nothing) and is
// refused rather than passed over for an older plan.
function loadPlan(d, lane, taskDir, rows = []) {
  const numberOf = (row) => Number(/\.planner\.(\d+)$/.exec(String(row.id ?? row.parsed?.id ?? ''))?.[1])
  const recorded = rows.filter((row) => row.event === 'envelope' && row.role === 'planner')
  const accepted = new Set(recorded.filter((row) => Array.isArray(row.defects) && row.defects.length === 0 && !row.error && row.parsed?.status === 'done').map(numberOf))
  const mentioned = new Set(recorded.map(numberOf))
  const files = d.readdirSync(taskDir).map((name) => ({ name, n: Number(/^planner-(\d+)\.json$/.exec(name)?.[1]) }))
    .filter(({ n }) => Number.isInteger(n) && n > 0).sort((a, b) => b.n - a.n)
  if (!files.length) throw new FinishRefusal('finish-premise', `lane ${lane} has no planner return`)
  for (const { name, n } of files) {
    // A file the journal records as refused is never read: it may not even be JSON.
    if (recorded.length && mentioned.has(n) && !accepted.has(n)) continue
    const checked = validateEnvelope('planner', readJson(d, join(taskDir, name), 'the planner return'), { archived: true })
    if (checked.defects.length || checked.envelope?.status !== 'done') continue
    if (recorded.length === 0 || accepted.has(n)) return checked.envelope.details
    if (!mentioned.has(n)) throw new FinishRefusal('finish-premise', `the planner return ${name} has no journal row, so whether it was accepted is unknown`)
  }
  throw new FinishRefusal('finish-premise', `lane ${lane} has no accepted planner return`)
}

function planFor(d, lane, taskDir, recordedTier, rows) {
  if (recordedTier === 'mechanical' && !d.readdirSync(taskDir).some((name) => /^planner-\d+\.json$/.test(name))
    && !rows.some((row) => row.event === 'envelope' && row.role === 'planner')) {
    const builder = rows.findLast((row) => row.event === 'envelope' && row.role === 'builder'
      && Array.isArray(row.defects) && row.defects.length === 0 && !row.error && row.parsed?.status === 'done' && row.parsed.id === row.id
      && typeof row.parsed.details?.subject === 'string' && row.parsed.details.subject !== '')
    if (!builder) throw new FinishRefusal('finish-premise', `lane ${lane} has no builder subject`)
    return { subject: builder.parsed.details.subject, plan_path: null, files_in_scope: null }
  }
  return loadPlan(d, lane, taskDir, rows)
}

// The finish spec for a stop: the stop, the findings still open at that point of the journal, and the turn offset.
function finishFor(rows, stopped, before, plan) {
  const { subject, plan_path: planPath } = plan
  const reviewed = rows.slice(0, before).findLast((row) => row.event === 'verdict' && row.status === 'reviewed')
  return {
    planPath, subject, filesInScope: plan.files_in_scope ?? null,
    stop: { reason: stopped.reason, observation: stopped.observation ?? null },
    findings: reviewed?.verdict === 'changes-needed' && Array.isArray(reviewed.findings) ? reviewed.findings : [],
    turnOffset: rows.filter((row) => row.event === 'envelope').length,
  }
}

// Writes finish.json and spawns the detached run; a launch that fails releases the claim, so the lane can be retried.
function launch(d, { crewRoot, taskDir, spec, finish, claim, recoveryPid }) {
  const specPath = join(taskDir, 'finish.json')
  const started = join(crewRoot, 'briefs', 'started')
  const log = join(started, `${spec.id}.run.log`)
  let pid
  try {
    d.mkdirSync(started, { recursive: true })
    d.writeFileSync(specPath, `${JSON.stringify({ ...spec, shape: 'finish', finish }, null, 2)}\n`)
    // Clear the old proof before spawning: a crash before the new pid is written leaves
    // the lane unproven and requires manual recovery, rather than risking a live run.
    d.rmSync(join(taskDir, 'run.pid'), { force: true })
    try {
      pid = d.spawnDetached(process.execPath, [LEAN, specPath], { cwd: spec.cwd, log })
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('no valid pid')
    } catch (error) {
      if (recoveryPid) writeRunPid(taskDir, recoveryPid, d)
      throw error
    }
  } catch (error) {
    try { d.rmSync(claim, { force: true }) } catch { /* the launch error is the one reported */ }
    throw error
  }
  writeRunPid(taskDir, pid, d)
  try { d.writeFileSync(claim, `${pid}\n`) } catch { /* the detached run may already be active */ }
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
    if (error?.code !== 'EEXIST') throw new FinishRefusal('finish-unreadable', `cannot claim lane ${lane}: ${error?.code ?? error?.message}`)
    const running = () => new FinishRefusal('finish-running', `lane ${lane} may still be running; claim ${claim}`)
    let text, pid
    try {
      text = d.readFileSync(claim, 'utf8')
      pid = Number(text.trim())
      if (!/^\d+\n?$/.test(text) || !Number.isSafeInteger(pid) || pid <= 0 || d.alive(pid) !== false) throw running()
    } catch { throw running() }
    const lock = join(taskDir, `finish-${at}.reclaim`)
    try { d.writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' }) } catch { throw running() }
    try {
      if (d.readFileSync(claim, 'utf8') !== text || d.alive(pid) !== false) throw running()
      d.rmSync(claim)
      d.writeFileSync(claim, `${process.pid}\n`, { flag: 'wx' })
    } catch { throw running() } finally { d.rmSync(lock, { force: true }) }
  }
  return claim
}

const onLaneBranch = (d, spec) => {
  const branch = d.git(spec.cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  return branch?.status === 'green' && typeof spec.branch === 'string' && String(branch.stdout ?? '').trim() === spec.branch
}

export function finishLane({ lane, root, deps = {} }) {
  const d = { ...defaultDeps(), ...deps }
  const crewRoot = root ?? d.crewRoot
  const { taskDir, spec, rows, recordedTier } = loadLane(d, lane, crewRoot)
  requireWorktree(d, spec)

  const died = deadRun({ rows, taskDir, readFileSync: d.readFileSync, alive: d.alive })
  const stopped = died ? { event: 'verdict', status: 'stopped', stage: null, reason: 'run-died', observation: died } : rows.findLast((row) => row.event === 'verdict' && row.status === 'stopped')
  if (!stopped) throw new FinishRefusal('finish-premise', `lane ${lane} has not stopped`)
  // A stop the loop writes after a stage closed carries stage null, so the stage it stopped in is the last one started.
  const stopAt = died ? rows.length : rows.lastIndexOf(stopped)
  const stoppedIn = rows.slice(0, stopAt).findLast((row) => row.event === 'stage-start')?.stage ?? stopped.stage
  if ([stopped.stage, stoppedIn].some((stage) => stage === 'plan' || stage === 'baseline')) throw new FinishRefusal('finish-premise', `lane ${lane} stopped in the ${stoppedIn} stage, before any build`)
  // A row after the stop means a run has re-entered the lane since: a second finish would race it.
  if (rows.slice(stopAt + 1).some((row) => row.event === 'stage-start' || row.event === 'finish-ready')) throw new FinishRefusal('finish-running', `lane ${lane} has run again since it stopped`)

  if (rows.some((row) => row.event === 'pr')) throw new FinishRefusal('finish-published', `lane ${lane} already has a recorded PR`)
  const lastCommit = rows.findLastIndex((row) => row.event === 'commit')
  const standing = lastCommit >= 0 && !rows.slice(lastCommit + 1).some((row) => row.event === 'finish-uncommit' || (row.event === 'stage-end' && row.stage === 'uncommit' && row.outcome?.status === 'green'))
  const head = rows[lastCommit]?.head
  let undo
  if (standing) {
    const local = d.git(spec.cwd, ['rev-parse', 'HEAD'])
    const now = String(local?.stdout ?? '').trim()
    const rebased = rows.slice(lastCommit + 1, stopAt).findLast((row) => row.event === 'stage-end' && row.stage === 'rebase' && row.outcome?.status === 'green')?.outcome
    if (local?.status === 'green' && typeof head === 'string' && head && now === head) {
      undo = { head, onto: `${head}^` }
    } else if (local?.status === 'green' && typeof head === 'string' && head && typeof rebased?.head === 'string' && rebased.head && typeof rebased.onto === 'string' && rebased.onto && now === rebased.head) {
      const parent = d.git(spec.cwd, ['rev-parse', `${now}^`])
      if (parent?.status !== 'green' || String(parent.stdout ?? '').trim() !== rebased.onto) throw new FinishRefusal('finish-committed', `lane ${lane}'s rebased build is not one commit on its rebase base`)
      undo = { head: now, onto: rebased.onto, committed: head }
    }
    if (!undo) throw new FinishRefusal('finish-committed', `lane ${lane}'s committed build is not the checkout HEAD`)
    if (!onLaneBranch(d, spec)) throw new FinishRefusal('finish-committed', `lane ${lane}'s checkout is not on its branch ${spec.branch}`)
    const remote = d.git(spec.cwd, ['ls-remote', '--heads', 'origin', `refs/heads/${spec.branch}`])
    if (remote?.status !== 'green' || String(remote.stdout ?? '').trim() !== '') throw new FinishRefusal('finish-committed', `lane ${lane}'s remote branch exists or could not be checked`)
  }

  if (!rows.some((row) => row.event === 'envelope' && row.role === 'builder' && Array.isArray(row.defects) && row.defects.length === 0 && ['done', 'insufficient'].includes(row.parsed?.status) && row.parsed.id === row.id)) throw new FinishRefusal('finish-no-build', `lane ${lane} has no schema-valid done or insufficient builder envelope in its journal`)

  const finish = finishFor(rows, stopped, stopAt, planFor(d, lane, taskDir, recordedTier, rows))
  if (died) finish.recoveredStopAt = stopAt
  const claim = claimStop(d, lane, taskDir, stopAt)
  try {
    // A previous claimant may have finished while this call was probing the remote.
    const current = loadLane(d, lane, crewRoot)
    if (JSON.stringify(current.rows) !== JSON.stringify(rows) || JSON.stringify(current.spec) !== JSON.stringify(spec) || current.recordedTier !== recordedTier) throw new FinishRefusal('finish-running', `lane ${lane} changed while claiming its stop`)
    requireWorktree(d, spec)
    if (standing) {
      const local = d.git(spec.cwd, ['rev-parse', 'HEAD'])
      if (local?.status !== 'green' || String(local.stdout ?? '').trim() !== undo.head) throw new FinishRefusal('finish-committed', `lane ${lane}'s committed build is not the checkout HEAD`)
      // The reset moves whichever branch is checked out: another branch at the same commit must never be reset.
      if (!onLaneBranch(d, spec)) throw new FinishRefusal('finish-committed', `lane ${lane}'s checkout is not on its branch ${spec.branch}`)
      if (d.git(spec.cwd, ['reset', '--soft', undo.onto])?.status !== 'green') throw new FinishRefusal('finish-committed', `lane ${lane}'s committed build could not be reset`)
      try { d.appendFileSync(join(taskDir, 'journal.jsonl'), `${JSON.stringify({ event: 'finish-uncommit', lane, ...undo })}\n`) } catch (error) {
        throw new FinishRefusal('finish-unreadable', `cannot record finish-uncommit for lane ${lane}: ${error?.code ?? error?.message}`)
      }
    }
  } catch (error) {
    try { d.rmSync(claim, { force: true }) } catch { /* the validation, reset or journal error is the one reported */ }
    throw error
  }
  return launch(d, { crewRoot, taskDir, spec, finish, claim, recoveryPid: died?.pid })
}

const NOTES_HEADING = '## Operator notes'

function readText(d, file, what) {
  try { return d.readFileSync(file, 'utf8') } catch (error) {
    throw new FinishRefusal('finish-unreadable', `cannot read ${what} ${file}: ${error?.code ?? error?.message}`)
  }
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
  const { taskDir, spec, rows, recordedTier } = loadLane(d, lane, crewRoot)
  const readyAt = rows.findLastIndex((row) => row.event === 'finish-ready')
  // A run that started or stopped after the ready row means the lane's last run did not end finish-ready.
  if (readyAt < 0 || rows.slice(readyAt + 1).some((row) => row.event === 'stage-start' || (row.event === 'verdict' && row.status === 'stopped'))) throw new FinishRefusal('finish-not-ready', `lane ${lane}'s last run did not end finish-ready`)
  if (rows.slice(readyAt + 1).some((row) => row.event === 'finish-decision')) throw new FinishRefusal('finish-decided', `lane ${lane} already has a decision on this finish run`)
  const ready = rows[readyAt]
  if (choice === 'return' && typeof file !== 'string') throw new FinishRefusal('finish-unreadable', '--return needs a guidance file')
  let stopped, priorReviewRounds, recoveredStopAt
  if (choice === 'return') {
    stopped = rows.slice(0, readyAt).findLast((row) => row.event === 'verdict' && row.status === 'stopped')
    let previous
    try { previous = JSON.parse(d.readFileSync(join(taskDir, 'finish.json'), 'utf8')).finish } catch { /* older finishes may have no spec */ }
    if (previous?.stop?.reason === 'run-died' && Number.isSafeInteger(previous.recoveredStopAt)
      && previous.recoveredStopAt >= 0 && previous.recoveredStopAt <= readyAt) {
      recoveredStopAt = previous.recoveredStopAt
      stopped = { reason: 'run-died', observation: previous.stop.observation }
    }
    if (!stopped) throw new FinishRefusal('finish-premise', `lane ${lane} has no stop before its finish-ready row`)
    // Count from the earlier historical stop when present, never discarding reviews on recovery.
    const historicalStop = rows.slice(0, readyAt).findLastIndex((row) => row.event === 'verdict' && row.status === 'stopped')
    const sinceStop = rows.slice(Math.min(historicalStop >= 0 ? historicalStop + 1 : readyAt, recoveredStopAt ?? readyAt), readyAt)
    const journalReviews = Math.max(
      sinceStop.filter((row) => row.event === 'verdict' && row.status === 'reviewed').length,
      sinceStop.filter((row) => row.event === 'envelope' && row.role === 'reviewer').length,
    )
    priorReviewRounds = Math.max(journalReviews, Number.isSafeInteger(ready.reviewRounds) && ready.reviewRounds >= 0 ? ready.reviewRounds : 0)
    if (priorReviewRounds >= FINISH_REVIEW_ROUNDS) throw new FinishRefusal('finish-rounds-spent', `lane ${lane} has spent its finish review rounds`)
  }

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
      // The checkout must still be the commit the finish run measured: the body reports that run, not a later commit.
      // openPullRequest has no expected head, so a HEAD that is unreadable or different publishes nothing.
      const head = await d.run({ cwd: spec.cwd, command: 'git', args: ['rev-parse', 'HEAD'], timeoutMs: 60_000 })
      if (head?.status !== 'green' || String(head.stdout ?? '').trim() !== ready.head) throw new FinishRefusal('finish-head-moved', `lane ${lane}'s checkout is not measured at the finish run's head ${ready.head}; nothing was published`)
      const published = await d.openPullRequest({ cwd: spec.cwd, branch: spec.branch, base: spec.base, title: ready.subject, body, closes })
      if (published?.status !== 'green' || !isObject(published.pr)) throw new FinishRefusal('finish-publish', `the pull request did not open: ${published?.reason ?? 'unmeasured'}`)
      // A reused PR has its own text; apply the same issue-token rewriting as openPullRequest.
      const edited = await d.run({ cwd: spec.cwd, command: 'gh', args: ['pr', 'edit', String(published.pr.number), '--title', withoutIssueTokens(ready.subject), '--body', composeLanePrBody({ body, closes, refs: [] })], timeoutMs: 60_000 })
      if (edited?.status !== 'green') throw new FinishRefusal('finish-publish', `the pull request ${published.pr.number} (${published.pr.url ?? 'no url'}) is open but could not be updated with the measured text, and is not recorded: ${edited?.reason ?? 'unmeasured'}`)
      d.appendFileSync(journal, `${JSON.stringify({ event: 'pr', lane, stage: 'publish', pr: published.pr })}\n`)
      decision()
      d.log(`crew finish: lane=${lane} published ${published.pr.url ?? ''}`)
      return { lane, choice, pr: published.pr }
    }

    // return: the same finish spec the first pass had, plus the guidance, with the review rounds already spent.
    const plan = planFor(d, lane, taskDir, recordedTier, rows)
    const finish = {
      ...finishFor(rows, stopped, readyAt, plan),
      ...(recoveredStopAt === undefined ? {} : { recoveredStopAt }),
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
