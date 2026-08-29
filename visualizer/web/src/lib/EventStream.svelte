<script>
  import { untrack } from 'svelte'
  import { eventPayload, eventStreamSummary } from './event-story.js'
  import { phaseFilterId } from './trace.js'
  import EventStory from './EventStory.svelte'

  let { run, events = [], phaseFilter = null, onrefresh = async () => {} } = $props()
  let type = $state(''), role = $state(''), selectedPhase = $state(''), refreshing = $state(false), error = $state('')
  let phases = $derived(run.phases || [])
  let phaseAvailable = $derived(events.some((event) => event.phase_id != null))
  let roles = $derived([...new Set([...(run.agents || []).map((agent) => agent.role), ...events.map((event) => eventPayload(event)?.role)].filter(Boolean))].sort())
  let filtered = $derived(events.filter((event) => (!type || event.type === type) && (!role || eventPayload(event)?.role === role) && (!selectedPhase || String(event.phase_id) === String(selectedPhase))))
  let summary = $derived(eventStreamSummary(filtered))
  let scope = $derived(phases.find((phase) => String(phase.id) === String(selectedPhase))?.name?.replaceAll('_',' ') || 'All phases')
  const types = [
    { value:'', label:'All event types' },
    { value:'agent_start', label:'Turns started' },
    { value:'agent_end', label:'Turns ended' },
    { value:'decision', label:'Decisions' },
    { value:'log', label:'Workflow logs' },
  ]

  async function refresh() {
    if (refreshing) return
    refreshing = true
    error = ''
    try { await onrefresh() }
    catch (err) { error = err?.message || 'Events could not be refreshed.' }
    finally { refreshing = false }
  }
  function clearFilters() { type = ''; role = ''; selectedPhase = '' }

  $effect(() => {
    const requested = phaseFilter
    const id = run.adw_id
    if (id && requested !== undefined && requested !== null) untrack(() => { selectedPhase = phaseFilterId(run, requested) })
  })
</script>

<section class="panel">
  <header><div><p class="micro">Ordered ledger history</p><h2>What happened</h2><p>Sequence numbers preserve the authoritative order when an event has no timestamp.</p></div><button class="refresh" onclick={refresh} disabled={refreshing}>{refreshing ? 'Refreshing…' : 'Refresh events'}</button></header>

  <div class="filters"><label>Event type<select bind:value={type}>{#each types as option (option.value)}<option value={option.value}>{option.label}</option>{/each}</select></label><label>Role<select bind:value={role}><option value="">All roles</option>{#each roles as option (option)}<option value={option}>{option}</option>{/each}</select></label><label>Phase<select bind:value={selectedPhase} disabled={!phaseAvailable}><option value="">All phases</option>{#each phases as phase (phase.id ?? phase.seq)}<option value={phase.id}>{phase.name} · {phase.seq}</option>{/each}</select></label>{#if type || role || selectedPhase}<button class="clear" type="button" onclick={clearFilters}>Clear filters</button>{/if}</div>

  <div class="scope"><div><strong>{summary.total}</strong><span>{summary.total === 1 ? 'event' : 'events'} · {scope}</span></div><div class="counts"><span>{summary.starts} started</span><span>{summary.ends} ended</span><span>{summary.decisions} decision{summary.decisions === 1 ? '' : 's'}</span><span>{summary.logs} log{summary.logs === 1 ? '' : 's'}</span></div></div>
  {#if !phaseAvailable && events.length}<p class="notice">Phase filtering is unavailable because these events predate phase linkage.</p>{/if}
  {#if error}<p class="error">{error}</p>{/if}

  <div class="rows" aria-live="polite" aria-busy={refreshing}>{#each filtered as event (event.id)}<EventStory {event} {phases} />{:else}<div class="empty"><strong>No events match this view.</strong><span>Try a broader event type, role, or phase.</span></div>{/each}</div>
</section>

<style>
.panel { background:var(--panel); border:1px solid var(--line); border-radius:.6rem; padding:1rem; }.panel > header { display:flex; align-items:start; justify-content:space-between; gap:1rem; }.panel .micro { margin:0 0 .2rem; color:var(--accent); }.panel h2 { margin:0; }.panel header p:last-child { margin:.28rem 0 0; max-width:35rem; color:var(--muted); font-size:.67rem; }.filters { display:flex; align-items:end; flex-wrap:wrap; gap:.55rem; margin:.95rem 0 .75rem; }.filters label { display:grid; gap:.25rem; color:var(--muted); font-size:.57rem; font-weight:700; letter-spacing:.07em; text-transform:uppercase; }.filters select { min-width:9.5rem; min-height:2rem; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--panel-raised); padding:.35rem .55rem; color:inherit; font-size:.64rem; text-transform:none; letter-spacing:0; }.refresh,.clear { min-height:2rem; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--panel-raised); color:var(--muted); padding:.35rem .6rem; font-size:.61rem; cursor:pointer; }.refresh:hover,.clear:hover { border-color:var(--accent); color:var(--accent); }.refresh:disabled { opacity:.55; cursor:wait; }.scope { display:flex; align-items:center; justify-content:space-between; gap:1rem; margin-bottom:.9rem; border:1px solid var(--line); border-radius:var(--radius); background:var(--bg); padding:.55rem .7rem; }.scope > div:first-child { display:flex; align-items:baseline; gap:.35rem; }.scope strong { font:650 1.05rem/1 var(--mono); }.scope span { color:var(--muted); font-size:.58rem; }.counts { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:.3rem .65rem; }.rows { max-height:38rem; overflow:auto; padding-right:.25rem; scrollbar-gutter:stable; transition:opacity .12s ease; }.rows[aria-busy='true'] { opacity:.68; }.notice,.error { border-radius:var(--radius-sm); padding:.55rem .7rem; font-size:.63rem; }.notice { border:1px solid var(--line); color:var(--muted); }.error { border:1px solid color-mix(in srgb,var(--status-fail) 45%,var(--line)); color:var(--status-fail); }.empty { min-height:9rem; display:grid; place-content:center; gap:.3rem; color:var(--muted); text-align:center; }.empty strong { color:inherit; font-size:.76rem; }.empty span { font-size:.64rem; }
@media (max-width:650px) { .panel > header { align-items:start; }.scope { align-items:start; flex-direction:column; }.counts { justify-content:flex-start; }.filters label { flex:1 1 8rem; }.filters select { width:100%; min-width:0; } }
</style>
