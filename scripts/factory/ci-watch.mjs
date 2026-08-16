// scripts/factory/ci-watch.mjs — host-side branch push and CI check adjudication.
//
// NEVER FROM A WORKER PATH
// An autonomous agent never holds write access to the repository it was cloned
// from. The single push in this module refuses before it builds a push argv
// when the checkout is a linked worktree or lies under the crew root.
//
// WATCHES AND RECORDS ONLY
// Slice 1 dispatches nothing. No driver, dispatch, repair-brief or re-dispatch
// surface is named here; the repair dispatch is slice 2 (#253).

import { spawnSync as cpSpawnSync } from 'node:child_process'
import { existsSync as fsExistsSync, realpathSync as fsRealpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { CI_CLASSIFICATIONS, CI_DECISIONS } from './ledger.mjs'
import { recordCiCycle as emitRecordCiCycle } from './emit.mjs'

// This repository's one real check is `.github/workflows/test.yml:9`; #252's
// repo profile is the generaliser. Slice 1 deliberately ratifies this local
// CI shape instead of pretending to have a cross-repository profile.
export const CI_CHECKS = Object.freeze(['test (node 24)'])
export const LOCAL_LANE = Object.freeze(['node', '--test', '--test-timeout=30000'])
export const UNKNOWN_REASONS = Object.freeze([
  'ci-failures-unparseable', 'local-lane-unrunnable',
  'local-failures-disjoint', 'conclusion-not-adjudicable',
])
export const PUSH_REFUSALS = Object.freeze(['worker-path', 'checkout-missing', 'branch-unresolved', 'push-failed'])

function defaultChecks(d, request) {
  const args = request.action === 'runs'
    ? ['api', `repos/{owner}/{repo}/commits/${request.headSha}/check-runs`, '--paginate']
    : ['run', 'view', request.logRef, '--log']
  let result
  try {
    result = d.spawnSync('gh', args, { encoding: 'utf8' })
  } catch (err) {
    return { status: 128, stdout: '', stderr: String(err?.message || err) }
  }
  if (result?.error) {
    return { status: 128, stdout: '', stderr: String(result.error.message || result.error) }
  }
  if (result?.status !== 0) return result
  const stdout = result?.stdout ?? ''
  if (request.action === 'log') return String(stdout)
  try { return JSON.parse(String(stdout)) } catch { return [] }
}

export function normalDeps(deps = {}) {
  const d = {
    spawnSync: deps.spawnSync || cpSpawnSync,
    existsSync: deps.existsSync || fsExistsSync,
    realpathSync: deps.realpathSync || fsRealpathSync,
    now: deps.now || (() => Date.now()),
  }
  d.checks = deps.checks || ((request) => defaultChecks(d, request))
  return d
}

export function runner(d) {
  return function git(where, args) {
    let result
    try {
      result = d.spawnSync('git', [...where, ...args], { encoding: 'utf8' })
    } catch (err) {
      return { status: 128, stdout: '', stderr: String(err?.message || err) }
    }
    if (result?.error) return { status: 128, stdout: '', stderr: String(result.error.message || result.error) }
    return {
      status: result?.status,
      stdout: String(result?.stdout || '').trim(),
      stderr: String(result?.stderr || '').trim(),
    }
  }
}

function realPathOr(d, path) {
  try { return d.realpathSync(path) } catch { return resolve(path) }
}

function isUnder(root, target) {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep))
}

export function isWorkerPath({ checkout, crewRoot = join(homedir(), '.crew'), deps = {} } = {}) {
  const d = normalDeps(deps)
  const git = runner(d)
  let linked = false
  try {
    const result = git(
      ['-C', checkout],
      ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'],
    )
    const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    linked = result.status === 0 && lines.length >= 2 && lines[0] !== lines[1]
  } catch {
    linked = false
  }
  let underCrew = false
  try {
    underCrew = isUnder(realPathOr(d, crewRoot), realPathOr(d, checkout))
  } catch {
    underCrew = false
  }
  return { worker: linked || underCrew, why: linked || underCrew ? 'worker-path' : null }
}

export function pushBranch({ checkout, branch, remote = 'origin', crewRoot, deps = {} } = {}) {
  const d = normalDeps(deps)
  const git = runner(d)
  let runBranch = branch ?? null
  try {
    if (typeof checkout !== 'string' || checkout.length === 0 || !d.existsSync(checkout)) {
      return { ok: false, reason: 'checkout-missing', remote, branch: runBranch }
    }

    const worker = isWorkerPath({ checkout, crewRoot, deps: d })
    // This gate must precede branch resolution and the construction of any
    // argv containing `push`: worker paths can never publish to the host.
    if (worker.worker) return { ok: false, reason: 'worker-path', remote, branch: runBranch }

    if (runBranch == null) {
      const symbolic = git(
        ['-C', checkout],
        ['symbolic-ref', '--short', '--quiet', 'HEAD'],
      )
      if (symbolic.status !== 0 || !symbolic.stdout) {
        return { ok: false, reason: 'branch-unresolved', remote, branch: runBranch }
      }
      runBranch = symbolic.stdout
    }
    if (typeof runBranch !== 'string' || runBranch.length === 0) {
      return { ok: false, reason: 'branch-unresolved', remote, branch: runBranch }
    }

    const pushed = git(['-C', checkout], ['push', remote, runBranch])
    if (pushed.status !== 0) {
      return { ok: false, reason: 'push-failed', stderr: pushed.stderr, remote, branch: runBranch }
    }
    return { ok: true, remote, branch: runBranch }
  } catch {
    return { ok: false, reason: 'push-failed', remote, branch: runBranch }
  }
}

function invokeChecks(d, request) {
  try {
    if (typeof d.checks === 'function') {
      // A two-argument seam is also accepted for small fakes that prefer an
      // operation name followed by its request object.
      return d.checks.length >= 2
        ? d.checks(request.action, request)
        : d.checks(request)
    }
    if (d.checks && typeof d.checks[request.action] === 'function') return d.checks[request.action](request)
    if (request.action === 'runs' && d.checks && typeof d.checks.fetchCheckRuns === 'function') return d.checks.fetchCheckRuns(request)
    if (request.action === 'log' && d.checks && typeof d.checks.fetchCheckLog === 'function') return d.checks.fetchCheckLog(request)
    if (request.action === 'runs' && d.checks && typeof d.checks.list === 'function') return d.checks.list(request)
    if (request.action === 'log' && d.checks && typeof d.checks.fetchLog === 'function') return d.checks.fetchLog(request)
    if (request.action === 'runs' && d.checks && Array.isArray(d.checks.runs)) return d.checks.runs
    if (request.action === 'log' && d.checks && typeof d.checks.log === 'string') return d.checks.log
  } catch {
    return null
  }
  return null
}

function checkRows(value) {
  if (typeof value === 'string') {
    try { return checkRows(JSON.parse(value)) } catch { return [] }
  }
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return []
  if (value.status != null && value.status !== 0) return []
  if (typeof value.stdout === 'string') return checkRows(value.stdout)
  if (Array.isArray(value.check_runs)) return value.check_runs
  if (Array.isArray(value.checks)) return value.checks
  if (Array.isArray(value.runs)) return value.runs
  if (value.check_name || value.name) return [value]
  return []
}

export function fetchCheckRuns({ branch, headSha, deps = {} } = {}) {
  const d = normalDeps(deps)
  const response = invokeChecks(d, { action: 'runs', kind: 'runs', branch, headSha })
  const rows = checkRows(response)
  const byName = new Map()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const name = row.check_name ?? row.name
    if (typeof name !== 'string' || !CI_CHECKS.includes(name) || byName.has(name)) continue
    byName.set(name, {
      check_name: name,
      conclusion: row.conclusion ?? 'unknown',
      log_ref: row.log_ref ?? row.logRef ?? row.details_url ?? row.url ?? null,
    })
  }
  return CI_CHECKS.map((checkName) => byName.get(checkName) || {
    check_name: checkName,
    conclusion: 'unknown',
    log_ref: null,
  })
}

export function fetchCheckLog({ logRef, deps = {} } = {}) {
  if (logRef == null) return null
  const d = normalDeps(deps)
  const response = invokeChecks(d, { action: 'log', kind: 'log', logRef })
  if (response == null) return null
  if (typeof response === 'string') return response
  if (typeof response === 'object') {
    if (response.error || (response.status != null && response.status !== 0)) return null
    if (typeof response.log === 'string') return response.log
    if (typeof response.text === 'string') return response.text
    if (typeof response.stdout === 'string') return response.stdout
    if (typeof response.body === 'string') return response.body
  }
  return null
}

function lineWithoutCr(line) {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

export function extractFailure(logText) {
  const text = logText == null ? '' : String(logText)
  const lines = text.split('\n')
  const failures = []
  const blocks = []

  for (let i = 0; i < lines.length; i++) {
    const line = lineWithoutCr(lines[i])
    const match = line.match(/^not ok \d+ - (.+)$/)
    if (!match) continue
    failures.push(match[1].trim())
    let end = i
    let next = i + 1
    const startsYaml = next < lines.length && (
      /^\s/.test(lineWithoutCr(lines[next])) || /^\s*\.\.\.\s*$/.test(lineWithoutCr(lines[next]))
    )
    if (startsYaml) {
      while (next < lines.length) {
        const yamlLine = lineWithoutCr(lines[next])
        if (/^\s*\.\.\.\s*$/.test(yamlLine)) {
          end = next
          break
        }
        if (yamlLine !== '' && !/^\s/.test(yamlLine)) break
        end = next
        next += 1
      }
    }
    blocks.push(lines.slice(i, end + 1).join('\n'))
    i = end
  }

  if (failures.length > 0) {
    return { excerpt: blocks.join('\n'), failures, source: 'check-log' }
  }
  return {
    excerpt: lines.slice(-200).join('\n'),
    failures: [],
    source: 'check-log-tail-200',
  }
}

export function runLocalLane({ checkout, deps = {} } = {}) {
  const d = normalDeps(deps)
  let result
  try {
    result = d.spawnSync(LOCAL_LANE[0], LOCAL_LANE.slice(1), { cwd: checkout, encoding: 'utf8' })
  } catch {
    return { ran: false, exit: null, failures: [], lane: [...LOCAL_LANE] }
  }
  if (result?.error) return { ran: false, exit: null, failures: [], lane: [...LOCAL_LANE] }
  const extracted = extractFailure(result?.stdout ?? '')
  return {
    ran: true,
    exit: result?.status ?? null,
    failures: extracted.failures,
    lane: [...LOCAL_LANE],
  }
}

export function classifyRed({ conclusion, ciFailures = [], local = {} } = {}) {
  if (conclusion === 'success') return { classification: 'green', reason: null }
  if (conclusion !== 'failure') return { classification: 'unknown', reason: 'conclusion-not-adjudicable' }
  if (!Array.isArray(ciFailures) || ciFailures.length === 0) {
    return { classification: 'unknown', reason: 'ci-failures-unparseable' }
  }
  if (!local.ran) return { classification: 'unknown', reason: 'local-lane-unrunnable' }
  if (local.exit === 0) return { classification: 'platform-divergent', reason: 'local-lane-green' }
  const localFailures = Array.isArray(local.failures) ? local.failures : []
  const localSet = new Set(localFailures)
  if (ciFailures.some((failure) => localSet.has(failure))) {
    return { classification: 'reproduced', reason: 'local-lane-reproduced' }
  }
  return { classification: 'unknown', reason: 'local-failures-disjoint' }
}

export function decisionFor(classification) {
  if (!CI_CLASSIFICATIONS.includes(classification)) {
    throw new Error('decisionFor: classification is outside CI_CLASSIFICATIONS')
  }
  if (classification === 'green') return 'none'
  // Only `reproduced` maps to `repair`; a red that does not reproduce locally
  // parks on cycle one and never retries, because retrying a Linux-only
  // failure from a macOS host wastes a cycle by construction (the #234 class).
  if (classification === 'reproduced') return 'repair'
  if (classification === 'platform-divergent') return 'park'
  return 'park'
}

function resolveHeadSha(checkout, branch, d) {
  const git = runner(d)
  const result = git(
    ['-C', checkout],
    ['rev-parse', '--verify', '--quiet', `${branch}^{commit}`],
  )
  return result.status === 0 && result.stdout ? result.stdout : null
}

function watchNow(d) {
  try { return d.now() } catch { return Date.now() }
}

export function ciWatchRun({
  checkout,
  branch,
  cycle = 1,
  adwId = null,
  taskSlug = null,
  repoSlug = null,
  dbPath = null,
  crewRoot,
  deps = {},
} = {}) {
  const d = normalDeps(deps)
  try {
    const pushed = pushBranch({ checkout, branch, crewRoot, deps: d })
    if (!pushed.ok) {
      return { ok: false, pushed: false, reason: pushed.reason, cycles: [] }
    }

    const headSha = resolveHeadSha(checkout, pushed.branch, d)
    if (!headSha) {
      return { ok: false, pushed: true, reason: 'branch-unresolved', cycles: [] }
    }
    const checks = fetchCheckRuns({ branch: pushed.branch, headSha, deps: d })
    const cycles = []

    for (const check of checks) {
      let extracted = { excerpt: null, failures: [], source: null }
      let local = { ran: false, exit: null, failures: [], lane: [...LOCAL_LANE] }
      let localAttempted = false
      if (check.conclusion !== 'success') {
        extracted = extractFailure(fetchCheckLog({ logRef: check.log_ref, deps: d }))
        if (check.conclusion === 'failure' && extracted.failures.length > 0) {
          localAttempted = true
          local = runLocalLane({ checkout, deps: d })
        }
      }
      const adjudication = classifyRed({
        conclusion: check.conclusion,
        ciFailures: extracted.failures,
        local,
      })
      const decision = decisionFor(adjudication.classification)
      const row = {
        adw_id: adwId,
        task_slug: taskSlug,
        repo_slug: repoSlug,
        branch: pushed.branch,
        head_sha: headSha,
        check_name: check.check_name,
        cycle,
        conclusion: check.conclusion,
        classification: adjudication.classification,
        decision,
        reason: adjudication.reason,
        excerpt: extracted.excerpt,
        excerpt_source: extracted.source,
        local_lane: localAttempted ? LOCAL_LANE.join(' ') : null,
        local_exit: localAttempted ? local.exit : null,
        created_at: watchNow(d),
      }
      try {
        emitRecordCiCycle({ dbPath, ...row })
      } catch {
        // The facade is non-throwing by contract; retain the cycle result even
        // if a test seam or a future facade implementation violates it.
      }
      cycles.push(row)
    }
    return { ok: true, pushed: true, cycles }
  } catch {
    return { ok: false, pushed: false, reason: 'push-failed', cycles: [] }
  }
}
