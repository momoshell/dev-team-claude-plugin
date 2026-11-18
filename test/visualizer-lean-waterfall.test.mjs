import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { layoutTimeline, formatLeanDuration } from '../visualizer/web/src/lib/timeline.js'
import { createLeanSource } from '../crew/lean-source.mjs'

const source = (name) => readFileSync(new URL(`../visualizer/web/src/lib/${name}`, import.meta.url), 'utf8')
const base = 1700000000000
const phase = (id, start, end) => ({ id, name: `stage-${id}`, started_at: start == null ? null : base + start, ended_at: end == null ? null : base + end })

test('WP1 separates open and unrecorded phases without invented durations', () => {
  // MUTATION: disable the running, absent-end classification.
  const iso = n => new Date(base + n).toISOString()
  const open = { id: 2, name: 'open', role: 'builder', status: 'running', started_at: iso(20000), ended_at: null }
  const complete = { ...phase(1, 0, 10000), status: 'done' }
  const bad = [
    { ...open, id: 3, started_at: null }, { ...open, id: 4, started_at: 'invalid' },
    { ...open, id: 5, ended_at: 'invalid' }, { ...open, id: 6, status: 'done' }, phase(7, 5000, 4000),
  ]
  const run = { source: 'lean', phases: [complete, open, ...bad] }, original = structuredClone(run)
  const result = layoutTimeline(run, [], { now: base + 100000 })
  assert.deepEqual(result.blocks.map(p => p.id), [1, 2]); assert.equal(result.blocks[1].x, 1)
  assert.deepEqual(result.unrecorded.map(p => p.id), [3, 4, 5, 6, 7])
  assert.equal(result.origin_at, iso(0)); assert.equal(result.span_ms, 20000)
  assert.deepEqual(result, layoutTimeline(run, [], { now: base + 900000 })); assert.deepEqual(run, original)
  const only = layoutTimeline({ source: 'lean', phases: [open] })
  assert.equal(only.blocks.length, 1); assert.deepEqual(only.unrecorded, [])
  assert.equal(only.origin_at, iso(20000)); assert.equal(only.span_ms, 0)
  assert.deepEqual(layoutTimeline({ source: 'lean', phases: [] }).blocks, [])
  const markup = source('LeanWaterfall.svelte')
  assert.doesNotMatch(markup, /timeline\.open/)
  assert.match(markup, /timeline\.unrecorded as entry/); assert.match(markup, /Not recorded — \{entry.reason\}/)
})

test('a build stage with a lead turn inside it shows the builder turn seconds apart from the stage span', () => {
  const root = mkdtempSync(join(tmpdir(), 'lean-turns-'))
  try {
    const crewRoot = join(root, 'crew'), archiveRoot = join(root, 'archive'), lane = join(crewRoot, 'dt-demo', 'demo')
    mkdirSync(join(lane, 'task'), { recursive: true }); mkdirSync(archiveRoot)
    writeFileSync(join(lane, 'crew.json'), JSON.stringify({ members: { builder: { agent: 'pi' }, lead: { agent: 'pi' } } }))
    writeFileSync(join(lane, 'task', 'lean.json'), JSON.stringify({ id: 'demo', tier: 'build', shape: 'standard' }))
    const row = (event, stage, seconds, extra = {}) => ({ event, lane: 'demo', stage, at: base + seconds * 1000, ...extra })
    const turn = (stage, role, seconds, at) => row('seat-turn', stage, at, { role, id: 'turn', model: 'model', seconds, status: 'done', usage: null, unmeasured: {} })
    const env = (stage, role, at) => row('envelope', stage, at, { role, id: 'turn', parsed: {}, defects: [], error: null })
    const rows = [row('stage-start', 'build', 0), turn('build', 'builder', 59, 59), turn('build', 'lead', 7, 59), env('build', 'builder', 59), row('stage-start', 'lead', 59), turn('lead', 'lead', 24, 83), env('lead', 'lead', 83), row('stage-end', 'lead', 83), turn('build', 'builder', 486, 569), env('build', 'builder', 569), row('stage-end', 'build', 569)]
    writeFileSync(join(lane, 'task', 'journal.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n')
    const run = createLeanSource({ crewRoot, archiveRoot }).listRuns()[0]
    const [build, lead] = layoutTimeline(run).blocks
    // MUTATION: drop the role filter in layoutTimeline; the lead-roled turn inside build adds 7s.
    assert.equal(build.seat_ms, 545000); assert.equal(build.seat_reason, null); assert.equal(build.duration_ms, 569000); assert.equal(lead.seat_ms, 24000)
    for (const seconds of [null, -1, '5']) {
      const phases = structuredClone(run.phases); phases[0].turns.push({ role: 'builder', seconds })
      const block = layoutTimeline({ phases }).blocks[0]
      assert.equal(block.seat_ms, null); assert.equal(block.seat_reason, 'seconds-malformed')
    }
    // MUTATION: drop the journal's unmeasured.seconds reason in the reader.
    writeFileSync(join(lane, 'task', 'journal.jsonl'), [...rows.slice(0, -1), row('seat-turn', 'build', 570, { role: 'builder', id: 'turn', model: 'model', seconds: null, status: 'done', usage: null, unmeasured: { seconds: 'clock-unmeasured' } }), rows.at(-1)].map(r => JSON.stringify(r)).join('\n') + '\n')
    const unclocked = layoutTimeline(createLeanSource({ crewRoot, archiveRoot }).listRuns()[0]).blocks[0]
    assert.equal(unclocked.seat_ms, null); assert.equal(unclocked.seat_reason, 'clock-unmeasured'); assert.equal(unclocked.duration_ms, 569000)
    const markup = source('LeanWaterfall.svelte')
    assert.match(markup, /block\.role\} turns \{formatLeanDuration\(block\.seat_ms\)/); assert.match(markup, /Stage span \{formatLeanDuration\(block\.duration_ms\)/)
    assert.match(markup, /\{:else if block\.seat_reason\}<span>\{block\.role\} turn time not measured · \{block\.seat_reason\}/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('WP3 formats valid durations and rejects invalid values', () => {
  // MUTATION: replace the seconds conversion with raw milliseconds.
  for (const [ms, expected] of [[0, '0s'], [1, '0.001s'], [123, '0.123s'], [1500, '1.5s'], [60000, '1m 0s'], [165213, '2m 45.213s'], [664000, '11m 4s']]) assert.equal(formatLeanDuration(ms), expected)
  for (const value of [null, undefined, NaN, Infinity, -Infinity, -1, '1000']) assert.equal(formatLeanDuration(value), null)
  const markup = source('LeanWaterfall.svelte')
  assert.match(markup, /import\s*\{[^}]*\bformatLeanDuration\b[^}]*\}\s*from\s*['"]\.\/timeline\.js['"]/)
  assert.match(markup, /\{formatLeanDuration\(block\.duration_ms\)\}/); assert.doesNotMatch(markup, /\{block\.duration_ms\}\s*ms\b/)
})

test('historical stage order stays ordinal without fabricating timing or collapsing retries', async () => {
  // MUTATION: sort/deduplicate phases or use ordinal positions as durations.
  const { layoutStageOrder } = await import('../visualizer/web/src/lib/timeline.js')
  const run = { source: 'lean', phases: [
    { id: 11, name: 'build', role: 'builder', status: 'done', checks: [] },
    { id: 12, name: 'review', role: 'reviewer', status: 'done', checks: [] },
    { id: 13, name: 'build', role: 'builder', status: 'running', checks: [{ check: 'gate', result: { status: 'red' } }] },
  ] }
  const before = structuredClone(run), order = layoutStageOrder(run)
  assert.deepEqual(order.map(p => [p.id, p.ordinal, p.x, p.width, p.duration_ms]), [
    [11, 1, 0, 1 / 3, null], [12, 2, 1 / 3, 1 / 3, null], [13, 3, 2 / 3, 1 / 3, null],
  ])
  assert.equal(order[2].status, 'running'); assert.deepEqual(order[2].checks, run.phases[2].checks)
  assert.deepEqual(run, before); assert.deepEqual(layoutStageOrder(), []); assert.deepEqual(layoutStageOrder({ phases: null }), [])
  const component = source('LeanWaterfall.svelte')
  assert.match(component, /!timeline\.blocks\.length && ordered\.length > 0/)
  assert.match(component, /positions and widths do not measure elapsed time/)
  assert.match(component, /Untimed · recorded order/)
  assert.match(component, /leanCheckStatus\(check\)/)
})
