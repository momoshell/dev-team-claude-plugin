// The ADR-052 standard loop: plan -> gate baseline (red) -> build -> gate (green) -> mutation
// proof -> review -> suite -> commit -> PR. Import-only: every effect (seat turn, filesystem,
// check, git, journal) crosses an injected seam, and nothing here is wired to the boot path yet.
// A seat's return is never trusted from the callback: the envelope is read back from the path
// the loop issued, parsed and validated as P2, and must carry the id the loop issued.
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveAgents } from './agents.mjs'
import {
  CHECK_REASONS, checkBaseline, commitChanges, openPullRequest, proveMutations, rebaseBranch, runGate, runSuite,
} from './checks.mjs'
import { TIERS, validateEnvelope } from './protocols.mjs'
import { proveRequiredSkills } from './skills-proof.mjs'

export const DEFAULT_ROUNDS = 2
const MAX_ENVELOPE_REPAIRS = 1
export const LOOP_REASONS = Object.freeze([
  ...CHECK_REASONS, 'unsupported-shape', 'envelope-refused', 'seat-unmeasured', 'lead-escalated', 'lead-unavailable',
  'lead-refused', 'accept-unmeasured', 'round-bound', 'paths-unmeasured',
])

const REQUIRED_ROLES = ['planner', 'builder', 'reviewer']
const text = (v) => typeof v === 'string' && v !== ''
const strings = (v) => Array.isArray(v) && v.every(text)
const describe = (error) => ({ code: error?.code ?? null, message: String(error?.message ?? error) })
const refusal = (reason) => ({ status: 'stopped', reason, pr: null })

// `git status --porcelain=v1 -z`: `XY path` records, a rename or copy (in either column) followed by its
// source. Returns every path named, or null when the output is truncated, mis-framed or names an unsafe path.
function parseChangedPaths(stdout) {
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
    for (const path of named) paths.add(path)
  }
  return [...paths]
}

export async function runLoop(spec, deps = {}) {
  // Nothing is read or run until every field and seam is sound.
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return refusal('invalid-input')
  if (spec.shape !== 'standard') return refusal('unsupported-shape')
  const sound = [spec.id, spec.cwd, spec.taskDir, spec.brief, spec.source, spec.branch, spec.base].every(text) && TIERS.includes(spec.tier)
    && strings(spec.acceptance) && spec.acceptance.length > 0 && new Set(spec.acceptance).size === spec.acceptance.length
    && text(spec.suite?.command) && (spec.suite.args === undefined || Array.isArray(spec.suite.args))
    && (spec.suite.timeoutMs === undefined || (Number.isSafeInteger(spec.suite.timeoutMs) && spec.suite.timeoutMs > 0))
    && [spec.closes, spec.refs].every((v) => v === undefined || Array.isArray(v))
    && (spec.timeoutMs === undefined || (Number.isSafeInteger(spec.timeoutMs) && spec.timeoutMs > 0))
  if (!sound) return refusal('invalid-input')
  const d = {
    resolveAgents, mkdir, readFile, checkBaseline, runGate, proveMutations, runSuite, commitChanges, rebaseBranch, openPullRequest,
    run: runSuite,
    journal: async (row) => appendFile(join(spec.taskDir, 'journal.jsonl'), `${JSON.stringify(row)}\n`),
    ...deps,
  }
  const seams = ['runSeat', 'resolveAgents', 'mkdir', 'readFile', 'journal', 'checkBaseline', 'runGate', 'proveMutations', 'runSuite', 'commitChanges', 'rebaseBranch', 'openPullRequest', 'run']
  if (!seams.every((name) => typeof d[name] === 'function')) return refusal('invalid-input')
  let resolved
  try { resolved = d.resolveAgents(spec.tier) } catch { return refusal('seat-unmeasured') }
  const seats = { ...resolved?.seats }
  if (!REQUIRED_ROLES.every((role) => seats[role] && typeof seats[role] === 'object')) return refusal('seat-unmeasured')
  const bounded = (cell) => cell.rounds === undefined || (Number.isSafeInteger(cell.rounds) && cell.rounds > 0)
  if (!Object.values(seats).every(bounded)) return refusal('invalid-input')

  const { cwd, timeoutMs } = spec
  const { journal } = d
  const rounds = { planner: 0, builder: 0, reviewer: 0, lead: 0 }
  const last = {}
  let where = null
  let turn = 0
  let planPath = null
  let gatePath = null
  let changedPaths = []

  const emit = async (event, fields) => {
    const row = { event, lane: spec.id, stage: where, ...fields }
    try { await journal(row) } catch {}
  }
  const stop = async (reason, observation) => {
    const closed = LOOP_REASONS.includes(reason) ? reason : 'runner-threw'
    await emit('verdict', { status: 'stopped', reason: closed, observation })
    return refusal(closed)
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
  // A valid non-done envelope, or an exhausted bound, is put to the lead.
  const seatTurn = async (role, feedback = []) => {
    for (;;) {
      let held
      if (rounds[role] >= (seats[role].rounds ?? DEFAULT_ROUNDS)) {
        held = { reason: 'round-bound', envelope: null }
      } else {
        turn += 1
        rounds[role] += 1
        const id = `${spec.id}.${role}.${turn}`
        const returnPath = join(spec.taskDir, `${role}-${turn}.json`)
        const request = { role, seat: seats[role], id, returnPath, brief: spec.brief, planPath, gatePath, feedback, ...(role === 'reviewer' ? { changedPaths } : {}) }
        // One attempt: run the seat, then read the issued path back, parse it and validate it in full.
        const attempt = async (asked) => {
          let failure = null
          let parsed = null
          let recording = null
          try { recording = await d.runSeat(asked) } catch (error) { failure = { reason: 'seat-unmeasured', error: describe(error) } }
          let raw = null
          if (!failure) {
            try { raw = await d.readFile(returnPath, 'utf8') } catch (error) { failure = { reason: 'seat-unmeasured', error: describe(error) } }
          }
          if (!failure && (typeof raw !== 'string' || raw.trim() === '')) failure = { reason: 'seat-unmeasured', error: { code: null, message: 'the seat returned an empty file' } }
          if (!failure) {
            try { parsed = JSON.parse(raw) } catch (error) { failure = { reason: 'envelope-refused', error: describe(error) } }
          }
          const checked = failure ? { envelope: null, defects: [] } : validateEnvelope(role, parsed)
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
        if (checked.envelope.status === 'done') return { envelope: checked.envelope }
        held = { reason: checked.envelope.status, envelope: checked.envelope }
      }
      // The lead is never consulted about itself: no recursion, an unusable lead turn ends the lane.
      if (role === 'lead') return { halt: await stop(held.envelope ? 'lead-refused' : 'round-bound', held) }
      const decided = await consultLead(role, held, feedback)
      if (decided.halt) return decided
      if (decided.decision === 'accept') return { envelope: held.envelope }
      // bounce: exactly one more turn for this role, beyond its bound only if the bound is spent; the counter keeps its history
      seats[role] = { ...seats[role], rounds: Math.max(seats[role].rounds ?? DEFAULT_ROUNDS, rounds[role] + 1) }
    }
  }
  // accept releases only a schema-valid envelope the seat itself returned; it never stands in for a measurement.
  const consultLead = async (role, held, feedback) => {
    if (!seats.lead) return { halt: await stop('lead-unavailable', { role, ...held }) }
    const asked = await stage('lead', () => seatTurn('lead', [{ role, reason: held.reason, envelope: held.envelope ?? last[role] ?? null, feedback }]))
    if (asked.halt) return asked
    const { decision } = asked.envelope.details
    if (decision === 'escalate') return { halt: await stop('lead-escalated', { role, ...held }) }
    if (decision === 'accept' && !held.envelope) return { halt: await stop('accept-unmeasured', { role, ...held }) }
    return { decision }
  }

  try {
    try { await d.mkdir(spec.taskDir, { recursive: true }) } catch (error) { return await stop('runner-threw', { mkdir: describe(error) }) }

    const planned = await stage('plan', () => seatTurn('planner'))
    if (planned.halt) return planned.halt
    const { acceptance, subject } = planned.envelope.details
    const mutations = planned.envelope.details.mutations
    planPath = planned.envelope.details.plan_path
    gatePath = planned.envelope.details.gate_path
    if (acceptance.length !== spec.acceptance.length || !acceptance.every((id) => spec.acceptance.includes(id))) return await stop('envelope-refused', { acceptance })

    const measurements = []
    const baseline = await stage('baseline', () => callCheck('baseline', d.checkBaseline, { cwd, gatePath, timeoutMs }))
    if (!baseline.accepted) return stop(baseline.reason, baseline)
    if (baseline.reason !== 'gate-failed' || baseline.result?.status !== 'red' || baseline.result.reason !== 'gate-failed' || !(baseline.result.failingIds?.length > 0)) return stop('runner-threw', baseline)
    measurements.push(`- Baseline gate: ${baseline.result.status}; failing ids: ${baseline.result.failingIds.join(', ')}.`)

    let feedback = []
    for (;;) {
      const built = await stage('build', () => seatTurn('builder', feedback))
      if (built.halt) return built.halt
      const gate = await stage('gate', () => callCheck('gate', d.runGate, { cwd, gatePath, timeoutMs }, { command: true }))
      if (gate.status !== 'green') return stop(gate.reason, gate)
      measurements.push(`- Gate: ${gate.status}.`)

      const proof = await stage('mutations', () => callCheck('mutations', d.proveMutations, { cwd, gatePath, checks: acceptance, mutations, timeoutMs }))
      const rows = Array.isArray(proof.rows) ? proof.rows : []
      const proofOK = proof.status === 'green' && proof.reason === null && rows.length === acceptance.length
        && acceptance.every((id) => rows.filter((row) => row?.check === id && row.outcome === 'killed' && row.reason === null).length === 1)
      if (!proofOK) return stop(proof.reason ?? 'mutation-unmeasured', proof)
      measurements.push(`- Mutations: ${rows.filter((row) => row.outcome === 'killed').length}/${acceptance.length} killed (${rows.map((row) => `${row.check}: ${row.outcome}`).join(', ')}).`)

      // The reviewer is told what git reports changed now, remeasured every round; an unreadable status stops the lane.
      const status = await stage('review-paths', () => callCheck('review-paths', d.run, { cwd, command: 'git', args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'], timeoutMs }, { command: true }))
      changedPaths = status.status === 'green' && typeof status.stdout === 'string' ? parseChangedPaths(status.stdout) : null
      if (changedPaths === null) return stop('paths-unmeasured', status)

      const reviewed = await stage('review', () => seatTurn('reviewer'))
      if (reviewed.halt) return reviewed.halt
      const review = reviewed.envelope
      await emit('verdict', { status: 'reviewed', verdict: review.details.verdict, findings: review.details.findings })
      if (review.details.verdict === 'changes-needed') {
        feedback = review.details.findings
        continue
      }
      break
    }

    const runSuite = () => stage('suite', () => callCheck('suite', d.runSuite, { cwd, command: spec.suite.command, args: spec.suite.args, timeoutMs: spec.suite.timeoutMs ?? timeoutMs }, { command: true }))
    const suite = await runSuite()
    // Only a measured red is run once more; an unmeasured suite stops as it is, and the first red stays in the PR text.
    if (suite.status === 'red') {
      measurements.push(`- Suite: ${suite.status}; exit ${suite.code}.`)
      const rerun = await runSuite()
      if (rerun.status !== 'green') return stop(rerun.status === 'red' ? suite.reason : rerun.reason, rerun)
      measurements.push(`- Suite re-run: ${rerun.status}; exit ${rerun.code}.`)
    } else {
      if (suite.status !== 'green') return stop(suite.reason, suite)
      measurements.push(`- Suite: ${suite.status}; exit ${suite.code}.`)
    }
    const body = [`Source: ${JSON.stringify(spec.source)}`, '', '## Acceptance', ...acceptance.map((id) => `- ${id}`), '', '## Measurements', ...measurements].join('\n')

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
