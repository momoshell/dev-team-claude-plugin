// crew/workflows.mjs — closed workflow seat-map declarations and validation.
// This module is a leaf: it knows policy data and shape membership, but never
// imports the executor or boot implementation.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

import { VARIANTS } from './variants.mjs'
import { validateCapabilities } from './capabilities.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKFLOWS_DIR = join(HERE, 'workflows')
const WORKFLOW_SCHEMA_PATH = join(WORKFLOWS_DIR, 'workflow.schema.json')
const WORKFLOW_SCHEMA = JSON.parse(readFileSync(WORKFLOW_SCHEMA_PATH, 'utf8'))
const WORKFLOW_NAME = /^[a-z0-9][a-z0-9-]*$/
const IDENTIFIER = /^[a-z0-9][a-z0-9_-]*$/
const RELATIVE_GRANT = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/

export const WORKFLOW_REFUSALS = Object.freeze([
  'workflow-name-invalid',
  'workflow-unreadable',
  'workflow-schema',
  'workflow-shape-unsupported',
  'workflow-stage-extra',
  'workflow-stage-not-seated',
  'workflow-stage-missing',
  'workflow-stage-role',
  'workflow-role-unseated',
  'workflow-role-divergent',
  'workflow-agent-unknown',
  'workflow-model-unknown',
  'workflow-model-below-floor',
  'workflow-grant-undeliverable',
  'workflow-needs-tier',
  'workflow-seat-mismatch',
])

export function workflowRefusal(reason, message, details = {}) {
  if (!WORKFLOW_REFUSALS.includes(reason)) {
    throw new Error(`unknown workflow refusal reason ${JSON.stringify(reason)}`)
  }
  return Object.assign(new Error(`${message} [${reason}]`), { reason }, details || {})
}

export const SEAT_BEARING_STAGES = Object.freeze({
  full: Object.freeze({
    plan: 'planner', // verified crew/drive.mjs:7197-7219
    check: 'tech-lead', // verified crew/drive.mjs:7534-7546
    build: 'builder', // verified crew/drive.mjs:9340-9344
    'gate-repair': 'lead', // verified crew/drive.mjs:9280-9290 through GATE_CUSTODIAN
    review: 'reviewer', // verified crew/drive.mjs:9766-9813
  }),
})

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

export function loadWorkflow(name, { dir = WORKFLOWS_DIR, readFile = readFileSync } = {}) {
  if (typeof name !== 'string' || !WORKFLOW_NAME.test(name)) {
    throw workflowRefusal(
      'workflow-name-invalid',
      `workflow name ${JSON.stringify(name)} is invalid; expected a lowercase hyphenated identifier matching /^[a-z0-9][a-z0-9-]*$/`,
      { name },
    )
  }
  const file = resolvePath(join(resolvePath(dir), `${name}.json`))
  let raw
  try {
    raw = readFile(file, 'utf8')
  } catch (err) {
    throw workflowRefusal(
      'workflow-unreadable',
      `workflow ${JSON.stringify(name)} at ${file} is unreadable: ${err?.message || String(err)}`,
      { name, path: file },
    )
  }
  try {
    return JSON.parse(String(raw))
  } catch (err) {
    throw workflowRefusal(
      'workflow-unreadable',
      `workflow ${JSON.stringify(name)} at ${file} is unreadable or unparseable: ${err?.message || String(err)}`,
      { name, path: file },
    )
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function schemaErrors(map) {
  const errors = validateCapabilities(WORKFLOW_SCHEMA, map)
  if (errors.length || !isObject(map) || !isObject(map.seats)) return errors
  for (const [stage, seat] of Object.entries(map.seats)) {
    for (const kind of ['skills', 'extensions']) {
      const entries = Array.isArray(seat?.[kind]) ? seat[kind] : []
      const seen = new Set()
      for (const entry of entries) {
        if (typeof entry !== 'string' || !RELATIVE_GRANT.test(entry) || entry.split('/').some((part) => part === '.' || part === '..')) {
          errors.push(`$.seats.${stage}.${kind}: ${JSON.stringify(entry)} is not a repo-relative grant path`)
          continue
        }
        if (seen.has(entry)) errors.push(`$.seats.${stage}.${kind}: duplicate grant ${JSON.stringify(entry)}`)
        seen.add(entry)
      }
    }
  }
  return errors
}

function mapValue(container, key) {
  if (container instanceof Map) return container.get(key)
  return container && typeof container === 'object' ? container[key] : undefined
}

function modelBand(ladder, key) {
  const band = mapValue(ladder?.members, key)
  if (band !== undefined && band !== null) return band
  if (Array.isArray(ladder?.bands)) {
    const found = ladder.bands.find((entry) => Array.isArray(entry?.members) && entry.members.includes(key))
    return found?.band
  }
  return undefined
}

function modelRank(ladder, band) {
  const rank = mapValue(ladder?.ranks, band)
  if (typeof rank === 'number') return rank
  if (Array.isArray(ladder?.bands)) return ladder.bands.find((entry) => entry?.band === band)?.rank
  return undefined
}

function effectiveGrants(register, role, agent) {
  const roleDeclaration = register?.roles?.[role] || {}
  const overlay = roleDeclaration?.by_agent?.[agent] || {}
  return {
    skills: new Set([...(roleDeclaration.skills || []), ...(overlay.skills || [])]),
    extensions: new Set([...(roleDeclaration.extensions || []), ...(overlay.extensions || [])]),
  }
}

function assertGrantEntries(kind, entries, grants, { path, stage, role }) {
  for (const entry of entries) {
    if (!grants.has(entry)) {
      throw workflowRefusal(
        'workflow-grant-undeliverable',
        `workflow ${path} stage ${stage} role ${role} declares an ungranted ${kind} entry ${JSON.stringify(entry)}`,
        { path, stage, role, kind, entry },
      )
    }
  }
}

function assertModelCell(seat, register, ladder, tier, { path, stage, role }) {
  const codingAgent = register.coding_agents[seat.agent]
  if (!codingAgent.providers.includes(seat.provider)) {
    throw workflowRefusal(
      'workflow-model-unknown',
      `workflow ${path} stage ${stage} role ${role} names provider ${JSON.stringify(seat.provider)} unsupported by coding agent ${seat.agent}`,
      { path, stage, role, provider: seat.provider, id: seat.id },
    )
  }
  const member = `${seat.provider}/${seat.id}`
  const band = modelBand(ladder, member)
  const seatRank = modelRank(ladder, band)
  const floorName = ladder?.floors?.[tier] ?? ladder?.tier_floors?.[tier]
  const floorRank = modelRank(ladder, floorName)
  if (band === undefined || seatRank === undefined || floorName === undefined || floorRank === undefined) {
    throw workflowRefusal(
      'workflow-model-unknown',
      `workflow ${path} stage ${stage} role ${role} names model ${member} absent from the supplied ladder or tier floor ${JSON.stringify(floorName ?? null)}`,
      { path, stage, role, provider: seat.provider, id: seat.id, tier },
    )
  }
  if (seatRank < floorRank) {
    throw workflowRefusal(
      'workflow-model-below-floor',
      `workflow ${path} stage ${stage} role ${role} names model ${member} at rank ${seatRank}, below tier ${tier} floor ${JSON.stringify(floorName)} at rank ${floorRank}`,
      { path, stage, role, provider: seat.provider, id: seat.id, tier, seatRank, floorRank },
    )
  }
}

export function validateWorkflow(map, {
  register,
  ladder,
  tier,
  roles,
  path = '<workflow>',
  seatBearingStages = SEAT_BEARING_STAGES,
} = {}) {
  const errors = schemaErrors(map)
  if (errors.length) {
    throw workflowRefusal(
      'workflow-schema',
      `workflow ${path} failed schema validation: ${errors.slice(0, 3).join('; ')}`,
      { path, errors },
    )
  }

  const variant = VARIANTS?.[map.shape]
  const inventory = seatBearingStages?.[map.shape]
  if (!variant || !isObject(inventory)) {
    throw workflowRefusal(
      'workflow-shape-unsupported',
      `workflow ${path} declares unsupported shape ${JSON.stringify(map.shape)}; no seat-bearing inventory is available`,
      { path, shape: map.shape },
    )
  }
  const shapeStages = new Set(variant.stages)
  const roleSet = new Set(Array.isArray(roles) ? roles : [])
  if (!register || typeof register !== 'object') register = { coding_agents: {} }
  if (!isObject(register.coding_agents)) register.coding_agents = {}
  const byRole = {}

  for (const [stage, seat] of Object.entries(map.seats)) {
    if (!shapeStages.has(stage)) {
      throw workflowRefusal(
        'workflow-stage-extra',
        `workflow ${path} stage ${stage} is not declared by shape ${map.shape}`,
        { path, shape: map.shape, stage },
      )
    }
    if (!Object.hasOwn(inventory, stage)) {
      throw workflowRefusal(
        'workflow-stage-not-seated',
        `workflow ${path} stage ${stage} is a shape stage but is not seat-bearing`,
        { path, shape: map.shape, stage },
      )
    }
    const expectedRole = inventory[stage]
    if (seat.role !== expectedRole) {
      throw workflowRefusal(
        'workflow-stage-role',
        `workflow ${path} stage ${stage} must be seated by role ${expectedRole}, found ${seat.role}`,
        { path, shape: map.shape, stage, role: seat.role, expectedRole },
      )
    }
    if (!roleSet.has(expectedRole)) {
      throw workflowRefusal(
        'workflow-role-unseated',
        `workflow ${path} stage ${stage} names role ${expectedRole}, which is not seated in the effective tier`,
        { path, shape: map.shape, stage, role: expectedRole },
      )
    }
    const role = expectedRole
    if (!Object.hasOwn(register.coding_agents, seat.agent)) {
      throw workflowRefusal(
        'workflow-agent-unknown',
        `workflow ${path} stage ${stage} role ${expectedRole} names unknown coding agent ${JSON.stringify(seat.agent)}`,
        { path, stage, role: expectedRole, agent: seat.agent },
      )
    }
    assertModelCell(seat, register, ladder, tier, { path, stage, role })
    const grants = effectiveGrants(register, role, seat.agent)
    assertGrantEntries('skills', seat.skills, grants.skills, { path, stage, role })
    assertGrantEntries('extensions', seat.extensions, grants.extensions, { path, stage, role })

    const resolved = {
      agent: seat.agent,
      provider: seat.provider,
      id: seat.id,
      effort: seat.effort,
      skills: [...seat.skills],
      extensions: [...seat.extensions],
      availability: 'unmeasured',
    }
    const prior = byRole[role]
    if (prior && !isDeepStrictEqual(prior, resolved)) {
      throw workflowRefusal(
        'workflow-role-divergent',
        `workflow ${path} stages for role ${role} declare divergent seat cells`,
        { path, stage, role, prior, resolved },
      )
    }
    if (!prior) byRole[role] = resolved
  }

  for (const [stage, role] of Object.entries(inventory)) {
    if (roleSet.has(role) && !Object.hasOwn(map.seats, stage)) {
      throw workflowRefusal(
        'workflow-stage-missing',
        `workflow ${path} is missing required seated stage ${stage} for role ${role}`,
        { path, shape: map.shape, stage, role },
      )
    }
  }

  return deepFreeze({ shape: map.shape, seats: byRole })
}
