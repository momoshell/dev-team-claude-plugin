<script>
  import { getReturns, getSessions } from './lib/api.js'
  import { DEFAULT_FILTERS, createSemaphore, escalationProbeTargets, fleetView } from './lib/fleet.js'
  import { formatHash, parseHash, subscribeHash } from './lib/route.js'
  import Filters from './lib/Filters.svelte'
  import FleetTable from './lib/FleetTable.svelte'
  import RunCard from './lib/RunCard.svelte'
  import MetricsStrip from './lib/MetricsStrip.svelte'
  import CellHealthPanel from './lib/CellHealthPanel.svelte'
  import RunSetPanel from './lib/RunSetPanel.svelte'
  import IntakePanel from './lib/IntakePanel.svelte'
  import RosterPanel from './lib/RosterPanel.svelte'
  import RosterEditor from './lib/RosterEditor.svelte'
  import RunDetail from './lib/RunDetail.svelte'

  let route = $state(parseHash(location.hash))
  let view = $state('table')
  let themeValue = 'os'
  try { themeValue = localStorage.getItem('dt-theme') || 'os' } catch {}
  let theme = $state(themeValue)
  let runs = $state([])
  let envelopes = $state(new Map())
  let filters = $state({ mode: '', status: '', since: '', until: '' })
  let viewFilters = $state({ ...DEFAULT_FILTERS })
  let error = $state('')
  let now = $state(Date.now())
  let refreshGeneration = 0
  const returnRequestSemaphore = createSemaphore(6)

  let anyRunning = $derived(runs.some((run) => run.running))
  let fleet = $derived(fleetView(runs, { envelopes, now, filters: viewFilters }))
  let runIndex = $derived(new Map(runs.map((run) => [run.adw_id, run])))
  let visibleRuns = $derived(fleet.rows.map((row) => runIndex.get(row.adw_id)).filter(Boolean))
  let selectedRun = $derived(route.view === 'run' || route.view === 'phase' ? runIndex.get(route.adw_id) : null)
  let pageTitle = $derived(selectedRun ? `${selectedRun.goal || 'Run'} · Factory visualizer` : 'Factory runs')

  $effect(() => subscribeHash((next) => route = next))

  $effect(() => {
    if (typeof document === 'undefined') return
    if (theme === 'ink' || theme === 'paper') document.documentElement.dataset.theme = theme
    else delete document.documentElement.dataset.theme
    try { localStorage.setItem('dt-theme', theme) } catch {}
  })

  async function probeEnvelopes(nextRuns, generation) {
    const ids = escalationProbeTargets(nextRuns)
    const byId = new Map(nextRuns.map((run) => [run.adw_id, run]))
    const found = new Map()
    let cursor = 0
    async function worker() {
      while (cursor < ids.length) {
        const id = ids[cursor++]
        const run = byId.get(id)
        if (!run) continue
        try {
          const result = await returnRequestSemaphore.run(() => getReturns(run.repo_slug, run.goal, run.adw_id))
          if (result?.task && typeof result.task === 'object') found.set(id, result.task)
        } catch {}
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, ids.length) }, () => worker()))
    if (generation === refreshGeneration) envelopes = found
  }

  async function refresh() {
    const generation = ++refreshGeneration
    try {
      const result = await getSessions(filters)
      if (generation !== refreshGeneration) return
      const nextRuns = Array.isArray(result?.runs) ? result.runs : []
      runs = nextRuns
      now = Date.now()
      envelopes = new Map()
      error = ''
      await probeEnvelopes(nextRuns, generation)
    } catch (err) {
      if (generation === refreshGeneration) error = err.message || 'session request failed'
    }
  }

  $effect(() => {
    const query = `${filters.mode}|${filters.status}|${filters.since}|${filters.until}`
    void query
    void refresh()
    const timer = anyRunning ? setInterval(refresh, 3000) : null
    return () => { if (timer) clearInterval(timer) }
  })

  function navigate(next) { location.hash = formatHash(next) }
  function openRun(adwId) { navigate({ view: 'run', adw_id: adwId }) }
  function backToFleet() { location.hash = '#/' }
</script>
<svelte:head><title>{pageTitle}</title></svelte:head>
<header class="topbar">
  <a class="brand" href="#/">Factory visualizer</a>
  <nav aria-label="Views">
    <button class:active={route.view === 'fleet'} onclick={() => navigate({ view: 'fleet' })}>Fleet</button>
    <button class:active={route.view === 'ops'} onclick={() => navigate({ view: 'ops' })}>Ops</button>
    <button class:active={route.view === 'roster'} onclick={() => navigate({ view: 'roster' })}>Roster</button>
  </nav>
  <div class="tools">
    <label class="theme">Theme <select bind:value={theme}><option value="os">OS</option><option value="paper">Paper</option><option value="ink">Ink</option></select></label>
  </div>
</header>
{#if route.view === 'run' || route.view === 'phase'}
  {#if selectedRun}
    <RunDetail run={selectedRun} phase={route.phase} onback={backToFleet} />
  {:else}
    <main class="page"><p class="error">Run not found.</p><button onclick={backToFleet}>Back to fleet</button></main>
  {/if}
{:else if route.view === 'ops'}
  <main class="page">
    <h1>Operations</h1>
    <MetricsStrip runs={runs} />
    <CellHealthPanel />
    <IntakePanel />
    <RunSetPanel />
  </main>
{:else if route.view === 'roster'}
  <main class="page">
    <h1>Roster</h1>
    <RosterPanel />
    <RosterEditor />
  </main>
{:else}
  <main class="page">
    <div class="heading"><div><h1>Fleet</h1><p class="muted">A dense readout of the latest ledger runs.</p></div><button class="toggle" onclick={() => view = view === 'table' ? 'cards' : 'table'}>{view === 'table' ? 'Show cards' : 'Show table'}</button></div>
    <Filters bind:filters bind:viewFilters hiddenLine={fleet.hidden.line} />
    {#if fleet.rail.length}
      <section class="rail" aria-label="Attention rail">
        <h2 class="micro">Attention</h2>
        {#each fleet.rail as row (row.adw_id)}
          <button class="rail-row" title={row.why} onclick={() => openRun(row.adw_id)}>
            <span class="rail-run mono">{row.run_label}</span>
            {#if row.status.key === 'escalated'}<span class="chip serious">{row.status.where || 'escalation'}</span><span class="rail-why">{row.why}</span>{:else}<span class="chip quiet">{row.why}</span>{/if}
          </button>
        {/each}
      </section>
    {/if}
    {#if error}<p class="error">{error}</p>{/if}
    {#if view === 'table'}
      <FleetTable rows={fleet.rows} onopen={(row) => openRun(row.adw_id)} />
    {:else}
      <section class="board">
        {#each visibleRuns as run (run.adw_id)}
          <RunCard {run} taskEnvelope={envelopes.get(run.adw_id)} onopen={(next) => openRun(next.adw_id)} />
        {:else}<p class="muted">No runs found.</p>{/each}
      </section>
    {/if}
    <MetricsStrip runs={runs} />
    <CellHealthPanel />
    <IntakePanel />
    <RunSetPanel />
  </main>
{/if}
<style>
:global(*) { box-sizing:border-box; }
:global(body) { margin:0; overflow-x:hidden; }
.topbar { display:flex; align-items:center; gap:1.2rem; border-bottom:1px solid var(--line); padding:.8rem 1rem; background:var(--panel); }
.brand { color:inherit; font-weight:700; text-decoration:none; }
nav { display:flex; gap:.25rem; }
button, select { font:inherit; border:1px solid var(--line); border-radius:0; background:var(--panel); color:inherit; padding:.35rem .55rem; cursor:pointer; }
nav button.active, .toggle { color:var(--accent); border-color:var(--accent); }
.tools { margin-left:auto; }
.theme { display:flex; align-items:center; gap:.4rem; color:var(--muted); font-size:.8rem; }
.page { max-width:1200px; margin:auto; padding:1.5rem 1rem 3rem; }
h1 { margin:.2rem 0; }
.heading { display:flex; justify-content:space-between; align-items:end; gap:1rem; }
.muted { color:var(--muted); }
.error { color:var(--status-fail); }
.rail { display:grid; gap:.4rem; border:1px solid var(--serious); padding:.7rem; margin:0 0 1rem; }
.rail h2 { margin:0; color:var(--serious); }
.rail-row { display:flex; align-items:center; gap:.7rem; width:100%; border:0; border-top:1px solid var(--line); padding:.55rem 0; text-align:left; }
.rail-row:first-of-type { border-top:0; }
.rail-run { flex:1; color:inherit; }
.rail-why { color:var(--muted); flex:2; text-align:left; white-space:normal; }
.chip { display:inline-block; padding:.15rem .4rem; border:1px solid currentColor; }
.chip.serious { color:var(--status-escalated); }
.chip.quiet { color:var(--muted); }
.board { display:grid; gap:1rem; }
.mono { font-family:var(--mono); font-variant-numeric:tabular-nums; }
</style>
