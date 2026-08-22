<script>
  import { getEvents, postTriage } from './api.js'
  import { drainEvents, createDrainQueue } from './drain.js'
  import { deriveStatus, durationCell, heartbeatCell, tokenCell } from './fleet.js'
  import PhaseDots from './PhaseDots.svelte'
  import GateChips from './GateChips.svelte'
  import RoleTag from './RoleTag.svelte'
  let { run, taskEnvelope = null, onopen = () => {} } = $props()
  let status = $derived(deriveStatus(run, taskEnvelope))
  let duration = $derived(durationCell(run))
  let tokens = $derived(tokenCell(run))
  let heartbeat = $derived(heartbeatCell(run))
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
  <header><div><strong>{run.goal || 'Untitled run'}</strong><small>{run.repo_slug || 'repository pending'}</small></div><span class={`status ${status.tone}`} title={status.why || undefined}><span class="status-dot" aria-hidden="true"></span>{status.word}</span></header>
  <div class="meta"><span class:muted={!run.mode} title={run.pending.mode}>mode {run.mode || '—'}</span><span class:mono={true} class:dashed={duration.dashed} title={duration.title || undefined}>{duration.text}</span><span class:mono={true} class:dashed={tokens.dashed} title={tokens.title || undefined}>tokens {tokens.text}</span><span class:dashed={heartbeat.dashed} title={heartbeat.title || undefined}>{heartbeat.text}</span><PhaseDots phases={run.phases} laneSource={run.phase_lanes} /><GateChips {run} /><span>{run.engineer || 'engineer —'}</span></div>
  <div class="agents">{#each run.agents as agent (agent.key)}<RoleTag role={agent.role} lane={agent.lane} />{/each}</div>
  <footer><button onclick={triage}>{run.triage.reviewed_at ? 'Unarchive' : 'Archive'}</button><button onclick={toggleEvents}>{expanded ? 'Hide events' : 'Events'}</button><button onclick={() => onopen(run)}>Detail</button></footer>
  {#if expanded}<div class="events wide">{#if historyTruncated}<p class="muted">History was cut at the page guard.</p>{/if}{#each events as event (event.id)}<div><code>#{event.id}</code> {event.type} {event.payload_json}</div>{/each}</div>{/if}
</article>
<style>
.card { background:var(--panel); border:1px solid var(--line); padding:1rem; display:grid; gap:.8rem; }
header, footer, .meta { display:flex; justify-content:space-between; gap:1rem; align-items:center; }
header div { display:grid; gap:.2rem; }
small, .muted { color:var(--muted); }
.status { display:inline-flex; align-items:center; gap:.35rem; }
.status-dot { width:.55rem; height:.55rem; background:currentColor; display:inline-block; }
.status.ok { color:var(--status-ok); }
.status.fail { color:var(--status-fail); }
.status.busy { color:var(--status-running); }
.status.serious { color:var(--status-escalated); }
.agents { display:flex; gap:.4rem; flex-wrap:wrap; }
.events { white-space:nowrap; padding:.5rem; border-top:1px solid var(--line); }
button { cursor:pointer; border:1px solid var(--line); background:var(--panel); color:inherit; }
.mono { font-family:var(--mono); font-variant-numeric:tabular-nums; }
.dashed { border-bottom:1px dashed currentColor; color:var(--muted); }
</style>
