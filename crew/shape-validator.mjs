// Import-free validator leaf: safe for driver and server consumers.

const EXECUTIONS = Object.freeze(['reviewed', 'envelope'])
const WRITE_SURFACES = Object.freeze(['planned', 'none'])
const ENVELOPE_FIELD_KINDS = Object.freeze(['text', 'records', 'paths', 'object'])

const SHAPE_SOURCES = Object.freeze({
  scope: Object.freeze(['plan', 'inherited', 'brief']),
  lane: Object.freeze(['plan', 'ctx']),
  gate: Object.freeze(['plan', 'none', 'brief']),
})

const REVIEWED_CORE_STAGES = Object.freeze(['build', 'scope-gate', 'lane', 'review', 'commit', 'document', 'rebase', 'suite', 'publish'])
const ENVELOPE_STAGE_ORDERS = Object.freeze({
  scout: Object.freeze(['scout', 'scope-gate', 'envelope-accept']),
  review_only: Object.freeze(['review_only', 'scope-gate', 'envelope-accept']),
  review_panel: Object.freeze(['review_panel', 'scope-gate', 'envelope-accept']),
  verify_only: Object.freeze(['verify_only', 'scope-gate', 'envelope-accept']),
})

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

export const SHAPE_DEFECT_CODES = Object.freeze([
  'stage-reordered', 'stage-extra', 'stage-missing', 'stage-unimplemented', 'seats-mismatch',
  'declaration-missing', 'execution-invalid', 'writes-invalid', 'accepted-by-invalid',
  'stages-invalid', 'envelope-fields-invalid', 'boolean-field-invalid',
  'envelope-field-kind-invalid', 'envelope-field-name-invalid', 'envelope-field-metadata-invalid',
  'sources-invalid',
])

export const EXECUTOR_TOPOLOGIES = deepFreeze({
  full: {
    execution: 'reviewed',
    required_seats: 'tier',
    stages: Object.freeze(['plan', 'check', 'build', 'scope-gate', 'lane', 'gate',
      'gate-baseline', 'gate-repair', 'gate-reverify', 'gate-proof', 'review',
      'commit', 'document', 'rebase', 'suite', 'publish', 'converge']),
  },
  scout: {
    execution: 'envelope',
    required_seats: Object.freeze(['planner']),
    stages: ENVELOPE_STAGE_ORDERS.scout,
  },
  review_only: {
    execution: 'envelope',
    required_seats: Object.freeze(['reviewer']),
    stages: ENVELOPE_STAGE_ORDERS.review_only,
  },
  review_panel: {
    execution: 'envelope',
    required_seats: Object.freeze(['reviewer', 'tech-lead', 'lead']),
    stages: ENVELOPE_STAGE_ORDERS.review_panel,
  },
  repair: {
    execution: 'reviewed',
    required_seats: 'tier',
    stages: Object.freeze(['repair', ...REVIEWED_CORE_STAGES]),
    sources: Object.freeze({ scope: 'inherited', lane: 'ctx', gate: 'none' }),
  },
  directed: {
    execution: 'reviewed',
    required_seats: Object.freeze(['builder', 'reviewer']),
    stages: Object.freeze(['directed', 'build', 'scope-gate',
      'lane', 'gate', 'gate-baseline', 'gate-proof', 'review',
      'commit', 'document', 'rebase', 'suite', 'publish', 'converge']),
    sources: Object.freeze({ scope: 'brief', lane: 'ctx', gate: 'brief' }),
  },
  verify_only: {
    execution: 'envelope',
    required_seats: Object.freeze(['reviewer']),
    stages: ENVELOPE_STAGE_ORDERS.verify_only,
  },
})

const ALL_STAGE_HEADS = new Set(Object.values(EXECUTOR_TOPOLOGIES).flatMap(({ stages }) => stages))

function hasOwn(object, key) {
  return object !== null && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key)
}

function frozenStringArrayDefect(value, label) {
  if (!Array.isArray(value) || !Object.isFrozen(value) || value.length === 0) {
    return `${label} must be a frozen non-empty string array`
  }
  if (value.some((item) => typeof item !== 'string' || !item)) return `${label} must contain only non-empty strings`
  if (new Set(value).size !== value.length) return `${label} must contain unique strings`
  return null
}

export function envelopeFieldMetadataDefect(field, envelopeFields = []) {
  if (!field || typeof field !== 'object' || Array.isArray(field)) return 'envelope field must be an object'
  const kind = field.kind
  if (kind === 'object') {
    const metadataKeys = ['values', 'allow_empty', 'item_fields', 'optional_item_fields', 'item_values', 'item_patterns', 'cardinality', 'covers']
    const metadataKey = metadataKeys.find((key) => hasOwn(field, key))
    if (metadataKey) return `envelope field ${JSON.stringify(field.name)} may not declare ${metadataKey} on object`
  }
  const itemFields = Array.isArray(field.item_fields) ? field.item_fields : []
  const itemSet = new Set(itemFields)
  const optionalItemFields = Array.isArray(field.optional_item_fields) ? field.optional_item_fields : []
  const optionalItemSet = new Set(optionalItemFields)
  const declaredItemSet = new Set([...itemFields, ...optionalItemFields])
  if (hasOwn(field, 'values')) {
    if (kind !== 'text') return `envelope field ${JSON.stringify(field.name)} may declare values only on text`
    const defect = frozenStringArrayDefect(field.values, `envelope field ${JSON.stringify(field.name)}.values`)
    if (defect) return defect
  }
  if (kind === 'paths' && hasOwn(field, 'item_fields')) return `envelope field ${JSON.stringify(field.name)} may declare item_fields only on records`
  if (hasOwn(field, 'allow_empty') && kind !== 'records' && kind !== 'paths') {
    return `envelope field ${JSON.stringify(field.name)} may declare allow_empty only on records`
  }
  for (const key of ['item_values', 'item_patterns', 'cardinality', 'optional_item_fields']) {
    if (hasOwn(field, key) && kind !== 'records') return `envelope field ${JSON.stringify(field.name)} may declare ${key} only on records`
  }
  if (hasOwn(field, 'allow_empty') && typeof field.allow_empty !== 'boolean') {
    return `envelope field ${JSON.stringify(field.name)}.allow_empty must be boolean`
  }
  if (hasOwn(field, 'covers')) {
    if (kind !== 'records') return `envelope field ${JSON.stringify(field.name)} may declare covers only on records`
    const covers = field.covers
    if (!covers || typeof covers !== 'object' || Array.isArray(covers)) return `envelope field ${JSON.stringify(field.name)}.covers must be an object`
    if (typeof covers.field !== 'string' || !covers.field || covers.field === field.name) return `envelope field ${JSON.stringify(field.name)}.covers.field must name another records field`
    const covered = envelopeFields.find((candidate) => candidate?.name === covers.field)
    if (!covered) return `envelope field ${JSON.stringify(field.name)}.covers.field ${JSON.stringify(covers.field)} is not declared`
    if (covered.kind !== 'records') return `envelope field ${JSON.stringify(field.name)}.covers.field ${JSON.stringify(covers.field)} must be records`
    if (typeof covers.key !== 'string' || !covers.key) return `envelope field ${JSON.stringify(field.name)}.covers.key must name an item field`
    if (!itemFields.includes(covers.key) || !Array.isArray(covered.item_fields) || !covered.item_fields.includes(covers.key)) {
      return `envelope field ${JSON.stringify(field.name)}.covers.key ${JSON.stringify(covers.key)} must be required by both records fields`
    }
  }
  if (kind === 'records' && (!Array.isArray(field.item_fields) || itemFields.some((name) => typeof name !== 'string' || !name) || new Set(itemFields).size !== itemFields.length)) {
    return `envelope field ${JSON.stringify(field.name)}.item_fields must be unique non-empty strings`
  }
  if (hasOwn(field, 'optional_item_fields') && (!Array.isArray(field.optional_item_fields) || optionalItemFields.some((name) => typeof name !== 'string' || !name) || new Set(optionalItemFields).size !== optionalItemFields.length)) {
    return `envelope field ${JSON.stringify(field.name)}.optional_item_fields must be unique non-empty strings`
  }
  if (optionalItemFields.some((name) => itemSet.has(name))) return `envelope field ${JSON.stringify(field.name)}.optional_item_fields must be disjoint from item_fields`
  for (const [key, values] of Object.entries(field.item_values || {})) {
    if (!declaredItemSet.has(key)) return `envelope field ${JSON.stringify(field.name)}.item_values names undeclared item field ${JSON.stringify(key)}`
    const defect = frozenStringArrayDefect(values, `envelope field ${JSON.stringify(field.name)}.item_values.${key}`)
    if (defect) return defect
  }
  if (hasOwn(field, 'item_values') && (!field.item_values || typeof field.item_values !== 'object' || Array.isArray(field.item_values))) {
    return `envelope field ${JSON.stringify(field.name)}.item_values must be an object`
  }
  for (const [key, source] of Object.entries(field.item_patterns || {})) {
    if (!declaredItemSet.has(key)) return `envelope field ${JSON.stringify(field.name)}.item_patterns names undeclared item field ${JSON.stringify(key)}`
    if (typeof source !== 'string') return `envelope field ${JSON.stringify(field.name)}.item_patterns.${key} must be a regex source`
    try { new RegExp(source) } catch { return `envelope field ${JSON.stringify(field.name)}.item_patterns.${key} is not a valid regex` }
  }
  if (hasOwn(field, 'item_patterns') && (!field.item_patterns || typeof field.item_patterns !== 'object' || Array.isArray(field.item_patterns))) {
    return `envelope field ${JSON.stringify(field.name)}.item_patterns must be an object`
  }
  if (hasOwn(field, 'cardinality')) {
    const cardinality = field.cardinality
    if (!cardinality || typeof cardinality !== 'object' || Array.isArray(cardinality)) return `envelope field ${JSON.stringify(field.name)}.cardinality must be an object`
    const { discriminator, empty, nonempty } = cardinality
    if (typeof discriminator !== 'string' || !discriminator) return `envelope field ${JSON.stringify(field.name)}.cardinality.discriminator must name a text field`
    const discriminatorField = envelopeFields.find((candidate) => candidate?.name === discriminator)
    if (!discriminatorField) return `envelope field ${JSON.stringify(field.name)}.cardinality discriminator ${JSON.stringify(discriminator)} is not declared`
    if (discriminatorField.kind !== 'text') return `envelope field ${JSON.stringify(field.name)}.cardinality discriminator ${JSON.stringify(discriminator)} must be text`
    if (typeof empty !== 'string' || !empty || typeof nonempty !== 'string' || !nonempty || empty === nonempty) {
      return `envelope field ${JSON.stringify(field.name)}.cardinality must name distinct empty and nonempty values`
    }
    if (!Array.isArray(discriminatorField.values) || !discriminatorField.values.includes(empty) || !discriminatorField.values.includes(nonempty)) {
      return `envelope field ${JSON.stringify(field.name)}.cardinality values must belong to the discriminator's closed values`
    }
  }
  return null
}

function sourcesDefect(sources) {
  if (!sources || typeof sources !== 'object') return 'no sources declared'
  const keys = Object.keys(SHAPE_SOURCES)
  const extra = Object.keys(sources).filter((key) => !keys.includes(key))
  if (extra.length) {
    return `sources declares ${extra.join(', ')}, which nothing reads — the source keys are exactly ${keys.join(', ')}`
  }
  for (const key of keys) {
    if (!SHAPE_SOURCES[key].includes(sources[key])) {
      return `sources.${key} must be one of ${SHAPE_SOURCES[key].join(', ')}`
    }
  }
  return null
}

function partialTopologyDetail(variantName) {
  return `the partial reviewed shapes this driver implements are repair and directed; a declaration registered as ${JSON.stringify(variantName ?? null)} would open ${JSON.stringify(`${variantName}:r1`)}, a stage it does not declare`
}

function topologyDetail(defect, variantName, actual, expected) {
  if (defect === 'stage-missing') {
    const missing = expected.filter((head) => !actual.includes(head))
    const topology = EXECUTOR_TOPOLOGIES[variantName]
    if (topology?.execution === 'envelope' && missing.includes('envelope-accept')) {
      return 'an envelope shape must declare its envelope-accept stage'
    }
    if (topology?.execution === 'envelope' && missing.includes('scope-gate')) {
      return 'a shape that claims to write nothing must declare the scope-gate stage that proves it'
    }
    if (variantName === 'full' && expected === EXECUTOR_TOPOLOGIES.full.stages) return partialTopologyDetail(variantName)
  }
  return `a ${variantName} shape runs exactly ${expected.join(', ')}; this declaration runs ${actual.join(', ')}`
}

function sameSeats(actual, expected) {
  return Array.isArray(actual) && Array.isArray(expected)
    ? actual.length === expected.length && expected.every((seat, index) => actual[index] === seat)
    : actual === expected
}

function topologyDefect(topology, actual, verdict) {
  const expected = topology.stages
  if (actual.some((head) => !expected.includes(head)) || actual.length > expected.length) {
    return verdict('stage-extra', actual, expected)
  }
  if (expected.some((head) => !actual.includes(head))) {
    return verdict('stage-missing', actual, expected)
  }
  if (actual.some((head, i) => actual[i] !== expected[i])) {
    return verdict('stage-reordered', actual, expected)
  }
  return { defect: null, detail: null }
}

export function shapeValidationDefect(shape, variantName = 'full') {
  const verdict = (defect, detailOrActual, expected) => ({
    defect,
    detail: expected === undefined ? detailOrActual : topologyDetail(defect, variantName, detailOrActual, expected),
  })

  if (!shape || typeof shape !== 'object') return verdict('declaration-missing', 'no declaration')
  if (!EXECUTIONS.includes(shape.execution)) return verdict('execution-invalid', `execution must be one of ${EXECUTIONS.join(', ')}`)
  if (!WRITE_SURFACES.includes(shape.writes)) return verdict('writes-invalid', `writes must be one of ${WRITE_SURFACES.join(', ')}`)
  if (typeof shape.accepted_by !== 'string' || !shape.accepted_by.trim()) return verdict('accepted-by-invalid', 'accepted_by must say what accepts this shape')
  if (!Array.isArray(shape.stages) || shape.stages.length === 0) return verdict('stages-invalid', 'stages must declare the heads this shape emits')
  if (!Array.isArray(shape.envelope_fields)) return verdict('envelope-fields-invalid', 'envelope_fields must be an array')
  for (const key of ['strict_identity', 'report_values']) {
    if (hasOwn(shape, key) && typeof shape[key] !== 'boolean') return verdict('boolean-field-invalid', `${key} must be boolean`)
  }
  const fieldNames = new Set()
  for (const field of shape.envelope_fields) {
    if (!ENVELOPE_FIELD_KINDS.includes(field?.kind)) return verdict('envelope-field-kind-invalid', `envelope field ${JSON.stringify(field?.name)} must declare a kind in ${ENVELOPE_FIELD_KINDS.join(', ')}`)
    if (typeof field.name !== 'string' || !field.name || fieldNames.has(field.name)) return verdict('envelope-field-name-invalid', 'envelope fields must have unique non-empty names')
    fieldNames.add(field.name)
    const metadataDefect = envelopeFieldMetadataDefect(field, shape.envelope_fields)
    if (metadataDefect) return verdict('envelope-field-metadata-invalid', metadataDefect)
  }

  const topology = EXECUTOR_TOPOLOGIES[variantName] ?? null
  if (shape.execution === 'reviewed') {
    const fullStages = EXECUTOR_TOPOLOGIES.full.stages
    const missingFull = fullStages.filter((head) => !shape.stages.includes(head))
    const partialTopology = missingFull.length && topology?.execution === 'reviewed' && topology !== EXECUTOR_TOPOLOGIES.full
      ? topology
      : null
    const seats = partialTopology ? partialTopology.required_seats : 'tier'
    if (Array.isArray(seats)) {
      if (!Array.isArray(shape.required_seats) || shape.required_seats.length !== seats.length
        || seats.some((role, i) => shape.required_seats[i] !== role)) {
        return verdict('seats-mismatch', `the ${variantName} shape runs exactly ${seats.join(', ')}; required_seats must be that list`)
      }
    } else if (shape.required_seats !== 'tier') {
      return verdict('seats-mismatch', 'a reviewed shape is seated by the tier; required_seats must be "tier"')
    }

    if (missingFull.length) {
      const undeclared = sourcesDefect(shape.sources)
      if (undeclared) {
        const detail = `the reviewed executor implements exactly the full stage set; this declaration omits ${missingFull.join(', ')}, and a partial reviewed shape needs declared sources for scope, lane and gate before it can be run: ${undeclared}`
        const code = topology === EXECUTOR_TOPOLOGIES.full ? 'stage-missing' : 'sources-invalid'
        return verdict(code, detail)
      }
      if (topology?.execution === 'reviewed' && topology !== EXECUTOR_TOPOLOGIES.full) {
        const sourced = Object.keys(SHAPE_SOURCES).map((key) => `${key}=${shape.sources[key]}`).join(', ')
        if (Object.keys(SHAPE_SOURCES).some((key) => shape.sources[key] !== topology.sources[key])) {
          return verdict('sources-invalid', `the ${variantName} shape sources ${Object.entries(topology.sources).map(([k, v]) => `${k}=${v}`).join(', ')}; this declaration sources ${sourced}`)
        }
      }
    }

    const unknownIndex = shape.stages.findIndex((head) => !ALL_STAGE_HEADS.has(head))
    if (unknownIndex !== -1) return verdict('stage-unimplemented', `stage ${JSON.stringify(shape.stages[unknownIndex])} is not implemented by the executor`)
    if (!topology || topology.execution !== 'reviewed') return verdict('stage-unimplemented', partialTopologyDetail(variantName))
    return topologyDefect(topology, shape.stages, verdict)
  }

  const seats = shape.required_seats
  const expectedEnvelopeSeats = topology?.execution === 'envelope' ? topology.required_seats : null
  if (expectedEnvelopeSeats) {
    if (!sameSeats(seats, expectedEnvelopeSeats)) {
      return verdict('seats-mismatch', `the ${variantName} shape runs exactly ${expectedEnvelopeSeats.join(', ')}; required_seats must be that list`)
    }
  } else if (!Array.isArray(seats) || seats.length !== 1 || typeof seats[0] !== 'string' || !seats[0]) {
    return verdict('seats-mismatch', 'an envelope shape runs exactly one declared seat; required_seats must be a one-role array')
  }
  if (shape.writes !== 'none') return verdict('writes-invalid', 'an envelope shape has no plan to source a write surface from; writes must be "none"')

  const unknownIndex = shape.stages.findIndex((head) => !ALL_STAGE_HEADS.has(head))
  if (unknownIndex !== -1) return verdict('stage-unimplemented', `stage ${JSON.stringify(shape.stages[unknownIndex])} is not implemented by the executor`)
  if (!topology || topology.execution !== 'envelope') {
    if (!shape.stages.includes('envelope-accept')) return verdict('stage-missing', 'an envelope shape must declare its envelope-accept stage')
    if (!shape.stages.includes('scope-gate')) return verdict('stage-missing', 'a shape that claims to write nothing must declare the scope-gate stage that proves it')
    return topology ? { defect: null, detail: null } : verdict('stage-unimplemented', `the ${variantName} shape is not an implemented envelope topology`)
  }

  return topologyDefect(topology, shape.stages, verdict)
}
