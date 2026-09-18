#!/usr/bin/env node
// scripts/factory/agent-doctor.mjs — a coding-agent availability probe.
// The doctor gathers host evidence, delegates state resolution to the capability
// register, and renders a proposal that --write can persist atomically.

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  REGISTER_ROOT,
  agentAvailability,
  loadCapabilities,
} from '../../crew/capabilities.mjs'

export const USAGE = 'usage: node scripts/factory/agent-doctor.mjs [--write] [--state <path>]'

export function AGENT_AVAILABILITY_STATE_PATH() {
  return join(REGISTER_ROOT, 'crew', 'capabilities.json')
}

class DoctorUsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DoctorUsageError'
  }
}

function textOf(value) {
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return typeof value === 'string' ? value : ''
}

function errorText(error) {
  try { return error?.message || String(error) } catch { return 'unknown error' }
}

function normalDeps(deps = {}) {
  const source = deps && typeof deps === 'object' ? deps : {}
  return {
    which: source.which || defaultWhich,
    spawn: source.spawn || defaultSpawn,
    importAdapter: source.importAdapter || ((url) => import(url)),
    readFile: source.readFile || readFileSync,
    mkdirSync: source.mkdirSync || mkdirSync,
    writeFileSync: source.writeFileSync || writeFileSync,
    renameSync: source.renameSync || renameSync,
    unlinkSync: source.unlinkSync || unlinkSync,
    home: source.home || homedir,
    now: source.now || (() => Date.now()),
    availability: source.agentAvailability || agentAvailability,
    stdout: source.stdout || ((value) => process.stdout.write(value)),
    stderr: source.stderr || ((value) => process.stderr.write(value)),
  }
}

function defaultWhich(binary) {
  const result = spawnSync('which', [String(binary)], { encoding: 'utf8', shell: false })
  if (result?.error) throw result.error
  if (!result || result.status !== 0) return null
  const resolved = textOf(result.stdout).trim()
  return resolved || null
}

function defaultSpawn(binary, args) {
  return spawnSync(String(binary), [...args], { encoding: 'utf8', shell: false })
}

async function resolvedValue(value, fallback) {
  const supplied = typeof value === 'function' ? await value() : await value
  return typeof supplied === 'string' && supplied.length > 0 ? supplied : fallback
}

function adapterPathFor(entry) {
  return resolve(REGISTER_ROOT, String(entry?.adapter || ''))
}

function missingAdapterError(error, adapterPath) {
  const code = error?.code || error?.cause?.code
  if (code === 'ENOENT' || code === 'ERR_MODULE_NOT_FOUND') return true
  if (code) return false
  const message = errorText(error)
  return message.length === 0 || message.includes(adapterPath) || message.includes(pathToFileURL(adapterPath).href)
}

async function loadAdapter(entry, d) {
  const adapterPath = adapterPathFor(entry)
  const url = pathToFileURL(adapterPath).href
  try {
    return { path: adapterPath, adapter: await d.importAdapter(url), present: true, loadError: null }
  } catch (error) {
    if (missingAdapterError(error, adapterPath)) return { path: adapterPath, adapter: null, present: false, loadError: null }
    return { path: adapterPath, adapter: null, present: true, loadError: error }
  }
}

async function readVisibleConfig(entry, home, d) {
  const visible = new Set()
  const config = Array.isArray(entry?.config) ? entry.config : []
  for (const configPath of config) {
    const candidate = configPath.startsWith('~/') ? join(home, configPath.slice(2)) : configPath
    try {
      await d.readFile(candidate, 'utf8')
      visible.add(candidate)
    } catch {
      // An unreadable path is not visible to the resolver; EPERM and ENOENT
      // both remain a conservative absence rather than a fabricated config.
    }
  }
  return visible
}

async function resolveBinary(entry, d) {
  let binary = null
  let error = null
  try {
    const found = await d.which(entry.binary)
    const trimmed = typeof found === 'string' || Buffer.isBuffer(found) ? textOf(found).trim() : found
    binary = trimmed || null
  } catch (caught) {
    error = caught
  }
  return { binary, error }
}

async function versionEvidence(binary, d) {
  if (!binary) return null
  try {
    const evidence = await d.spawn(binary, ['--version'])
    return evidence ?? { error: new Error('version probe returned no result') }
  } catch (error) {
    return { error }
  }
}

function versionText(evidence) {
  if (!evidence || evidence.status !== 0) return null
  const first = textOf(evidence.stdout).split(/\r?\n/, 1)[0].trim()
  return first || null
}

async function probeOne(register, agent, entry, home, d) {
  const loaded = await loadAdapter(entry, d)
  const { binary, error: whichError } = await resolveBinary(entry, d)
  const version = await versionEvidence(binary, d)
  const visibleConfig = await readVisibleConfig(entry, home, d)
  const transports = {}
  const transportRefusals = []
  const declaredTransports = Array.isArray(entry?.transports) ? entry.transports : []
  for (const transport of declaredTransports) {
    if (!loaded.present || loaded.loadError || !loaded.adapter) {
      transports[transport] = 'refused'
      continue
    }
    try {
      if (typeof loaded.adapter.capabilitiesFor !== 'function') throw new Error('adapter exports no capabilitiesFor function')
      await loaded.adapter.capabilitiesFor({ transport })
      transports[transport] = 'ok'
    } catch (error) {
      transports[transport] = 'refused'
      transportRefusals.push({ transport, message: errorText(error) })
    }
  }

  const availability = d.availability(register, agent, {
    exists: (path) => (loaded.present && path === loaded.path) || visibleConfig.has(path),
    which: () => {
      if (whichError) throw whichError
      return binary
    },
    home,
    version,
    adapterLoadError: loaded.loadError,
    transportRefusals,
  })
  return {
    agent,
    state: availability.state,
    reason: availability.reason,
    binary,
    version: versionText(version),
    transports,
  }
}

function reportFor(results, nowValue) {
  const agents = {}
  for (const result of results) {
    agents[result.agent] = {
      state: result.state,
      reason: result.reason,
      binary: result.binary,
      version: result.version,
      transports: result.transports,
    }
  }
  const value = {
    schema_version: 1,
    probed_at: new Date(nowValue).toISOString(),
    agents,
  }
  return { value, proposedText: `${JSON.stringify(value, null, 2)}\n` }
}

export async function probeAgents(register = null, deps = {}) {
  const d = normalDeps(deps)
  const resolvedRegister = register ?? loadCapabilities()
  const home = await resolvedValue(d.home, homedir())
  const entries = resolvedRegister?.coding_agents && typeof resolvedRegister.coding_agents === 'object'
    ? Object.entries(resolvedRegister.coding_agents)
    : []
  const results = []
  for (const [agent, entry] of entries) results.push(await probeOne(resolvedRegister, agent, entry, home, d))
  const nowValue = await d.now()
  const { value, proposedText } = reportFor(results, nowValue)
  return { results, value, proposedText }
}

export async function probeReport(registerOrOptions = null, deps = {}) {
  if (registerOrOptions && typeof registerOrOptions === 'object' && Object.hasOwn(registerOrOptions, 'register')) {
    return probeAgents(registerOrOptions.register, registerOrOptions.deps || {})
  }
  return probeAgents(registerOrOptions, deps)
}


export function renderReadout(results = []) {
  const executable = results.filter(({ state }) => state === 'executable').length
  const unavailable = results.filter(({ state }) => state !== 'executable')
  const denominator = `${results.length} agents probed, ${executable} executable, ${unavailable.length} unavailable`
  return [denominator, ...unavailable.map(({ agent, reason }) => `${agent}: ${reason}`)].join('\n')
}

function splitDiffLines(value) {
  const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

export function renderUnifiedDiff(before, proposedText, statePath) {
  if (before !== null && String(before) === String(proposedText)) return ''
  const oldLines = before === null ? [] : splitDiffLines(before)
  const newLines = splitDiffLines(proposedText)
  const oldLabel = before === null ? '/dev/null' : statePath
  const hunk = `@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@`
  return [
    `--- ${oldLabel}`,
    `+++ ${statePath}`,
    hunk,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join('\n')
}

function parseArgs(argv) {
  const flags = { write: false, state: null }
  const values = [...argv]
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index]
    if (flag === '--write') {
      flags.write = true
      continue
    }
    if (flag === '--state') {
      const value = values[++index]
      if (!value || value.startsWith('--')) throw new DoctorUsageError('--state requires a value')
      flags.state = value
      continue
    }
    if (flag.startsWith('-')) throw new DoctorUsageError(`unknown option: ${flag}`)
    throw new DoctorUsageError(`extra operand: ${flag}`)
  }
  return flags
}

function writeOutput(d, value) {
  d.stdout(`${value}\n`)
}

function persistState(d, statePath, proposedText) {
  const parent = dirname(statePath)
  let temporary = null
  try {
    temporary = join(parent, `.${basename(statePath)}.${process.pid}.${randomUUID()}.tmp`)
    d.mkdirSync(parent, { recursive: true })
    d.writeFileSync(temporary, proposedText, { encoding: 'utf8', flag: 'wx' })
    d.renameSync(temporary, statePath)
  } catch (error) {
    if (temporary) {
      try { d.unlinkSync(temporary) } catch { /* preserve the original target on cleanup failure */ }
    }
    throw error
  }
}

async function readStateRegister(d, statePath) {
  let before
  try {
    before = textOf(await d.readFile(statePath, 'utf8'))
  } catch (error) {
    throw Object.assign(new Error(errorText(error)), { reason: 'state-read-failed', cause: error })
  }
  if (before.trim() === '') {
    throw Object.assign(new Error(`runtime capability register ${statePath} is empty`), { reason: 'state-read-failed' })
  }
  let parsed
  try {
    parsed = JSON.parse(before)
  } catch (error) {
    throw Object.assign(new Error(errorText(error)), { reason: 'state-read-failed', cause: error })
  }
  try {
    return { before, register: loadCapabilities({ path: statePath, register: parsed }) }
  } catch (error) {
    throw Object.assign(new Error(errorText(error)), { reason: 'state-read-failed', cause: error })
  }
}

function mergeProbeAvailability(register, results) {
  const merged = structuredClone(register)
  for (const result of results) {
    const entry = merged?.coding_agents?.[result.agent]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    entry.availability = result.state
    entry.availability_reason = result.reason
  }
  return merged
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const d = normalDeps(deps)
  let flags
  try {
    flags = parseArgs(argv)
  } catch (error) {
    d.stderr(`${error.message} [reason: usage]\n${USAGE}\n`)
    return 2
  }

  const statePath = flags.state || AGENT_AVAILABILITY_STATE_PATH()
  let before = null
  let targetRegister = null
  if (flags.write) {
    try {
      ({ before, register: targetRegister } = await readStateRegister(d, statePath))
    } catch (error) {
      d.stderr(`${errorText(error)} [reason: state-read-failed]\n`)
      return 2
    }
  }

  let probed
  let home
  try {
    home = await resolvedValue(d.home, homedir())
    const register = flags.write ? targetRegister : (deps?.register ?? null)
    probed = await probeAgents(register, { ...d, home })
  } catch (error) {
    d.stderr(`${errorText(error)} [reason: probe-failed]\n`)
    return 1
  }

  let proposedText = probed.proposedText
  if (flags.write) {
    try {
      const merged = mergeProbeAvailability(targetRegister, probed.results)
      const validated = loadCapabilities({ register: merged })
      proposedText = `${JSON.stringify(validated, null, 2)}\n`
    } catch (error) {
      d.stderr(`${errorText(error)} [reason: state-read-failed]\n`)
      return 2
    }
  }

  const output = [renderReadout(probed.results)]
  if (flags.write) output.push(renderUnifiedDiff(before, proposedText, statePath))
  writeOutput(d, output.filter((value, index) => index === 0 || value !== '').join('\n'))
  if (flags.write && before !== proposedText) {
    try {
      persistState(d, statePath, proposedText)
    } catch (error) {
      d.stderr(`${errorText(error)} [reason: state-write-failed]\n`)
      return 2
    }
  }
  return 0
}

const invokedDirectly = import.meta.main
if (invokedDirectly) process.exitCode = await main(process.argv.slice(2))
