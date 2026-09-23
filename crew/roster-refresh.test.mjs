import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { parseArgs, normalizeCatalog, diffModels, readRosterModels, renderReport, successorOf, planBump, applyBump, catalogEntry, proseMentions, commitWrites, bumpLadder, replaceIds, modelFamily, rateDepartures, replacedBenches } from './roster-refresh.mjs'

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

test('agent declarations use register-shaped names instead of hardcoded enums', () => {
  const primary = schema.$defs.seat.properties.agent
  const fallback = schema.$defs.fallbackEntry.properties.agent
  for (const declaration of [primary, fallback]) {
    assert.equal(declaration.enum, undefined)
    assert.equal(declaration.pattern, '^[a-z0-9][a-z0-9-]*$')
  }
  assert.deepEqual(validate(schema, roster), [])
  const malformed = structuredClone(roster)
  malformed.tiers.build.builder.agent = 'Pi'
  assert.ok(validate(schema, malformed).length > 0)
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

import { spawnSync } from 'node:child_process'
import { scratchDir } from '../test/helpers.mjs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const REFRESH_TOOL = new URL('./roster-refresh.mjs', import.meta.url).pathname
const fixtureRecord = (costIn, costOut, context) => ({ cost_in_per_mtok: costIn, cost_out_per_mtok: costOut, context })

function withFixtureDirectory(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'roster-refresh-241-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('readRosterModels refuses an array-shaped models block', () => {
  const rosterPath = '/tmp/roster-array-shaped.json'
  const badRoster = { models: ['luna', 'terra', 'sol', 'opus', 'sonnet', 'fable', 'haiku'] }
  assert.throws(
    () => readRosterModels(badRoster, rosterPath),
    (err) => {
      assert.ok(err.message.includes(rosterPath))
      assert.match(err.message, /expected "models" to be an object mapping/)
      assert.match(err.message, /an array of 7 entries/)
      return true
    }
  )
})

test('readRosterModels refuses a record with no numeric cost', () => {
  const key = 'anthropic/not-a-model'
  assert.throws(
    () => readRosterModels({ models: { [key]: { cost_out_per_mtok: 1, context: 1000 } } }, '/tmp/roster-bad-record.json'),
    (err) => {
      assert.ok(err.message.includes(`models["${key}"]`))
      assert.match(err.message, /no numeric cost_in_per_mtok/)
      return true
    }
  )
})

test('readRosterModels accepts the shipped roster', () => {
  const models = readRosterModels(roster, 'crew/roster.json')
  assert.equal(Object.keys(models).length, 15)
})

test('synthetic catalog leaves every shipped llama-swap model under cannot confirm', () => {
  const localKeys = ['llama-swap/qwen3.8-27b', 'llama-swap/gpt-oss-20b', 'llama-swap/gemma4-31b']
  const before = Object.fromEntries(localKeys.map((key) => [key, fixtureRecord(0, 0, 131072)]))
  const after = normalizeCatalog({ 'llama-swap': { models: {} } }, ['llama-swap'])
  const diff = diffModels(before, after)
  const report = renderReport(diff, {
    generatedAt: 'now',
    rosterUpdatedAt: '2026-09-12',
    seatedCount: localKeys.length,
  })
  const sectionStart = report.indexOf('## Seated models the catalog cannot confirm — unverifiable (3)')
  assert.ok(sectionStart >= 0)
  const unverifiable = report.slice(sectionStart)
  assert.match(report, /## Seated models confirmed by the catalog \(0 of 3\)/)
  assert.doesNotMatch(report, /## Seated models confirmed by the catalog \(3 of 3\)/)
  assert.doesNotMatch(report, /No changes vs crew\/roster\.json\./)
  assert.doesNotMatch(unverifiable, /confirmed|unchanged/)
  for (const key of localKeys) {
    assert.ok(unverifiable.includes(`- ${key}: no catalog entry; roster values unverified (cost_in=0 cost_out=0 context=131072)`), key)
  }
})

test('a seated model with no catalog entry is reported as unverifiable, not as unchanged', () => {
  const before = { 'fixture/missing': fixtureRecord(1, 2, 1000) }
  const after = normalizeCatalog({ fixture: { models: { present: { cost: { input: 3, output: 4 }, limit: { context: 2000 } } } } })
  const report = renderReport(diffModels(before, after), {
    generatedAt: 'now',
    rosterUpdatedAt: 'today',
    seatedCount: Object.keys(before).length,
  })
  assert.match(report, /## Seated models the catalog cannot confirm — unverifiable \(1\)/)
  assert.match(report, /- fixture\/missing: no catalog entry; roster values unverified \(cost_in=1 cost_out=2 context=1000\)/)
  assert.doesNotMatch(report, /## Disappeared/)
})

test('the report states how many seated models the catalog confirmed', () => {
  const before = {
    'fixture/changed': fixtureRecord(1, 2, 1000),
    'fixture/same': fixtureRecord(3, 4, 2000),
    'fixture/missing': fixtureRecord(5, 6, 3000),
  }
  const after = normalizeCatalog({ fixture: { models: {
    changed: { cost: { input: 2, output: 2 }, limit: { context: 1000 } },
    same: { cost: { input: 3, output: 4 }, limit: { context: 2000 } },
  } } })
  const opts = { generatedAt: 'now', rosterUpdatedAt: 'today', seatedCount: 3 }
  assert.match(renderReport(diffModels(before, after), opts), /## Seated models confirmed by the catalog \(2 of 3\)/)
  assert.match(renderReport(diffModels(before, before), opts), /## Seated models confirmed by the catalog \(3 of 3\)/)
})

test('the CLI refuses an unreadable roster and prints no diff', () => {
  withFixtureDirectory((dir) => {
    const badPath = join(dir, 'roster-bad.json')
    const catalogPath = join(dir, 'catalog.json')
    writeFileSync(badPath, JSON.stringify({ models: ['luna', 'terra', 'sol', 'opus', 'sonnet', 'fable', 'haiku'] }))
    writeFileSync(catalogPath, JSON.stringify({}))
    const result = spawnSync(process.execPath, [REFRESH_TOOL, '--roster', badPath, '--catalog', catalogPath], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.ok(result.stderr.includes(badPath))
    assert.match(result.stderr, /object/)
    assert.match(result.stderr, /array of 7 entries/)
    assert.doesNotMatch(result.stdout, /# roster-refresh report|## New models/)
  })
})

test('the CLI still diffs a well-formed roster', () => {
  withFixtureDirectory((dir) => {
    const rosterPath = join(dir, 'roster-good.json')
    const catalogPath = join(dir, 'catalog.json')
    const goodRoster = {
      updated_at: 'today',
      tiers: { build: { lead: { provider: 'fixture', id: 'changed' }, reviewer: { provider: 'fixture', id: 'same' } } },
      models: {
        'fixture/changed': fixtureRecord(1, 2, 1000),
        'fixture/same': fixtureRecord(3, 4, 2000),
        'fixture/missing': fixtureRecord(5, 6, 3000),
      },
    }
    const catalog = {
      fixture: { models: {
        changed: { cost: { input: 2, output: 2 }, limit: { context: 1000 } },
        same: { cost: { input: 3, output: 4 }, limit: { context: 2000 } },
        added: { cost: { input: 7, output: 8 }, limit: { context: 4000 } },
      } },
    }
    writeFileSync(rosterPath, JSON.stringify(goodRoster))
    writeFileSync(catalogPath, JSON.stringify(catalog))
    const result = spawnSync(process.execPath, [REFRESH_TOOL, '--roster', rosterPath, '--catalog', catalogPath], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /## New models/)
    assert.match(result.stdout, /fixture\/added/)
    assert.match(result.stdout, /fixture\/changed: cost_in_per_mtok 1->2/)
    assert.match(result.stdout, /unverifiable/)
    assert.match(result.stdout, /2 of 3/)
  })
})

test('the module imports cleanly with no process.argv[1]', () => {
  const moduleUrl = new URL('./roster-refresh.mjs', import.meta.url).href
  const result = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(moduleUrl)})`], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('renderReport preserves removed models for legacy callers', () => {
  const report = renderReport(diffModels(NA, NB), { generatedAt: 'now', rosterUpdatedAt: 'today' })
  assert.match(report, /## Disappeared \(1\)/)
  assert.match(report, /openai\/gpt-5\.6-sol/)
})


// ---- --apply: successor planning -------------------------------------------------------------
const price = (input, output, extra = {}) => ({ cost: { input, output, ...extra }, limit: { context: 1000000 } })
const BUMP_CATALOG = {
  openai: { models: {
    'gpt-5.6-sol': price(4, 20), 'gpt-6-sol': price(2, 10, { cache_read: 0.2, cache_write: 2.5 }),
    'gpt-6-sol-pro': price(40, 200), 'gpt-9-sol-mini': price(1, 1),
    'gpt-5.6-luna': price(0.2, 1.2), 'gpt-6-luna': price(0.1, 0.5),
  } },
  anthropic: { models: {
    'claude-opus-5': price(5, 25), 'claude-opus-5-5': price(4, 20, { cache_read: 0.2 }),
    'claude-opus-5-5-20260922': price(4, 20), 'claude-opus-5-20260922': price(4, 20),
  } },
  meta: { models: { 'muse-spark-1.3-contributor': price(0.1, 0.2), 'muse-spark-1.4': price(1.25, 4.25) } },
}
const CATALOG_KEYS = Object.entries(BUMP_CATALOG).flatMap(([p, v]) => Object.keys(v.models).map((m) => `${p}/${m}`))

// Mutation killed: letting the name group match more than one token picks gpt-6-sol-pro, and
// a missing single-token bound picks gpt-9-sol-mini.
test('SUCC1 a successor is the newest version of the SAME family, never a tier variant', () => {
  assert.deepEqual(successorOf('openai/gpt-5.6-sol', CATALOG_KEYS), { key: 'openai/gpt-5.6-sol', successor: 'openai/gpt-6-sol', reason: null })
  assert.equal(successorOf('openai/gpt-5.6-luna', CATALOG_KEYS).successor, 'openai/gpt-6-luna')
})

// Mutation killed: an unbounded minor reads the date in claude-opus-5-20260922 as version 5.20260922,
// which beats every real release.
test('SUCC2 a dated snapshot is never a successor', () => {
  assert.equal(successorOf('anthropic/claude-opus-5', CATALOG_KEYS).successor, 'anthropic/claude-opus-5-5')
})

// Mutation killed: dropping the tier suffix from the muse family moves a contributor seat
// onto the full-price non-contributor model.
test('SUCC3 a tiered family keeps its tier', () => {
  assert.deepEqual(successorOf('meta/muse-spark-1.3-contributor', CATALOG_KEYS), { key: 'meta/muse-spark-1.3-contributor', successor: null, reason: 'already-newest' })
})

// Mutation killed: guessing a family for an unrecognised shape would reseat a local model.
test('SUCC4 an unrecognised id is never bumped, and says why', () => {
  assert.deepEqual(successorOf('llama-swap/qwen3.8-27b', CATALOG_KEYS), { key: 'llama-swap/qwen3.8-27b', successor: null, reason: 'family-unrecognised' })
})

const BUMP_ROSTER = {
  updated_at: '2026-01-01',
  tiers: {
    build: {
      planner: { id: 'gpt-5.6-sol', agent: 'pi', provider: 'openai' },
      reviewer: { id: 'claude-opus-5', agent: 'claude', provider: 'anthropic' },
    },
    judge: {
      'tech-lead': { id: 'claude-opus-5', agent: 'claude', provider: 'anthropic', fallback: [{ id: 'gpt-5.6-sol', agent: 'pi', provider: 'openai' }] },
    },
  },
  models: {
    'openai/gpt-5.6-sol': { cost_in_per_mtok: 4, cost_out_per_mtok: 20, context: 1000000, tags: ['reasoning'], source: 'models.dev', last_verified: '2026-01-01' },
    'anthropic/claude-opus-5': { cost_in_per_mtok: 5, cost_out_per_mtok: 25, context: 1000000, tags: ['frontier'], source: 'models.dev', last_verified: '2026-01-01' },
  },
}
const BUMP_LADDER = { bands: [{ members: ['anthropic/claude-opus-5', 'openai/gpt-5.6-sol'], membership_basis: 'openai/gpt-5.6-sol scored 61; claude-opus-5 scored 63.' }] }
// Real routing candidates carry their provider (crew/routing-policy.json); a bare id is never mapped.
const BUMP_ROUTING = { routes: { build: { reviewer: { candidates: [{ provider: 'openai', id: 'gpt-5.6-sol' }] } } } }

// Mutation killed: skipping seat fallbacks, the ladder or the routing policy leaves an old
// version running somewhere the operator said it must not.
test('APPLY1 every seat, fallback, catalog key, ladder member and route moves to the successor', () => {
  const plan = planBump(BUMP_ROSTER, BUMP_CATALOG)
  const next = applyBump({ roster: BUMP_ROSTER, ladder: BUMP_LADDER, routing: BUMP_ROUTING }, plan, BUMP_CATALOG, { today: '2026-09-23' })
  assert.equal(next.roster.tiers.build.planner.id, 'gpt-6-sol')
  assert.equal(next.roster.tiers.build.reviewer.id, 'claude-opus-5-5')
  assert.equal(next.roster.tiers.judge['tech-lead'].fallback[0].id, 'gpt-6-sol')
  // The replaced entries stay as unseated price rows; the ladder no longer admits them.
  assert.deepEqual(Object.keys(next.roster.models).sort(), ['anthropic/claude-opus-5', 'anthropic/claude-opus-5-5', 'openai/gpt-5.6-sol', 'openai/gpt-6-sol'])
  // Kept as it was, plus the override-only tag nextModelRung's upgrade walk skips; each successor
  // sits right after the row it replaced.
  assert.deepEqual(next.roster.models['openai/gpt-5.6-sol'], { ...BUMP_ROSTER.models['openai/gpt-5.6-sol'], tags: [...(BUMP_ROSTER.models['openai/gpt-5.6-sol'].tags || []), 'override-only'] })
  const order = Object.keys(next.roster.models)
  assert.equal(order.indexOf('openai/gpt-6-sol'), order.indexOf('openai/gpt-5.6-sol') + 1)
  assert.deepEqual(next.ladder.bands[0].members, ['anthropic/claude-opus-5-5', 'openai/gpt-6-sol'])
  assert.equal(next.routing.routes.build.reviewer.candidates[0].id, 'gpt-6-sol')
  assert.equal(next.roster.updated_at, '2026-09-23')
})

// Mutation killed: replacing substrings rewrites a measured score onto a model that was never
// measured — a true record turned into a false one.
test('APPLY2 prose that records a measurement is left untouched and reported', () => {
  const plan = planBump(BUMP_ROSTER, BUMP_CATALOG)
  const next = applyBump({ roster: BUMP_ROSTER, ladder: BUMP_LADDER, routing: BUMP_ROUTING }, plan, BUMP_CATALOG, { today: '2026-09-23' })
  assert.equal(next.ladder.bands[0].membership_basis, BUMP_LADDER.bands[0].membership_basis)
  assert.deepEqual(proseMentions(next.ladder, plan.bumps).map((h) => h.path), ['.bands[0].membership_basis', '.bands[0].membership_basis'])
})

// Mutation killed: an unbounded match flags claude-opus-5-5 as a mention of claude-opus-5.
test('APPLY3 a successor that extends the old id is not reported as a mention of it', () => {
  const plan = { bumps: [{ from: 'anthropic/claude-opus-5', to: 'anthropic/claude-opus-5-5' }] }
  assert.deepEqual(proseMentions({ members: ['anthropic/claude-opus-5-5'], id: 'claude-opus-5-5' }, plan.bumps), [])
})

// Mutation killed: defaulting an unpublished cache rate to zero claims a free cache the catalog
// never said exists.
test('APPLY4 a cache rate the catalog does not publish is omitted and said so, never zero', () => {
  const entry = catalogEntry('anthropic/claude-opus-5-5', BUMP_CATALOG, { tags: ['frontier'], today: '2026-09-23' })
  assert.equal(entry.cost_cache_read_per_mtok, 0.2)
  assert.equal(Object.hasOwn(entry, 'cost_cache_write_per_mtok'), false)
  assert.match(entry.cache_rate_source, /no cache write rate/)
  assert.deepEqual(entry.tags, ['frontier'])
})

// Mutation killed: a global bare-id map writes one provider's successor into another provider's seat.
test('APPLY5 two providers sharing a bare id each move to their OWN successor', () => {
  const catalog = { openai: { models: { 'gpt-5-sol': price(1, 1), 'gpt-6-sol': price(2, 2) } }, proxy: { models: { 'gpt-5-sol': price(1, 1), 'gpt-7-sol': price(3, 3) } } }
  const roster = { tiers: { build: {
    planner: { provider: 'openai', id: 'gpt-5-sol', agent: 'pi' },
    reviewer: { provider: 'proxy', id: 'gpt-5-sol', agent: 'pi' },
  } }, models: {} }
  const plan = planBump(roster, catalog)
  const next = applyBump({ roster }, plan, catalog, { today: '2026-09-23' })
  assert.equal(next.roster.tiers.build.planner.id, 'gpt-6-sol')
  assert.equal(next.roster.tiers.build.reviewer.id, 'gpt-7-sol')
})

// Mutation killed: letting the retained entry win keeps a stale price the catalog has replaced.
test('APPLY6 a successor already in the roster is refreshed from the catalog, never left stale', () => {
  const roster = { tiers: { build: { planner: { provider: 'openai', id: 'gpt-5.6-sol', agent: 'pi' } } }, models: {
    'openai/gpt-5.6-sol': { cost_in_per_mtok: 4, cost_out_per_mtok: 20, context: 1, tags: ['reasoning'], source: 'models.dev', last_verified: '2026-01-01' },
    'openai/gpt-6-sol': { cost_in_per_mtok: 999, cost_out_per_mtok: 999, context: 1, tags: ['vendor-diverse'], source: 'stale', last_verified: '2025-01-01' },
  } }
  const next = applyBump({ roster }, planBump(roster, BUMP_CATALOG), BUMP_CATALOG, { today: '2026-09-23' })
  assert.equal(next.roster.models['openai/gpt-6-sol'].cost_in_per_mtok, 2)
  assert.equal(next.roster.models['openai/gpt-6-sol'].source, 'models.dev')
  assert.deepEqual(next.roster.models['openai/gpt-6-sol'].tags.sort(), ['reasoning', 'vendor-diverse'])
  assert.equal(next.roster.models['openai/gpt-5.6-sol'].cost_in_per_mtok, 4)
})

// Mutation killed: reporting already-newest for a model the catalog does not list turns
// absence into a version judgment nobody measured.
test('SUCC5 a model the catalog does not list is unconfirmed, not newest', () => {
  assert.deepEqual(successorOf('openai/gpt-4-terra', ['openai/gpt-6-sol']), { key: 'openai/gpt-4-terra', successor: null, reason: 'not-in-catalog' })
  assert.equal(successorOf('openai/gpt-6-sol', ['openai/gpt-6-sol']).reason, 'already-newest')
})

// Mutation killed: dropping fallback enumeration leaves a fallback-only model on its old version.
test('APPLY7 a model used ONLY as a fallback is bumped too', () => {
  const roster = { tiers: { judge: { 'tech-lead': {
    provider: 'anthropic', id: 'claude-opus-5-5', agent: 'claude',
    fallback: [{ provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi' }],
  } } }, models: {} }
  const plan = planBump(roster, BUMP_CATALOG)
  assert.deepEqual(plan.bumps, [{ from: 'openai/gpt-5.6-luna', to: 'openai/gpt-6-luna' }])
  const next = applyBump({ roster }, plan, BUMP_CATALOG, { today: '2026-09-23' })
  assert.equal(next.roster.tiers.judge['tech-lead'].fallback[0].id, 'gpt-6-luna')
})

// Mutation killed: writing targets directly leaves roster and ladder bumped while routing is not.
test('APPLY8 a failed write changes no file, and a failed rename restores what it replaced', () => {
  const files = new Map([['a', 'A0'], ['b', 'B0'], ['c', 'C0']])
  const fsx = (failOn) => ({
    constants: { W_OK: 2 },
    accessSync: () => {},
    writeFileSync: (p, t) => { if (failOn.write === p) throw new Error(`cannot write ${p}`); files.set(p, t) },
    renameSync: (from, to) => { if (failOn.rename === to) throw new Error(`cannot rename ${to}`); files.set(to, files.get(from)); files.delete(from) },
    unlinkSync: (p) => files.delete(p), existsSync: (p) => files.has(p),
  })
  const writes = [['a', 'A0', 'A1'], ['b', 'B0', 'B1'], ['c', 'C0', 'C1']].map(([path, original, next]) => ({ path, original, next }))
  assert.throws(() => commitWrites(writes, fsx({ write: 'c.roster-refresh.tmp' })), /aborted before changing any file/)
  assert.deepEqual([files.get('a'), files.get('b'), files.get('c')], ['A0', 'B0', 'C0'])
  assert.throws(() => commitWrites(writes, fsx({ rename: 'c' })), /restored all 2 file/)
  assert.deepEqual([files.get('a'), files.get('b'), files.get('c')], ['A0', 'B0', 'C0'])
  assert.equal([...files.keys()].some((k) => k.endsWith('.tmp') || k.endsWith('.bak')), false)
})

// Mutation killed: searching for a successor before confirming the model is listed bumps a model
// the catalog cannot vouch for.
test('SUCC6 an unlisted model is not bumped even when its family has a listed successor', () => {
  assert.deepEqual(successorOf('openai/gpt-5.6-sol', ['openai/gpt-6-sol']), { key: 'openai/gpt-5.6-sol', successor: null, reason: 'not-in-catalog' })
})

// Mutation killed: dropping the dedupe writes a ladder naming the successor twice, which
// loadLadder rejects.
test('LADDER1 a band that already holds the successor keeps one copy', () => {
  const next = bumpLadder({ bands: [{ members: ['openai/gpt-5.6-sol', 'openai/gpt-6-sol'] }] }, { 'openai/gpt-5.6-sol': 'openai/gpt-6-sol' })
  assert.deepEqual(next.bands[0].members, ['openai/gpt-6-sol'])
})

// Mutation killed: dropping the cross-band check silently leaves one model in two bands.
test('LADDER2 a successor already in a DIFFERENT band is refused, not placed', () => {
  assert.throws(
    () => bumpLadder({ bands: [{ members: ['openai/gpt-5.6-sol'] }, { members: ['openai/gpt-6-sol'] }] }, { 'openai/gpt-5.6-sol': 'openai/gpt-6-sol' }),
    /placement decision, not a version bump/,
  )
})

// Mutation killed: a string-value rule rewrites a membership basis that is exactly an id.
test('APPLY9 a basis that is exactly an old id is a record and is never rewritten', () => {
  const next = bumpLadder({ bands: [{ members: ['openai/gpt-5.6-sol'], membership_basis: 'openai/gpt-5.6-sol' }] }, { 'openai/gpt-5.6-sol': 'openai/gpt-6-sol' })
  assert.equal(next.bands[0].membership_basis, 'openai/gpt-5.6-sol')
  assert.deepEqual(next.bands[0].members, ['openai/gpt-6-sol'])
})

// Mutation killed: skipping validation writes an output the runtime's own loader rejects.
test('VALIDATE1 a staged file the loader rejects changes no file', () => {
  const files = new Map([['a', 'A0'], ['b', 'B0']])
  const fsx = {
    constants: { W_OK: 2 }, accessSync: () => {},
    writeFileSync: (p, t) => files.set(p, t),
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from) },
    unlinkSync: (p) => files.delete(p), existsSync: (p) => files.has(p),
  }
  const writes = [
    { path: 'a', original: 'A0', next: 'A1', validate: () => {} },
    { path: 'b', original: 'B0', next: 'B1', validate: () => { throw new Error('ladder names a model twice') } },
  ]
  assert.throws(() => commitWrites(writes, fsx), /aborted before changing any file — ladder names a model twice/)
  assert.deepEqual([files.get('a'), files.get('b')], ['A0', 'B0'])
  assert.equal([...files.keys()].some((k) => k.endsWith('.tmp')), false)
})

// Mutation killed: enumerating only v1 `tiers` leaves a v2 seat — seated under `assurances` and
// absent from the model map — on its old version while its neighbours move.
test('V2SEAT a v2 roster seat is bumped even when its model is not in the catalog map', () => {
  const roster = { assurances: { standard: { reviewer: { provider: 'anthropic', id: 'claude-opus-5', agent: 'claude' } } }, models: {} }
  const plan = planBump(roster, BUMP_CATALOG)
  assert.deepEqual(plan.bumps, [{ from: 'anthropic/claude-opus-5', to: 'anthropic/claude-opus-5-5' }])
  const next = applyBump({ roster }, plan, BUMP_CATALOG, { today: '2026-09-23' })
  assert.equal(next.roster.assurances.standard.reviewer.id, 'claude-opus-5-5')
})

// Mutation killed: swallowing a failed restore reports a whole rollback over a mixed config.
test('ROLLBACK2 a restore that fails is reported, and its original survives on disk', () => {
  const files = new Map([['a', 'A0'], ['b', 'B0']])
  let restoring = false
  const fsx = {
    constants: { W_OK: 2 }, accessSync: () => {},
    writeFileSync: (p, t) => { if (restoring && p === 'a') throw new Error('disk full'); files.set(p, t) },
    renameSync: (from, to) => { if (to === 'b') { restoring = true; throw new Error('cannot rename b') } files.set(to, files.get(from)); files.delete(from) },
    unlinkSync: (p) => files.delete(p), existsSync: (p) => files.has(p),
  }
  const writes = [{ path: 'a', original: 'A0', next: 'A1' }, { path: 'b', original: 'B0', next: 'B1' }]
  assert.throws(() => commitWrites(writes, fsx), /could NOT restore a; .*MIXED/)
  assert.equal(files.get('a.roster-refresh.bak'), 'A0')
})

// Mutation killed: excluding exact matches hides a basis that is exactly a stale id.
test('PROSE2 an exact stale id outside a reference field is reported', () => {
  const plan = { bumps: [{ from: 'openai/gpt-5.6-sol', to: 'openai/gpt-6-sol' }] }
  assert.deepEqual(proseMentions({ bands: [{ members: ['openai/gpt-6-sol'], membership_basis: 'openai/gpt-5.6-sol' }] }, plan.bumps).map((h) => h.path), ['.bands[0].membership_basis'])
})

// Mutation killed: starting again over a leftover backup overwrites the only original of a file
// whose restore already failed.
test('ROLLBACK3 a leftover recovery backup refuses the next apply and survives it', () => {
  const files = new Map([['a', 'A1'], ['a.roster-refresh.bak', 'A0'], ['b', 'B0']])
  const fsx = {
    constants: { W_OK: 2 }, accessSync: () => {},
    writeFileSync: (p, t) => files.set(p, t),
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from) },
    unlinkSync: (p) => files.delete(p), existsSync: (p) => files.has(p),
  }
  const writes = [{ path: 'a', original: 'A1', next: 'A2' }, { path: 'b', original: 'B0', next: 'B1' }]
  assert.throws(() => commitWrites(writes, fsx), /refused to start — a\.roster-refresh\.bak/)
  assert.deepEqual([files.get('a'), files.get('a.roster-refresh.bak'), files.get('b')], ['A1', 'A0', 'B0'])
})

// Mutation killed: dropping the bounds check writes a negative price or a fractional context that
// roster.schema.json forbids and loadRoster never checks.
test('BOUNDS1 a catalog value outside the schema bounds is refused, not written', () => {
  const catalog = (cost, context) => ({ openai: { models: { 'gpt-6-sol': { cost, limit: { context } } } } })
  assert.throws(() => catalogEntry('openai/gpt-6-sol', catalog({ input: -3, output: 10 }, 1000), { today: '2026-09-23' }), /input is outside/)
  assert.throws(() => catalogEntry('openai/gpt-6-sol', catalog({ input: 2, output: 10 }, 1.5), { today: '2026-09-23' }), /context is outside/)
  assert.throws(() => catalogEntry('openai/gpt-6-sol', catalog({ input: 2, output: 10, cache_write: -1 }, 1000), { today: '2026-09-23' }), /cache_write is outside/)
  assert.equal(catalogEntry('openai/gpt-6-sol', catalog({ input: 2, output: 10, cache_write: 0 }, 1000), { today: '2026-09-23' }).cost_cache_write_per_mtok, 0)
  // An ABSENT input or output price is refused too; the bounds check only sees values present.
  assert.throws(() => catalogEntry('openai/gpt-6-sol', catalog({ output: 10 }, 1000), { today: '2026-09-23' }), /publishes no input\/output price/)
  assert.throws(() => catalogEntry('openai/gpt-6-sol', catalog({ input: 2 }, 1000), { today: '2026-09-23' }), /publishes no input\/output price/)
})

// Mutation killed: copying models.dev's anthropic cacheWrite ships the 5-minute rate under the
// 1h definition every cost row prints.
test('HOUR1 an anthropic cache write is priced at the 1h rate, other vendors as published', () => {
  const catalog = {
    anthropic: { models: { 'claude-opus-5-5': { cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 }, limit: { context: 1000000 } } } },
    openai: { models: { 'gpt-6-sol': { cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5, tiers: [{ input: 4, tier: { type: 'context', size: 272000 } }] }, limit: { context: 1050000 } } } },
  }
  const opus = catalogEntry('anthropic/claude-opus-5-5', catalog, { today: '2026-09-23' })
  assert.equal(opus.cost_cache_write_per_mtok, 8)
  assert.match(opus.cache_rate_source, /5-minute rate.*1h-TTL rate, 2\.00x/)
  const sol = catalogEntry('openai/gpt-6-sol', catalog, { today: '2026-09-23' })
  assert.equal(sol.cost_cache_write_per_mtok, 2.5)
  assert.match(sol.cache_rate_source, /second price tier above 272000 tokens/)
})

// Mutation killed: planning a kept price row as a bump re-reports it, and re-applies it, on every run.
test('RETAIN1 an unseated predecessor whose successor is already held is a price row, not a bump', () => {
  const roster = { tiers: { build: { planner: { provider: 'openai', id: 'gpt-6-sol', agent: 'pi' } } }, models: {
    'openai/gpt-5.6-sol': { cost_in_per_mtok: 4, cost_out_per_mtok: 20, context: 1, tags: ['override-only'], source: 'models.dev', last_verified: '2026-01-01' },
    'openai/gpt-6-sol': { cost_in_per_mtok: 2, cost_out_per_mtok: 10, context: 1, tags: [], source: 'models.dev', last_verified: '2026-09-23' },
  } }
  const plan = planBump(roster, BUMP_CATALOG)
  assert.deepEqual(plan.bumps, [])
  assert.deepEqual(plan.skipped.find((s) => s.key === 'openai/gpt-5.6-sol'), { key: 'openai/gpt-5.6-sol', reason: 'retained-price-row' })
  // A newer successor arriving later moves only the seated model; the kept row stays a price row.
  const later = { ...BUMP_CATALOG, openai: { models: { ...BUMP_CATALOG.openai.models, 'gpt-7-sol': price(1, 5) } } }
  assert.deepEqual(planBump(roster, later).bumps, [{ from: 'openai/gpt-6-sol', to: 'openai/gpt-7-sol' }])
  // A SEATED model tagged override-only (the judge tech-lead's Fable) is still bumped.
  const seatedOverride = { tiers: { judge: { 'tech-lead': { provider: 'openai', id: 'gpt-5.6-sol', agent: 'pi' } } }, models: { 'openai/gpt-5.6-sol': roster.models['openai/gpt-5.6-sol'] } }
  assert.deepEqual(planBump(seatedOverride, BUMP_CATALOG).bumps, [{ from: 'openai/gpt-5.6-sol', to: 'openai/gpt-6-sol' }])
})

// Mutation killed: a backup write outside the staging try escapes raw and leaves .tmp and .bak
// files behind, which the next run then blames on a rollback that never happened.
test('BAK1 a failed backup write changes no file and leaves nothing behind', () => {
  const files = new Map([['a', 'A0'], ['b', 'B0']])
  const fsx = {
    constants: { W_OK: 2 }, accessSync: () => {},
    writeFileSync: (p, t) => { if (p === 'b.roster-refresh.bak') throw new Error('ENOSPC'); files.set(p, t) },
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from) },
    unlinkSync: (p) => files.delete(p), existsSync: (p) => files.has(p),
  }
  const writes = [{ path: 'a', original: 'A0', next: 'A1' }, { path: 'b', original: 'B0', next: 'B1' }]
  assert.throws(() => commitWrites(writes, fsx), /aborted before changing any file — ENOSPC/)
  assert.deepEqual([...files.entries()], [['a', 'A0'], ['b', 'B0']])
})

// Mutation killed: swallowing a failed backup removal reports a clean apply that blocks the next run.
test('BAK2 a backup that cannot be removed after a successful apply is reported', () => {
  const files = new Map([['a', 'A0']])
  const fsx = {
    constants: { W_OK: 2 }, accessSync: () => {},
    writeFileSync: (p, t) => files.set(p, t),
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from) },
    unlinkSync: (p) => { if (p.endsWith('.bak')) throw new Error('EPERM'); files.delete(p) },
    existsSync: (p) => files.has(p),
  }
  assert.throws(() => commitWrites([{ path: 'a', original: 'A0', next: 'A1' }], fsx), /succeeded, but could not remove a\.roster-refresh\.bak/)
  assert.equal(files.get('a'), 'A1')
})

// Mutation killed: the CLI's own fs object lacking a method commitWrites calls fails every real
// --apply while every injected-fs unit test stays green.
test('CLI1 --apply rewrites a scratch roster, ladder, routing policy and workflow end to end', () => {
  const dir = scratchDir('roster-refresh-cli1-')
  try {
    // Plant a predecessor of the shipped build planner everywhere it is named, so the apply has a
    // real bump to make whatever the shipped roster seats today.
    const read = (name) => JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'))
    const shipped = read('roster.json')
    const planner = shipped.tiers.build.planner
    const current = `${planner.provider}/${planner.id}`
    // The same family at version zero, whatever shape the planner's family has.
    const planted = `${planner.provider}/${planner.id.replace(/\d+/, '0')}`
    assert.equal(modelFamily(planted.slice(planted.indexOf('/') + 1)).family, modelFamily(planner.id).family)
    assert.equal(successorOf(planted, [planted, current]).successor, current)
    const back = { [current]: planted }
    const roster = replaceIds(shipped, back)
    roster.models = Object.fromEntries(Object.entries(shipped.models).map(([k, v]) => [k === current ? planted : k, v]))
    const files = {
      'roster.json': roster,
      'model-ladder.json': bumpLadder(read('model-ladder.json'), back),
      'routing-policy.json': replaceIds(read('routing-policy.json'), back),
      'workflows/full.json': replaceIds(read('workflows/full.json'), back),
    }
    for (const [name, doc] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true })
      const shippedText = readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')
      writeFileSync(join(dir, name), `${JSON.stringify(doc, null, 2)}${shippedText.endsWith('\n') ? '\n' : ''}`)
    }
    const catalog = {}
    const add = (key, e) => {
      const [provider, ...rest] = key.split('/')
      catalog[provider] ??= { models: {} }
      catalog[provider].models[rest.join('/')] = { cost: { input: e.cost_in_per_mtok, output: e.cost_out_per_mtok, cache_read: e.cost_cache_read_per_mtok, cache_write: e.cost_cache_write_per_mtok }, limit: { context: e.context } }
    }
    for (const [key, e] of Object.entries(shipped.models)) add(key, e)
    add(planted, shipped.models[current])
    const catalogPath = join(dir, 'catalog.json')
    writeFileSync(catalogPath, JSON.stringify(catalog))
    const plantedId = planted.slice(planted.indexOf('/') + 1)
    const result = spawnSync(process.execPath, [REFRESH_TOOL, '--roster', join(dir, 'roster.json'), '--catalog', catalogPath, '--apply'], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /applied 1 bump\(s\)/)
    const after = JSON.parse(readFileSync(join(dir, 'roster.json'), 'utf8'))
    assert.equal(Object.hasOwn(after.models, current), true)
    assert.equal(Object.hasOwn(after.models, planted), true)
    for (const name of Object.keys(files)) {
      assert.equal(readFileSync(join(dir, name), 'utf8').includes(`"${plantedId}"`) && name !== 'roster.json', false, `${name} still seats ${plantedId}`)
      // Every file keeps its own byte format.
      const shippedText = readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')
      assert.equal(readFileSync(join(dir, name), 'utf8').endsWith('\n'), shippedText.endsWith('\n'), name)
    }
    assert.equal(JSON.stringify(after.tiers).includes(`"${plantedId}"`), false)
    assert.deepEqual(readdirSync(dir).filter((n) => /\.roster-refresh\.(tmp|bak)$/.test(n)), [])
    // A catalog refusal is a printed message and an unchanged tree, never a stack trace.
    const bad = JSON.parse(readFileSync(catalogPath, 'utf8'))
    const [provider] = current.split('/')
    bad[provider].models[planner.id.replace(/\d+/, '99')] = { cost: { input: -1, output: 10 }, limit: { context: 1050000 } }
    writeFileSync(catalogPath, JSON.stringify(bad))
    const settled = readFileSync(join(dir, 'roster.json'), 'utf8')
    const refused = spawnSync(process.execPath, [REFRESH_TOOL, '--roster', join(dir, 'roster.json'), '--catalog', catalogPath, '--apply'], { encoding: 'utf8' })
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /^roster-refresh: refusing to write /)
    assert.doesNotMatch(refused.stderr, /\n\s+at /)
    assert.equal(readFileSync(join(dir, 'roster.json'), 'utf8'), settled)
    // So is a directory missing the files the apply rewrites.
    rmSync(join(dir, 'model-ladder.json'))
    const missing = spawnSync(process.execPath, [REFRESH_TOOL, '--roster', join(dir, 'roster.json'), '--catalog', catalogPath, '--apply'], { encoding: 'utf8' })
    assert.equal(missing.status, 1)
    assert.doesNotMatch(missing.stderr, /\n\s+at /)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// Mutation killed: dropping the status filter reseats a family onto a beta or deprecated model.
test('BETA1 an alpha, beta or deprecated catalog entry is never a successor', () => {
  const keys = ['openai/gpt-6-sol', 'openai/gpt-7-sol']
  assert.deepEqual(successorOf('openai/gpt-6-sol', keys, new Set(['openai/gpt-7-sol'])), { key: 'openai/gpt-6-sol', successor: null, reason: 'newer-only-unreleased' })
  for (const status of ['alpha', 'beta', 'deprecated']) {
    const catalog = { openai: { models: { 'gpt-6-sol': price(2, 10), 'gpt-7-sol': { ...price(1, 5), status } } } }
    assert.deepEqual(planBump({ tiers: { build: { planner: { provider: 'openai', id: 'gpt-6-sol', agent: 'pi' } } }, models: {} }, catalog).bumps, [], status)
  }
})

// Mutation killed: a rate check that ignores the vendor multipliers lets a 0.05x read through unsaid.
test('DEPART1 a published cache rate off its vendor multiplier is reported, not normalised', () => {
  assert.deepEqual(rateDepartures('anthropic/claude-opus-5-5', { cost_in_per_mtok: 4, cost_cache_read_per_mtok: 0.2, cost_cache_write_per_mtok: 8 }), ['anthropic/claude-opus-5-5: cache read 0.2 per Mtok, not the ratified 0.10x (0.4)'])
  assert.deepEqual(rateDepartures('anthropic/claude-sonnet-5', { cost_in_per_mtok: 2, cost_cache_read_per_mtok: 0.2, cost_cache_write_per_mtok: 4 }), [])
  // openai has no ratified write multiplier (gpt-6-sol and gpt-6-luna were ratified as published);
  // its read convention still holds.
  assert.deepEqual(rateDepartures('openai/gpt-6-sol', { cost_in_per_mtok: 2, cost_cache_read_per_mtok: 0.2, cost_cache_write_per_mtok: 2.5 }), [])
  assert.equal(rateDepartures('openai/gpt-6-sol', { cost_in_per_mtok: 2, cost_cache_read_per_mtok: 0.1, cost_cache_write_per_mtok: 2.5 }).length, 1)
  assert.deepEqual(rateDepartures('meta/muse-spark-1.4', { cost_in_per_mtok: 1, cost_cache_read_per_mtok: 0.002 }), [])
})

// Mutation killed: without the check a fallback bumped onto its own primary seats one model twice.
test('FALLBACK1 a bump that lands a fallback on its primary is refused', () => {
  const roster = { tiers: { judge: { 'tech-lead': { provider: 'anthropic', id: 'claude-opus-5-5', agent: 'claude', fallback: [{ provider: 'anthropic', id: 'claude-opus-5', agent: 'claude' }] } } }, models: {} }
  assert.throws(() => applyBump({ roster }, { bumps: [{ from: 'anthropic/claude-opus-5', to: 'anthropic/claude-opus-5-5' }] }, BUMP_CATALOG, { today: '2026-09-23' }), /would name anthropic\/claude-opus-5-5 twice/)
  // Two fallbacks collapsing onto one model are refused the same way.
  const pair = { tiers: { judge: { 'tech-lead': { provider: 'openai', id: 'gpt-6-sol', agent: 'pi', fallback: [{ provider: 'anthropic', id: 'claude-opus-5', agent: 'claude' }, { provider: 'anthropic', id: 'claude-opus-5-5', agent: 'claude' }] } } }, models: {} }
  assert.throws(() => applyBump({ roster: pair }, { bumps: [{ from: 'anthropic/claude-opus-5', to: 'anthropic/claude-opus-5-5' }] }, BUMP_CATALOG, { today: '2026-09-23' }), /twice/)
})

// Mutation killed: without the refusal an empty --roster falls back to the shipped roster, and
// under --apply rewrites this checkout's own configuration. The empty catalog keeps the mutant
// from writing anything: it exits 0 instead of refusing.
test('CLI2 an empty --roster is refused, never the shipped roster', () => {
  const dir = scratchDir('roster-refresh-cli2-')
  try {
    const catalogPath = join(dir, 'catalog.json')
    writeFileSync(catalogPath, '{}')
    for (const args of [['--roster', ''], ['--roster'], [`--roster=${join(dir, 'roster.json')}`], ['--rooster', join(dir, 'roster.json')]]) {
      const result = spawnSync(process.execPath, [REFRESH_TOOL, '--catalog', catalogPath, '--apply', ...args], { encoding: 'utf8' })
      assert.equal(result.status, 1, JSON.stringify(args))
      assert.match(result.stderr, /given no path|unknown argument/)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// Mutation killed: re-dating a document the bump names nothing in rewrites the whole file and
// moves its hash for no change.
test('ROUTE1 a document the bump does not touch is returned exactly as it was', () => {
  const routing = { updated_at: '2026-09-12', routes: { build: { builder: { candidates: [{ provider: 'meta', id: 'muse-spark-1.3-contributor', agent: 'pi' }] } } } }
  const next = applyBump({ roster: { tiers: {}, models: {} }, routing }, { bumps: [{ from: 'openai/gpt-5.6-sol', to: 'openai/gpt-6-sol' }] }, BUMP_CATALOG, { today: '2026-09-23' })
  assert.deepEqual(next.routing, routing)
})

// Mutation killed: an unguarded readdir turns one unreadable bench directory into a failed exit
// after the apply already succeeded.
test('BENCH1 an unreadable bench directory is named, never fatal', () => {
  const root = '/r/docs/audits'
  const fsx = {
    existsSync: () => true,
    readdirSync: (p) => { if (p === root) return ['2026-09-21', '2026-09-22']; if (p.includes('2026-09-22')) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return ['reviewer'] },
    readFileSync: () => JSON.stringify({ production: 'anthropic/claude-opus-5' }),
  }
  const out = replacedBenches(root, new Set(['anthropic/claude-opus-5']), fsx)
  assert.deepEqual(out.benches, ['/r/docs/audits/2026-09-21/bench/reviewer/candidates.json'])
  assert.deepEqual(out.unscanned, ['/r/docs/audits/2026-09-22/bench (EACCES)'])
  // A malformed candidates.json and an absent root are named too: the scan measured nothing there.
  const malformed = replacedBenches(root, new Set(), { ...fsx, readdirSync: (p) => (p === root ? ['2026-09-21'] : ['reviewer']), readFileSync: () => '{ not json' })
  assert.deepEqual(malformed.unscanned, ['/r/docs/audits/2026-09-21/bench/reviewer/candidates.json (not JSON)'])
  assert.deepEqual(replacedBenches(root, new Set(), { ...fsx, existsSync: () => false }).unscanned, ['/r/docs/audits (absent)'])
})

// Mutation killed: a grammar that ignores what it does not know reads `--roster=<path>` as no
// --roster at all, and --apply then rewrites the shipped roster.
test('ARGS1 the argument grammar is closed', () => {
  assert.deepEqual(parseArgs(['--roster', 'r.json', '--catalog', 'c.json', '--apply']), { help: false, apply: true, roster: 'r.json', catalog: 'c.json', out: null })
  for (const argv of [['--roster=r.json'], ['--rooster', 'r.json'], ['--catalog', ''], ['--catalog'], ['--roster', '--apply'], ['r.json']]) {
    assert.throws(() => parseArgs(argv), /given no path|unknown argument/, JSON.stringify(argv))
  }
})

// Mutation killed: writing a document the bump does not change re-serialises it — a hand-compacted
// routing policy grew from 114 to 344 lines for an apply that named nothing in it.
test('CLI3 a file the bump does not change keeps its exact bytes', () => {
  const dir = scratchDir('roster-refresh-cli3-')
  try {
    const read = (name) => JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'))
    const shipped = read('roster.json')
    const planner = shipped.tiers.build.planner
    const current = `${planner.provider}/${planner.id}`
    const plantedId = planner.id.replace(/\d+/, '0')
    const planted = `${planner.provider}/${plantedId}`
    // Only the build planner's seat and its catalog row name the predecessor: the ladder, the
    // routing policy and the workflow already name the successor, so none of them change.
    const roster = JSON.parse(JSON.stringify(shipped))
    roster.tiers.build.planner.id = plantedId
    roster.models[planted] = shipped.models[current]
    writeFileSync(join(dir, 'roster.json'), JSON.stringify(roster, null, 2))
    const compact = {}
    for (const name of ['model-ladder.json', 'routing-policy.json', 'workflows/full.json']) {
      mkdirSync(dirname(join(dir, name)), { recursive: true })
      compact[name] = JSON.stringify(read(name))
      writeFileSync(join(dir, name), compact[name])
    }
    const catalog = {}
    for (const [key, e] of Object.entries(roster.models)) {
      const [provider, ...rest] = key.split('/')
      catalog[provider] ??= { models: {} }
      catalog[provider].models[rest.join('/')] = { cost: { input: e.cost_in_per_mtok, output: e.cost_out_per_mtok, cache_read: e.cost_cache_read_per_mtok, cache_write: e.cost_cache_write_per_mtok }, limit: { context: e.context } }
    }
    writeFileSync(join(dir, 'catalog.json'), JSON.stringify(catalog))
    const result = spawnSync(process.execPath, [REFRESH_TOOL, '--roster', join(dir, 'roster.json'), '--catalog', join(dir, 'catalog.json'), '--apply'], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /applied 1 bump\(s\)/)
    assert.equal(JSON.parse(readFileSync(join(dir, 'roster.json'), 'utf8')).tiers.build.planner.id, planner.id)
    for (const [name, bytes] of Object.entries(compact)) assert.equal(readFileSync(join(dir, name), 'utf8'), bytes, name)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
