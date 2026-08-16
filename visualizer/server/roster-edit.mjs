import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SEAT_DEFAULTS, assertCapabilities, DEFAULT_TRANSPORT, HEADLESS_TRANSPORTS } from '../../crew/crew.mjs'

export const SCHEMA_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'crew', 'roster.schema.json')
export const ADAPTERS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'crew', 'adapters')

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function loadSchema(schemaPath = SCHEMA_PATH) {
  return JSON.parse(readFileSync(schemaPath, 'utf8'))
}

export function loadSeatSchema(schemaPath = SCHEMA_PATH) {
  const seat = loadSchema(schemaPath)?.$defs?.seat
  if (!record(seat)) throw new Error(`roster schema has no $defs.seat, at ${schemaPath}`)
  return {
    required: Array.isArray(seat.required) ? [...seat.required] : [],
    properties: record(seat.properties) ? structuredClone(seat.properties) : {},
  }
}

function found(value) {
  if (value === undefined) return 'missing'
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  let rendered
  try { rendered = JSON.stringify(value) } catch { rendered = String(value) }
  return rendered === undefined ? String(value) : rendered
}

function expectedType(property) {
  if (typeof property?.type === 'string') return property.type
  if (Array.isArray(property?.type) && property.type.length === 1) return property.type[0]
  if (Array.isArray(property?.enum) && property.enum.every((value) => typeof value === 'string')) return 'string'
  return null
}

function refusal(message) {
  return { code: 'cell_shape', message }
}

export function validateCell(cell, seatSchema, location = 'tiers.<tier>.<role>') {
  const schema = record(seatSchema) ? seatSchema : {}
  if (cell === null) return []
  if (!record(cell)) return [refusal(`expected object or null, found ${found(cell)}, at ${location}`)]

  const refusals = []
  const required = Array.isArray(schema.required) ? schema.required : []
  const properties = record(schema.properties) ? schema.properties : {}
  for (const field of required) {
    if (!Object.prototype.hasOwnProperty.call(cell, field)) {
      refusals.push(refusal(`expected ${field} to be present, found missing, at ${location}.${field}`))
    }
  }
  if (schema.additionalProperties !== true) {
    for (const field of Object.keys(cell)) {
      if (!Object.prototype.hasOwnProperty.call(properties, field)) {
        refusals.push(refusal(`expected no additional properties, found ${found(field)}, at ${location}.${field}`))
      }
    }
  }
  for (const [field, property] of Object.entries(properties)) {
    if (!Object.prototype.hasOwnProperty.call(cell, field)) continue
    const value = cell[field]
    const type = expectedType(property)
    if (type && (typeof value !== type || value === null)) {
      refusals.push(refusal(`expected ${type}, found ${found(value)}, at ${location}.${field}`))
      continue
    }
    if (typeof property?.pattern === 'string' && typeof value === 'string') {
      let matches = false
      try { matches = new RegExp(property.pattern).test(value) } catch {}
      if (!matches) refusals.push(refusal(`expected a value matching ${property.pattern}, found ${found(value)}, at ${location}.${field}`))
    }
    if (Array.isArray(property?.enum) && !property.enum.includes(value)) {
      refusals.push(refusal(`expected one of ${property.enum.join(', ')}, found ${found(value)}, at ${location}.${field}`))
    }
  }
  return refusals
}

function lines(text) {
  if (text === '') return { values: [], newline: false }
  const newline = text.endsWith('\n')
  const values = text.split('\n')
  if (newline) values.pop()
  return { values, newline }
}

function rangeStart(index, count) {
  return count === 0 ? index : index + 1
}

function terminated(source, index) {
  return index < source.values.length - 1 || source.newline
}

function bodyLine(prefix, value, noNewline = false) {
  return [{ text: `${prefix}${value}` }, ...(noNewline ? [{ text: '\\ No newline at end of file', marker: true }] : [])]
}

export function unifiedDiff(beforeText, afterText, { path = 'crew/roster.json' } = {}) {
  if (beforeText === afterText) return ''
  const before = lines(beforeText), after = lines(afterText)
  let prefix = 0
  while (prefix < before.values.length && prefix < after.values.length && before.values[prefix] === after.values[prefix] && terminated(before, prefix) === terminated(after, prefix)) prefix += 1
  let suffix = 0
  while (prefix + suffix < before.values.length && prefix + suffix < after.values.length && before.values.at(-1 - suffix) === after.values.at(-1 - suffix) && terminated(before, before.values.length - 1 - suffix) === terminated(after, after.values.length - 1 - suffix)) suffix += 1
  if (prefix === before.values.length && prefix === after.values.length) {
    prefix = Math.max(0, prefix - 1)
    suffix = 0
  }

  const beforeStart = Math.max(0, prefix - 3)
  const afterStart = Math.max(0, prefix - 3)
  const beforeChangedEnd = before.values.length - suffix
  const afterChangedEnd = after.values.length - suffix
  const contextAfter = Math.min(3, suffix)
  const beforeEnd = beforeChangedEnd + contextAfter
  const afterEnd = afterChangedEnd + contextAfter
  const beforeCount = beforeEnd - beforeStart
  const afterCount = afterEnd - afterStart
  const output = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${rangeStart(beforeStart, beforeCount)},${beforeCount} +${rangeStart(afterStart, afterCount)},${afterCount} @@`,
  ]

  for (let index = beforeStart; index < prefix; index += 1) {
    const noNewline = (index === before.values.length - 1 && !before.newline) || (index === after.values.length - 1 && !after.newline)
    output.push(...bodyLine(' ', before.values[index], noNewline))
  }
  for (let index = prefix; index < beforeChangedEnd; index += 1) {
    output.push(...bodyLine('-', before.values[index], index === before.values.length - 1 && !before.newline))
  }
  for (let index = prefix; index < afterChangedEnd; index += 1) {
    output.push(...bodyLine('+', after.values[index], index === after.values.length - 1 && !after.newline))
  }
  for (let index = beforeChangedEnd; index < beforeEnd; index += 1) {
    const afterIndex = afterChangedEnd + (index - beforeChangedEnd)
    const noNewline = (index === before.values.length - 1 && !before.newline) || (afterIndex === after.values.length - 1 && !after.newline)
    output.push(...bodyLine(' ', after.values[afterIndex], noNewline))
  }
  return `${output.map((entry) => typeof entry === 'string' ? entry : entry.text).join('\n')}\n`
}

function validTierNames(schema) {
  const properties = schema?.properties?.tiers?.properties
  return record(properties) ? Object.keys(properties) : ['mechanical', 'build', 'judge']
}

function validRoleNames(schema) {
  const properties = schema?.$defs?.tier?.properties
  return record(properties) ? Object.keys(properties) : ['lead', 'planner', 'builder', 'reviewer', 'tech-lead']
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function capabilityUnknown({ tier, role, agent, adapterPath, reason }) {
  const path = adapterPath ? ` at ${adapterPath}` : ''
  const detail = reason ? `: ${reason}` : ''
  return {
    code: 'capability_unknown',
    message: `seat tiers.${tier}.${role} with agent "${agent}" refused because capability could not be determined${detail}${path}`,
    transports: [],
  }
}

export async function capabilityRefusals({ tier, role, cell, adaptersDir = ADAPTERS_DIR } = {}) {
  if (cell === null) return []
  if (!Object.prototype.hasOwnProperty.call(SEAT_DEFAULTS, role) || typeof cell?.agent !== 'string') return []

  const agent = cell.agent
  if (!/^[a-z0-9][a-z0-9-]*$/.test(agent)) {
    return [capabilityUnknown({ tier, role, agent, reason: 'invalid adapter name' })]
  }

  const adapterPath = join(adaptersDir, `adapter-${agent}.mjs`)
  if (!existsSync(adapterPath)) {
    return [capabilityUnknown({ tier, role, agent, adapterPath, reason: 'adapter file does not exist' })]
  }

  let adapter
  try {
    adapter = await import(pathToFileURL(adapterPath).href)
  } catch (err) {
    return [capabilityUnknown({ tier, role, agent, adapterPath, reason: `adapter import failed: ${err?.message || String(err)}` })]
  }
  if (typeof adapter.capabilitiesFor !== 'function') {
    return [capabilityUnknown({ tier, role, agent, adapterPath, reason: 'adapter exports no capabilitiesFor function' })]
  }

  const refusals = []
  let shipped = 0
  for (const transport of [DEFAULT_TRANSPORT, ...HEADLESS_TRANSPORTS]) {
    let capabilities
    try {
      capabilities = adapter.capabilitiesFor({ transport })
    } catch {
      continue
    }
    shipped += 1
    try {
      assertCapabilities(role, agent, capabilities)
    } catch (err) {
      refusals.push({ code: 'capability_refused', message: err?.message || String(err), transport })
    }
  }

  if (!shipped) {
    return [capabilityUnknown({ tier, role, agent, adapterPath, reason: 'adapter ships no capability profile for a supported transport' })]
  }

  const deduped = new Map()
  for (const refusal of refusals) {
    const existing = deduped.get(refusal.message)
    if (existing) existing.transports.push(refusal.transport)
    else deduped.set(refusal.message, { code: refusal.code, message: refusal.message, transports: [refusal.transport] })
  }
  return [...deduped.values()]
}

export async function proposeEdit({ rosterText, rosterPath = 'crew/roster.json', readError = null, tier, role, cell, seatSchema } = {}) {
  let roster
  if (typeof rosterText !== 'string') {
    const message = readError || `unable to read roster: unknown read error, at ${rosterPath}`
    return { ok: false, refusals: [{ code: 'roster_unreadable', message }], diff: null, before: null, after: null }
  }
  try {
    roster = JSON.parse(rosterText)
  } catch (err) {
    const message = `invalid roster JSON: ${err.message || 'invalid JSON'}, at ${rosterPath}`
    return { ok: false, refusals: [{ code: 'roster_unreadable', message }], diff: null, before: null, after: null }
  }

  const canonical = JSON.stringify(roster, null, 2)
  const normalised = rosterText.endsWith('\n') ? rosterText.slice(0, -1) : rosterText
  if (canonical !== normalised) {
    return {
      ok: false,
      refusals: [{ code: 'roster_not_canonical', message: `roster is non-canonically-formatted; refusing a misleading diff against ${rosterPath}` }],
      diff: null,
      before: null,
      after: null,
    }
  }

  let schema
  try { schema = loadSchema() } catch (err) {
    return {
      ok: false,
      refusals: [{ code: 'roster_unreadable', message: `unable to read roster schema: ${err.message || 'unknown read error'}, at ${SCHEMA_PATH}` }],
      diff: null,
      before: null,
      after: null,
    }
  }
  const tierNames = validTierNames(schema)
  const roleNames = validRoleNames(schema)
  if (!record(roster.tiers) || !Object.prototype.hasOwnProperty.call(roster.tiers, tier)) {
    return {
      ok: false,
      refusals: [{ code: 'unknown_tier', message: `unknown tier "${tier}" — valid tiers: ${tierNames.join(', ')} (crew/crew.mjs resolveTier)` }],
      diff: null,
      before: null,
      after: null,
    }
  }
  if (!roleNames.includes(role)) {
    return {
      ok: false,
      refusals: [{ code: 'unknown_role', message: `unknown role "${role}" — crew/crew.mjs:438 unknown crew role: ${role} would break the boot path` }],
      diff: null,
      before: null,
      after: null,
    }
  }

  const tierRoster = record(roster.tiers[tier]) ? roster.tiers[tier] : {}
  const before = clone(tierRoster[role]) ?? null
  const refusals = []
  if (cell === null && role !== 'lead' && role !== 'tech-lead') {
    refusals.push({ code: 'unseat_refused', message: `cannot unseat ${tier}.${role}: crew/crew.mjs:201 resolveTier would not seat it and the tier could not boot a planner/builder/reviewer` })
  }
  if (tier === 'mechanical' && role === 'lead' && cell !== null) {
    refusals.push({ code: 'mechanical_lead', message: `mechanical.lead must remain present and exactly null; see crew/roster-refresh.test.mjs:125-128` })
  }

  const loadedSeatSchema = seatSchema || loadSeatSchema()
  const shapeRefusals = validateCell(cell, loadedSeatSchema, `tiers.${tier}.${role}`)
  refusals.push(...shapeRefusals)
  if (!shapeRefusals.length && cell !== null) {
    const modelKey = `${cell.provider}/${cell.id}`
    if (!record(roster.models) || !Object.prototype.hasOwnProperty.call(roster.models, modelKey)) {
      refusals.push({ code: 'unknown_model', message: `model ${modelKey} is absent from roster.models; see crew/roster-refresh.test.mjs:143-151` })
    }
  }
  if (!shapeRefusals.length && cell !== null) {
    refusals.push(...await capabilityRefusals({ tier, role, cell }))
  }

  let afterRoster
  if (!shapeRefusals.length) {
    afterRoster = structuredClone(roster)
    afterRoster.tiers[tier][role] = clone(cell)
    const editedTier = afterRoster.tiers[tier]
    const reviewer = editedTier?.reviewer
    const partnerRole = editedTier?.['tech-lead'] ? 'tech-lead' : (editedTier?.planner ? 'planner' : null)
    const partner = partnerRole ? editedTier[partnerRole] : null
    if (reviewer && partner && reviewer.provider === partner.provider) {
      refusals.push({ code: 'cross_vendor', message: `cross-vendor panel invariant failed for ${tier}: reviewer and ${partnerRole} share provider "${reviewer.provider}"; see crew/roster-refresh.test.mjs:134-141 and #206's fused panel` })
    }
    const judge = afterRoster.tiers?.judge
    if (judge?.['tech-lead'] && judge?.planner && judge['tech-lead'].provider === judge.planner.provider) {
      refusals.push({ code: 'judge_vendor_split', message: `judge tech-lead and planner must use different providers (both use "${judge['tech-lead'].provider}"); see crew/roster-refresh.test.mjs:130-132` })
    }
  }

  if (refusals.length) return { ok: false, refusals, diff: null, before, after: null }
  const canonicalAfter = JSON.stringify(afterRoster, null, 2)
  const afterText = rosterText.endsWith('\n') ? `${canonicalAfter}\n` : canonicalAfter
  const diff = unifiedDiff(rosterText, afterText, { path: 'crew/roster.json' })
  return { ok: true, refusals: [], diff, before, after: clone(cell) }
}
