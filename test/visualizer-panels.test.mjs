import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseHash, formatHash } from '../visualizer/web/src/lib/route.js'
import { configurationDimensionCell, configurationFilterView, tokenCell } from '../visualizer/web/src/lib/fleet.js'
import { assuranceMeta, executionMeta } from '../visualizer/web/src/lib/workflow-semantics.js'
import { ROOT } from './helpers.mjs'
import { transportLabel } from '../visualizer/web/src/lib/agent-settings.js'

test('TR3 transportLabel names acp and shows a retired transport as recorded', () => {
  assert.equal(transportLabel('acp'), 'Agent Client Protocol (ACP)')
  for (const value of ['pane', 'headless-json', 'headless-rpc']) assert.equal(transportLabel(value), value)
})

test('LB1 a lean row\'s tier and shape fill the board\'s assurance and execution cells and filters', () => {
  const lean = { adw_id: 'l', source: 'lean', tier: 'build', shape: 'standard' }
  // MUTATION: read the absent assurance and execution_shape fields instead.
  assert.equal(configurationDimensionCell(lean, 'assurance').text, 'Standard')
  assert.equal(configurationDimensionCell(lean, 'execution_shape').text, 'Standard')
  assert.equal(configurationDimensionCell(lean, 'task_profile').dashed, true)
  assert.deepEqual(configurationFilterView([lean]).dimensions.map((d) => d.key), ['execution_shape', 'assurance'])
  assert.equal(configurationFilterView([lean], { assurance: 'rigorous' }).rows.length, 0)
  assert.equal(configurationFilterView([lean], { assurance: 'standard' }).rows.length, 1)
  assert.equal(configurationDimensionCell({ tier: 'build' }, 'assurance').dashed, true)
})

test('workflow semantics name only real tiers and shapes and no mechanical planner or reviewer', () => {
  for (const value of ['mechanical', 'build', 'judge', 'unknown', null]) assert.equal('staffing' in assuranceMeta(value), false)
  const text = readFileSync(join(ROOT, 'visualizer/web/src/lib/workflow-semantics.js'), 'utf8')
  const quick = text.match(/quick: Object\.freeze\(\{[\s\S]*?\}\)/)[0]
  assert.doesNotMatch(quick, /planner|reviewer/i)
  for (const shape of ['standard', 'finish']) assert.notEqual(executionMeta(shape).summary, 'Recorded execution shape.')
  assert.doesNotMatch(executionMeta('standard').summary, /plan|review/i)
  assert.doesNotMatch(executionMeta('finish').summary, /pull request|\bpr\b/i)
  assert.equal(executionMeta('full').summary, 'Recorded execution shape.')
})

test('hash routes parse and format every kept canonical view', () => {
  for (const hash of ['#/', '#/agents', '#/skills', '#/adw-123']) {
    assert.equal(formatHash(parseHash(hash)), hash)
  }
  assert.deepEqual(parseHash(''), { view: 'fleet', adw_id: null })
  assert.deepEqual(parseHash('#'), { view: 'fleet', adw_id: null })
  assert.deepEqual(parseHash('#/adw-123/'), { view: 'run', adw_id: 'adw-123' })
  assert.deepEqual(parseHash('#/agents/ignored/extra'), { view: 'agents', adw_id: null })
  // A dropped view's hash is read as a run id, never routed to a page that no longer exists.
  for (const dropped of ['ops', 'roster', 'prompts', 'workflows', 'assurances']) assert.equal(parseHash(`#/${dropped}`).view, 'run')
  assert.deepEqual(parseHash('#/adw-123/plan/ignored'), { view: 'run', adw_id: 'adw-123' })
  assert.equal(parseHash('#/agents').adw_id, null)
  assert.equal(parseHash('#/skills').adw_id, null)
})

test('fleet cells preserve honest absence and discriminate status evidence', () => {
  assert.equal(tokenCell({ metrics: { billed_input_tokens: null }, pending: { billed_input_tokens: 'predates this measurement' } }).value, null)
  assert.equal(tokenCell({ metrics: { billed_input_tokens: 10, billed_output_tokens: 2, billed_cache_write_tokens: 3, billed_cache_read_tokens: 5 } }).value, 20)
  assert.equal(tokenCell({ metrics: { billed_input_tokens: 10, billed_output_tokens: 2, billed_cache_write_tokens: 3, billed_cache_read_tokens: 5 } }).cacheRate, 5 / 18 * 100)
  assert.equal(tokenCell({ metrics: { billed_input_tokens: 10, billed_output_tokens: 2, billed_cache_write_tokens: null, billed_cache_read_tokens: 5 } }).cacheRate, null)
})

test('paused, hidden and disposed ledger refreshes do not restart themselves', async () => {
  const { createRefreshLoop } = await import('../visualizer/web/src/lib/live.js')
  const timers = new Map()
  let next = 0, reads = 0, finish, visible = false
  const loop = createRefreshLoop(() => { reads += 1; return new Promise(resolve => { finish = resolve }) }, {
    visible: () => visible,
    setTimeout: (fn, delay) => { timers.set(++next, {fn, delay}); return next },
    clearTimeout: id => timers.delete(id),
  })
  const tick = () => { const [id, timer] = [...timers][0]; timers.delete(id); timer.fn() }
  const initial = loop.refresh()
  await Promise.resolve(); finish(); await initial
  tick(); await Promise.resolve()
  assert.equal(reads, 1, 'hidden tabs skip the scheduled read')
  assert.equal(timers.size, 1)
  loop.setEnabled(false)
  assert.equal(timers.size, 0)
  const manual = loop.refresh()
  await Promise.resolve(); finish(); await manual
  assert.equal(reads, 2, 'manual refresh remains available while auto refresh is paused')
  assert.equal(timers.size, 0)
  loop.setEnabled(true)
  visible = true
  tick(); await Promise.resolve()
  assert.equal(reads, 3)
  const running = loop.refresh()
  loop.setEnabled(false)
  finish(); await running
  assert.equal(timers.size, 0, 'pausing during a request must suppress its next timer')
  const last = loop.refresh()
  await Promise.resolve(); loop.stop(); finish(); await last
  assert.equal(timers.size, 0, 'a completed read must not resurrect a disposed loop')
  await loop.refresh()
  assert.equal(reads, 4)
})


test('the kept frontend imports nothing from crew/ or scripts/', () => {
  const found = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) { walk(path); continue }
      if (!/\.(js|mjs|svelte)$/.test(name)) continue
      const source = readFileSync(path, 'utf8')
      for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        if (!match[1].startsWith('.')) continue
        const target = join(dir, match[1]).slice(ROOT.length + 1)
        if (/^(crew|scripts)\//.test(target)) found.push(`${path.slice(ROOT.length + 1)} -> ${match[1]}`)
      }
    }
  }
  walk(join(ROOT, 'visualizer/web/src'))
  assert.deepEqual(found, [])
})
