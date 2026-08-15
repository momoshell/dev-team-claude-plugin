<script>
  import { getEvents, getReturns } from './api.js'
  import { drainEvents } from './drain.js'
  import PhaseGantt from './PhaseGantt.svelte'
  import EnvelopeInspector from './EnvelopeInspector.svelte'
  import ReviewPanel from './ReviewPanel.svelte'
  import EventStream from './EventStream.svelte'
  let { run, onback = () => {} } = $props()
  let returns = $state({ envelopes: [], task: null }), events = $state([]), selectedPhaseId = $state(null), error = $state('')
  async function load() {
    try {
      returns = await getReturns(run.repo_slug, run.goal, run.adw_id)
      const drained = await drainEvents((after, limit) => getEvents(run.adw_id, after, limit), {})
      events = drained.events
    } catch (err) { error = err.message }
  }
  $effect(() => { const id = run.adw_id; if (id) void load() })
  function duration() { return run.duration_ms == null ? 'running' : `${Math.round(run.duration_ms / 1000)}s` }
</script>
<main class="detail"><header><button onclick={onback}>Back</button><div><h1>{run.goal || 'Untitled run'}</h1><p>{run.repo_slug || 'repository pending'} · {run.status} · {run.started_at || '—'} → {run.ended_at || 'now'} · {duration()}</p></div></header>
  {#if error}<p class="error">{error}</p>{/if}
  <PhaseGantt {run} {events} onselectphase={(id) => selectedPhaseId = id} />
  <EnvelopeInspector {run} {returns} />
  <ReviewPanel {run} {returns} />
  <EventStream {run} phaseFilter={selectedPhaseId} />
</main>
<style>.detail { max-width:1200px; margin:auto; padding:1rem; display:grid; gap:1rem; }.detail > header { display:flex; align-items:center; gap:1rem; }.detail h1 { margin:.2rem 0; }.detail p { color:var(--muted); }.error { color:#b42318; }</style>
