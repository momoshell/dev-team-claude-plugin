// Shared helpers for the seat replays (replay-builder.mjs, replay-planner.mjs).
// Import-safe: no CLI, no model client and no crew module is loaded here.
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BENCH_DIR = dirname(fileURLToPath(import.meta.url))
export const CHECKOUT = resolve(BENCH_DIR, '..')
export const CORPUS_DIR = join(BENCH_DIR, 'corpus')

// The closed arm vocabulary: crew/protocols.mjs EXTENSIONS. Kept as a list so a
// prototype name such as "constructor" is never mistaken for an arm.
export const ARMS = Object.freeze(['readgate', 'lab', 'builderloop', 'reminders', 'skeletonread', 'subagent', 'fff'])

// Pre-parity planner returns lack the scope keys the arms read; give every arm the files the lane's merged PR touched.
export const SCOPE_BACKFILL = Object.freeze({
  b1380: ['crew/loop.mjs', 'crew/loop.test.mjs'],
  b1381: ['crew/lean.mjs', 'crew/start.test.mjs'],
})

export function validateArms(list) {
  if (!Array.isArray(list)) throw new Error('arms must be a list (an empty list is allowed)')
  for (const name of list) {
    if (typeof name !== 'string' || !ARMS.includes(name)) throw new Error(`unknown arm: ${typeof name === 'string' ? name : JSON.stringify(name)} (known: ${ARMS.join(', ')})`)
  }
  return list
}

// A cell names the seat: { agent, model, effort, advisor?: { agent, model, effort }, wait_s?, settle_s? }.
// The seat adapter refuses a combination it does not support; this only checks the shape.
export function validateCell(cell) {
  const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  const named = (c, what) => {
    if (!plain(c)) throw new Error(`${what} must be an object with agent, model and effort`)
    for (const key of ['agent', 'model', 'effort']) if (typeof c[key] !== 'string' || !c[key]) throw new Error(`${what}.${key} must be a nonempty string`)
  }
  named(cell, 'cell')
  if (cell.advisor != null) named(cell.advisor, 'cell.advisor')
  for (const key of ['wait_s', 'settle_s']) {
    if (cell[key] !== undefined && !(Number.isSafeInteger(cell[key]) && cell[key] >= (key === 'wait_s' ? 1 : 0))) throw new Error(`cell.${key} must be a ${key === 'wait_s' ? 'positive' : 'non-negative'} safe integer`)
  }
  return cell
}

export function seatDefinition({ role, cell, arms }) {
  return { role, agent: cell.agent, model: cell.model, effort: cell.effort, writes: role === 'builder' ? 'repo' : 'task-dir', wait_s: cell.wait_s ?? 3600, advisor: cell.advisor ?? null, extensions: [...arms] }
}

export function loadCorpus(lane, corpusDir = CORPUS_DIR) {
  if (typeof lane !== 'string' || !/^b\d+$/.test(lane)) throw new Error(`lane must look like b1380, got ${JSON.stringify(lane)}`)
  const dir = join(corpusDir, lane)
  if (!existsSync(join(dir, 'manifest.json'))) throw new Error(`no corpus for lane ${lane} in ${corpusDir}`)
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  for (const key of ['base', 'originalTask', 'originalTree']) if (typeof manifest[key] !== 'string' || !manifest[key]) throw new Error(`${lane}/manifest.json lacks ${key}`)
  return { dir, manifest }
}

export const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)

// The real path of `path`, resolving the deepest ancestor that exists. A dangling symlink counts as existing
// (lstat) and then fails realpath, so a link can never be mistaken for a free name.
export function realThrough(path) {
  const tail = []
  let at = resolve(path)
  for (;;) {
    try { lstatSync(at); break } catch (error) { if (error.code !== 'ENOENT') throw error }
    tail.unshift(basename(at))
    const up = dirname(at)
    if (up === at) break
    at = up
  }
  return join(realpathSync(at), ...tail)
}

// Refuse a write destination that is, or resolves into, the corpus, this checkout or ~/.crew.
export function assertOutsideProtected(path, what, { corpusDir = CORPUS_DIR, checkoutDir = CHECKOUT, home = homedir() } = {}) {
  const target = resolve(path)
  const real = realThrough(target)
  for (const [label, root] of [['the corpus', corpusDir], ['this checkout', checkoutDir], ['~/.crew', join(home, '.crew')]]) {
    if (inside(real, realThrough(root)) || inside(target, resolve(root))) throw new Error(`${what} ${target} is inside ${label}`)
  }
  return target
}

// Establish a new output directory. Refused: relative paths, existing paths, and anything
// inside the corpus, this checkout or ~/.crew (symlinks resolved).
export function createOutDir(out, { corpusDir = CORPUS_DIR, checkoutDir = CHECKOUT, home = homedir() } = {}) {
  if (typeof out !== 'string' || !isAbsolute(out)) throw new Error('--out must be an absolute path')
  const target = resolve(out)
  try { lstatSync(target); throw new Error(`output ${target} already exists`) } catch (error) { if (error.code !== 'ENOENT') throw error }
  assertOutsideProtected(target, 'output', { corpusDir, checkoutDir, home })
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'session.jsonl'), '')
  writeFileSync(join(target, 'diff.patch'), '')
  return target
}

export const rewriter = (manifest, task, tree) => (text) => text.replaceAll(manifest.originalTask, task).replaceAll(manifest.originalTree, tree)

export function git(args, opts = {}) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 << 20, ...opts })
  if (r.error) throw r.error
  return r
}

// Isolated detached worktree of `repo` at `base`; the caller registers the removal.
export function addWorktree({ repo, base, tree, onCleanup }) {
  const r = git(['-C', repo, 'worktree', 'add', '-q', '--detach', tree, base])
  if (r.status !== 0) throw new Error(`git worktree add ${base} failed: ${(r.stderr || '').trim()}`)
  onCleanup(() => {
    const rm = git(['-C', repo, 'worktree', 'remove', '--force', tree])
    if (rm.status !== 0) throw new Error(`git worktree remove failed: ${(rm.stderr || '').trim()}`)
    git(['-C', repo, 'worktree', 'prune'])
  })
}

// Common lane setup: task dir with a run-start journal row, plus the rewritten first prompt.
export function writeJournalStart(task, sleep) {
  mkdirSync(task, { recursive: true })
  writeFileSync(join(task, 'journal.jsonl'), `${JSON.stringify({ event: 'run-start', at: new Date().toISOString() })}\n`)
  sleep(50) // the arms read "a planner return written since run-start"
}

export const sleepMs = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

export function readJournal(task) {
  try {
    return readFileSync(join(task, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

export function rowKinds(journal) {
  const kinds = {}
  for (const r of journal) { const k = r.event ?? Object.keys(r).find((key) => key !== 'at' && key !== 'role') ?? '?'; kinds[k] = (kinds[k] ?? 0) + 1 }
  return kinds
}

export function advisorRows(journal) {
  return {
    notes: journal.filter((r) => r.advisor_note).map((r) => ({ claim: r.advisor_note.claim ?? null, evidence: r.advisor_note.evidence ?? null, severity: r.advisor_note.severity ?? null, tier: r.advisor_note.tier, outcome: r.advisor_note.outcome, kind: r.advisor_note.kind, target: r.advisor_note.target, trigger: r.advisor_note.trigger, codes: r.advisor_note.codes })),
    usage: journal.filter((r) => r.advisor_usage).map((r) => r.advisor_usage),
    consults: journal.filter((r) => r.advisor_consult).map((r) => ({ trigger: r.advisor_consult.trigger, window_bytes: r.advisor_consult.window_bytes ?? null, omitted: r.advisor_consult.omitted_files?.length ?? null })),
    blocked: journal.filter((r) => r.advisor_note?.trigger === 'pre-return' && r.advisor_note.outcome === 'injected' && r.advisor_note.severity === 'high').length,
  }
}

export function dirtyFiles(tree) {
  const r = git(['-C', tree, 'status', '--porcelain', '-uall'])
  return r.stdout.split('\n').filter(Boolean).map((l) => l.slice(3).split(' -> ').at(-1))
}

// Whole change against HEAD, staged or not, including files the seat added (intent-to-add first).
// A failing git command throws, so an empty diff is never published for a failed capture.
export function writeDiff(tree, file) {
  const run = (args) => {
    const r = git(['-C', tree, ...args])
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || '').trim()}`)
    return r.stdout
  }
  run(['add', '-N', '.'])
  const full = run(['diff', 'HEAD'])
  writeFileSync(file, full)
  return run(['diff', 'HEAD', '--stat']).trim().split('\n').at(-1) ?? ''
}

export const errText = (e) => `${e?.code ? `${e.code} ` : ''}${e?.message ?? e}`.trim() || 'unknown error'

// Shared run skeleton. `body(ctx)` validates its options first (the entry owns validateArms), does the work and returns the result row; any failure or
// cleanup error ends up in row.error. result.json is always written.
export async function runReplay({ kind, options, deps, body }) {
  const { lane, cell, arms, out } = options ?? {}
  const result = { id: null, kind, lane: lane ?? null, cell: cell ?? null, arms: Array.isArray(arms) ? arms : null, error: null }
  const cleanups = []
  const errors = []
  const outDir = createOutDir(out, { corpusDir: deps.corpusDir, home: deps.home }) // refuses unsafe destinations; nothing is written then
  result.id = basename(outDir)
  const step = async (name, fn) => { try { return await fn() } catch (e) { errors.push(`${name}: ${errText(e)}`); return undefined } }
  try {
    await step('setup', async () => {
      Object.assign(result, await body({ outDir, step, errors, onCleanup: (fn) => cleanups.push(fn), result }))
    })
  } finally {
    for (const fn of cleanups.reverse()) { try { fn() } catch (e) { errors.push(`cleanup: ${errText(e)}`) } }
    result.error = errors.length ? errors.join('; ') : null
    writeFileSync(join(outDir, 'result.json'), JSON.stringify(result, null, 2))
  }
  return result
}

// A crew check (runGate, proveMutations) returns an unmeasured result instead of throwing when it could not run.
// That is a harness failure, not a measured red: record it, with the diagnostics the check returned.
const diagText = (e) => (e == null ? null : typeof e === 'string' ? e : [e.code, e.message].filter(Boolean).join(' ') || JSON.stringify(e))
export function checkDiagnostics(r) {
  if (!r || typeof r !== 'object') return null
  const rowIssues = Array.isArray(r.rows) ? r.rows.filter((row) => row?.outcome === 'unmeasured').map((row) => `${row.check}:${row.reason ?? 'unmeasured'}${row.error ? ` ${diagText(row.error)}` : ''}`) : []
  return {
    status: r.status ?? null, reason: r.reason ?? null,
    error: diagText(r.error), diagnostic: r.diagnostic == null ? null : typeof r.diagnostic === 'string' ? r.diagnostic : JSON.stringify(r.diagnostic),
    preflight: r.preflight ? { status: r.preflight.status ?? null, reason: r.preflight.reason ?? null, error: diagText(r.preflight.error) } : null,
    unmeasuredRows: rowIssues.length ? rowIssues : null,
  }
}
export function unmeasuredError(name, r) {
  if (r == null || typeof r !== 'object') return `${name}: returned no result`
  if (r.status !== 'unmeasured') return null
  const d = checkDiagnostics(r)
  return `${name}: unmeasured ${d.reason ?? ''}${d.error ? ` (${d.error})` : ''}${d.unmeasuredRows ? ` [${d.unmeasuredRows.join('; ')}]` : ''}`.replace(/\s+/g, ' ').trim()
}

export function removeDir(dir) { rmSync(dir, { recursive: true, force: true }) }

export function parseCli(argv) {
  const opts = { arms: null }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = () => { if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`); return argv[++i] }
    if (flag === '--lane') opts.lane = value()
    else if (flag === '--cell') opts.cell = value()
    else if (flag === '--arms') { const raw = value(); opts.arms = raw === '' ? [] : raw.split(',') }
    else if (flag === '--out') opts.out = value()
    else throw new Error(`unknown argument ${flag}`)
  }
  for (const key of ['lane', 'cell', 'out']) if (!opts[key]) throw new Error(`--${key} is required`)
  if (opts.arms === null) throw new Error('--arms is required (use --arms "" for none)')
  return { lane: opts.lane, cellFile: opts.cell, arms: opts.arms, out: opts.out }
}

export function readCellFile(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch (e) { throw new Error(`cell file ${file}: ${e.message}`) }
}

// Default run preparation: a detached worktree at the lane's base under out/tree, a task dir
// under out/task, the rewritten first prompt, and (builder only) the recorded plan and gate.
export function prepareLane({ role, lane, outDir, onCleanup, deps = {} }) {
  const { dir, manifest } = loadCorpus(lane, deps.corpusDir)
  const task = join(outDir, 'task')
  const tree = join(outDir, 'tree')
  const rewrite = rewriter(manifest, task, tree)
  addWorktree({ repo: deps.repoDir ?? CHECKOUT, base: manifest.base, tree, onCleanup })
  writeJournalStart(task, deps.sleepMs ?? sleepMs)
  let planDetails = null
  if (role === 'builder') {
    for (const name of ['plan.md', 'gate.mjs', 'planner-1.json', 'lean.json']) writeFileSync(join(task, name), rewrite(readFileSync(join(dir, name), 'utf8')))
    const file = join(task, 'planner-1.json')
    const ret = JSON.parse(readFileSync(file, 'utf8'))
    ret.details ??= {}
    if (SCOPE_BACKFILL[lane]) {
      ret.details.files_in_scope ??= SCOPE_BACKFILL[lane]
      ret.details.validation_lane ??= `node --test ${SCOPE_BACKFILL[lane].filter((f) => f.endsWith('.test.mjs')).join(' ')}`
    }
    ret.details.gate_cmd ??= `node ${join(task, 'gate.mjs')}`
    writeFileSync(file, JSON.stringify(ret, null, 2))
    planDetails = ret.details
  }
  const prompt = rewrite(readFileSync(join(dir, `${role}-prompt.txt`), 'utf8'))
  const returnName = prompt.match(new RegExp(`${role}-\\d+\\.json`))?.[0]
  if (!returnName) throw new Error(`the ${role} prompt for ${lane} names no return file`)
  return { prompt, briefText: readFileSync(join(dir, 'brief.md'), 'utf8'), cwd: tree, taskDir: task, returnName, plan: planDetails }
}

export async function loadSeat(deps) {
  if (deps.runAcpSeat) return deps.runAcpSeat
  return (await import(new URL('../crew/acp/seat.mjs', import.meta.url).href)).runAcpSeat
}

export async function loadChecks(deps) {
  if (deps.runGate && deps.proveMutations) return { runGate: deps.runGate, proveMutations: deps.proveMutations }
  const mod = await import(new URL('../crew/checks.mjs', import.meta.url).href)
  return { runGate: deps.runGate ?? mod.runGate, proveMutations: deps.proveMutations ?? mod.proveMutations }
}

export function readEnvelope(task, returnName) {
  try { return JSON.parse(readFileSync(join(task, returnName), 'utf8')) } catch { return null }
}

// The seat's required return file. Returns { envelope, error }: a missing, unparseable or incomplete file is an error to record, never a clean run.
export function loadEnvelope(task, returnName) {
  const file = join(task, returnName)
  let text
  try { text = readFileSync(file, 'utf8') } catch (e) { return { envelope: null, error: `envelope: ${returnName} not written (${e.code ?? e.message})` } }
  let envelope
  try { envelope = JSON.parse(text) } catch (e) { return { envelope: null, error: `envelope: ${returnName} is not valid JSON (${e.message})` } }
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) return { envelope: null, error: `envelope: ${returnName} is not a JSON object` }
  if (typeof envelope.status !== 'string' || !envelope.status || typeof envelope.summary !== 'string' || !envelope.summary.trim()) return { envelope: null, error: `envelope: ${returnName} lacks a status and summary` }
  return { envelope, error: null }
}

// Run the seat, returning { turn, error, wallS }. A seat failure is recorded, never thrown.
export async function callSeat({ deps, definition, prep, outDir }) {
  const runAcpSeat = await loadSeat(deps)
  const started = Date.now()
  let turn = null
  let error = null
  try {
    turn = await runAcpSeat({ definition, cwd: prep.cwd, taskDir: prep.taskDir, prompt: prep.prompt, briefText: prep.briefText, sessionFile: join(outDir, 'session.jsonl'), deps: { runtimeRoot: join(outDir, 'seat-runtime') } })
    // A returned refusal or a turn with no stop reason is not a measured turn (crew/lean.mjs fails it the same way).
    if (turn?.refusal) error = `seat refused${turn.refusal.code ? ` ${turn.refusal.code}` : ''}: ${turn.refusal.message ?? JSON.stringify(turn.refusal)}`
    else if (!turn?.stopReason) error = 'seat turn returned no stop reason'
  } catch (e) { error = errText(e) }
  return { turn, error, wallS: Math.round((Date.now() - started) / 1000) }
}
