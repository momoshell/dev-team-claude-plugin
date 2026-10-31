import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// All code under test is resolved from the checkout supplied as cwd, never this artifact.
const root = process.cwd()
const modulePath = resolve(root, 'visualizer/web/src/lib/timeline.js')
const componentPath = resolve(root, 'visualizer/web/src/lib/LeanWaterfall.svelte')
let api, loadError
try { api = await import(pathToFileURL(modulePath).href) } catch (error) { loadError = error }
const component = () => readFileSync(componentPath, 'utf8')
const base = 1700000000000
const stamp = n => n == null ? null : new Date(base + n).toISOString()
const phase = (id, start, end, status = 'done') => ({
  id, name: `stage-${id}`, role: 'builder', status,
  started_at: stamp(start), ended_at: stamp(end),
})
function layout(run, now = base + 200000) {
  assert.ok(!loadError, `timeline module could not load: ${loadError?.message}`)
  assert.equal(typeof api.layoutTimeline, 'function', 'layoutTimeline entry point missing')
  return api.layoutTimeline(run, [], { now })
}
const checks = {
  WP1() {
    const complete = phase(1, 0, 10000)
    const open = phase(2, 20000, null, 'running')
    const bad = [
      phase(3, null, null, 'running'),
      { ...phase(4, 0, null, 'running'), started_at: 'invalid' },
      { ...phase(5, 0, null, 'running'), ended_at: 'invalid' },
      phase(6, 0, null, 'done'),
      phase(7, 5000, 4000),
    ]
    const run = { source: 'lean', phases: [complete, open, ...bad] }
    const original = structuredClone(run)
    const result = layout(run)
    assert.ok(Array.isArray(result.open), 'started phase with no stage-end is not classified as open')
    assert.deepEqual(result.open.map(p => p.id), [2], 'open classification must require recorded start, running status and absent end')
    assert.deepEqual(result.blocks.map(p => p.id), [1], 'open phase must not acquire a completed bar')
    assert.deepEqual(result.unrecorded.map(p => p.id), [3, 4, 5, 6, 7], 'open phase must not be listed as a missing/invalid end')
    const entry = result.open[0]
    for (const key of ['x', 'width', 'duration_ms']) assert.equal(entry[key], null, `open ${key} must remain unmeasured`)
    for (const key of ['id', 'name', 'role', 'started_at', 'ended_at']) assert.equal(entry[key], open[key], `preserve open ${key} evidence`)
    assert.equal(result.origin_at, stamp(0)); assert.equal(result.span_ms, 10000)
    assert.deepEqual(result, layout(run, base + 900000), 'wall clock must not change recorded lean layout')
    assert.deepEqual(run, original, 'layout must not mutate recorded evidence')
    const only = layout({ source: 'lean', phases: [open] })
    assert.equal(only.open.length, 1); assert.equal(only.blocks.length, 0); assert.equal(only.unrecorded.length, 0)
    assert.equal(only.origin_at, null); assert.equal(only.span_ms, null)
    assert.deepEqual(layout({ source: 'lean', phases: [] }).open, [])
    const markup = component()
    const openRows = markup.match(/\{#each\s+timeline\.open\s+as\s+entry\b[\s\S]*?\{\/each\}/)?.[0]
    assert.ok(openRows, 'component must display the open entries separately')
    assert.ok(openRows.includes('Open — no stage-end record'), 'open rows need an explicit non-live open label')
    assert.match(openRows, /entry\.name/); assert.match(openRows, /entry\.role/)
    assert.doesNotMatch(openRows, /\brunning\b|\blive\b|in.flight|duration_ms|class="bar"/i, 'open rows must not claim liveness or measured duration')
    assert.match(markup, /timeline\.unrecorded as entry/)
    assert.ok(markup.includes('Not recorded — {entry.reason}'), 'retain true missing/invalid-boundary presentation')
  },
  WP2() {
    const run = { source: 'lean', phases: [
      phase(1, 0, 1000000), phase(2, 0, 1), phase(3, 200000, 200123),
      phase(4, 500000, 500000), phase(5, 999999, 1000000),
    ] }
    const original = structuredClone(run), result = layout(run)
    assert.equal(api.MIN_WIDTH, 0.02, 'reuse the existing drawing floor')
    assert.equal(result.origin_at, stamp(0)); assert.equal(result.span_ms, 1000000)
    assert.equal(result.blocks.length, 5)
    for (const [index, block] of result.blocks.entries()) {
      const recorded = run.phases[index]
      const start = Date.parse(recorded.started_at), end = Date.parse(recorded.ended_at)
      assert.equal(block.id, recorded.id)
      assert.equal(block.width, Math.max(0.02, (end - start) / 1000000), `stage ${block.id} is not drawn at the minimum width`)
      assert.equal(block.duration_ms, end - start, 'drawing floor must not inflate the printed duration')
      assert.equal(block.x, (start - base) / 1000000, 'drawing floor must not shift measured positions')
    }
    assert.deepEqual(run, original)
    const zero = layout({ source: 'lean', phases: [phase(10, 500, 500)] })
    assert.equal(zero.span_ms, 0); assert.equal(zero.blocks[0].width, 0.02, 'zero-span recorded interval still needs a visible bar')
    assert.equal(zero.blocks[0].duration_ms, 0); assert.equal(zero.blocks[0].x, 0)
    // Retain the existing WF1 common scale, including overlaps above the drawing floor.
    const normal = layout({ source: 'lean', phases: [phase(1, 0, 10000), phase(2, 20000, 40000), phase(3, 25000, 30000)] })
    assert.deepEqual(normal.blocks.map(({ x, width, duration_ms }) => [x, width, duration_ms]), [[0, .25, 10000], [.5, .5, 20000], [.625, .125, 5000]])
    const markup = component()
    assert.match(markup, /block\.x \* 100/); assert.match(markup, /block\.width \* 100/)
  },
  WP3() {
    assert.ok(!loadError, `timeline module could not load: ${loadError?.message}`)
    assert.equal(typeof api.formatLeanDuration, 'function', 'lean stage durations still lack a seconds/minutes formatter')
    for (const [ms, expected] of [[0, '0s'], [1, '0.001s'], [123, '0.123s'], [1500, '1.5s'], [60000, '1m 0s'], [165213, '2m 45.213s'], [664000, '11m 4s']]) {
      assert.equal(api.formatLeanDuration(ms), expected, `duration ${ms} must use measured seconds/minutes, not raw milliseconds`)
    }
    for (const invalid of [null, undefined, NaN, Infinity, -Infinity, -1, '1000']) {
      assert.equal(api.formatLeanDuration(invalid), null, 'unknown/invalid duration must not become zero or a liveness claim')
    }
    const markup = component()
    assert.match(markup, /import\s*\{[^}]*\bformatLeanDuration\b[^}]*\}\s*from\s*['"]\.\/timeline\.js['"]/, 'component must import the tested formatter')
    assert.match(markup, /\{formatLeanDuration\(block\.duration_ms\)\}/, 'stage label must use the tested formatter')
    assert.doesNotMatch(markup, /\{block\.duration_ms\}\s*ms\b/, 'raw-ms stage label remains')
  },
}
let failed = false
for (const id of ['WP1', 'WP2', 'WP3']) {
  try { checks[id]() } catch (error) {
    failed = true
    const reason = String(error?.message ?? error).split('\n')[0].replace(/[\r\n]/g, ' ')
    console.log(`FAIL ${id}: ${reason}`)
  }
}
process.exitCode = failed ? 1 : 0
