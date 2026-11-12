// crew closeout <lane> — close a merged lane, or discard a stopped lane with no PR or a CLOSED PR.
//
// Three steps, in this order, each checked:
//   1. git worktree remove <worktree>   (never --force, so git refuses a worktree with uncommitted changes)
//   2. git branch -D <lane>             (local only)
//   3. move ~/.crew/dt-<lane> to ~/.crew-journal-archive/dt-<lane> (or a free .archive-<n> suffix on re-archive)
// Plain closeout requires a MERGED PR in the worktree's origin repository, with the lane branch's tip as its head.
// Discard permits stopped, abandoned or accepted lanes with a CLOSED PR, and quiet lanes without a journal.
// It refuses tips on neither a remote-tracking ref nor the base. An absent worktree skips git on retry.
// Checks precede removal; a failed archive move leaves the lane directory for a retry.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLeanSource } from './lean-source.mjs'
import { stateless } from './lean-journal-order.mjs'
import { LANE, isObject, parseJournalRows, within } from './lane-core.mjs'
import { reapLaneSeats } from './seat-reap.mjs'
import { parsePrUrl } from './record-pr.mjs'
import { deadRun, parsePidRecord, probeAlive } from './run-pid.mjs'
import { claimStop } from './finish.mjs'

class CloseoutRefusal extends Error {}

const refuse = (message) => { throw new CloseoutRefusal(message) }
const isDir = (path) => { try { return statSync(path).isDirectory() } catch { return false } }
const defaultRun = (cmd, args, options = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024, ...options })

function journalRows(text) {
  return parseJournalRows(text, (kind) => refuse(kind === 'malformed' ? 'task journal has a malformed row' : 'task journal has a non-object row'))
}

function lastPr(rows, lane, taskDir, alive) {
  const pr = rows.findLast((row) => row.event === 'pr')?.pr
  if (!isObject(pr) || typeof pr.url !== 'string') {
    const died = deadRun({ rows, taskDir, alive })
    if (died && !rows.some((row) => row.event === 'pr')) refuse(`run-died: lane ${lane}'s run (pid ${died.pid}) died with no pull request recorded; record it with crew record-pr ${lane} --pr <url>`)
    refuse('task journal records no pull request')
  }
  try { return parsePrUrl(pr.url) } catch { refuse(`task journal records a malformed pull request url: ${pr.url}`) }
}

// owner/repo of a GitHub remote URL (https or ssh), lowercased; null for anything else.
const repoOf = (remote) => /^(?:https:\/\/(?:[^@/\s]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote)?.slice(1, 3).join('/').toLowerCase() ?? null

// Run a command and refuse unless it exits 0.
function must(run, what, cmd, args) {
  const result = run(cmd, args)
  if (!result || result.error || result.status !== 0) refuse(`${what} failed: ${String(result?.stderr || result?.error?.message || '').trim()}`)
  return String(result.stdout ?? '')
}

function closeoutLane({ lane, discard = false, root = join(homedir(), '.crew'), archiveRoot, run = defaultRun, renameSync: rename = renameSync, mkdirSync: mkdir = mkdirSync, alive = probeAlive, kill = process.kill, sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), now = Date.now } = {}) {
  if (typeof lane !== 'string' || !LANE.test(lane)) refuse('lane must be a lean lane slug')
  const archive = archiveRoot ?? join(dirname(root), '.crew-journal-archive')
  const found = createLeanSource({ crewRoot: root, archiveRoot: archive }).resolveLane(lane)
  if (!found) refuse(`no lean lane ${lane}`)
  if (found.archived) refuse(`lane ${lane} is already archived`)
  const journal = join(found.dir, 'task', 'journal.jsonl')
  let text
  if (!within(found.dir, journal)) {
    try { lstatSync(journal); refuse('task journal is missing or resolves outside the lane') } catch (error) {
      if (!discard || error?.code !== 'ENOENT' || !within(found.dir, dirname(journal))) refuse('task journal is missing or resolves outside the lane')
      text = null
    }
  } else {
    try { text = readFileSync(journal, 'utf8') } catch (error) { refuse(`task journal unreadable: ${error?.code ?? error?.message}`) }
  }
  const rows = text === null ? [] : journalRows(text)
  let pr, claim, moved = false
  const taskDir = join(found.dir, 'task')
  let archivedDir = join(archive, `dt-${lane}`)
  for (let n = 2; ; n++) {
    if (!existsSync(archivedDir)) {
      try { lstatSync(archivedDir) } catch (error) {
        if (error?.code === 'ENOENT') break
        refuse(`could not check ${archivedDir}: ${error?.code ?? error?.message}`)
      }
    }
    archivedDir = join(archive, `dt-${lane}.archive-${n}`)
  }
  try {
  if (discard) {
    const lastFinish = rows.findLast((row) => row.event === 'finish-ready' || row.event === 'finish-decision')
    const abandoned = lastFinish?.event === 'finish-decision' && lastFinish.choice === 'abandon'
    const accepted = lastFinish?.event === 'finish-decision' && lastFinish.choice === 'accept'
    if (lastFinish && !abandoned && !accepted) refuse(`lane has a finish record; use crew finish ${lane}`)
    if (accepted && !rows.some((row) => row.event === 'pr')) refuse(`lane has a finish record; use crew finish ${lane}`)
    if (rows.some((row) => row.event === 'pr')) {
      pr = lastPr(rows, lane, taskDir, alive)
      const viewText = must(run, 'gh pr view', 'gh', ['pr', 'view', pr.url, '--json', 'state'])
      let view
      try { view = JSON.parse(viewText) } catch { refuse('gh pr view returned unparseable output') }
      if (view?.state !== 'CLOSED') refuse(`lane recorded a pull request; use crew closeout ${lane}`)
    }
    const tail = rows.findLast((row, index) => !stateless(rows, row, index))
    const stopRows = tail?.event === 'pr' ? rows.slice(0, rows.lastIndexOf(tail)) : rows
    const last = stopRows.findLast((row, index) => !stateless(rows, row, index))
    const died = deadRun({ rows: stopRows, taskDir, alive })
    if (text !== null && !(last?.event === 'verdict' && last.status === 'stopped') && !((abandoned || accepted) && tail === lastFinish) && !died) refuse(`lane ${lane} is not stopped`)
    const stopAt = text === null ? 0 : died ? stopRows.length : rows.lastIndexOf(last)
    try { claim = claimStop({ writeFileSync, readFileSync, rmSync, alive }, lane, taskDir, stopAt) } catch { refuse(`lane ${lane} is not stopped`) }
    if (text === null) {
      try { lstatSync(journal); refuse(`lane ${lane} is not stopped`) } catch (error) { if (error?.code !== 'ENOENT') refuse(`lane ${lane} is not stopped`) }
    } else {
      try { if (readFileSync(journal, 'utf8') !== text) refuse(`lane ${lane} is not stopped`) } catch { refuse(`lane ${lane} is not stopped`) }
    }
    let claims
    try { claims = readdirSync(taskDir).filter((name) => /^finish-\d+\.(claim|reclaim)$/.test(name) && name !== basename(claim)) } catch { refuse(`lane ${lane} is not stopped`) }
    for (const name of ['run.pid', ...claims]) {
      let text
      try { text = readFileSync(join(taskDir, name), 'utf8') } catch (error) {
        if (name === 'run.pid' && error?.code === 'ENOENT') continue
        refuse(`lane ${lane} is not stopped`)
      }
      const record = parsePidRecord(text)
      if (!record || alive(record.pid, record.startedAt) !== false) refuse(`lane ${lane} is not stopped`)
    }
    if (died && !deadRun({ rows: stopRows, taskDir, alive })) refuse(`lane ${lane} is not stopped`)
  } else pr = lastPr(rows, lane, join(found.dir, 'task'), alive)

  const worktree = found.spec.cwd
  if (typeof worktree !== 'string' || !worktree) refuse('lean.json names no existing worktree')
  if (basename(worktree) !== `dt-${lane}`) refuse(`worktree ${worktree} is not dt-${lane}`)
  let absent = false
  try { lstatSync(worktree) } catch (error) {
    if (error?.code === 'ENOENT') absent = true
    else refuse('lean.json names no existing worktree')
  }
  if (!absent && !isDir(worktree)) refuse('lean.json names no existing worktree')
  const laneDir = join(root, `dt-${lane}`)

  let view
  if (!discard) {
    const viewText = must(run, 'gh pr view', 'gh', ['pr', 'view', pr.url, '--json', 'state,headRefOid'])
    try { view = JSON.parse(viewText) } catch { refuse('gh pr view returned unparseable output') }
    if (view?.state !== 'MERGED') refuse(`pull request #${pr.number} is not merged (${String(view?.state)})`)
  }

  let tip
  if (!absent) {
  const mainCheckout = dirname(must(run, 'git rev-parse', 'git', ['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir']).trim())
  if (!discard) {
    const origin = repoOf(must(run, 'git remote get-url', 'git', ['-C', worktree, 'remote', 'get-url', 'origin']).trim())
    const prRepo = repoOf(pr.url.replace(/\/pull\/\d+$/, ''))
    if (!origin || origin !== prRepo) refuse(`pull request ${pr.url} is not in this worktree's origin (${origin ?? 'not a GitHub remote'})`)
  }
  const head = must(run, 'git symbolic-ref', 'git', ['-C', worktree, 'symbolic-ref', '-q', 'HEAD']).trim()
  if (head !== `refs/heads/${lane}`) refuse(`worktree ${worktree} is on ${head || 'a detached HEAD'}, not ${lane}`)
  tip = must(run, 'git rev-parse', 'git', ['-C', mainCheckout, 'rev-parse', '--verify', `refs/heads/${lane}^{commit}`]).trim()
  if (!discard) {
    if (typeof view.headRefOid !== 'string' || tip !== view.headRefOid) refuse(`branch ${lane} is at ${tip}, not the merged head ${String(view.headRefOid)}`)
  } else {
    const base = found.spec.base
    const refs = ['refs/remotes/', ...(typeof base === 'string' ? [`refs/heads/${base}`] : [])]
    if (!must(run, 'git for-each-ref', 'git', ['-C', mainCheckout, 'for-each-ref', '--contains', tip, '--format=%(refname)', ...refs]).trim()) refuse(`branch ${lane} tip ${tip} is on neither a remote-tracking ref nor ${base}; push it or delete the branch by hand`)
  }
  must(run, 'git worktree remove', 'git', ['-C', mainCheckout, 'worktree', 'remove', worktree])
  must(run, 'git branch -D', 'git', ['-C', mainCheckout, 'branch', '-D', lane])
  }
  const reaped = reapLaneSeats({ dir: found.dir, alive, kill, spawnSync: run, sleep, now })
  try {
    mkdir(archive, { recursive: true })
    rename(laneDir, archivedDir)
    moved = true
  } catch (error) { refuse(`could not move ${laneDir} to ${archivedDir}: ${error?.code ?? error?.message}`) }
  return { lane, pr, worktree, archivedDir, absent, tip, ...reaped }
  } finally {
    if (claim) {
      rmSync(claim, { force: true })
      if (moved) rmSync(join(archivedDir, basename(found.dir), 'task', basename(claim)), { force: true })
    }
  }
}

export function main(argv = process.argv.slice(2), deps = {}) {
  const d = { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text), ...deps }
  const [lane, ...extra] = argv
  if (!lane || lane.startsWith('-') || !(extra.length === 0 || (extra.length === 1 && extra[0] === '--discard'))) {
    d.stderr('usage: crew closeout <lane> [--discard]\n')
    return 2
  }
  try {
    const done = closeoutLane({ lane, discard: extra.length === 1, root: d.root, archiveRoot: d.archiveRoot, run: d.run, renameSync: d.renameSync, mkdirSync: d.mkdirSync, alive: d.alive, kill: d.kill, sleep: d.sleep, now: d.now })
    const removal = done.absent ? `worktree ${done.worktree} already absent; branch ${lane} not checked` : `removed ${done.worktree}, deleted branch ${lane} (was ${done.tip})`
    d.stdout(`${extra.length ? 'discarded' : 'closed out'} ${lane}: ${removal}, archived to ${done.archivedDir}\n`)
    for (const record of done.stopped) d.stdout(`stopped seat ${record.role} pgid ${record.pgid}\n`)
    for (const record of done.unproven) d.stdout(`seat ${record.role}${record.pgid == null ? '' : ` pgid ${record.pgid}`}: not proven stopped\n`)
    return 0
  } catch (error) {
    if (!(error instanceof CloseoutRefusal)) throw error
    d.stderr(`crew closeout: ${error.message.replace(/\p{Cc}+/gu, ' ')}\n`)
    return 1
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main()
}
