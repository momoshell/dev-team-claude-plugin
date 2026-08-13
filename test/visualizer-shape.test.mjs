import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { shapeRun, foldAgents, laneFor, matchesFilters } from '../visualizer/server/shape.mjs'
import { drainEvents, createDrainQueue } from '../visualizer/web/src/lib/drain.js'
import { layoutTimeline, MIN_WIDTH, QUEUED_WIDTH } from '../visualizer/web/src/lib/timeline.js'
import { diffEnvelopes, attemptPairs } from '../visualizer/web/src/lib/envelope-diff.js'

const start = '2024-01-01T00:00:00.000Z'
const end = '2024-01-01T00:00:02.000Z'
const base = { adw_id: 'x', task_slug: 'task', repo_slug: 'repo', status: 'running', started_at: start, ended_at: null,
  billed_cost_usd: null, billed_input_tokens: null, billed_output_tokens: null, billed_cache_write_tokens: null, billed_cache_read_tokens: null }
const missingProbe = { missing: ['mode', 'engineer'], latched: false, probes: 1 }

function allFiles(path, output = []) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory() && entry.name !== 'dist' && entry.name !== 'node_modules') allFiles(child, output)
    else if (entry.isFile()) output.push(child)
  }
  return output
}

test('shapeRun has an identical card key set for live and finished runs', () => {
  const live = shapeRun(base, [], [], null, missingProbe, Date.parse(end))
  const finished = shapeRun({ ...base, status: 'ok', ended_at: end }, [], [], null, missingProbe, Date.parse('2025-01-01'))
  assert.deepEqual(Object.keys(live).sort(), Object.keys(finished).sort())
  assert.equal(live.duration_ms, 2000)
  assert.equal(finished.duration_ms, 2000)
  assert.equal(live.running, true)
  assert.equal(finished.running, false)
})

test('every unmeasured field is null and has a non-empty pending reason', () => {
  const run = shapeRun(base, [], [], null, missingProbe, Date.parse(end))
  for (const field of Object.keys(run.pending)) {
    const value = field in run.metrics ? run.metrics[field] : run[field]
    assert.equal(value, null, `${field} must never be fabricated`)
    assert.equal(typeof run.pending[field], 'string')
    assert.ok(run.pending[field].length > 0)
    assert.notEqual(run.pending[field], 0)
  }
  assert.equal(run.metrics.read_tokens, null)
  assert.equal(run.metrics.written_tokens, null)
})

test('real emitted events leave phase lanes honestly unavailable, while linked events resolve', () => {
  const phases = [{ id: 1, seq: 1, name: 'plan', status: 'ok', started_at: start, ended_at: end }]
  const emitted = [{ type: 'agent_start', phase_id: null, payload_json: JSON.stringify({ role: 'planner', dispatch_id: 'd1' }), started_at: start }]
  const honest = shapeRun(base, phases, emitted, null, missingProbe, Date.parse(end))
  assert.equal(honest.phases[0].lane, null)
  assert.equal(honest.phase_lanes, null)
  assert.equal(typeof honest.pending.phase_lanes, 'string')
  assert.notEqual(honest.phases[0].lane, 0)
  const stale = shapeRun(base, phases, [{ ...emitted[0], phase_id: 99 }], null, missingProbe, Date.parse(end))
  assert.equal(stale.phases[0].lane, null)
  assert.equal(typeof stale.pending.phase_lanes, 'string')
  const linked = shapeRun(base, phases, [{ ...emitted[0], phase_id: 1 }], null, missingProbe, Date.parse(end))
  assert.equal(linked.phases[0].lane, laneFor('planner'))
  assert.equal(linked.phase_lanes, 'agent')
  assert.equal(linked.pending.phase_lanes, undefined)
})

test('foldAgents gap-fills starts and closes lanes on end', () => {
  const started = [{ type: 'agent_start', payload_json: JSON.stringify({ role: 'builder', dispatch_id: 'open' }), started_at: start }]
  assert.deepEqual(foldAgents(started)[0], { dispatch_id: 'open', role: 'builder', lane: laneFor('builder'), outcome: null, started_at: start, ended_at: null })
  const closed = foldAgents([...started, { type: 'agent_end', payload_json: JSON.stringify({ role: 'builder', dispatch_id: 'open', outcome: 'done' }), started_at: end }])[0]
  assert.equal(closed.outcome, 'done')
  assert.equal(closed.ended_at, end)
})

test('laneFor is stable for a role across calls', () => {
  assert.equal(laneFor('planner'), laneFor('planner'))
  assert.equal(laneFor('reviewer'), laneFor('reviewer'))
})

test('matchesFilters covers mode, status, since, until and pending mode', () => {
  const pending = shapeRun(base, [], [], null, missingProbe, Date.parse(end))
  assert.equal(matchesFilters(pending, { mode: '' }), true)
  assert.equal(matchesFilters(pending, { mode: 'shop-floor' }), false)
  const complete = shapeRun({ ...base, status: 'ok', ended_at: end, mode: 'batch' }, [], [], null, { missing: ['engineer'] }, Date.parse(end))
  assert.equal(matchesFilters(complete, { mode: 'batch', status: 'ok', since: '2023-12-31', until: '2024-01-02' }), true)
  assert.equal(matchesFilters(complete, { mode: 'other' }), false)
  assert.equal(matchesFilters(complete, { status: 'running' }), false)
  assert.equal(matchesFilters(complete, { since: '2024-01-02' }), false)
  assert.equal(matchesFilters(complete, { until: '2024-01-01' }), false)
})

test('drainEvents exhausts pages, stops stalled cursors, and reports max-page truncation', async () => {
  const source = Array.from({ length: 201 }, (_, i) => ({ id: i + 1 }))
  const fetchPage = async (after, limit) => {
    const events = source.filter((event) => event.id > after).slice(0, limit)
    return { events, cursor: events.length ? events.at(-1).id : after }
  }
  const drained = await drainEvents(fetchPage, { limit: 100 })
  assert.equal(drained.events.length, 201)
  assert.equal(new Set(drained.events.map((event) => event.id)).size, 201)
  assert.equal(drained.truncated, false)
  const stalled = await drainEvents(async () => ({ events: [{ id: 1 }], cursor: 0 }), { limit: 1 })
  assert.equal(stalled.truncated, true)
  const shortStalled = await drainEvents(async () => ({ events: [{ id: 1 }], cursor: 0 }), { limit: 100 })
  assert.equal(shortStalled.truncated, true)
  const guarded = await drainEvents(async (after) => ({ events: [{ id: after + 1 }], cursor: after + 1 }), { limit: 1, maxPages: 2 })
  assert.equal(guarded.truncated, true)
})

test('final drain is queued behind an in-flight periodic drain', async () => {
  let release
  const firstPage = new Promise((resolve) => { release = resolve })
  let calls = 0
  const queue = createDrainQueue(async () => { calls += 1; if (calls === 1) await firstPage })
  const running = queue.drain()
  const finishing = queue.drain({ final: true })
  await Promise.resolve()
  assert.equal(calls, 1)
  release()
  await running
  await finishing
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 2)
})

test('crew emitter tripwire confirms phase linkage and honest unavailable wording', () => {
  const crew = readFileSync(join(process.cwd(), 'crew/crew.mjs'), 'utf8')
  const shape = readFileSync(join(process.cwd(), 'visualizer/server/shape.mjs'), 'utf8')
  assert.match(crew, /const record = \(type, payload\).*phase_id: phaseId/s)
  assert.doesNotMatch(shape, /crew agent events carry no phase_id/)
})

test('timeline reserves request space and parks queued phases', () => {
  const run = { started_at: start, ended_at: end, phase_lanes: 'agent', phases: [
    { id: 1, seq: 1, name: 'plan', status: 'ok', lane: 0, started_at: start, ended_at: end },
    { id: 2, seq: 2, name: 'finish', status: 'running', lane: null, started_at: null, ended_at: null },
  ] }
  const out = layoutTimeline(run, [], { now: Date.parse(end) })
  assert.equal(out.origin_at, start)
  assert.equal(out.queued[0].queued, true)
  assert.equal(out.queued[0].width, QUEUED_WIDTH)
  assert.equal(out.request, null)
})

test('timeline excludes point events and keeps span marks', () => {
  const run = { phases: [{ id: 1, seq: 1, name: 'plan', status: 'ok', started_at: start, ended_at: end }] }
  const out = layoutTimeline(run, [{ id: 1, started_at: null, ended_at: null, payload_json: '{"duration_ms":99}' }, { id: 2, started_at: start, ended_at: end }], { now: Date.parse(end) })
  assert.deepEqual(out.marks.map((event) => event.id), [2])
})

test('timeline floors and separates consecutive blocks', () => {
  const run = { phases: [{ id: 1, seq: 1, name: 'a', started_at: start, ended_at: start }, { id: 2, seq: 2, name: 'b', started_at: end, ended_at: end }] }
  const out = layoutTimeline(run, [], { now: Date.parse(end) })
  assert.ok(out.blocks.every((block) => block.width >= MIN_WIDTH - 1e-9))
  assert.ok(out.blocks[0].x + out.blocks[0].width <= out.blocks[1].x + 1e-9)
})

test('envelope diff reports recursive changes in stable order', () => {
  const before = { status: 'done', summary: 'old', artifacts: ['a'], details: { remove: true } }
  const after = { status: 'done', summary: 'new', artifacts: ['a', 'b'], details: { add: true } }
  const rows = diffEnvelopes(before, after)
  assert.deepEqual(rows.map((row) => row.path), ['artifacts[1]', 'details.add', 'details.remove', 'summary'])
})

test('attemptPairs finds consecutive attempts per role', () => {
  const pairs = attemptPairs([{ role: 'builder', dispatch_seq: 1 }, { role: 'planner', dispatch_seq: 2 }, { role: 'builder', dispatch_seq: 3 }])
  assert.equal(pairs.length, 1)
  assert.equal(pairs[0].role, 'builder')
})

test('timeline empty run is safe', () => {
  const out = layoutTimeline({ phases: [] }, [])
  assert.deepEqual(out.blocks, [])
  assert.deepEqual(out.marks, [])
})

test('visualizer architecture keeps sqlite and legacy Svelte syntax behind the boundaries', () => {
  const files = allFiles(join(process.cwd(), 'visualizer'))
  const allowed = new Set(['visualizer/server/ledger-feed.mjs', 'visualizer/server/triage.mjs'])
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const relative = file.replace(`${process.cwd()}/`, '')
    if (source.includes('node:sqlite')) assert.ok(allowed.has(relative), relative)
    if (file.endsWith('.svelte')) {
      assert.doesNotMatch(source, /^\s*export\s+let\s/m, relative)
      assert.doesNotMatch(source, /^\s*\$:\s/m, relative)
    }
  }
})
