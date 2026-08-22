// The planner/scout lab extension: a seat-authored PROGRAM runs in a node
// --permission child while every lab.* operation is served by this host against
// a disposable clone of the committed HEAD.
//
// Why .ts: pi loads extensions through jiti, so no build step exists. Node
// imports this file directly through erasable type stripping, which means it
// MUST stay erasable-syntax-only: annotations and interfaces are permitted;
// never enum, namespace or parameter properties.
//
// Why zero-dep: pi is not a dependency of this checkout. Nothing outside
// node: is reachable, and the repo's own suite must be able to import this file
// directly with a bare ESM import.
//
// The lab is granted to the scout/planner seat only. The builder and lead seats
// are NEVER granted lab: a builder composing host operations is a fence bypass.
// This bounds ACCIDENTS. Adversarial containment is #72's work.
//
// runSuite is the declared carve-out. The PROGRAM itself runs with no
// filesystem write, no child process and no network. runSuite() is the one
// exception: its suite child runs with host authority because the repository
// suite cannot run under node --permission at all. Code written into the scratch
// with mutate() and then executed with runSuite() therefore runs with the
// host's authority. That boundary is declared in the tool description, every
// result and every journal row, not hidden as a gap.

import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const LAB_TOOL_NAME = 'lab'
export const LAB_API = Object.freeze(['scratchCheckout', 'read', 'grep', 'mutate', 'runSuite'])
export const LAB_PERMISSION_FLAG = '--permission'
export const LAB_ORIGIN_HEAD_REF = 'refs/remotes/origin/HEAD'
// Two audit layers, deliberately not one. The per-path probe is defence in depth
// and can only ever sample finitely many paths (ground truth 16); the execArgv
// scan is what makes ABSENCE provable, because this launcher emits no fs-write
// flag at all, so any occurrence is a widening whatever its value (ground truth 17).
export const LAB_AUDIT_UNGRANTED = Object.freeze(['fs.write', 'child', 'net', 'worker'])
export const LAB_AUDIT_WRITE_PROBES = Object.freeze(['/', '/tmp'])
export const LAB_AUDIT_FORBIDDEN_ARGV = Object.freeze(['--allow-fs-write'])
export const LAB_GREP_OPTIONS = Object.freeze(['ignoreCase', 'fixedString', 'maxHits', 'pathspec'])
// Dot-prefixed names are ADMITTED — .gitignore, .github/workflows/test.yml and
// .claude/** are ordinary tracked files a seat must be able to read, grep, mutate
// and select. Traversal is rejected by the SEGMENT guard, never by the first
// character class, and `--` already separates pathspec and test argv.
export const LAB_PATH_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/
export const LAB_PATH_FORBIDDEN = /[\\\0*?[\]]/
export const LAB_CHILD_TIMEOUT_MS = 5 * 60 * 1000
export const LAB_OP_TIMEOUT_MS = 60 * 1000
export const LAB_OP_MAXBUFFER = 16 * 1024 * 1024
export const LAB_SUITE_TIMEOUT_MS = 10 * 60 * 1000
export const LAB_REAP_POLL_MS = 50
export const LAB_REAP_POLLS_MAX = 40
export const LAB_STDIO_GRACE_MS = 250
export const LAB_PROGRAM_CAP_BYTES = 64 * 1024
export const LAB_OUTPUT_CAP_BYTES = 50 * 1024
export const LAB_OUTPUT_CAP_LINES = 2000
// Bounded by createStreamCollector below, for BOTH children. A cap that names
// no collector bounds nothing (r3 H1).
export const LAB_STREAM_CAP_BYTES = 4 * 1024 * 1024
export const LAB_RESIDUAL_CAP_BYTES = 1 * 1024 * 1024
// Queued-but-not-yet-served RPC frames. Under the 4 MiB byte cap a child can
// emit roughly a million tiny newline-delimited frames, so a byte cap alone
// leaves opChain unbounded (r4 C1).
export const LAB_FRAME_QUEUE_MAX = 1024
export const LAB_GREP_HITS_MAX = 500
export const LAB_SUITE_PATHS_MAX = 64
export const LAB_REFUSALS = Object.freeze([
  'program-invalid', 'program-oversize', 'cwd-invalid',
  'no-scratch', 'scratch-failed',
  'path-option-shaped', 'path-not-relative', 'path-traversal',
  'path-escapes-scratch', 'file-missing',
  'find-absent', 'find-equals-replace', 'op-args-invalid',
  'op-timeout', 'op-oversize', 'unknown-op',
  'child-denied', 'child-timeout', 'child-unreaped', 'child-failed',
  'suite-failed', 'output-oversize',
])

export interface LabScratch { path: string; head: string; detached: boolean; origin_url: string | null; origin_head: string | null }
export interface LabReadResult { file: string; text: string; truncated: boolean }
export interface LabGrepHit { file: string; line: number; text: string }
export interface LabGrepOptions { ignoreCase?: boolean; fixedString?: boolean; maxHits?: number; pathspec?: string[] }
export interface LabGrepResult { pattern: string; hits: LabGrepHit[]; truncated: boolean }
export interface LabMutateResult { file: string; count: number }
export interface LabSuiteResult { paths: string[]; pass: number | null; fail: number | null; exit_code: number | null; host_authority: true; truncated: boolean }
export interface LabAudit { runner: boolean; program: boolean; granted: string[]; execargv: string[]; node_options: string | null }
export interface LabApi {
  scratchCheckout(): Promise<LabScratch>
  read(file: string): Promise<LabReadResult>
  grep(pattern: string, opts?: LabGrepOptions): Promise<LabGrepResult>
  mutate(file: string, find: string, replace: string): Promise<LabMutateResult>
  runSuite(paths?: string[]): Promise<LabSuiteResult>
}

export const LAB_PARAMS = {
  type: 'object',
  additionalProperties: true,
  properties: {
    program: {
      description: 'A seat-authored program using scratchCheckout, read, grep, mutate and runSuite against a clone of the committed HEAD. runSuite is the declared host authority carve-out: its suite child runs with host authority after mutate().',
    },
  },
}

function refusalError(refused: string, message = ''): any {
  const error: any = new Error(message || refused)
  error.labRefusal = refused
  return error
}

function isRefusal(value: any): boolean {
  return typeof value === 'string' && LAB_REFUSALS.includes(value)
}

function errorRefusal(error: any, fallback = 'child-failed'): string {
  if (isRefusal(error?.labRefusal)) return error.labRefusal
  return fallback
}

export function containsScratch(scratchReal: string, candidateReal: string): boolean {
  if (String(candidateReal).split('/').includes('..')) return false
  return candidateReal === scratchReal || candidateReal.startsWith(`${scratchReal}/`)
}

export function validateScratchPath(scratchReal: string, raw: any, deps: any = {}): any {
  if (typeof raw !== 'string' || !raw.length) return { refused: 'op-args-invalid' }
  if (raw.startsWith('-')) return { refused: 'path-option-shaped' }
  if (LAB_PATH_FORBIDDEN.test(raw)) return { refused: 'path-not-relative' }
  if (!LAB_PATH_RE.test(raw)) return { refused: 'path-not-relative' }
  for (const segment of raw.split('/')) {
    if (segment === '.' || segment === '..') return { refused: 'path-traversal' }
  }
  // ONLY resolution ABSENCE becomes file-missing. An unqualified catch would
  // launder an injected realpath bug, EACCES or another unexpected exception
  // into a plausible missing-file refusal, so everything else RETHROWS.
  const realpath = deps.realpath || realpathSync
  let resolved
  try { resolved = realpath(join(scratchReal, raw)) }
  catch (err: any) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR' || err?.code === 'ELOOP') return { refused: 'file-missing' }
    throw err
  }
  if (!containsScratch(scratchReal, resolved)) return { refused: 'path-escapes-scratch' }
  return { path: resolved }
}

export function allowReadPaths(target: string, deps: any = {}): string[] {
  const real = deps.realpath || realpathSync
  const raw = String(target)
  let resolved = raw
  try { resolved = real(raw) } catch { /* a path that does not resolve is still granted as given */ }
  return [...new Set([raw, resolved])]
}

// One REPEATED flag per path (ground truth 14). No value ends in `*` — the
// value is a PREFIX, so `<dir>*` would leak into `<dir>extra`.
export function labChildArgs({ runnerPath, allowRead }: any): string[] {
  const args = [LAB_PERMISSION_FLAG]
  for (const one of allowRead || []) args.push(`--allow-fs-read=${one}`)
  args.push('--no-warnings')
  args.push(runnerPath)
  return args
}

export function classifyDenial(err: any): any {
  if (!err) return null
  if (err.code === 'ERR_DLOPEN_DISABLED') return { code: 'ERR_DLOPEN_DISABLED', permission: 'NativeAddon', resource: null }
  if (err.code === 'ERR_ACCESS_DENIED') return { code: 'ERR_ACCESS_DENIED', permission: err.permission || null, resource: err.resource || null }
  if (/fetch failed/i.test(String(err.message || ''))) return { code: 'ERR_ACCESS_DENIED', permission: 'Net', resource: null }
  return null
}

// Conservative bounded liveness polling — NOT a death detector. Only ESRCH
// proves absence: EPERM means the pid exists and is not ours to signal, and an
// unreaped zombie keeps signal zero positive forever.
export function livenessProbe(pid: number, deps: any = {}): string {
  const kill = deps.kill || ((one: number, signal: any) => process.kill(one, signal))
  try { kill(pid, 0); return 'alive' }
  catch (err: any) {
    if (err?.code === 'ESRCH') return 'gone'
    if (err?.code === 'EPERM') return 'alive'
    return 'unknown'
  }
}

// The child's startup audit, exported PURE so tests can drive every branch.
export function auditGrants(deps: any = {}): any {
  const has = typeof deps.has === 'function' ? deps.has : () => false
  const execArgv = deps.execArgv || []
  const nodeOptions = deps.nodeOptions || ''
  const audit: any = { runner: false, program: false, granted: [], execargv: [], node_options: nodeOptions || null }
  const probe = (key: string, path?: string): boolean => {
    try { return Boolean(has(key, path)) } catch { return false }
  }
  audit.runner = probe('fs.read', deps.runnerRaw) && probe('fs.read', deps.runnerReal)
  audit.program = probe('fs.read', deps.programRaw) && probe('fs.read', deps.programReal)
  for (const key of LAB_AUDIT_UNGRANTED) {
    if (key === 'fs.write') {
      for (const probePath of LAB_AUDIT_WRITE_PROBES) if (probe('fs.write', probePath)) audit.granted.push(`fs.write:${probePath}`)
    } else if (probe(key)) audit.granted.push(key)
  }
  for (const arg of execArgv) {
    for (const forbidden of LAB_AUDIT_FORBIDDEN_ARGV) if (String(arg).startsWith(forbidden)) audit.execargv.push(String(arg))
  }
  audit.ok = audit.runner && audit.program && !audit.granted.length && !audit.execargv.length && !nodeOptions
  return audit
}

// ONE bounded collector, used by the program child AND by every suite child.
// Raw BYTES are counted before decoding, stderr counts as well as stdout, and
// stdout/stderr have independent decoders and residuals. Only stdout is parsed
// as JSONL; stderr is bounded diagnostics and never spliced into RPC residual.
export function createStreamCollector({ capBytes, residualCapBytes, frameQueueMax, onLine, onOverflow }: any) {
  const channels: any = {
    stdout: { decoder: new StringDecoder('utf8'), residual: '', parse: true },
    stderr: { decoder: new StringDecoder('utf8'), residual: '', parse: false },
  }
  let bytes = 0
  let queued = 0
  let overflowed = false
  let overflowNotified = false
  const blow = (kind: string) => {
    if (overflowNotified) return
    overflowNotified = true
    overflowed = true
    for (const channel of Object.values(channels) as any[]) channel.residual = ''
    queued = 0
    onOverflow(kind)
  }
  return {
    bytesSeen: () => bytes,
    queuedFrames: () => queued,
    isOverflowed: () => overflowed,
    served: () => { if (queued > 0) queued -= 1 },
    push(chunk: any, kind: string) {
      if (overflowed) return
      const channel = channels[kind]
      if (!channel) return
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
      bytes += buf.length
      if (bytes > capBytes) { blow(kind); return }
      channel.residual += channel.decoder.write(buf)
      if (Buffer.byteLength(channel.residual) > residualCapBytes) { blow(kind); return }
      let index = channel.residual.indexOf('\n')
      while (index >= 0) {
        const line = channel.residual.slice(0, index)
        channel.residual = channel.residual.slice(index + 1)
        if (channel.parse) {
          queued += 1
          if (queued > frameQueueMax) { blow(kind); return }
        }
        onLine(line, kind)
        index = channel.residual.indexOf('\n')
      }
    },
    end(kind: string) {
      if (overflowed) return
      const channel = channels[kind]
      if (!channel) return
      channel.residual += channel.decoder.end()
      if (Buffer.byteLength(channel.residual) > residualCapBytes) { blow(kind); return }
      if (channel.residual.trim()) {
        if (channel.parse) {
          queued += 1
          if (queued > frameQueueMax) { blow(kind); return }
        }
        onLine(channel.residual, kind)
      }
      channel.residual = ''
    },
  }
}

export function journalPathFrom(taskDir: string): string {
  return join(dirname(String(taskDir)), 'journal.jsonl')
}

export function labRow({ at, role, spawnId, program, outcome, output, hostAuthority, scratchRetained }: any): any {
  return { at, lab_run: { spawn_id: spawnId, outcome, program, output, host_authority: hostAuthority, scratch_retained: scratchRetained ?? null }, role }
}

export function boundLabText(text: string, cap?: number): string {
  const value = String(text ?? '')
  const limit = cap ?? LAB_OUTPUT_CAP_BYTES
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= limit) return value
  return new StringDecoder('utf8').write(bytes.subarray(0, Math.max(0, limit)))
}

function boundedTextInfo(text: any, cap = LAB_OUTPUT_CAP_BYTES, lineCap = LAB_OUTPUT_CAP_LINES): any {
  const value = String(text ?? '')
  const byteTruncated = Buffer.byteLength(value, 'utf8') > cap
  const byteText = boundLabText(value, cap)
  const lines = byteText.split('\n')
  const lineTruncated = lines.length > lineCap
  const finalText = lineTruncated ? lines.slice(0, lineCap).join('\n') : byteText
  return { text: finalText, truncated: byteTruncated || lineTruncated }
}

export function parseTapSummary(text: string): any {
  let pass: number | null = null
  let fail: number | null = null
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const passMatch = line.match(/^# pass (\d+)$/)
    const failMatch = line.match(/^# fail (\d+)$/)
    if (passMatch) pass = Number(passMatch[1])
    if (failMatch) fail = Number(failMatch[1])
  }
  return { pass, fail }
}

function stripAnsi(text: string): string {
  const esc = String.fromCharCode(27)
  return String(text ?? '').replace(new RegExp(`${esc}\\[[0-9;]*[A-Za-z]`, 'g'), '')
}

function safeJson(value: any): string {
  try { return JSON.stringify(value) } catch { return '' }
}

function safeString(value: any, cap = 4096): string {
  return boundLabText(String(value?.message || value || ''), cap)
}

// The runner is deliberately self-contained. It imports only built-ins and
// does its startup audit before importing the seat-authored program.
export function runnerSource(programUrl: string): string {
  return `import { realpathSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'

const programUrl = ${JSON.stringify(programUrl)}
const runnerRaw = fileURLToPath(import.meta.url)
const programRaw = fileURLToPath(programUrl)
const resolveReal = (value) => { try { return realpathSync(value) } catch { return value } }
const runnerReal = resolveReal(runnerRaw)
const programReal = resolveReal(programRaw)
const ungranted = ${JSON.stringify(LAB_AUDIT_UNGRANTED)}
const writeProbes = ${JSON.stringify(LAB_AUDIT_WRITE_PROBES)}
const forbiddenArgv = ${JSON.stringify(LAB_AUDIT_FORBIDDEN_ARGV)}
const has = (key, path) => { try { return Boolean(process.permission.has(key, path)) } catch { return false } }
const auditGrants = () => {
  const audit = { runner: has('fs.read', runnerRaw) && has('fs.read', runnerReal), program: has('fs.read', programRaw) && has('fs.read', programReal), granted: [], execargv: [], node_options: process.env.NODE_OPTIONS || null }
  for (const key of ungranted) {
    if (key === 'fs.write') {
      for (const probe of writeProbes) if (has('fs.write', probe)) audit.granted.push('fs.write:' + probe)
    } else if (has(key)) audit.granted.push(key)
  }
  for (const arg of process.execArgv || []) for (const forbidden of forbiddenArgv) if (String(arg).startsWith(forbidden)) audit.execargv.push(String(arg))
  audit.ok = audit.runner && audit.program && !audit.granted.length && !audit.execargv.length && !audit.node_options
  return audit
}
const classifyDenial = (err) => {
  if (!err) return null
  if (err.code === 'ERR_DLOPEN_DISABLED') return { code: 'ERR_DLOPEN_DISABLED', permission: 'NativeAddon', resource: null }
  if (err.code === 'ERR_ACCESS_DENIED') return { code: 'ERR_ACCESS_DENIED', permission: err.permission || null, resource: err.resource || null }
  if (/fetch failed/i.test(String(err.message || ''))) return { code: 'ERR_ACCESS_DENIED', permission: 'Net', resource: null }
  return null
}
const shortError = (err) => String(err && (err.stack || err.message) || err || '').slice(0, 4096)
let terminal = false
const emit = (frame) => {
  if (terminal) return
  terminal = true
  try { process.stdout.write(JSON.stringify(frame) + '\\n') } catch { /* stdout may already be closed */ }
  process.exitCode = 0
  try { process.stdin.destroy() } catch { /* no stdin to destroy */ }
}
const report = (err) => {
  const denial = classifyDenial(err)
  const message = shortError(err) + (denial && denial.permission === 'Net' ? ' (requires --allow-net)' : '')
  emit({ done: true, refused: denial ? 'child-denied' : 'child-failed', ...(denial ? { denial } : {}), error: message })
}
process.on('uncaughtException', report)
process.on('unhandledRejection', report)

const decoder = new StringDecoder('utf8')
let residual = ''
let nextId = 1
const pending = new Map()
const rpc = (op, args) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  try { process.stdout.write(JSON.stringify({ id, op, args }) + '\\n') }
  catch (err) { pending.delete(id); reject(err) }
})
const handleLine = (line) => {
  let frame
  try { frame = JSON.parse(line) } catch { return }
  if (!frame || frame.done) return
  const slot = pending.get(frame.id)
  if (!slot) return
  pending.delete(frame.id)
  if (frame.ok) slot.resolve(frame.value)
  else {
    const error = new Error(frame.message || frame.refused || 'lab operation refused')
    error.labRefusal = frame.refused
    slot.reject(error)
  }
}
process.stdin.on('data', (chunk) => {
  residual += decoder.write(chunk)
  let index = residual.indexOf('\\n')
  while (index >= 0) {
    handleLine(residual.slice(0, index))
    residual = residual.slice(index + 1)
    index = residual.indexOf('\\n')
  }
})
process.stdin.on('end', () => {
  residual += decoder.end()
  if (residual.trim()) handleLine(residual)
})

const main = async () => {
  const audit = auditGrants()
  if (!audit.ok) { emit({ done: true, refused: 'child-denied', audit }); return }
  const lab = {}
  for (const name of ['scratchCheckout', 'read', 'grep', 'mutate', 'runSuite']) lab[name] = (...args) => rpc(name, args)
  globalThis.lab = Object.freeze(lab)
  try {
    const imported = await import(programUrl)
    emit({ done: true, result: imported.default === undefined ? null : imported.default })
  } catch (err) { report(err) }
}
main().catch(report)
`
}

export function toolResultPatch(event: any): any {
  if (!event || event.toolName !== LAB_TOOL_NAME) return undefined
  if (!event.details || !event.details.refused) return undefined
  return { isError: true }
}

export function createLabTool(deps: any = {}) {
  const env = deps.env || process.env
  const spawn = deps.spawn || nodeSpawn
  const spawnSync = deps.spawnSync || nodeSpawnSync
  const readFile = deps.readFile || readFileSync
  const writeFile = deps.writeFile || writeFileSync
  const appendFile = deps.appendFile || appendFileSync
  const mkTempDir = deps.mkTempDir || (() => mkdtempSync(join(realpathSync(tmpdir()), 'crew-pi-lab-')))
  const removeDir = deps.removeDir || ((dir: string) => rmSync(dir, { recursive: true, force: true }))
  const realpath = deps.realpath || realpathSync
  const isDirectory = deps.isDirectory || ((path: string) => {
    try { return statSync(path).isDirectory() } catch { return false }
  })
  const now = deps.now || (() => new Date().toISOString())
  const randomId = deps.randomId || (() => Math.random().toString(36).slice(2, 10))
  const setTimer = deps.setTimeout || setTimeout
  const clearTimer = deps.clearTimeout || clearTimeout
  const kill = deps.kill || ((pid: number, signal: any) => process.kill(pid, signal))
  const execPath = deps.execPath || process.execPath
  const childTimeoutMs = deps.childTimeoutMs ?? LAB_CHILD_TIMEOUT_MS
  const killGraceMs = deps.killGraceMs ?? 2000
  const opTimeoutMs = deps.opTimeoutMs ?? LAB_OP_TIMEOUT_MS
  const opMaxBuffer = deps.opMaxBuffer ?? LAB_OP_MAXBUFFER
  const suiteTimeoutMs = deps.suiteTimeoutMs ?? LAB_SUITE_TIMEOUT_MS
  const reapPollMs = deps.reapPollMs ?? LAB_REAP_POLL_MS
  const reapPollsMax = deps.reapPollsMax ?? LAB_REAP_POLLS_MAX
  const stdioGraceMs = deps.stdioGraceMs ?? LAB_STDIO_GRACE_MS
  const streamCapBytes = deps.streamCapBytes ?? LAB_STREAM_CAP_BYTES
  const residualCapBytes = deps.residualCapBytes ?? LAB_RESIDUAL_CAP_BYTES
  const frameQueueMax = deps.frameQueueMax ?? LAB_FRAME_QUEUE_MAX
  const role = String(env.CREW_ROLE || 'unknown')
  const taskDir = String(env.CREW_TASK_DIR || '')
  let currentRepoRoot = ''

  const boundedError = (error: any) => safeString(error, 4096)
  const syncGit = (args: string[], cwd: string): any => {
    const run = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: opTimeoutMs, maxBuffer: opMaxBuffer })
    if (run?.error?.code === 'ETIMEDOUT') throw refusalError('op-timeout', 'git operation timed out')
    if (run?.error?.code === 'ENOBUFS') throw refusalError('op-oversize', 'git operation exceeded its output bound')
    return run
  }
  const optionalGitValue = (args: string[], cwd: string): string | null => {
    const run = syncGit(args, cwd)
    if (run?.status !== 0) return null
    const value = String(run.stdout || '').trim()
    return value || null
  }
  const requiredGitValue = (args: string[], cwd: string): string => {
    const value = optionalGitValue(args, cwd)
    if (!value) throw refusalError('scratch-failed', 'git did not return the required value')
    return value
  }
  const requireGit = (args: string[], cwd: string, refusal = 'scratch-failed'): any => {
    const run = syncGit(args, cwd)
    if (run?.status !== 0) throw refusalError(refusal, 'git operation failed')
    return run
  }

  const mirrorOriginUrl = (scratch: string, repoRoot: string, localDeps: any) => {
    const source = optionalGitValue(['config', '--get', 'remote.origin.url'], repoRoot)
    if (source) requireGit(['config', 'remote.origin.url', source], scratch)
    else {
      const run = syncGit(['config', '--unset-all', 'remote.origin.url'], scratch)
      if (run?.error?.code && run.error.code !== 'ENOENT') throw run.error
    }
    return source
  }
  const mirrorOriginHead = (scratch: string, repoRoot: string, localDeps: any) => {
    const source = optionalGitValue(['symbolic-ref', LAB_ORIGIN_HEAD_REF], repoRoot)
    if (source) requireGit(['symbolic-ref', LAB_ORIGIN_HEAD_REF, source], scratch)
    else {
      const run = syncGit(['symbolic-ref', '--delete', LAB_ORIGIN_HEAD_REF], scratch)
      if (run?.error?.code && run.error.code !== 'ENOENT') throw run.error
    }
    return source
  }
  const detachAt = (scratch: string, sourceHeadSha: string, localDeps: any) => {
    requireGit(['checkout', '--detach', sourceHeadSha], scratch)
  }

  let scratchPromise: Promise<LabScratch> | null = null
  let scratchRoot: string | null = null
  let scratchParent: string | null = null
  let scratchRetained: string | null = null
  let suiteControl: any = null

  const makeScratch = async (): Promise<LabScratch> => {
    const repoRoot = currentRepoRoot
    let root: string | null = null
    try {
      const sourceHeadSha = requiredGitValue(['rev-parse', 'HEAD'], repoRoot)
      root = String(mkTempDir())
      scratchParent = root
      const scratch = join(root, 'wt')
      scratchRoot = scratch
      requireGit(['clone', '-q', '--local', repoRoot, scratch], repoRoot)
      mirrorOriginUrl(scratch, repoRoot, deps)
      mirrorOriginHead(scratch, repoRoot, deps)
      detachAt(scratch, sourceHeadSha, deps)
      const resolvedScratch = String(realpath(scratch))
      const originUrl = optionalGitValue(['config', '--get', 'remote.origin.url'], resolvedScratch)
      const originHead = optionalGitValue(['symbolic-ref', LAB_ORIGIN_HEAD_REF], resolvedScratch)
      const head = requiredGitValue(['rev-parse', 'HEAD'], resolvedScratch)
      const attached = optionalGitValue(['symbolic-ref', '-q', 'HEAD'], resolvedScratch)
      return { path: resolvedScratch, head, detached: !attached, origin_url: originUrl, origin_head: originHead }
    } catch (error: any) {
      if (error?.labRefusal) throw error
      throw refusalError(error?.code === 'ETIMEDOUT' ? 'op-timeout' : error?.code === 'ENOBUFS' ? 'op-oversize' : 'scratch-failed', 'scratch checkout failed')
    }
  }
  const ensureScratch = () => (scratchPromise ??= makeScratch())

  const validateOptions = (opts: any): any => {
    if (opts === undefined) return {}
    if (!opts || typeof opts !== 'object' || Array.isArray(opts)) throw refusalError('op-args-invalid', 'grep options are invalid')
    for (const key of Object.keys(opts)) if (!LAB_GREP_OPTIONS.includes(key)) throw refusalError('op-args-invalid', 'grep options are invalid')
    if (opts.ignoreCase !== undefined && typeof opts.ignoreCase !== 'boolean') throw refusalError('op-args-invalid', 'grep options are invalid')
    if (opts.fixedString !== undefined && typeof opts.fixedString !== 'boolean') throw refusalError('op-args-invalid', 'grep options are invalid')
    if (opts.maxHits !== undefined && (!Number.isInteger(opts.maxHits) || opts.maxHits <= 0)) throw refusalError('op-args-invalid', 'grep options are invalid')
    if (opts.pathspec !== undefined && (!Array.isArray(opts.pathspec) || opts.pathspec.some((one: any) => typeof one !== 'string'))) throw refusalError('op-args-invalid', 'grep options are invalid')
    return opts
  }

  const runSuiteProcess = async (paths: string[], scratch: LabScratch): Promise<any> => {
    const args = ['--test', '--test-timeout=30000', '--test-reporter=tap', '--', ...paths]
    const childEnv = { ...env }
    delete childEnv.NODE_OPTIONS
    delete childEnv.FORCE_COLOR
    delete childEnv.CLICOLOR_FORCE
    childEnv.NO_COLOR = '1'
    let child: any
    try {
      child = spawn(execPath, args, {
        cwd: scratch.path,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv,
        detached: true,
      })
    } catch (error: any) {
      throw refusalError('suite-failed', 'the suite could not be spawned')
    }

    let suiteText = ''
    let suiteTextTruncated = false
    let overflow = false
    let pendingRefusal: string | null = null
    let parentClosed = false
    let parentCode: number | null = null
    let parentSignal: any = null
    let settled = false
    let killTimer: any = null
    let suiteTimer: any = null
    let pollTimer: any = null
    let graceTimer: any = null
    let polls = 0
    let pollStarted = false
    let terminationRequested = false
    let settleResult: any
    let resolveOwnership: any
    const ownership = new Promise((resolve) => { resolveOwnership = resolve })
    let collector: any
    const appendSuite = (line: any, kind: string) => {
      if (overflow) return
      const before = suiteText
      const bounded = boundedTextInfo(`${suiteText}${String(line ?? '')}\n`)
      suiteText = bounded.text
      suiteTextTruncated = suiteTextTruncated || bounded.truncated
      if (suiteText.length === before.length && String(line ?? '').length) suiteTextTruncated = true
      if (kind === 'stdout') collector?.served?.()
    }
    const onOverflow = () => {
      if (overflow) return
      overflow = true
      suiteText = ''
      suiteTextTruncated = true
      pendingRefusal = 'op-oversize'
      requestTerminate()
    }
    collector = createStreamCollector({
      capBytes: streamCapBytes,
      residualCapBytes,
      frameQueueMax,
      onLine: appendSuite,
      onOverflow,
    })

    const clear = (timer: any) => { if (timer !== null) clearTimer(timer) }
    const killGroup = (signal: any) => {
      const pid = Number(child?.pid || 0)
      if (!pid) return
      try { kill(-pid, signal) } catch { /* a group may already be gone */ }
    }
    const finish = (value: any) => {
      if (settled) return
      settled = true
      clear(suiteTimer); suiteTimer = null
      clear(killTimer); killTimer = null
      clear(pollTimer); pollTimer = null
      clear(graceTimer); graceTimer = null
      settleResult = value
      resolveOwnership(value)
    }
    const finishFromParent = () => {
      if (!parentClosed || settled) return
      if (pendingRefusal) { finish({ refused: pendingRefusal, output: '', truncated: suiteTextTruncated, retained: false }); return }
      if (parentSignal || parentCode === null) { finish({ refused: 'suite-failed', output: suiteText, truncated: suiteTextTruncated }); return }
      const stripped = stripAnsi(suiteText)
      const summary = parseTapSummary(stripped)
      if (summary.pass === null || summary.fail === null) { finish({ refused: 'suite-failed', message: 'the suite produced no parseable TAP summary', output: suiteText, truncated: suiteTextTruncated }); return }
      finish({ result: { paths, pass: summary.pass, fail: summary.fail, exit_code: parentCode, host_authority: true, truncated: suiteTextTruncated }, output: suiteText, truncated: suiteTextTruncated })
    }
    const probeGroup = () => {
      if (settled) return
      const pid = Number(child?.pid || 0)
      const state = pid ? livenessProbe(-pid, { kill }) : 'gone'
      polls += 1
      if (state === 'gone') {
        clear(killTimer); killTimer = null
        if (parentClosed) finishFromParent()
        else {
          graceTimer = setTimer(() => {
            graceTimer = null
            if (!parentClosed && !settled) finish({ refused: pendingRefusal || 'suite-failed', output: '', truncated: suiteTextTruncated, retained: false })
            else finishFromParent()
          }, stdioGraceMs)
          graceTimer?.unref?.()
        }
        return
      }
      if (polls >= reapPollsMax) {
        finish({ refused: pendingRefusal || 'suite-failed', output: '', truncated: suiteTextTruncated, retained: true })
        return
      }
      pollTimer = setTimer(() => { pollTimer = null; probeGroup() }, reapPollMs)
      pollTimer?.unref?.()
    }
    const startPoll = () => {
      if (pollStarted || settled) return
      pollStarted = true
      probeGroup()
    }
    function requestTerminate() {
      if (terminationRequested) return
      terminationRequested = true
      if (pendingRefusal === null) pendingRefusal = overflow ? 'op-oversize' : 'suite-failed'
      killGroup('SIGTERM')
      if (killTimer === null) {
        killTimer = setTimer(() => {
          killTimer = null
          killGroup('SIGKILL')
          startPoll()
        }, killGraceMs)
        killTimer?.unref?.()
      }
    }
    const onClose = (code: number, signal: any) => {
      if (parentClosed) return
      parentClosed = true
      parentCode = code
      parentSignal = signal
      clear(suiteTimer); suiteTimer = null
      collector.end('stdout')
      collector.end('stderr')
      if (pollStarted) {
        if (livenessProbe(-Number(child?.pid || 0), { kill }) === 'gone') finishFromParent()
        else if (pollTimer === null && !settled) probeGroup()
      } else {
        probeGroup()
      }
    }
    child.stdout?.on?.('data', (chunk: any) => collector.push(chunk, 'stdout'))
    child.stderr?.on?.('data', (chunk: any) => collector.push(chunk, 'stderr'))
    child.on?.('close', onClose)
    child.on?.('error', () => { if (!parentClosed) pendingRefusal = pendingRefusal || 'suite-failed' })
    suiteTimer = setTimer(() => { suiteTimer = null; pendingRefusal = pendingRefusal || 'suite-failed'; requestTerminate() }, suiteTimeoutMs)
    suiteTimer?.unref?.()
    suiteControl = { terminate: requestTerminate, ownership }

    const answer = await ownership
    if (suiteControl?.ownership === ownership) suiteControl = null
    if (answer.retained) scratchRetained = scratch.path
    if (answer.refused) throw refusalError(answer.refused, answer.message || answer.refused)
    return answer.result
  }

  return {
    name: LAB_TOOL_NAME,
    label: 'Lab',
    description: 'Run a seat-authored PROGRAM in a node --permission child against a clone of the committed HEAD. The five lab.* operations are scratchCheckout, read, grep, mutate and runSuite; runSuite is the declared host authority carve-out and its suite child runs with host authority.',
    parameters: LAB_PARAMS,
    executionMode: 'sequential',
    async execute(_toolCallId: string, params: any, signal: any, _onUpdate: any, ctx: any) {
      const spawnId = randomId()
      scratchPromise = null
      scratchRoot = null
      scratchParent = null
      scratchRetained = null
      suiteControl = null
      const cwd = typeof ctx?.cwd === 'string' ? ctx.cwd : ''
      const program = params?.program
      const ops: any[] = []
      let hostAuthority = false
      let outcome = 'refused'
      let refused: string | null = null
      let denial: any = null
      let audit: any = null
      let resultValue: any = null
      let childOutput = ''
      let childOutputTruncated = false
      let errorText = ''
      let dir: string | null = null
      let programPath = ''
      let runnerPath = ''
      currentRepoRoot = cwd

      const finish = () => {
        const details: any = {
          spawn_id: spawnId,
          outcome,
          ops: [...ops],
          host_authority: hostAuthority,
          scratch_retained: scratchRetained,
        }
        if (outcome === 'ok') details.result = resultValue
        else {
          details.refused = refused
          if (denial) details.denial = denial
          if (audit) details.audit = audit
          if (errorText) details.error = boundLabText(errorText, 4096)
        }
        const text = outcome === 'ok'
          ? boundLabText(resultValue === undefined ? 'null' : safeJson(resultValue) || 'null')
          : `refused: ${refused || 'child-failed'}`
        return { content: [{ type: 'text', text }], details }
      }
      const refuseEarly = (code: string) => {
        refused = code
        outcome = 'refused'
        return finish()
      }

      if (!cwd.startsWith('/') || !isDirectory(cwd)) return refuseEarly('cwd-invalid')
      if (typeof program !== 'string' || !program.length) return refuseEarly('program-invalid')
      if (Buffer.byteLength(program, 'utf8') > LAB_PROGRAM_CAP_BYTES) return refuseEarly('program-oversize')

      const childEnv = { ...env }
      delete childEnv.NODE_OPTIONS
      delete childEnv.FORCE_COLOR
      delete childEnv.CLICOLOR_FORCE
      childEnv.NO_COLOR = '1'

      const appendChildOutput = (text: any) => {
        if (childOutputTruncated) return
        const bounded = boundedTextInfo(`${childOutput}${String(text ?? '')}`)
        childOutput = bounded.text
        childOutputTruncated = bounded.truncated
      }

      const executeOps = async (frame: any, isAccepting = () => true): Promise<any> => {
        if (!isAccepting()) throw refusalError('child-failed', 'the child is terminating')
        if (!frame || typeof frame.op !== 'string') throw refusalError('op-args-invalid', 'operation arguments are invalid')
        const op = frame.op
        ops.push(op)
        if (!LAB_API.includes(op)) throw refusalError('unknown-op', 'unknown lab operation')
        const args = Array.isArray(frame.args) ? frame.args : null
        if (!args) throw refusalError('op-args-invalid', 'operation arguments are invalid')
        if (op === 'scratchCheckout') {
          if (args.length) throw refusalError('op-args-invalid', 'scratchCheckout takes no arguments')
          return ensureScratch()
        }
        if (!scratchPromise) throw refusalError('no-scratch', 'scratchCheckout must run first')
        const scratch = await ensureScratch()
        if (!isAccepting()) throw refusalError('child-failed', 'the child is terminating')
        if (op === 'read') {
          if (args.length !== 1) throw refusalError('op-args-invalid', 'read takes one path')
          const raw = args[0]
          const checked = validateScratchPath(scratch.path, raw, { realpath })
          if (checked.refused) throw refusalError(checked.refused, checked.refused)
          let text
          try { text = String(readFile(checked.path, 'utf8')) }
          catch (error: any) { if (error?.code === 'ENOENT') throw refusalError('file-missing', 'file is missing'); throw error }
          const bounded = boundedTextInfo(text)
          return { file: raw, text: bounded.text, truncated: bounded.truncated }
        }
        if (op === 'grep') {
          if (args.length < 1 || args.length > 2 || typeof args[0] !== 'string' || !args[0].length) throw refusalError('op-args-invalid', 'grep arguments are invalid')
          const opts = validateOptions(args[1])
          const pathspec: string[] = []
          for (const raw of opts.pathspec || []) {
            const checked = validateScratchPath(scratch.path, raw, { realpath })
            if (checked.refused) throw refusalError(checked.refused, checked.refused)
            pathspec.push(raw)
          }
          const grepArgs = ['grep', '-n']
          if (opts.ignoreCase) grepArgs.push('-i')
          if (opts.fixedString) grepArgs.push('-F')
          grepArgs.push('-e', args[0], '--', ...pathspec)
          const run = syncGit(grepArgs, scratch.path)
          if (run?.status !== 0 && run?.status !== 1) throw refusalError('child-failed', 'git grep failed')
          const maxHits = Math.min(opts.maxHits || LAB_GREP_HITS_MAX, LAB_GREP_HITS_MAX)
          const lines = String(run.stdout || '').split(/\r?\n/).filter((line: string) => line.length)
          const hits: LabGrepHit[] = []
          for (const line of lines) {
            const match = line.match(/^(.*?):(\d+):(.*)$/)
            if (!match) continue
            if (hits.length >= maxHits) continue
            hits.push({ file: match[1], line: Number(match[2]), text: match[3] })
          }
          return { pattern: args[0], hits, truncated: lines.length > maxHits }
        }
        if (op === 'mutate') {
          if (args.length !== 3 || typeof args[0] !== 'string' || typeof args[1] !== 'string' || typeof args[2] !== 'string') throw refusalError('op-args-invalid', 'mutate arguments are invalid')
          const raw = args[0]
          const find = args[1]
          const replace = args[2]
          if (!find.length) throw refusalError('op-args-invalid', 'mutate find is empty')
          if (find === replace) throw refusalError('find-equals-replace', 'mutate find equals replace')
          const checked = validateScratchPath(scratch.path, raw, { realpath })
          if (checked.refused) throw refusalError(checked.refused, checked.refused)
          const before = String(readFile(checked.path, 'utf8'))
          if (!before.includes(find)) throw refusalError('find-absent', 'mutate find is absent')
          const count = before.split(find).length - 1
          writeFile(checked.path, before.split(find).join(replace))
          return { file: raw, count }
        }
        if (op === 'runSuite') {
          hostAuthority = true
          if (args.length > 1) throw refusalError('op-args-invalid', 'runSuite takes an optional path array')
          let paths: string[] = []
          if (args.length === 1) {
            if (!Array.isArray(args[0]) || args[0].length > LAB_SUITE_PATHS_MAX) throw refusalError('op-args-invalid', 'runSuite paths are invalid')
            paths = []
            for (const raw of args[0]) {
              const checked = validateScratchPath(scratch.path, raw, { realpath })
              if (checked.refused) throw refusalError(checked.refused, checked.refused)
              paths.push(raw)
            }
          }
          return runSuiteProcess(paths, scratch)
        }
        throw refusalError('unknown-op', 'unknown lab operation')
      }

      const runProgramChild = async (): Promise<any> => new Promise((resolve) => {
        let child: any
        try {
          const childReadPaths = allowReadPaths(dir as string, { realpath })
          // Node's macOS permission bootstrap resolves a raw /var entry path
          // before user code; the helper keeps its declared order, while the
          // launcher puts the realpath half first for that platform seam.
          child = spawn(execPath, labChildArgs({ runnerPath, allowRead: [...childReadPaths].reverse() }), {
            cwd: dir,
            shell: false,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: childEnv,
          })
        } catch (error: any) {
          resolve({ reason: 'child-failed', code: null, signal: null, terminal: null, output: '', truncated: false, error: 'the child could not be spawned' })
          return
        }
        let collector: any
        let opChain: Promise<any> = Promise.resolve()
        let acceptingOps = true
        let terminal: any = null
        let closed = false
        let settled = false
        let pendingReason: string | null = null
        let terminationRequested = false
        let timedOut = false
        let abortHandler: any = null
        let deadline: any = null
        let killTimer: any = null
        let pollTimer: any = null
        let graceTimer: any = null
        let pollStarted = false
        let polls = 0
        let childError = ''
        let outputText = ''
        let outputTruncated = false
        const appendOutput = (line: any, kind: string) => {
          if (pendingReason === 'output-oversize') return
          const bounded = boundedTextInfo(`${outputText}${String(line ?? '')}\n`)
          outputText = bounded.text
          outputTruncated = outputTruncated || bounded.truncated
        }
        const send = (frame: any) => {
          if (!child?.stdin || child.stdin.destroyed) return
          try { child.stdin.write(JSON.stringify(frame) + '\n') } catch { /* the child is already closing */ }
        }
        const disarm = () => {
          try { child.stdout?.removeListener?.('data', stdoutHandler) } catch { /* no stream */ }
          try { child.stderr?.removeListener?.('data', stderrHandler) } catch { /* no stream */ }
          try { child.stdin?.destroy?.() } catch { /* no stream */ }
          try { child.stdout?.destroy?.() } catch { /* no stream */ }
          try { child.stderr?.destroy?.() } catch { /* no stream */ }
          try { child.unref?.() } catch { /* no child */ }
        }
        const clear = (timer: any) => { if (timer !== null) clearTimer(timer) }
        const finalize = (reason: string, code: any, signalValue: any) => {
          if (settled) return
          acceptingOps = false
          settled = true
          clear(deadline); deadline = null
          clear(killTimer); killTimer = null
          clear(pollTimer); pollTimer = null
          clear(graceTimer); graceTimer = null
          if (signal && abortHandler) signal.removeEventListener?.('abort', abortHandler)
          const synthetic = reason === 'child-failed' || reason === 'child-unreaped'
          if (synthetic) disarm()
          resolve({ reason, code, signal: signalValue, terminal, output: outputText, truncated: outputTruncated, bytes: collector?.bytesSeen?.() || 0, error: childError })
        }
        const settle = (reason: string, code: any = null, signalValue: any = null) => {
          acceptingOps = false
          if (settled) return
          const selected = (reason === 'child-failed' || reason === 'child-unreaped') ? reason : (pendingReason || reason)
          const finishLater = async () => {
            if (selected !== 'normal') {
              try { suiteControl?.terminate?.() } catch { /* suite ownership handles its own failure path */ }
            }
            try { await opChain } catch { /* served requests already became refusal frames */ }
            finalize(selected, code, signalValue)
          }
          void finishLater()
        }
        const startPoll = () => {
          if (pollStarted || settled) return
          pollStarted = true
          const poll = () => {
            if (settled) return
            const pid = Number(child?.pid || 0)
            const state = pid ? livenessProbe(pid, { kill }) : 'gone'
            polls += 1
            if (state === 'gone') {
              graceTimer = setTimer(() => {
                graceTimer = null
                if (!closed && !settled) settle('child-failed')
              }, stdioGraceMs)
              graceTimer?.unref?.()
              return
            }
            if (polls >= reapPollsMax) { settle('child-unreaped'); return }
            pollTimer = setTimer(() => { pollTimer = null; poll() }, reapPollMs)
            pollTimer?.unref?.()
          }
          poll()
        }
        const killChild = () => {
          acceptingOps = false
          try { child.kill('SIGTERM') } catch { /* child may already be gone */ }
          if (closed || killTimer !== null) return
          killTimer = setTimer(() => {
            killTimer = null
            if (closed) return
            try { child.kill('SIGKILL') } catch { /* child may already be gone */ }
            startPoll()
          }, killGraceMs)
          killTimer?.unref?.()
        }
        const requestTermination = (reason: string) => {
          acceptingOps = false
          if (terminationRequested) return
          terminationRequested = true
          const selected = reason === 'deadline' ? (timedOut ? 'child-timeout' : 'child-failed') : reason
          pendingReason = pendingReason || selected
          try { suiteControl?.terminate?.() } catch { /* suite ownership handles its own failure path */ }
          killChild()
        }
        const serve = async (frame: any): Promise<any> => {
          if (!acceptingOps) return { ok: false, refused: 'child-failed', message: 'the child is terminating' }
          try {
            const value = await executeOps(frame, () => acceptingOps)
            return { ok: true, value }
          } catch (error: any) {
            const code = errorRefusal(error)
            return { ok: false, refused: code, message: isRefusal(code) ? code : 'operation refused' }
          }
        }
        const onLine = (line: any, kind: string) => {
          appendOutput(line, kind)
          if (kind !== 'stdout') return
          let frame: any
          try { frame = JSON.parse(String(line).trim()) } catch { collector.served(); return }
          if (!frame || frame.done) {
            collector.served()
            if (frame?.done) {
              terminal = frame
              try { child.stdin?.end?.() } catch { /* the child is already closing */ }
            }
            return
          }
          opChain = opChain.then(() => serve(frame), () => serve(frame)).then((answer) => {
            send({ id: frame.id, ...answer })
          }).catch(() => {
            send({ id: frame.id, ok: false, refused: 'child-failed', message: 'operation failed' })
          }).finally(() => collector.served())
        }
        const onOverflow = () => {
          outputText = ''
          outputTruncated = true
          requestTermination('output-oversize')
        }
        collector = createStreamCollector({ capBytes: streamCapBytes, residualCapBytes, frameQueueMax, onLine, onOverflow })
        const stdoutHandler = (chunk: any) => collector.push(chunk, 'stdout')
        const stderrHandler = (chunk: any) => collector.push(chunk, 'stderr')
        child.stdout?.on?.('data', stdoutHandler)
        child.stderr?.on?.('data', stderrHandler)
        child.on?.('error', (error: any) => { childError = childError || 'the child failed'; if (error?.code === 'ERR_ACCESS_DENIED') childError = 'the child was denied' })
        child.on?.('close', (code: number, signalValue: any) => {
          if (closed) return
          closed = true
          clear(deadline); deadline = null
          clear(killTimer); killTimer = null
          collector.end('stdout')
          collector.end('stderr')
          if (pendingReason) settle(pendingReason, code, signalValue)
          else if (!terminal) settle(code === 0 ? 'child-failed' : 'child-failed', code, signalValue)
          else settle('normal', code, signalValue)
        })
        deadline = setTimer(() => {
          deadline = null
          timedOut = true
          requestTermination('deadline')
        }, childTimeoutMs)
        deadline?.unref?.()
        abortHandler = () => requestTermination('child-failed')
        if (signal) {
          if (signal.aborted) abortHandler()
          else signal.addEventListener?.('abort', abortHandler, { once: true })
        }
      })

      try {
        dir = String(mkTempDir())
        programPath = join(dir, 'program.mjs')
        runnerPath = join(dir, 'runner.mjs')
        writeFile(programPath, program, { mode: 0o600 })
        writeFile(runnerPath, runnerSource(pathToFileURL(programPath).href), { mode: 0o600 })
        const child = await runProgramChild()
        childOutput = child.output
        childOutputTruncated = child.truncated
        errorText = child.error || ''
        if (child.reason === 'output-oversize') refused = 'output-oversize'
        else if (child.terminal?.refused) {
          refused = isRefusal(child.terminal.refused) ? child.terminal.refused : 'child-failed'
          denial = child.terminal.denial || null
          audit = child.terminal.audit || null
          errorText = child.terminal.error || errorText
        } else if (child.reason === 'child-timeout') refused = 'child-timeout'
        else if (child.reason === 'child-unreaped') refused = 'child-unreaped'
        else if (child.reason === 'child-failed') refused = 'child-failed'
        else if (child.code !== 0 || child.error) refused = 'child-failed'
        else if (!child.terminal || !Object.hasOwn(child.terminal, 'result')) refused = 'child-failed'
        else {
          const rendered = safeJson(child.terminal.result) || 'null'
          const bounded = boundedTextInfo(rendered)
          if (bounded.truncated) refused = 'output-oversize'
          else {
            outcome = 'ok'
            resultValue = child.terminal.result
          }
        }
      } catch (error: any) {
        refused = errorRefusal(error, 'scratch-failed')
        errorText = error?.labRefusal ? '' : boundedError(error)
      } finally {
        outcome = refused ? 'refused' : outcome
        if (!scratchRetained && scratchRoot) {
          try { removeDir(scratchRoot) } catch { /* cleanup is best effort */ }
        }
        if (!scratchRetained && scratchParent) {
          try { removeDir(scratchParent) } catch { /* cleanup is best effort */ }
        }
        try { if (dir) removeDir(dir) } catch { /* cleanup is best effort */ }
        try {
          if (taskDir) {
            const rowOutcome = outcome === 'ok' ? 'ok' : 'refused'
            const output = boundLabText(childOutput)
            appendFile(journalPathFrom(taskDir), `${JSON.stringify(labRow({ at: now(), role, spawnId, outcome: rowOutcome, program: boundLabText(program), output, hostAuthority, scratchRetained }))}\n`)
          }
        } catch { /* journal failure never changes the tool verdict */ }
      }
      return finish()
    },
  }
}

export default function labExtension(pi: any) {
  pi.registerTool(createLabTool())
  pi.on('tool_result', (event: any) => toolResultPatch(event))
}
