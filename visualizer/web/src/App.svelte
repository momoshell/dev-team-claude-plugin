<script>
  import { getReturns, getSessions } from './lib/api.js'
  import { createSemaphore, deriveDisplayStatus, fleetActivity } from './lib/fleet.js'
  import { journalPulse } from './lib/live.js'
  import { formatHash, parseHash, subscribeHash } from './lib/route.js'
  import TaskList from './lib/TaskList.svelte'
  import OperationsOverview from './lib/OperationsOverview.svelte'
  import MetricsStrip from './lib/MetricsStrip.svelte'
  import CellHealthPanel from './lib/CellHealthPanel.svelte'
  import TeardownPanel from './lib/TeardownPanel.svelte'
  import RunSetPanel from './lib/RunSetPanel.svelte'
  import IntakePanel from './lib/IntakePanel.svelte'
  import RosterPanel from './lib/RosterPanel.svelte'
  import RunDetail from './lib/RunDetail.svelte'
  import Dropdown from './lib/Dropdown.svelte'

  const THEME_OPTIONS = [{ value:'ink', label:'Dark' }, { value:'paper', label:'Light' }, { value:'os', label:'System' }]

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
  let activity = $derived(fleetActivity(runs, now))
  let runIndex = $derived(new Map(runs.map((run) => [run.adw_id, run])))
  let selectedRun = $derived(route.view === 'run' || route.view === 'phase' ? runIndex.get(route.adw_id) : null)
  let attentionRows = $derived(runs.map((run) => {
    const status = deriveDisplayStatus(run, envelopes.get(run.adw_id), now)
    const why = status.why || (status.key === 'fail'
      ? 'The run recorded a failure. Inspect its terminal phase and proof.'
      : status.key === 'aborted'
        ? 'The run stopped without an acceptance verdict. Inspect its preserved execution context.'
        : status.key === 'silent' || status.key === 'unverified'
          ? status.why
          : 'Code declined to fake a result and handed the preserved context to a human.')
    return { run, status, why }
  }).filter((row) => ['escalated', 'fail', 'aborted', 'silent', 'unverified'].includes(row.status.key) && !row.run.triage?.reviewed_at))
  let attentionBreakdown = $derived({
    escalated: attentionRows.filter((row) => row.status.key === 'escalated').length,
    failed: attentionRows.filter((row) => row.status.key === 'fail').length,
    aborted: attentionRows.filter((row) => row.status.key === 'aborted').length,
    silent: attentionRows.filter((row) => row.status.key === 'silent').length,
    unverified: attentionRows.filter((row) => row.status.key === 'unverified').length,
  })
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
    <span class:degraded={feedDegraded} class:silent={!feedDegraded && !activity.live && (activity.silent || activity.unverified)} class="connection"><i></i>{feedDegraded ? 'Feed degraded' : activity.live ? `${activity.live} live` : activity.silent ? `${activity.silent} silent session${activity.silent === 1 ? '' : 's'}` : activity.unverified ? `0 live · ${activity.unverified} heartbeat unavailable` : 'Ledger ready'}</span>
    <label class="theme"><span>Theme</span><Dropdown bind:value={theme} options={THEME_OPTIONS} ariaLabel="Theme" width="5.2rem" variant="compact" /></label>
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
    <div class="page-heading"><div><p class="eyebrow">Factory control room</p><h1>Operations</h1><p>See whether work is flowing, where reliability is slipping, and which evidence needs a closer look.</p></div><span class="updated">Live operating windows · refreshed automatically</span></div>
    <OperationsOverview {runs} degraded={feedDegraded} {now} onopen={openRun} />
    <details class="ops-baseline"><summary>All-time task baseline</summary><MetricsStrip {runs} envelopes={envelopes} degraded={feedDegraded} {now} /></details>
    <div class="ops-section-heading"><div><p class="eyebrow">Subsystem evidence</p><h2>Go deeper</h2></div><p>Each readout keeps its own measurement window and clearly separates zero from unavailable.</p></div>
    <div class="ops-grid"><CellHealthPanel /><RunSetPanel /><TeardownPanel /><IntakePanel /></div>
  </main>
{:else if route.view === 'roster'}
  <main class="page">
    <div class="page-heading"><div><p class="eyebrow">Capability map</p><h1>Model roster</h1><p>Who does the work at every factory tier, and why each model has that seat.</p></div></div>
    <RosterPanel />
  </main>
{:else}
  <main class="page">
    <div class="page-heading task-heading"><div><p class="eyebrow">Work history</p><h1>Factory tasks</h1><p>Follow work in progress, inspect completed runs, and open the full execution waterfall.</p></div><span class="updated">Live ledger · refreshed automatically</span></div>
    <MetricsStrip {runs} envelopes={envelopes} degraded={feedDegraded} {now} />
    {#if error}<p class="error-banner">{error}</p>{/if}
    {#if attentionRows.length}
      <details class="attention">
        <summary><span class="attention-mark" aria-hidden="true">!</span><span class="attention-title"><strong>Needs attention</strong><small>{attentionBreakdown.escalated} escalated{attentionBreakdown.failed ? ` · ${attentionBreakdown.failed} failed` : ''}{attentionBreakdown.aborted ? ` · ${attentionBreakdown.aborted} aborted` : ''}{attentionBreakdown.silent ? ` · ${attentionBreakdown.silent} silent` : ''}{attentionBreakdown.unverified ? ` · ${attentionBreakdown.unverified} unverified` : ''}</small></span><span class="attention-total">{attentionRows.length}</span><span class="attention-action">Review queue <i aria-hidden="true"></i></span></summary>
        <div class="attention-list" aria-label="Tasks needing attention">{#each attentionRows as row (row.run.adw_id)}<button onclick={() => openRun(row.run)}><span><strong>{row.run.goal || row.run.adw_id}</strong><small>{row.status.where || row.run.repo_slug || (row.status.key === 'fail' ? 'Failed run' : row.status.key === 'aborted' ? 'Aborted run' : 'Escalated')}</small></span><span class="rail-why">{row.why}</span><span class={`rail-status ${row.status.tone}`}>{row.status.word}</span><b>Open →</b></button>{/each}</div>
      </details>
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
.tools { justify-self:end; display:flex; align-items:center; gap:.8rem; }.connection { display:inline-flex; align-items:center; gap:.4rem; color:var(--muted); font-size:.7rem; white-space:nowrap; }.connection i { width:.45rem; height:.45rem; border-radius:50%; background:var(--status-ok); box-shadow:0 0 8px var(--status-ok); }.connection.degraded,.connection.silent { color:var(--status-escalated); }.connection.degraded i,.connection.silent i { background:var(--status-escalated); box-shadow:none; }
.theme { display:flex; align-items:center; gap:.35rem; }.theme > span { position:absolute; width:1px; height:1px; overflow:hidden; }
.page { position:relative; width:min(1440px,100%); margin:auto; padding:2rem 1.25rem 4rem; }.page-heading { display:flex; justify-content:space-between; align-items:end; gap:1rem; margin-bottom:1rem; }.page-heading h1 { margin:.1rem 0 .35rem; font-size:clamp(1.7rem,3vw,2.35rem); letter-spacing:-.04em; }.page-heading p { margin:0; color:var(--muted); max-width:44rem; font-size:.9rem; }.page-heading .eyebrow { color:var(--accent); font-size:.66rem; font-weight:700; letter-spacing:.14em; text-transform:uppercase; }.updated { color:var(--muted); font-size:.7rem; padding-bottom:.35rem; white-space:nowrap; }
.ops-grid { display:grid; gap:1rem; grid-template-columns:repeat(2,minmax(0,1fr)); }
.ops-section-heading { display:flex; align-items:end; justify-content:space-between; gap:1rem; margin:2rem 0 .8rem; }.ops-section-heading h2 { margin:.12rem 0 0; font-size:1.15rem; }.ops-section-heading p { max-width:34rem; margin:0; color:var(--muted); font-size:.7rem; text-align:right; }
.ops-baseline { border:1px solid var(--line); border-radius:var(--radius); background:color-mix(in srgb,var(--panel) 85%,transparent); padding:.7rem .8rem .15rem; }.ops-baseline summary { width:max-content; color:var(--muted); cursor:pointer; font-size:.65rem; }
.error-banner { border:1px solid color-mix(in srgb,var(--status-fail) 45%,var(--line)); background:color-mix(in srgb,var(--status-fail) 8%,var(--panel)); color:var(--status-fail); border-radius:var(--radius); padding:.8rem 1rem; }
.attention { overflow:hidden; margin:0 0 1rem; border:1px solid color-mix(in srgb,var(--status-escalated) 42%,var(--line)); border-radius:var(--radius); background:color-mix(in srgb,var(--status-escalated) 5%,var(--panel)); }.attention summary { display:grid; grid-template-columns:auto minmax(0,1fr) auto auto; align-items:center; gap:.7rem; min-height:3.35rem; padding:.6rem .8rem; cursor:pointer; list-style:none; }.attention summary::-webkit-details-marker { display:none; }.attention summary:hover { background:color-mix(in srgb,var(--status-escalated) 5%,transparent); }.attention-mark { width:1.8rem; height:1.8rem; display:grid; place-items:center; border-radius:50%; background:color-mix(in srgb,var(--status-escalated) 12%,var(--panel-raised)); color:var(--status-escalated); font:700 .75rem var(--mono); }.attention-title { min-width:0; display:grid; gap:.12rem; }.attention-title strong { font-size:.72rem; }.attention-title small { color:var(--muted); font-size:.6rem; }.attention-total { min-width:1.8rem; height:1.55rem; display:grid; place-items:center; border:1px solid color-mix(in srgb,var(--status-escalated) 35%,var(--line)); border-radius:2rem; color:var(--status-escalated); font:650 .62rem var(--mono); }.attention-action { display:flex; align-items:center; gap:.5rem; color:var(--status-escalated); font-size:.62rem; white-space:nowrap; }.attention-action i { width:.45rem; height:.45rem; border-right:1px solid currentColor; border-bottom:1px solid currentColor; transform:rotate(45deg) translateY(-2px); transition:transform .16s ease; }.attention[open] .attention-action i { transform:rotate(225deg) translate(-1px,-1px); }.attention-list { border-top:1px solid color-mix(in srgb,var(--status-escalated) 25%,var(--line)); }.attention button { width:100%; display:grid; grid-template-columns:minmax(12rem,1fr) minmax(16rem,2fr) auto auto; align-items:center; gap:1rem; border:0; border-top:1px solid color-mix(in srgb,var(--status-escalated) 18%,var(--line)); background:transparent; padding:.7rem .8rem; text-align:left; cursor:pointer; }.attention button:first-child { border-top:0; }.attention button:hover { background:color-mix(in srgb,var(--status-escalated) 6%,transparent); }.attention button > span:first-child { min-width:0; display:grid; gap:.15rem; }.attention button strong { overflow:hidden; font-size:.75rem; text-overflow:ellipsis; white-space:nowrap; }.attention button small,.rail-why { color:var(--muted); font-size:.62rem; }.rail-status { border:1px solid currentColor; border-radius:2rem; padding:.2rem .4rem; font-size:.55rem; white-space:nowrap; }.rail-status.serious { color:var(--status-escalated); }.rail-status.fail { color:var(--status-fail); }.rail-status.aborted { color:var(--status-running); }.attention button b { color:var(--status-escalated); font-size:.62rem; white-space:nowrap; }
.empty-state { max-width:34rem; margin:8vh auto; text-align:center; }.empty-state > span { font:4rem/1 var(--mono); color:var(--line); }.empty-state h1 { margin:.8rem 0 .4rem; }.empty-state p { color:var(--muted); }.empty-state button { border:1px solid var(--accent); border-radius:var(--radius-sm); background:var(--accent); color:var(--bg); padding:.55rem .8rem; cursor:pointer; }
@media (max-width: 900px) { .topbar { grid-template-columns:1fr auto; }.topbar nav { grid-row:2; grid-column:1/-1; justify-self:stretch; justify-content:center; }.tools .connection { display:none; }.ops-grid { grid-template-columns:1fr; } }
@media (max-width: 760px) { .attention button { grid-template-columns:minmax(0,1fr) auto; }.attention .rail-why { grid-column:1/-1; grid-row:2; }.rail-status { grid-column:2; grid-row:1; }.attention button b { display:none; } }
@media (max-width: 620px) { .page { padding:1.4rem .75rem 3rem; }.brand small,.theme { display:none; }.topbar { padding:.55rem .75rem; }.page-heading,.ops-section-heading { align-items:start; }.ops-section-heading > p { display:none; }.updated { display:none; } nav button { flex:1; }.attention-action { font-size:0; }.attention-action i { margin-right:.15rem; } }
</style>
