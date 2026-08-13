<script>
  import { getEvents, postTriage } from './api.js'
  import { drainEvents, createDrainQueue } from './drain.js'
  import PhaseDots from './PhaseDots.svelte'
  let { run } = $props()
  let expanded = $state(false)
  let events = $state([])
  let cursor = $state(0)
  let loading = $state(false)
  let historyTruncated = $state(false)
  // Left undefined until the effect's first pass: reading run.running here
  // captures only the initial value (svelte.dev/e/state_referenced_locally),
  // and the final drain must fire on a true running -> finished transition.
  let previousRunning
  async function drainPage() {
    loading = true
    try {
      const result = await drainEvents((after, limit) => getEvents(run.adw_id, after, limit), { after: cursor })
      events = [...events, ...result.events]
      cursor = result.cursor
      historyTruncated = historyTruncated || result.truncated
    } finally { loading = false }
  }
  const drainQueue = createDrainQueue(drainPage)
  function drain(options) { return drainQueue.drain(options) }
  async function toggleEvents() {
    expanded = !expanded
    if (!expanded) return
    if (!events.length) await drain()
  }
  $effect(() => {
    const wasRunning = previousRunning
    previousRunning = run.running
    if (!expanded) return
    if (!run.running) {
      if (wasRunning === true) drain({ final: true })
      return
    }
    const timer = setInterval(drain, 3000)
    return () => clearInterval(timer)
  })
  async function triage() { await postTriage(run.adw_id, !run.triage.reviewed_at); run.triage.reviewed_at = run.triage.reviewed_at ? null : new Date().toISOString() }
</script>
<article class="card">
  <header><div><strong>{run.goal || 'Untitled run'}</strong><small>{run.repo_slug || 'repository pending'}</small></div><span class="status">{run.status}</span></header>
  <div class="meta"><span class:muted={!run.mode} title={run.pending.mode}>mode {run.mode || '—'}</span><span>{Math.round((run.duration_ms || 0) / 1000)}s</span><PhaseDots phases={run.phases} laneSource={run.phase_lanes} /><span>{run.engineer || 'engineer —'}</span></div>
  <div class="agents">{#each run.agents as agent (agent.dispatch_id)}<span class="agent" style={`--lane-color: var(--lane-${agent.lane ?? 0})`} title={agent.outcome || 'running'}>lane {agent.lane}: {agent.role}</span>{/each}</div>
  <footer><button onclick={triage}>{run.triage.reviewed_at ? 'Unarchive' : 'Archive'}</button><button onclick={toggleEvents}>{expanded ? 'Hide events' : 'Events'}</button></footer>
  {#if expanded}<div class="events wide">{#if historyTruncated}<p class="muted">History was cut at the page guard.</p>{/if}{#each events as event (event.id)}<div><code>#{event.id}</code> {event.type} {event.payload_json}</div>{/each}</div>{/if}
</article>
<style>.card { background:var(--panel); border:1px solid var(--line); border-radius:.6rem; padding:1rem; display:grid; gap:.8rem; } header, footer, .meta { display:flex; justify-content:space-between; gap:1rem; align-items:center; } header div { display:grid; gap:.2rem; } small, .muted { color:var(--muted); }.status { border-radius:1rem; padding:.2rem .6rem; background:#dbeafe; }.agents { display:flex; gap:.4rem; flex-wrap:wrap; }.agent { background:var(--lane-color); color:#fff; padding:.25rem .5rem; border-radius:.3rem; font-size:.85rem; }.events { white-space:nowrap; padding:.5rem; border-top:1px solid var(--line); } button { cursor:pointer; }</style>
