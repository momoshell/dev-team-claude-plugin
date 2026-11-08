// Resolve a tier's seats from the agent definitions in crew/agents.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAgent, AGENT_ROLES, TIERS, RUN_FIELDS, runOverrideDefects } from './protocols.mjs'

const DEFAULT_DIRECTORY = fileURLToPath(new URL('./agents/', import.meta.url))

// A read that fails stays the filesystem's failure: code and cause survive, and no
// unreadable file is ever taken for a role nobody seated.
function readDefinition(path) {
  try { return readFileSync(path, 'utf8') } catch (cause) {
    throw Object.assign(new Error(`cannot read agent definition ${path}: ${cause.code ?? cause.message}`, { cause }), { code: cause.code, path })
  }
}

const cellOf = (model, agent, effort) => {
  const [provider, id] = model.split('/')
  return { agent, effort, provider, id }
}

export function withRunOverride(fields, override) {
  if (!override) return fields
  const tiers = { ...fields.tiers }
  for (const [tier, entry] of Object.entries(override.tiers ?? {})) {
    if (entry === null) tiers[tier] = null
    else {
      const nonRun = Object.fromEntries(Object.entries(fields.tiers?.[tier] ?? {}).filter(([key]) => !RUN_FIELDS.includes(key)))
      tiers[tier] = { ...nonRun, ...entry }
    }
  }
  return { ...fields, ...override, tiers }
}

export function loadRoster({ personal, project, readFileSync }) {
  const overrides = {}, files = []
  for (const [layer, path] of Object.entries({ personal, project })) {
    let raw
    try { raw = readFileSync(path, 'utf8') } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw new Error(`${path}: cannot read: ${error?.message}`, { cause: error })
    }
    let data
    try { data = JSON.parse(raw) } catch (error) { throw new Error(`${path}: root is not valid JSON: ${error.message}`, { cause: error }) }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${path}: root must be an object`)
    for (const [role, entry] of Object.entries(data)) {
      if (!AGENT_ROLES.includes(role)) throw new Error(`${path}: ${role} is not a role`)
      const defects = runOverrideDefects(role, entry)
      if (defects.length) throw new Error(`${path}: ${defects.join('; ')}`)
      const previous = Object.hasOwn(overrides, role) ? overrides[role] : {}
      overrides[role] = { ...previous, ...entry, ...(Object.hasOwn(entry, 'tiers') ? { tiers: { ...previous.tiers, ...entry.tiers } } : {}) }
    }
    files.push({ layer, path, sha256: createHash('sha256').update(raw).digest('hex') })
  }
  return { overrides, files }
}

function readDefinitions(directory) {
  const problems = []
  const definitions = AGENT_ROLES.map((role) => {
    const path = join(directory, `${role}.md`)
    const { fields, defects } = parseAgent(readDefinition(path))
    const found = [...defects]
    if (fields && (fields.name !== role || fields.role !== role)) found.push(`name and role are both ${role}, the filename; found name ${fields.name}, role ${fields.role}`)
    problems.push(...found.map((defect) => `${path}: ${defect}`))
    return fields
  })
  if (problems.length) throw new Error(`agent definitions are refused:\n${problems.join('\n')}`)
  return definitions
}

// Capture complete run fields per tier, including absent advisors and unseated roles.
export function snapshotRoster(overrides = {}, directory = DEFAULT_DIRECTORY) {
  const definitions = readDefinitions(directory)
  const cell = (fields) => ({ agent: fields.agent, model: fields.model, effort: fields.effort, advisor: fields.advisor ?? null })
  return Object.fromEntries(AGENT_ROLES.map((role, index) => {
    const fields = withRunOverride(definitions[index], Object.hasOwn(overrides, role) ? overrides[role] : undefined)
    const tiers = Object.fromEntries(TIERS.map((tier) => [tier, fields.tiers?.[tier] === null ? null : cell({ ...fields, ...fields.tiers?.[tier] })]))
    return [role, { ...cell(fields), tiers }]
  }))
}

// Returns { seats, advisor }: a null tier override
// unseats a role, any other override replaces the base fields it names.
export function resolveAgents(tier, directory = DEFAULT_DIRECTORY, overrides = {}) {
  if (!TIERS.includes(tier)) throw new Error(`unknown tier "${tier}" — valid tiers: ${TIERS.join(', ')}`)
  const definitions = readDefinitions(directory)
  const seats = {}
  const declared = new Map()
  AGENT_ROLES.forEach((role, index) => {
    const base = withRunOverride(definitions[index], Object.hasOwn(overrides ?? {}, role) ? overrides[role] : undefined)
    const override = base.tiers?.[tier]
    if (override === null) return
    const effective = { ...base, ...override }
    const seat = cellOf(effective.model, effective.agent, effective.effort)
    if (effective.rounds !== undefined) seat.rounds = effective.rounds
    seats[role] = seat
    if (effective.advisor) declared.set(role, cellOf(effective.advisor.model, effective.advisor.agent, effective.advisor.effort))
  })
  const advisors = [...new Set([...declared.values()].map((cell) => JSON.stringify(cell)))]
  if (advisors.length > 1) throw new Error(`conflicting advisors in tier ${tier}: ${[...declared].map(([role, cell]) => `${role} names ${cell.provider}/${cell.id}`).join(', ')}`)
  const advisor = advisors.length ? JSON.parse(advisors[0]) : null
  return { seats, advisor }
}
