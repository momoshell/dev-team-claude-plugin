import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseHash, formatHash } from '../visualizer/web/src/lib/route.js'
import { configurationDimensionCell, configurationFilterView, needsAttention, taskBoard, tokenCell } from '../visualizer/web/src/lib/fleet.js'
import { assuranceMeta, executionMeta, taskProfileMeta } from '../visualizer/web/src/lib/workflow-semantics.js'
import { ROOT } from './helpers.mjs'
import { transportLabel } from '../visualizer/web/src/lib/agent-settings.js'

test('D9 the agent editor carries no model picker and agent-settings exports no model helpers', async () => {
  const page = readFileSync(join(ROOT, 'visualizer/web/src/lib/AgentsPage.svelte'), 'utf8')
  assert.doesNotMatch(page, /modelsError|model-settings|setModelPreference|chooseModel/)
  const settings = await import('../visualizer/web/src/lib/agent-settings.js')
  assert.equal('modelPreference' in settings, false)
  assert.equal('setModelPreference' in settings, false)
})

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

test('TK1 tokenCell keeps a lean row\'s closed tokens reason', () => {
  const reason = 'lean seat recordings are not counted'
  const cell = tokenCell({ source: 'lean', pending: { tokens: reason } })
  assert.equal(cell.text, reason); assert.equal(cell.title, reason)
})

test('workflow semantics separate profile, execution and assurance without inference', () => {
  assert.equal(assuranceMeta('mechanical').label, 'Quick')
  assert.equal(assuranceMeta('judge').label, 'Rigorous')
  assert.equal(assuranceMeta('standard').alias, 'build')
  assert.equal(executionMeta('scout').label, 'Scout')
  assert.equal(taskProfileMeta(null).label, 'Not recorded')
  assert.match(taskProfileMeta(null).summary, /does not infer/)
})

function configurationFixture() {
  const historical = { adw_id: 'historical', tier: 'build', variant: 'full', task_profile: null, execution_shape: null, assurance: null }
  const measured = { adw_id: 'measured', task_profile: 'implementation', execution_shape: 'full', assurance: 'standard' }
  const other = { adw_id: 'other', task_profile: 'audit', execution_shape: 'scout', assurance: 'rigorous' }
  const colliding = { adw_id: 'colliding', task_profile: 'Not recorded', execution_shape: 'directed', assurance: 'quick' }
  return { historical, measured, other, colliding, rows: [historical, measured, other, colliding] }
}

test('A1 hides configuration filters when all dimensions are absent', () => {
  const { historical } = configurationFixture()
  assert.deepEqual(configurationFilterView([historical]).dimensions, [])
})

test('B1 exposes measured configuration dimensions and options', () => {
  const { rows } = configurationFixture()
  const view = configurationFilterView(rows)
  assert.deepEqual(view.dimensions.map((dimension) => dimension.key), ['task_profile', 'execution_shape', 'assurance'])
  assert.ok(view.dimensions.every((dimension) => dimension.options.length > 0))
  assert.ok(view.dimensions.every((dimension) => dimension.options.every((option) => option.value !== null)))
})

test('C1 marks missing configuration without inferring legacy fields', () => {
  const { historical } = configurationFixture()
  const marks = ['task_profile', 'execution_shape', 'assurance'].map((dimension) => configurationDimensionCell(historical, dimension))
  assert.ok(marks.every((mark) => mark.value === null && mark.text === 'Not recorded' && mark.dashed === true))
  assert.notEqual(marks[0].text, historical.tier)
  assert.notEqual(marks[1].text, historical.variant)
  assert.notEqual(marks[2].text, 'Standard')
})

test('D1 distinguishes missing configuration from a matching literal value', () => {
  const { historical, colliding } = configurationFixture()
  const absent = configurationDimensionCell(historical, 'task_profile')
  const real = configurationDimensionCell(colliding, 'task_profile')
  assert.equal(absent.value, null)
  assert.equal(absent.dashed, true)
  assert.equal(real.value, 'Not recorded')
  assert.equal(real.dashed, false)
  assert.notDeepEqual({ value: absent.value, dashed: absent.dashed }, { value: real.value, dashed: real.dashed })
})

test('E1 preserves unrecorded rows while filtering measured configuration', () => {
  const { historical, measured, other } = configurationFixture()
  const view = configurationFilterView([historical, measured, other], { task_profile: 'implementation' })
  assert.deepEqual(view.rows.map((row) => row.adw_id), ['historical', 'measured'])
  assert.equal(view.excluded.count, 1)
  assert.equal(view.excluded.line, '1 measured row excluded by configuration filters · not-recorded rows remain visible')
})

test('F1 lists only measured configuration options', () => {
  const { measured, colliding } = configurationFixture()
  const view = configurationFilterView([measured, colliding])
  const options = (key) => view.dimensions.find((dimension) => dimension.key === key).options.map((option) => option.value)
  assert.deepEqual(options('task_profile'), ['Not recorded', 'implementation'])
  assert.deepEqual(options('execution_shape'), ['directed', 'full'])
  assert.deepEqual(options('assurance'), ['quick', 'standard'])
  assert.doesNotMatch(JSON.stringify(view), /audit|scout|rigorous/)
})

test('G1 task list uses configuration cells filters and exclusion text', () => {
  const source = readFileSync(join(ROOT, 'visualizer/web/src/lib/TaskList.svelte'), 'utf8')
  assert.match(source, /import \{[^}]*configurationDimensionCell[^}]*configurationFilterView[^}]*\} from '\.\/fleet\.js'/)
  assert.match(source, /let baseRows = \$derived\(/)
  assert.match(source, /configurationFilterView\(baseRows,/)
  for (const dimension of ['task_profile', 'execution_shape', 'assurance']) assert.match(source, new RegExp(`configurationDimensionCell\\(run, '${dimension}'\\)`))
  assert.match(source, /configurationView\.excluded\.line/)
  assert.doesNotMatch(source, /runConfiguration|run\.tier|run\.variant|configuration\.legacy_(?:tier|variant)/)
})

test('the board no longer probes task envelopes: lean lanes carry their status in the journal row', () => {
  const app = readFileSync(join(ROOT, 'visualizer/web/src/App.svelte'), 'utf8')
  for (const gone of ['probeEnvelopes', 'envelopeCache', 'envelopeQueued', 'getReturns', 'escalationProbeTargets']) assert.equal(app.includes(gone), false, gone)
  assert.doesNotMatch(app, /const envelopes/)
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

test('E1 agents page route nav and title are wired', () => {
  const root = join(ROOT, 'visualizer/web/src')
  const app = readFileSync(join(root, 'App.svelte'), 'utf8')
  const page = readFileSync(join(root, 'lib/AgentsPage.svelte'), 'utf8')
  assert.match(app, /route\.view === 'agents'/)
  assert.match(app, /Agents · Factory/)
  assert.match(app, /<AgentsPage\s*\/?\s*>/)
  assert.match(app, /route\.view === 'agents'[^\n]*>Agents</)
  assert.match(page, /aria-label="Agent library"/)
})

test('skills-page:D1', () => {
  const root = join(ROOT, 'visualizer/web/src')
  const app = readFileSync(join(root, 'App.svelte'), 'utf8')
  const page = readFileSync(join(root, 'lib/SkillsPage.svelte'), 'utf8')
  assert.equal(formatHash(parseHash('#/skills')), '#/skills')
  assert.ok(app.includes("import SkillsPage from './lib/SkillsPage.svelte'"))
  assert.ok(app.includes('Skills · Factory'))
  assert.ok(app.includes("route.view === 'skills'"))
  assert.ok(app.includes('<SkillsPage />'))
  assert.match(app, />Skills<\//)
  assert.ok(page.includes('onsubmit={save}'))
  assert.match(page, /saveSkillFile\(\{name,text,expected_revision:editor.revision\}\)/)
  assert.ok(page.includes('Selection rules'))
  assert.ok(page.includes('Discard your unsaved skill changes?'))
  assert.doesNotMatch(page, /proposeSkills|Proposal only/)
  assert.doesNotMatch(page, /#[0-9a-f]{3,8}\b|rgb\(|--(?:ink|paper|spot|serious)/i)
})

test('F1 agents page uses only Tier-2 colour aliases', () => {
  const source = readFileSync(join(ROOT, 'visualizer/web/src/lib/AgentsPage.svelte'), 'utf8')
  const css = source.match(/<style>([\s\S]*?)<\/style>/)?.[1] || ''
  const declarations = [...css.matchAll(/(?:^|[;{}])\s*[-a-z]+\s*:\s*([^;{}]+)/g)].map((match) => match[1].trim())
  assert.equal(css.includes('data-theme'), false)
  assert.equal(declarations.some((value) => /#[0-9a-f]{3,8}\b/i.test(value)), false)
  assert.equal(declarations.some((value) => /(?:^|\s)(?:white|black|red|blue|green|gray|grey)(?:\s|$)/i.test(value)), false)
  assert.equal(declarations.some((value) => /--(?:ink|paper|spot|serious|status-\w+-raw|role-\w+-(?:dark|light))/.test(value)), false)
  assert.ok(source.includes('background:var(--panel); border:1px solid var(--line);'))
  for (const token of ['Create agent', 'Use a copy', 'Save agent']) assert.ok(source.includes(token), token)
  for (const tab of ['Project library', 'Available on system']) assert.ok(source.includes(tab), tab); assert.doesNotMatch(source, /Skill delivery|skills-panel/); const skillsPage = readFileSync(join(ROOT, 'visualizer/web/src/lib/SkillDelivery.svelte'), 'utf8'); assert.match(skillsPage, /Skill delivery/); assert.match(skillsPage, /<th>Skill<\/th><th>Last recorded delivery<\/th>/); assert.match(skillsPage, /cell\?\.last_seat_delivery === true/)
})

test('fleet cells preserve honest absence and discriminate status evidence', () => {
  assert.equal(tokenCell({ metrics: { billed_input_tokens: null }, pending: { billed_input_tokens: 'predates this measurement' } }).value, null)
  assert.equal(tokenCell({ metrics: { billed_input_tokens: 10, billed_output_tokens: 2, billed_cache_write_tokens: 3, billed_cache_read_tokens: 5 } }).value, 20)
  assert.equal(tokenCell({ metrics: { billed_input_tokens: 10, billed_output_tokens: 2, billed_cache_write_tokens: 3, billed_cache_read_tokens: 5 } }).cacheRate, 5 / 18 * 100)
  assert.equal(tokenCell({ metrics: { billed_input_tokens: 10, billed_output_tokens: 2, billed_cache_write_tokens: null, billed_cache_read_tokens: 5 } }).cacheRate, null)
})

test('role colour stays isolated and escalation reasons remain in task history', () => {
  const root = join(ROOT, 'visualizer/web/src')
  const app = readFileSync(join(root, 'App.svelte'), 'utf8')
  assert.doesNotMatch(app, /--role-|--lane-\d/)
  assert.match(app, /taskBoard\(runs, \{ state: 'attention' \}\)/)
  const tasks = readFileSync(join(root, 'lib/TaskList.svelte'), 'utf8')
  assert.match(tasks, /Why review\?/)
  assert.match(tasks, /status\.why/)
  assert.doesNotMatch(app, /class="attention-list"/)
  assert.doesNotMatch(app, /getReturns|probeEnvelopes|returnRequestSemaphore/)
})

test('A1: every visualizer consumer uses the shared attention classifier', () => {
  const app = readFileSync(join(ROOT, 'visualizer/web/src/App.svelte'), 'utf8')
  const taskList = readFileSync(join(ROOT, 'visualizer/web/src/lib/TaskList.svelte'), 'utf8')
  assert.match(app, /taskBoard\(runs, \{ state: 'attention' \}\)/)
  assert.match(app, /attentionBreakdown\(attentionRows\)/)
  assert.match(taskList, /taskBoard\(runs,/)
})

test('C1: every current attention key routes the metric click to attention', () => {
  const app = readFileSync(join(ROOT, 'visualizer/web/src/App.svelte'), 'utf8')
  assert.match(app, /taskFocus = \{ state: 'attention'/)
})

test('G1: a key outside the attention vocabulary is not attention work', () => {
  assert.equal(needsAttention('outside-attention-vocabulary'), false)
})

test('ledger refresh waits after completion, coalesces clicks and resets its pause', async () => {
  const { createRefreshLoop } = await import('../visualizer/web/src/lib/live.js')
  const timers = new Map()
  let next = 0, reads = 0, finish
  const loop = createRefreshLoop(() => { reads += 1; return new Promise(resolve => { finish = resolve }) }, {
    setTimeout: (fn, delay) => { timers.set(++next, {fn, delay}); return next },
    clearTimeout: id => timers.delete(id),
  })
  const first = loop.refresh()
  await Promise.resolve()
  assert.equal(reads, 1)
  assert.equal(loop.refresh(), first)
  assert.equal(timers.size, 0, 'a slow read must never have a periodic timer alongside it')
  finish()
  await first
  assert.deepEqual([...timers.values()].map(t => t.delay), [30000])
  const manual = loop.refresh()
  await Promise.resolve()
  assert.equal(timers.size, 0, 'manual refresh cancels the old scheduled read')
  assert.equal(reads, 2)
  finish()
  await manual
  assert.deepEqual([...timers.values()].map(t => t.delay), [30000])
  loop.stop()
  assert.equal(timers.size, 0)
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


// Reversing an edit must remove the pending move, not keep a no-op ready to apply.
test('visualizer architecture keeps legacy Svelte syntax out of every component', () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? (entry.name === 'node_modules' || entry.name === 'dist' ? [] : walk(join(dir, entry.name))) : [join(dir, entry.name)])
  const files = walk(join(ROOT, 'visualizer'))
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const relative = file.replace(`${ROOT}/`, '')
    if (file.endsWith('.svelte')) {
      assert.doesNotMatch(source, /^\s*export\s+let\s/m, relative)
      assert.doesNotMatch(source, /^\s*\$:\s/m, relative)
    }
  }
  assert.ok(files.some((file) => file.endsWith('.svelte')))
})

test('theme role and lane aliases follow the ratified role order', () => {
  const css = readFileSync(join(ROOT, 'visualizer/web/src/lib/theme.css'), 'utf8')
  for (const [index, role] of ['planner', 'builder', 'reviewer', 'tech-lead', 'lead', 'driver'].entries()) {
    assert.match(css, new RegExp(`--role-${role}\\s*:`))
    assert.match(css, new RegExp(`--lane-${index}\\s*:\\s*var\\(\\s*--role-${role}\\s*\\)`))
  }
})

test('theme gives component scrollbars a thin theme-aware treatment', () => {
  const css = readFileSync(join(ROOT, 'visualizer/web/src/lib/theme.css'), 'utf8')
  assert.match(css, /--scrollbar-track\s*:/)
  assert.match(css, /--scrollbar-thumb\s*:/)
  assert.match(css, /scrollbar-width:\s*thin/)
  assert.match(css, /scrollbar-color:\s*var\(--scrollbar-thumb\) var\(--scrollbar-track\)/)
  assert.match(css, /\*::\-webkit-scrollbar\s*\{[^}]*width:\s*\.625rem[^}]*height:\s*\.625rem/)
  assert.match(css, /\*::\-webkit-scrollbar-thumb:hover\s*\{[^}]*var\(--scrollbar-thumb-hover\)/)
  assert.match(css, /:root\[data-theme='ink'\]\s*\{\s*color-scheme:\s*dark/)
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

// MUTATION: count shipped without the measured guard and a lean board reads "Shipped 0".
test('newestFirst lists the latest started_at first and unstarted runs last in feed order', () => {
  const rows = [
    { adw_id: 'a', started_at: null },
    { adw_id: 'b', started_at: '2026-11-01T20:44:19.652Z' },
    { adw_id: 'c', started_at: 'not a date' },
    { adw_id: 'd', started_at: '2026-11-02T16:25:24.265Z' },
    { adw_id: 'e', started_at: '2026-11-02T16:25:24.265Z' },
  ]
  assert.deepEqual(taskBoard(rows).rows.map((run) => run.adw_id), ['d', 'e', 'b', 'a', 'c'])
  assert.deepEqual(rows.map((run) => run.adw_id), ['a', 'b', 'c', 'd', 'e'])
})
