import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

// The checkout is ALWAYS the working directory, including in mutation copies.
const root = process.cwd()
const code = (file) => {
  try { return readFileSync(resolve(root, file), 'utf8') }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error }
}
const load = (file) => import(pathToFileURL(resolve(root, file)).href)
const B = 1_700_000_000_000
const iso = (offset) => new Date(B + offset).toISOString()
const close = (actual, expected, message) => {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`)
}
const componentPath = 'visualizer/web/src/lib/LeanWaterfall.svelte'
const detailPath = 'visualizer/web/src/lib/LeanRunDetail.svelte'

const checks = {
  async WF1() {
    const detail = code(detailPath)
    assert.ok(detail.includes('<LeanWaterfall {run} />'), 'lean detail does not mount the phase execution waterfall')
    assert.match(detail, /import\s+LeanWaterfall\s+from\s+['"]\.\/LeanWaterfall\.svelte['"]/, 'mounted waterfall must be imported')
    const component = code(componentPath)
    assert.match(component, /import\s*\{\s*layoutTimeline\s*\}\s*from\s*['"]\.\/timeline\.js['"]/, 'waterfall must reuse the shared layout')
    assert.match(component, /layoutTimeline\(\s*run\s*\)/, 'waterfall must lay out the current run')
    const markup = component.split('</script>')[1] || ''
    assert.match(markup, /Execution waterfall/i, 'waterfall must have a visible heading')
    assert.match(markup, /\{#each\s+timeline\.blocks\s+as\s+block\b/, 'waterfall must render its phase blocks')
    assert.match(markup, /left\s*:\s*\$\{\s*block\.x\s*\*\s*100\s*\}%/, 'bar offsets must use the measured layout')
    assert.match(markup, /width\s*:\s*\$\{\s*block\.width\s*\*\s*100\s*\}%/, 'bar widths must use the measured layout')
    assert.ok(!detail.includes('Stage durations are not measured.'), 'remove the obsolete blanket timing disclaimer')
    for (const evidence of ['lean-sequence-heading', 'lean-seats-heading', 'lean-journal-heading']) {
      assert.ok(detail.includes(evidence), `keep existing evidence section ${evidence}`)
    }
    const { layoutTimeline } = await load('visualizer/web/src/lib/timeline.js')
    const run = { source: 'lean', started_at: iso(-10_000), ended_at: iso(100_000), phases: [
      { id: 1, name: 'draft', started_at: iso(0), ended_at: iso(10_000), role: 'planner' },
      { id: 2, name: 'implement', started_at: iso(20_000), ended_at: iso(40_000), role: 'builder' },
      { id: 3, name: 'inspect', started_at: iso(25_000), ended_at: iso(30_000), role: 'reviewer' },
    ] }
    const original = structuredClone(run)
    const result = layoutTimeline(run, [], { now: B + 999_000 })
    assert.equal(result.blocks.length, 3, 'one measured block per complete phase')
    assert.equal(result.origin_at, iso(0), 'phase timestamps define the origin')
    assert.equal(result.span_ms, 40_000, 'run boundaries must not stretch the phase scale')
    assert.equal(result.request, null, 'lean phase scale must not invent a request-time rail')
    for (const [id, x, width, duration] of [[1, 0, .25, 10_000], [2, .5, .5, 20_000], [3, .625, .125, 5_000]]) {
      const block = result.blocks.find((entry) => entry.phase_id === id)
      assert.ok(block, `phase ${id} is missing from layout`)
      close(block.x, x, `phase ${id} recorded offset (including gaps/overlap)`)
      close(block.width, width, `phase ${id} recorded width`)
      assert.equal(block.duration_ms, duration, `phase ${id} recorded duration`)
    }
    assert.deepEqual(run, original, 'layout must not rewrite recorded input')
  },

  async WF2() {
    const { layoutTimeline } = await load('visualizer/web/src/lib/timeline.js')
    const phases = [
      { id: 1, name: 'complete', started_at: iso(0), ended_at: iso(10_000) },
      { id: 2, name: 'end-only', started_at: null, ended_at: iso(500_000) },
      { id: 3, name: 'check-only', started_at: null, ended_at: null },
      { id: 4, name: 'open', started_at: iso(4_000), ended_at: null },
      { id: 5, name: 'invalid-start', started_at: 'not-a-date', ended_at: iso(9_000) },
      { id: 6, name: 'invalid-end', started_at: iso(3_000), ended_at: 'not-a-date' },
      { id: 7, name: 'reversed', started_at: iso(5_000), ended_at: iso(4_000) },
    ]
    const run = { source: 'lean', phases }
    const result = layoutTimeline(run, [], { now: B + 50_000 })
    assert.deepEqual(result.queued, [], 'lean missing starts are not queued phases')
    assert.deepEqual(result.blocks.map((entry) => entry.phase_id), [1], 'missing/invalid boundaries must not produce a timed bar')
    assert.ok(Array.isArray(result.unrecorded), 'lean layout must retain untimed phases as not-recorded evidence')
    assert.deepEqual(result.unrecorded.map((entry) => entry.id).sort(), [2, 3, 4, 5, 6, 7], 'every untimed phase must remain visible')
    for (const entry of result.unrecorded) {
      for (const field of ['x', 'width', 'duration_ms']) assert.equal(entry[field], null, `${entry.name}: unrecorded ${field} must be null, not zero/origin/now`)
      assert.ok(typeof entry.reason === 'string' && entry.reason.trim(), `${entry.name}: absent timing needs its reason`)
      assert.match(entry.reason, /start|end|interval/i, `${entry.name}: reason must explain the missing/invalid boundary`)
    }
    for (const id of [2, 3, 5]) assert.match(result.unrecorded.find((entry) => entry.id === id).reason, /start/i, `phase ${id}: explain the absent/invalid start`)
    for (const id of [4, 6]) assert.match(result.unrecorded.find((entry) => entry.id === id).reason, /end/i, `phase ${id}: explain the absent/invalid end`)
    assert.match(result.unrecorded.find((entry) => entry.id === 7).reason, /interval|revers|before|order/i, 'reversed phase must explain its invalid interval')
    assert.equal(result.span_ms, 10_000, 'unrecorded phases cannot expand the measured scale')
    assert.deepEqual(layoutTimeline(run, [], { now: B + 500_000 }), result, 'lean missing ends must never stretch to now')
    for (const untimed of [phases.slice(1), []]) {
      const absent = layoutTimeline({ source: 'lean', phases: untimed }, [], { now: B + 50_000 })
      assert.deepEqual(absent.blocks, [], 'all-unrecorded input has no timed bars')
      assert.deepEqual(absent.queued, [], 'all-unrecorded input has no queued bars')
      assert.equal(absent.origin_at, null, 'no recorded origin may be invented')
      assert.equal(absent.span_ms, null, 'no recorded span may be invented')
      assert.equal(absent.unrecorded.length, untimed.length, 'early return must retain absent phase evidence')
    }
    const component = code(componentPath)
    const markup = component.split('</script>')[1] || ''
    const absentRows = markup.match(/\{#each\s+timeline\.unrecorded\s+as\s+entry\b([\s\S]*?)\{\/each\}/)?.[1]
    assert.ok(absentRows, 'waterfall must visibly render unrecorded phases outside timed blocks')
    assert.match(absentRows, /Not recorded/i, 'missing timing must say not recorded')
    assert.match(absentRows, /entry\.reason/, 'missing timing must show its reason')
    assert.ok(!/entry\.(?:x|width|duration_ms)|class=["']bar["']/.test(absentRows), 'untimed evidence must not render a fabricated bar')
    // Preserve the legacy caller: only lean runs gain recorded-only semantics.
    const legacy = layoutTimeline({ phases: [
      { id: 1, name: 'open', started_at: iso(0), ended_at: null },
      { id: 2, name: 'waiting', started_at: null, ended_at: null },
    ] }, [], { now: B + 10_000 })
    assert.equal(legacy.queued.length, 1, 'legacy queued behavior must remain intact')
    assert.equal(legacy.blocks[0].duration_ms, 10_000, 'legacy open intervals retain their existing now-based behavior')
  },

  async WF3() {
    const { createLeanSource } = await load('visualizer/server/lean-source.mjs')
    const sandbox = mkdtempSync(join(tmpdir(), 'lean-waterfall-gate-'))
    try {
      const crewRoot = join(sandbox, 'crew'), archiveRoot = join(sandbox, 'archive')
      const name = 'waterfall-proof', lane = join(crewRoot, `dt-${name}`, name)
      mkdirSync(join(lane, 'task'), { recursive: true }); mkdirSync(archiveRoot)
      writeFileSync(join(lane, 'crew.json'), JSON.stringify({ members: { planner: { agent: 'pi' }, builder: { agent: 'pi' }, reviewer: { agent: 'pi' }, 'tech-lead': { agent: 'pi' } } }))
      writeFileSync(join(lane, 'task', 'lean.json'), JSON.stringify({ id: name, tier: 'build', shape: 'standard' }))
      const rows = [{ event: 'run-start', at: B }]
      let turn = 0
      const add = (row) => rows.push({ ...row, at: B + rows.length * 1000 })
      const begin = (stage) => add({ event: 'stage-start', stage })
      const end = (stage) => add({ event: 'stage-end', stage, outcome: { status: 'done' } })
      const envelope = (stage, role) => {
        const id = `${name}.${role || 'blank'}.${++turn}`
        add({ event: 'envelope', stage, role, id, returnPath: `task/${role || 'blank'}-${turn}.json`, parsed: { role, id, status: 'done', summary: 'Recorded response', details: {} }, defects: [], error: null })
      }
      begin('draft'); envelope('draft', 'planner'); end('draft')
      begin('implement'); envelope('implement', 'builder'); end('implement')
      begin('implement'); envelope('implement', 'reviewer'); envelope('implement', 'tech-lead'); envelope('implement', ''); end('implement')
      begin('implement'); end('implement')
      begin('outer'); begin('inner'); envelope('inner', 'reviewer'); end('inner'); envelope('outer', 'builder'); end('outer')
      begin('gate'); end('gate')
      add({ event: 'check', stage: 'check-only', check: 'evidence', result: { status: 'green' } }); envelope('check-only', 'builder')
      add({ event: 'verdict', stage: 'verdict-only', status: 'stopped' }); envelope('verdict-only', 'reviewer')
      end('end-only'); envelope('end-only', 'planner')
      begin('blank'); envelope('blank', '  '); end('blank')
      envelope('unmatched', 'reviewer')
      writeFileSync(join(lane, 'task', 'journal.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
      const source = createLeanSource({ crewRoot, archiveRoot })
      const run = source.listRuns().find((entry) => entry.goal === name)
      assert.ok(run, 'fixture must resolve through the public lean source API')
      const roles = (stage) => run.phases.filter((phase) => phase.name === stage).map((phase) => phase.role ?? null)
      assert.deepEqual(roles('draft'), ['planner'], 'phase must carry the role from its stage envelope, not its stage name')
      assert.deepEqual(roles('implement'), ['builder', 'tech-lead', null], 'retry phases keep their own latest nonempty answered role, never a previous attempt owner')
      assert.deepEqual(roles('inner'), ['reviewer'], 'nested phase carries its matching role')
      assert.deepEqual(roles('outer'), ['builder'], 'envelope must bind by stage, not last-created phase')
      assert.deepEqual(roles('gate'), [null], 'roster/stage must not invent a role without an envelope')
      assert.deepEqual(roles('blank'), [null], 'blank envelope role remains absent')
      assert.deepEqual(roles('check-only'), ['builder'], 'start-less check phase may still have a recorded seat')
      assert.deepEqual(roles('verdict-only'), ['reviewer'], 'start-less verdict phase may still have a recorded seat')
      assert.deepEqual(roles('end-only'), ['planner'], 'end-only phase may still have a recorded seat')
      assert.deepEqual(roles('unmatched'), [], 'unmatched envelope creates no phantom phase')
      const { layoutTimeline } = await load('visualizer/web/src/lib/timeline.js')
      const timeline = layoutTimeline(run, [], { now: B + 999_000 })
      assert.equal(timeline.blocks.find((block) => block.name === 'draft')?.role, 'planner', 'layout must preserve recorded role labels')
      for (const [stage, role] of [['check-only', 'builder'], ['verdict-only', 'reviewer'], ['end-only', 'planner']]) {
        assert.equal(timeline.unrecorded?.find((entry) => entry.name === stage)?.role, role, 'untimed phases must retain their recorded seat')
      }
      const markup = (code(componentPath).split('</script>')[1] || '')
      assert.match(markup, /block\.role/, 'timed phase label must render the recorded seat role')
      const absentRows = markup.match(/\{#each\s+timeline\.unrecorded\s+as\s+entry\b([\s\S]*?)\{\/each\}/)?.[1] || ''
      assert.match(absentRows, /entry\.role/, 'untimed phase label must also render the recorded seat role')
      assert.match(markup, /Seat role not recorded/i, 'missing role must remain honestly absent')
    } finally { rmSync(sandbox, { recursive: true, force: true }) }
  },
}

let failed = false
for (const id of ['WF1', 'WF2', 'WF3']) {
  try { await checks[id]() }
  catch (error) {
    failed = true
    const reason = String(error?.message || error).split('\n')[0]
    console.log(`FAIL ${id}: ${reason}`)
  }
}
process.exitCode = failed ? 1 : 0
