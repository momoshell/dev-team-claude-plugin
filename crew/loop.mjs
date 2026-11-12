// Build: plan -> rebase -> build -> proof -> (suite || review) -> PR.
// Judge: plan -> rebase -> build -> proof -> suite -> review -> second review -> PR.
// Finish: rebase -> builder triage -> proof -> review -> suite -> commit -> rebase. A base conflict gets one
// builder conflict turn; an unresolved or spent turn stops with the build uncommitted. A mechanical finish uses its brief and publishes nothing.
// A publishing rebase conflict also gets one builder conflict turn per run; an unresolved or spent turn stops rebase-conflict.
// Mechanical: rebase -> build -> proof -> suite -> PR. A fix turn repeats checks; build, judge and mechanical
// never automatically rerun a red suite (ADR-054 §1). Finish retains its unchanged-tree rerun (ADR-054, What this does not decide).
// Every shape commits only the checked tree; a moved head repeats checks at most three times, stopping if Git dropped the change as upstream.
// Import-only: every effect (seat turn, filesystem, check, git, journal) crosses an injected seam.
// A seat's return is never trusted from the callback: the envelope is read back from the path
// the loop issued, parsed and validated as P2, and must carry the id the loop issued.
import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { resolveAgents } from './agents.mjs'
import {
  CHECK_REASONS, FINISH_REVIEW_ROUNDS, commitChanges, openPullRequest, parseStatus, rebaseBranch, runSuite, validGenerated, validTimeout,
} from './checks.mjs'
import { HEX_OID, describeError as describe, GIT_STATUS_ARGS, gitRepoState } from './lane-core.mjs'
import { proveTests } from './proof.mjs'
import { TIERS, AGENT_ROLES, runOverrideDefects, validateEnvelope } from './protocols.mjs'
import { proveRequiredSkills } from './skills-proof.mjs'

export const DEFAULT_ROUNDS = 2
const MAX_ENVELOPE_REPAIRS = 1
const MAX_RECHECKS = 3
const MAX_PROGRESS_TURNS = 6
const PROOF_UNMEASURED = '- proof: unmeasured'
export const LOOP_REASONS = Object.freeze([
  ...CHECK_REASONS, 'unsupported-shape', 'envelope-refused', 'seat-unmeasured', 'authentication_failed', 'lead-escalated', 'lead-unavailable',
  'lead-refused', 'seat-escalated', 'round-bound', 'paths-unmeasured', 'no-progress', 'raise-needs-plan', 'recheck-bound',
])

const REQUIRED_ROLES = ['planner', 'builder', 'reviewer']
const FINISH_ROLES = ['builder', 'reviewer']
const text = (v) => typeof v === 'string' && v !== ''
const strings = (v) => Array.isArray(v) && v.every(text)
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
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
    && (!Object.hasOwn(spec, 'generated') || validGenerated(spec.generated))
    && (spec.closes === undefined || Array.isArray(spec.closes))
    && (!Object.hasOwn(spec, 'roster') || rosterSound(spec.roster))
  if (!sound) return early('invalid-input')
  const fin = spec.finish
  // A finish run re-enters a stopped lane with its accepted plan and open findings.
  if (isFinish && !(fin && typeof fin === 'object' && text(fin.subject) && (fin.planPath === null || text(fin.planPath))
    && Array.isArray(fin.findings) && text(fin.stop?.reason)
    && Number.isSafeInteger(fin.turnOffset) && fin.turnOffset >= 0
    && (fin.filesInScope == null || strings(fin.filesInScope))
    && (fin.guidance === undefined || typeof fin.guidance === 'string')
    && (fin.priorReviewRounds === undefined || (Number.isSafeInteger(fin.priorReviewRounds) && fin.priorReviewRounds >= 0)))) return early('invalid-input')
  const d = {
    resolveAgents, mkdir, readFile, stat, realpath, writeFile, proveTests, runSuite, commitChanges, rebaseBranch, openPullRequest,
    run: runSuite,
    now: Date.now,
    repoState: gitRepoState,
    journal: async (row) => appendFile(join(spec.taskDir, 'journal.jsonl'), `${JSON.stringify(row)}\n`),
    ...deps,
  }
  const seams = ['runSeat', 'resolveAgents', 'mkdir', 'readFile', 'stat', 'realpath', 'writeFile', 'journal', 'proveTests', 'runSuite', 'commitChanges', 'rebaseBranch', 'openPullRequest', 'run', 'now', 'repoState']
  if (!seams.every((name) => typeof d[name] === 'function')) return early('invalid-input')
  let resolved
  try { resolved = d.resolveAgents(spec.tier, undefined, spec.roster?.snapshot ?? spec.roster?.overrides) } catch { return early('seat-unmeasured') }
  const seats = { ...resolved?.seats }
  const requiredRoles = (tier) => isFinish ? FINISH_ROLES : tier === 'mechanical' ? ['builder'] : tier === 'judge' ? [...REQUIRED_ROLES, 'tech-lead'] : REQUIRED_ROLES
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
  let progressTurns = 0
  let tier = spec.tier
  let testsRequired = isFinish || tier !== 'mechanical'
  let rebasedHead = null
  let repaired = false
  let planPath = isFinish ? fin.planPath : null
  let subject = isFinish ? fin.subject : null
  let planSummary = isFinish ? fin.planSummary : null
  const failures = []
  const repeatsFailure = (failure) => {
    if (failures.some((previous) => isDeepStrictEqual(previous, failure))) return true
    failures.push(failure)
    return false
  }
  let namedTests = []
  let priorFindings = isFinish ? fin.findings : []
  let reservePending = false, reserveSpent = false, reserveBase = null
  let secondFindings = []
  let reviewedTree = null
  let findingOrder = 0
  const openFindings = { reviewer: new Map(priorFindings.filter((f) => f.severity === 'should-fix').map((f) => [f.id, { finding: f, order: findingOrder++ }])), 'tech-lead': new Map() }
  const rememberFindings = (role, details) => {
    const open = openFindings[role]
    for (const finding of details.findings) {
      if (finding.severity === 'should-fix') open.set(finding.id, { finding, order: findingOrder++ })
    }
    for (const entry of details.closed ?? []) open.delete(entry.id)
  }
  let builderReport = null
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
  const stop = async (reason, observation) => {
    const closed = LOOP_REASONS.includes(reason) ? reason : 'runner-threw'
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
      await emit('stage-end', { outcome })
    }
  })
  const acceptPlan = async ({ details, summary }) => {
    planSummary = summary
    planPath = resolve(spec.taskDir, details.plan_path)
    filesInScope = details.files_in_scope ?? null
    subject = details.subject
    testsRequired = details.tests.length > 0
    if (details.judge) {
      const halt = await raise('planner-judge', { judge: details.judge })
      if (halt) return halt
    }
    const paths = protectedPaths(filesInScope)
    return paths.length ? await raise('protected-path', { paths }) : null
  }
  // Runs one check seam; a throw or a result that contradicts its own status is unmeasured, never trusted.
  const callCheck = async (name, fn, input, { command = false } = {}) => {
    let result
    try { result = await fn(input) } catch (error) { result = { status: 'unmeasured', reason: 'runner-threw', error: describe(error) } }
    await emit('check', { check: name, result })
    const sound = result !== null && typeof result === 'object' && !Array.isArray(result)
      && (result.reason === null || CHECK_REASONS.includes(result.reason))
      && ['green', 'red', 'unmeasured'].includes(result.status) && (result.status === 'green') === (result.reason === null)
      && (!command || result.status !== 'green' || (result.code === 0 && !result.signal && result.timedOut === false))
    return sound ? result : { status: 'unmeasured', reason: 'runner-threw' }
  }

  const readStatus = (name) => stage(name, () => callCheck(name, d.run, { cwd, command: 'git', args: [...GIT_STATUS_ARGS] }, { command: true }))

  // One role's turn: issue, await, read back, validate (an envelope attempt gets one repair turn that
  // costs no round). Returns { envelope } for a done envelope or { halt }.
  // Non-done returns route under ADR-055 §12; an exhausted bound goes to the lead, unless singleTurn or the lead's own bound stops it.
  const seatTurn = async (role, feedback = [], { singleTurn = false, free = false, hold = false, reserveReview = null, deltaReview = null } = {}) => {
    if (role === 'reviewer') enterPhase('review')
    let given = feedback
    for (;;) {
      let held, progressed = false
      if (!free && rounds[role] >= (seats[role].rounds ?? DEFAULT_ROUNDS)) {
        held = { reason: 'round-bound', envelope: null }
      } else {
        turn += 1
        if (!free) rounds[role] += 1
        free = false
        if (role === 'lead') feedback = feedback.map((item) => Object.hasOwn(item, 'last') ? { ...item, last: rounds.lead >= (seats.lead.rounds ?? DEFAULT_ROUNDS) } : item)
        const id = `${spec.id}.${role}.${turn}`
        const returnPath = join(spec.taskDir, `${role}-${turn}.json`)
        const request = { role, tier, seat: seats[role], id, returnPath, brief: spec.brief, planPath, feedback, ...(['builder', 'reviewer', 'tech-lead'].includes(role) ? { filesInScope: filesInScope === null ? null : [...filesInScope] } : {}), ...(['reviewer', 'tech-lead'].includes(role) ? { changedPaths, builderReport } : {}), ...(reserveReview ? { reserveReview } : {}), ...(deltaReview ? { deltaReview } : {}) }
        // One attempt: run the seat, then read the issued path back, parse it and validate it in full.
        const attempt = async (asked) => {
          let failure = null
          let parsed = null, parseError = null
          let recording = null, turnError = null, routed = false, providerKind = null, method = null
          try { recording = await d.runSeat(asked, { emit }) } catch (error) {
            turnError = describe(error)
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
          if (!isFinish && tier === 'mechanical' && role === 'builder' && checked.envelope?.status === 'done' && checked.envelope.details && !Object.hasOwn(checked.envelope.details, 'subject')) checked.defects.push('details.subject is required on a mechanical lane for the commit and PR')
          if (role === 'planner' && checked.envelope && checked.defects.length === 0) checked.defects.push(...await artifactDefects(checked.envelope.details))
          return { failure, parsed, raw, parseError, recording, checked, turnError, routed, providerKind, method }
        }
        const observe = (a) => emit('envelope', { role, id, returnPath, parsed: a.parsed, defects: a.checked.defects, error: a.failure?.error ?? null, turnError: a.turnError })
        const before = role === 'builder' ? await fingerprint() : null
        const attempts = [await attempt(request)]
        let latest = attempts[0], rerun = false, repairs = 0, asked = request
        for (;;) {
          const acceptable = !latest.failure && latest.checked.defects.length === 0 && latest.checked.envelope?.id === id
          if (latest.turnError && !acceptable && !latest.routed && !rerun) {
            await observe(latest)
            // The rerun replaces the thrown attempt; repairs still keep their original.
            attempts.pop()
            rerun = true
            asked = { ...asked, rerun: { error: latest.turnError } }
          } else if (!latest.turnError && repairs < MAX_ENVELOPE_REPAIRS && ((!latest.failure && latest.checked.defects.length > 0) || (latest.parseError && latest.raw.trimStart().startsWith('{')))) {
            await observe(latest)
            repairs += 1
            asked = { ...request, repair: { defects: latest.parseError ? [latest.parseError] : [...latest.checked.defects] } }
          } else break
          latest = await attempt(asked)
          attempts.push(latest)
        }
        let { failure, parsed, checked } = latest
        const returnValid = !failure && checked.defects.length === 0 && checked.envelope?.id === id
        // The proof reads the rows the runner relayed for each turn, after the schema and id are sound;
        // a repair turn never launders the work that came before it.
        if (!failure && checked.defects.length === 0 && checked.envelope?.id === id) {
          for (const { recording } of attempts) {
            if (!recording?.definition) continue
            const unproven = proveRequiredSkills({ definition: recording.definition, recorded: recording.recorded, cwd: recording.cwd, museSkillsRoot: recording.museSkillsRoot })
            if (unproven) checked.defects.push(unproven)
          }
        }
        const valid = checked.defects.length === 0 && checked.envelope?.id === id
        await emit('envelope', { role, id, returnPath, parsed, defects: checked.defects, error: failure?.error ?? null, turnError: latest.turnError })
        if (latest.turnError && !returnValid) failure = { reason: latest.providerKind === 'authentication_failed' && latest.method === 'session/new' ? 'authentication_failed' : 'seat-unmeasured', error: latest.turnError }
        if (!failure && !valid) failure = { reason: 'envelope-refused', defects: checked.defects }
        if (failure) return hold ? { held: { ...failure, envelope: null } } : { halt: await stop(role === 'lead' && failure.reason !== 'authentication_failed' ? 'lead-refused' : failure.reason, { role, id, ...failure }) }
        last[role] = checked.envelope
        if (role === 'builder') {
          const after = await fingerprint()
          progressed = before !== null && after !== null && before !== after
        }
        if (hold && checked.envelope.status !== 'done') return { held: { reason: checked.envelope.status, envelope: checked.envelope } }
        // ADR-055 §12: a questionless escalation returns to the same seat, including the lead.
        if (role === 'lead') {
          const questionless = checked.envelope.details.decision === 'escalate' && !text(checked.envelope.details.question)
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
        const findings = (Array.isArray(open) ? open : []).map((item) => item?.summary).filter(text)
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
      const decided = await consultLead(role, held, given, progressed)
      if (decided.halt) return decided
      if (decided.decision === 'accept') return { envelope: held.envelope }
      if (!isFinish && role === 'builder' && decided.target === 'planner') {
        const mechanical = tier === 'mechanical'
        // ADR-055 §7 and §12: a planner bounce spends the planner's round, or restarts a mechanical lane.
        if (!mechanical) seats.planner = { ...seats.planner, rounds: Math.max(seats.planner.rounds ?? DEFAULT_ROUNDS, rounds.planner + 1) }
        const revised = mechanical
          ? await restart('build', 'lead-bounce-planner', { envelope: held.envelope ?? last.builder ?? null, lead: decided.summary })
          : await replan(held.envelope ?? last.builder ?? null, decided.summary)
        if (revised.halt) return revised
        if (mechanical) { singleTurn = false; given = [] }
        feedback = mechanical ? [] : [{ id: 'plan-revised', plan_path: planPath }, ...given]
      } else if (role === 'builder') {
        feedback = [{ id: 'lead-bounce', summary: decided.summary }, ...given]
      }
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
    for (;;) {
      const lastConsult = rounds.lead + 1 >= (seats.lead.rounds ?? DEFAULT_ROUNDS)
      const asked = await stage('lead', () => seatTurn('lead', [{ role, reason: held.reason, envelope: held.envelope ?? last[role] ?? null, held: held.envelope ?? null, feedback, last: lastConsult, targets: isFinish ? ['builder'] : ['builder', 'planner'] }]))
      if (asked.halt) return asked
      const { decision, target, question } = asked.envelope.details
      if (decision === 'escalate') return { halt: await stop('lead-escalated', { role, ...held, question }) }
      if (decision === 'accept' && !isFinish && tier !== 'mechanical' && role === 'builder' && held.reason === 'insufficient') {
        feedback = [{ id: 'accept-insufficient', summary: 'Route the builder insufficient to builder or planner, or escalate with a question.' }, ...feedback]
        continue
      }
      // ADR-055 §12: a finish has no planner to route a builder's plan gap to.
      if (isFinish && role === 'builder' && decision === 'bounce' && target === 'planner') {
        feedback = [{ id: 'finish-no-planner', summary: 'A finish run has no planner: bounce to builder with instructions it can apply, or escalate naming the plan gap in details.question.' }, ...feedback]
        continue
      }
      if (decision === 'accept' && !held.envelope) return { decision: 'bounce', target: role, summary: asked.envelope.summary }
      if (decision === 'bounce' && target === 'builder' && role === 'builder' && progressed && progressTurns < MAX_PROGRESS_TURNS) {
        rounds.lead = Math.max(0, rounds.lead - 1)
        progressTurns += 1
        await emit('lead-bound-refund', { id: held.envelope?.id, progressTurns })
      }
      return { decision, target, summary: asked.envelope.summary }
    }
  }
  const replan = async (envelope, lead) => {
    const planned = await stage('replan', () => seatTurn('planner', [{ id: 'plan-gap', role: 'builder', envelope, ...(lead ? { lead } : {}) }]))
    if (planned.halt) return planned
    const halt = await acceptPlan(planned.envelope)
    return halt ? { halt } : {}
  }

  // ADR-055 §7: discard the entire mechanical build before planning the raised lane.
  const restart = async (to, reason, detail) => {
    for (const args of [['reset', '--hard', rebasedHead], ['clean', '-f', '-d']]) {
      const discarded = await stage('discard', () => callCheck('discard', d.run, { cwd, command: 'git', args }, { command: true }))
      if (discarded.status !== 'green') return { halt: await stop(discarded.reason, discarded) }
    }
    const raised = await raise(reason, detail, to)
    if (raised) return { halt: raised }
    rounds.builder = 0
    repaired = false
    const planned = await stage('plan', () => seatTurn('planner', [{ id: 'mechanical-restart', reason, ...detail }]))
    if (planned.halt) return planned
    const halt = await acceptPlan(planned.envelope)
    return halt ? { halt } : {}
  }

  const fetchOrigin = () => stage('fetch', () => callCheck('fetch', d.run, { cwd, command: 'git', args: ['fetch', 'origin'] }, { command: true }))
  const rebaseOnBase = () => stage('rebase', () => callCheck('rebase', d.rebaseBranch, { cwd, base: spec.base, ...(spec.generated ? { generated: spec.generated } : {}) }))
  let conflictTurn = true
  const resolveConflict = async (rebased) => {
    if (rebased.status !== 'red' || rebased.reason !== 'rebase-conflict' || !conflictTurn) return rebased
    conflictTurn = false
    const head = await stage('conflict-head', () => callCheck('conflict-head', d.run, { cwd, command: 'git', args: ['rev-parse', 'HEAD'] }, { command: true }))
    if (head.status !== 'green') return head
    const before = typeof head.stdout === 'string' ? head.stdout.trim() : ''
    if (!HEX_OID.test(before)) return { status: 'unmeasured', reason: 'runner-threw', head }
    const item = { id: 'rebase-conflict', severity: 'must-fix', summary: `Rebase ${cwd} onto origin/${spec.base}, resolve conflicts in ${JSON.stringify(rebased.conflicts)}, complete the rebase, leave a clean tree. This is your only conflict turn.`, checkout: cwd, base: spec.base, conflicts: rebased.conflicts }
    const turn = await stage('conflict', () => seatTurn('builder', [item], { free: true, hold: true }))
    let outcome = turn.held
    if (turn.envelope?.status === 'done') {
      outcome = await rebaseOnBase()
      if (outcome.status === 'green' && text(outcome.head)) return outcome
    }
    await stage('conflict-undo', () => callCheck('conflict-undo', d.run, { cwd, command: 'git', args: ['rebase', '--abort'] }, { command: true }))
    for (const args of [['reset', '--hard', before], ['clean', '-f', '-d']]) {
      const undone = await stage('conflict-undo', () => callCheck('conflict-undo', d.run, { cwd, command: 'git', args }, { command: true }))
      if (undone.status !== 'green') return undone
    }
    return { ...rebased, ...(outcome?.reason === 'authentication_failed' ? { reason: 'authentication_failed' } : {}), turn: outcome }
  }
  const suiteRun = () => stage('suite', () => callCheck('suite', d.runSuite, { cwd, command: spec.suite.command, args: spec.suite.args, timeoutMs: spec.suite.timeoutMs }, { command: true }))
  const result = await (async () => {
  try {
    try { await d.mkdir(spec.taskDir, { recursive: true }) } catch (error) { return await stop('runner-threw', { mkdir: describe(error) }) }
    // The lane's own start, written once: the arms of every seat (and every retry) date the planner's return against it.
    // A finish run appends none: the original row stays the anchor the arms date the accepted plan against.
    if (!isFinish) {
      await emit('run-start', { run_id: spec.id })
      await emit('roster', { tier, seats: rosterCells(seats), files: spec.roster?.files ?? [] })
    }

    const planned = isFinish || tier === 'mechanical' ? null : await stage('plan', () => seatTurn('planner'))
    if (planned?.halt) return planned.halt
    if (planned) {
      const halt = await acceptPlan(planned.envelope)
      if (halt) return halt
    } else if (isFinish) {
      // A --return pass counts the reviews the finish run already spent: it never grants new rounds.
      seats.reviewer = { ...seats.reviewer, rounds: FINISH_REVIEW_ROUNDS - (fin.priorReviewRounds ?? 0) }
      const scopePaths = protectedPaths(filesInScope)
      if (scopePaths.length) {
        const halt = await raise('protected-path', { paths: scopePaths })
        if (halt) return halt
      }
    }

    if (isFinish) {
      const status = await readStatus('base-paths')
      const files = status.status === 'green' && typeof status.stdout === 'string' ? parseChangedPaths(status.stdout) : null
      if (files === null) return stop('paths-unmeasured', status)
      const fetched = await fetchOrigin()
      if (fetched.status !== 'green') return stop(fetched.reason, fetched)
      // An added-then-deleted entry is no part of the build (the work tree deleted it) and no commit can hold it, so it
      // leaves the index before the snapshot; left there, the rebase refuses the checkout as dirty.
      const dropped = worktreeRecords(status.stdout).filter((record) => record.startsWith('AD ')).map((record) => record.slice(3))
      if (dropped.length) {
        const unstaged = await stage('base-unstage', () => callCheck('base-unstage', d.run, { cwd, command: 'git', args: ['--literal-pathspecs', 'rm', '--cached', '--quiet', '--ignore-unmatch', '--', ...dropped] }, { command: true }))
        if (unstaged.status !== 'green') return stop(unstaged.reason, unstaged)
      }
      const kept = files.filter((path) => !dropped.includes(path))
      let wip
      if (kept.length) {
        wip = await stage('base-commit', () => callCheck('base-commit', d.commitChanges, { cwd, files: kept, subject: 'wip: crew finish base' }))
        if (wip.status !== 'green' || !text(wip.head)) return stop(wip.reason ?? 'runner-threw', wip)
      }
      const rebased = await resolveConflict(await rebaseOnBase())
      const baseFailure = rebased.status !== 'green' ? rebased.reason
        : typeof rebased.onto !== 'string' || !HEX_OID.test(rebased.onto) || !text(rebased.head) ? 'runner-threw'
        : rebased.head === rebased.onto ? 'nothing-to-commit' : null
      if (baseFailure) {
        // A dropped snapshot (its patch already upstream) leaves the branch on the base with a clean tree: resetting to
        // its old parent would rewind the lane off the base and stage the upstream change as local.
        if (wip && baseFailure !== 'cleanup-unproven' && baseFailure !== 'nothing-to-commit') {
          const restored = await stage('base-restore', () => callCheck('base-restore', d.run, { cwd, command: 'git', args: ['reset', '--soft', `${wip.head}^`] }, { command: true }))
          if (restored.status !== 'green') return stop(restored.reason, restored)
        }
        return stop(baseFailure, rebased)
      }
      if (wip) {
        const restored = await stage('base-restore', () => callCheck('base-restore', d.run, { cwd, command: 'git', args: ['reset', '--soft', rebased.onto] }, { command: true }))
        if (restored.status !== 'green') return stop(restored.reason, restored)
      }
      rebasedHead = wip ? rebased.onto : rebased.head
    }

    if (!isFinish && rebasedHead === null) {
      const fetched = await fetchOrigin()
      if (fetched.status !== 'green') return stop(fetched.reason, fetched)
      const rebased = await rebaseOnBase()
      if (rebased.status !== 'green' || !text(rebased.head)) return stop(rebased.reason ?? 'runner-threw', rebased)
      rebasedHead = rebased.head
    }

    let proofLines = [PROOF_UNMEASURED]
    let suiteLine = '- Suite: unmeasured.'
    let builderSummary = '', proofRows = null, suiteResult = null
    const finishReviews = []
    let feedback = isFinish ? [{ id: 'finish-stop', reason: fin.stop.reason, observation: fin.stop.observation }, ...(fin.guidance !== undefined ? [{ id: 'finish-return', guidance: fin.guidance }] : []), ...fin.findings] : []
    let repairing = false, recheck = false, rechecks = 0
    let committed, rebased, measurements, laneBody, reviewStatus, checkedTree, publishedFiles
    const readTree = () => stage('checked-tree', () => callCheck('checked-tree', d.run, { cwd, command: 'git', args: ['write-tree'] }, { command: true }))
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
        proofRows = null
        if (!recheck) {
          if (reserveSpent && rounds.reviewer >= (seats.reviewer.rounds ?? DEFAULT_ROUNDS)) return stop('round-bound', { role: 'reviewer', reason: 'round-bound', findings: priorFindings, feedback })
          const built = await stage(repairing ? 'suite-repair' : 'build', () => seatTurn('builder', feedback, { singleTurn: repairing && (isFinish || tier === 'mechanical') }))
          repairing = false
          if (built.halt) return built.halt
          if (!isFinish && tier === 'mechanical') subject = built.envelope.details.subject
          builderSummary = oneLine(built.envelope.details.summary) || oneLine(built.envelope.summary)
          // Every return names its own tests; an earlier turn's names never stand in for this build.
          namedTests = Array.isArray(built.envelope.details.tests) ? built.envelope.details.tests : []
          builderReport = { tests: namedTests, notes: built.envelope.details.notes ?? null }
          if (!namedTests.length && !isFinish && testsRequired) {
            const failure = { role: 'builder', failure: 'proof-no-tests' }
            if (repeatsFailure(failure)) return stop('no-progress', failure)
            feedback = [{ id: 'proof-no-tests', severity: 'must-fix', summary: 'Name at least one test in details.tests ({file, title}); the loop proves each red on the old source and green on the build.' }]
            continue
          }
        }
        const rebaseOnly = recheck && !isFinish
        recheck = false
        if (!namedTests.length && !isFinish && !testsRequired) proofLines = [tier === 'mechanical' ? '- proof: none, mechanical lane, not reviewed' : '- proof: none, no criterion is machine-checked']
        if (namedTests.length) {
          const proof = await stage('proof', () => callCheck('proof', d.proveTests, { cwd, base: 'HEAD', tests: namedTests, timeoutMs: spec.proofTimeoutMs }))
          const rows = Array.isArray(proof.rows) ? proof.rows : []
          const proofOK = proof.status === 'green' && proof.reason === null && rows.length === namedTests.length && rows.every((row) => row?.proven === true)
          if (!proofOK && proof.status === 'red') {
            const tests = rows.filter((row) => !row?.proven).map(({ file, title, base, build, reason }) => ({ file, title, base, build, reason }))
            const failure = { role: 'builder', failure: 'proof-unproven', tests }
            if (repeatsFailure(failure)) return stop('no-progress', failure)
            feedback = [{ id: 'proof-unproven', severity: 'must-fix', summary: 'Named tests must be red on the old source and green on the build.', tests }]
            continue
          }
          if (!proofOK) return stop(proof.reason ?? 'runner-threw', proof)
          proofRows = rows
          proofLines = rows.map(({ file, title }) => `- proof: ${file} ${JSON.stringify(oneLine(title))}: red on the old source, green on the build`)
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
          const runReview = () => stage('review', () => seatTurn('reviewer', priorFindings, { free: rebaseOnly, singleTurn: !rebaseOnly && reservePending, ...(!rebaseOnly && reservePending ? { reserveReview: { baseTree: reserveBase } } : !rebaseOnly && reviewedTree ? { deltaReview: { baseTree: reviewedTree } } : {}) }))
          let suite, reviewed
          if (tier === 'build') {
            const pair = await Promise.allSettled([suiteRun(), runReview()])
            const failed = pair.find((result) => result.status === 'rejected')
            if (failed) throw failed.reason
            ;[suite, reviewed] = pair.map((result) => result.value)
          }
          else {
            suite = await suiteRun()
            if (suite.status === 'green') reviewed = await runReview()
          }
          if (reviewed?.halt) return reviewed.halt
          if (suite.status !== 'green' && suite.status !== 'red') return stop(suite.reason, suite)
          let redFindings = [], reviewRed = false
          if (reviewed) {
            const review = reviewed.envelope
            priorFindings = review.details.findings
            rememberFindings('reviewer', review.details)
            if (!rebaseOnly && !reservePending) reviewedTree = checkedTree
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
            if (review.details.verdict === 'changes-needed') { reviewRed = true; redFindings = priorFindings }
          }
          if (suite.status === 'red' || reviewRed) {
            feedback = [...redFindings]
            if (suite.status === 'red') {
              const failures = suiteFailures([suite])
              feedback.push({ id: 'suite-repair', severity: 'must-fix', summary: 'The full suite is red after your change. Fix the failing tests.', checkout: cwd, failingTests: failures.tests, failingFiles: failures.files, ...(failures.tail.length ? { outputTail: failures.tail } : {}) })
              repairing = true
            }
            continue
          }
          suiteResult = { code: suite.code }
          suiteLine = `- Suite: green; exit ${suite.code}.`
          if (tier === 'judge') {
            const second = await stage('second-review', () => seatTurn('tech-lead', secondFindings, { free: rebaseOnly }))
            if (second.halt) return second.halt
            secondFindings = second.envelope.details.findings
            rememberFindings('tech-lead', second.envelope.details)
            await emit('verdict', { status: 'reviewed', role: 'tech-lead', verdict: second.envelope.details.verdict, findings: secondFindings })
            if (second.envelope.details.verdict === 'changes-needed') { feedback = secondFindings; continue }
          }
          break
        }

        const halt = await stageChecked()
        if (halt) return halt

        // A finish review is capped outright: its bound ends the run, never a lead bounce into a fourth round.
        const reviewed = await stage('review', () => seatTurn('reviewer', priorFindings, { singleTurn: isFinish }))
        if (reviewed.halt) return reviewed.halt
        const review = reviewed.envelope
        priorFindings = review.details.findings
        rememberFindings('reviewer', review.details)
        finishReviews.push({ verdict: review.details.verdict, findings: review.details.findings })
        await emit('verdict', { status: 'reviewed', verdict: review.details.verdict, findings: review.details.findings })
        if (review.details.verdict === 'changes-needed') {
          feedback = review.details.findings
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
      const suite = await suiteRun()
      // Mechanical fixes the first red; finish retains its unchanged-tree rerun.
      if (suite.status === 'red') {
        const mechanical = !isFinish && tier === 'mechanical'
        const rerun = mechanical ? suite : await suiteRun()
        if (rerun.status === 'red') {
          if (repaired) return stop(suite.reason, rerun)
          // Give the builder one repair turn, then repeat this lane's checks.
          const failures = suiteFailures(mechanical ? [suite] : [suite, rerun])
          feedback = [{
            id: 'suite-repair',
            severity: 'must-fix',
            summary: `The full suite is red ${mechanical ? 'after your change' : 'on two runs after your change'}. Fix the failing tests. This is your only repair turn.`,
            checkout: cwd,
            failingTests: failures.tests,
            failingFiles: failures.files,
            ...(failures.tail.length ? { outputTail: failures.tail } : {}),
          }]
          for (const role of isFinish || tier === 'mechanical' ? ['builder'] : ['builder', 'reviewer']) seats[role] = { ...seats[role], rounds: isFinish ? (seats[role].rounds ?? DEFAULT_ROUNDS) + 1 : Math.max(seats[role].rounds ?? DEFAULT_ROUNDS, rounds[role] + 1) }
          repairing = true
          repaired = true
          continue
        }
        if (rerun.status !== 'green') return stop(rerun.reason, rerun)
        suiteResult = { code: rerun.code, redCode: suite.code }
        suiteLine = `- Suite: green; exit ${rerun.code} (re-run after red; exit ${suite.code}).`
      } else {
        if (suite.status !== 'green') return stop(suite.reason, suite)
        suiteResult = { code: suite.code }
        suiteLine = `- Suite: green; exit ${suite.code}.`
      }
      break
    }
    measurements = [...proofLines, suiteLine, ...(!isFinish && tier === 'mechanical' && namedTests.length ? ['- Review: none, mechanical lane, not reviewed.'] : [])]
    const finishLines = !isFinish ? [] : [
      '## Finish',
      `- Stop: ${oneLine(fin.stop.reason)}${fin.stop.observation == null ? '' : `: ${oneLine(JSON.stringify(fin.stop.observation))}`}`,
      ...(finishReviews.length === 0 ? ['- Reviews: unmeasured.'] : finishReviews.map((r, at) => {
        const findings = Array.isArray(r.findings) && r.findings.length > 0
          ? r.findings.map((f) => `${oneLine(f?.id)} (${oneLine(f?.severity)}) at ${oneLine(f?.location)}: ${oneLine(f?.summary)}`).join('; ')
          : 'none'
        return `- Review ${at + 1}: ${oneLine(r.verdict)}; findings: ${findings}`
      })),
      '',
    ]
    const body = [
      `Source: ${JSON.stringify(spec.source)}`, '', ...finishLines, '## Measurements', ...measurements,
      ...(!isFinish && tier !== 'mechanical' && [...priorFindings, ...(tier === 'judge' ? secondFindings : [])].some((f) => f.severity === 'should-fix')
        ? ['', '## Should-fix', ...[...priorFindings.map((f) => [f, 'reviewer']), ...(tier === 'judge' ? secondFindings.map((f) => [f, 'tech-lead']) : [])].filter(([f]) => f.severity === 'should-fix').map(([f, role]) => `- ${oneLine(f.id)} (${role}) at ${oneLine(f.location)}: ${oneLine(f.summary)}`)] : []),
    ].join('\n')
    // The commit names what git reports changed now, never a list the caller wrote before the build.
    const status = await readStatus('paths')
    const files = status.status === 'green' && typeof status.stdout === 'string' ? parseChangedPaths(status.stdout) : null
    if (!files) return stop('paths-unmeasured', status)
    publishedFiles = files
    laneBody = () => {
      const entries = [...openFindings.reviewer.values(), ...(tier === 'judge' && !isFinish ? openFindings['tech-lead'].values() : [])].sort((a, b) => a.order - b.order)
      const open = entries.map(({ finding }) => finding)
      const issue = /^issue ([1-9]\d*)$/.exec(spec.source)
      const title = issue && (/^title:\s*(.+)$/im.exec(spec.brief.split(/^---\s*$/m)[1] ?? '')?.[1]
        ?? /^\s*(?:>\s*)?issue title:\s*(.+)$/im.exec(spec.brief)?.[1])
      const ask = !issue ? briefAsk(spec.brief) : ''
      const purpose = oneLine(planSummary).replace(/^(?:the plan|plan)(?:\s+|$)/i, '')
      return [
        '## Summary', `Purpose: ${purpose && !/plan\.md|^(?:written|drafted)\b/i.test(purpose) ? purpose[0].toUpperCase() + purpose.slice(1) : 'unmeasured.'}`,
        ...(issue ? [`Closes issue ${issue[1]}${title ? `: ${oneLine(title)}` : ''}`] : ask ? [`Operator request: ${ask}`] : []),
        `How: ${oneLine(builderSummary) || oneLine(subject)}`,
        ...(!issue && !ask ? ['', `Source: ${oneLine(spec.source)}`] : []),
        ...(isFinish ? ['', `The lane stopped with reason ${oneLine(fin.stop.reason)}. This report covers only this finish run.`, `${finishReviews.length} ${finishReviews.length === 1 ? 'review' : 'reviews'} in this finish run; final verdict: ${oneLine(finishReviews.at(-1)?.verdict) || 'unmeasured'}.`] : []),
        '', '## Changes', ...publishedFiles.map((file) => `- ${oneLine(file)}`),
        '', '## Verification',
        ...(!isFinish && tier === 'mechanical' ? ['Proof: mechanical lane, not reviewed.']
          : proofRows ? proofRows.map(({ file, title }) => `- ${oneLine(file)}: ${oneLine(title)} was red on the old source, green on the build.`)
            : !isFinish && !testsRequired ? ['Proof: no criterion is machine-checked.'] : ['Proof: unmeasured.']),
        suiteResult ? `Suite passed with exit code ${suiteResult.code}${Object.hasOwn(suiteResult, 'redCode') ? ` on a re-run after a red exit ${suiteResult.redCode}` : ''}.` : 'Suite: unmeasured.',
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
        enterPhase('recheck')
        rechecks++
        recheck = true
        continue
      }
    }
    break
    }

    if (rebased.head !== committed.head) {
      const paths = await stage('published-paths', () => callCheck('published-paths', d.run, { cwd, command: 'git', args: ['diff', '--no-renames', '--name-only', '-z', `${rebased.head}^`, rebased.head] }, { command: true }))
      const output = paths.status === 'green' && typeof paths.stdout === 'string' ? paths.stdout : null
      // Reuse the status path validation on the NUL-framed diff names.
      publishedFiles = output !== null && (output === '' || output.endsWith('\0'))
        ? parseChangedPaths(output === '' ? '' : `${output.slice(0, -1).split('\0').map((file) => `M  ${file}`).join('\0')}\0`) : null
      if (publishedFiles === null) return stop('paths-unmeasured', paths)
      if (namedTests.length) {
        const reproven = await stage('proof', () => callCheck('proof', d.proveTests, { cwd, base: `${rebased.head}^`, tests: namedTests, timeoutMs: spec.proofTimeoutMs }))
        if (reproven.status !== 'green' || reproven.reason !== null || !Array.isArray(reproven.rows) || reproven.rows.length !== namedTests.length || !reproven.rows.every((row) => row?.proven === true)) return stop(reproven.reason ?? 'runner-threw', reproven)
        proofRows = reproven.rows
      }
      const postSuite = await suiteRun()
      if (postSuite.status !== 'green') return stop(postSuite.reason, postSuite)
      suiteResult = { code: postSuite.code }
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
      await emit('finish-ready', { status: 'ready-for-operator', head: rebased.head, subject, body, reviewRounds })
      return { status: 'done', reason: null, pr: null }
    }

    const published = await stage('publish', () => callCheck('publish', d.openPullRequest, {
      cwd, branch: spec.branch, base: spec.base, title: subject, body: laneBody(), closes: spec.closes ?? [],
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
