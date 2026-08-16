// Arms is pull-only and write-limited: it appends manifest records and calls
// harvestRun; it never pushes, merges histories, creates branches, or mutates
// run checkouts.

import { spawnSync as cpSpawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  appendFileSync as fsAppendFileSync,
  existsSync as fsExistsSync,
  mkdirSync as fsMkdirSync,
  readFileSync as fsReadFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { harvestRun } from './harvest.mjs'

export const ARM_AXES = Object.freeze(['prompt', 'roster', 'model'])

export const ARM_APPEND_REASONS = Object.freeze([
  'set-id-invalid', 'adw-id-invalid', 'axes-invalid', 'axis-unknown',
  'pin-missing', 'crew-dir-missing', 'duplicate-arm', 'write-failed',
])

export const ARM_SET_STATUSES = Object.freeze({
  COLLECTED: 'collected', REFUSED: 'refused',
})

export const ARM_SET_REASONS = Object.freeze([
  'manifest-missing', 'manifest-empty', 'manifest-unreadable',
  'set-id-mismatch', 'duplicate-arm', 'pin-unresolved', 'pin-drift',
  'pin-mismatch',
])

export const COST_ABSENT = 'absent'

const SET_ID_PATTERN = /^[A-Za-z0-9._-]+$/
const ARM_KIND = 'arm'
const COST_USAGE_KEYS = [
  'agent_sessions', 'billed_input_tokens', 'billed_output_tokens',
  'billed_cache_write_tokens', 'billed_cache_read_tokens',
]

function normalDeps(deps = {}) {
  const source = deps && typeof deps === 'object' ? deps : {}
  return {
    spawnSync: source.spawnSync || cpSpawnSync,
    existsSync: source.existsSync || fsExistsSync,
    readFileSync: source.readFileSync || fsReadFileSync,
    appendFileSync: source.appendFileSync || fsAppendFileSync,
    mkdirSync: source.mkdirSync || fsMkdirSync,
    now: source.now || (() => new Date().toISOString()),
    uuid: source.uuid || randomUUID,
    harvest: source.harvest || harvestRun,
    ledger: source.ledger || null,
  }
}

function validSetId(setId) {
  return typeof setId === 'string' && SET_ID_PATTERN.test(setId)
}

function validArmIdShape(adwId) {
  return typeof adwId === 'string' && adwId.length > 0 && !/[\u0000-\u0020~^:?*\\[\]]/.test(adwId)
    && !adwId.includes('..') && !adwId.endsWith('.') && !adwId.endsWith('/')
    && !adwId.startsWith('/') && !adwId.includes('//') && !adwId.includes('@{')
}

function gitRunner(d) {
  return function git(where, args) {
    let result
    try {
      result = d.spawnSync('git', [...where, ...args], { encoding: 'utf8' })
    } catch (err) {
      return { status: 128, stdout: '', stderr: String(err?.message || err) }
    }
    if (result?.error) {
      return { status: 128, stdout: '', stderr: String(result.error.message || result.error) }
    }
    return {
      status: result?.status,
      stdout: String(result?.stdout || '').trim(),
      stderr: String(result?.stderr || '').trim(),
    }
  }
}

function validArmId(adwId, d) {
  if (!validArmIdShape(adwId)) return false
  const result = gitRunner(d)([], ['check-ref-format', `refs/factory/${adwId}`])
  return result.status === 0
}

function validAxes(axes) {
  if (!axes || typeof axes !== 'object' || Array.isArray(axes)) return false
  for (const key of Object.keys(axes)) {
    if (typeof axes[key] !== 'string' || axes[key].trim().length === 0) return false
  }
  return true
}

function axisReason(axes) {
  if (!validAxes(axes)) return 'axes-invalid'
  if (Object.keys(axes).some((key) => !ARM_AXES.includes(key))) return 'axis-unknown'
  return null
}

function validPin(pin) {
  return typeof pin === 'string' && pin.trim().length > 0
}

function readJson(path, d) {
  try {
    return JSON.parse(d.readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function wellFormedArm(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false
  if (record.kind !== ARM_KIND || !validSetId(record.set_id)) return false
  if (!validArmIdShape(record.adw_id)) return false
  if (!validAxes(record.axes) || Object.keys(record.axes).some((key) => !ARM_AXES.includes(key))) return false
  if (!validPin(record.pin)) return false
  if (typeof record.crew_dir !== 'string' || record.crew_dir.trim().length === 0) return false
  if (record.checkout !== null && (typeof record.checkout !== 'string' || record.checkout.trim().length === 0)) return false
  if (typeof record.created_at !== 'string' || record.created_at.length === 0) return false
  return true
}

function failed(reason) {
  return { ok: false, reason }
}

export function armsManifestPath({ factoryRoot = null, setId } = {}) {
  if (!validSetId(setId)) return null
  const root = factoryRoot ?? (process.env.DEVTEAM_FACTORY_DIR || join(homedir(), '.dev-team', 'factory'))
  if (typeof root !== 'string' || root.length === 0) return null
  try { return join(root, 'arms', `${setId}.jsonl`) } catch { return null }
}

export function appendArm(input = {}) {
  const args = input && typeof input === 'object' ? input : {}
  try {
    const d = normalDeps(args.deps)
    const { manifestPath, setId, adwId, pin, crewDir, checkout = null } = args
    const axes = args.axes === undefined ? {} : args.axes

    if (!validSetId(setId)) return failed('set-id-invalid')
    if (!validArmId(adwId, d)) return failed('adw-id-invalid')
    const axesFailure = axisReason(axes)
    if (axesFailure) return failed(axesFailure)
    if (!validPin(pin)) return failed('pin-missing')
    if (typeof crewDir !== 'string' || crewDir.length === 0 || !d.existsSync(crewDir)) {
      return failed('crew-dir-missing')
    }

    d.mkdirSync(dirname(manifestPath), { recursive: true })

    let existing = ''
    if (d.existsSync(manifestPath)) {
      try {
        existing = String(d.readFileSync(manifestPath, 'utf8'))
      } catch {
        return failed('write-failed')
      }
      for (const line of existing.split(/\r?\n/)) {
        if (!line.trim()) continue
        let record
        try { record = JSON.parse(line) } catch { continue }
        if (record && typeof record === 'object' && !Array.isArray(record)
          && record.kind === ARM_KIND && record.adw_id === adwId) {
          return failed('duplicate-arm')
        }
      }
    }

    const arm = {
      kind: ARM_KIND,
      set_id: setId,
      adw_id: adwId,
      axes,
      pin,
      crew_dir: crewDir,
      checkout: checkout ?? null,
      created_at: d.now(),
    }
    const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
    d.appendFileSync(manifestPath, `${separator}${JSON.stringify(arm)}\n`)
    return { ok: true, arm }
  } catch {
    return failed('write-failed')
  }
}

export function readManifest(input = {}) {
  const args = input && typeof input === 'object' ? input : {}
  const d = normalDeps(args.deps)
  const { manifestPath } = args
  if (typeof manifestPath !== 'string' || manifestPath.length === 0) return failed('manifest-missing')

  let text
  try {
    if (!d.existsSync(manifestPath)) return failed('manifest-missing')
    text = d.readFileSync(manifestPath, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') return failed('manifest-missing')
    return failed('manifest-unreadable')
  }

  const lines = String(text).split(/\r?\n/)
  let lastNonEmpty = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim()) lastNonEmpty = index
  }

  const arms = []
  const seen = new Set()
  let setId = null
  let skipped = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim()) continue

    let record
    try {
      record = JSON.parse(line)
    } catch {
      if (index === lastNonEmpty || recoverableTornLine(lines, index)) {
        skipped += 1
        continue
      }
      return failed('manifest-unreadable')
    }
    if (!wellFormedArm(record)) return failed('manifest-unreadable')
    if (setId === null) setId = record.set_id
    else if (record.set_id !== setId) return failed('set-id-mismatch')
    if (seen.has(record.adw_id)) return failed('duplicate-arm')
    seen.add(record.adw_id)
    arms.push(record)
  }

  if (arms.length === 0) return failed('manifest-empty')
  return { ok: true, setId, arms, skipped }
}

// A separator added by appendArm can turn a formerly trailing torn line into
// an interior line; a valid next arm is evidence that this was that tail.
function recoverableTornLine(lines, index) {
  let next = index + 1
  while (next < lines.length && !lines[next].trim()) next += 1
  if (next >= lines.length) return false
  try { return wellFormedArm(JSON.parse(lines[next])) } catch { return false }
}

function crewMetadata(arm, d) {
  let path
  try { path = join(arm.crew_dir, 'crew.json') } catch { return null }
  try {
    if (!d.existsSync(path)) return null
  } catch {
    return null
  }
  const crew = readJson(path, d)
  return crew && typeof crew === 'object' && !Array.isArray(crew) ? crew : null
}

function resolveCommit(git, checkout, pin) {
  if (typeof checkout !== 'string' || checkout.length === 0 || !validPin(pin)) return null
  const result = git(
    ['-C', checkout],
    ['rev-parse', '--verify', '--quiet', `${pin}^{commit}`],
  )
  return result.status === 0 && result.stdout ? result.stdout : null
}

function refusal(_set, reason, extra = {}) {
  return {
    ok: false,
    status: ARM_SET_STATUSES.REFUSED,
    reason,
    ...extra,
  }
}

function controlPass(set, d) {
  const git = gitRunner(d)
  const bySha = new Map()

  for (const arm of set.arms) {
    const crew = crewMetadata(arm, d)
    const checkout = arm.checkout ?? (typeof crew?.checkout === 'string' ? crew.checkout : null)
    const manifestSha = resolveCommit(git, checkout, arm.pin)
    if (!manifestSha) {
      return refusal(set, 'pin-unresolved', {
        adw_id: arm.adw_id,
        pin: arm.pin,
        message: `arm ${arm.adw_id} pin ${arm.pin} cannot be resolved in ${checkout || 'its checkout'}`,
      })
    }

    const hasDiskPin = crew && Object.prototype.hasOwnProperty.call(crew, 'base') && crew.base != null
    if (hasDiskPin) {
      const diskPin = crew.base
      const diskSha = resolveCommit(git, checkout, diskPin)
      if (!diskSha) {
        return refusal(set, 'pin-unresolved', {
          adw_id: arm.adw_id,
          pin: diskPin,
          manifest_pin: arm.pin,
          manifest_sha: manifestSha,
          message: `arm ${arm.adw_id} on-disk pin ${String(diskPin)} cannot be resolved in ${checkout || 'its checkout'}`,
        })
      }
      if (diskSha !== manifestSha) {
        return refusal(set, 'pin-drift', {
          adw_id: arm.adw_id,
          pin: arm.pin,
          disk_pin: diskPin,
          manifest_sha: manifestSha,
          disk_sha: diskSha,
          message: `arm ${arm.adw_id} pin drift: manifest ${arm.pin} -> ${manifestSha}, crew.json base ${String(diskPin)} -> ${diskSha}`,
        })
      }
    }

    let group = bySha.get(manifestSha)
    if (!group) {
      group = { pin: arm.pin, sha: manifestSha, arms: [] }
      bySha.set(manifestSha, group)
    }
    group.arms.push(arm.adw_id)
  }

  if (bySha.size > 1) {
    const pins = [...bySha.values()]
    return refusal(set, 'pin-mismatch', {
      pins,
      message: `arms disagree on pin SHAs: ${pins.map((entry) => entry.sha).join(' vs ')}`,
    })
  }

  return { ok: true, pin: [...bySha.keys()][0] }
}

function armCost(adwId, d) {
  if (!d.ledger) return { cost: COST_ABSENT, cost_absent: 'no ledger handle supplied' }

  let readout
  try {
    readout = d.ledger.taskReadout(adwId)
  } catch (err) {
    const message = String(err?.message || err || 'ledger read failed')
    return { cost: COST_ABSENT, cost_absent: message || 'ledger read failed' }
  }

  if (readout?.degraded) return { cost: COST_ABSENT, cost_absent: 'ledger mirror degraded' }
  const absentReason = readout?.absent && readout.absent.usage
  if (readout?.usage == null || absentReason != null) {
    const reason = typeof absentReason === 'string' && absentReason.length > 0
      ? absentReason
      : 'usage not measured'
    return { cost: COST_ABSENT, cost_absent: reason }
  }

  if (typeof readout.usage !== 'object' || Array.isArray(readout.usage)) {
    return { cost: COST_ABSENT, cost_absent: 'usage not measured' }
  }
  const cost = {}
  for (const key of COST_USAGE_KEYS) cost[key] = readout.usage[key]
  return { cost }
}

export function collectArms({ manifestPath, repo = null, deps = {} } = {}) {
  const d = normalDeps(deps)
  const setRead = readManifest({ manifestPath, deps: d })
  if (!setRead.ok) {
    return { ...setRead, status: ARM_SET_STATUSES.REFUSED }
  }

  const set = { ...setRead, manifestPath }
  const control = controlPass(set, d)
  if (!control.ok) return control

  const counts = { created: 0, updated: 0, unchanged: 0, empty: 0, refused: 0 }
  const refusedArms = []
  const arms = []
  const harvestDeps = deps && typeof deps === 'object' ? deps : {}

  for (const arm of set.arms) {
    let harvest
    try {
      harvest = d.harvest({
        repo,
        crewDir: arm.crew_dir,
        checkout: arm.checkout,
        adwId: arm.adw_id,
        pin: arm.pin,
        deps: harvestDeps,
      })
    } catch (err) {
      harvest = { ok: false, reason: 'harvest-failed', message: String(err?.message || err) }
    }

    if (harvest?.ok === true && Object.prototype.hasOwnProperty.call(counts, harvest.status)) {
      counts[harvest.status] += 1
    } else {
      counts.refused += 1
      refusedArms.push(arm.adw_id)
    }

    arms.push({
      adw_id: arm.adw_id,
      axes: arm.axes,
      harvest,
      ...armCost(arm.adw_id, d),
    })
  }

  return {
    ok: true,
    status: ARM_SET_STATUSES.COLLECTED,
    set_id: set.setId,
    manifest_path: manifestPath,
    pin: control.pin,
    arms,
    counts,
    refused_arms: refusedArms,
    skipped: set.skipped,
  }
}

export const ARM_SPAWN_DEFAULT_N = 2
export const ARM_SPAWN_MAX_N = 4
export const ARM_SPAWN_STATUSES = Object.freeze({
  SPAWNED: 'spawned', PARTIAL: 'partial', REFUSED: 'refused',
})
export const ARM_SPAWN_REASONS = Object.freeze([
  'set-id-invalid', 'n-invalid', 'n-over-cap', 'repo-missing',
  'worktree-root-missing', 'worktree-exists', 'manifest-path-invalid',
  'axes-invalid', 'axis-unknown', 'pin-unresolved', 'worktree-failed',
  'arm-pin-mismatch', 'spawn-failed', 'spawn-id-missing', 'append-failed',
])

function spawnMessage(err, fallback) {
  const message = String(err?.message || err || '').trim()
  return message || fallback
}

function spawnRefusal(reason, message, extra = {}) {
  return {
    ok: false,
    status: ARM_SPAWN_STATUSES.REFUSED,
    reason,
    message,
    ...extra,
  }
}

function spawnPartial({ setId, manifestPath, pin, arms, index, phase, reason, message, failure = {}, ...extra }) {
  return {
    ok: false,
    status: ARM_SPAWN_STATUSES.PARTIAL,
    set_id: setId,
    manifest_path: manifestPath,
    pin,
    arms,
    failed: {
      index,
      phase,
      reason,
      message,
      ...extra,
      ...failure,
    },
  }
}

function usablePath(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function armSlug(setId, index) {
  return `${setId}-${String(index).padStart(2, '0')}`
}

function worktreeName(setId, index) {
  return `${setId}-arm${String(index).padStart(2, '0')}`
}

function factoryctlPath() {
  return fileURLToPath(new URL('./factoryctl.mjs', import.meta.url))
}

export function factoryctlSpawner(input = {}) {
  const args = input && typeof input === 'object' ? input : {}
  const axes = args.axes && typeof args.axes === 'object' && !Array.isArray(args.axes) ? args.axes : {}
  if (Object.prototype.hasOwnProperty.call(axes, 'model')) {
    return {
      ok: false,
      reason: 'axis-unsupported',
      message: 'factoryctl run does not support axis model',
    }
  }

  const d = normalDeps(args.deps)
  const brief = axes.prompt ?? args.brief
  const tier = axes.roster ?? args.tier
  const checkout = args.checkout
  const task = args.armSlug
  let result
  try {
    result = d.spawnSync(process.execPath, [
      factoryctlPath(), 'run',
      '--brief', brief,
      '--tier', tier,
      '--checkout', checkout,
      '--task', task,
    ], { encoding: 'utf8' })
  } catch (err) {
    return { ok: false, reason: 'spawn-failed', message: spawnMessage(err, 'factoryctl failed to start') }
  }

  if (result?.error || result?.status !== 0) {
    const stderr = String(result?.stderr || '').trim()
    return {
      ok: false,
      reason: 'spawn-failed',
      message: stderr || spawnMessage(result?.error, `factoryctl exited with status ${String(result?.status)}`),
    }
  }

  const lines = String(result?.stdout || '').split(/\r?\n/).reverse()
  let payload = null
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed
        break
      }
    } catch { /* keep looking for the JSON result line */ }
  }
  if (!payload) {
    return {
      ok: false,
      reason: 'spawn-failed',
      message: 'factoryctl returned no JSON run result',
    }
  }
  return { ok: true, adwId: payload.run_id, crewDir: payload.crew_dir }
}

export function spawnArmSet(input = {}) {
  const args = input && typeof input === 'object' ? input : {}
  const d = normalDeps(args.deps)

  const repo = args.repo
  if (!usablePath(repo)) {
    return spawnRefusal('repo-missing', 'repo must be a non-empty existing directory')
  }
  let repoExists = false
  try { repoExists = d.existsSync(repo) } catch { repoExists = false }
  if (!repoExists) {
    return spawnRefusal('repo-missing', `repo does not exist: ${repo}`)
  }

  const worktreeRoot = args.worktreeRoot
  if (!usablePath(worktreeRoot)) {
    return spawnRefusal('worktree-root-missing', 'worktreeRoot must be a non-empty path')
  }

  let setId = args.setId
  if (setId === undefined) {
    try {
      setId = `set-${String(d.uuid()).slice(0, 8)}`
    } catch (err) {
      return spawnRefusal('set-id-invalid', spawnMessage(err, 'could not create a set id'))
    }
  }
  if (!validSetId(setId)) {
    return spawnRefusal('set-id-invalid', `invalid set id: ${String(setId)}`)
  }

  const hasArms = args.arms !== undefined
  let n = hasArms ? (Array.isArray(args.arms) ? args.arms.length : null) : args.n
  if (!hasArms && (n === undefined || n === null)) n = ARM_SPAWN_DEFAULT_N
  if (!Number.isInteger(n) || n < 1) {
    return spawnRefusal('n-invalid', `n must be an integer greater than or equal to 1: ${String(n)}`)
  }
  if (n > ARM_SPAWN_MAX_N) {
    return spawnRefusal('n-over-cap', `n ${n} exceeds ARM_SPAWN_MAX_N cap ${ARM_SPAWN_MAX_N}`)
  }

  let armSpecs
  if (hasArms) {
    if (!Array.isArray(args.arms)) {
      return spawnRefusal('n-invalid', 'arms must be an array when supplied')
    }
    armSpecs = args.arms.map((arm) => {
      if (!arm || typeof arm !== 'object' || Array.isArray(arm)) return { axes: null }
      return { axes: arm.axes === undefined ? {} : arm.axes }
    })
  } else {
    armSpecs = Array.from({ length: n }, () => ({ axes: {} }))
  }

  for (const spec of armSpecs) {
    const axesFailure = axisReason(spec?.axes)
    if (axesFailure) {
      return spawnRefusal(axesFailure, axesFailure === 'axis-unknown'
        ? 'arm axes contain an unknown axis'
        : 'arm axes must be a non-empty string map')
    }
  }

  let manifestPath = args.manifestPath
  if (manifestPath === undefined) {
    try { manifestPath = armsManifestPath({ setId }) } catch { manifestPath = null }
  }
  if (!usablePath(manifestPath) || manifestPath.includes('\u0000')) {
    return spawnRefusal('manifest-path-invalid', 'manifestPath must be a non-empty path')
  }

  const git = gitRunner(d)
  const pin = args.pin === undefined ? 'HEAD' : args.pin
  if (!validPin(pin)) {
    return spawnRefusal('pin-unresolved', `pin ${String(pin)} cannot be resolved in ${repo}`)
  }
  const pinResult = git(
    ['-C', repo],
    ['rev-parse', '--verify', '--quiet', `${pin}^{commit}`],
  )
  if (pinResult.status !== 0 || !pinResult.stdout) {
    return spawnRefusal('pin-unresolved', `pin ${String(pin)} cannot be resolved in ${repo}`)
  }
  const setPin = pinResult.stdout

  const planned = armSpecs.map((_spec, offset) => {
    const index = offset + 1
    return {
      index,
      dir: join(worktreeRoot, worktreeName(setId, index)),
      branch: `arms/${setId}/${String(index).padStart(2, '0')}`,
    }
  })
  for (const plan of planned) {
    let exists = false
    try { exists = d.existsSync(plan.dir) } catch { exists = true }
    if (exists) {
      return spawnRefusal('worktree-exists', `worktree path already exists: ${plan.dir}`, { path: plan.dir })
    }
  }

  const spawner = args.spawn === undefined ? factoryctlSpawner : args.spawn
  const spawnedArms = []
  for (let offset = 0; offset < planned.length; offset += 1) {
    const plan = planned[offset]
    const axes = armSpecs[offset].axes
    const spawnResult = git(
      ['-C', repo],
      ['worktree', 'add', '-b', plan.branch, plan.dir, setPin],
    )
    if (spawnResult.status !== 0) {
      return spawnPartial({
        setId, manifestPath, pin: setPin, arms: spawnedArms,
        index: plan.index, phase: 'worktree', reason: 'worktree-failed',
        message: spawnResult.stderr || `git worktree add exited with status ${String(spawnResult.status)}`,
      })
    }

    const head = git(['-C', plan.dir], ['rev-parse', '--verify', 'HEAD'])
    const found = head.status === 0 && head.stdout ? head.stdout : null
    if (found !== setPin) {
      return spawnPartial({
        setId, manifestPath, pin: setPin, arms: spawnedArms,
        index: plan.index, phase: 'worktree', reason: 'arm-pin-mismatch',
        message: `arm ${plan.index} pin mismatch: expected ${setPin}, found ${found || 'unresolved'}`,
        found,
        failure: { pin: setPin },
      })
    }

    let admitted
    try {
      const spawnInput = {
        setId,
        index: plan.index,
        armSlug: armSlug(setId, plan.index),
        checkout: plan.dir,
        branch: plan.branch,
        axes,
        pin: setPin,
        brief: args.brief,
        tier: args.tier,
      }
      if (spawner === factoryctlSpawner) spawnInput.deps = d
      admitted = typeof spawner === 'function'
        ? spawner(spawnInput)
        : { ok: false, reason: 'spawn-failed', message: 'spawn must be a function' }
    } catch (err) {
      admitted = { ok: false, reason: 'spawn-failed', message: spawnMessage(err, 'spawner failed') }
    }
    if (!admitted || admitted.ok !== true) {
      const spawnReason = admitted?.reason
      return spawnPartial({
        setId, manifestPath, pin: setPin, arms: spawnedArms,
        index: plan.index, phase: 'spawn', reason: 'spawn-failed',
        message: admitted?.message || 'spawner refused the arm',
        ...(spawnReason ? { spawn_reason: spawnReason } : {}),
      })
    }

    if (!usablePath(admitted.adwId) || !usablePath(admitted.crewDir)) {
      return spawnPartial({
        setId, manifestPath, pin: setPin, arms: spawnedArms,
        index: plan.index, phase: 'spawn', reason: 'spawn-id-missing',
        message: 'spawner returned no usable adwId and crewDir',
      })
    }

    let appended
    try {
      appended = appendArm({
        manifestPath,
        setId,
        adwId: admitted.adwId,
        axes,
        pin: setPin,
        crewDir: admitted.crewDir,
        checkout: plan.dir,
        deps: d,
      })
    } catch (err) {
      appended = { ok: false, reason: 'write-failed', message: spawnMessage(err, 'manifest append failed') }
    }
    if (!appended || appended.ok !== true) {
      const appendReason = appended?.reason || 'write-failed'
      return spawnPartial({
        setId, manifestPath, pin: setPin, arms: spawnedArms,
        index: plan.index, phase: 'append', reason: 'append-failed',
        message: appended?.message || `appendArm refused the arm: ${appendReason}`,
        append_reason: appendReason,
      })
    }

    spawnedArms.push({
      adw_id: admitted.adwId,
      index: plan.index,
      axes,
      checkout: plan.dir,
      branch: plan.branch,
      crew_dir: admitted.crewDir,
    })
  }

  return {
    ok: true,
    status: ARM_SPAWN_STATUSES.SPAWNED,
    set_id: setId,
    manifest_path: manifestPath,
    pin: setPin,
    arms: spawnedArms,
    count: spawnedArms.length,
  }
}
