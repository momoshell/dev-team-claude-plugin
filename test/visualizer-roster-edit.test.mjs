import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { scratchDir } from '../test/helpers.mjs'
import { DEFAULT_TRANSPORT, HEADLESS_TRANSPORTS, ROLE_ORDER, assertCapabilities } from '../crew/crew.mjs'
import { capabilityRefusals, loadSeatSchema, proposeEdit } from '../visualizer/server/roster-edit.mjs'
import { applyMoves, composeMoves, ladderView, readLadder, readReference, stageMoves } from '../visualizer/server/roster-ladder.mjs'

const rosterPath = join(process.cwd(), 'crew', 'roster.json')
const schemaPath = join(process.cwd(), 'crew', 'roster.schema.json')
const rosterText = readFileSync(rosterPath, 'utf8')
const roster = JSON.parse(rosterText)
const changedBuildReviewerEffort = roster.tiers.build.reviewer.effort === 'high' ? 'max' : 'high'
const v2Roster = (policy = {}) => ({
  schema_version: 2,
  updated_at: roster.updated_at,
  assurances: {
    quick: structuredClone(roster.tiers.mechanical),
    standard: structuredClone(roster.tiers.build),
    rigorous: structuredClone(roster.tiers.judge),
  },
  models: structuredClone(roster.models),
  policy: structuredClone(policy),
})
const ladderPath = join(process.cwd(), 'crew', 'model-ladder.json')
const ratifiedLadder = readLadder({ ladderPath })

function ladderRosterView() {
  return {
    path: rosterPath,
    degraded: false,
    error: null,
    updated_at: roster.updated_at,
    schema_version: roster.schema_version,
    tiers: Object.entries(roster.tiers).map(([tier, tierRoster]) => ({
      tier,
      seats: Object.entries(tierRoster).filter(([, cell]) => cell !== null).map(([role, cell]) => ({ role, ...cell, model_key: `${cell.provider}/${cell.id}` })),
      unseated: Object.entries(tierRoster).filter(([, cell]) => cell === null).map(([role]) => role),
    })),
    models: Object.entries(roster.models).map(([key, model]) => ({ key, ...model })),
  }
}

async function edit(input = {}) {
  return await proposeEdit({
    rosterText,
    rosterPath: 'crew/roster.json',
    tier: 'build',
    role: 'reviewer',
    cell: { ...roster.tiers.build.reviewer, effort: changedBuildReviewerEffort },
    ...input,
  })
}

function assertRefused(result, code) {
  assert.equal(result.ok, false)
  assert.equal(result.diff, null)
  assert.ok(result.refusals.some((refusal) => refusal.code === code), `${code} refusal missing`)
  return result.refusals.find((refusal) => refusal.code === code).message
}

test('the runtime roster is byte-exactly canonical JSON', () => {
  assert.equal(rosterText, JSON.stringify(roster, null, 2))
  assert.equal(rosterText.endsWith('\n'), false)
})

test('a legal edit produces an applyable v2 result', async () => {
  const result = await edit()
  assert.equal(result.ok, true)
  assert.match(result.diff, /^--- a\/crew\/roster\.json$/m)
  assert.match(result.diff, /^\+\+\+ b\/crew\/roster\.json$/m)
  const patchBody = result.diff.split('\n').slice(2).join('\n')
  assert.doesNotMatch(patchBody, /cost_in_per_mtok|cost_out_per_mtok/)
  assert.doesNotMatch(patchBody, /^[+-]\s*"models":/m)
  assert.ok(result.diff.split('\n').length < 120)
  const dir = mkdtempSync(join(tmpdir(), 'roster-edit-'))
  try {
    const crew = join(dir, 'crew')
    const patchPath = join(dir, 'edit.patch')
    mkdirSync(crew, { recursive: true })
    copyFileSync(rosterPath, join(crew, 'roster.json'))
    writeFileSync(patchPath, result.diff)
    execFileSync('patch', ['-p1', '-i', patchPath], { cwd: dir, stdio: 'pipe' })
    const after = JSON.parse(readFileSync(join(crew, 'roster.json'), 'utf8'))
    assert.equal(after.schema_version, 2)
    assert.equal(Object.hasOwn(after, 'tiers'), false)
    assert.equal(after.assurances.standard.reviewer.effort, changedBuildReviewerEffort)
    assert.deepEqual(after.models, roster.models)
    assert.deepEqual(after.policy, {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('identity v2 edits are empty while v1 identity edits migrate to v2', async () => {
  const source = v2Roster()
  const sourceText = JSON.stringify(source, null, 2)
  const v2Result = await edit({ rosterText: sourceText, cell: source.assurances.standard.reviewer })
  assert.equal(v2Result.ok, true)
  assert.equal(v2Result.diff, '')
  assert.deepEqual(v2Result.before, v2Result.after)

  const v1Result = await edit({ cell: roster.tiers.build.reviewer })
  assert.equal(v1Result.ok, true)
  assert.notEqual(v1Result.diff, '')
  const dir = scratchDir('roster-edit-identity-')
  try {
    mkdirSync(join(dir, 'crew'), { recursive: true })
    copyFileSync(rosterPath, join(dir, 'crew', 'roster.json'))
    const patchPath = join(dir, 'edit.patch')
    writeFileSync(patchPath, v1Result.diff)
    execFileSync('patch', ['-p1', '-i', patchPath], { cwd: dir, stdio: 'pipe' })
    const after = JSON.parse(readFileSync(join(dir, 'crew', 'roster.json'), 'utf8'))
    assert.equal(after.schema_version, 2)
    assert.deepEqual(after.assurances.standard, roster.tiers.build)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('unknown tier is refused using resolveTier wording', async () => {
  const message = assertRefused(await edit({ tier: 'nope' }), 'unknown_tier')
  assert.match(message, /unknown tier "nope"/)
  assert.match(message, /mechanical, build, judge/)
  assert.match(message, /crew\/crew\.mjs resolveTier/)
})

test('unknown role is refused before a proposal is composed', async () => {
  const message = assertRefused(await edit({ role: 'operator' }), 'unknown_role')
  assert.match(message, /crew\/crew\.mjs:438 unknown crew role/)
})

test('unseating a required role is refused', async () => {
  const message = assertRefused(await edit({ role: 'planner', cell: null }), 'unseat_refused')
  assert.match(message, /resolveTier.*would not seat.*planner\/builder\/reviewer/)
})

test('mechanical lead cannot be seated', async () => {
  const message = assertRefused(await edit({ tier: 'mechanical', role: 'lead' }), 'mechanical_lead')
  assert.match(message, /mechanical\.lead.*null/)
  assert.match(message, /roster-refresh\.test\.mjs:125-128/)
})

test('cell shape violations name their field', async () => {
  const badEnum = await edit({ cell: { ...roster.tiers.build.reviewer, effort: 'bogus' } })
  assert.match(assertRefused(badEnum, 'cell_shape'), /effort/)
  const extra = await edit({ cell: { ...roster.tiers.build.reviewer, extra: true } })
  assert.match(assertRefused(extra, 'cell_shape'), /additional properties/)
  const missing = { ...roster.tiers.build.reviewer }
  delete missing.agent
  assert.match(assertRefused(await edit({ cell: missing }), 'cell_shape'), /agent.*missing/)
})

test('an unknown model is refused without exposing its catalog record', async () => {
  const message = assertRefused(await edit({ cell: { provider: 'openai', id: 'gpt-9.9-nope', agent: 'pi', effort: 'high' } }), 'unknown_model')
  assert.match(message, /openai\/gpt-9\.9-nope/)
  assert.doesNotMatch(JSON.stringify(await edit({ cell: { provider: 'openai', id: 'gpt-9.9-nope', agent: 'pi', effort: 'high' } })), /cost_in_per_mtok|cost_out_per_mtok|usd|spend/i)
})

test('cross-vendor pairing is checked when the reviewer changes', async () => {
  const message = assertRefused(await edit({ cell: { provider: 'anthropic', id: 'claude-opus-5', agent: 'claude', effort: 'high' } }), 'cross_vendor')
  assert.match(message, /cross-vendor/)
  assert.match(message, /build/)
  assert.match(message, /planner/)
  assert.match(message, /anthropic/)
})

test('cross-vendor pairing is checked when the planner changes', async () => {
  const message = assertRefused(await edit({ role: 'planner', cell: { provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'max' } }), 'cross_vendor')
  assert.match(message, /cross-vendor/)
  assert.match(message, /planner/)
})

test('judge keeps tech-lead and planner on different vendors', async () => {
  const message = assertRefused(await edit({ tier: 'judge', role: 'planner', cell: { provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'max' } }), 'judge_vendor_split')
  assert.match(message, /tech-lead.*planner/)
  assert.match(message, /roster-refresh\.test\.mjs:130-132/)
})

test('an unreadable roster refuses before parsing or diffing', async () => {
  const result = await proposeEdit({ rosterText: null, rosterPath: '/tmp/missing-roster.json', readError: 'unable to read roster: ENOENT, at /tmp/missing-roster.json', tier: 'build', role: 'reviewer', cell: roster.tiers.build.reviewer })
  const message = assertRefused(result, 'roster_unreadable')
  assert.match(message, /\/tmp\/missing-roster\.json/)
})

test('seat enums are loaded from the supplied schema', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roster-schema-'))
  try {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
    schema.$defs.seat.properties.effort.enum = schema.$defs.seat.properties.effort.enum.filter((value) => value !== 'xhigh')
    const modified = join(dir, 'roster.schema.json')
    writeFileSync(modified, JSON.stringify(schema, null, 2))
    const message = assertRefused(await edit({ seatSchema: loadSeatSchema(modified), cell: { ...roster.tiers.build.reviewer, effort: 'xhigh' } }), 'cell_shape')
    assert.match(message, /xhigh/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('propose-time and boot-time refusals agree for every seat, adapter and transport', async () => {
  const adaptersDir = join(process.cwd(), 'crew', 'adapters')
  const agents = readdirSync(adaptersDir)
    .map((name) => /^adapter-(.+)\.mjs$/.exec(name)?.[1])
    .filter(Boolean)
  const transports = [DEFAULT_TRANSPORT, ...HEADLESS_TRANSPORTS]
  for (const role of ROLE_ORDER) {
    for (const agent of agents) {
      const adapter = await import(pathToFileURL(join(adaptersDir, `adapter-${agent}.mjs`)).href)
      const expected = new Map()
      for (const transport of transports) {
        let capabilities
        try {
          capabilities = adapter.capabilitiesFor({ transport })
        } catch {
          continue
        }
        try {
          assertCapabilities(role, agent, capabilities)
        } catch (err) {
          const existing = expected.get(err.message)
          if (existing) existing.push(transport)
          else expected.set(err.message, [transport])
        }
      }
      const actual = await capabilityRefusals({ tier: 'build', role, cell: { agent } })
      assert.deepEqual(actual, [...expected].map(([message, listed]) => ({ code: 'capability_refused', message, transports: listed })), `${role}/${agent}`)
    }
  }
})

test('a pi planner is refused before a diff is composed', async () => {
  const result = await edit({ role: 'planner', cell: { provider: 'anthropic', id: 'claude-opus-5', agent: 'pi', effort: 'high' } })
  assert.equal(result.ok, false)
  assert.equal(result.diff, null)
  assert.equal(result.after, null)
  const refusal = result.refusals.find(({ code }) => code === 'capability_refused')
  assert.ok(refusal)
  assert.match(refusal.message, /requires capability "subagents"/)
})

test('a seat the adapter can hold still proposes exactly as before', async () => {
  const result = await edit({ role: 'builder', cell: { provider: 'anthropic', id: 'claude-opus-5', agent: 'pi', effort: 'high' } })
  assert.equal(result.ok, true)
  assert.equal(result.after.agent, 'pi')
  assert.equal(typeof result.diff, 'string')
  assert.ok(result.diff.length > 0)
})

test('an agent with no adapter is unknown, and unknown refuses', async () => {
  const direct = await capabilityRefusals({ tier: 'build', role: 'planner', cell: { agent: 'nosuch-agent' } })
  assert.ok(direct.some(({ code }) => code === 'capability_unknown'))
  assert.match(direct.find(({ code }) => code === 'capability_unknown').message, /nosuch-agent/)

  const seatSchema = loadSeatSchema()
  seatSchema.properties.agent.enum.push('nosuch-agent')
  const result = await edit({ role: 'planner', seatSchema, cell: { provider: 'anthropic', id: 'claude-opus-5', agent: 'nosuch-agent', effort: 'high' } })
  assert.equal(result.ok, false)
  assert.equal(result.diff, null)
  assert.ok(result.refusals.some(({ code }) => code === 'capability_unknown'))
})

test('an adapter that answers for no transport is unknown, never fine', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roster-adapter-'))
  try {
    writeFileSync(join(dir, 'adapter-stub.mjs'), 'export function capabilitiesFor() { throw new Error(\'no profile\') }\n')
    const refusals = await capabilityRefusals({ tier: 'build', role: 'builder', cell: { agent: 'stub' }, adaptersDir: dir })
    assert.ok(refusals.some(({ code }) => code === 'capability_unknown'))
    assert.equal(refusals.some(({ code }) => code === 'capability_refused'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unseating runs no capability check', async () => {
  assert.deepEqual(await capabilityRefusals({ tier: 'judge', role: 'tech-lead', cell: null }), [])
})

test('an invalid agent name is refused without touching the filesystem', async () => {
  const refusals = await capabilityRefusals({ tier: 'build', role: 'builder', cell: { agent: '../evil' }, adaptersDir: null })
  assert.equal(refusals.length, 1)
  assert.equal(refusals[0].code, 'capability_unknown')
  assert.match(refusals[0].message, /\.\.\/evil/)
})

test('readLadder and readReference degrade without inventing data', () => {
  assert.equal(ratifiedLadder.degraded, false)
  assert.deepEqual(ratifiedLadder.bands.map((band) => band.rank), [...ratifiedLadder.bands].map((band) => band.rank).sort((a, b) => b - a))
  const dir = mkdtempSync(join(tmpdir(), 'roster-ladder-read-'))
  try {
    const missing = readLadder({ ladderPath: join(dir, 'missing.json') })
    assert.equal(missing.degraded, true); assert.equal(missing.bands, null); assert.match(missing.error, /missing\.json/)
    const invalidPath = join(dir, 'invalid.json'); writeFileSync(invalidPath, '{ nope')
    const invalid = readLadder({ ladderPath: invalidPath })
    assert.equal(invalid.degraded, true); assert.equal(invalid.bands, null); assert.match(invalid.error, /invalid\.json/)
    const referenceMissing = readReference({ referencePath: join(dir, 'reference.json') })
    assert.equal(referenceMissing.present, false); assert.equal(referenceMissing.scores, null)
    const referencePath = join(dir, 'reference-valid.json')
    writeFileSync(referencePath, JSON.stringify({ fetched_at: '2026-08-17', source: 'test', models: { 'openai/gpt-5.6-terra': { score: 95 }, 'anthropic/claude-opus-5': { score: 'unknown' } } }))
    const reference = readReference({ referencePath })
    assert.equal(reference.present, true); assert.equal(reference.scores['openai/gpt-5.6-terra'], 95)
    const view = ladderView({ roster: ladderRosterView(), ladder: ratifiedLadder, reference, cells: { rows: [], absent: null } })
    const scored = view.chips.find((chip) => chip.key === 'openai/gpt-5.6-terra')
    const nonNumeric = view.chips.find((chip) => chip.key === 'anthropic/claude-opus-5')
    assert.equal(scored.reference, 95); assert.ok(nonNumeric.reference_pending); assert.equal(nonNumeric.reference, null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('ladderView keeps ratified drift, measured records and tier rail separate', () => {
  const reference = { path: '/tmp/reference.json', present: true, fetched_at: '2026-08-17', source: 'test', scores: { 'openai/gpt-5.6-terra': 95 } }
  const cells = { rows: [{ provider: 'openai', model_id: 'gpt-5.6-terra', agent: 'pi', effort: 'max', kind: 'timeout', failures: 3, run_less: 1, first_at: 'a', last_at: 'b' }], absent: null }
  const view = ladderView({ roster: ladderRosterView(), ladder: ratifiedLadder, reference, cells })
  const terra = view.chips.find((chip) => chip.key === 'openai/gpt-5.6-terra')
  assert.equal(terra.band, 'workhorse'); assert.equal(terra.proposed_band, 'frontier'); assert.match(terra.drift.why, /workhorse/); assert.match(terra.drift.why, /frontier/)
  assert.deepEqual({ failures: terra.measured.failures, run_less: terra.measured.run_less, in_run: terra.measured.in_run, cells: terra.measured.cells }, { failures: 3, run_less: 1, in_run: 2, cells: 1 })
  assert.deepEqual(view.rail.map((rail) => rail.tier), Object.keys(roster.tiers))
  const absent = ladderView({ roster: ladderRosterView(), ladder: ratifiedLadder, reference: { path: '/tmp/reference', present: false, scores: null }, cells: { rows: null, absent: 'cell_failures predates this ledger mirror' } }).chips.find((chip) => chip.key === terra.key)
  assert.equal(absent.measured, null); assert.ok(absent.measured_pending)
  const broken = ladderView({ roster: ladderRosterView(), ladder: readLadder({ ladderPath: '/tmp/missing-model-ladder.json' }), reference, cells })
  assert.equal(broken.bands, null); assert.equal(broken.chips, null); assert.equal(broken.rail, null)
})

async function stageLadder(moves, extra = {}) {
  return await stageMoves({ rosterText, rosterPath: 'crew/roster.json', readError: null, moves, ladder: ratifiedLadder, readBreaker: () => null, ...extra })
}

test('stageMoves validates all four checks and produces an applyable multi-move diff', async () => {
  const moves = [
    { tier: 'build', role: 'reviewer', cell: { ...roster.tiers.build.reviewer, effort: 'high' } },
    { tier: 'mechanical', role: 'reviewer', cell: { ...roster.tiers.mechanical.reviewer, effort: 'high' } },
  ]
  const result = await stageLadder(moves)
  assert.equal(result.ok, true); assert.deepEqual(result.checks.map((entry) => entry.check), ['band_floor', 'vendor_diversity', 'breaker_state', 'cost_ceiling']); assert.ok(result.checks.every((entry) => entry.ok && entry.message))
  const dir = mkdtempSync(join(tmpdir(), 'roster-ladder-patch-'))
  try {
    mkdirSync(join(dir, 'crew')); copyFileSync(rosterPath, join(dir, 'crew', 'roster.json')); const patchPath = join(dir, 'roster.patch'); writeFileSync(patchPath, result.diff)
    execFileSync('patch', ['-p1', '-i', patchPath], { cwd: dir, stdio: 'pipe' })
    const after = JSON.parse(readFileSync(join(dir, 'crew', 'roster.json'), 'utf8'))
    assert.equal(after.schema_version, 2)
    assert.equal(after.assurances.standard.reviewer.effort, 'high'); assert.equal(after.assurances.quick.reviewer.effort, 'high')
    assert.deepEqual(after.models, roster.models)
    assert.deepEqual(after.policy, {})
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('stageMoves names floor, cost and vendor refusals and keeps the diff null', async () => {
  const floor = await stageLadder([{ tier: 'build', role: 'builder', cell: { provider: 'anthropic', id: 'claude-haiku-4-5', agent: 'claude', effort: 'medium' } }])
  assert.equal(floor.ok, false); assert.equal(floor.diff, null); assert.equal(floor.checks.find((entry) => entry.check === 'band_floor').ok, false); assert.match(floor.checks.find((entry) => entry.check === 'band_floor').message, /utility.*build.*builder.*claude-haiku-4-5/)
  const cost = await stageLadder([{ tier: 'build', role: 'reviewer', cell: { provider: 'anthropic', id: 'claude-fable-5', agent: 'claude', effort: 'high' } }])
  assert.equal(cost.checks.find((entry) => entry.check === 'cost_ceiling').ok, false); assert.match(cost.checks.find((entry) => entry.check === 'cost_ceiling').message, /25.*build.*reviewer.*claude-fable-5/)
  const vendor = await stageLadder([{ tier: 'build', role: 'reviewer', cell: { provider: 'anthropic', id: 'claude-opus-5', agent: 'claude', effort: 'high' } }])
  assert.equal(vendor.checks.find((entry) => entry.check === 'vendor_diversity').ok, false); assert.match(vendor.checks.find((entry) => entry.check === 'vendor_diversity').message, /cross-vendor/)
  assert.equal(vendor.local_apply_allowed, true)
  assert.match(vendor.local_diff, /^--- a\/crew\/roster\.json/m)
})

test('stageMoves breaker and shape refusals still return every named check', async () => {
  const move = { tier: 'build', role: 'reviewer', cell: { ...roster.tiers.build.reviewer, effort: 'high' } }
  const open = await stageLadder([move], { readBreaker: () => ({ verdict: 'open', cells: [{ provider: 'openai', model_id: 'gpt-5.6-terra', agent: 'pi', effort: 'high', verdict: 'open' }] }) })
  assert.equal(open.checks.find((entry) => entry.check === 'breaker_state').ok, false); assert.match(open.checks.find((entry) => entry.check === 'breaker_state').message, /open.*gpt-5.6-terra/)
  const cell = { ...move.cell }; delete cell.effort
  const shape = await stageLadder([{ ...move, cell }])
  assert.ok(shape.refusals.some((refusal) => refusal.code === 'cell_shape')); assert.deepEqual(shape.checks.map((entry) => entry.check), ['band_floor', 'vendor_diversity', 'breaker_state', 'cost_ceiling'])
  assert.equal(shape.local_apply_allowed, false)
  assert.equal(shape.local_diff, null)
  const degraded = await stageMoves({ rosterText, rosterPath: 'crew/roster.json', moves: [move], ladder: readLadder({ ladderPath: '/tmp/missing-model-ladder.json' }), readBreaker: () => null })
  assert.equal(degraded.checks.find((entry) => entry.check === 'band_floor').ok, false); assert.equal(degraded.checks.find((entry) => entry.check === 'cost_ceiling').ok, false)
})

test('stageMoves can compose an optional cell:null move without model checks', async () => {
  const move = { tier: 'judge', role: 'lead', cell: null }
  const result = await stageLadder([move])
  assert.equal(result.ok, true)
  assert.equal(result.checks.find((entry) => entry.check === 'band_floor').ok, true)
  assert.equal(result.checks.find((entry) => entry.check === 'cost_ceiling').ok, true)
  assert.match(result.diff, /judge/)
  const degraded = await stageMoves({ rosterText, rosterPath: 'crew/roster.json', moves: [move], ladder: readLadder({ ladderPath: '/tmp/missing-model-ladder-null.json' }), readBreaker: () => null })
  assert.equal(degraded.ok, false)
  assert.equal(degraded.diff, null)
  assert.equal(degraded.checks.find((entry) => entry.check === 'band_floor').ok, false)
  assert.equal(degraded.checks.find((entry) => entry.check === 'cost_ceiling').ok, false)
})

test('composeMoves returns a deterministic PR-ready bundle and never writes the roster', async () => {
  const before = readFileSync(rosterPath, 'utf8')
  const moves = [{ tier: 'build', role: 'reviewer', cell: { ...roster.tiers.build.reviewer, effort: changedBuildReviewerEffort } }]
  const result = await composeMoves({ rosterText, rosterPath: 'crew/roster.json', moves, ladder: ratifiedLadder, branchSeed: 'unit-test', readBreaker: () => null })
  assert.equal(result.ok, true); assert.equal(result.branch, 'roster/ladder-unit-test'); assert.match(result.commit_subject, /^chore\(roster\): reseat/); assert.match(result.patch, /^--- a\/crew\/roster\.json/); assert.equal(readFileSync(rosterPath, 'utf8'), before)
})

test('proposeEdit and composeMoves emit v2 from a v2 source and preserve policy and unedited cells', async () => {
  const policy = { visualizer_probe: 'ratified-policy' }
  const source = v2Roster(policy)
  const sourceText = JSON.stringify(source, null, 2)
  const move = { tier: 'build', role: 'reviewer', cell: { ...source.assurances.standard.reviewer, effort: changedBuildReviewerEffort } }
  const proposal = await proposeEdit({ rosterText: sourceText, rosterPath: 'crew/roster.json', ...move })
  assert.equal(proposal.ok, true)
  const applyPatch = (diff, prefix) => {
    const dir = scratchDir(prefix)
    try {
      mkdirSync(join(dir, 'crew'), { recursive: true })
      writeFileSync(join(dir, 'crew', 'roster.json'), sourceText)
      const patchPath = join(dir, 'edit.patch')
      writeFileSync(patchPath, diff)
      execFileSync('patch', ['-p1', '-i', patchPath], { cwd: dir, stdio: 'pipe' })
      return JSON.parse(readFileSync(join(dir, 'crew', 'roster.json'), 'utf8'))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
  const proposalAfter = applyPatch(proposal.diff, 'roster-v2-proposal-')
  assert.equal(proposalAfter.schema_version, 2)
  assert.equal(Object.hasOwn(proposalAfter, 'tiers'), false)
  assert.deepEqual(proposalAfter.policy, policy)
  assert.deepEqual(proposalAfter.models, source.models)
  assert.deepEqual(proposalAfter.assurances.quick, source.assurances.quick)
  assert.deepEqual(proposalAfter.assurances.rigorous, source.assurances.rigorous)
  assert.equal(proposalAfter.assurances.standard.reviewer.effort, changedBuildReviewerEffort)

  const composed = await composeMoves({
    rosterText: sourceText,
    rosterPath: 'crew/roster.json',
    moves: [move, { tier: 'mechanical', role: 'reviewer', cell: { ...source.assurances.quick.reviewer, effort: changedBuildReviewerEffort } }],
    ladder: ratifiedLadder,
    branchSeed: 'v2-unit-test',
    readBreaker: () => null,
  })
  assert.equal(composed.ok, true)
  const composedAfter = applyPatch(composed.patch, 'roster-v2-compose-')
  assert.equal(composedAfter.schema_version, 2)
  assert.deepEqual(composedAfter.policy, policy)
  assert.deepEqual(composedAfter.models, source.models)
  assert.equal(composedAfter.assurances.standard.reviewer.effort, changedBuildReviewerEffort)
  assert.equal(composedAfter.assurances.quick.reviewer.effort, changedBuildReviewerEffort)
  assert.deepEqual(composedAfter.assurances.rigorous, source.assurances.rigorous)
})

test('applyMoves preserves the source schema while repository and local previews stay distinct', async () => {
  const policy = { local_apply_probe: 'ratified-policy' }
  const sourceV2 = v2Roster(policy)
  const moveV1 = { tier: 'build', role: 'reviewer', cell: { ...roster.tiers.build.reviewer, effort: changedBuildReviewerEffort } }
  const moveV2 = { tier: 'build', role: 'reviewer', cell: { ...sourceV2.assurances.standard.reviewer, effort: changedBuildReviewerEffort } }
  const write = async (sourceText, move) => {
    let written = null
    const result = await applyMoves({
      rosterText: sourceText,
      rosterPath: 'crew/roster.json',
      moves: [move],
      ladder: ratifiedLadder,
      readBreaker: () => null,
      writeRoster: ({ afterText }) => { written = afterText; return { ok: true, changed: true, conflict: false, error: null } },
    })
    return { result, written }
  }
  const v1 = await write(rosterText, moveV1)
  assert.equal(v1.result.applied, true)
  const afterV1 = JSON.parse(v1.written)
  assert.equal(afterV1.schema_version, 1)
  assert.ok(afterV1.tiers)
  assert.equal(Object.hasOwn(afterV1, 'assurances'), false)
  assert.equal(Object.hasOwn(afterV1, 'policy'), false)
  assert.equal(afterV1.tiers.build.reviewer.effort, changedBuildReviewerEffort)
  assert.deepEqual(afterV1.models, roster.models)

  const v2 = await write(JSON.stringify(sourceV2, null, 2), moveV2)
  assert.equal(v2.result.applied, true)
  const afterV2 = JSON.parse(v2.written)
  assert.equal(afterV2.schema_version, 2)
  assert.ok(afterV2.assurances)
  assert.equal(Object.hasOwn(afterV2, 'tiers'), false)
  assert.deepEqual(afterV2.policy, policy)
  assert.equal(afterV2.assurances.standard.reviewer.effort, changedBuildReviewerEffort)

  const staged = await stageLadder([moveV1])
  assert.equal(staged.ok, true)
  const applyPreview = (diff, prefix) => {
    const dir = scratchDir(prefix)
    try {
      mkdirSync(join(dir, 'crew'), { recursive: true })
      writeFileSync(join(dir, 'crew', 'roster.json'), rosterText)
      const patchPath = join(dir, 'stage.patch')
      writeFileSync(patchPath, diff)
      execFileSync('patch', ['-p1', '-i', patchPath], { cwd: dir, stdio: 'pipe' })
      return JSON.parse(readFileSync(join(dir, 'crew', 'roster.json'), 'utf8'))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
  const repository = applyPreview(staged.diff, 'roster-stage-repository-')
  const local = applyPreview(staged.local_diff, 'roster-stage-local-')
  assert.equal(repository.schema_version, 2)
  assert.equal(local.schema_version, 1)
  assert.ok(local.tiers)
  assert.equal(Object.hasOwn(local, 'assurances'), false)
})
