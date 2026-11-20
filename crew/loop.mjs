// Build: plan -> rebase -> build -> refresh base -> proof -> (suite || review) -> PR.
// Judge: plan -> rebase -> build -> refresh base -> proof -> suite -> (review || second review) -> PR.
// Finish: rebase -> builder triage -> refresh base -> proof -> review -> suite -> commit -> rebase.
// Only the first check round fetches the base; later repairs hold it until publishing.
// A moved base snapshots, rebases and uncommits the build;
// its next review is full and counted, not a publishing recheck, and spends none of MAX_RECHECKS.
// Initial finish, pre-check and publishing rebases share up to three builder conflict turns per run.
// After the first turn, the attempted base must differ from the previous turn's base.
// An unresolved conflict stops rebase-conflict, restoring uncommitted work only when cleanup is proven.
// A mechanical finish uses its brief and publishes nothing.
// Mechanical: rebase -> build -> refresh base -> proof -> suite -> PR. A fix turn repeats checks.
// Only a red suite or proof with measured host sleep gets one unchanged-tree re-run (ADR-054 §1).
// Otherwise finish repairs its first red suite and stops on a second red or an unmeasured suite.
// Only the checked tree is committed. The post-suite publishing rebase still repeats checks at most three times.
// Git dropping the change as upstream stops nothing-to-commit at either move.
// Import-only: every effect (seat turn, filesystem, check, git, journal) crosses an injected seam.
// A seat's return is never trusted from the callback: the envelope is read back from the path
// the loop issued, parsed and validated as P2, and must carry the id the loop issued.
import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFile, lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { resolveAgents } from './agents.mjs'
import {
  CHECK_REASONS, FINISH_REVIEW_ROUNDS, commitChanges, openPullRequest, parseStatus, rebaseBranch, runSuite, validGenerated, validTimeout,
} from './checks.mjs'
import { HEX_OID, describeError as describe, GIT_STATUS_ARGS, gitRepoState } from './lane-core.mjs'
import { proveTests } from './proof.mjs'
import { TIERS, AGENT_ROLES, runOverrideDefects, validateEnvelope } from './protocols.mjs'

export const DEFAULT_ROUNDS = 2
const MAX_ENVELOPE_REPAIRS = 1
const MAX_RECHECKS = 3
const MAX_CONFLICT_TURNS = 3
const MAX_PROGRESS_TURNS = 6
const WORKTREE_SYMLINK = 'worktree-symlink'
const PROOF_UNMEASURED = '- proof: unmeasured'
export const LOOP_REASONS = Object.freeze([
  ...CHECK_REASONS, 'unsupported-shape', 'envelope-refused', 'seat-unmeasured', 'authentication_failed', 'lead-escalated', 'lead-unavailable',
  'lead-refused', 'seat-escalated', 'round-bound', 'paths-unmeasured', 'no-progress', 'raise-needs-plan', 'recheck-bound', 'red-after-sleep-rerun',
])

const REQUIRED_ROLES = ['planner', 'builder', 'reviewer']
const FINISH_ROLES = ['builder', 'reviewer']
const text = (v) => typeof v === 'string' && v !== ''
const strings = (v) => Array.isArray(v) && v.every(text)
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const plainObject = (v) => object(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
const JOURNAL_OUTPUT_TAIL = 4096
function journaled(result) {
  if (!plainObject(result)) return result
  const copy = { ...result }
  for (const key of ['stdout', 'stderr']) if (typeof result[key] === 'string') {
    copy[key] = result[key].slice(-JOURNAL_OUTPUT_TAIL)
    copy[`${key}Bytes`] = Buffer.byteLength(result[key], 'utf8')
  }
  return copy
}
const rosterSound = (roster) => object(roster) && object(roster.overrides) && Array.isArray(roster.files)
  && Object.entries(roster.overrides).every(([role, entry]) => AGENT_ROLES.includes(role) && !runOverrideDefects(role, entry).length)
  && (!Object.hasOwn(roster, 'snapshot') || (object(roster.snapshot) && AGENT_ROLES.every((role) => {
    const entry = roster.snapshot[role]
    return object(entry) && ['agent', 'model', 'effort', 'advisor'].every((key) => Object.hasOwn(entry, key))
      && object(entry.tiers) && TIERS.every((tier) => Object.hasOwn(entry.tiers, tier) && (entry.tiers[tier] === null || (object(entry.tiers[tier]) && ['agent', 'model', 'effort', 'advisor'].every((key) => Object.hasOwn(entry.tiers[tier], key)))))
      && !runOverrideDefects(role, entry).length
  }) && Object.keys(roster.snapshot).every((role) => AGENT_ROLES.includes(role))))
  && roster.files.every((file) => object(file) && ['personal', 'project'].includes(file.layer) && text(file.path) && typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/.test(file.sha256))
const rosterCells = (seats) => Object.fromEntries(Object.entries(seats).map(([role, cell]) => [role, {
  agent: cell?.agent ?? null, model: cell?.provider && cell?.id ? `${cell.provider}/${cell.id}` : null, effort: cell?.effort ?? null,
}]))
const refusal = (reason) => ({ status: 'stopped', reason, pr: null })

// Extract failure names and locations from Node, Rust and Vitest output, with bounded diagnostics for each run.
const SUITE_LIST_MAX = 40
const SUITE_TAIL_MAX = 2000
const SUITE_PREFIX_MAX = 1250
function suiteFailures(results) {
  const tests = new Set()
  const files = new Set()
  const tails = []
  for (const result of results) {
    const stdout = typeof result?.stdout === 'string' ? result.stdout : ''
    const stderr = typeof result?.stderr === 'string' ? result.stderr : ''
    const out = stdout + (stdout && stderr && !stdout.endsWith('\n') ? '\n' : '') + stderr
    const failures = new Set()
    for (const line of out.split(/\n/)) {
      const at = /^\s*test at (\S+)\s*$/.exec(line)
      const loc = /^\s*location:\s*['"]?([^'"]+?)['"]?\s*$/.exec(line)
      const spec = /^\s*✖\s+(.+?)(?:\s+\(\d+(?:\.\d+)?ms\))?\s*$/.exec(line)
      const tap = /^\s*not ok\s+\d+\s*-?\s*(.*?)\s*$/.exec(line)
      const nextest = /^\s*FAIL\s+\[\s*\d+(?:\.\d+)?s\]\s+(?:\(\d+\/\d+\)\s+)?(.+?)\s*$/.exec(line)
      const cargo = /^\s*test\s+(.+?)\s+\.\.\.\s+FAILED\s*$/.exec(line)
      const vitest = /^\s*FAIL\s+(.+?)\s+>\s+(.+?)\s*$/.exec(line)
      const cross = /^\s*×\s+(.+?)(?:\s+\(?\d+(?:\.\d+)?\s*(?:ms|s)\)?)?\s*$/.exec(line)
      let recognised = true
      if (at) files.add(at[1])
      else if (loc) files.add(loc[1])
      else if (spec && !/^failing tests:?$/.test(spec[1])) tests.add(spec[1])
      else if (tap?.[1]) tests.add(tap[1])
      else if (nextest) tests.add(nextest[1])
      else if (cargo) tests.add(cargo[1])
      else if (vitest) { files.add(vitest[1]); tests.add(vitest[2]) }
      else if (cross) tests.add(cross[1])
      else recognised = false
      if (recognised && !at && !loc && out.length > SUITE_TAIL_MAX) failures.add(line.replace(/\r$/, ''))
    }
    // Reserve trailing diagnostics unless a single failure line needs more prefix space.
    const budget = Math.min(SUITE_TAIL_MAX - 1, [...failures].reduce((max, line) => Math.max(max, line.length), SUITE_PREFIX_MAX))
    const kept = new Set()
    let prefix = ''
    let added
    do {
      added = false
      for (const line of failures) {
        const trailing = out.slice(-(SUITE_TAIL_MAX - (prefix ? prefix.length + 1 : 0)))
        if (kept.has(line) || trailing.includes(line) || prefix.length + (prefix ? 1 : 0) + line.length > budget) continue
        prefix += `${prefix ? '\n' : ''}${line}`
        kept.add(line)
        added = true
      }
    } while (added)
    const remaining = SUITE_TAIL_MAX - (prefix ? prefix.length + 1 : 0)
    tails.push(prefix ? `${prefix}\n${remaining ? out.slice(-remaining) : ''}` : out.slice(-SUITE_TAIL_MAX))
  }
  return { tests: [...tests].slice(0, SUITE_LIST_MAX), files: [...files].slice(0, SUITE_LIST_MAX), tail: tails.filter((t) => t !== '') }
}

function finishPromptObservation(observation) {
  if (![observation?.stdout, observation?.stderr].some((stream) => typeof stream === 'string' && stream.length > SUITE_TAIL_MAX)) return observation
  const { tests, files, tail } = suiteFailures([observation])
  const { stdout, stderr, ...rest } = observation
  return { ...rest, failingTests: tests, failingFiles: files, outputTail: tail }
}

// `git status --porcelain=v1 -z`: `XY path` records, a rename or copy (in either column) followed by its
// source. Returns every path named, or null when the output is truncated, mis-framed or names an unsafe path.
// With `unstaged`, only the primary path of a record whose work-tree column differs from the index (and which is not
// added-then-deleted, no change against HEAD) is returned: the entries a `git add` has something to stage, as
// commitChanges stages them. A staged deletion or a rename source is in neither the tree nor the index and has no pathspec.
function parseChangedPaths(stdout, unstaged = false) {
  if (stdout !== '' && !stdout.endsWith('\0')) return null
  const entries = parseStatus(stdout)
  if (!entries) return null
  const paths = new Set()
  const safe = (path) => path !== '' && !path.startsWith('/') && !/[\\\0]/.test(path)
    && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
  for (const { x, y, path, from } of entries) {
    if (!/^[ MTADRCU?!]{2}$/.test(x + y)) return null
    const named = from === null ? [path] : [path, from]
    if (!named.every(safe)) return null
    if (!unstaged) for (const name of named) paths.add(name)
    else if (y !== ' ' && !(x === 'A' && y === 'D')) paths.add(path)
  }
  return [...paths]
}

// Status is already validated by parseChangedPaths; keep rename and copy sources with their records.
function worktreeRecords(stdout) {
  return parseStatus(stdout).filter(({ y }) => y !== ' ').map(({ x, y, path, from }) => `${x}${y} ${path}${from === null ? '' : `\0${from}`}`)
}

// ADR-055 §7: exact files and directory trees that require judge review.
const PROTECTED = ['crew/loop.mjs', 'crew/checks.mjs', 'crew/finish.mjs', 'crew/lean.mjs', 'crew/proof.mjs', 'crew/proof-reporter.mjs', 'crew/protocols.mjs', 'crew/acp/grants.mjs', 'hooks/', 'crew/agents/', '.github/workflows/', 'docs/adr/']
const protectedPaths = (paths) => (paths ?? []).map((path) => path.replace(/^(\.\/)+/, '')).filter((path) => PROTECTED.some((entry) => entry.endsWith('/') ? path === entry.slice(0, -1) || path.startsWith(entry) : path === entry))

const oneLine = (v) => String(v ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim()

function briefAsk(brief) {
  const lines = brief.split(/\r?\n/)
  const heading = lines.findIndex((line) => line.trim() === '## The ask')
  if (heading < 0) return ''
  const block = []
  for (const line of lines.slice(heading + 1)) {
    if (/^ {0,3}#{1,2}(?:\s|$)/.test(line)) break
    if (!line.trim()) { if (block.length) break; continue }
    if (!/^ {0,3}>/.test(line)) continue
    const content = line.replace(/^ {0,3}>[ \t]?/, '')
    if (!content.trim()) break
    block.push(content)
  }
  return oneLine(block.join('\n'))
}

export function seatTurnRow({ role, id, recording, turnError, parsed, started, ended, turnBefore, turnAfter }) {
  const unmeasured = {}, row = { role, id }
  const measure = (field, value, valid, reason) => {
    row[field] = valid ? value : null
    if (!valid) unmeasured[field] = reason
  }
  const reason = turnError ? 'turn-failed' : 'not-reported'
  for (const field of ['agent', 'model', 'effort']) {
    const value = recording?.definition?.[field]
    measure(field, value, typeof value === 'string', reason)
  }
  const calls = recording?.toolCalls, stopReason = recording?.stopReason, usage = recording?.usage
  measure('tool_calls', calls, Number.isSafeInteger(calls) && calls >= 0, reason)
  measure('stop_reason', stopReason, typeof stopReason === 'string', reason)
  measure('usage', usage, usage !== null && typeof usage === 'object' && (Object.getPrototypeOf(usage) === Object.prototype || Object.getPrototypeOf(usage) === null), turnError ? reason : recording?.usage_reason === 'usage-unavailable' ? 'usage-unavailable' : reason)
  if (row.usage === null && recording?.usage_partial) row.usage_partial = recording.usage_partial
  const seconds = (ended - started) / 1000
  measure('seconds', seconds, typeof started === 'number' && typeof ended === 'number' && Number.isFinite(seconds), 'clock-unmeasured')
  const status = parsed?.status
  measure('status', status, ['done', 'insufficient', 'escalate'].includes(status), 'no-return')
  measure('worktree_changed', turnBefore !== turnAfter, role === 'builder' && turnBefore !== null && turnAfter !== null, role === 'builder' ? 'worktree-unmeasured' : 'not-repo-seat')
  if (recording?.sleep_credited_s !== undefined) row.sleep_credited_s = recording.sleep_credited_s
  if (recording?.sleep_credit_reason) row.sleep_credit_reason = recording.sleep_credit_reason
  return { ...row, unmeasured }
}

export function commitBody({ source, isFinish, tier, stop, finishReviews, measurements, priorFindings, secondFindings }) {
  const finishLines = !isFinish ? [] : [
    '## Finish',
    `- Stop: ${oneLine(stop.reason)}${stop.observation == null ? '' : `: ${oneLine(JSON.stringify(stop.observation))}`}`,
    ...(finishReviews.length === 0 ? ['- Reviews: unmeasured.'] : finishReviews.map((r, at) => {
      const findings = Array.isArray(r.findings) && r.findings.length > 0
        ? r.findings.map((f) => `${oneLine(f?.id)} (${oneLine(f?.severity)}) at ${oneLine(f?.location)}: ${oneLine(f?.summary)}`).join('; ')
        : 'none'
      return `- Review ${at + 1}: ${oneLine(r.verdict)}; findings: ${findings}`
    })),
    '',
  ]
  return [
    `Source: ${JSON.stringify(source)}`, '', ...finishLines, '## Measurements', ...measurements,
    ...(!isFinish && tier !== 'mechanical' && [...priorFindings, ...(tier === 'judge' ? secondFindings : [])].some((f) => f.severity === 'should-fix')
      ? ['', '## Should-fix', ...[...priorFindings.map((f) => [f, 'reviewer']), ...(tier === 'judge' ? secondFindings.map((f) => [f, 'tech-lead']) : [])].filter(([f]) => f.severity === 'should-fix').map(([f, role]) => `- ${oneLine(f.id)} (${role}) at ${oneLine(f.location)}: ${oneLine(f.summary)}`)] : []),
  ].join('\n')
}

export async function runLoop(spec, deps = {}) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return refusal('invalid-input')
  const early = async (reason) => {
    const result = refusal(reason)
    const journal = { journal: async (row) => appendFile(join(spec.taskDir, 'journal.jsonl'), `${JSON.stringify(row)}\n`), ...deps }.journal
    if (!text(spec.id) || !text(spec.taskDir) || typeof journal !== 'function') return result
    let at
    try { at = (deps.now ?? Date.now)() } catch {}
    try {
      await journal({ event: 'verdict', lane: spec.id, stage: null, status: 'stopped', reason, ...(Number.isFinite(at) ? { at } : {}) })
    } catch (error) {
      let detail
      try { detail = describe(error) } catch { detail = { code: null, message: 'unprintable error' } }
      return { ...result, journal: { unwritten: 1, error: detail } }
    }
    return result
  }
  if (spec.shape !== 'standard' && spec.shape !== 'finish') return early('unsupported-shape')
  const isFinish = spec.shape === 'finish'
  const sound = [spec.id, spec.cwd, spec.taskDir, spec.brief, spec.source, spec.branch, spec.base].every(text) && TIERS.includes(spec.tier)
    && text(spec.suite?.command) && (spec.suite.args === undefined || Array.isArray(spec.suite.args))
    && (spec.suite.timeoutMs === undefined || validTimeout(spec.suite.timeoutMs))
    && (spec.proofTimeoutMs === undefined || validTimeout(spec.proofTimeoutMs))
    && (spec.suiteLock === undefined || typeof spec.suiteLock === 'boolean')
    && (!Object.hasOwn(spec, 'generated') || validGenerated(spec.generated))
    && (spec.closes === undefined || Array.isArray(spec.closes))
    && (!Object.hasOwn(spec, 'roster') || rosterSound(spec.roster))
  if (!sound) return early('invalid-input')
  const fin = spec.finish
  const planning = isFinish ? fin?.planning : null
  if (planning != null && !(plainObject(planning) && ['planner', 'lead'].includes(planning.entry)
    && plainObject(planning.planner) && typeof fin.guidance === 'string'
    && (planning.entry !== 'lead' || (validateEnvelope('planner', planning.plan, { archived: true }).defects.length === 0 && planning.plan?.status === 'done')))) return early('invalid-input')
  // Only a pre-build planning resume may enter without a subject or plan.
  if (isFinish && !(fin && typeof fin === 'object' && (planning || text(fin.subject)) && (fin.planPath === null || text(fin.planPath))
    && Array.isArray(fin.findings) && text(fin.stop?.reason)
    && (fin.findingsRole === undefined || fin.findingsRole === 'tech-lead')
    && Number.isSafeInteger(fin.turnOffset) && fin.turnOffset >= 0
    && (fin.filesInScope == null || strings(fin.filesInScope))
    && (fin.testsRequired === undefined || typeof fin.testsRequired === 'boolean')
    && (fin.guidance === undefined || typeof fin.guidance === 'string')
    && (fin.rulings === undefined || (Array.isArray(fin.rulings) && fin.rulings.every((r) => plainObject(r) && text(r.summary))))
    && (fin.priorReviewRounds === undefined || (Number.isSafeInteger(fin.priorReviewRounds) && fin.priorReviewRounds >= 0)))) return early('invalid-input')
  const d = {
    resolveAgents, mkdir, readFile, stat, lstat, realpath, writeFile, proveTests, runSuite, commitChanges, rebaseBranch, openPullRequest,
    run: runSuite,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    repoState: gitRepoState,
    journal: async (row) => appendFile(join(spec.taskDir, 'journal.jsonl'), `${JSON.stringify(row)}\n`),
    ...deps,
  }
  const seams = ['runSeat', 'resolveAgents', 'mkdir', 'readFile', 'stat', 'lstat', 'realpath', 'writeFile', 'journal', 'proveTests', 'runSuite', 'commitChanges', 'rebaseBranch', 'openPullRequest', 'run', 'now', 'sleep', 'repoState']
  if (!seams.every((name) => typeof d[name] === 'function')) return early('invalid-input')
  let resolved
  try { resolved = d.resolveAgents(spec.tier, undefined, spec.roster?.snapshot ?? spec.roster?.overrides) } catch { return early('seat-unmeasured') }
  const seats = { ...resolved?.seats }
  const requiredRoles = (tier) => isFinish ? (planning ? REQUIRED_ROLES : FINISH_ROLES) : tier === 'mechanical' ? ['builder'] : tier === 'judge' ? [...REQUIRED_ROLES, 'tech-lead'] : REQUIRED_ROLES
  if (!requiredRoles(spec.tier).every((role) => seats[role] && typeof seats[role] === 'object')) return early('seat-unmeasured')
  const bounded = (cell) => cell.rounds === undefined || (Number.isSafeInteger(cell.rounds) && cell.rounds > 0)
  if (!Object.values(seats).every(bounded)) return early('invalid-input')

  const { cwd } = spec
  const fingerprint = async () => { try { const s = await d.repoState(cwd); return typeof s === 'string' ? s : null } catch { return null } }
  const { journal } = d
  const rounds = { planner: 0, builder: 0, reviewer: 0, 'tech-lead': 0, lead: 0 }
  const phases = ['build', 'review', 'recheck']
  let phase = 0
  const enterPhase = (next) => {
    const index = phases.indexOf(next)
    if (index > phase) { phase = index; rounds.lead = 0 }
  }
  const last = {}
  const context = new AsyncLocalStorage()
  let turn = isFinish ? fin.turnOffset : 0
  let planningEntry = Boolean(planning)
  let progressTurns = 0
  let builderMark = null, consultMustFix = null
  let tier = spec.tier
  let testsRequired = isFinish ? fin.testsRequired ?? fin.planPath !== null : tier !== 'mechanical'
  let rebasedHead = null, currentBase = null
  let repaired = false
  let planPath = isFinish ? fin.planPath : null
  let subject = isFinish ? fin.subject : null
  let planSummary = isFinish ? fin.planSummary : null
  const failures = []
  const rulings = isFinish && Array.isArray(fin.rulings) ? fin.rulings.map((r) => ({ id: 'lead-bounce', summary: r.summary })) : []
  const guidanceItem = isFinish && typeof fin?.guidance === 'string' ? { id: 'finish-return', summary: 'The operator supplied guidance for this finish run. It stands for the whole finish run and outranks the plan and a lead ruling where they differ.', guidance: fin.guidance } : null
  const withGuidance = (items) => guidanceItem ? [guidanceItem, ...items.filter((item) => item?.id !== 'finish-return')] : items
  const planningHistory = planning ? { id: 'planning-resume', summary: 'Resume the stopped planning attempt in this lane. The operator guidance answers the previous stop; the brief is unchanged. Previous planner evidence and the stopped lead question follow.', planner: planning.planner, observation: planning.observation } : null
  const repeatsFailure = (failure) => {
    if (failures.some((previous) => isDeepStrictEqual(previous, failure))) return true
    failures.push(failure)
    return false
  }
  let namedTests = []
  const provedTests = new Map()
  const lastProved = new Set()
  let priorFindings = isFinish ? fin.findings : []
  const importedTechFindings = new Set(isFinish ? fin.findings.filter((f) => fin.findingsRole === 'tech-lead' || f.role === 'tech-lead') : [])
  let reservePending = false, reserveSpent = false, reserveBase = null
  let secondFindings = []
  let reviewedTree = null, recheckScope = null
  let findingOrder = 0
  const openFindings = { reviewer: new Map(priorFindings.filter((f) => f.severity === 'should-fix').map((f) => [f.id, { finding: f, order: findingOrder++ }])), 'tech-lead': new Map() }
  const omitted = (role, details) => Number.isSafeInteger(details.findings_omitted) && details.findings_omitted > 0 ? [{ id: 'findings-omitted', role, count: details.findings_omitted, summary: `The ${role} listed ${details.findings.length} findings and omitted ${details.findings_omitted} more; fix the listed ones and check the same code for the omitted ones.` }] : []
  const rememberFindings = (role, details) => {
    const open = openFindings[role]
    for (const finding of details.findings) {
      if (finding.severity === 'should-fix') open.set(finding.id, { finding, order: findingOrder++ })
    }
    for (const entry of details.closed ?? []) open.delete(entry.id)
  }
  let builderReport = null, builderNotes
  let filesInScope = isFinish ? fin.filesInScope ?? null : null
  let changedPaths = []
  let stagePaths = []

  // A planner's plan_path must name an existing regular file inside the task dir (a relative
  // path is read against it), the way the context arms resolve them; anything else is a defect for the planner to repair.
  const within = (root, target) => {
    const rel = relative(root, target)
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
  }
  const artifactDefects = async (details) => {
    const defects = []
    let root = null
    try { root = await d.realpath(resolve(spec.taskDir)) } catch (error) { return [`details.plan_path cannot be checked: the task dir is unreadable (${describe(error).message})`] }
    for (const key of ['plan_path']) {
      const target = resolve(spec.taskDir, details[key])
      if (/:\d+(-\d+)?$/.test(details[key])) { defects.push(`details.${key} must be a bare file path, without a line-range suffix: ${details[key]}`); continue }
      if (!within(resolve(spec.taskDir), target)) { defects.push(`details.${key} must be a file inside the task dir ${spec.taskDir}`); continue }
      try {
        if (!(await d.stat(target)).isFile()) { defects.push(`details.${key} must be an existing regular file inside the task dir, not ${details[key]}`); continue }
        if (!within(root, await d.realpath(target))) defects.push(`details.${key} must be a file inside the task dir ${spec.taskDir}`)
      } catch (error) { defects.push(`details.${key} must be an existing regular file inside the task dir: ${describe(error).message}`) }
    }
    return defects
  }

  let unwritten = 0, journalError = null
  const emit = async (event, fields) => {
    let at
    try { at = d.now() } catch {}
    try { await journal({ event, lane: spec.id, stage: context.getStore() ?? null, ...fields, at }) } catch (error) {
      unwritten++
      if (journalError === null) {
        try { journalError = describe(error) } catch { journalError = { code: null, message: 'unprintable error' } }
      }
    }
  }
  let reviewRound = null
  const stop = async (reason, observation) => {
    const closed = LOOP_REASONS.includes(reason) ? reason : 'runner-threw'
    // A judge stop stays pending until both seats have journaled their returns.
    if (reviewRound) {
      reviewRound.halt ??= { reason: closed, observation }
      return refusal(reviewRound.halt.reason)
    }
    await emit('verdict', { status: 'stopped', reason: closed, observation })
    return refusal(closed)
  }
  // ADR-055 §7: a raise replaces seats without widening existing round bounds.
  const raise = async (reason, detail, to = 'judge') => {
    if (TIERS.indexOf(tier) >= TIERS.indexOf(to)) return null
    // A planless mechanical finish cannot be raised: the raised seats need a plan. The operator restarts it from its brief.
    if (isFinish && planPath === null) return stop('raise-needs-plan', { reason, ...detail })
    let next
    try { next = d.resolveAgents(to, undefined, spec.roster?.snapshot ?? spec.roster?.overrides)?.seats } catch (error) { return stop('seat-unmeasured', { reason, error: describe(error) }) }
    if (!requiredRoles(to).every((role) => next?.[role] && typeof next[role] === 'object') || !Object.values(next ?? {}).every((cell) => cell == null || (typeof cell === 'object' && bounded(cell)))) return stop('seat-unmeasured', { reason })
    for (const [role, cell] of Object.entries(next)) {
      if (cell && seats[role]?.rounds !== undefined) next[role] = { ...cell, rounds: seats[role].rounds }
    }
    for (const role of Object.keys(seats)) delete seats[role]
    Object.assign(seats, next)
    const from = tier
    tier = to
    await emit('tier-raised', { from, to: tier, reason, ...detail, seats: rosterCells(seats) })
    return null
  }
  const stage = (name, work) => context.run(name, async () => {
    await emit('stage-start', {})
    let outcome = null
    try { outcome = await work(); return outcome } catch (error) { outcome = { threw: describe(error) }; throw error } finally {
      if (plainObject(outcome)) {
        const { stdout, stderr, ...rest } = outcome
        await emit('stage-end', { outcome: rest })
      } else await emit('stage-end', { outcome })
    }
  })
  const acceptPlan = async ({ details, summary }) => {
    planSummary = summary
    planPath = resolve(spec.taskDir, details.plan_path)
    filesInScope = details.files_in_scope ?? null
    subject = details.subject
    testsRequired = !Array.isArray(details.tests) || details.tests.length > 0
    if (details.judge) {
      const halt = await raise('planner-judge', { judge: details.judge })
      if (halt) return halt
    }
    const paths = protectedPaths(filesInScope)
    return paths.length ? await raise('protected-path', { paths }) : null
  }
  // Runs one check seam; a throw or a result that contradicts its own status is unmeasured, never trusted.
  let outputNumber = 0
  const callCheck = async (name, fn, input, { command = false, cancellable = false } = {}) => {
    const retained = name === 'suite' || name === 'proof'
    let result, started, ended
    if (retained) try { started = d.now() } catch {}
    try { result = await fn(input) } catch (error) { result = { status: 'unmeasured', reason: 'runner-threw', error: describe(error) } } finally {
      if (retained) try { ended = d.now() } catch {}
    }
    const metadata = {}
    if (retained) {
      const elapsed = Number.isFinite(started) && Number.isFinite(ended) ? ended - started : NaN
      metadata.seconds = Number.isFinite(elapsed) && elapsed >= 0 ? elapsed / 1000 : null
      if (metadata.seconds === null) metadata.secondsReason = 'clock-unmeasured'
      if (result?.status !== 'green') {
        try {
          // A runner that threw or returned no streams captured nothing: an empty file would claim two empty streams.
          const streams = { stdout: typeof result?.stdout === 'string' ? result.stdout : null, stderr: typeof result?.stderr === 'string' ? result.stderr : null }
          if (streams.stdout === null && streams.stderr === null) throw Object.assign(new Error('the runner returned no output streams'), { code: 'output-uncaptured' })
          const output = JSON.stringify(streams)
          for (;;) {
            const file = `check-${name}-${++outputNumber}.json`
            try { await d.writeFile(join(spec.taskDir, file), output, { flag: 'wx' }) } catch (error) {
              if (error?.code === 'EEXIST') continue
              throw error
            }
            metadata.outputFile = file
            break
          }
        } catch (error) {
          metadata.outputFile = null
          try { metadata.outputError = describe(error) } catch { metadata.outputError = { code: null, message: 'unprintable error' } }
        }
      }
    }
    await emit('check', { check: name, result: journaled(result), ...metadata })
    const sound = result !== null && typeof result === 'object' && !Array.isArray(result)
      && (result.reason === null || CHECK_REASONS.includes(result.reason))
      && (['green', 'red', 'unmeasured'].includes(result.status)
        || (cancellable && name === 'suite' && result.status === 'cancelled' && result.reason === 'cancelled' && result.cleanup === 'proven' && result.timedOut === false))
      && (result.status === 'green') === (result.reason === null)
      && (!command || result.status !== 'green' || (result.code === 0 && !result.signal && result.timedOut === false))
    return sound ? result : { status: 'unmeasured', reason: 'runner-threw' }
  }

  const readStatus = (name) => stage(name, () => callCheck(name, d.run, { cwd, command: 'git', args: [...GIT_STATUS_ARGS] }, { command: true }))
  const checkBuildPaths = async (name, feedback) => {
    const status = await readStatus(name)
    if (status.status !== 'green' || typeof status.stdout !== 'string' || parseChangedPaths(status.stdout) === null) return { halt: await stop('paths-unmeasured', status) }
    const links = new Set()
    for (const { x, y, path } of parseStatus(status.stdout)) {
      // A modified or renamed entry alone may already have been a symlink.
      if (y === 'D' || !/[TA?]/.test(x + y)) continue
      try { if ((await d.lstat(join(cwd, path))).isSymbolicLink()) links.add(path) } catch {}
    }
    const id = WORKTREE_SYMLINK
    const remaining = feedback.filter((item) => item?.id !== id)
    if (!links.size) return { status, feedback: remaining }
    const paths = [...links].sort()
    const failure = { role: 'builder', failure: id, paths }
    if (repeatsFailure(failure)) return { halt: await stop('no-progress', failure) }
    return { feedback: withGuidance([{ id, severity: 'must-fix', summary: `Remove symlinks from these changed worktree paths before checks: ${JSON.stringify(paths)}.`, paths }, ...remaining]) }
  }

  // One role's turn: issue, await, read back, validate (an envelope attempt gets one repair turn that
  // costs no round). Returns { envelope } for a done envelope or { halt }.
  // Non-done returns route under ADR-055 §12; an exhausted bound goes to the lead, unless singleTurn or the lead's own bound stops it.
  const seatTurn = async (role, feedback = [], { singleTurn = false, free = false, hold = false, reserveReview = null, deltaReview = null, recheckReview = null } = {}) => {
    if (role === 'reviewer') enterPhase('review')
    if (planningEntry && ['planner', 'lead'].includes(role)) feedback = [...feedback, guidanceItem, planningHistory]
    let given = feedback
    for (;;) {
      if (reviewRound?.halt) return { halt: refusal(reviewRound.halt.reason) }
      let held, progressed = false
      if (!free && rounds[role] >= (seats[role].rounds ?? DEFAULT_ROUNDS)) {
        held = { reason: 'round-bound', envelope: null }
        progressed = role === 'builder' && builderMark?.changed === true && !builderMark.refunded
      } else {
        if (role === 'builder') builderMark = null
        turn += 1
        if (!free) rounds[role] += 1
        const uncounted = isFinish && role === 'reviewer' && free
        free = false
        if (role === 'lead') feedback = feedback.map((item) => Object.hasOwn(item, 'last') ? { ...item, last: rounds.lead >= (seats.lead.rounds ?? DEFAULT_ROUNDS) } : item)
        const id = `${spec.id}.${role}.${turn}`
        const returnFile = `${role}-${turn}.json`
        const returnPath = join(spec.taskDir, returnFile)
        const request = { role, tier, seat: seats[role], id, returnPath, brief: spec.brief, planPath, feedback: role === 'builder' ? [...feedback, ...rulings] : feedback, ...(role === 'builder' ? { testsRequired } : {}), ...(['builder', 'reviewer', 'tech-lead'].includes(role) ? { filesInScope: filesInScope === null ? null : [...filesInScope] } : {}), ...(['reviewer', 'tech-lead'].includes(role) ? { changedPaths, builderReport } : {}), ...(reserveReview ? { reserveReview } : {}), ...(deltaReview ? { deltaReview } : {}), ...(recheckReview ? { recheckReview } : {}) }
        // One attempt: run the seat, then read the issued path back, parse it and validate it in full.
        const attempt = async (asked) => {
          let failure = null
          let parsed = null, parseError = null
          let recording = null, turnError = null, turnReason = null, routed = false, providerKind = null, method = null
          // P4 measures each attempt separately; ADR-055 §12 (#2279) keeps its own progress comparison.
          const turnBefore = role === 'builder' ? await fingerprint() : null
          let started, ended
          try { started = d.now() } catch {}
          let turnAfter = null
          try {
            try { recording = await d.runSeat(asked, { emit }) } finally {
              try { ended = d.now() } catch {}
              turnAfter = role === 'builder' ? await fingerprint() : null
            }
          } catch (error) {
            turnError = describe(error)
            turnReason = error?.reason
            providerKind = error?.providerKind
            method = error?.method
            recording = error?.recording ?? null
            // ADR-055 amendment: a repo violation's return is neither read nor rerun.
            const repoViolation = ['acp-seat-wrote-repo', 'acp-seat-repo-unmeasured', 'acp-seat-wrote-record', 'acp-seat-record-unmeasured'].includes(error?.reason)
            routed = typeof error?.providerKind === 'string' || repoViolation
            if (repoViolation) failure = { reason: 'seat-unmeasured', error: turnError }
          }
          let raw = null
          if (!failure) try { raw = await d.readFile(returnPath, 'utf8') } catch (error) { failure = { reason: 'seat-unmeasured', error: describe(error) } }
          if (!failure && (typeof raw !== 'string' || raw.trim() === '')) failure = { reason: 'seat-unmeasured', error: { code: null, message: 'the seat returned an empty file' } }
          if (!failure) {
            try { parsed = JSON.parse(raw) } catch (error) { parseError = error.message; failure = { reason: 'envelope-refused', error: describe(error) } }
          }
          const checked = failure ? { envelope: null, defects: [] } : validateEnvelope(role, parsed, { prior: (role === 'reviewer' ? priorFindings : role === 'tech-lead' ? secondFindings : []).filter((finding) => finding?.severity === 'must-fix').map((finding) => finding.id) })
          if (typeof checked.envelope?.id === 'string' && checked.envelope.id !== '' && checked.envelope.id !== id) checked.defects.push(`id must be the issued id ${id}`)
          try {
            await emit('seat-turn', seatTurnRow({ role, id: asked.id, recording, turnError, parsed, started, ended, turnBefore, turnAfter }))
          } catch { /* journal measurements must not affect the turn */ }
          if (!isFinish && tier === 'mechanical' && role === 'builder' && checked.envelope?.status === 'done' && checked.envelope.details && !Object.hasOwn(checked.envelope.details, 'subject')) checked.defects.push('details.subject is required on a mechanical lane for the commit and PR')
          if (role === 'planner' && checked.envelope?.status === 'done' && checked.defects.length === 0 && Object.hasOwn(checked.envelope.details, 'plan_path')) checked.defects.push(...await artifactDefects(checked.envelope.details))
          return { failure, parsed, raw, parseError, checked, turnError, turnReason, routed, providerKind, method, turnBefore, turnAfter }
        }
        const observe = (a) => emit('envelope', { role, id, returnPath, parsed: a.parsed, dropped: a.checked.dropped ?? [], defects: a.checked.defects, error: a.failure?.error ?? null, turnError: a.turnError, ...(uncounted ? { counted: false } : {}) })
        const attempts = [await attempt(request)]
        const firstBefore = attempts[0].turnBefore
        let latest = attempts[0], rerun = false, repairs = 0, asked = request
        for (;;) {
          if (reviewRound?.halt) break
          const acceptable = !latest.failure && latest.checked.defects.length === 0 && latest.checked.envelope?.id === id
          if (latest.turnError && !acceptable && !latest.routed && !rerun) {
            await observe(latest)
            rerun = true
            asked = { ...asked, rerun: { error: latest.turnError, reason: latest.turnReason } }
          } else if (!latest.turnError && repairs < MAX_ENVELOPE_REPAIRS && ((!latest.failure && latest.checked.defects.length > 0) || (latest.parseError && latest.raw.trimStart().startsWith('{')))) {
            await observe(latest)
            repairs += 1
            asked = { ...request, repair: { defects: latest.parseError ? [latest.parseError] : [...latest.checked.defects] } }
          } else break
          latest = await attempt(asked)
        }
        let { failure, parsed, checked } = latest
        const valid = !failure && checked.defects.length === 0 && checked.envelope?.id === id
        await emit('envelope', { role, id, returnPath, parsed, dropped: checked.dropped ?? [], defects: checked.defects, error: failure?.error ?? null, turnError: latest.turnError, ...(uncounted ? { counted: false } : {}) })
        if (latest.turnError && !valid) failure = { reason: latest.providerKind === 'authentication_failed' && latest.method === 'session/new' ? 'authentication_failed' : 'seat-unmeasured', error: latest.turnError }
        if (!failure && !valid) failure = { reason: 'envelope-refused', defects: checked.defects }
        if (failure) return hold ? { held: { ...failure, envelope: null } } : { halt: await stop(role === 'lead' && failure.reason !== 'authentication_failed' ? 'lead-refused' : failure.reason, { role, id, ...failure }) }
        last[role] = checked.envelope
        progressed = role === 'builder' && firstBefore !== null && latest.turnAfter !== null && firstBefore !== latest.turnAfter
        if (role === 'builder') {
          builderMark = { changed: progressed, refunded: false }
          const notes = checked.envelope.details.notes
          builderNotes = text(notes) ? { text: notes, file: `task/${returnFile}` } : undefined
        }
        if (hold && checked.envelope.status !== 'done') return { held: { reason: checked.envelope.status, envelope: checked.envelope } }
        // Decision seats may stop with their summary as the operator question.
        if (['planner', 'reviewer', 'tech-lead'].includes(role) && checked.envelope.status !== 'done') return { halt: await stop('seat-escalated', { role, reason: checked.envelope.status, envelope: checked.envelope, question: checked.envelope.details.question ?? checked.envelope.summary }) }
        // ADR-055 §12: done lead escalations still retry when questionless.
        if (role === 'lead') {
          const questionless = checked.envelope.status === 'done' && checked.envelope.details.decision === 'escalate' && !text(checked.envelope.details.question)
          if (checked.envelope.status !== 'done' || questionless) {
            const failure = { role, status: checked.envelope.status, details: checked.envelope.details }
            if (repeatsFailure(failure)) return { halt: await stop('no-progress', failure) }
          }
          if (questionless) {
            feedback = [{ id: 'escalate-no-question', summary: 'Name the decision needed from the operator in details.question.' }, ...given]
            continue
          }
          return { envelope: checked.envelope }
        }
        if (checked.envelope.status === 'done') return { envelope: checked.envelope }
        held = { reason: checked.envelope.status, envelope: checked.envelope }
      }
      if (hold) return { held }
      // ADR-055 §12 (#2279): progress without a named gap continues without spending a round.
      if (role === 'builder' && held.envelope?.status === 'insufficient' && !held.envelope.details.gap && progressed
        && !singleTurn && (isFinish || tier !== 'mechanical') && progressTurns < MAX_PROGRESS_TURNS) {
        progressTurns += 1
        await emit('builder-continue', { id: held.envelope.id, progressTurns })
        feedback = [{ id: 'builder-continue', summary: 'Your insufficient names no plan gap in details.gap and your turn changed the worktree: continue the same plan until its tasks are done, or return insufficient naming the gap in details.gap.' }, ...given]
        free = true
        continue
      }
      // ADR-055 §12: a finish escalation with a question reaches the operator; mechanical repair returns still route to the lead or restart.
      if (singleTurn && !(role === 'builder' && !isFinish && tier === 'mechanical' && held.envelope && ['insufficient', 'escalate'].includes(held.envelope.status))) {
        if (held.envelope?.status === 'escalate' && text(held.envelope.details?.question)) return { halt: await stop('seat-escalated', { role, reason: 'escalate', envelope: held.envelope, question: held.envelope.details.question }) }
        return { halt: await stop('round-bound', { role, ...held }) }
      }
      // The lead is never consulted about itself: a spent bound asks the operator about the held issue.
      if (role === 'lead') {
        // The question names the blocker in front of the lead now: the held return, else the open feedback; an
        // earlier return and an earlier lead decision are labelled as earlier, never as this blocker's.
        const { role, reason, envelope, held: current = null, feedback: open = [] } = given[0]
        const findings = (Array.isArray(open) ? open : []).filter((item) => item?.id !== 'finish-return').map((item) => item?.summary).filter(text)
        const blocker = current?.summary || findings.join('; ') || (envelope?.summary ? `last return: ${envelope.summary}` : 'no envelope')
        const lead = last.lead ?? null
        const earlier = lead?.details?.decision ? ` Earlier lead decision: ${[lead.details.decision, lead.details.target, lead.summary].filter(Boolean).join(' ')}.` : ''
        const question = oneLine(`How should ${role} resolve ${reason}: ${blocker}?${earlier}`)
        return { halt: await stop('lead-escalated', { role, reason, envelope, feedback: open, lead, bound: 'lead', question }) }
      }
      if (held.envelope) {
        const { status, details } = held.envelope
        const failure = { role, status, details }
        if (repeatsFailure(failure)) return { halt: await stop('no-progress', failure) }
        if (status === 'escalate' && !text(details.question)) {
          feedback = [{ id: 'escalate-no-question', summary: 'Name the decision needed from the operator in details.question.' }, ...given]
          continue
        }
        // ADR-055 §12, amended 2026-11-03: only mechanical insufficiency restarts directly.
        if (!isFinish && role === 'builder' && status === 'insufficient' && tier === 'mechanical') {
          const revised = await restart('build', 'builder-insufficient', { envelope: held.envelope })
          if (revised.halt) return revised
          singleTurn = false; given = []
          feedback = []
          seats[role] = { ...seats[role], rounds: Math.max(seats[role].rounds ?? DEFAULT_ROUNDS, rounds[role] + 1) }
          continue
        }
      }
      if (reviewRound?.ready[role]) {
        // A spent seat waits for the sibling's initial turn before asking for more work.
        reviewRound.ready[role].resolve()
        await Promise.all(Object.values(reviewRound.ready).map((ready) => ready.promise))
        if (reviewRound.halt) return { halt: refusal(reviewRound.halt.reason) }
      }
      const decided = await consultLead(role, held, given, progressed)
      if (decided.halt) return decided
      if (decided.decision === 'accept') {
        if (!isFinish && tier === 'mechanical' && role === 'builder' && held.envelope?.status !== 'done') return { halt: await stop('seat-escalated', { role, reason: held.envelope.status, envelope: held.envelope, question: held.envelope.details?.question ?? null, lead: decided.summary }) }
        return { envelope: held.envelope }
      }
      if (!isFinish && role === 'builder' && decided.target === 'planner') {
        const mechanical = tier === 'mechanical'
        // ADR-055 §7 and §12: a planner bounce spends the planner's round, or restarts a mechanical lane.
        if (!mechanical) seats.planner = { ...seats.planner, rounds: Math.max(seats.planner.rounds ?? DEFAULT_ROUNDS, rounds.planner + 1) }
        const revised = mechanical
          ? await restart('build', 'lead-bounce-planner', { envelope: held.envelope ?? last.builder ?? null, lead: decided.summary })
          : await replan(held.envelope ?? last.builder ?? null, decided.summary)
        if (revised.halt) return revised
        if (mechanical) { singleTurn = false; given = [] }
        feedback = mechanical ? [] : [{ id: 'plan-revised', summary: 'The planner revised the plan at plan_path: continue on the revised plan.', plan_path: planPath }, ...given]
      } else if (role === 'builder') {
        rulings.unshift({ id: 'lead-bounce', summary: decided.summary })
        await emit('lead-rulings', { rulings: [...rulings] })
        feedback = given
      } else feedback = [{ id: 'lead-bounce', summary: decided.summary }, ...given]
      // bounce: exactly one more turn for this role, beyond its bound only if the bound is spent; the counter keeps its history
      seats[role] = { ...seats[role], rounds: Math.max(seats[role].rounds ?? DEFAULT_ROUNDS, rounds[role] + 1) }
      if (!isFinish && role === 'builder') for (const reviewer of ['reviewer', 'tech-lead']) {
        if (seats[reviewer]) seats[reviewer] = { ...seats[reviewer], rounds: Math.max(seats[reviewer].rounds ?? DEFAULT_ROUNDS, rounds[reviewer] + 1) }
      }
    }
  }
  // accept releases only a schema-valid envelope the seat itself returned, except a builder insufficient that needs routing.
  const consultLead = async (role, held, feedback, progressed) => {
    if (!seats.lead) return { halt: await stop('lead-unavailable', { role, ...held }) }
    const mustFix = new Set(feedback.filter((item) => item.severity === 'must-fix').map((item) => `${importedTechFindings.has(item) || secondFindings.includes(item) ? 'tech-lead' : priorFindings.includes(item) ? 'reviewer' : 'loop'}\0${item.id}`))
    const carried = [...mustFix].some((key) => consultMustFix?.has(key))
    consultMustFix = mustFix
    for (;;) {
      const lastConsult = rounds.lead + 1 >= (seats.lead.rounds ?? DEFAULT_ROUNDS)
      const asked = await stage('lead', () => seatTurn('lead', [{ role, reason: held.reason, envelope: held.envelope ?? last[role] ?? null, held: held.envelope ?? null, feedback, last: lastConsult, targets: isFinish && !planningEntry ? ['builder'] : ['builder', 'planner'] }]))
      if (asked.halt) return asked
      const { decision, target, question, instructions } = asked.envelope.details
      if (decision === 'escalate') return { halt: await stop('lead-escalated', { role, ...held, lead: asked.envelope, question: question ?? asked.envelope.summary }) }
      if (decision === 'accept' && !isFinish && tier !== 'mechanical' && role === 'builder' && held.reason === 'insufficient') {
        feedback = [{ id: 'accept-insufficient', summary: 'Route the builder insufficient to builder or planner, or escalate with a question.' }, ...feedback]
        continue
      }
      // ADR-055 §12: a finish has no planner to route a builder's plan gap to.
      if (isFinish && role === 'builder' && decision === 'bounce' && target === 'planner') {
        feedback = [{ id: 'finish-no-planner', summary: 'A finish run has no planner: bounce to builder with instructions it can apply, or escalate naming the plan gap in details.question.' }, ...feedback]
        continue
      }
      // ADR-055 §7: pass the lead's instruction to the bounced seat, falling back to its summary.
      if (decision === 'accept' && (!held.envelope || (['planner', 'reviewer', 'tech-lead'].includes(role) && held.envelope.status !== 'done' && validateEnvelope(role, { ...held.envelope, status: 'done' }).defects.length > 0))) return { decision: 'bounce', target: role, summary: instructions ?? asked.envelope.summary }
      if (decision === 'bounce' && target === 'builder' && role === 'builder' && progressed && !(held.reason === 'round-bound' && carried) && progressTurns < MAX_PROGRESS_TURNS) {
        rounds.lead = Math.max(0, rounds.lead - 1)
        progressTurns += 1
        if (builderMark) builderMark.refunded = true
        await emit('lead-bound-refund', { id: held.envelope?.id, progressTurns })
      }
      return { decision, target, summary: instructions ?? asked.envelope.summary }
    }
  }
  const replan = async (envelope, lead) => {
    const planned = await stage('replan', () => seatTurn('planner', [{ id: 'plan-gap', role: 'builder', envelope, ...(lead ? { lead } : {}) }]))
    if (planned.halt) return planned
    if (rulings.length) { rulings.length = 0; await emit('lead-rulings', { rulings: [] }) }
    const halt = await acceptPlan(planned.envelope)
    return halt ? { halt } : {}
  }

  // ADR-055 §7: discard the entire mechanical build before planning the raised lane.
  const restart = async (to, reason, detail) => {
    for (const args of [['reset', '--hard', rebasedHead], ['clean', '-f', '-d']]) {
      const discarded = await stage('discard', () => callCheck('discard', d.run, { cwd, command: 'git', args }, { command: true }))
      if (discarded.status !== 'green') return { halt: await stop(discarded.reason, discarded) }
    }
    if (rulings.length) { rulings.length = 0; await emit('lead-rulings', { rulings: [] }) }
    const raised = await raise(reason, detail, to)
    if (raised) return { halt: raised }
    rounds.builder = 0
    repaired = false
    provedTests.clear()
    lastProved.clear()
    const planned = await stage('plan', () => seatTurn('planner', [{ id: 'mechanical-restart', summary: 'The mechanical build was discarded; plan the restarted lane.', reason, ...detail }]))
    if (planned.halt) return planned
    const halt = await acceptPlan(planned.envelope)
    return halt ? { halt } : {}
  }

  const fetchOrigin = () => stage('fetch', async () => {
    for (let attempt = 1; ; attempt++) {
      const result = await callCheck('fetch', d.run, { cwd, command: 'git', args: ['fetch', 'origin'] }, { command: true })
      if (attempt === 3 || result.status !== 'red' || result.reason !== 'exit-nonzero'
        || typeof result.stderr !== 'string' || !/cannot lock ref|unable to update local ref/.test(result.stderr)) return result
      await d.sleep(attempt * 1000)
    }
  })
  const rebaseOnBase = () => stage('rebase', () => callCheck('rebase', d.rebaseBranch, { cwd, base: spec.base, ...(spec.generated ? { generated: spec.generated } : {}) }))
  let conflictTurns = 0, lastConflictBase = null
  const resolveConflict = async (rebased) => {
    if (rebased.status !== 'red' || rebased.reason !== 'rebase-conflict' || conflictTurns >= MAX_CONFLICT_TURNS) return rebased
    const onto = typeof rebased.onto === 'string' && HEX_OID.test(rebased.onto) ? rebased.onto : null
    if (conflictTurns > 0 && (onto === null || lastConflictBase === null || onto === lastConflictBase)) return rebased
    const head = await stage('conflict-head', () => callCheck('conflict-head', d.run, { cwd, command: 'git', args: ['rev-parse', 'HEAD'] }, { command: true }))
    if (head.status !== 'green') return head
    const before = typeof head.stdout === 'string' ? head.stdout.trim() : ''
    if (!HEX_OID.test(before)) return { status: 'unmeasured', reason: 'runner-threw', head }
    const item = {
      id: 'rebase-conflict', severity: 'must-fix', checkout: cwd, base: spec.base, onto, conflicts: rebased.conflicts,
      summary: `Rebase ${cwd} onto ${onto ?? `origin/${spec.base}`} and resolve conflicts in ${JSON.stringify(rebased.conflicts)}. `
        + (onto ? `Inspect the base-side commits with \`git log HEAD..${onto}\` before rebasing. ` : '')
        + 'Keep both sides unless they contradict. Complete the rebase, leave a clean tree, and record what you resolved in details.notes.',
    }
    conflictTurns++
    lastConflictBase = onto
    const turn = await stage('conflict', () => seatTurn('builder', [item], { free: true, hold: true }))
    let outcome = turn.held
    if (turn.envelope?.status === 'done') {
      outcome = await rebaseOnBase()
      if ((outcome.status === 'green' && text(outcome.head)) || outcome.reason === 'cleanup-unproven') return outcome
    }
    await stage('conflict-undo', () => callCheck('conflict-undo', d.run, { cwd, command: 'git', args: ['rebase', '--abort'] }, { command: true }))
    for (const args of [['reset', '--hard', before], ['clean', '-f', '-d']]) {
      const undone = await stage('conflict-undo', () => callCheck('conflict-undo', d.run, { cwd, command: 'git', args }, { command: true }))
      if (undone.status !== 'green') return undone
    }
    return { ...rebased, ...(outcome?.reason === 'authentication_failed' ? { reason: 'authentication_failed' } : {}), turn: outcome }
  }
  // Snapshot only measured lane paths; both finish bootstrap and pre-check moves use the rebase safety policy.
  const moveBuild = async (status, precheck = false) => {
    const files = status.status === 'green' && typeof status.stdout === 'string' ? parseChangedPaths(status.stdout) : null
    if (files === null) return { halt: await stop('paths-unmeasured', status) }
    // Added-then-deleted entries are not part of the build and would leave the snapshot dirty.
    const dropped = worktreeRecords(status.stdout).filter((record) => record.startsWith('AD ')).map((record) => record.slice(3))
    if (dropped.length) {
      const unstaged = await stage('base-unstage', () => callCheck('base-unstage', d.run, { cwd, command: 'git', args: ['--literal-pathspecs', 'rm', '--cached', '--quiet', '--ignore-unmatch', '--', ...dropped] }, { command: true }))
      if (unstaged.status !== 'green') return { halt: await stop(unstaged.reason, unstaged) }
    }
    const kept = files.filter((path) => !dropped.includes(path))
    let wip
    if (kept.length) {
      wip = await stage('base-commit', () => callCheck('base-commit', d.commitChanges, { cwd, files: kept, subject: precheck ? 'wip: crew pre-check base' : 'wip: crew finish base' }))
      if (wip.status !== 'green' || !text(wip.head)) return { halt: await stop(wip.reason ?? 'runner-threw', wip) }
    }
    const rebased = await resolveConflict(await rebaseOnBase())
    const baseFailure = rebased.status !== 'green' ? rebased.reason
      : typeof rebased.onto !== 'string' || !HEX_OID.test(rebased.onto) || typeof rebased.head !== 'string' || !HEX_OID.test(rebased.head) ? 'runner-threw' : null
    if (baseFailure) {
      if (wip && baseFailure !== 'cleanup-unproven') {
        const name = precheck ? 'uncommit' : 'base-restore'
        const restored = await stage(name, () => callCheck(name, d.run, { cwd, command: 'git', args: ['reset', '--soft', `${wip.head}^`] }, { command: true }))
        if (restored.status !== 'green') return { halt: await stop(restored.reason, restored) }
      }
      return { halt: await stop(baseFailure, rebased) }
    }
    if (precheck && rebased.head === rebased.onto) return { halt: await stop('nothing-to-commit', rebased) }
    // Record uncommit so finishLane can resume a pass stopped before its next commit.
    if (wip || rebased.head !== rebased.onto) {
      const restored = await stage('uncommit', () => callCheck('uncommit', d.run, { cwd, command: 'git', args: ['reset', '--soft', rebased.onto] }, { command: true }))
      if (restored.status !== 'green') return { halt: await stop(restored.reason, restored) }
    }
    return { rebased }
  }
  const withSleepRerun = async (name, check) => {
    const attempt = () => stage(name, check)
    let result = await attempt()
    if (result.status === 'red' && Number.isFinite(result.sleep_credited_s) && result.sleep_credited_s > 0) {
      result = await attempt()
      // Let the caller join any parallel review before journaling the stop.
      if (result.status === 'red') return { result, stopAfterSleepRerun: () => stop('red-after-sleep-rerun', { stage: name, result: journaled(result) }) }
    }
    return { result }
  }
  const suiteCommand = oneLine([spec.suite.command, ...(spec.suite.args ?? [])].join(' '))
  const suiteRun = (signal) => withSleepRerun('suite', () => callCheck('suite', d.runSuite, { cwd, command: spec.suite.command, args: spec.suite.args, timeoutMs: spec.suite.timeoutMs, suiteLock: spec.suiteLock, lane: spec.id, ...(signal ? { signal } : {}) }, { command: true, cancellable: !!signal }))
  const proofRun = (base) => withSleepRerun('proof', () => callCheck('proof', (input) => d.proveTests(input, {
    onWorktreeSetup: (setup) => emit('worktree-setup', setup),
  }), { cwd, base, tests: namedTests, timeoutMs: spec.proofTimeoutMs, lane: spec.id }))
  const result = await (async () => {
  try {
    try { await d.mkdir(spec.taskDir, { recursive: true }) } catch (error) { return await stop('runner-threw', { mkdir: describe(error) }) }
    // The lane's own start, written once: the arms of every seat (and every retry) date the planner's return against it.
    // A finish run appends none: the original row stays the anchor the arms date the accepted plan against.
    if (!isFinish) {
      await emit('run-start', { run_id: spec.id })
      await emit('roster', { tier, seats: rosterCells(seats), files: spec.roster?.files ?? [] })
    }

    let planned = null
    if (planning) {
      if (planning.entry === 'lead') {
        const decision = await consultLead('planner', { reason: fin.stop.reason, envelope: planning.plan }, [], false)
        if (decision.halt) return decision.halt
        planned = decision.decision === 'accept' ? { envelope: planning.plan }
          : await stage('plan', () => seatTurn('planner', [{ id: 'lead-bounce', summary: decision.summary }]))
      } else planned = await stage('plan', () => seatTurn('planner'))
    } else if (!isFinish && tier !== 'mechanical') planned = await stage('plan', () => seatTurn('planner'))
    if (planned?.halt) return planned.halt
    if (planned) {
      const halt = await acceptPlan(planned.envelope)
      if (halt) return halt
      planningEntry = false
    }
    if (isFinish) {
      // A --return pass counts the reviews the finish run already spent: it never grants new rounds.
      seats.reviewer = { ...seats.reviewer, rounds: FINISH_REVIEW_ROUNDS - (fin.priorReviewRounds ?? 0) }
      const scopePaths = protectedPaths(filesInScope)
      if (scopePaths.length) {
        const halt = await raise('protected-path', { paths: scopePaths })
        if (halt) return halt
      }
    }

    let feedback = isFinish ? [{ id: 'finish-stop', summary: 'The previous lane stopped with the given reason and observation.', reason: fin.stop.reason, observation: finishPromptObservation(fin.stop.observation) }, ...(guidanceItem ? [guidanceItem] : []), ...fin.findings] : []
    if (isFinish) {
      let worktree = await checkBuildPaths('base-paths', feedback)
      while (!worktree.halt && !worktree.status) {
        const built = await stage('build', () => seatTurn('builder', worktree.feedback))
        if (built.halt) return built.halt
        worktree = await checkBuildPaths('base-paths', worktree.feedback)
      }
      if (worktree.halt) return worktree.halt
      const fetched = await fetchOrigin()
      if (fetched.status !== 'green') return stop(fetched.reason, fetched)
      const moved = await moveBuild(worktree.status)
      if (moved.halt) return moved.halt
      rebasedHead = currentBase = moved.rebased.onto
    }

    if (!isFinish && rebasedHead === null) {
      const fetched = await fetchOrigin()
      if (fetched.status !== 'green') return stop(fetched.reason, fetched)
      const rebased = await rebaseOnBase()
      if (rebased.status !== 'green' || !text(rebased.head)) return stop(rebased.reason ?? 'runner-threw', rebased)
      rebasedHead = rebased.head
      currentBase = rebased.onto
    }

    let proofLines = [PROOF_UNMEASURED]
    let suiteLine = `- Suite: unmeasured; ${suiteCommand}.`
    let builderSummary = ''
    const finishReviews = []
    let firstCheck = true
    let repairing = false, recheck = false, rechecks = 0, uncountedReview = false
    let committed, rebased, measurements, laneBody, reviewStatus, checkedTree
    const readTree = () => stage('checked-tree', () => callCheck('checked-tree', d.run, { cwd, command: 'git', args: ['write-tree'] }, { command: true }))
    const latestReviews = {}
    const reviewTurn = async (role, findings, options) => {
      const previous = latestReviews[role]
      if (previous?.tree === checkedTree && previous.result.envelope.details.verdict === 'pass') {
        await emit('review-reused', { role, tree: checkedTree, verdict: 'pass' })
        return { ...previous.result, reused: true }
      }
      const result = await seatTurn(role, findings, options)
      if (result.envelope) latestReviews[role] = { tree: checkedTree, result }
      return result
    }
    const stageChecked = async () => {
      if (stagePaths.length > 0) {
        const staged = await stage('suite-stage', () => callCheck('suite-stage', d.run, { cwd, command: 'git', args: ['--literal-pathspecs', 'add', '--', ...stagePaths] }, { command: true }))
        if (staged.status !== 'green') return stop(staged.reason, staged)
      }
      const tree = await readTree()
      checkedTree = tree.status === 'green' && typeof tree.stdout === 'string' ? tree.stdout.trim() : ''
      return HEX_OID.test(checkedTree) ? null : stop('paths-unmeasured', tree)
    }
    for (;;) {
    for (;;) {
      for (;;) {
        proofLines = [PROOF_UNMEASURED]
        if (!recheck) {
          if (reserveSpent && rounds.reviewer >= (seats.reviewer.rounds ?? DEFAULT_ROUNDS)) return stop('round-bound', { role: 'reviewer', reason: 'round-bound', findings: priorFindings, feedback })
          const built = await stage(repairing ? 'suite-repair' : 'build', () => seatTurn('builder', feedback, { singleTurn: repairing && (isFinish || tier === 'mechanical') }))
          // A symlink retry must not spend a finish suite repair's uncounted review.
          if (repairing || !feedback.some((item) => item?.id === WORKTREE_SYMLINK)) uncountedReview = isFinish && repairing
          repairing = false
          if (built.halt) return built.halt
          if (!isFinish && tier === 'mechanical') subject = built.envelope.details.subject
          builderSummary = oneLine(built.envelope.details.summary) || oneLine(built.envelope.summary)
          // Every return names its own tests; an earlier turn's names never stand in for this build.
          namedTests = Array.isArray(built.envelope.details.tests) ? built.envelope.details.tests : []
          lastProved.clear()
          builderReport = { tests: namedTests, notes: built.envelope.details.notes ?? null }
          const worktree = await checkBuildPaths('build-paths', feedback)
          if (worktree.halt) return worktree.halt
          feedback = worktree.feedback
          if (!worktree.status) continue
          if (!namedTests.length && (!isFinish || planning) && testsRequired) {
            const failure = { role: 'builder', failure: 'proof-no-tests' }
            if (repeatsFailure(failure)) return stop('no-progress', failure)
            feedback = [{ id: 'proof-no-tests', severity: 'must-fix', summary: 'Name at least one test in details.tests ({file, title}); the loop proves each red on the old source and green on the build, or green with base-package-absent or base-test-absent.' }, ...feedback.filter((item) => item?.id !== 'proof-no-tests' && item?.id !== 'proof-unproven')]
            continue
          }
          if (firstCheck) {
            firstCheck = false
            const fetched = await fetchOrigin()
            if (fetched.status !== 'green') return stop(fetched.reason, fetched)
            const measured = await stage('check-base', () => callCheck('check-base', d.run, { cwd, command: 'git', args: ['rev-parse', `refs/remotes/origin/${spec.base}`] }, { command: true }))
            if (measured.status !== 'green') return stop(measured.reason, measured)
            const freshBase = typeof measured.stdout === 'string' ? measured.stdout.trim() : ''
            if (!HEX_OID.test(freshBase) || typeof currentBase !== 'string' || !HEX_OID.test(currentBase)) return stop('runner-threw', measured)
            if (freshBase !== currentBase) {
              const moved = await moveBuild(worktree.status, true)
              if (moved.halt) return moved.halt
              await emit('pre-check-base-move', { from: currentBase, onto: moved.rebased.onto, review: !isFinish && tier === 'mechanical' ? 'none' : 'full', counted: isFinish || tier !== 'mechanical' })
              rebasedHead = currentBase = moved.rebased.onto
              reviewedTree = reserveBase = recheckScope = null
              // A moved base needs a full counted review even when the lane's tree id is unchanged, so no earlier pass is reused.
              for (const role of Object.keys(latestReviews)) delete latestReviews[role]
              uncountedReview = false
            }
          }
        } else uncountedReview = isFinish
        const rebaseOnly = recheck && !isFinish
        const recheckReview = rebaseOnly ? recheckScope : null
        recheckScope = null
        recheck = false
        if (!namedTests.length && (!isFinish || planning) && !testsRequired) proofLines = [tier === 'mechanical' ? '- proof: none, mechanical lane, not reviewed' : '- proof: none, no criterion is machine-checked']
        if (namedTests.length) {
          const { result: proof, stopAfterSleepRerun } = await proofRun('HEAD')
          if (stopAfterSleepRerun) return stopAfterSleepRerun()
          const rows = Array.isArray(proof.rows) ? proof.rows : []
          const proofOK = proof.status === 'green' && proof.reason === null && rows.length === namedTests.length && rows.every((row) => row?.proven === true)
          if (!proofOK && proof.status === 'red') {
            const tests = rows.filter((row) => !row?.proven).map(({ file, title, base, build, reason }) => ({ file, title, base, build, reason }))
            const failure = { role: 'builder', failure: 'proof-unproven', tests }
            if (repeatsFailure(failure)) return stop('no-progress', failure)
            feedback = [{ id: 'proof-unproven', severity: 'must-fix', summary: 'Named tests must be green on the build and red on the old source, or have base-package-absent or base-test-absent.', tests }, ...feedback.filter((item) => item?.id !== 'proof-no-tests' && item?.id !== 'proof-unproven')]
            continue
          }
          if (!proofOK) return stop(proof.reason ?? 'runner-threw', journaled(proof))
          for (const row of rows) {
            const key = `${row.file}\0${row.title}`
            provedTests.set(key, row)
            lastProved.add(key)
          }
          proofLines = rows.map(({ file, title, base }) => `- proof: ${file} ${JSON.stringify(oneLine(title))}: ${base?.reason === 'base-package-absent' ? 'package absent on the old source (base-package-absent)' : base?.reason === 'base-test-absent' ? 'test file absent on the old source (base-test-absent)' : 'red on the old source'}, green on the build`)
        }

        // The reviewer is told what git reports changed now, remeasured every round; an unreadable status stops the lane.
        const status = await readStatus('review-paths')
        changedPaths = status.status === 'green' && typeof status.stdout === 'string' ? parseChangedPaths(status.stdout) : null
        if (changedPaths === null) return stop('paths-unmeasured', status)
        stagePaths = parseChangedPaths(status.stdout, true)
        reviewStatus = status.stdout
        const paths = protectedPaths(changedPaths)
        if (!isFinish && tier === 'mechanical') {
          if (!paths.length) break
          const restarted = await restart('judge', 'protected-path', { paths })
          if (restarted.halt) return restarted.halt
          feedback = []
          continue
        }
        if (paths.length) {
          const halt = await raise('protected-path', { paths })
          if (halt) return halt
        }

        if (!isFinish) {
          const halt = await stageChecked()
          if (halt) return halt
          const runReview = () => stage('review', () => reviewTurn('reviewer', priorFindings, { free: rebaseOnly, recheckReview, singleTurn: !rebaseOnly && reservePending, ...(!rebaseOnly && reservePending && reserveBase ? { reserveReview: { baseTree: reserveBase } } : !rebaseOnly && reviewedTree ? { deltaReview: { baseTree: reviewedTree } } : {}) }))
          const runReviews = async () => {
            const round = tier === 'judge' ? { ready: { reviewer: Promise.withResolvers(), 'tech-lead': Promise.withResolvers() }, halt: null } : null
            reviewRound = round
            let results
            try {
              results = await Promise.allSettled([
                runReview().finally(() => round?.ready.reviewer.resolve()),
                ...(round ? [stage('second-review', () => reviewTurn('tech-lead', secondFindings, { free: rebaseOnly, recheckReview })).finally(() => round.ready['tech-lead'].resolve())] : []),
              ])
            } finally { reviewRound = null }
            if (round?.halt) return [{ halt: await stop(round.halt.reason, round.halt.observation) }]
            const failed = results.find((result) => result.status === 'rejected')
            if (failed) throw failed.reason
            return results.map((result) => result.value)
          }
          let suiteCheck, reviews = []
          if (tier === 'build') {
            const cancellation = new AbortController()
            const pair = await Promise.allSettled([suiteRun(cancellation.signal), runReviews().then((results) => {
              if (results.every((result) => !result.halt && result.envelope)
                && results.some((result) => !result.reused && result.envelope.details.verdict === 'changes-needed')) cancellation.abort()
              return results
            })])
            const failed = pair.find((result) => result.status === 'rejected')
            if (failed) throw failed.reason
            ;[suiteCheck, reviews] = pair.map((result) => result.value)
          }
          else {
            suiteCheck = await suiteRun()
            if (suiteCheck.result.status === 'green') reviews = await runReviews()
          }
          const [reviewed, second] = reviews
          const reviewHalt = reviews.find((result) => result.halt)?.halt
          if (reviewHalt) return reviewHalt
          const { result: suite, stopAfterSleepRerun } = suiteCheck
          if (stopAfterSleepRerun) return stopAfterSleepRerun()
          const cancelled = tier === 'build' && suite.status === 'cancelled'
            && reviews.some((result) => !result.reused && result.envelope?.details.verdict === 'changes-needed')
          if (suite.status !== 'green' && suite.status !== 'red' && !cancelled) return stop(suite.reason, suite)
          let redFindings = [], reviewRed = false
          if (reviewed?.envelope && !reviewed.reused) {
            const review = reviewed.envelope
            priorFindings = review.details.findings
            rememberFindings('reviewer', review.details)
            if (rebaseOnly || !reservePending) reviewedTree = checkedTree
            await emit('verdict', { status: 'reviewed', verdict: review.details.verdict, findings: priorFindings })
            if (!rebaseOnly && reservePending) {
              reservePending = false
              if (review.details.verdict === 'changes-needed') return stop('round-bound', { role: 'reviewer', reason: 'round-bound', envelope: review, findings: priorFindings })
            } else if (!rebaseOnly && !reserveSpent && (review.details.verdict === 'changes-needed' || suite.status === 'red') && rounds.reviewer >= (seats.reviewer.rounds ?? DEFAULT_ROUNDS)) {
              reserveSpent = true
              reservePending = true
              reserveBase = checkedTree
              seats.reviewer = { ...seats.reviewer, rounds: (seats.reviewer.rounds ?? DEFAULT_ROUNDS) + 1 }
            }
            if (review.details.verdict === 'changes-needed') { reviewRed = true; redFindings = [...priorFindings, ...omitted('reviewer', review.details)] }
          }
          if (second?.envelope && !second.reused) {
            secondFindings = second.envelope.details.findings
            rememberFindings('tech-lead', second.envelope.details)
            await emit('verdict', { status: 'reviewed', role: 'tech-lead', verdict: second.envelope.details.verdict, findings: secondFindings })
            if (second.envelope.details.verdict === 'changes-needed') reviewRed = true
          }
          if (suite.status === 'red' || reviewRed) {
            feedback = tier === 'judge' ? reviews.flatMap((result, index) => [...result.envelope.details.findings, ...omitted(index === 0 ? 'reviewer' : 'tech-lead', result.envelope.details)]) : redFindings
            if (suite.status === 'red') {
              const failures = suiteFailures([suite])
              feedback.push({ id: 'suite-repair', severity: 'must-fix', summary: `The project suite is red after your change: ${suiteCommand}. Fix the failing tests.`, checkout: cwd, failingTests: failures.tests, failingFiles: failures.files, ...(failures.tail.length ? { outputTail: failures.tail } : {}) })
              repairing = true
            }
            continue
          }
          suiteLine = `- Suite: green; exit ${suite.code}; ${suiteCommand}.`
          break
        }

        const halt = await stageChecked()
        if (halt) return halt

        // ADR-051 Amendment 2: repair and moved-head reviews run even at the cap.
        const reviewed = await stage('review', () => reviewTurn('reviewer', priorFindings, { singleTurn: isFinish, free: uncountedReview }))
        if (reviewed.halt) return reviewed.halt
        if (reviewed.reused) break
        const review = reviewed.envelope
        priorFindings = review.details.findings
        rememberFindings('reviewer', review.details)
        finishReviews.push({ verdict: review.details.verdict, findings: review.details.findings })
        await emit('verdict', { status: 'reviewed', verdict: review.details.verdict, findings: review.details.findings, ...(uncountedReview ? { counted: false } : {}) })
        if (review.details.verdict === 'changes-needed') {
          if (uncountedReview && rounds.reviewer >= (seats.reviewer.rounds ?? DEFAULT_ROUNDS)) return stop('round-bound', { role: 'reviewer', reason: 'round-bound', envelope: review, findings: review.details.findings })
          feedback = withGuidance([...review.details.findings, ...omitted('reviewer', review.details)])
          continue
        }
        break
      }

      if (!isFinish && tier !== 'mechanical') break

      // The suite runs over the file set the commit will hold: the measured changed paths that need staging, and only those, are staged
      // so a test that lists tracked files sees a file the lane created.
      if (!isFinish) {
        const halt = await stageChecked()
        if (halt) return halt
      }
      const { result: suite, stopAfterSleepRerun } = await suiteRun()
      if (stopAfterSleepRerun) return stopAfterSleepRerun()
      if (suite.status === 'red') {
        if (repaired) return stop(suite.reason, suite)
        // Give the builder one repair turn, then repeat this lane's checks.
        const failures = suiteFailures([suite])
        feedback = withGuidance([{
          id: 'suite-repair',
          severity: 'must-fix',
          summary: `The project suite is red after your change: ${suiteCommand}. Fix the failing tests. This is your only repair turn.`,
          checkout: cwd,
          failingTests: failures.tests,
          failingFiles: failures.files,
          ...(failures.tail.length ? { outputTail: failures.tail } : {}),
        }])
        for (const role of isFinish || tier === 'mechanical' ? ['builder'] : ['builder', 'reviewer']) seats[role] = { ...seats[role], rounds: isFinish ? (seats[role].rounds ?? DEFAULT_ROUNDS) + 1 : Math.max(seats[role].rounds ?? DEFAULT_ROUNDS, rounds[role] + 1) }
        repairing = true
        repaired = true
        continue
      }
      if (suite.status !== 'green') return stop(suite.reason, suite)
      suiteLine = `- Suite: green; exit ${suite.code}; ${suiteCommand}.`
      break
    }
    measurements = [...proofLines, suiteLine, ...(!isFinish && tier === 'mechanical' && namedTests.length ? ['- Review: none, mechanical lane, not reviewed.'] : [])]
    const body = commitBody({ source: spec.source, isFinish, tier, stop: isFinish ? fin.stop : null, finishReviews, measurements, priorFindings, secondFindings })
    // The commit names what git reports changed now, never a list the caller wrote before the build.
    const status = await readStatus('paths')
    const files = status.status === 'green' && typeof status.stdout === 'string' ? parseChangedPaths(status.stdout) : null
    if (!files) return stop('paths-unmeasured', status)
    laneBody = () => {
      const entries = [...openFindings.reviewer.values(), ...(tier === 'judge' && !isFinish ? openFindings['tech-lead'].values() : [])].sort((a, b) => a.order - b.order)
      const open = entries.map(({ finding }) => finding)
      const issue = /^issue ([1-9]\d*)$/.exec(spec.source)
      const closing = issue && (spec.closes ?? []).includes(Number(issue[1]))
      const proved = [...provedTests.values()]
      const title = issue && /^\s*(?:>\s*)?issue title:\s*(.+)$/im.exec(spec.brief)?.[1]
      const ask = !issue ? briefAsk(spec.brief) : ''
      const subjectPurpose = tier === 'mechanical' && !planSummary
      const purpose = subjectPurpose
        ? oneLine(subject).replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/i, '')
        : oneLine(planSummary).replace(/^(?:the plan|plan)(?:\s+|$)/i, '')
      return [
        '## Summary', `Purpose: ${purpose && (subjectPurpose || !/plan\.md|^(?:written|drafted)\b/i.test(purpose)) ? purpose[0].toUpperCase() + purpose.slice(1) : 'unmeasured.'}`,
        ...(issue ? [`${closing ? 'Closes issue' : 'Issue'} ${issue[1]}${title ? `: ${oneLine(title)}` : ''}`] : ask ? [`Operator request: ${ask}`] : []),
        `How: ${oneLine(builderSummary) || oneLine(subject)}`,
        ...(!issue && !ask ? ['', `Source: ${oneLine(spec.source)}`] : []),
        ...(isFinish ? ['', `The lane stopped with reason ${oneLine(fin.stop.reason)}. This report covers only this finish run.`, `${finishReviews.length} ${finishReviews.length === 1 ? 'review' : 'reviews'} in this finish run; final verdict: ${oneLine(finishReviews.at(-1)?.verdict) || 'unmeasured'}.`] : []),
        '', '## Verification',
        ...(proved.length ? [...proved.map(({ file, title, base }) => `- ${oneLine(file)}: ${oneLine(title)} ${base?.reason === 'base-package-absent' ? 'had its package absent on the old source (base-package-absent)' : base?.reason === 'base-test-absent' ? 'had its test file absent on the old source (base-test-absent)' : 'was red on the old source'}, green on ${lastProved.has(`${file}\0${title}`) ? 'the build.' : 'an earlier build turn; the last build turn did not name it.'}`), ...(!isFinish && tier === 'mechanical' ? ['Review: none, mechanical lane, not reviewed.'] : [])]
          : !isFinish && tier === 'mechanical' ? ['Proof: mechanical lane, not reviewed.']
            : (!isFinish || planning) && !testsRequired ? ['Proof: no criterion is machine-checked.'] : ['Proof: unmeasured.']),
        suiteLine,
        ...(open.length ? ['', '## Open points', ...open.map((f) => `- ${oneLine(f.summary)} (${oneLine(f.location)})`)] : []),
      ].join('\n')
    }
    // A protected path first seen after the review-time check (the suite wrote it) never met the raise: never commit it.
    const unraised = protectedPaths(files).filter((path) => !protectedPaths(changedPaths).includes(path))
    if (unraised.length) return stop('dirty-worktree', { paths: unraised })
    {
      // Only an added-then-deleted path remains unstaged after suite-stage; all other work-tree changes are new.
      const reviewed = new Set(worktreeRecords(reviewStatus).filter((record) => record.startsWith('AD ')))
      if (worktreeRecords(status.stdout).some((record) => !reviewed.has(record))) return stop('dirty-worktree', status)
      const tree = await readTree()
      const oid = tree.status === 'green' && typeof tree.stdout === 'string' ? tree.stdout.trim() : ''
      if (!HEX_OID.test(oid)) return stop('paths-unmeasured', tree)
      if (oid !== checkedTree) return stop('dirty-worktree', tree)
    }

    committed = await stage('commit', () => callCheck('commit', d.commitChanges, {
      cwd, files, subject, body, closes: spec.closes ?? [],
    }))
    if (committed.status !== 'green' || !text(committed.head)) return stop(committed.reason ?? 'runner-threw', committed)
    await emit('commit', { head: committed.head })

    const fetched = await fetchOrigin()
    if (fetched.status !== 'green') return stop(fetched.reason, fetched)

    rebased = await resolveConflict(await rebaseOnBase())
    if (rebased.status !== 'green' || !text(rebased.head)) return stop(rebased.reason ?? 'runner-threw', rebased)

    if (rebased.head !== committed.head) {
      if (typeof rebased.onto !== 'string' || !HEX_OID.test(rebased.onto)) return stop('runner-threw', rebased)
      if (rebased.head === rebased.onto) return stop('nothing-to-commit', { head: rebased.head, onto: rebased.onto, committed: committed.head })
      if (isFinish || tier !== 'mechanical') {
        if (rechecks >= MAX_RECHECKS) return stop('recheck-bound', { rechecks, head: rebased.head, onto: rebased.onto, committed: committed.head })
        const uncommitted = await stage('uncommit', () => callCheck('uncommit', d.run, { cwd, command: 'git', args: ['reset', '--soft', rebased.onto] }, { command: true }))
        if (uncommitted.status !== 'green') return stop(uncommitted.reason, uncommitted)
        currentBase = rebased.onto
        enterPhase('recheck')
        rechecks++
        reviewedTree = null
        if (!isFinish) {
          const scope = { reviewed: committed.head, onto: rebased.onto, rebased: rebased.head }
          recheckScope = Object.values(scope).every((oid) => HEX_OID.test(oid)) ? scope : null
          if (recheckScope) for (const [from, to] of [[`${scope.reviewed}^`, scope.reviewed], [scope.onto, scope.rebased], [`${scope.reviewed}^`, scope.onto]]) {
            const diff = await callCheck('recheck-scope-diff', d.run, { cwd, command: 'git', args: ['diff', '--no-ext-diff', '--name-only', from, to] }, { command: true })
            if (diff.status !== 'green') { recheckScope = null; break }
          }
          await emit('recheck-scope', { scope: recheckScope ? 'measured' : 'unmeasured', review: recheckScope ? 'scoped' : 'full', reason: recheckScope ? null : 'scope-unmeasured', ...scope })
        }
        recheck = true
        continue
      }
    }
    break
    }

    if (rebased.head !== committed.head) {
      if (namedTests.length) {
        const { result: reproven, stopAfterSleepRerun } = await proofRun(`${rebased.head}^`)
        if (stopAfterSleepRerun) return stopAfterSleepRerun()
        if (reproven.status !== 'green' || reproven.reason !== null || !Array.isArray(reproven.rows) || reproven.rows.length !== namedTests.length || !reproven.rows.every((row) => row?.proven === true)) return stop(reproven.reason ?? 'runner-threw', journaled(reproven))
        lastProved.clear()
        for (const row of reproven.rows) {
          const key = `${row.file}\0${row.title}`
          provedTests.set(key, row)
          lastProved.add(key)
        }
      }
      const { result: postSuite, stopAfterSleepRerun } = await suiteRun()
      if (stopAfterSleepRerun) return stopAfterSleepRerun()
      if (postSuite.status !== 'green') return stop(postSuite.reason, postSuite)
      suiteLine = `- Suite: green; exit ${postSuite.code}; ${suiteCommand}.`
      // The tree the checks passed on must be the commit that is published or reported ready.
      const cleanStatus = await readStatus('post-rebase-clean')
      const cleanPaths = cleanStatus.status === 'green' && typeof cleanStatus.stdout === 'string' ? parseChangedPaths(cleanStatus.stdout) : null
      if (cleanPaths === null) return stop('paths-unmeasured', cleanStatus)
      if (cleanPaths.length > 0) return stop('dirty-worktree', cleanStatus)
      const cleanHead = await stage('post-rebase-clean', () => callCheck('post-rebase-clean', d.run, { cwd, command: 'git', args: ['rev-parse', 'HEAD'] }, { command: true }))
      if (cleanHead.status !== 'green') return stop(cleanHead.reason, cleanHead)
      if (typeof cleanHead.stdout !== 'string' || cleanHead.stdout.trim() !== rebased.head) return stop('dirty-worktree', cleanHead)
    }

    if (isFinish) {
      // The fused report the deciding session reads instead of the journal; a run that cannot write it is not ready.
      const reviewRounds = (fin.priorReviewRounds ?? 0) + rounds.reviewer
      const body = laneBody()
      const report = { schema: 'finish-report/1', lane: spec.id, stop: { reason: fin.stop.reason, observation: fin.stop.observation ?? null }, subject, body, head: rebased.head, reviewRounds, reviews: finishReviews, measurements }
      await d.writeFile(join(spec.taskDir, 'finish-report.json'), `${JSON.stringify(report, null, 2)}\n`)
      await emit('finish-ready', { status: 'ready-for-operator', head: rebased.head, subject, body, reviewRounds, ...(builderNotes ? { builderNotes } : {}) })
      return { status: 'done', reason: null, pr: null }
    }

    const published = await stage('publish', () => callCheck('publish', d.openPullRequest, {
      cwd, branch: spec.branch, base: spec.base, title: subject, body: laneBody(), closes: spec.closes ?? [], ...(builderNotes ? { builderNotes } : {}),
    }))
    if (published.status !== 'green' || !published.pr || typeof published.pr !== 'object') return stop(published.reason ?? 'runner-threw', published)
    await emit('pr', { pr: published.pr })
    return { status: 'done', reason: null, pr: published.pr }
  } catch (error) {
    return stop('runner-threw', { threw: describe(error) })
  }
  })()
  return unwritten ? { ...result, journal: { unwritten, error: journalError } } : result
}
