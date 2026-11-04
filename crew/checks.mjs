import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { GIT_STATUS_ARGS, HEX_OID, describeError } from './lane-core.mjs'

export const FINISH_REVIEW_ROUNDS = 3

export const CHECK_REASONS = Object.freeze([
  'invalid-input', 'unsupported-platform', 'exit-nonzero', 'signal', 'spawn-error', 'timeout', 'output-limit',
  'cleanup-unproven', 'proof-unproven', 'runner-threw', 'nothing-to-commit', 'commit-failed', 'rebase-conflict', 'rebase-failed',
  'dirty-worktree', 'push-unmeasured', 'pr-unmeasured', 'invalid-remote-data',
])

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 2 ** 31 - 1
const OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024
const TERM_GRACE_MS = 150
const REAP_SETTLE_MS = 1000
const POLL_MS = 25
const INHERITED_ENV = ['FORCE_COLOR', 'CLICOLOR_FORCE', 'NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID']

const sleep = (ms) => new Promise((wake) => setTimeout(wake, ms))
const unmeasured = (reason, extra = {}) => ({ status: 'unmeasured', reason, code: null, signal: null, stdout: '', stderr: '', timedOut: false, pgid: null, ...extra })
const validTimeout = (ms) => Number.isSafeInteger(ms) && ms > 0 && ms <= MAX_TIMEOUT_MS

function cleanEnv() {
  const env = { ...process.env, NO_COLOR: '1' }
  for (const key of INHERITED_ENV) delete env[key]
  return env
}

// shortcut: POSIX process groups only; add verified lineage tracking if escaped groups become required
function signalGroup(child, signal) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1) return false
  try { process.kill(-child.pid, signal); return true } catch { return false }
}

// Only ESRCH proves the group dead: EPERM means a live group we may not signal, anything else is unknown.
function groupState(probe, pgid) {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return 'unknown'
  try { probe(-pgid, 0); return 'live' } catch (error) {
    if (error?.code === 'ESRCH') return 'dead'
    return error?.code === 'EPERM' ? 'live' : 'unknown'
  }
}

// TERM, a short grace, KILL, then a bounded wait for the group to be gone AND the pipes closed.
async function reapGroup(child, probe, isClosed) {
  const reaped = () => groupState(probe, child.pid) === 'dead' && isClosed()
  const until = async (ms) => {
    for (let waited = 0; waited < ms; waited += POLL_MS) {
      if (reaped()) return true
      await sleep(POLL_MS)
    }
    return reaped()
  }
  signalGroup(child, 'SIGTERM')
  if (await until(TERM_GRACE_MS)) return true
  signalGroup(child, 'SIGKILL')
  return until(REAP_SETTLE_MS)
}

export function runSuite({ cwd, command, args = [], timeoutMs = DEFAULT_TIMEOUT_MS } = {}, deps = {}) {
  if (process.platform === 'win32') return Promise.resolve(unmeasured('unsupported-platform'))
  const valid = typeof cwd === 'string' && cwd !== '' && typeof command === 'string' && command !== ''
    && Array.isArray(args) && args.every((arg) => typeof arg === 'string')
    && validTimeout(timeoutMs)
  if (!valid) return Promise.resolve(unmeasured('invalid-input'))
  const probe = deps.probeKill ?? ((pid, signal) => process.kill(pid, signal))
  return new Promise((resolveRun) => {
    let child
    try {
      child = spawn(command, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv() })
    } catch (error) {
      resolveRun(unmeasured('spawn-error', { error: describeError(error) }))
      return
    }
    const pgid = Number.isSafeInteger(child.pid) ? child.pid : null
    let stdout = ''
    let stderr = ''
    let size = 0
    let timedOut = false
    let overflow = false
    let stopping = false
    let closed = false
    let done = false
    let spawnError = null
    let exit = { code: null, signal: null }

    const classify = (cleanup) => {
      const base = { code: exit.code, signal: exit.signal, stdout, stderr, timedOut, pgid, cleanup }
      if (spawnError) return { status: 'unmeasured', reason: 'spawn-error', ...base, error: describeError(spawnError) }
      if (cleanup === 'unproven') return { status: 'unmeasured', reason: 'cleanup-unproven', ...base }
      if (timedOut) return { status: 'unmeasured', reason: 'timeout', ...base }
      if (overflow) return { status: 'unmeasured', reason: 'output-limit', ...base }
      if (exit.code === null) return { status: 'unmeasured', reason: 'signal', ...base }
      if (exit.code === 0) return { status: 'green', reason: null, ...base }
      return { status: 'red', reason: 'exit-nonzero', ...base }
    }
    const settle = (cleanup) => {
      if (done) return
      done = true
      clearTimeout(deadline)
      const emitters = [child, child.stdout, child.stderr].filter(Boolean)
      for (const emitter of emitters) { emitter.removeAllListeners(); emitter.on('error', () => {}) }
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolveRun(classify(cleanup))
    }
    // `force` is false only for an ordinary close, where a group already proven dead needs no signalling.
    const stop = async (force) => {
      if (stopping) return
      stopping = true
      clearTimeout(deadline)
      if (!force && groupState(probe, pgid) === 'dead') return settle('proven')
      settle(await reapGroup(child, probe, () => closed) ? 'proven' : 'unproven')
    }
    const append = (chunk, target) => {
      if (overflow) return
      size += Buffer.byteLength(chunk)
      if (size > OUTPUT_LIMIT_BYTES) { overflow = true; void stop(true); return }
      if (target === 'stdout') stdout += chunk
      else stderr += chunk
    }

    // The deadline outlives `exit`: a leader that exits while descendants hold the pipes is still bounded.
    const deadline = setTimeout(() => { timedOut = true; void stop(true) }, timeoutMs)
    child.on('error', (error) => {
      spawnError = error
      if (pgid === null) settle('proven')
      else void stop(true)
    })
    child.on('exit', (code, signal) => { exit = { code, signal } })
    child.on('close', (code, signal) => { closed = true; exit = { code, signal }; void stop(false) })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => append(chunk, 'stdout'))
    child.stderr.on('data', (chunk) => append(chunk, 'stderr'))
  })
}

// A literal repo-relative path: no absolute, backslash, NUL, empty, dot, dotdot or .git segment.
export function literalRelative(file) {
  if (file === '' || file.startsWith('/') || /[\\\0]/.test(file)) return false
  return file.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
}

export const validGenerated = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Array.isArray(v.paths) && v.paths.length > 0 && v.paths.every((path) => typeof path === 'string' && literalRelative(path.endsWith('/') ? path.slice(0, -1) : path) && !/[*?\[\]]/.test(path))
  && typeof v.command === 'string' && v.command.trim() !== '' && !v.command.includes('\0')
  && Array.isArray(v.args) && v.args.every((arg) => typeof arg === 'string' && !arg.includes('\0'))
  && (v.timeoutMs === undefined || validTimeout(v.timeoutMs))

const ISSUE_TOKEN = /#(\d+)/g
// A ref-like name that is never an option, never blank, never a control character.
const SAFE_NAME = /^[^-\x00-\x20\x7f][^\x00-\x20\x7f]*$/
const GIT_PATHS = ['index', 'index.lock', 'HEAD.lock', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false']

const red = (reason, extra = {}) => ({ status: 'red', reason, ...extra })
const guarded = async (work) => {
  try { return await work() } catch (error) { return unmeasured('runner-threw', { error: describeError(error) }) }
}
const wellFormed = (r) => {
  if (!r || typeof r !== 'object' || typeof r.stdout !== 'string' || typeof r.stderr !== 'string') return false
  if (r.status === 'green') return r.code === 0 && r.reason === null && !r.signal && r.timedOut !== true
  if (r.status === 'red') return Number.isInteger(r.code) && r.code !== 0 && typeof r.reason === 'string'
  return r.status === 'unmeasured' && CHECK_REASONS.includes(r.reason)
}

// Every git and gh call goes through here, so a test or caller can replace the one process boundary.
async function runCommand(spec, deps) {
  let result
  try { result = await (typeof deps.run === 'function' ? deps.run : runSuite)(spec) } catch (error) {
    return unmeasured('runner-threw', { error: describeError(error) })
  }
  return wellFormed(result) ? result : unmeasured('runner-threw', { error: { code: null, message: 'the runner returned a malformed result' } })
}

// A command that did not come back green becomes the caller's closed reason: red stays measured, anything else stays unmeasured.
function notGreen(result, reason) {
  const detail = result.stderr.trim() || null
  return result.status === 'red' ? red(reason, { detail }) : unmeasured(result.reason, { detail })
}

// Positive integer issue ids, deduplicated; null when any entry is not one.
function issueList(list) {
  if (!Array.isArray(list) || !list.every((issue) => Number.isSafeInteger(issue) && issue > 0)) return null
  return [...new Set(list)]
}

function issueLines(closes, refs) {
  const closingLines = closes.map((issue) => `Closes: #${issue}`)
  const open = refs.filter((issue) => !closes.includes(issue))
  return open.length === 0 ? closingLines : [...closingLines, `Refs: ${open.map((issue) => `#${issue}`).join(', ')}`]
}

export const withoutIssueTokens = (text) => text.replace(ISSUE_TOKEN, 'issue $1')
const joinBlocks = (blocks) => blocks.filter((block) => block !== '').join('\n\n')

// Issue numbers appear only on the dedicated trailer lines, so prose can never close or reference an issue.
function composeLaneMessage({ subject, body, closes, refs }) {
  return joinBlocks([withoutIssueTokens(subject), withoutIssueTokens(body), issueLines(closes, refs).join('\n')])
}

export function composeLanePrBody({ body, closes, refs }) {
  const prose = withoutIssueTokens(body)
  return joinBlocks([prose, issueLines(closes, refs).join('\n')])
}

const singleLine = (text) => typeof text === 'string' && text.trim() !== '' && !/[\r\n\0]/.test(text)

// A name git itself accepts as a branch, so a validated name can never be read as an option.
async function refProblem(git, name) {
  if (typeof name !== 'string' || !SAFE_NAME.test(name)) return unmeasured('invalid-input')
  const checked = await git(['check-ref-format', `refs/heads/${name}`])
  return checked.status === 'green' ? null : unmeasured(checked.status === 'red' ? 'invalid-input' : checked.reason)
}

export function parseStatus(stdout) {
  const parts = stdout.split('\0')
  if (parts.at(-1) === '') parts.pop()
  const entries = []
  for (let at = 0; at < parts.length; at++) {
    const record = parts[at]
    if (record.length < 4 || record[2] !== ' ') return null
    const [x, y] = record
    let from = null
    if ('RC'.includes(x) || 'RC'.includes(y)) {
      from = parts[++at]
      if (from === undefined || from === '') return null
    }
    entries.push({ x, y, path: record.slice(3), from })
  }
  return entries
}

const isUnmerged = ({ x, y }) => x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')

// HEAD, branch, git paths, status and index entries in one read; `problem` is the first command that did not come back green.
async function readCheckout(git, cwd) {
  const reads = [
    await git(['rev-parse', 'HEAD']),
    await git(['rev-parse', '--abbrev-ref', 'HEAD']),
    await git(['rev-parse', ...GIT_PATHS.flatMap((name) => ['--git-path', name])]),
    await git([...GIT_STATUS_ARGS]),
    await git(['ls-files', '--stage', '-z']),
  ]
  const bad = reads.find((read) => read.status !== 'green')
  if (bad) return { problem: bad }
  const [head, branch, paths, status, entries] = reads.map((read) => read.stdout)
  const lines = paths.split('\n').filter((line) => line !== '')
  if (!HEX_OID.test(head.trim()) || lines.length !== GIT_PATHS.length) return { problem: unmeasured('invalid-remote-data') }
  const where = (name) => resolve(cwd, lines[GIT_PATHS.indexOf(name)])
  // Status labels say a path changed, not what it holds; the bytes of every path status names are compared too.
  const named = (parseStatus(status) ?? []).flatMap((entry) => (entry.from === null ? [entry.path] : [entry.path, entry.from]))
  const digest = createHash('sha256')
  for (const path of [...new Set(named)].sort()) {
    let bytes = null
    try { bytes = lstatSync(join(cwd, path)).isFile() ? readFileSync(join(cwd, path)) : null } catch {}
    digest.update(`${path}\0${bytes === null ? 'absent' : createHash('sha256').update(bytes).digest('hex')}\0`)
  }
  return {
    head: head.trim(), branch: branch.trim(), status, entries, contents: digest.digest('hex'), indexPath: where('index'),
    busy: GIT_PATHS.filter((name) => name !== 'index' && existsSync(where(name))),
  }
}

const sameCheckout = (a, b) => a.head === b.head && a.branch === b.branch && a.status === b.status && a.entries === b.entries && a.contents === b.contents

// Puts HEAD and the index back to the captured state, then proves it by reading the checkout again.
async function restoreCheckout(git, cwd, before, indexBefore) {
  const problems = []
  const { indexPath } = before
  const now = await git(['rev-parse', 'HEAD'])
  const moved = now.status === 'green' ? now.stdout.trim() : null
  if (moved === null) problems.push('HEAD unreadable')
  else if (moved !== before.head) {
    const back = await git(['update-ref', '-m', 'restore after a failed lane commit', 'HEAD', before.head, moved])
    if (back.status !== 'green') problems.push('HEAD was not restored')
  }
  try {
    if (indexBefore === null) rmSync(indexPath, { force: true })
    else writeFileSync(indexPath, indexBefore)
  } catch (error) { problems.push(`index was not restored: ${describeError(error).message}`) }
  const after = await readCheckout(git, cwd)
  if (after.problem || !sameCheckout(before, after)) problems.push('the checkout differs from its state before the commit')
  return problems
}

// shortcut: one writer per checkout; add an explicit checkout lease before concurrent writers
// Commits exactly the listed files that changed. Anything staged beside them stays staged, and a failed commit leaves HEAD, index and tree as found.
export async function commitChanges(spec = {}, deps = {}) {
  return guarded(async () => {
    const { cwd, files: listed, subject, body = '', closes = [], refs = [], timeoutMs = DEFAULT_TIMEOUT_MS } = spec ?? {}
    deps ??= {}
    const closing = issueList(closes)
    const referenced = issueList(refs)
    const files = Array.isArray(listed) ? [...new Set(listed)] : null
    const valid = typeof cwd === 'string' && cwd !== '' && validTimeout(timeoutMs) && singleLine(subject) && typeof body === 'string'
      && closing && referenced && files && files.every((file) => typeof file === 'string' && literalRelative(file))
    if (!valid) return unmeasured('invalid-input')
    for (const file of files) {
      try { if (lstatSync(join(cwd, file)).isDirectory()) return unmeasured('invalid-input', { detail: `${file} is a directory` }) } catch {}
    }
    if (files.length === 0) return red('nothing-to-commit')
    const git = (args) => runCommand({ cwd, command: 'git', args, timeoutMs }, deps)
    const before = await readCheckout(git, cwd)
    if (before.problem) return notGreen(before.problem, 'commit-failed')
    const status = parseStatus(before.status)
    if (!status) return unmeasured('invalid-remote-data')
    if (before.busy.length > 0 || status.some(isUnmerged)) return red('dirty-worktree', { busy: before.busy })
    for (const entry of status) {
      if (entry.from !== null && files.includes(entry.path) !== files.includes(entry.from)) {
        return unmeasured('invalid-input', { detail: `${entry.from} -> ${entry.path} must be committed together` })
      }
    }
    // Added to the index then deleted from the tree (AD) is no change against HEAD, and a pathspec for it matches nothing.
    const changed = status.filter((entry) => !(entry.x === 'A' && entry.y === 'D')).flatMap((entry) => (entry.from === null ? [entry.path] : [entry.path, entry.from]))
    const present = files.filter((file) => changed.includes(file))
    if (present.length === 0) return red('nothing-to-commit')
    let indexBefore = null
    try { indexBefore = readFileSync(before.indexPath) } catch (error) {
      if (error?.code !== 'ENOENT') return unmeasured('commit-failed', { error: describeError(error) })
    }
    const toStage = present.filter((file) => status.some((entry) => entry.path === file && entry.y !== ' '))
    const message = composeLaneMessage({ subject, body, closes: closing, refs: referenced })
    let failure = null
    if (toStage.length > 0) {
      const staged = await git(['--literal-pathspecs', 'add', '--', ...toStage])
      if (staged.status !== 'green') failure = staged
    }
    if (!failure) {
      const made = await git(['--literal-pathspecs', ...NO_HOOKS, 'commit', '--only', '-m', message, '--', ...present])
      if (made.status === 'green') {
        const head = await git(['rev-parse', 'HEAD'])
        if (head.status === 'green' && HEX_OID.test(head.stdout.trim()) && head.stdout.trim() !== before.head) {
          return { status: 'green', reason: null, head: head.stdout.trim(), files: present }
        }
        failure = head.status === 'green' ? unmeasured('invalid-remote-data') : head
      } else failure = made
    }
    const outcome = notGreen(failure, 'commit-failed')
    const problems = await restoreCheckout(git, cwd, before, indexBefore)
    return problems.length === 0 ? outcome : unmeasured('cleanup-unproven', { cause: outcome.reason, problems })
  })
}

// Rebases the lane onto `base`; a rebase that stops is aborted and the checkout proven back to where it started.
export async function rebaseBranch(spec = {}, deps = {}) {
  return guarded(async () => {
    const { cwd, base, generated, timeoutMs = DEFAULT_TIMEOUT_MS } = spec ?? {}
    deps ??= {}
    if (typeof cwd !== 'string' || cwd === '' || !validTimeout(timeoutMs) || (Object.hasOwn(spec ?? {}, 'generated') && !validGenerated(generated))) return unmeasured('invalid-input')
    const git = (args) => runCommand({ cwd, command: 'git', args, timeoutMs }, deps)
    const bad = await refProblem(git, base)
    if (bad) return bad
    const before = await readCheckout(git, cwd)
    if (before.problem) return notGreen(before.problem, 'rebase-failed')
    if (before.busy.length > 0 || before.status !== '') return red('dirty-worktree', { busy: before.busy })
    if (before.branch === 'HEAD') return unmeasured('invalid-input', { detail: 'a detached HEAD has no lane branch to rebase' })
    // A bare name can resolve to a tag of the same name, so it is resolved to a branch: the remote-tracking
    // origin/<base> first, because a local base may lag it. The caller fetches before rebasing.
    let target = null, onto = null
    for (const ref of [`refs/remotes/origin/${base}`, `refs/remotes/${base}`, `refs/heads/${base}`]) {
      const resolved = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
      if (resolved.status === 'green') {
        onto = resolved.stdout.trim()
        if (!HEX_OID.test(onto)) return unmeasured('invalid-remote-data')
        target = ref; break
      }
    }
    if (target === null) return red('rebase-failed', { detail: `${base} is neither a local nor a remote-tracking branch` })
    // Every step below uses the resolved commit, never the ref: lanes share origin/<base>, and a fetch by another lane
    // between the resolve and the rebase would move it under this one.
    // An ignored file the base tracks can be overwritten by a rebase, and an abort does not bring it back.
    const ignored = await git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard'])
    const tracked = await git(['ls-tree', '-r', '-z', '--name-only', onto])
    if (ignored.status !== 'green' || tracked.status !== 'green') return unmeasured('rebase-failed', { detail: 'ignored or base paths could not be listed' })
    const baseFiles = new Set(tracked.stdout.split('\0').filter(Boolean))
    const colliding = ignored.stdout.split('\0').filter((path) => path !== '' && baseFiles.has(path))
    if (colliding.length > 0) return red('dirty-worktree', { detail: 'ignored files the base tracks would be overwritten', paths: colliding })
    const count = generated ? await git(['rev-list', '--count', `${onto}..${before.head}`]) : null
    if (count && (count.status !== 'green' || !/^\d+$/.test(count.stdout.trim()))) return unmeasured('rebase-failed', { detail: 'lane commits could not be counted' })
    let outcome = await git([...NO_HOOKS, '-c', 'rebase.autoStash=false', 'rebase', onto])
    if (generated && outcome.status === 'red') {
      const declared = (path) => generated.paths.some((entry) => entry.endsWith('/') ? path.startsWith(entry) : path === entry)
      const conflicts = new Set()
      let failure = null
      for (let stops = 0; outcome.status === 'red' && stops < Number(count.stdout.trim()); stops++) {
        const listed = await git(['diff', '--name-only', '--diff-filter=U', '-z'])
        if (listed.status !== 'green') { failure = unmeasured('rebase-failed', { detail: 'the conflict list could not be read' }); break }
        const paths = listed.stdout.split('\0').filter(Boolean)
        if (!paths.length) break
        for (const path of paths) conflicts.add(path)
        if (!paths.every(declared)) { failure = red('rebase-conflict', { conflicts: paths, regenerate: 'undeclared-path' }); break }
        for (const path of paths) {
          const stages = await git(['--literal-pathspecs', 'ls-files', '--unmerged', '-z', '--', path])
          if (stages.status !== 'green') { failure = notGreen(stages, 'rebase-failed'); break }
          const hasOurs = stages.stdout.split('\0').some((entry) => /^[0-7]+ [0-9a-f]+ 2\t/.test(entry))
          if (hasOurs) {
            const ours = await git(['--literal-pathspecs', 'checkout', '--ours', '--', path])
            if (ours.status !== 'green') { failure = notGreen(ours, 'rebase-failed'); break }
          }
          const staged = hasOurs ? await git(['--literal-pathspecs', 'add', '--', path]) : await git(['--literal-pathspecs', 'rm', '-f', '--ignore-unmatch', '--', path])
          if (staged.status !== 'green') { failure = notGreen(staged, 'rebase-failed'); break }
        }
        if (failure) break
        outcome = await git([...NO_HOOKS, '-c', 'core.editor=true', 'rebase', '--continue'])
        if (outcome.status === 'red') {
          const left = await git(['diff', '--name-only', '--diff-filter=U', '-z'])
          const empty = await git(['diff', '--cached', '--quiet'])
          if (left.status === 'green' && left.stdout === '' && empty.status === 'green') outcome = await git([...NO_HOOKS, 'rebase', '--skip'])
        }
      }
      if (!failure && outcome.status === 'green' && conflicts.size) {
        const rebased = await readCheckout(git, cwd)
        let temp = null, tree = null, newHead = null
        try {
          if (rebased.problem) failure = notGreen(rebased.problem, 'rebase-failed')
          else {
            temp = realpathSync(mkdtempSync(join(tmpdir(), 'crew-regenerate-')))
            tree = join(temp, 'tree')
            const scratchGit = (args) => runCommand({ cwd: tree, command: 'git', args, timeoutMs }, deps)
            const added = await git([...NO_HOOKS, 'worktree', 'add', '--detach', tree, rebased.head])
            if (added.status !== 'green') failure = notGreen(added, 'rebase-failed')
            else {
              const regenerated = await runCommand({ cwd: tree, command: generated.command, args: generated.args, timeoutMs: generated.timeoutMs ?? DEFAULT_TIMEOUT_MS }, deps)
              if (regenerated.status !== 'green') failure = regenerated.status === 'red'
                ? red('rebase-conflict', { conflicts: [...conflicts], regenerate: 'regenerate-failed', cause: regenerated.reason })
                : { ...regenerated, conflicts: [...conflicts] }
              else {
                const afterCommand = await readCheckout(scratchGit, tree)
                let entries = !afterCommand.problem && afterCommand.head === rebased.head && afterCommand.branch === 'HEAD' && afterCommand.busy.length === 0 ? parseStatus(afterCommand.status) : null
                let changed = entries?.flatMap((entry) => entry.from === null ? [entry.path] : [entry.path, entry.from])
                if (!changed) failure = unmeasured('rebase-failed', { detail: 'regenerated paths could not be listed' })
                else if (!changed.every(declared)) failure = red('rebase-conflict', { conflicts: [...conflicts], regenerate: 'undeclared-path' })
                else {
                  // A command may have force-staged ignored output; leave it in the disposable tree.
                  for (const entry of entries.filter((item) => 'ARC'.includes(item.x))) {
                    const ignored = await scratchGit(['check-ignore', '--no-index', '-q', '--', entry.path])
                    if (ignored.status === 'green') {
                      const unstaged = await scratchGit(['--literal-pathspecs', 'reset', '-q', 'HEAD', '--', entry.path])
                      if (unstaged.status !== 'green') { failure = notGreen(unstaged, 'rebase-failed'); break }
                    } else if (ignored.status !== 'red' || ignored.code !== 1) { failure = notGreen(ignored, 'rebase-failed'); break }
                  }
                  if (!failure) {
                    const status = await scratchGit([...GIT_STATUS_ARGS])
                    entries = status.status === 'green' ? parseStatus(status.stdout) : null
                    changed = entries?.flatMap((entry) => entry.from === null ? [entry.path] : [entry.path, entry.from])
                    if (!changed) failure = unmeasured('rebase-failed', { detail: 'regenerated paths could not be listed' })
                  }
                  if (!failure) {
                    for (const path of new Set([...conflicts, ...changed])) {
                      try {
                        if (lstatSync(join(tree, path)).isFile() && /^(?:<<<<<<<|>>>>>>>)/m.test(readFileSync(join(tree, path), 'utf8'))) {
                          failure = red('rebase-conflict', { conflicts: [...conflicts], regenerate: 'conflict-markers' }); break
                        }
                      } catch (error) { if (error?.code !== 'ENOENT') { failure = unmeasured('rebase-failed', { detail: `cannot read ${path}` }); break } }
                    }
                    if (!failure && changed.length) {
                      const staged = await scratchGit(['add', '-A', '--', '.'])
                      const commit = staged.status === 'green'
                        ? await scratchGit([...NO_HOOKS, 'commit', ...(rebased.head === onto ? ['-C', before.head] : ['--amend', '--no-edit'])]) : staged
                      if (commit.status !== 'green') failure = notGreen(commit, 'rebase-failed')
                    }
                    if (!failure) {
                      const head = await scratchGit(['rev-parse', 'HEAD'])
                      if (head.status !== 'green' || !HEX_OID.test(head.stdout.trim())) failure = unmeasured('rebase-failed', { detail: 'regenerated head could not be read' })
                      else newHead = head.stdout.trim()
                    }
                  }
                }
              }
            }
          }
        } catch (error) {
          failure = unmeasured('rebase-failed', { error: describeError(error) })
        } finally {
          if (temp) {
            if (tree) await git(['worktree', 'remove', '--force', tree])
            try { rmSync(temp, { recursive: true, force: true }) } catch {}
            await git(['worktree', 'prune'])
            const worktrees = await git(['worktree', 'list', '--porcelain', '-z'])
            if (existsSync(temp) || worktrees.status !== 'green' || worktrees.stdout.split('\0').includes(`worktree ${tree}`)) failure = unmeasured('cleanup-unproven', { cause: failure?.reason ?? null, detail: 'scratch worktree removal could not be proven' })
          }
        }
        if (!failure) {
          const added = await git(['diff-tree', '-r', '--name-only', '-z', '--diff-filter=A', rebased.head, newHead])
          if (added.status !== 'green') failure = notGreen(added, 'rebase-failed')
          else {
            const paths = []
            for (const path of added.stdout.split('\0').filter(Boolean)) {
              const parts = path.split('/')
              for (let i = 1; i <= parts.length; i++) {
                try {
                  const stat = lstatSync(join(cwd, ...parts.slice(0, i)))
                  if (i === parts.length || !stat.isDirectory()) { paths.push(path); break }
                } catch (error) {
                  if (error?.code !== 'ENOENT') failure = unmeasured('rebase-failed', { detail: `cannot inspect ${path}` })
                  break
                }
              }
              if (failure) break
            }
            if (!failure && paths.length) failure = red('dirty-worktree', { paths })
          }
          if (!failure) {
            const reset = await git(['reset', '-q', '--keep', newHead])
            if (reset.status !== 'green') failure = notGreen(reset, 'rebase-failed')
          }
        }
        if (!failure) {
          const after = await readCheckout(git, cwd)
          const onBase = await git(['merge-base', '--is-ancestor', onto, 'HEAD'])
          if (!after.problem && after.head === newHead && after.busy.length === 0 && after.status === '' && after.branch === before.branch && onBase.status === 'green') return { status: 'green', reason: null, head: after.head, onto, regenerated: { paths: [...conflicts] } }
          failure = unmeasured('rebase-failed', { detail: 'the regenerated checkout could not be proven clean and on its base' })
        }
      }
      if (failure || conflicts.size) {
        const result = failure ?? notGreen(outcome, 'rebase-failed')
        const mid = await readCheckout(git, cwd)
        if (mid.problem || mid.busy.some((name) => name.startsWith('rebase-'))) await git(['rebase', '--abort'])
        // The command never ran in this checkout, so reset and clean leave its ignored files alone.
        await git(['reset', '-q', '--hard', before.head])
        await git(['clean', '-f', '-d'])
        const final = await readCheckout(git, cwd)
        return final.problem || final.busy.length || !sameCheckout(before, final) || result.reason === 'cleanup-unproven'
          ? unmeasured('cleanup-unproven', { cause: result.reason, detail: 'the checkout is not proven back at its pre-rebase state' }) : result
      }
    }
    if (outcome.status === 'green') {
      const after = await readCheckout(git, cwd)
      const onBase = await git(['merge-base', '--is-ancestor', onto, 'HEAD'])
      if (!after.problem && after.busy.length === 0 && after.status === '' && after.branch === before.branch && onBase.status === 'green') return { status: 'green', reason: null, head: after.head, onto }
      return unmeasured('rebase-failed', { detail: 'the rebase exited 0 but the checkout could not be proven clean and on its base' })
    }
    const listed = outcome.status === 'red' ? await git(['diff', '--name-only', '--diff-filter=U', '-z']) : null
    const mid = await readCheckout(git, cwd)
    if (mid.problem || mid.busy.some((name) => name.startsWith('rebase-'))) {
      await git(['rebase', '--abort'])
    }
    let final = await readCheckout(git, cwd)
    // A runner can report failure after git finished the rebase: the branch moved with no rebase left to abort.
    if (!final.problem && final.busy.length === 0 && final.status === '' && final.branch === before.branch && final.head !== before.head) {
      await git(['reset', '-q', '--keep', before.head])
      final = await readCheckout(git, cwd)
    }
    if (final.problem || final.busy.length > 0 || !sameCheckout(before, final)) {
      return unmeasured('cleanup-unproven', { cause: outcome.reason, detail: 'the checkout is not proven back at its pre-rebase state' })
    }
    if (outcome.status !== 'red') return outcome
    if (listed.status !== 'green') return unmeasured('rebase-failed', { detail: 'the conflict list could not be read' })
    const conflicts = listed.stdout.split('\0').filter((path) => path !== '')
    if (conflicts.length > 0) return { status: 'red', reason: 'rebase-conflict', conflicts }
    return red('rebase-failed', { detail: outcome.stderr.trim() || null })
  })
}

function validPr(record, branch, base) {
  if (!record || typeof record !== 'object' || !Number.isSafeInteger(record.number) || record.number <= 0) return false
  try { if (new URL(record.url).protocol !== 'https:') return false } catch { return false }
  return record.state === 'OPEN' && record.headRefName === branch && typeof record.baseRefName === 'string' && record.isCrossRepository === false
}

// Pushes the lane branch (never forced) and opens its PR, or returns the PR already open. Every claim is read back.
export async function openPullRequest(spec = {}, deps = {}) {
  return guarded(async () => {
    const { cwd, branch, base, title, body = '', closes = [], refs = [], remote = 'origin', timeoutMs = DEFAULT_TIMEOUT_MS } = spec ?? {}
    deps ??= {}
    const closing = issueList(closes)
    const referenced = issueList(refs)
    const valid = typeof cwd === 'string' && cwd !== '' && validTimeout(timeoutMs) && singleLine(title) && typeof body === 'string'
      && closing && referenced && typeof remote === 'string' && /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(remote)
    if (!valid) return unmeasured('invalid-input')
    if (branch === base) return unmeasured('invalid-input', { detail: 'the lane branch is its own base; nothing is pushed' })
    const git = (args) => runCommand({ cwd, command: 'git', args, timeoutMs }, deps)
    const gh = (args) => runCommand({ cwd, command: 'gh', args, timeoutMs }, deps)
    const bad = await refProblem(git, branch) ?? await refProblem(git, base)
    if (bad) return bad
    const headRead = await git(['rev-parse', 'HEAD'])
    const current = await git(['symbolic-ref', '--short', 'HEAD'])
    if (headRead.status !== 'green') return notGreen(headRead, 'push-unmeasured')
    if (current.status !== 'green') return notGreen(current, 'push-unmeasured')
    const head = headRead.stdout.trim()
    if (!HEX_OID.test(head)) return unmeasured('invalid-remote-data')
    if (current.stdout.trim() !== branch) return unmeasured('invalid-input', { detail: `checked out branch is ${current.stdout.trim()}, not ${branch}` })

    // null is unknown (failed, malformed or ambiguous query), never an absent PR.
    const openPrs = async () => {
      // Queried by head only: a PR the lane already has on another base must block a second, not hide behind --base.
      const listed = await gh(['pr', 'list', '--state', 'open', '--head', branch, '--json', 'number,url,state,headRefName,baseRefName,isCrossRepository'])
      if (listed.status !== 'green') return null
      let records
      try { records = JSON.parse(listed.stdout) } catch { return null }
      if (!Array.isArray(records) || !records.every((record) => validPr(record, branch, base))) return null
      return records.map(({ number, url, state, headRefName, baseRefName }) => ({ number, url, state, headRefName, baseRefName }))
    }
    // '' is a measured absent branch; null is unknown.
    const remoteHead = async () => {
      const listed = await git(['ls-remote', '--heads', remote, `refs/heads/${branch}`])
      if (listed.status !== 'green') return null
      const lines = listed.stdout.split('\n').filter((line) => line !== '')
      if (lines.length === 0) return ''
      const [oid, ref] = lines[0].split('\t')
      return lines.length === 1 && ref === `refs/heads/${branch}` && HEX_OID.test(oid) ? oid : null
    }

    const existing = await openPrs()
    if (existing === null || existing.length > 1) return unmeasured('pr-unmeasured')
    if (existing.length === 1 && existing[0].baseRefName !== base) return unmeasured('pr-unmeasured', { detail: `the open PR for ${branch} targets ${existing[0].baseRefName}, not ${base}`, pr: existing[0] })
    let remoteOid = await remoteHead()
    if (remoteOid !== head) {
      await git(['push', remote, `HEAD:refs/heads/${branch}`])
      remoteOid = await remoteHead()
    }
    if (remoteOid !== head) return unmeasured('push-unmeasured')
    const composedBody = composeLanePrBody({ body, closes: closing, refs: referenced })
    if (existing.length === 1) {
      const edited = await gh(['pr', 'edit', String(existing[0].number), '--body', composedBody])
      if (edited.status !== 'green') return notGreen(edited, 'pr-unmeasured')
      const viewed = await gh(['pr', 'view', String(existing[0].number), '--json', 'body'])
      if (viewed.status !== 'green') return unmeasured('pr-unmeasured')
      let confirmedBody
      try { confirmedBody = JSON.parse(viewed.stdout)?.body } catch { return unmeasured('pr-unmeasured') }
      if (confirmedBody !== composedBody) return unmeasured('pr-unmeasured')
      return { status: 'green', reason: null, pr: existing[0], reused: true }
    }
    await gh(['pr', 'create', '--base', base, '--head', branch, '--title', withoutIssueTokens(title), '--body', composedBody])
    const confirmed = await openPrs() ?? []
    if (confirmed.length !== 1 || confirmed[0].baseRefName !== base) return unmeasured('pr-unmeasured')
    return { status: 'green', reason: null, pr: confirmed[0], reused: false }
  })
}
