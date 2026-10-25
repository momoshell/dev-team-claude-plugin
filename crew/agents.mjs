// The P5 consumer (ADR-052 section 3): resolve a tier's seats from the agent definitions
// in crew/agents, the way resolveTier reads them from roster.json. Import-free of the
// old boot path, so the two run in parallel until boot moves over.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAgent, AGENT_ROLES, TIERS } from './protocols.mjs'

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

// Returns { seats, advisor } shaped as resolveTier's roster cells: a null tier override
// unseats a role, any other override replaces the base fields it names.
export function resolveAgents(tier, directory = DEFAULT_DIRECTORY) {
  if (!TIERS.includes(tier)) throw new Error(`unknown tier "${tier}" — valid tiers: ${TIERS.join(', ')}`)
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
  const seats = {}
  const declared = new Map()
  AGENT_ROLES.forEach((role, index) => {
    const base = definitions[index]
    const override = base.tiers?.[tier]
    if (override === null) return
    const effective = { ...base, ...override }
    const seat = cellOf(effective.model, effective.agent, effective.effort)
    if (effective.rounds !== undefined) seat.rounds = effective.rounds
    if (effective.fallback?.length) seat.fallback = effective.fallback.map((entry) => cellOf(entry.model, entry.agent, entry.effort ?? effective.effort))
    seats[role] = seat
    if (effective.advisor) declared.set(role, cellOf(effective.advisor.model, effective.advisor.agent, effective.advisor.effort))
  })
  const advisors = [...new Set([...declared.values()].map((cell) => JSON.stringify(cell)))]
  if (advisors.length > 1) throw new Error(`conflicting advisors in tier ${tier}: ${[...declared].map(([role, cell]) => `${role} names ${cell.provider}/${cell.id}`).join(', ')}`)
  const advisor = advisors.length ? JSON.parse(advisors[0]) : null
  return { seats, advisor }
}
