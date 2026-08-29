<script>
  import { untrack } from 'svelte'
  import { getEvents } from './api.js'
  import { drainEvents } from './drain.js'
  import { phaseFilterId } from './trace.js'
  let { run, phaseFilter = null } = $props()
  let events = $state([]), cursor = $state(0), loading = $state(false), truncated = $state(false), initialized = $state(false), expandedWhy = $state({}), error = $state('')
  let type = $state(''), role = $state(''), selectedPhase = $state('')
  let phaseAvailable = $derived(events.some((event) => event.phase_id != null))
  let roles = $derived([...new Set(events.map((event) => { try { return JSON.parse(event.payload_json || '{}').role } catch { return null } }).filter(Boolean))].sort())
  let phases = $derived(run.phases || [])
  const types = ['log', 'agent_start', 'agent_end', 'decision']
  function filters() { return { type, role, phase_id: selectedPhase } }
  async function load(reset = false) {
    if (loading) return
    if (reset) { events = []; cursor = 0; truncated = false }
    loading = true
    error = ''
    try {
      const result = await drainEvents((after, limit) => getEvents(run.adw_id, after, limit, filters()), { after: cursor })
      events = [...events, ...result.events]; cursor = result.cursor; truncated = truncated || result.truncated
    } catch (err) {
      error = err?.message || 'Events could not be loaded.'
    } finally { loading = false }
  }
  function changeFilter() { void load(true) }
  function payload(event) { try { return JSON.parse(event.payload_json || '{}') } catch { return event.payload_json } }
  function text(value) { return typeof value === 'string' ? value : JSON.stringify(value, null, 2) }
  function time(value) {
    if (!value) return 'Time unavailable'
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? String(value) : new Intl.DateTimeFormat(undefined, { hour:'numeric', minute:'2-digit', second:'2-digit' }).format(parsed)
  }
  $effect(() => {
    const requested = phaseFilter
    const id = run.adw_id
    if (id && requested !== undefined && requested !== null) untrack(() => { selectedPhase = phaseFilterId(run, requested); void load(true) })
  })
  $effect(() => { const id = run.adw_id; if (id && !initialized) untrack(() => { initialized = true; void load() }) })
</script>
<section class="panel"><header><div><h2>Event stream</h2><p>{events.length} ledger event{events.length === 1 ? '' : 's'} in this view</p></div><button class="refresh" onclick={() => load()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button></header>
  <div class="filters"><label>type <select bind:value={type} onchange={changeFilter}><option value="">all</option>{#each types as option (option)}<option value={option}>{option}</option>{/each}</select></label><label>role <select bind:value={role} onchange={changeFilter}><option value="">all</option>{#each roles as option (option)}<option value={option}>{option}</option>{/each}</select></label><label>phase <select bind:value={selectedPhase} disabled={!phaseAvailable && !selectedPhase} onchange={changeFilter}><option value="">all</option>{#each phases as phase (phase.id ?? phase.seq)}<option value={phase.id}>{phase.name} · {phase.seq}</option>{/each}</select></label></div>
  {#if !phaseAvailable}<p class="muted">phase filter unavailable — this run's events predate phase linkage (#123)</p>{/if}
  {#if error}<p class="error">{error}</p>{/if}
  <div class="wide rows">{#each events as event (event.id)}{@const value = payload(event)}<article class="event"><div class="event-meta"><span class={`type ${event.type}`}>{event.type.replaceAll('_',' ')}</span><time datetime={event.started_at || event.ended_at || undefined}>{time(event.started_at || event.ended_at)}</time><code>seq {event.seq ?? '—'} · phase {event.phase_id ?? '—'}</code></div><pre class:why={event.type === 'decision'} class:expanded={expandedWhy[event.id]}>{text(value)}</pre>{#if event.type === 'decision' && typeof value?.why === 'string' && value.why.length > 240}<button class="expand" onclick={() => expandedWhy[event.id] = !expandedWhy[event.id]}>{expandedWhy[event.id] ? 'Collapse why' : 'Expand why'}</button>{/if}</article>{:else}{#if !loading}<p class="empty">No events match these filters.</p>{/if}{/each}</div>
  {#if truncated}<p class="muted">History was cut at the page guard.</p>{/if}
</section>
<style>
.panel { background:var(--panel); border:1px solid var(--line); border-radius:.6rem; padding:1rem; }.panel > header { display:flex; align-items:start; justify-content:space-between; gap:1rem; }.panel h2 { margin:0; }.panel header p { margin:.25rem 0 0; color:var(--muted); font-size:.68rem; }.filters { display:flex; flex-wrap:wrap; gap:1rem; margin:.9rem 0 .8rem; }.filters label { display:grid; gap:.25rem; color:var(--muted); font-size:.62rem; text-transform:uppercase; letter-spacing:.08em; }.filters select { min-height:2rem; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--panel-raised); padding:.35rem .55rem; text-transform:none; letter-spacing:0; }.rows { max-height:34rem; }.event { display:grid; grid-template-columns:10.5rem minmax(0,1fr); gap:.8rem; border-top:1px solid var(--line); padding:.7rem 0; }.event-meta { display:flex; align-content:start; flex-wrap:wrap; gap:.35rem; }.event-meta .type { width:max-content; border-radius:1rem; background:var(--accent-soft); color:var(--accent); padding:.18rem .4rem; font-size:.57rem; text-transform:capitalize; }.event-meta time,.event-meta code { width:100%; color:var(--muted); font-size:.58rem; }.event pre { margin:0; border-radius:var(--radius-sm); background:var(--bg); padding:.55rem .65rem; white-space:pre-wrap; overflow-wrap:anywhere; max-height:7rem; overflow:auto; font-size:.63rem; }.event pre.why { max-height:5rem; }.event pre.why.expanded { max-height:none; }.refresh,.expand { min-height:2rem; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--panel-raised); color:var(--muted); padding:.35rem .6rem; cursor:pointer; }.expand { grid-column:2; justify-self:start; }.refresh:hover,.expand:hover { border-color:var(--accent); color:var(--accent); }.muted { color:var(--muted); }.empty { margin:0; border-top:1px solid var(--line); padding:1.5rem 0; color:var(--muted); text-align:center; }.error { border:1px solid color-mix(in srgb,var(--status-fail) 45%,var(--line)); border-radius:var(--radius-sm); color:var(--status-fail); padding:.55rem .7rem; }
@media (max-width:650px) { .event { grid-template-columns:1fr; }.expand { grid-column:1; } }
</style>
