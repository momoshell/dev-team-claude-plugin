// The standard loop: plan -> build -> proof -> review -> suite -> commit -> PR. Import-only: every effect (seat turn, filesystem,
// check, git, journal) crosses an injected seam, and nothing here is wired to the boot path yet.
// A seat's return is never trusted from the callback: the envelope is read back from the path
// the loop issued, parsed and validated as P2, and must carry the id the loop issued.
import { appendFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { resolveAgents } from './agents.mjs'
import {
  CHECK_REASONS, commitChanges, openPullRequest, rebaseBranch, runSuite,
} from './checks.mjs'
import { proveTests } from './proof.mjs'
import { TIERS, validateEnvelope } from './protocols.mjs'
import { proveRequiredSkills } from './skills-proof.mjs'

export const DEFAULT_ROUNDS = 2
const MAX_ENVELOPE_REPAIRS = 1
const PROOF_UNMEASURED = '- proof: unmeasured'
export const LOOP_REASONS = Object.freeze([
  ...CHECK_REASONS, 'unsupported-shape', 'envelope-refused', 'seat-unmeasured', 'lead-escalated', 'lead-unavailable',
  'lead-refused', 'accept-unmeasured', 'round-bound', 'paths-unmeasured', 'no-progress',
])

const REQUIRED_ROLES = ['planner', 'builder', 'reviewer']
const FINISH_ROLES = ['builder', 'reviewer']
const FINISH_REVIEW_ROUNDS = 3
const text = (v) => typeof v === 'string' && v !== ''
const strings = (v) => Array.isArray(v) && v.every(text)
const describe = (error) => ({ code: error?.code ?? null, message: String(error?.message ?? error) })
const refusal = (reason) => ({ status: 'stopped', reason, pr: null })

// The failing tests and file locations a red suite printed, from the Node spec reporter (`test at file:l:c`,
// `✖ name`) or TAP (`not ok N - name`, `location: 'file:l:c'`), with a bounded tail of each run for the diagnostics.
const SUITE_LIST_MAX = 40
const SUITE_TAIL_MAX = 2000
function suiteFailures(results) {
  const tests = new Set()
  const files = new Set()
  const tails = []
  for (const result of results) {
    const out = typeof result?.stdout === 'string' ? result.stdout : ''
    for (const line of out.split(/\r?\n/)) {
      const at = /^\s*test at (\S+)\s*$/.exec(line)
      const loc = /^\s*location:\s*['"]?([^'"]+?)['"]?\s*$/.exec(line)
      const spec = /^\s*✖\s+(.+?)(?:\s+\(\d+(?:\.\d+)?ms\))?\s*$/.exec(line)
      const tap = /^\s*not ok\s+\d+\s*-?\s*(.*?)\s*$/.exec(line)
      if (at) files.add(at[1])
      else if (loc) files.add(loc[1])
      else if (spec && !/^failing tests:?$/.test(spec[1])) tests.add(spec[1])
      else if (tap?.[1]) tests.add(tap[1])
    }
    tails.push(out.slice(-SUITE_TAIL_MAX))
  }
  return { tests: [...tests].slice(0, SUITE_LIST_MAX), files: [...files].slice(0, SUITE_LIST_MAX), tail: tails.filter((t) => t !== '') }
}

// `git status --porcelain=v1 -z`: `XY path` records, a rename or copy (in either column) followed by its
// source. Returns every path named, or null when the output is truncated, mis-framed or names an unsafe path.
// With `unstaged`, only the primary path of a record whose work-tree column differs from the index (and which is not
// added-then-deleted, no change against HEAD) is returned: the entries a `git add` has something to stage, as
// commitChanges stages them. A staged deletion or a rename source is in neither the tree nor the index and has no pathspec.
function parseChangedPaths(stdout, unstaged = false) {
  const parts = stdout.split('\0')
  if (parts.pop() !== '') return null
  const paths = new Set()
  const safe = (path) => path !== '' && !path.startsWith('/') && !/[\\\0]/.test(path)
    && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
  for (let at = 0; at < parts.length; at++) {
    const record = parts[at]
    if (!/^[ MTADRCU?!]{2} /.test(record)) return null
    const named = [record.slice(3)]
    if ('RC'.includes(record[0]) || 'RC'.includes(record[1])) named.push(parts[++at])
    if (!named.every((path) => typeof path === 'string' && safe(path))) return null
    if (!unstaged) for (const path of named) paths.add(path)
    else if (record[1] !== ' ' && !(record[0] === 'A' && record[1] === 'D')) paths.add(named[0])
  }
  return [...paths]
}

// ADR-055 §7: exact files and directory trees that require judge review.
const PROTECTED = ['crew/loop.mjs', 'crew/proof.mjs', 'crew/proof-reporter.mjs', 'crew/protocols.mjs', 'crew/acp/grants.mjs', 'hooks/', 'crew/agents/', '.github/workflows/', 'docs/adr/']
const protectedPaths = (paths) => (paths ?? []).map((path) => path.replace(/^(\.\/)+/, '')).filter((path) => PROTECTED.some((entry) => entry.endsWith('/') ? path === entry.slice(0, -1) || path.startsWith(entry) : path === entry))

const oneLine = (v) => String(v ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim()

export async function runLoop(spec, deps = {}) {
  // Nothing is read or run until every field and seam is sound.
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return refusal('invalid-input')
  if (spec.shape !== 'standard' && spec.shape !== 'finish') return refusal('unsupported-shape')
  const isFinish = spec.shape === 'finish'
  const sound = [spec.id, spec.cwd, spec.taskDir, spec.brief, spec.source, spec.branch, spec.base].every(text) && TIERS.includes(spec.tier)
    && text(spec.suite?.command) && (spec.suite.args === undefined || Array.isArray(spec.suite.args))
    && (spec.suite.timeoutMs === undefined || (Number.isSafeInteger(spec.suite.timeoutMs) && spec.suite.timeoutMs > 0))
    && [spec.closes, spec.refs].every((v) => v === undefined || Array.isArray(v))
    && (spec.timeoutMs === undefined || (Number.isSafeInteger(spec.timeoutMs) && spec.timeoutMs > 0))
  if (!sound) return refusal('invalid-input')
  const fin = spec.finish
  // A finish run re-enters a stopped lane with its accepted plan and open findings.
  if (isFinish && !(fin && typeof fin === 'object' && [fin.planPath, fin.subject].every(text)
    && Array.isArray(fin.findings) && text(fin.stop?.reason)
    && Number.isSafeInteger(fin.turnOffset) && fin.turnOffset >= 0
    && (fin.filesInScope == null || strings(fin.filesInScope))
    && (fin.guidance === undefined || typeof fin.guidance === 'string')
    && (fin.priorReviewRounds === undefined || (Number.isSafeInteger(fin.priorReviewRounds) && fin.priorReviewRounds >= 0)))) return refusal('invalid-input')
  const d = {
    resolveAgents, mkdir, readFile, stat, realpath, writeFile, proveTests, runSuite, commitChanges, rebaseBranch, openPullRequest,
    run: runSuite,
    now: Date.now,
    journal: async (row) => appendFile(join(spec.taskDir, 'journal.jsonl'), `${JSON.stringify(row)}\n`),
    ...deps,
  }
  const seams = ['runSeat', 'resolveAgents', 'mkdir', 'readFile', 'stat', 'realpath', 'writeFile', 'journal', 'proveTests', 'runSuite', 'commitChanges', 'rebaseBranch', 'openPullRequest', 'run', 'now']
  if (!seams.every((name) => typeof d[name] === 'function')) return refusal('invalid-input')
  let resolved
  try { resolved = d.resolveAgents(spec.tier) } catch { return refusal('seat-unmeasured') }
  const seats = { ...resolved?.seats }
  if (!(isFinish ? FINISH_ROLES : REQUIRED_ROLES).every((role) => seats[role] && typeof seats[role] === 'object')) return refusal('seat-unmeasured')
  const bounded = (cell) => cell.rounds === undefined || (Number.isSafeInteger(cell.rounds) && cell.rounds > 0)
  if (!Object.values(seats).every(bounded)) return refusal('invalid-input')

  const { cwd, timeoutMs } = spec
  const { journal } = d
  const rounds = { planner: 0, builder: 0, reviewer: 0, lead: 0 }
  const last = {}
  let where = null
  let turn = isFinish ? fin.turnOffset : 0
  let tier = spec.tier
  let testsRequired = true
  let planPath = isFinish ? fin.planPath : null
  let subject = isFinish ? fin.subject : null
  const failures = []
  const repeatsFailure = (failure) => {
    if (failures.some((previous) => isDeepStrictEqual(previous, failure))) return true
    failures.push(failure)
    return false
  }
  let namedTests = []
  let priorFindings = isFinish ? fin.findings : []
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

  const emit = async (event, fields) => {
    try { await journal({ event, lane: spec.id, stage: where, ...fields, at: d.now() }) } catch {}
  }
  const stop = async (reason, observation) => {
    const closed = LOOP_REASONS.includes(reason) ? reason : 'runner-threw'
    await emit('verdict', { status: 'stopped', reason: closed, observation })
    return refusal(closed)
  }
  // ADR-055 §7: a raise replaces seats without widening existing round bounds.
  const raise = async (reason, detail) => {
    if (tier === 'judge') return null
    let next
    try { next = d.resolveAgents('judge')?.seats } catch (error) { return stop('seat-unmeasured', { reason, error: describe(error) }) }
    if (!(isFinish ? FINISH_ROLES : REQUIRED_ROLES).every((role) => next?.[role] && typeof next[role] === 'object') || !Object.values(next ?? {}).every((cell) => cell == null || (typeof cell === 'object' && bounded(cell)))) return stop('seat-unmeasured', { reason })
    for (const [role, cell] of Object.entries(next)) {
      if (cell && seats[role]?.rounds !== undefined) next[role] = { ...cell, rounds: seats[role].rounds }
    }
    for (const role of Object.keys(seats)) delete seats[role]
    Object.assign(seats, next)
    const from = tier
    tier = 'judge'
    await emit('tier-raised', { from, to: tier, reason, ...detail })
    return null
  }
  const stage = async (name, work) => {
    const outer = where
    where = name
    await emit('stage-start', {})
    let outcome = null
    try { outcome = await work(); return outcome } catch (error) { outcome = { threw: describe(error) }; throw error } finally {
      await emit('stage-end', { outcome })
      where = outer
    }
  }
  const acceptPlan = async (details) => {
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
      && (typeof result.accepted === 'boolean'
        ? result.reason !== null
        : ['green', 'red', 'unmeasured'].includes(result.status) && (result.status === 'green') === (result.reason === null))
      && (!command || result.status !== 'green' || (result.code === 0 && !result.signal && result.timedOut === false))
    return sound ? result : { status: 'unmeasured', reason: 'runner-threw' }
  }

  // One role's turn: issue, await, read back, validate (a schema-refused file gets one repair turn that
  // costs no round). Returns { envelope } for a done envelope or { halt }.
  // Non-done returns route under ADR-055 §12; an exhausted bound goes to the lead, unless singleTurn stops it.
  const seatTurn = async (role, feedback = [], { singleTurn = false } = {}) => {
    const given = feedback
    for (;;) {
      let held
      if (rounds[role] >= (seats[role].rounds ?? DEFAULT_ROUNDS)) {
        held = { reason: 'round-bound', envelope: null }
      } else {
        turn += 1
        rounds[role] += 1
        const id = `${spec.id}.${role}.${turn}`
        const returnPath = join(spec.taskDir, `${role}-${turn}.json`)
        const request = { role, tier, seat: seats[role], id, returnPath, brief: spec.brief, planPath, feedback, ...(['builder', 'reviewer'].includes(role) ? { filesInScope: filesInScope === null ? null : [...filesInScope] } : {}), ...(role === 'reviewer' ? { changedPaths, builderReport } : {}) }
        // One attempt: run the seat, then read the issued path back, parse it and validate it in full.
        const attempt = async (asked) => {
          let failure = null
          let parsed = null
          let recording = null
          try { recording = await d.runSeat(asked, { emit }) } catch (error) { failure = { reason: 'seat-unmeasured', error: describe(error) } }
          let raw = null
          if (!failure) {
            try { raw = await d.readFile(returnPath, 'utf8') } catch (error) { failure = { reason: 'seat-unmeasured', error: describe(error) } }
          }
          if (!failure && (typeof raw !== 'string' || raw.trim() === '')) failure = { reason: 'seat-unmeasured', error: { code: null, message: 'the seat returned an empty file' } }
          if (!failure) {
            try { parsed = JSON.parse(raw) } catch (error) { failure = { reason: 'envelope-refused', error: describe(error) } }
          }
          const checked = failure ? { envelope: null, defects: [] } : validateEnvelope(role, parsed, { prior: role === 'reviewer' ? priorFindings.map((finding) => finding?.id) : [] })
          if (role === 'planner' && checked.envelope && checked.defects.length === 0) checked.defects.push(...await artifactDefects(checked.envelope.details))
          return { failure, parsed, recording, checked }
        }
        const observe = (a) => emit('envelope', { role, id, returnPath, parsed: a.parsed, defects: a.checked.defects, error: a.failure?.error ?? null })
        // A file that parsed but failed the schema gets a bounded repair turn; any other failure is final.
        const attempts = [await attempt(request)]
        let latest = attempts[0]
        while (!latest.failure && latest.checked.defects.length > 0 && attempts.length <= MAX_ENVELOPE_REPAIRS) {
          await observe(latest)
          latest = await attempt({ ...request, repair: { defects: [...latest.checked.defects] } })
          attempts.push(latest)
        }
        let { failure, parsed, checked } = latest
        // The proof reads the rows the runner relayed for each turn, after the schema and id are sound;
        // a repair turn never launders the work that came before it.
        if (!failure && checked.defects.length === 0 && checked.envelope?.id === id) {
          for (const { recording } of attempts) {
            if (!recording?.definition) continue
            const unproven = proveRequiredSkills({ definition: recording.definition, recorded: recording.recorded, cwd: recording.cwd })
            if (unproven) checked.defects.push(unproven)
          }
        }
        const valid = checked.defects.length === 0 && checked.envelope?.id === id
        await emit('envelope', { role, id, returnPath, parsed, defects: checked.defects, error: failure?.error ?? null })
        if (!failure && !valid) failure = { reason: 'envelope-refused', defects: checked.defects }
        if (failure) return { halt: await stop(role === 'lead' ? 'lead-refused' : failure.reason, { role, id, ...failure }) }
        last[role] = checked.envelope
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
      if (singleTurn) return { halt: await stop('round-bound', { role, ...held }) }
      // The lead is never consulted about itself: no recursion, an unusable lead turn ends the lane.
      if (role === 'lead') return { halt: await stop(held.envelope ? 'lead-refused' : 'round-bound', held) }
      if (held.envelope) {
        const { status, details } = held.envelope
        const failure = { role, status, details }
        if (repeatsFailure(failure)) return { halt: await stop('no-progress', failure) }
        if (status === 'escalate' && !text(details.question)) {
          feedback = [{ id: 'escalate-no-question', summary: 'Name the decision needed from the operator in details.question.' }, ...given]
          continue
        }
        if (!isFinish && role === 'builder' && status === 'insufficient') {
          const revised = await replan(held.envelope)
          if (revised.halt) return revised
          feedback = [{ id: 'plan-revised', plan_path: planPath }, ...given]
          seats[role] = { ...seats[role], rounds: Math.max(seats[role].rounds ?? DEFAULT_ROUNDS, rounds[role] + 1) }
          continue
        }
      }
      const decided = await consultLead(role, held, given)
      if (decided.halt) return decided
      if (decided.decision === 'accept') return { envelope: held.envelope }
      if (!isFinish && role === 'builder' && decided.target === 'planner') {
        const revised = await replan(held.envelope ?? last.builder ?? null, decided.summary)
        if (revised.halt) return revised
        feedback = [{ id: 'plan-revised', plan_path: planPath }, ...given]
      }
      // bounce: exactly one more turn for this role, beyond its bound only if the bound is spent; the counter keeps its history
      seats[role] = { ...seats[role], rounds: Math.max(seats[role].rounds ?? DEFAULT_ROUNDS, rounds[role] + 1) }
    }
  }
  // accept releases only a schema-valid envelope the seat itself returned; it never stands in for a measurement.
  const consultLead = async (role, held, feedback) => {
    if (!seats.lead) return { halt: await stop('lead-unavailable', { role, ...held }) }
    const asked = await stage('lead', () => seatTurn('lead', [{ role, reason: held.reason, envelope: held.envelope ?? last[role] ?? null, feedback }]))
    if (asked.halt) return asked
    const { decision, target, question } = asked.envelope.details
    if (decision === 'escalate') return { halt: await stop('lead-escalated', { role, ...held, question }) }
    if (decision === 'accept' && !held.envelope) return { halt: await stop('accept-unmeasured', { role, ...held }) }
    return { decision, target, summary: asked.envelope.summary }
  }
  const replan = async (envelope, lead) => {
    const planned = await stage('replan', () => seatTurn('planner', [{ id: 'plan-gap', role: 'builder', envelope, ...(lead ? { lead } : {}) }]))
    if (planned.halt) return planned
    const halt = await acceptPlan(planned.envelope.details)
    return halt ? { halt } : {}
  }

  try {
    try { await d.mkdir(spec.taskDir, { recursive: true }) } catch (error) { return await stop('runner-threw', { mkdir: describe(error) }) }
    // The lane's own start, written once: the arms of every seat (and every retry) date the planner's return against it.
    // A finish run appends none: the original row stays the anchor the arms date the accepted plan against.
    if (!isFinish) await emit('run-start', { run_id: spec.id })

    const planned = isFinish ? null : await stage('plan', () => seatTurn('planner'))
    if (planned?.halt) return planned.halt
    if (!isFinish) {
      const halt = await acceptPlan(planned.envelope.details)
      if (halt) return halt
    } else {
      // A --return pass counts the reviews the finish run already spent: it never grants new rounds.
      seats.reviewer = { ...seats.reviewer, rounds: FINISH_REVIEW_ROUNDS - (fin.priorReviewRounds ?? 0) }
      const scopePaths = protectedPaths(filesInScope)
      if (scopePaths.length) {
        const halt = await raise('protected-path', { paths: scopePaths })
        if (halt) return halt
      }
    }

    let proofLines = [PROOF_UNMEASURED]
    let suiteLine = '- Suite: unmeasured.'
    const finishReviews = []
    let feedback = isFinish ? [{ id: 'finish-stop', reason: fin.stop.reason, observation: fin.stop.observation }, ...(fin.guidance !== undefined ? [{ id: 'finish-return', guidance: fin.guidance }] : []), ...fin.findings] : []
    let repairing = false
    let repaired = false
    for (;;) {
      for (;;) {
        proofLines = [PROOF_UNMEASURED]
        const built = await stage(repairing ? 'suite-repair' : 'build', () => seatTurn('builder', feedback, { singleTurn: repairing }))
        repairing = false
        if (built.halt) return built.halt
        // Every return names its own tests; an earlier turn's names never stand in for this build.
        namedTests = Array.isArray(built.envelope.details.tests) ? built.envelope.details.tests : []
        builderReport = { tests: namedTests, notes: built.envelope.details.notes ?? null }
        if (!namedTests.length && !isFinish && testsRequired) {
          const failure = { role: 'builder', failure: 'proof-no-tests' }
          if (repeatsFailure(failure)) return stop('no-progress', failure)
          feedback = [{ id: 'proof-no-tests', severity: 'must-fix', summary: 'Name at least one test in details.tests ({file, title}); the loop proves each red on the old source and green on the build.' }]
          continue
        }
        if (!namedTests.length && !isFinish && !testsRequired) proofLines = ['- proof: none, no criterion is machine-checked']
        if (namedTests.length) {
          const proof = await stage('proof', () => callCheck('proof', d.proveTests, { cwd, base: 'HEAD', tests: namedTests, timeoutMs }))
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
          proofLines = rows.map(({ file, title }) => `- proof: ${file} ${JSON.stringify(oneLine(title))}: red on the old source, green on the build`)
        }

        // The reviewer is told what git reports changed now, remeasured every round; an unreadable status stops the lane.
        const status = await stage('review-paths', () => callCheck('review-paths', d.run, { cwd, command: 'git', args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'], timeoutMs }, { command: true }))
        changedPaths = status.status === 'green' && typeof status.stdout === 'string' ? parseChangedPaths(status.stdout) : null
        if (changedPaths === null) return stop('paths-unmeasured', status)
        stagePaths = parseChangedPaths(status.stdout, true)
        const paths = protectedPaths(changedPaths)
        if (paths.length) {
          const halt = await raise('protected-path', { paths })
          if (halt) return halt
        }

        // A finish review is capped outright: its bound ends the run, never a lead bounce into a fourth round.
        const reviewed = await stage('review', () => seatTurn('reviewer', priorFindings, { singleTurn: isFinish }))
        if (reviewed.halt) return reviewed.halt
        const review = reviewed.envelope
        priorFindings = review.details.findings
        finishReviews.push({ verdict: review.details.verdict, findings: review.details.findings })
        await emit('verdict', { status: 'reviewed', verdict: review.details.verdict, findings: review.details.findings })
        if (review.details.verdict === 'changes-needed') {
          // The suite repair is one builder turn: a review that asks for more after it stops the lane.
          if (repaired) return stop('round-bound', { role: 'reviewer', findings: review.details.findings })
          feedback = review.details.findings
          continue
        }
        break
      }

      // The suite runs over the file set the commit will hold: the measured changed paths that need staging, and only those, are staged
      // so a test that lists tracked files sees a file the lane created.
      if (stagePaths.length > 0) {
        const staged = await stage('suite-stage', () => callCheck('suite-stage', d.run, { cwd, command: 'git', args: ['--literal-pathspecs', 'add', '--', ...stagePaths], timeoutMs }, { command: true }))
        if (staged.status !== 'green') return stop(staged.reason, staged)
      }
      const runSuite = () => stage('suite', () => callCheck('suite', d.runSuite, { cwd, command: spec.suite.command, args: spec.suite.args, timeoutMs: spec.suite.timeoutMs ?? timeoutMs }, { command: true }))
      const suite = await runSuite()
      // Only a measured red is run once more; an unmeasured suite stops as it is, and the first red stays in the PR text.
      if (suite.status === 'red') {
        const rerun = await runSuite()
        if (rerun.status === 'red') {
          if (repaired) return stop(suite.reason, rerun)
          // Two measured reds earn one builder turn and one review (beyond their rounds if spent), then proof, review and suite again.
          const failures = suiteFailures([suite, rerun])
          feedback = [{
            id: 'suite-repair',
            severity: 'must-fix',
            summary: 'The full suite is red on two runs after your change. Fix the failing tests. This is your only repair turn.',
            checkout: cwd,
            failingTests: failures.tests,
            failingFiles: failures.files,
            ...(failures.tail.length ? { outputTail: failures.tail } : {}),
          }]
          for (const role of isFinish ? ['builder'] : ['builder', 'reviewer']) seats[role] = { ...seats[role], rounds: Math.max(seats[role].rounds ?? DEFAULT_ROUNDS, rounds[role] + 1) }
          repairing = true
          repaired = true
          continue
        }
        if (rerun.status !== 'green') return stop(rerun.reason, rerun)
        suiteLine = `- Suite: green; exit ${rerun.code} (re-run after red; exit ${suite.code}).`
      } else {
        if (suite.status !== 'green') return stop(suite.reason, suite)
        suiteLine = `- Suite: green; exit ${suite.code}.`
      }
      break
    }
    const measurements = [...proofLines, suiteLine]
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
    ].join('\n')

    // The commit names what git reports changed now, never a list the caller wrote before the build.
    const status = await stage('paths', () => callCheck('paths', d.run, { cwd, command: 'git', args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'], timeoutMs }, { command: true }))
    const files = status.status === 'green' && typeof status.stdout === 'string' ? parseChangedPaths(status.stdout) : null
    if (!files) return stop('paths-unmeasured', status)

    const committed = await stage('commit', () => callCheck('commit', d.commitChanges, {
      cwd, files, subject, body, closes: spec.closes ?? [], refs: spec.refs ?? [], timeoutMs,
    }))
    if (committed.status !== 'green' || !text(committed.head)) return stop(committed.reason ?? 'runner-threw', committed)
    await emit('commit', { head: committed.head })

    const fetched = await stage('fetch', () => callCheck('fetch', d.run, { cwd, command: 'git', args: ['fetch', 'origin'], timeoutMs }, { command: true }))
    if (fetched.status !== 'green') return stop(fetched.reason, fetched)

    const rebased = await stage('rebase', () => callCheck('rebase', d.rebaseBranch, { cwd, base: spec.base, timeoutMs }))
    if (rebased.status !== 'green' || !text(rebased.head)) return stop(rebased.reason ?? 'runner-threw', rebased)

    if (rebased.head !== committed.head) {
      if (namedTests.length) {
        const reproven = await stage('proof', () => callCheck('proof', d.proveTests, { cwd, base: `${rebased.head}^`, tests: namedTests, timeoutMs }))
        if (reproven.status !== 'green' || reproven.reason !== null || !Array.isArray(reproven.rows) || reproven.rows.length !== namedTests.length || !reproven.rows.every((row) => row?.proven === true)) return stop(reproven.reason ?? 'runner-threw', reproven)
      }
      const postSuite = await stage('suite', () => callCheck('suite', d.runSuite, { cwd, command: spec.suite.command, args: spec.suite.args, timeoutMs: spec.suite.timeoutMs ?? timeoutMs }, { command: true }))
      if (postSuite.status !== 'green') return stop(postSuite.reason, postSuite)
      // The tree the checks passed on must be the commit that is published or reported ready.
      const cleanStatus = await stage('post-rebase-clean', () => callCheck('post-rebase-clean', d.run, { cwd, command: 'git', args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'], timeoutMs }, { command: true }))
      const cleanPaths = cleanStatus.status === 'green' && typeof cleanStatus.stdout === 'string' ? parseChangedPaths(cleanStatus.stdout) : null
      if (cleanPaths === null) return stop('paths-unmeasured', cleanStatus)
      if (cleanPaths.length > 0) return stop('dirty-worktree', cleanStatus)
      const cleanHead = await stage('post-rebase-clean', () => callCheck('post-rebase-clean', d.run, { cwd, command: 'git', args: ['rev-parse', 'HEAD'], timeoutMs }, { command: true }))
      if (cleanHead.status !== 'green') return stop(cleanHead.reason, cleanHead)
      if (typeof cleanHead.stdout !== 'string' || cleanHead.stdout.trim() !== rebased.head) return stop('dirty-worktree', cleanHead)
    }

    if (isFinish) {
      // The fused report the deciding session reads instead of the journal; a run that cannot write it is not ready.
      const reviewRounds = (fin.priorReviewRounds ?? 0) + rounds.reviewer
      const report = { schema: 'finish-report/1', lane: spec.id, stop: { reason: fin.stop.reason, observation: fin.stop.observation ?? null }, subject, body, head: rebased.head, reviewRounds, reviews: finishReviews, measurements }
      await d.writeFile(join(spec.taskDir, 'finish-report.json'), `${JSON.stringify(report, null, 2)}\n`)
      await emit('finish-ready', { status: 'ready-for-operator', head: rebased.head, subject, body, reviewRounds })
      return { status: 'done', reason: null, pr: null }
    }

    const published = await stage('publish', () => callCheck('publish', d.openPullRequest, {
      cwd, branch: spec.branch, base: spec.base, title: subject, body, closes: spec.closes ?? [], refs: spec.refs ?? [], timeoutMs,
    }))
    if (published.status !== 'green' || !published.pr || typeof published.pr !== 'object') return stop(published.reason ?? 'runner-threw', published)
    await emit('pr', { pr: published.pr })
    return { status: 'done', reason: null, pr: published.pr }
  } catch (error) {
    return stop('runner-threw', { threw: describe(error) })
  }
}
