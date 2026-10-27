// crew closeout <lane> — close a merged lean lane: remove its worktree, delete its branch, archive its lane directory.
//
// Three steps, in this order, each checked:
//   1. git worktree remove <worktree>   (never --force, so git refuses a worktree with uncommitted changes)
//   2. git branch -D <lane>             (local only)
//   3. move ~/.crew/dt-<lane> to ~/.crew-journal-archive/dt-<lane>  (moved, never deleted)
// The lane's recorded PR must be MERGED on GitHub, in the worktree's origin repository, with the lane branch's tip
// as its head; the worktree must be dt-<lane> on that branch. All of it is checked before step 1, so a refusal
// changes nothing on disk or in git.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLeanSource } from '../visualizer/server/lean-source.mjs'
import { parsePrUrl } from './record-pr.mjs'

export class CloseoutRefusal extends Error {}

const LANE = /^[a-z0-9][a-z0-9-]{0,62}$/
const refuse = (message) => { throw new CloseoutRefusal(message) }
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isDir = (path) => { try { return statSync(path).isDirectory() } catch { return false } }
const defaultRun = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' })

function within(root, path) {
  try {
    const base = realpathSync(root), real = realpathSync(path)
    return real === base || real.startsWith(`${base}${sep}`)
  } catch { return false }
}

function lastPr(text) {
  let pr = null
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { refuse('task journal has a malformed row') }
    if (!isObject(row)) refuse('task journal has a non-object row')
    if (row.event === 'pr') pr = row.pr
  }
  if (!isObject(pr) || typeof pr.url !== 'string') refuse('task journal records no pull request')
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

export function closeoutLane({ lane, root = join(homedir(), '.crew'), archiveRoot, run = defaultRun, renameSync: rename = renameSync, mkdirSync: mkdir = mkdirSync } = {}) {
  if (typeof lane !== 'string' || !LANE.test(lane)) refuse('lane must be a lean lane slug')
  const archive = archiveRoot ?? join(dirname(root), '.crew-journal-archive')
  const found = createLeanSource({ crewRoot: root, archiveRoot: archive }).resolveLane(lane)
  if (!found) refuse(`no lean lane ${lane}`)
  if (found.archived) refuse(`lane ${lane} is already archived`)
  const journal = join(found.dir, 'task', 'journal.jsonl')
  if (!within(found.dir, journal)) refuse('task journal is missing or resolves outside the lane')
  let text
  try { text = readFileSync(journal, 'utf8') } catch (error) { refuse(`task journal unreadable: ${error?.code ?? error?.message}`) }
  const pr = lastPr(text)

  const worktree = found.spec.cwd
  if (typeof worktree !== 'string' || !worktree || !isDir(worktree)) refuse('lean.json names no existing worktree')
  if (basename(worktree) !== `dt-${lane}`) refuse(`worktree ${worktree} is not dt-${lane}`)
  const laneDir = join(root, `dt-${lane}`)
  const archivedDir = join(archive, `dt-${lane}`)
  if (existsSync(archivedDir)) refuse(`${archivedDir} already exists`)

  const viewText = must(run, 'gh pr view', 'gh', ['pr', 'view', pr.url, '--json', 'state,headRefOid'])
  let view
  try { view = JSON.parse(viewText) } catch { refuse('gh pr view returned unparseable output') }
  if (view?.state !== 'MERGED') refuse(`pull request #${pr.number} is not merged (${String(view?.state)})`)

  const mainCheckout = dirname(must(run, 'git rev-parse', 'git', ['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir']).trim())
  const origin = repoOf(must(run, 'git remote get-url', 'git', ['-C', worktree, 'remote', 'get-url', 'origin']).trim())
  const prRepo = repoOf(pr.url.replace(/\/pull\/\d+$/, ''))
  if (!origin || origin !== prRepo) refuse(`pull request ${pr.url} is not in this worktree's origin (${origin ?? 'not a GitHub remote'})`)
  const head = must(run, 'git symbolic-ref', 'git', ['-C', worktree, 'symbolic-ref', '-q', 'HEAD']).trim()
  if (head !== `refs/heads/${lane}`) refuse(`worktree ${worktree} is on ${head || 'a detached HEAD'}, not ${lane}`)
  const tip = must(run, 'git rev-parse', 'git', ['-C', mainCheckout, 'rev-parse', '--verify', `refs/heads/${lane}^{commit}`]).trim()
  if (typeof view.headRefOid !== 'string' || tip !== view.headRefOid) refuse(`branch ${lane} is at ${tip}, not the merged head ${String(view.headRefOid)}`)
  must(run, 'git worktree remove', 'git', ['-C', mainCheckout, 'worktree', 'remove', worktree])
  must(run, 'git branch -D', 'git', ['-C', mainCheckout, 'branch', '-D', lane])
  try {
    mkdir(archive, { recursive: true })
    rename(laneDir, archivedDir)
  } catch (error) { refuse(`could not move ${laneDir} to ${archivedDir}: ${error?.code ?? error?.message}`) }
  return { lane, pr, worktree, archivedDir }
}

export function main(argv = process.argv.slice(2), deps = {}) {
  const d = { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text), ...deps }
  const [lane, ...extra] = argv
  if (lane === undefined || lane.startsWith('-') || extra.length > 0) {
    d.stderr('usage: crew closeout <lane>\n')
    return 2
  }
  try {
    const done = closeoutLane({ lane, root: d.root, archiveRoot: d.archiveRoot, run: d.run, renameSync: d.renameSync, mkdirSync: d.mkdirSync })
    d.stdout(`closed out ${lane}: removed ${done.worktree}, deleted branch ${lane}, archived to ${done.archivedDir}\n`)
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
