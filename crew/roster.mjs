import { readFileSync } from 'node:fs'
import { ASSURANCE_NAMES, ASSURANCE_ALIAS_OF, canonicalAssurance } from './assurances.mjs'

export const ROSTER_SCHEMA_VERSIONS = Object.freeze([1, 2])
export const ROSTER_TRANSPORTS = Object.freeze(['pane', 'headless-json', 'headless-rpc', 'headless-api'])
export const ROSTER_REFUSALS = Object.freeze([
  'roster-not-object',               // the document is not a JSON object
  'roster-version-unknown',          // schema_version outside ROSTER_SCHEMA_VERSIONS
  'roster-version-mismatch',         // declared version disagrees with the container
  'roster-seating-absent',           // neither "tiers" nor "assurances" is declared
  'roster-seating-both',             // both names are declared, whatever their values
  'roster-seating-invalid',          // the sole declared container is not a usable map
  'roster-seating-unknown',          // a seating key the vocabulary does not name
  'roster-seating-incomplete',       // a preset is missing from the seating
  'roster-transport-policy-invalid', // transport_policy is not a closed usable object
  'roster-transport-invalid',        // transports is empty, duplicate, or unknown
  'roster-transport-stage-invalid',  // stage is missing, malformed, or forbidden
  'roster-batch-stage-critical',     // batch eligibility names a loop/unknown stage
])
export function refuseRoster (reason, message) {
  if (!ROSTER_REFUSALS.includes(reason)) throw new Error(`unknown roster refusal reason ${JSON.stringify(reason)}`)
  return Object.assign(new Error(`${message} [${reason}]`), { reason })
}

const seatingMap = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null)

export function rosterSeating (roster) {
  return seatingMap(roster?.tiers) ?? seatingMap(roster?.assurances)
}

const plainRecord = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function assertRosterTransportPolicies (roster, offCriticalStages) {
  if (!(offCriticalStages instanceof Set)
    || [...offCriticalStages].some((stage) => typeof stage !== 'string' || stage.length === 0)) {
    throw refuseRoster('roster-transport-stage-invalid', 'off-critical stage declarations must be a Set of non-empty strings')
  }
  const seating = rosterSeating(roster)
  if (!seating) throw refuseRoster('roster-transport-policy-invalid', 'cannot validate transport policies without a seating map')
  const policyKeys = ['transports', 'batch_eligible', 'stage']
  for (const [tier, cells] of Object.entries(seating)) {
    if (cells === null || typeof cells !== 'object') continue
    for (const [role, cell] of Object.entries(cells)) {
      if (cell === null || typeof cell !== 'object' || !Object.hasOwn(cell, 'transport_policy')) continue
      const policy = cell.transport_policy
      const where = `transport_policy at ${tier}.${role}`
      if (!plainRecord(policy) || Reflect.ownKeys(policy).some((key) => typeof key !== 'string' || !policyKeys.includes(key))) {
        throw refuseRoster('roster-transport-policy-invalid', `${where} must be a closed object with transports and batch_eligible`)
      }
      if (!Array.isArray(policy.transports) || policy.transports.length === 0) {
        throw refuseRoster('roster-transport-invalid', `${where}.transports must be a non-empty array`)
      }
      const seen = new Set()
      for (const transport of policy.transports) {
        if (typeof transport !== 'string' || !ROSTER_TRANSPORTS.includes(transport) || seen.has(transport)) {
          throw refuseRoster('roster-transport-invalid', `${where}.transports must contain each allowed transport exactly once`)
        }
        seen.add(transport)
      }
      if (typeof policy.batch_eligible !== 'boolean') {
        throw refuseRoster('roster-transport-policy-invalid', `${where}.batch_eligible must be boolean`)
      }
      if (policy.batch_eligible) {
        if (!Object.hasOwn(policy, 'stage') || typeof policy.stage !== 'string' || policy.stage.length === 0) {
          throw refuseRoster('roster-transport-stage-invalid', `${where}.stage is required for batch eligibility`)
        }
        if (!offCriticalStages.has(policy.stage)) {
          throw refuseRoster('roster-batch-stage-critical', `${where}.stage ${JSON.stringify(policy.stage)} is not an off-critical stage`)
        }
      } else if (Object.hasOwn(policy, 'stage')) {
        throw refuseRoster('roster-transport-stage-invalid', `${where}.stage is forbidden when batch_eligible is false`)
      }
    }
  }
}

export function normalizeRoster (raw) {
  if (seatingMap(raw) === null) throw refuseRoster('roster-not-object', 'roster must be a JSON object')
  // DECLARATION is the presence of the NAME, never the usability of the value.
  // {schema_version: 2, tiers: [], assurances: <valid>} is malformed, and Boot
  // (TRD §7.3) runs no schema validation — this normaliser is the only refusal
  // there is, so a value-shaped predicate would silently overwrite the illegal
  // declaration instead of naming it.
  const declaresLegacy = Object.hasOwn(raw, 'tiers')
  const declaresCanonical = Object.hasOwn(raw, 'assurances')
  if (declaresLegacy && declaresCanonical) throw refuseRoster('roster-seating-both', 'roster declares both "tiers" and "assurances"; exactly one is the seating')
  if (!declaresLegacy && !declaresCanonical) throw refuseRoster('roster-seating-absent', 'roster declares neither "tiers" nor "assurances"')
  const legacySeating = seatingMap(raw.tiers)
  const canonicalSeating = seatingMap(raw.assurances)
  if (!legacySeating && !canonicalSeating) throw refuseRoster('roster-seating-invalid', `roster declares "${declaresLegacy ? 'tiers' : 'assurances'}" but its value is not a JSON object`)
  const inferred = declaresLegacy ? 1 : 2
  const declared = raw.schema_version ?? inferred
  if (!ROSTER_SCHEMA_VERSIONS.includes(declared)) throw refuseRoster('roster-version-unknown', `roster schema_version ${JSON.stringify(declared)} is not one of ${ROSTER_SCHEMA_VERSIONS.join(', ')}`)
  if (declared !== inferred) throw refuseRoster('roster-version-mismatch', `roster declares schema_version ${declared} but carries a version ${inferred} seating container`)
  const seating = legacySeating ?? canonicalSeating
  // Both expected key sets come from crew/assurances.mjs. A second literal list
  // here is the vocabulary copy criterion (c) forbids.
  const expected = inferred === 1 ? ASSURANCE_NAMES.map((name) => ASSURANCE_ALIAS_OF[name]) : [...ASSURANCE_NAMES]
  for (const key of Object.keys(seating)) {
    if (!expected.includes(key)) throw refuseRoster('roster-seating-unknown', `roster seating key ${JSON.stringify(key)} is not an assurance preset; crew/assurances.mjs names ${expected.join(', ')}`)
  }
  if (Object.keys(seating).length !== expected.length) throw refuseRoster('roster-seating-incomplete', `roster seats ${Object.keys(seating).length} of ${expected.length} presets; crew/assurances.mjs names ${expected.join(', ')}`)
  const tiers = {}
  const assurances = {}
  for (const name of ASSURANCE_NAMES) {
    const cell = seating[inferred === 1 ? ASSURANCE_ALIAS_OF[name] : name]
    tiers[ASSURANCE_ALIAS_OF[name]] = cell
    assurances[name] = cell
  }
  return { ...raw, schema_version: declared, tiers, assurances }
}

export function loadRoster (path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  return normalizeRoster(parsed)
}

// The REPOSITORY serialization: always v2, always the TRD's canonical key
// order, always carrying the roster's own policy.
export function serializeRosterV2 (roster) {
  const seating = rosterSeating(roster)
  if (!seating) throw refuseRoster('roster-seating-absent', 'cannot serialize a roster with no seating container')
  const assurances = {}
  for (const name of ASSURANCE_NAMES) {
    const key = Object.keys(seating).find((entry) => canonicalAssurance(entry) === name)
    if (key === undefined) throw refuseRoster('roster-seating-incomplete', `cannot serialize a roster that does not seat ${JSON.stringify(name)}`)
    assurances[name] = seating[key]
  }
  return JSON.stringify({ schema_version: 2, updated_at: roster.updated_at, assurances, models: roster.models, policy: roster.policy ?? {} }, null, 2)
}

// The COMPATIBILITY serialization: a v1 file that is written back stays a v1
// file, byte-for-byte in shape, for every reader that cannot read v2 yet. The
// v1 root is closed, so no `policy` and no `assurances` may appear here.
export function serializeRosterV1 (roster) {
  const seating = rosterSeating(roster)
  if (!seating) throw refuseRoster('roster-seating-absent', 'cannot serialize a roster with no seating container')
  const tiers = {}
  for (const name of ASSURANCE_NAMES) {
    const key = Object.keys(seating).find((entry) => canonicalAssurance(entry) === name)
    if (key === undefined) throw refuseRoster('roster-seating-incomplete', `cannot serialize a roster that does not seat ${JSON.stringify(name)}`)
    tiers[ASSURANCE_ALIAS_OF[name]] = seating[key]
  }
  return JSON.stringify({ schema_version: 1, updated_at: roster.updated_at, tiers, models: roster.models }, null, 2)
}
