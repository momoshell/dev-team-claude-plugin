// factoryctl owns nothing — the daemon owns the workers, the registry and the projection; this is a socket client that prints.
import netDefault from 'node:net'
import { spawnSync as cpSpawnSync } from 'node:child_process'
import { existsSync as fsExistsSync, readFileSync as fsReadFileSync, statSync as fsStatSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { splitFrames } from './headless-rpc.mjs'
import { VARIANTS } from './variants.mjs'
import { archivedLanes, crewRoot, discoverLanes } from '../scripts/factory/lane-watch.mjs'

export const DEFAULT_TIMEOUT_MS = 5000

// A --flag followed by another --flag (or by nothing) is a BOOLEAN true.
export function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) { out._.push(token); continue }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) { out[token.slice(2)] = true } else { out[token.slice(2)] = next; i += 1 }
  }
  return out
}

// --- per-verb usage (#536 F12) -----------------------------------------------
// The allow-list is PER VERB and is never merged with crew.mjs's KNOWN_FLAGS:
// the two CLIs' vocabularies are deliberately separate, --lane means one thing
// to `run` and nothing at all to `ls`, and one global bag would re-admit exactly
// the confusion F12 measured.
export const KNOWN_FLAGS = Object.freeze({
  run: Object.freeze(['root', 'crew-dir', 'tier', 'brief', 'task', 'checkout', 'variant', 'files-in-scope', 'lane']),
  ls: Object.freeze(['root', 'json']),
  attach: Object.freeze(['root']),
  send: Object.freeze(['root', 'role']),
  pending: Object.freeze(['crew-root', 'repo', 'json']),
  waiting: Object.freeze(['crew-root', 'json', 'resolve', 'expire', 'dry-run']),
})

// A flag that is CORRECT on crew.mjs and wrong here, so the refusal says what
// was MEANT and not only what was wrong. Naming the mismatch is in scope;
// renaming a flag is not, and nothing here admits the flag.
export const FLAG_HINTS = Object.freeze({
  run: Object.freeze({ 'validation-lane': 'lane', 'brief-file': 'brief' }),
})

function editDistance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 0; j <= b.length; j += 1) rows[0][j] = j
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost)
    }
  }
  return rows[a.length][b.length]
}

// An explicit cross-CLI hint first, then a typo within two edits of a real flag.
function nearestFlag(verb, flag) {
  const hinted = FLAG_HINTS[verb]?.[flag]
  if (hinted) return hinted
  let best = null
  let bestDistance = 3
  for (const known of KNOWN_FLAGS[verb] || []) {
    const distance = editDistance(flag, known)
    if (distance < bestDistance) { best = known; bestDistance = distance }
  }
  return best
}

export class CtlUsageError extends Error {
  constructor(message) { super(message); this.name = 'CtlUsageError'; this.usage = true }
}

// `__proto__` changes an ordinary object's prototype and `_` overwrites
// parseArgs' positional sentinel, so neither reaches assertUsage as an unknown
// key. Scan raw argv before parseArgs can hide either spelling; parseArgs itself
// remains unchanged for its pinned export contract.
function rawUsageVerb(argv) {
  if (!Array.isArray(argv)) return null
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (typeof token !== 'string') continue
    if (!token.startsWith('--')) return token
    const next = argv[i + 1]
    if (typeof next === 'string' && !next.startsWith('--')) i += 1
  }
  return null
}

function assertRawUsage(verb, argv) {
  if (!Object.hasOwn(KNOWN_FLAGS, verb) || !Array.isArray(argv)) return
  const unknown = [...new Set(argv.filter((token) => token === '--__proto__' || token === '--_').map((token) => token.slice(2)))]
  if (unknown.length === 0) return
  const named = unknown.map((flag) => `--${flag}`).join(', ')
  const reads = KNOWN_FLAGS[verb].map((flag) => `--${flag}`).join(', ')
  throw new CtlUsageError(`factoryctl ${verb} does not read ${named}; ${verb} reads: ${reads}`)
}

// Layered OVER parseArgs and never inside it: parseArgs' export name, signature
// and return shape are pinned outside this file, so the refusal is a separate
// assertion step rather than a change to what parseArgs returns.
export function assertUsage(verb, args) {
  const supplied = args && typeof args === 'object' ? args : {}
  const known = KNOWN_FLAGS[verb] || []
  const unknown = Object.keys(supplied).filter((key) => key !== '_' && !known.includes(key))
  if (unknown.length === 0) return
  const named = unknown.map((flag) => {
    const meant = nearestFlag(verb, flag)
    return meant ? `--${flag} (did you mean --${meant}?)` : `--${flag}`
  }).join(', ')
  const reads = known.map((flag) => `--${flag}`).join(', ')
  throw new CtlUsageError(`factoryctl ${verb} does not read ${named}; ${verb} reads: ${reads}`)
}

export function socketPathFor(args = {}, env = process.env) {
  const root = args.root || env.CREW_DAEMON_ROOT || join(homedir(), '.crew', 'daemon')
  return join(root, 'daemon.sock')
}

function noDaemonError(socketPath) {
  const root = dirname(socketPath)
  const error = new Error([
    `no crew daemon is listening at ${socketPath} — factoryctl never starts one.`,
    'Start a daemon first, e.g.:',
    `  node --input-type=module -e "import {daemon} from './crew/daemon.mjs'; await daemon({root:'${root}'}).start()"`,
  ].join('\n'))
  error.code = 'no-daemon'
  return error
}

function connectionError(err, socketPath) {
  if (['ENOENT', 'ECONNREFUSED', 'ENOTSOCK'].includes(err?.code)) return noDaemonError(socketPath)
  return err instanceof Error ? err : new Error(String(err))
}

function daemonTimeoutError(socketPath) {
  const error = new Error(`timed out waiting for a response from the crew daemon at ${socketPath}`)
  error.code = 'daemon-timeout'
  return error
}

export function connect(socketPath, deps = {}) {
  const net = deps.net || netDefault
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise((resolve, reject) => {
    let socket
    let connected = false
    let settled = false
    let closed = false
    let sequence = 0
    let rest = Buffer.alloc(0)
    const pending = new Map()
    const listeners = new Set()

    const rejectPending = (error) => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(error)
      }
      pending.clear()
    }

    const failConnection = (err) => {
      const error = connectionError(err, socketPath)
      if (!connected) {
        if (settled) return
        settled = true
        try { socket?.destroy?.() } catch {}
        reject(error)
        return
      }
      rejectPending(error)
    }

    const close = () => {
      if (closed) return Promise.resolve()
      closed = true
      const error = new Error('factoryctl connection closed')
      error.code = 'connection-closed'
      rejectPending(error)
      try { socket?.destroy?.() } catch {}
      return Promise.resolve()
    }

    const call = (cmd, params) => new Promise((resolveCall, rejectCall) => {
      if (closed) {
        const error = new Error('factoryctl connection is closed')
        error.code = 'connection-closed'
        rejectCall(error)
        return
      }
      const id = `factoryctl-${++sequence}`
      const timer = setTimeout(() => {
        if (!pending.has(id)) return
        pending.delete(id)
        rejectCall(daemonTimeoutError(socketPath))
      }, timeoutMs)
      pending.set(id, { resolve: resolveCall, reject: rejectCall, timer })
      const request = { id, cmd }
      if (params !== undefined) request.params = params
      try { socket.write(`${JSON.stringify(request)}\n`) }
      catch (err) {
        clearTimeout(timer)
        pending.delete(id)
        rejectCall(err)
      }
    })

    const onData = (chunk) => {
      const split = splitFrames(Buffer.concat([rest, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''), 'utf8')]))
      rest = split.rest
      for (const line of split.lines) {
        if (!line.trim()) continue
        let frame
        try { frame = JSON.parse(line) } catch { continue }
        if (!frame || typeof frame.id !== 'string') continue
        if (frame.ok === undefined && frame.error === undefined) {
          for (const listener of listeners) { try { listener(frame) } catch {} }
          continue
        }
        const entry = pending.get(frame.id)
        if (!entry) continue
        pending.delete(frame.id)
        clearTimeout(entry.timer)
        if (frame.ok === true) entry.resolve(frame.result)
        else {
          const detail = frame.error || {}
          entry.reject(Object.assign(new Error(detail.message), { code: detail.code }))
        }
      }
    }

    try { socket = net.connect(socketPath) }
    catch (err) { failConnection(err); return }
    socket.on?.('data', onData)
    socket.on?.('error', failConnection)
    socket.on?.('close', () => {
      if (!connected) failConnection(Object.assign(new Error('socket closed'), { code: 'ENOENT' }))
      else rejectPending(new Error(`crew daemon connection closed at ${socketPath}`))
    })
    socket.on?.('connect', () => {
      if (settled || closed) return
      connected = true
      settled = true
      resolve({ call, close, onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn) } })
    })
  })
}

export function formatRows(rows) {
  const headers = ['RUN', 'STATE', 'OUTCOME', 'TASK']
  const values = (Array.isArray(rows) ? rows : []).map((row) => [
    row?.run_id == null ? '' : String(row.run_id),
    row?.state == null ? '' : String(row.state),
    row?.outcome == null ? '' : String(row.outcome),
    row?.task == null ? '' : String(row.task),
  ])
  const widths = headers.map((header, index) => Math.max(header.length, ...values.map((value) => value[index].length)))
  const render = (value, index) => index === values[0]?.length - 1 ? value : value.padEnd(widths[index])
  const header = headers.map((value, index) => index === headers.length - 1 ? value : value.padEnd(widths[index])).join('  ')
  return [header, ...values.map((row) => row.map(render).join('  '))].join('\n')
}

function outputSink(value, fallback) {
  if (typeof value === 'function') return value
  if (value && typeof value.write === 'function') return (text) => value.write(text)
  return (text) => fallback.write(text)
}

function requireRunArgs(args) {
  const hasDir = typeof args['crew-dir'] === 'string' && !!args['crew-dir']
  const hasTier = typeof args.tier === 'string' && !!args.tier
  if (args['crew-dir'] !== undefined && !hasDir) throw new Error('run requires --crew-dir <dir>')
  if (args.tier !== undefined && !hasTier) throw new Error('run requires --tier <tier>')
  if (hasDir && hasTier) throw new Error('run takes --crew-dir <dir> or --tier <tier>, never both: --crew-dir runs a crew you booted, --tier asks the daemon to boot one')
  if (!hasDir && !hasTier) throw new Error('run requires --crew-dir <dir> (a booted crew) or --tier <tier> (the daemon boots one)')
  if (typeof args.brief !== 'string' || !args.brief) throw new Error('run requires --brief <file>')
  if (args.task !== undefined && (typeof args.task !== 'string' || !args.task)) throw new Error('run requires --task <slug> when --task is present')
  if (args.checkout !== undefined && (typeof args.checkout !== 'string' || !args.checkout)) throw new Error('run requires --checkout <dir> when --checkout is present')
  if (args.variant !== undefined && (typeof args.variant !== 'string' || !args.variant)) throw new Error('run requires --variant <name> when --variant is present')
  if (args['files-in-scope'] !== undefined && (typeof args['files-in-scope'] !== 'string' || !args['files-in-scope'].trim())) throw new Error('run requires --files-in-scope <a,b> when --files-in-scope is present')
  if (args.lane !== undefined && (typeof args.lane !== 'string' || !args.lane.trim())) throw new Error('run requires --lane <lane> when --lane is present')
  if (typeof args['files-in-scope'] === 'string' && args['files-in-scope'].split(',').map((entry) => entry.trim()).filter(Boolean).length === 0) throw new Error('--files-in-scope supplied an empty list — an empty scope is never a scope')
  if (VARIANTS[args.variant]?.sources?.scope === 'inherited' && args['files-in-scope'] === undefined) throw new Error(`run requires --files-in-scope for a ${args.variant} run — scope-sourced runs cannot declare an empty scope`)
}

// The slug defaults to the brief's filename; crew.mjs slugs it and refuses a degenerate one.
function briefTask(file) { return basename(file).replace(/\.[^.]+$/, '') }

export async function runVerb(args, deps = {}) {
  requireRunArgs(args)
  const call = deps.call || deps.connection?.call
  if (typeof call !== 'function') throw new Error('run requires a daemon connection')
  const params = { brief_file: resolvePath(args.brief) }
  if (typeof args['crew-dir'] === 'string' && args['crew-dir']) params.crew_dir = resolvePath(args['crew-dir'])
  else {
    const cwd = typeof deps.cwd === 'function' ? deps.cwd() : process.cwd()
    params.tier = args.tier
    params.checkout = resolvePath(args.checkout || cwd)
    params.task = typeof args.task === 'string' && args.task ? args.task : briefTask(args.brief)
  }
  if (typeof args.variant === 'string' && args.variant) params.variant = args.variant
  if (typeof args.lane === 'string' && args.lane) params.lane = args.lane
  if (typeof args['files-in-scope'] === 'string') {
    const files = args['files-in-scope'].split(',').map((entry) => entry.trim()).filter(Boolean)
    if (files.length === 0) throw new Error('--files-in-scope supplied an empty list — an empty scope is never a scope')
    // Per-entry rules are adjudicated by enqueue; keeping no second copy here
    // ensures the daemon names the offending entry in the operator's refusal.
    params.files_in_scope = files
  } else if (VARIANTS[args.variant]?.sources?.scope === 'inherited') {
    throw new Error(`run requires --files-in-scope for a ${args.variant} run — scope-sourced runs cannot declare an empty scope`)
  }
  const result = await call('enqueue', params)
  const stdout = outputSink(deps.stdout, process.stdout)
  stdout(`${JSON.stringify({ run_id: result?.run_id, ...(params.tier && result?.crew_dir ? { crew_dir: result.crew_dir } : {}) })}\n`)
  return result
}

// The WHOLE message, not its first word (#536 F13): every positional past the
// run id, joined by one space. A word beginning with `--` is NOT message text —
// parseArgs reads it as a flag and assertUsage then refuses it by name, so a
// message whose first word starts with `--` has no spelling on this CLI and is
// refused loudly rather than silently truncated.
function sendMessage(args) {
  if (!Array.isArray(args?._)) return null
  const message = args._.slice(2).join(' ')
  return message.trim() ? message : null
}

function requireSendArgs(args) {
  if (typeof args?._?.[1] !== 'string' || !args._[1] || sendMessage(args) === null) {
    throw new Error('send requires <run-id> and <message>')
  }
  if (args.role !== undefined && (typeof args.role !== 'string' || !args.role)) throw new Error('send requires --role <role> when --role is present')
}

export async function sendVerb(args, deps = {}) {
  requireSendArgs(args)
  const call = deps.call || deps.connection?.call
  if (typeof call !== 'function') throw new Error('send requires a daemon connection')
  const role = args.role
  const result = await call('send', { run: args._[1], message: sendMessage(args), ...(role ? { role } : {}) })
  const stdout = outputSink(deps.stdout, process.stdout)
  stdout(`${JSON.stringify(result)}\n`)
  return result
}

export async function lsVerb(args, deps = {}) {
  const call = deps.call || deps.connection?.call
  if (typeof call !== 'function') throw new Error('ls requires a daemon connection')
  const listed = await call('list')
  const rows = []
  for (const run of Array.isArray(listed) ? listed : []) {
    const result = await call('result', { run: run.run_id })
    rows.push({ run_id: run.run_id, task: run.task, state: run.state, outcome: result?.outcome ?? null })
  }
  const stdout = outputSink(deps.stdout, process.stdout)
  if (args.json) stdout(`${JSON.stringify(rows)}\n`)
  else stdout(`${formatRows(rows)}\n`)
  return rows
}

function requireAttachArgs(args) {
  if (typeof args?._?.[1] !== 'string' || !args._[1]) throw new Error('attach requires <run-id>')
}

function attachEndMessage(run, reason) {
  if (reason === 'settled') return `attach ended: run ${run} settled — this stream is transport, not a verdict; ask \`factoryctl ls\` for the outcome\n`
  if (reason === 'dead') return `attach ended: run ${run} is dead with no envelope — ask \`factoryctl ls\` for the outcome\n`
  if (reason === 'interrupted') return `attach ended: interrupted — run ${run} was still streaming; the envelope is the record\n`
  if (reason === 'stream-closed') return `attach ended: output stream closed — run ${run} was still streaming\n`
  return `attach ended: run ${run} stream ended (${reason})\n`
}

export async function attachVerb(args, deps = {}) {
  requireAttachArgs(args)
  const run = args._[1]
  const call = deps.call || deps.connection?.call
  const onEvent = deps.onEvent || deps.connection?.onEvent
  if (typeof call !== 'function' || typeof onEvent !== 'function') throw new Error('attach requires a daemon connection')
  const stdout = outputSink(deps.stdout, process.stdout)
  const stderr = outputSink(deps.stderr, process.stderr)
  const signal = deps.signal
  let ended = false
  let reason = null
  let finish
  const done = new Promise((resolve) => {
    finish = (value) => {
      if (ended) return
      ended = true
      reason = value
      resolve(value)
    }
  })
  const listener = (frame) => {
    if (ended) return
    if (frame?.event !== undefined) {
      try { stdout(`${JSON.stringify(frame.event)}\n`) }
      catch { finish('stream-closed') }
      return
    }
    if (frame?.end !== undefined) finish(frame.end?.reason)
  }
  const unsubscribe = onEvent(listener)
  const abort = () => finish('interrupted')
  signal?.addEventListener?.('abort', abort, { once: true })
  try {
    if (signal?.aborted) finish('interrupted')
    if (!ended) {
      await call('tail', { run, since: 0 })
      if (!ended) {
        const current = await call('state', { run })
        if (!ended && current?.state === 'done') finish('settled')
        else if (!ended && current?.state === 'dead') finish('dead')
      }
    }
    if (!ended && signal?.aborted) finish('interrupted')
    const finalReason = await done
    stderr(attachEndMessage(run, finalReason))
    return { run_id: run, reason: finalReason }
  } finally {
    signal?.removeEventListener?.('abort', abort)
    try { await call('untail', { run }) } catch {}
    try { unsubscribe?.() } catch {}
  }
}

// --- pending publication (#678): READ-ONLY REGION BEGIN -----------------------
// A done lane commits to its branch and stops; nothing enumerates what is then
// waiting to be published. This region answers that and MUTATES NOTHING: it
// reads run.log, asks git read-only questions and asks `gh pr list`. No push, no
// PR, no teardown, no write to any crew dir.
export const PENDING_UNKNOWN = 'unknown'

// --- the completion log (#687) -----------------------------------------------
// A crew directory is mutable, reusable and removable, so `run.log` answers for
// whatever run holds the dir NOW: a reused dir serves the previous run's line and
// a removed dir serves nothing. The completion log has neither property — one
// line per finishing run, appended once, never rewritten, outliving the dir it
// came from. It is an ADDITIONAL source under the SAME verb: with it absent,
// `pending` answers exactly as it did before the log existed.
export const COMPLETION_LOG_NAME = 'completions.jsonl'
export const COMPLETION_LOG_ENV = 'CREW_COMPLETION_LOG'

// ONE resolver, shared by the writer (crew/crew.mjs) and this reader, so the two
// can never disagree about where the record lives. The env override is what makes
// the path injectable: a test must never write into a real home (#672).
export function completionLogPath({ root, home, env = process.env } = {}) {
  const override = env?.[COMPLETION_LOG_ENV]
  if (typeof override === 'string' && override.trim()) return resolvePath(override.trim())
  return join(root || crewRoot({ home }), COMPLETION_LOG_NAME)
}

function validCompletion(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false
  if (typeof row.lane !== 'string' || !row.lane) return false
  return typeof row.outcome === 'string' && row.outcome.length > 0
}

// Typed absences, never a silent empty: `absent` is a log nobody has written yet,
// `unknown` is a log that exists and could not be read. Collapsing the two would
// report "nothing pending" for a log the reader never opened, which is worse than
// having no log at all. A malformed line is skipped and COUNTED.
export function readCompletionLog(path, d) {
  let text
  try { text = d.readFileSync(path, 'utf8') } catch (err) {
    if (err?.code === 'ENOENT') return { state: 'absent', records: [], malformed: 0 }
    return { state: PENDING_UNKNOWN, records: [], malformed: 0 }
  }
  const records = []
  let malformed = 0
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { malformed += 1; continue }
    if (!validCompletion(row)) { malformed += 1; continue }
    records.push(row)
  }
  return { state: 'ok', records, malformed }
}

export function pendingDeps(deps = {}) {
  return {
    lanes: deps.lanes || ((root) => [...discoverLanes(root), ...archivedLanes(root)]),
    readFileSync: deps.readFileSync || fsReadFileSync,
    statSync: deps.statSync || fsStatSync,
    spawnSync: deps.spawnSync || cpSpawnSync,
    home: deps.home,
  }
}

// The terminal line every run writes (crew/crew.mjs:1905). LAST wins: a run.log
// carries seat noise and earlier frames, and only the last one is the outcome.
export function terminalRunLine(text) {
  const lines = String(text ?? '').split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (!line.startsWith('{')) continue
    let frame
    try { frame = JSON.parse(line) } catch { continue }
    if (!frame || typeof frame.status !== 'string') continue
    return { status: frame.status, commit: typeof frame.commit === 'string' && frame.commit ? frame.commit : null }
  }
  return null
}

const DONE_WITH_COMMIT = (terminal) => terminal?.status === 'done' && typeof terminal?.commit === 'string' && terminal.commit.length > 0

// Every git call is read-only and local except the --expire preservation commit below; no fetch or remote round trip.
export function gitRunner(d, repo) {
  return (...args) => {
    let result
    try { result = d.spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }) }
    catch (err) { return { status: 128, stdout: '', stderr: String(err?.message || err) } }
    if (result?.error) return { status: 128, stdout: '', stderr: String(result.error.message || result.error) }
    return { status: result?.status, stdout: String(result?.stdout || '').trim(), stderr: String(result?.stderr || '').trim() }
  }
}

function defaultBranch(git) {
  const head = git('rev-parse', '--abbrev-ref', 'origin/HEAD')
  if (head.status === 0 && head.stdout) return head.stdout
  for (const name of ['main', 'master']) {
    if (git('show-ref', '--verify', '--quiet', `refs/heads/${name}`).status === 0) return name
  }
  return null
}

function remoteName(git) {
  const listed = git('remote')
  if (listed.status !== 0) return null
  const first = listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean)[0]
  return first || null
}

function localName(branch) { return typeof branch === 'string' ? branch.replace(/^[^/]+\//, '') : branch }

export function resolveBranch(git, commit, slug, base) {
  const listed = git('for-each-ref', '--contains', commit, '--format=%(refname:short)', 'refs/heads')
  if (listed.status !== 0) return PENDING_UNKNOWN
  const names = listed.stdout.split('\n').map((line) => line.trim())
    .filter(Boolean).filter((name) => name !== base && name !== localName(base))
  if (names.includes(slug)) return slug
  if (names.length === 1) return names[0]
  return PENDING_UNKNOWN
}

function remoteState(git, branch, remote) {
  if (branch === PENDING_UNKNOWN || !remote) return PENDING_UNKNOWN
  const found = git('show-ref', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`)
  if (found.status === 0) return 'yes'
  if (found.status === 1) return 'no'
  return PENDING_UNKNOWN
}

// The issue the commit names, from the Refs trailer drive.mjs composes
// (crew/drive.mjs:1530). No trailer is unknown, never "no issue".
export function commitIssues(message) {
  const match = String(message ?? '').match(/^Refs:\s*(.+)$/m)
  if (!match) return PENDING_UNKNOWN
  const issues = match[1].split(',').map((entry) => entry.trim()).filter(Boolean)
  return issues.length ? issues.join(' ') : PENDING_UNKNOWN
}

// A MEASURED answer or unknown — never "unpublished" because nobody could ask.
function pullRequestState(d, repo, branch) {
  if (branch === PENDING_UNKNOWN) return { pr: PENDING_UNKNOWN, published: false }
  let result
  try { result = d.spawnSync('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state'], { cwd: repo, encoding: 'utf8' }) }
  catch { return { pr: PENDING_UNKNOWN, published: false } }
  if (result?.error || result?.status !== 0) return { pr: PENDING_UNKNOWN, published: false }
  let listed
  try { listed = JSON.parse(String(result.stdout || '')) } catch { return { pr: PENDING_UNKNOWN, published: false } }
  if (!Array.isArray(listed)) return { pr: PENDING_UNKNOWN, published: false }
  const open = listed.filter((entry) => {
    const state = String(entry?.state || '').toUpperCase()
    return state === 'OPEN' || state === 'MERGED'
  })
  if (open.length) return { pr: open.map((entry) => `#${entry?.number ?? '?'}`).join(' '), published: true }
  return { pr: 'none', published: false }
}

export function classifyLane(lane, ctx) {
  const runLog = join(lane.dir, 'run.log')
  let text
  try { text = ctx.d.readFileSync(runLog, 'utf8') } catch { return { kind: 'skip', reason: 'no-run-log' } }
  let doneAt = PENDING_UNKNOWN
  try { doneAt = ctx.d.statSync(runLog).mtime.toISOString() } catch { doneAt = PENDING_UNKNOWN }
  const terminal = terminalRunLine(text)
  if (terminal === null) {
    // A LIVE lane with no terminal line yet is RUNNING, not unclassifiable: it
    // has not finished, so it is not waiting to be published.
    if (!lane.archived && !lane.settled) return { kind: 'skip', reason: 'running' }
    return {
      kind: 'unknown', reason: 'run-log-unreadable',
      row: {
        lane: lane.task, commit: PENDING_UNKNOWN, branch: PENDING_UNKNOWN, issue: PENDING_UNKNOWN,
        done_at: doneAt, remote: PENDING_UNKNOWN, pr: PENDING_UNKNOWN, state: 'unknown', reason: 'run-log-unreadable',
        source: 'run.log',
      },
    }
  }
  return classifyTerminal({ task: lane.task, terminal, doneAt, ctx, source: 'run.log' })
}

// The same verdict for a run named by the completion log rather than by a crew
// dir. The record carries its OWN run's outcome and commit, so a lane whose dir
// was reused is judged on the run that wrote the record and never on whichever
// run holds the dir now.
export function classifyCompletion(record, ctx) {
  const terminal = {
    status: record.outcome,
    commit: typeof record.commit === 'string' && record.commit ? record.commit : null,
  }
  const doneAt = typeof record.at === 'string' && record.at ? record.at : PENDING_UNKNOWN
  return classifyTerminal({ task: record.lane, terminal, doneAt, ctx, source: 'completion-log' })
}

// The publication verdict for ONE finished run, whatever named it. Both sources
// converge here, so `pending` keeps one classifier and one set of git questions.
function classifyTerminal({ task, terminal, doneAt, ctx, source }) {
  if (!DONE_WITH_COMMIT(terminal)) {
    return { kind: 'skip', reason: terminal.status === 'done' ? 'done-without-commit' : 'not-done' }
  }
  const commit = terminal.commit
  const known = ctx.git('cat-file', '-e', `${commit}^{commit}`).status === 0
  const branch = known ? resolveBranch(ctx.git, commit, task, ctx.base) : PENDING_UNKNOWN
  if (known && ctx.base && ctx.git('merge-base', '--is-ancestor', commit, ctx.base).status === 0) {
    return { kind: 'skip', reason: 'merged' }
  }
  // Nothing to publish without a branch to push: the commit was merged under a
  // different sha and its branch deleted, or the object is not this repo's. Say
  // unknown — never "pending", which would claim work nobody can act on.
  if (branch === PENDING_UNKNOWN) {
    return {
      kind: 'unknown', reason: known ? 'branch-gone' : 'commit-not-in-repo',
      row: {
        lane: task, commit, branch: PENDING_UNKNOWN,
        issue: known ? commitIssues(ctx.git('log', '-1', '--format=%B', commit).stdout) : PENDING_UNKNOWN,
        done_at: doneAt, remote: PENDING_UNKNOWN, pr: PENDING_UNKNOWN,
        state: 'unknown', reason: known ? 'branch-gone' : 'commit-not-in-repo',
        source,
      },
    }
  }
  const pull = pullRequestState(ctx.d, ctx.repo, branch)
  if (pull.published) return { kind: 'skip', reason: 'pull-request' }
  const message = known ? ctx.git('log', '-1', '--format=%B', commit) : { status: 1, stdout: '' }
  return {
    kind: 'pending',
    row: {
      lane: task,
      commit,
      branch,
      issue: message.status === 0 ? commitIssues(message.stdout) : PENDING_UNKNOWN,
      done_at: doneAt,
      remote: remoteState(ctx.git, branch, ctx.remote),
      pr: pull.pr,
      state: 'pending',
      reason: known ? null : 'commit-not-in-repo',
      source,
    },
  }
}

const PENDING_HEADERS = ['LANE', 'COMMIT', 'BRANCH', 'ISSUE', 'DONE-AT', 'REMOTE', 'PR', 'STATE', 'WHY', 'SOURCE']
const PENDING_KEYS = ['lane', 'commit', 'branch', 'issue', 'done_at', 'remote', 'pr', 'state', 'reason', 'source']

export function formatPending({ rows, counts }) {
  const summary = `pending: ${counts.pending} · unknown: ${counts.unknown} · published: ${counts.published} · not-done: ${counts.not_done} · running: ${counts.running} · no-run-log: ${counts.no_run_log} · scanned: ${counts.scanned} · completion-log: ${counts.completion_log} · records: ${counts.completion_records} · added: ${counts.completion_added} · confirmed: ${counts.completion_confirmed} · malformed: ${counts.completion_malformed}`
  if (!rows.length) return ['no lanes are pending publication — no done lane in this crew root is waiting on a push', summary].join('\n')
  const values = rows.map((row) => PENDING_KEYS.map((key) => (row?.[key] == null ? (key === 'reason' ? '-' : PENDING_UNKNOWN) : String(row[key]))))
  const widths = PENDING_HEADERS.map((header, index) => Math.max(header.length, ...values.map((value) => value[index].length)))
  const line = (cells) => cells.map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index]))).join('  ')
  return [line(PENDING_HEADERS), ...values.map(line), summary].join('\n')
}

export function pendingVerb(args, deps = {}) {
  const d = pendingDeps(deps)
  const root = typeof args['crew-root'] === 'string' && args['crew-root'] ? resolvePath(args['crew-root']) : crewRoot({ home: d.home })
  const repo = typeof args.repo === 'string' && args.repo
    ? resolvePath(args.repo)
    : (typeof deps.cwd === 'function' ? deps.cwd() : process.cwd())
  const git = gitRunner(d, repo)
  const ctx = { d, git, repo, base: defaultBranch(git), remote: remoteName(git) }
  const pendingRows = []
  const index = new Map()
  const counts = {
    scanned: 0, pending: 0, unknown: 0, published: 0, not_done: 0, running: 0, no_run_log: 0,
    completion_log: 'absent', completion_records: 0, completion_added: 0, completion_confirmed: 0, completion_malformed: 0,
  }
  const rowKey = (lane, commit) => `${lane}\u0000${commit ?? ''}`
  for (const lane of d.lanes(root)) {
    counts.scanned += 1
    const verdict = classifyLane(lane, ctx)
    if (verdict.kind === 'skip') {
      if (verdict.reason === 'running') counts.running += 1
      else if (verdict.reason === 'no-run-log') counts.no_run_log += 1
      else if (verdict.reason === 'merged' || verdict.reason === 'pull-request') counts.published += 1
      else counts.not_done += 1
      continue
    }
    if (index.has(rowKey(verdict.row.lane, verdict.row.commit))) continue
    if (verdict.kind === 'unknown') counts.unknown += 1
    else counts.pending += 1
    index.set(rowKey(verdict.row.lane, verdict.row.commit), verdict.row)
    pendingRows.push(verdict.row)
  }
  // The SECOND source, merged into the same rows under the same verb. A run both
  // sources know is reported once and says so; a run only the log knows is added.
  // The crew-dir scan's own counters above are never touched by this loop, which
  // is what makes "delete the log and nothing is lost but reach" checkable.
  const completion = readCompletionLog(completionLogPath({ root, env: deps.env || process.env }), d)
  counts.completion_log = completion.state
  counts.completion_records = completion.records.length
  counts.completion_malformed = completion.malformed
  for (const record of completion.records) {
    const key = rowKey(record.lane, typeof record.commit === 'string' && record.commit ? record.commit : null)
    const seen = index.get(key)
    if (seen) { seen.source = 'both'; counts.completion_confirmed += 1; continue }
    const verdict = classifyCompletion(record, ctx)
    if (verdict.kind === 'skip') continue
    counts.completion_added += 1
    if (verdict.kind === 'unknown') counts.unknown += 1
    else counts.pending += 1
    index.set(key, verdict.row)
    pendingRows.push(verdict.row)
  }
  pendingRows.sort((a, b) => (a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0))
  const result = { rows: pendingRows, counts }
  const stdout = outputSink(deps.stdout, process.stdout)
  stdout(args.json ? `${JSON.stringify(result)}\n` : `${formatPending(result)}\n`)
  return result
}
// --- pending publication (#678): READ-ONLY REGION END -------------------------

// --- waiting on a human (#528): the escalation queue -------------------------
// `pending` above answers "what is waiting on a PUSH". This region answers a
// different question — "what is waiting on a HUMAN, since when, and what does it
// need" — and the two never share a verb: #687 asserts an escalated lane never
// appears in `pending`, because it is not pending a push.
//
// The row source is the durable completion record (#687), never a live crew dir:
// an escalated lane holds its workspace by design, but the workspace can still be
// removed, and the record outlives it. `where` and `why` come from that run's own
// returns/task.json.
//
// There is NO daemon here: expiry is classified at READ time against an injectable
// clock, and the destructive half is an explicit operator flag.

// 48h — two working days. An escalated lane holds a whole workspace (a worktree,
// a crew dir, warm panes), and the measured recovery window on this factory is
// same-day-or-next: teardown after recovery was missed 4x on 2026-08-21 (#528).
// Revisable when the real distribution of human response time is measured.
export const ESCALATION_BOUND_MS = 48 * 60 * 60 * 1000

export const WAITING_STATES = Object.freeze({ WAITING: 'waiting', EXPIRED: 'expired', UNKNOWN: 'unknown' })

// The moves the driver can actually accept, keyed by the escalation stage
// crew/drive.mjs emits (skills/crew-recovery/references/escalations.md holds the
// closed set and its operator guidance). An unlisted stage takes the default set
// rather than an empty one — never claim a human has no move.
export const DEFAULT_RESOLUTIONS = Object.freeze(['rerun-widened-fence', 'repair', 'plan-rounds', 'park'])
export const RESOLUTIONS_BY_WHERE = Object.freeze({
  scope: ['rerun-widened-fence', 'park'],
  'triage-scope': ['rerun-widened-fence', 'park'],
  plan: ['plan-rounds', 'rerun-widened-fence', 'park'],
  'plan-check': ['plan-rounds', 'park'],
  'plan-carve': ['rerun-widened-fence', 'park'],
  'sensitivity-floor': ['rerun-widened-fence', 'park'],
  build: ['repair', 'plan-rounds', 'park'],
  review: ['repair', 'park'],
  'refuted-must-fix': ['repair', 'park'],
  residuals: ['repair', 'park'],
  gate: ['repair', 'plan-rounds', 'park'],
  suite: ['repair', 'park'],
  triage: ['repair', 'park'],
  lane: ['rerun-widened-fence', 'park'],
  envelope: ['repair', 'park'],
  issues: ['repair', 'park'],
  full: ['repair', 'plan-rounds', 'park'],
  scout: ['rerun-widened-fence', 'park'],
  repair: ['repair', 'park'],
  directed: ['rerun-widened-fence', 'plan-rounds', 'park'],
})

export function resolutionsFor(where) {
  return [...(RESOLUTIONS_BY_WHERE[where] || DEFAULT_RESOLUTIONS)]
}

const CREW_CLI = join(dirname(fileURLToPath(import.meta.url)), 'crew.mjs')

// Teardown is crew.mjs's verb and stays there: this file shells out to it rather
// than importing it, because crew.mjs imports completionLogPath from here and a
// static cycle between the two is not worth one function call.
function defaultTeardown({ lane, checkout }, d) {
  let result
  try { result = d.spawnSync(process.execPath, [CREW_CLI, 'teardown', '--task', lane, '--checkout', checkout], { encoding: 'utf8' }) }
  catch (err) { return { ok: false, archived: null, reason: `teardown-spawn-failed: ${err?.message || String(err)}` } }
  if (result?.error) return { ok: false, archived: null, reason: `teardown-spawn-failed: ${result.error.message || result.error}` }
  let archived = null
  try { archived = JSON.parse(String(result.stdout || '{}'))?.archived ?? null } catch { archived = null }
  if (result.status !== 0) return { ok: false, archived, reason: `teardown-exit-${result.status}` }
  return { ok: true, archived, reason: null }
}

export function waitingDeps(deps = {}) {
  return {
    readFileSync: deps.readFileSync || fsReadFileSync,
    existsSync: deps.existsSync || fsExistsSync,
    spawnSync: deps.spawnSync || cpSpawnSync,
    now: deps.now || (() => Date.now()),
    teardown: deps.teardown || defaultTeardown,
    home: deps.home,
  }
}

// Safe by construction: only --expire or --resolve turns the sweep destructive,
// and an explicit --dry-run wins over it in either order (scripts/factory/reap-stale.mjs:251, #439).
export function waitingFlags(args = {}) {
  if (args.resolve === true) throw new Error('waiting --resolve requires <lane>')
  const expire = args.expire === true
  const resolve = typeof args.resolve === 'string' && args.resolve ? args.resolve : null
  const explicitDryRun = args['dry-run'] === true
  const dryRun = explicitDryRun || !(expire || resolve)
  return { expire, resolve, dryRun }
}

// The escalation block drive.mjs composes (crew/drive.mjs:2133). Every absence is
// TYPED: an unreadable envelope is `unknown` with a reason, never a row silently
// dropped and never a `where` invented.
export function escalationDetail(path, d) {
  if (typeof path !== 'string' || !path) return { where: PENDING_UNKNOWN, why: PENDING_UNKNOWN, reason: 'task-return-absent' }
  let text
  try { text = d.readFileSync(path, 'utf8') } catch { return { where: PENDING_UNKNOWN, why: PENDING_UNKNOWN, reason: 'task-return-unreadable' } }
  let envelope
  try { envelope = JSON.parse(String(text)) } catch { return { where: PENDING_UNKNOWN, why: PENDING_UNKNOWN, reason: 'task-return-malformed' } }
  const escalation = envelope?.details?.escalation
  if (!escalation || typeof escalation.where !== 'string' || !escalation.where) {
    return { where: PENDING_UNKNOWN, why: PENDING_UNKNOWN, reason: 'escalation-absent' }
  }
  return {
    where: escalation.where,
    why: typeof escalation.why === 'string' && escalation.why ? escalation.why : PENDING_UNKNOWN,
    reason: null,
  }
}

// Read-time classification, against an injected clock. Nothing fires by itself.
export function classifyWaiting(record, { now, d }) {
  const detail = escalationDetail(record.task_return, d)
  const at = typeof record.at === 'string' && record.at ? Date.parse(record.at) : NaN
  const age = Number.isFinite(at) ? now - at : null
  const expired = age !== null && age > ESCALATION_BOUND_MS
  const reason = detail.reason || (age === null ? 'escalated-at-unknown' : null)
  const state = reason ? WAITING_STATES.UNKNOWN : (expired ? WAITING_STATES.EXPIRED : WAITING_STATES.WAITING)
  return {
    run: typeof record.run === 'string' && record.run ? record.run : PENDING_UNKNOWN,
    lane: record.lane,
    where: detail.where,
    why: detail.why,
    escalated_at: typeof record.at === 'string' && record.at ? record.at : PENDING_UNKNOWN,
    age_h: age === null ? PENDING_UNKNOWN : Math.round((age / 3600000) * 10) / 10,
    workspace: typeof record.crew_dir === 'string' ? record.crew_dir : PENDING_UNKNOWN,
    workspace_present: typeof record.crew_dir === 'string' ? d.existsSync(record.crew_dir) : false,
    checkout: typeof record.checkout === 'string' ? record.checkout : PENDING_UNKNOWN,
    state,
    resolutions: resolutionsFor(detail.where),
    reason,
    preserved: null,
    archived: null,
    action: null,
    source: 'completion-log',
  }
}

// The ONE write this file makes, and only behind --expire. Nothing is DELETED:
// the tree becomes a WIP commit on whatever branch the lane checkout is on, and
// that branch is the recovery handle. A clean tree commits nothing and HEAD is
// already the ref, which is why the verdict is `rev-parse` plus `cat-file`, not
// the commit's own exit status.
export function preserveTree(git, lane) {
  const added = git('add', '-A')
  if (added.status !== 0) return { commit: null, reason: 'preserve-add-failed' }
  const staged = git('diff', '--cached', '--quiet')
  if (staged.status === 1) {
    const committed = git('commit', '--no-verify', '-m', `wip(${lane}): preserve escalated tree before expiry`)
    if (committed.status !== 0) return { commit: null, reason: 'preserve-commit-failed' }
  } else if (staged.status !== 0) {
    return { commit: null, reason: 'preserve-index-unknown' }
  }
  const head = git('rev-parse', 'HEAD')
  if (head.status !== 0 || !head.stdout) return { commit: null, reason: 'preserve-no-head' }
  if (git('cat-file', '-e', `${head.stdout}^{commit}`).status !== 0) return { commit: null, reason: 'preserve-unverified' }
  return { commit: head.stdout, reason: null }
}

const WAITING_HEADERS = ['LANE', 'RUN', 'WHERE', 'WHY', 'ESCALATED-AT', 'AGE-H', 'STATE', 'WORKSPACE', 'HELD', 'RESOLUTIONS', 'PRESERVED', 'ACTION', 'WHY-NOT']
const WAITING_KEYS = ['lane', 'run', 'where', 'why', 'escalated_at', 'age_h', 'state', 'workspace', 'workspace_present', 'resolutions', 'preserved', 'action', 'reason']

export function formatWaiting({ rows, counts }) {
  const summary = `waiting: ${counts.waiting} · expired: ${counts.expired} · unknown: ${counts.unknown} · escalations: ${counts.escalations} · records: ${counts.records} · malformed: ${counts.malformed} · completion-log: ${counts.log} · resolved: ${counts.resolved} · expired-acted: ${counts.expired_acted} · dry-run: ${counts.dry_run}`
  if (!rows.length) return ['no lane is waiting on a human — no escalation record in this crew root is unresolved', summary].join('\n')
  const values = rows.map((row) => WAITING_KEYS.map((key) => {
    const value = row?.[key]
    if (Array.isArray(value)) return value.join(',')
    if (value === null || value === undefined) return key === 'reason' || key === 'preserved' || key === 'action' ? '-' : PENDING_UNKNOWN
    return String(value)
  }))
  const widths = WAITING_HEADERS.map((header, index) => Math.max(header.length, ...values.map((value) => value[index].length)))
  const line = (cells) => cells.map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index]))).join('  ')
  return [line(WAITING_HEADERS), ...values.map(line), summary].join('\n')
}

export function waitingVerb(args, deps = {}) {
  const d = waitingDeps(deps)
  const flags = waitingFlags(args)
  const root = typeof args['crew-root'] === 'string' && args['crew-root'] ? resolvePath(args['crew-root']) : crewRoot({ home: d.home })
  const now = d.now()
  const waitingRows = []
  const counts = {
    log: 'absent', records: 0, escalations: 0, waiting: 0, expired: 0, unknown: 0, malformed: 0,
    resolved: 0, expired_acted: 0, dry_run: flags.dryRun,
  }
  const completion = readCompletionLog(completionLogPath({ root, env: deps.env || process.env }), d)
  counts.log = completion.state
  counts.records = completion.records.length
  counts.malformed = completion.malformed
  // A log the reader could not OPEN is not an empty queue. It gets its own typed
  // row, because "nothing is waiting on you" is the one answer this verb must
  // never give by accident.
  if (completion.state === PENDING_UNKNOWN) {
    waitingRows.push({
      run: PENDING_UNKNOWN, lane: PENDING_UNKNOWN, where: PENDING_UNKNOWN, why: PENDING_UNKNOWN,
      escalated_at: PENDING_UNKNOWN, age_h: PENDING_UNKNOWN, workspace: PENDING_UNKNOWN, workspace_present: false,
      checkout: PENDING_UNKNOWN, state: WAITING_STATES.UNKNOWN, resolutions: resolutionsFor(PENDING_UNKNOWN),
      reason: 'completion-log-unreadable', preserved: null, archived: null, action: null, source: 'completion-log',
    })
  }
  for (const record of completion.records) {
    if (record.outcome !== 'escalation') continue
    counts.escalations += 1
    const row = classifyWaiting(record, { now, d })
    // The destructive half, and the ONLY place this verb writes anything.
    const actionableCheckout = typeof row.checkout === 'string' && isAbsolute(row.checkout)
    if (!flags.dryRun && !actionableCheckout) {
      row.reason = 'checkout-unusable'
    } else if (!flags.dryRun && flags.resolve === row.lane) {
      const torn = d.teardown({ lane: row.lane, checkout: row.checkout, crewDir: row.workspace, preserved: null }, d)
      row.action = 'resolved'
      row.archived = torn.archived
      if (!torn.ok) row.reason = torn.reason
      counts.resolved += 1
    } else if (!flags.dryRun && flags.expire && row.state === WAITING_STATES.EXPIRED) {
      const preserved = preserveTree(gitRunner(d, row.checkout), row.lane)
      // Preserve BEFORE teardown, and never tear down without a ref that names a
      // real commit — the ordering IS the safety property.
      if (!preserved.commit) row.reason = preserved.reason
      else {
        row.preserved = preserved.commit
        const torn = d.teardown({ lane: row.lane, checkout: row.checkout, crewDir: row.workspace, preserved: preserved.commit }, d)
        row.archived = torn.archived
        row.action = 'expired'
        if (!torn.ok) row.reason = torn.reason
        counts.expired_acted += 1
      }
    }
    waitingRows.push(row)
  }
  for (const row of waitingRows) {
    if (row.state === WAITING_STATES.EXPIRED) counts.expired += 1
    else if (row.state === WAITING_STATES.UNKNOWN) counts.unknown += 1
    else counts.waiting += 1
  }
  waitingRows.sort((a, b) => (a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0))
  const result = { rows: waitingRows, counts }
  const stdout = outputSink(deps.stdout, process.stdout)
  stdout(args.json ? `${JSON.stringify(result)}\n` : `${formatWaiting(result)}\n`)
  return result
}
// --- waiting on a human (#528): END ------------------------------------------

export async function main(argv, deps = {}) {
  const stderr = outputSink(deps.stderr, process.stderr)
  try { assertRawUsage(rawUsageVerb(argv), argv) }
  catch (err) { stderr(`error: ${err?.message || String(err)}\n`); return 2 }
  const args = parseArgs(argv)
  const verb = args._[0]
  if (!['run', 'ls', 'attach', 'send', 'pending', 'waiting'].includes(verb)) {
    stderr('usage: factoryctl <run|ls|attach|send|pending|waiting> ...\n')
    return 2
  }
  // Refuse what the operator typed and this CLI does not read, BEFORE anything is
  // enqueued: a dropped flag used to enqueue an unscoped, unlaned run in silence.
  try { assertUsage(verb, args) }
  catch (err) { stderr(`error: ${err?.message || String(err)}\n`); return 2 }
  // `pending` and `waiting` read; they never connect to a daemon and never start one.
  if (verb === 'pending' || verb === 'waiting') {
    try {
      if (verb === 'pending') pendingVerb(args, deps)
      else waitingVerb(args, deps)
      return 0
    }
    catch (err) { stderr(`error: ${err?.message || String(err)}\n`); return 1 }
  }

  let session = null
  let controller = null
  let signalProcess = null
  let onInterrupt = null
  let onTerminate = null
  try {
    if (verb === 'run') requireRunArgs(args)
    if (verb === 'attach') requireAttachArgs(args)
    if (verb === 'send') requireSendArgs(args)
    if (verb === 'attach') {
      controller = new AbortController()
      signalProcess = deps.process ?? process
      onInterrupt = () => controller.abort()
      onTerminate = () => controller.abort()
      signalProcess.on?.('SIGINT', onInterrupt)
      signalProcess.on?.('SIGTERM', onTerminate)
    }
    session = await connect(socketPathFor(args, deps.env || process.env), { net: deps.net, timeoutMs: deps.timeoutMs })
    const commandDeps = { ...deps, call: session.call, onEvent: session.onEvent }
    if (verb === 'run') await runVerb(args, commandDeps)
    else if (verb === 'ls') await lsVerb(args, commandDeps)
    else if (verb === 'attach') await attachVerb(args, { ...commandDeps, signal: deps.signal ?? controller.signal })
    else await sendVerb(args, commandDeps)
    return 0
  } catch (err) {
    stderr(`error: ${err?.message || String(err)}\n`)
    return 1
  } finally {
    if (signalProcess) {
      const remove = signalProcess.removeListener || signalProcess.off
      remove?.call(signalProcess, 'SIGINT', onInterrupt)
      remove?.call(signalProcess, 'SIGTERM', onTerminate)
    }
    try { await session?.close?.() } catch {}
  }
}

const invokedDirectly = process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code })
}
