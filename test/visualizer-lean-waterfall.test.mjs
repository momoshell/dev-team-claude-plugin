import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { layoutTimeline } from '../visualizer/web/src/lib/timeline.js'
import { createLeanSource } from '../visualizer/server/lean-source.mjs'

const source = (name) => readFileSync(new URL(`../visualizer/web/src/lib/${name}`, import.meta.url), 'utf8')
const base = 1700000000000
const phase = (id, start, end) => ({ id, name: `stage-${id}`, started_at: start == null ? null : base + start, ended_at: end == null ? null : base + end })

test('WF1', () => {
  // MUTATION: removing the LeanWaterfall mount must fail this test.
  const detail = source('LeanRunDetail.svelte'), component = source('LeanWaterfall.svelte')
  assert.match(detail, /<LeanWaterfall \{run\} \/>/)
  for (const section of ['lean-sequence-heading', 'lean-seats-heading', 'lean-journal-heading']) assert.ok(detail.includes(section))
  assert.match(component, /layoutTimeline\(run\)/)
  assert.match(component, /block\.x \* 100/); assert.match(component, /block\.width \* 100/)
  const run = { source: 'lean', started_at: base - 50000, ended_at: base + 100000, phases: [phase(1, 0, 10000), phase(2, 20000, 40000), phase(3, 25000, 30000)] }
  const original = structuredClone(run), result = layoutTimeline(run)
  assert.deepEqual(result.blocks.map(({ x, width, duration_ms }) => [x, width, duration_ms]), [[0, .25, 10000], [.5, .5, 20000], [.625, .125, 5000]])
  assert.equal(result.span_ms, 40000); assert.equal(result.request, null); assert.deepEqual(run, original)
})

test('WF2', () => {
  // MUTATION: disabling recordedOnly must expose fabricated timing or queued phases.
  const phases = [phase(1, 0, 10000), phase(2, null, 90000), phase(3, 2000, null), { ...phase(4, 0, 1000), started_at: 'invalid' }, phase(5, 5000, 4000)]
  const run = { source: 'lean', phases }, result = layoutTimeline(run, [], { now: base + 100000 })
  assert.deepEqual(result.queued, []); assert.deepEqual(result.blocks.map(p => p.id), [1])
  assert.equal(result.unrecorded.length, 4)
  for (const p of result.unrecorded) { assert.equal(p.x, null); assert.equal(p.width, null); assert.equal(p.duration_ms, null); assert.ok(p.reason) }
  assert.match(result.unrecorded[0].reason, /start/i); assert.match(result.unrecorded[1].reason, /end/i); assert.match(result.unrecorded[3].reason, /interval/i)
  assert.deepEqual(result, layoutTimeline(run, [], { now: base + 200000 }))
  for (const list of [[], phases.slice(1)]) { const absent = layoutTimeline({ source: 'lean', phases: list }); assert.equal(absent.origin_at, null); assert.equal(absent.span_ms, null); assert.equal(absent.unrecorded.length, list.length) }
  const legacy = layoutTimeline({ phases: [phase(1, 0, null), phase(2, null, null)] }, [], { now: base + 10000 })
  assert.equal(legacy.queued.length, 1); assert.equal(legacy.blocks[0].duration_ms, 10000)
  const markup = source('LeanWaterfall.svelte'); assert.match(markup, /timeline\.unrecorded as entry/); assert.match(markup, /Not recorded — \{entry.reason\}/)
})

test('WF3', () => {
  // MUTATION: disabling envelope processing must lose the recorded phase roles.
  const root = mkdtempSync(join(tmpdir(), 'lean-waterfall-'))
  try {
    const crewRoot = join(root, 'crew'), archiveRoot = join(root, 'archive'), lane = join(crewRoot, 'dt-demo', 'demo')
    mkdirSync(join(lane, 'task'), { recursive: true }); mkdirSync(archiveRoot)
    writeFileSync(join(lane, 'crew.json'), JSON.stringify({ members: { planner: { agent: 'pi' }, builder: { agent: 'pi' } } }))
    writeFileSync(join(lane, 'task', 'lean.json'), JSON.stringify({ id: 'demo', tier: 'build', shape: 'standard' }))
    const rows = [{ event: 'run-start' }]
    const add = (event, stage, extra = {}) => rows.push({ event, stage, ...extra })
    const env = (stage, role) => add('envelope', stage, { role, id: 'turn', parsed: {}, defects: [], error: null })
    add('stage-start', 'draft'); env('draft', 'planner'); add('stage-end', 'draft')
    add('stage-start', 'draft'); env('draft', 'builder'); env('draft', 'reviewer'); env('draft', ' '); add('stage-end', 'draft')
    add('stage-start', 'draft'); add('stage-end', 'draft')
    add('stage-start', 'outer'); add('stage-start', 'inner'); env('outer', 'builder'); env('inner', 'reviewer'); add('stage-end', 'inner'); add('stage-end', 'outer')
    add('check', 'check-only', { check: 'proof' }); env('check-only', 'builder')
    add('verdict', 'verdict-only', { status: 'stopped' }); env('verdict-only', 'reviewer')
    add('stage-end', 'end-only'); env('end-only', 'planner'); env('unmatched', 'builder')
    writeFileSync(join(lane, 'task', 'journal.jsonl'), rows.map((row, i) => JSON.stringify({ ...row, at: base + i * 1000 })).join('\n') + '\n')
    const run = createLeanSource({ crewRoot, archiveRoot }).listRuns()[0]
    const roles = name => run.phases.filter(p => p.name === name).map(p => p.role ?? null)
    assert.deepEqual(roles('draft'), ['planner', 'reviewer', null]); assert.deepEqual(roles('outer'), ['builder']); assert.deepEqual(roles('inner'), ['reviewer'])
    assert.deepEqual(roles('check-only'), ['builder']); assert.deepEqual(roles('verdict-only'), ['reviewer']); assert.deepEqual(roles('end-only'), ['planner']); assert.deepEqual(roles('unmatched'), [])
    const layout = layoutTimeline(run); assert.equal(layout.blocks.find(p => p.name === 'draft').role, 'planner'); assert.equal(layout.unrecorded.find(p => p.name === 'check-only').role, 'builder')
    const markup = source('LeanWaterfall.svelte'); assert.match(markup, /block\.role/); assert.match(markup, /entry\.role/); assert.match(markup, /Seat role not recorded/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
