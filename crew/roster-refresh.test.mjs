import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeCatalog, diffModels, renderReport } from './roster-refresh.mjs'

const roster = JSON.parse(readFileSync(new URL('./roster.json', import.meta.url), 'utf8'))
const schema = JSON.parse(readFileSync(new URL('./roster.schema.json', import.meta.url), 'utf8'))

// --- minimal hand-rolled validator (no ajv, no dependency) ------------------
// Supports exactly: $schema, $id, title, $defs, $ref, type (string|array),
// const, enum, required, properties, patternProperties,
// additionalProperties (literal false only), pattern, minimum, items.
function validate(rootSchema, value) {
  const errors = []
  walk(rootSchema, value, '$')
  return errors

  function resolve(node) {
    if (node && node.$ref) return resolve(byPath(rootSchema, node.$ref))
    return node
  }

  function byPath(root, ref) {
    let node = root
    for (const part of ref.replace(/^#\//, '').split('/')) node = node[part]
    return node
  }

  function matchedTypes(value) {
    const matched = new Set()
    if (value === null) matched.add('null')
    else if (Array.isArray(value)) matched.add('array')
    else if (typeof value === 'number') {
      matched.add('number')
      if (Number.isInteger(value)) matched.add('integer')
    } else if (typeof value === 'string') matched.add('string')
    else if (typeof value === 'boolean') matched.add('boolean')
    else if (typeof value === 'object') matched.add('object')
    return matched
  }

  function walk(schemaNode, value, path) {
    const s = resolve(schemaNode)

    if (Object.prototype.hasOwnProperty.call(s, 'const')) {
      if (value !== s.const) errors.push(`${path}: expected const ${JSON.stringify(s.const)}, got ${JSON.stringify(value)}`)
      return
    }
    if (s.enum) {
      if (!s.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(s.enum)}`)
      return
    }

    const matched = matchedTypes(value)
    if (s.type) {
      const types = Array.isArray(s.type) ? s.type : [s.type]
      if (!types.some((t) => matched.has(t))) {
        errors.push(`${path}: expected type ${types.join('|')}, got ${[...matched].join('|') || typeof value}`)
        return
      }
    }

    if (value === null) return

    if (typeof value === 'string' && s.pattern && !new RegExp(s.pattern).test(value)) {
      errors.push(`${path}: ${JSON.stringify(value)} does not match pattern ${s.pattern}`)
    }

    if (typeof value === 'number' && s.minimum !== undefined && value < s.minimum) {
      errors.push(`${path}: ${value} < minimum ${s.minimum}`)
    }

    if (Array.isArray(value) && s.items) {
      value.forEach((item, i) => walk(s.items, item, `${path}[${i}]`))
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of s.required || []) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${path}: missing required property "${key}"`)
      }
      const patternEntries = Object.entries(s.patternProperties || {}).map(([p, sch]) => [new RegExp(p), sch])
      for (const [key, val] of Object.entries(value)) {
        let matchedSchema = null
        if (s.properties && Object.prototype.hasOwnProperty.call(s.properties, key)) {
          matchedSchema = s.properties[key]
        } else {
          for (const [re, sch] of patternEntries) {
            if (re.test(key)) {
              matchedSchema = sch
              break
            }
          }
        }
        if (matchedSchema) {
          walk(matchedSchema, val, `${path}.${key}`)
        } else if (s.additionalProperties === false) {
          errors.push(`${path}: additional property "${key}" not allowed`)
        }
      }
    }
  }
}

// --- negative self-checks: the validator itself must not be vacuous --------
test('validator rejects a wrong schema_version', () => {
  const clone = JSON.parse(JSON.stringify(roster))
  clone.schema_version = 2
  const errors = validate(schema, clone)
  assert.ok(errors.length > 0)
})

test('validator rejects a seat missing effort', () => {
  const clone = JSON.parse(JSON.stringify(roster))
  delete clone.tiers.build.lead.effort
  const errors = validate(schema, clone)
  assert.ok(errors.length > 0)
})

// --- roster.json shape -------------------------------------------------------
test('roster.json validates against roster.schema.json', () => {
  const errors = validate(schema, roster)
  assert.deepEqual(errors, [])
})

test('mechanical.lead is present and exactly null', () => {
  assert.ok('lead' in roster.tiers.mechanical)
  assert.equal(roster.tiers.mechanical.lead, null)
})

test('judge tech-lead and planner come from different vendors', () => {
  assert.notEqual(roster.tiers.judge['tech-lead'].provider, roster.tiers.judge.planner.provider)
})

test('every panel-capable tier pairs reviewer and partner across vendors', () => {
  for (const [tier, seats] of Object.entries(roster.tiers)) {
    const reviewer = seats.reviewer
    const partnerRole = ['tech-lead', 'planner'].find((role) => seats[role])
    if (!reviewer || !partnerRole) continue
    assert.notEqual(reviewer.provider, seats[partnerRole].provider, `${tier}: reviewer and ${partnerRole} must be cross-vendor`)
  }
})

test('every seated model resolves into the models map', () => {
  for (const seats of Object.values(roster.tiers)) {
    for (const entry of Object.values(seats)) {
      if (entry === null) continue
      const key = `${entry.provider}/${entry.id}`
      assert.ok(Object.prototype.hasOwnProperty.call(roster.models, key), `missing models["${key}"]`)
    }
  }
})

// --- roster-refresh.mjs pure functions --------------------------------------
const CATALOG_A = {
  anthropic: {
    id: 'anthropic',
    env: [],
    npm: '',
    name: 'Anthropic',
    doc: '',
    models: {
      'claude-sonnet-5': {
        id: 'claude-sonnet-5',
        name: 'Sonnet 5',
        family: 'claude',
        reasoning: true,
        tool_call: true,
        knowledge: '',
        release_date: '',
        modalities: {},
        limit: { context: 1000000, output: 64000 },
        cost: { input: 2, output: 10, cache_read: 0.2 },
      },
      'embed-1': {
        id: 'embed-1',
        name: 'Embed',
        family: 'claude',
        reasoning: false,
        tool_call: false,
        knowledge: '',
        release_date: '',
        modalities: {},
        limit: { context: 8192 },
      },
    },
  },
  openai: {
    id: 'openai',
    env: [],
    npm: '',
    name: 'OpenAI',
    doc: '',
    models: {
      'gpt-5.6-sol': {
        id: 'gpt-5.6-sol',
        name: 'sol',
        family: 'gpt',
        reasoning: true,
        tool_call: true,
        knowledge: '',
        release_date: '',
        modalities: {},
        limit: { context: 1050000 },
        cost: { input: 5, output: 30 },
      },
    },
  },
}

const CATALOG_B = JSON.parse(JSON.stringify(CATALOG_A))
CATALOG_B.anthropic.models['claude-sonnet-5'].cost.input = 4
delete CATALOG_B.openai.models['gpt-5.6-sol']
CATALOG_B.anthropic.models['claude-haiku-4-5'] = {
  id: 'claude-haiku-4-5',
  name: 'Haiku 4.5',
  family: 'claude',
  reasoning: true,
  tool_call: true,
  knowledge: '',
  release_date: '',
  modalities: {},
  limit: { context: 200000 },
  cost: { input: 1, output: 5 },
}

test('normalizeCatalog flattens a fixture catalog and skips cost-less models', () => {
  const normalized = normalizeCatalog(CATALOG_A)
  assert.deepEqual(normalized['anthropic/claude-sonnet-5'], { cost_in_per_mtok: 2, cost_out_per_mtok: 10, context: 1000000 })
  assert.deepEqual(normalized['openai/gpt-5.6-sol'], { cost_in_per_mtok: 5, cost_out_per_mtok: 30, context: 1050000 })
  assert.equal('anthropic/embed-1' in normalized, false)
})

const NA = normalizeCatalog(CATALOG_A)
const NB = normalizeCatalog(CATALOG_B)

test('diffModels is idempotent', () => {
  const d1 = diffModels(NA, NB)
  const d2 = diffModels(NA, NB)
  assert.deepEqual(d1, d2)
  assert.equal(JSON.stringify(d1), JSON.stringify(d2))
})

test('a changed price surfaces in the diff', () => {
  const diff = diffModels(NA, NB)
  assert.deepEqual(diff.changed[0].fields, [{ field: 'cost_in_per_mtok', from: 2, to: 4 }])
})

test('an unchanged catalog produces a no-op diff', () => {
  const diff = diffModels(NA, NA)
  assert.deepEqual(diff, { added: [], removed: [], changed: [] })
})

test('a new and a disappeared model land in the right buckets', () => {
  const diff = diffModels(NA, NB)
  assert.deepEqual(
    diff.added.map((m) => m.key),
    ['anthropic/claude-haiku-4-5']
  )
  assert.deepEqual(
    diff.removed.map((m) => m.key),
    ['openai/gpt-5.6-sol']
  )
})

test('renderReport body is deterministic', () => {
  const diff = diffModels(NA, NB)
  const r1 = renderReport(diff, { generatedAt: 't1', rosterUpdatedAt: '2026-08-13' })
  const r2 = renderReport(diff, { generatedAt: 't2', rosterUpdatedAt: '2026-08-13' })
  const strip = (s) => s.split('\n').filter((line) => !line.startsWith('generated_at:')).join('\n')
  assert.equal(strip(r1), strip(r2))
})
