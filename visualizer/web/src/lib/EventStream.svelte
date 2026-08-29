<script>
  import { getEvents } from './api.js'
  import { drainEvents } from './drain.js'
  let { run, phaseFilter = null } = $props()
  let events = $state([]), cursor = $state(0), loading = $state(false), truncated = $state(false), initialized = $state(false), expandedWhy = $state({})
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
    try {
      const result = await drainEvents((after, limit) => getEvents(run.adw_id, after, limit, filters()), { after: cursor })
      events = [...events, ...result.events]; cursor = result.cursor; truncated = truncated || result.truncated
    } finally { loading = false }
  }
  function changeFilter() { void load(true) }
  function payload(event) { try { return JSON.parse(event.payload_json || '{}') } catch { return event.payload_json } }
  function text(value) { return typeof value === 'string' ? value : JSON.stringify(value) }
  $effect(() => { if (phaseFilter !== undefined && phaseFilter !== null) { selectedPhase = phaseFilter; void load(true) } })
  $effect(() => { const id = run.adw_id; if (id && !initialized) { initialized = true; void load() } })
</script>
<section class="panel"><h2>Event stream</h2>
  <div class="filters"><label>type <select bind:value={type} onchange={changeFilter}><option value="">all</option>{#each types as option (option)}<option value={option}>{option}</option>{/each}</select></label><label>role <select bind:value={role} onchange={changeFilter}><option value="">all</option>{#each roles as option (option)}<option value={option}>{option}</option>{/each}</select></label><label>phase <select bind:value={selectedPhase} disabled={!phaseAvailable && !selectedPhase} onchange={changeFilter}><option value="">all</option>{#each phases as phase (phase.id ?? phase.seq)}<option value={phase.id}>{phase.name} · {phase.seq}</option>{/each}</select></label></div>
  {#if !phaseAvailable}<p class="muted">phase filter unavailable — this run's events predate phase linkage (#123)</p>{/if}
  <div class="wide rows">{#each events as event (event.id)}{@const value = payload(event)}<div class="event"><code>#{event.id} · seq {event.seq ?? '—'} · {event.type} · phase {event.phase_id ?? '—'}</code><pre class:why={event.type === 'decision'} class:expanded={expandedWhy[event.id]}>{text(value)}</pre>{#if event.type === 'decision' && typeof value?.why === 'string' && value.why.length > 240}<button class="expand" onclick={() => expandedWhy[event.id] = !expandedWhy[event.id]}>{expandedWhy[event.id] ? 'Collapse why' : 'Expand why'}</button>{/if}</div>{:else}<p class="muted">No events.</p>{/each}</div>
  <button onclick={() => load()} disabled={loading}>{loading ? 'Loading…' : 'Load more'}</button>{#if truncated}<p class="muted">History was cut at the page guard.</p>{/if}
</section>
<style>.panel { background:var(--panel); border:1px solid var(--line); border-radius:.6rem; padding:1rem; }.filters { display:flex; flex-wrap:wrap; gap:1rem; margin-bottom:.8rem; }.rows { max-height:30rem; }.event { border-top:1px solid var(--line); padding:.5rem 0; }.event pre { margin:.3rem 0 0; white-space:pre-wrap; overflow-wrap:anywhere; max-height:6rem; overflow:auto; }.event pre.why { max-height:5rem; }.event pre.why.expanded { max-height:none; }.expand { cursor:pointer; }.muted { color:var(--muted); }</style>
