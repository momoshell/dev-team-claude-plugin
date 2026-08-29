<script>
  import { getReturns, getSessions } from './lib/api.js'
  import { createSemaphore, deriveStatus } from './lib/fleet.js'
  import { journalPulse } from './lib/live.js'
  import { formatHash, parseHash, subscribeHash } from './lib/route.js'
  import TaskList from './lib/TaskList.svelte'
  import MetricsStrip from './lib/MetricsStrip.svelte'
  import CellHealthPanel from './lib/CellHealthPanel.svelte'
  import TeardownPanel from './lib/TeardownPanel.svelte'
  import RunSetPanel from './lib/RunSetPanel.svelte'
  import IntakePanel from './lib/IntakePanel.svelte'
  import RosterPanel from './lib/RosterPanel.svelte'
  import RunDetail from './lib/RunDetail.svelte'

  let route = $state(parseHash(location.hash))
  let themeValue = 'ink'
  try { themeValue = localStorage.getItem('dt-theme') || 'ink' } catch {}
  let theme = $state(themeValue)
  let runs = $state([])
  let envelopes = $state(new Map())
  let feedDegraded = $state(false)
  let error = $state('')
  let now = $state(Date.now())
  let refreshGeneration = 0
  const returnRequestSemaphore = createSemaphore(6)
  const envelopeCache = new Map()
  const envelopeRuns = new Map()
  const envelopeQueue = []
  const envelopeQueued = new Set()
  let envelopeWorkers = 0

  let anyRunning = $derived(runs.some((run) => run.running))
  let runIndex = $derived(new Map(runs.map((run) => [run.adw_id, run])))
  let selectedRun = $derived(route.view === 'run' || route.view === 'phase' ? runIndex.get(route.adw_id) : null)
  let attentionRows = $derived(runs.map((run) => {
    const status = deriveStatus(run, envelopes.get(run.adw_id))
    return { run, status, why: status.why || 'This task needs a human decision.' }
  }).filter((row) => row.status.key === 'escalated'))
  let pageTitle = $derived(selectedRun ? `${selectedRun.goal || 'Task'} · Factory` : route.view === 'roster' ? 'Roster · Factory' : route.view === 'ops' ? 'Operations · Factory' : 'Tasks · Factory')

  $effect(() => subscribeHash((next) => route = next))
  $effect(() => {
    if (typeof document === 'undefined') return
    if (theme === 'ink' || theme === 'paper') document.documentElement.dataset.theme = theme
    else delete document.documentElement.dataset.theme
    try { localStorage.setItem('dt-theme', theme) } catch {}
  })

  async function fetchEnvelope(id) {
    try {
      const run = envelopeRuns.get(id)
      if (!run) return
      const result = await returnRequestSemaphore.run(() => getReturns(run.repo_slug, run.goal, run.adw_id))
      if (result?.task && typeof result.task === 'object') {
        envelopeCache.set(id, result.task)
        envelopes = new Map(envelopeCache)
      }
    } catch {} finally {
      envelopeQueued.delete(id)
      envelopeWorkers -= 1
      queueMicrotask(drainEnvelopeQueue)
    }
  }

  function drainEnvelopeQueue() {
    while (envelopeWorkers < 6 && envelopeQueue.length) {
      const id = envelopeQueue.shift()
      envelopeWorkers += 1
      void fetchEnvelope(id)
    }
  }

  function probeEnvelopes(nextRuns) {
    envelopeRuns.clear()
    for (const run of Array.isArray(nextRuns) ? nextRuns : []) {
      const id = run?.adw_id
      if (!run?.repo_slug || !(run?.goal ?? run?.task_slug) || id == null) continue
      envelopeRuns.set(id, run)
      if (envelopeCache.has(id) || envelopeQueued.has(id)) continue
      envelopeQueued.add(id)
      envelopeQueue.push(id)
    }
    drainEnvelopeQueue()
  }

  async function refresh() {
    const generation = ++refreshGeneration
    try {
      const result = await getSessions()
      if (generation !== refreshGeneration) return
      const nextRuns = Array.isArray(result?.runs) ? result.runs : []
      runs = nextRuns
      feedDegraded = result?.degraded === true
      now = Date.now()
      error = ''
      probeEnvelopes(nextRuns)
      journalPulse.pulse()
    } catch (err) {
      if (generation === refreshGeneration) {
        error = err.message || 'session request failed'
        feedDegraded = true
      }
    }
  }

  $effect(() => {
    void refresh()
    const timer = anyRunning ? setInterval(refresh, 3000) : null
    return () => { if (timer) clearInterval(timer) }
  })

  function navigate(next) { location.hash = formatHash(next) }
  function openRun(run) { navigate({ view: 'run', adw_id: run.adw_id }) }
  function openPhase(name) { if (selectedRun) navigate({ view: 'phase', adw_id: selectedRun.adw_id, phase: name }) }
  function backToTasks() { navigate({ view: 'fleet' }) }
</script>

<svelte:head><title>{pageTitle}</title><meta name="description" content="Factory task execution, model roster, and operational health." /></svelte:head>

<header class="topbar">
  <a class="brand" href="#/" aria-label="Factory tasks">
    <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
    <span><strong>Factory</strong><small>developer operations</small></span>
  </a>
  <nav aria-label="Primary navigation">
    <button class:active={route.view === 'fleet' || route.view === 'run' || route.view === 'phase'} onclick={() => navigate({ view: 'fleet' })}>Tasks</button>
    <button class:active={route.view === 'roster'} onclick={() => navigate({ view: 'roster' })}>Roster</button>
    <button class:active={route.view === 'ops'} onclick={() => navigate({ view: 'ops' })}>Operations</button>
  </nav>
  <div class="tools">
    <span class:degraded={feedDegraded} class="connection"><i></i>{feedDegraded ? 'Feed degraded' : anyRunning ? `${runs.filter((run) => run.running).length} live` : 'Ledger ready'}</span>
    <label class="theme"><span>Theme</span><select bind:value={theme} aria-label="Theme"><option value="ink">Dark</option><option value="paper">Light</option><option value="os">System</option></select></label>
  </div>
</header>

{#if route.view === 'run' || route.view === 'phase'}
  {#if selectedRun}
    <RunDetail run={selectedRun} phase={route.phase} onback={backToTasks} onphase={openPhase} />
  {:else}
    <main class="page"><section class="empty-state"><span>404</span><h1>Task not found</h1><p>The ledger no longer contains this run, or the URL is incomplete.</p><button onclick={backToTasks}>Return to tasks</button></section></main>
  {/if}
{:else if route.view === 'ops'}
  <main class="page">
    <div class="page-heading"><div><p class="eyebrow">System health</p><h1>Operations</h1><p>Factory throughput, intake controls, and failure signals.</p></div></div>
    <MetricsStrip {runs} envelopes={envelopes} degraded={feedDegraded} />
    <div class="ops-grid"><CellHealthPanel /><TeardownPanel /><IntakePanel /><RunSetPanel /></div>
  </main>
{:else if route.view === 'roster'}
  <main class="page">
    <div class="page-heading"><div><p class="eyebrow">Capability map</p><h1>Model roster</h1><p>Who does the work at every factory tier, and why each model has that seat.</p></div></div>
    <RosterPanel />
  </main>
{:else}
  <main class="page">
    <div class="page-heading task-heading"><div><p class="eyebrow">Work history</p><h1>Factory tasks</h1><p>Follow work in progress, inspect completed runs, and open the full execution waterfall.</p></div><span class="updated">Live ledger · refreshed automatically</span></div>
    <MetricsStrip {runs} envelopes={envelopes} degraded={feedDegraded} />
    {#if error}<p class="error-banner">{error}</p>{/if}
    {#if attentionRows.length}
      <section class="attention" aria-label="Tasks needing attention"><header><span>Needs attention</span><strong>{attentionRows.length}</strong></header>{#each attentionRows as row (row.run.adw_id)}<button onclick={() => openRun(row.run)}><span><strong>{row.run.goal || row.run.adw_id}</strong><small>{row.status.where || row.run.repo_slug || 'Escalated'}</small></span><span class="rail-why">{row.why}</span><b>Open →</b></button>{/each}</section>
    {/if}
    <TaskList {runs} {envelopes} {now} onopen={openRun} />
  </main>
{/if}

<style>
:global(*) { box-sizing:border-box; }
.topbar { position:sticky; top:0; z-index:20; display:grid; grid-template-columns:minmax(13rem,1fr) auto minmax(13rem,1fr); align-items:center; gap:1rem; min-height:4.25rem; border-bottom:1px solid color-mix(in srgb,var(--line) 85%,transparent); padding:.6rem max(1rem,calc((100vw - 1440px)/2)); background:color-mix(in srgb,var(--bg) 88%,transparent); backdrop-filter:blur(18px); }
.brand { display:flex; align-items:center; gap:.7rem; color:inherit; text-decoration:none; width:max-content; }.brand > span:last-child { display:grid; }.brand strong { font-size:.92rem; letter-spacing:.01em; }.brand small { color:var(--muted); font-size:.62rem; text-transform:uppercase; letter-spacing:.1em; margin-top:.1rem; }
.brand-mark { display:grid; gap:3px; width:1.45rem; transform:skewX(-10deg); }.brand-mark i { display:block; height:4px; border-radius:1rem; }.brand-mark i:nth-child(1) { width:65%; background:var(--tech-lead-color); }.brand-mark i:nth-child(2) { width:100%; background:var(--planner-color); }.brand-mark i:nth-child(3) { width:48%; margin-left:25%; background:var(--builder-color); }
nav { justify-self:center; display:flex; gap:.3rem; padding:.25rem; border:1px solid var(--line); border-radius:.65rem; background:color-mix(in srgb,var(--panel) 85%,transparent); }
nav button { position:relative; border:0; border-radius:.45rem; background:transparent; color:var(--muted); padding:.45rem .8rem; font-size:.78rem; cursor:pointer; } nav button.active { color:inherit; background:var(--panel-raised); box-shadow:0 1px 6px rgba(0,0,0,.15); }
.tools { justify-self:end; display:flex; align-items:center; gap:.8rem; }.connection { display:inline-flex; align-items:center; gap:.4rem; color:var(--muted); font-size:.7rem; white-space:nowrap; }.connection i { width:.45rem; height:.45rem; border-radius:50%; background:var(--status-ok); box-shadow:0 0 8px var(--status-ok); }.connection.degraded { color:var(--status-escalated); }.connection.degraded i { background:var(--status-escalated); box-shadow:none; }
.theme { display:flex; align-items:center; gap:.35rem; }.theme span { position:absolute; width:1px; height:1px; overflow:hidden; }.theme select { min-height:2rem; border:1px solid var(--line); border-radius:.45rem; background:var(--panel); color:var(--muted); padding:0 .45rem; font-size:.7rem; }
.page { position:relative; width:min(1440px,100%); margin:auto; padding:2rem 1.25rem 4rem; }.page-heading { display:flex; justify-content:space-between; align-items:end; gap:1rem; margin-bottom:1rem; }.page-heading h1 { margin:.1rem 0 .35rem; font-size:clamp(1.7rem,3vw,2.35rem); letter-spacing:-.04em; }.page-heading p { margin:0; color:var(--muted); max-width:44rem; font-size:.9rem; }.page-heading .eyebrow { color:var(--accent); font-size:.66rem; font-weight:700; letter-spacing:.14em; text-transform:uppercase; }.updated { color:var(--muted); font-size:.7rem; padding-bottom:.35rem; white-space:nowrap; }
.ops-grid { display:grid; gap:1rem; grid-template-columns:repeat(2,minmax(0,1fr)); }
.error-banner { border:1px solid color-mix(in srgb,var(--status-fail) 45%,var(--line)); background:color-mix(in srgb,var(--status-fail) 8%,var(--panel)); color:var(--status-fail); border-radius:var(--radius); padding:.8rem 1rem; }
.attention { overflow:hidden; margin:0 0 1rem; border:1px solid color-mix(in srgb,var(--status-escalated) 45%,var(--line)); border-radius:var(--radius); background:color-mix(in srgb,var(--status-escalated) 6%,var(--panel)); }.attention header { display:flex; gap:.45rem; padding:.65rem .8rem; color:var(--status-escalated); font-size:.68rem; text-transform:uppercase; letter-spacing:.08em; }.attention header strong { font-family:var(--mono); }.attention button { width:100%; display:grid; grid-template-columns:minmax(12rem,1fr) minmax(16rem,2fr) auto; align-items:center; gap:1rem; border:0; border-top:1px solid color-mix(in srgb,var(--status-escalated) 25%,var(--line)); background:transparent; padding:.7rem .8rem; text-align:left; cursor:pointer; }.attention button > span:first-child { display:grid; gap:.15rem; }.attention button strong { font-size:.75rem; }.attention button small,.rail-why { color:var(--muted); font-size:.66rem; }.attention button b { color:var(--status-escalated); font-size:.67rem; }
.empty-state { max-width:34rem; margin:8vh auto; text-align:center; }.empty-state > span { font:4rem/1 var(--mono); color:var(--line); }.empty-state h1 { margin:.8rem 0 .4rem; }.empty-state p { color:var(--muted); }.empty-state button { border:1px solid var(--accent); border-radius:var(--radius-sm); background:var(--accent); color:var(--bg); padding:.55rem .8rem; cursor:pointer; }
@media (max-width: 900px) { .topbar { grid-template-columns:1fr auto; }.topbar nav { grid-row:2; grid-column:1/-1; justify-self:stretch; justify-content:center; }.tools .connection { display:none; }.ops-grid { grid-template-columns:1fr; } }
@media (max-width: 620px) { .page { padding:1.4rem .75rem 3rem; }.brand small,.theme { display:none; }.topbar { padding:.55rem .75rem; }.page-heading { align-items:start; }.updated { display:none; } nav button { flex:1; } }
</style>
