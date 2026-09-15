#!/usr/bin/env node
// scripts/factory/agent-doctor.mjs — a read-only coding-agent availability probe.
// The doctor gathers host evidence, delegates state resolution to the capability
// register, and renders a proposal without ever applying it.

import { readFileSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  REGISTER_ROOT,
  agentAvailability,
  loadCapabilities,
} from '../../crew/capabilities.mjs'

export const USAGE = 'usage: node scripts/factory/agent-doctor.mjs [--write] [--state <path>]'

export function AGENT_AVAILABILITY_STATE_PATH(value = homedir()) {
  const supplied = typeof value === 'string' ? value : value?.home
  const home = typeof supplied === 'function' ? supplied() : supplied
  return join(home || homedir(), '.crew', 'agent-availability.json')
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

export const reportAgents = probeReport
export const probe = probeReport

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

export async function main(argv = process.argv.slice(2), deps = {}) {
  const d = normalDeps(deps)
  let flags
  try {
    flags = parseArgs(argv)
  } catch (error) {
    d.stderr(`${error.message} [reason: usage]\n${USAGE}\n`)
    return 2
  }

  let probed
  let home
  try {
    home = await resolvedValue(d.home, homedir())
    probed = await probeAgents(deps?.register ?? null, { ...d, home })
  } catch (error) {
    d.stderr(`${errorText(error)} [reason: probe-failed]\n`)
    return 1
  }

  const statePath = flags.state || AGENT_AVAILABILITY_STATE_PATH(home)
  let before = null
  if (flags.write) {
    try {
      before = textOf(await d.readFile(statePath, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        d.stderr(`${errorText(error)} [reason: state-read-failed]\n`)
        return 2
      }
    }
  }

  const proposedText = probed.proposedText
  const output = [renderReadout(probed.results)]
  if (flags.write) output.push(renderUnifiedDiff(before, proposedText, statePath))
  writeOutput(d, output.filter((value, index) => index === 0 || value !== '').join('\n'))
  return 0
}

function realpathOr(path) {
  try { return realpathSync(path) } catch { return path }
}

const invokedDirectly = process.argv[1]
  && realpathOr(process.argv[1]) === realpathOr(fileURLToPath(import.meta.url))
if (invokedDirectly) process.exitCode = await main(process.argv.slice(2))
