// Harvest is pull-only: it never integrates histories and writes only refs/factory/*.

import { spawnSync as cpSpawnSync } from 'node:child_process'
import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from 'node:fs'
import { join } from 'node:path'

export const HARVEST_REASONS = Object.freeze([
  'adw-id-invalid', 'checkout-missing', 'pin-unknown', 'pin-missing',
  'branch-unresolved', 'not-descendant', 'non-fast-forward', 'fetch-failed',
])

export const HARVEST_STATUSES = Object.freeze({
  CREATED: 'created', UPDATED: 'updated', UNCHANGED: 'unchanged', EMPTY: 'empty',
})

export function factoryRef(adwId) { return `refs/factory/${adwId}` }

function normalDeps(deps = {}) {
  return {
    spawnSync: deps.spawnSync || cpSpawnSync,
    existsSync: deps.existsSync || fsExistsSync,
    readFileSync: deps.readFileSync || fsReadFileSync,
  }
}

function runner(d) {
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

export function harvestRun({
  repo = null,
  crewDir = null,
  checkout = null,
  adwId,
  pin = null,
  branch = null,
  deps = {},
} = {}) {
  const d = normalDeps(deps)
  const git = runner(d)

  let resolvedCheckout = checkout
  let resolvedPin = pin
  if (crewDir) {
    const crewPath = join(crewDir, 'crew.json')
    if (d.existsSync(crewPath)) {
      let crew = null
      try { crew = JSON.parse(d.readFileSync(crewPath, 'utf8')) } catch { /* invalid metadata is treated as absent */ }
      if (crew && typeof crew === 'object' && !Array.isArray(crew)) {
        resolvedCheckout = resolvedCheckout ?? crew.checkout ?? null
        resolvedPin = resolvedPin ?? crew.base ?? null
      }
    }
  }

  if (typeof adwId !== 'string' || adwId.length === 0) {
    return { ok: false, reason: 'adw-id-invalid', adwId }
  }
  const ref = factoryRef(adwId)
  if (git([], ['check-ref-format', ref]).status !== 0) {
    return { ok: false, reason: 'adw-id-invalid', adwId }
  }

  if (typeof resolvedCheckout !== 'string' || resolvedCheckout.length === 0 || !d.existsSync(resolvedCheckout)) {
    return { ok: false, reason: 'checkout-missing', checkout: resolvedCheckout }
  }
  const common = git(
    ['-C', resolvedCheckout],
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  )
  if (common.status !== 0 || !common.stdout) {
    return { ok: false, reason: 'checkout-missing', checkout: resolvedCheckout }
  }
  const host = repo ? ['-C', repo] : ['--git-dir', common.stdout]

  if (!resolvedPin) return { ok: false, reason: 'pin-unknown' }
  const pinResult = git(
    ['-C', resolvedCheckout],
    ['rev-parse', '--verify', '--quiet', `${resolvedPin}^{commit}`],
  )
  if (pinResult.status !== 0 || !pinResult.stdout) {
    return { ok: false, reason: 'pin-missing', pin: resolvedPin }
  }
  const pinSha = pinResult.stdout
  if (git(host, ['cat-file', '-e', `${pinSha}^{commit}`]).status !== 0) {
    return { ok: false, reason: 'pin-missing', pin: resolvedPin }
  }

  let runBranch = branch
  if (runBranch == null) {
    const symbolic = git(
      ['-C', resolvedCheckout],
      ['symbolic-ref', '--short', '--quiet', 'HEAD'],
    )
    if (symbolic.status !== 0 || !symbolic.stdout) {
      return { ok: false, reason: 'branch-unresolved', checkout: resolvedCheckout }
    }
    runBranch = symbolic.stdout
  }
  const headResult = git(
    ['-C', resolvedCheckout],
    ['rev-parse', '--verify', '--quiet', `${runBranch}^{commit}`],
  )
  if (headResult.status !== 0 || !headResult.stdout) {
    return { ok: false, reason: 'branch-unresolved', branch: runBranch }
  }
  const head = headResult.stdout
  const base = { adwId, ref, pin: pinSha, branch: runBranch, head }

  if (git(['-C', resolvedCheckout], ['merge-base', '--is-ancestor', pinSha, head]).status !== 0) {
    return { ok: false, reason: 'not-descendant', ...base }
  }

  const countResult = git(
    ['-C', resolvedCheckout],
    ['rev-list', '--count', `${pinSha}..${head}`],
  )
  const commits = Number(countResult.stdout || '0')
  if (commits === 0) {
    return { ok: true, status: HARVEST_STATUSES.EMPTY, ...base, ref: null, commits: 0 }
  }

  const existingResult = git(host, ['rev-parse', '--verify', '--quiet', ref])
  const existing = existingResult.status === 0 && existingResult.stdout ? existingResult.stdout : null
  if (existing === head) {
    return { ok: true, status: HARVEST_STATUSES.UNCHANGED, ...base, commits }
  }
  if (existing && git(host, ['merge-base', '--is-ancestor', existing, head]).status !== 0) {
    return { ok: false, reason: 'non-fast-forward', ...base, existing }
  }

  const fetched = git(
    host,
    ['fetch', '--no-tags', '--no-write-fetch-head', resolvedCheckout, `${head}:${ref}`],
  )
  if (fetched.status !== 0) {
    return { ok: false, reason: 'fetch-failed', ...base, stderr: fetched.stderr }
  }

  return {
    ok: true,
    status: existing ? HARVEST_STATUSES.UPDATED : HARVEST_STATUSES.CREATED,
    ...base,
    commits,
  }
}
