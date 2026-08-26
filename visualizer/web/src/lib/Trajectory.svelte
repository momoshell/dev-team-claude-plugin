<script>
  import { applyRead, clearFocus, initialJournalState, journalPulse, select, setRange, setReveal, shouldRead, trajectoryView } from './live.js'
  import { projectMarker } from './spans.js'
  import { PANEL_REFRESH_MS } from './panels.js'
  let { run } = $props()
  let state = $state(initialJournalState())
  let now = $state(Date.now())
  let dragFrom = null
  async function load() {
    try {
      const params = new URLSearchParams({ repo_slug: run.repo_slug || '', task_slug: run.goal || '', adw_id: run.adw_id || '' })
      const response = await fetch(`/api/journal?${params}`)
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || `request failed (${response.status})`)
      state = applyRead(state, { ok: true, payload: data }, Date.now())
    } catch (err) { state = applyRead(state, { ok: false, error: err.message }, Date.now()) }
    now = Date.now()
  }
  $effect(() => { const id = run.adw_id; if (id) void load() })
  // No clock of its own: App.svelte's existing anyRunning timer publishes the pulse.
  $effect(() => journalPulse.subscribe(() => { if (shouldRead({ running: run.running })) void load() }))
  let view = $derived(trajectoryView(state, { now, refresh_ms: run.running ? PANEL_REFRESH_MS : null }))
  // The drag reads the geometry of a RAIL, the same box the bars are laid out in,
  // so the interval the operator sees is the interval that is selected.
  function fraction(event) {
    const box = event.currentTarget.getBoundingClientRect()
    return box.width > 0 ? Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) : 0
  }
  function down(event) { dragFrom = view.origin + fraction(event) * view.total; state = setRange(state, null) }
  function up(event) {
    if (dragFrom == null) return
    const to = view.origin + fraction(event) * view.total
    state = setRange(state, { from: Math.min(dragFrom, to), to: Math.max(dragFrom, to) })
    dragFrom = null
  }
</script>
<section class="panel"><h2>Trajectory</h2>
  {#if view.freshness.stale}<p class="error">{view.freshness.label}</p>{/if}
  <p class="muted">{view.freshness.refresh_label}</p>
  {#if view.degraded}<p class="error">journal unavailable — {view.payload_error || 'the reader reported a degraded read'}</p>{/if}
  {#if view.skipped_malformed > 0}<p class="muted">{view.skipped_malformed} malformed line(s) skipped: {view.skipped_line_numbers.join(', ')}</p>{/if}
  {#if view.excluded_no_timestamp > 0}<p class="muted">{view.excluded_no_timestamp} row(s) carry no usable timestamp and are excluded rather than dated</p>{/if}
  {#each view.anomalies as anomaly}<p class="muted">{anomaly.kind}: {anomaly.label} (expected {anomaly.expected ?? 'no open stage'})</p>{/each}
  <div class="overview">
    {#each view.spans as span (span.started_index)}
      <!-- The driver's own rail: a stage nobody is seated on is the driver working,
           stated in a word and in --lane-5, not left as an inference (#673). -->
      <div class="lane" class:driver={span.actor === 'driver'} style={span.actor === 'driver' ? '--lane-color: var(--lane-5)' : ''}>
        <span class="name" title={span.label}>{span.label}{#if span.actor === 'driver'}<span class="actor micro"> driver</span>{/if}</span>
        <span class="rail" onmousedown={down} onmouseup={up} role="presentation">
          {#if span.box.marker}
            <span class="marker" style={`left:${span.box.left * 100}%`}></span>
          {:else}
            <span class="bar" style={`left:${span.box.left * 100}%;width:${span.box.width * 100}%`}></span>
          {/if}
          <!-- Overlaid, never carved out: a retry NEVER splits or shortens the bar. -->
          {#each span.markers ?? [] as event (event.index)}
            <span class="event-marker" title={`${event.event} ${event.detail}`} style={`left:${projectMarker(event.at_ms, view.origin, view.total).left * 100}%`}></span>
          {/each}
        </span>
        <span class="took">{span.took}</span>
      </div>
    {/each}
  </div>
  <div class="controls">
    <label><input type="checkbox" checked={state.reveal} onchange={(event) => { state = setReveal(state, event.currentTarget.checked) }} /> reveal operational</label>
    <span class="muted">{state.reveal ? `${view.hidden_operational} operational row(s) revealed` : `${view.hidden_operational} operational row(s) hidden`}</span>
    {#if state.range}<button onclick={() => { state = clearFocus(state) }}>clear focus</button>{/if}
  </div>
  <table class="ledger"><thead><tr><th>#</th><th>event</th><th>channel</th><th>detail</th></tr></thead><tbody>
    {#each view.rows as row (row.index)}
      <tr class:selected={state.selected === row.index} onclick={() => { state = select(state, row.index) }}><td>{row.index}</td><td>{row.event}</td><td>{row.channel ?? '—'}</td><td class="detail">{row.detail}</td></tr>
    {/each}
  </tbody></table>
  {#if state.selected != null}
    {@const row = view.all_rows.find((entry) => entry.index === state.selected)}
    {#if row}<pre class="inspector">{JSON.stringify(row.row, null, 2)}</pre>{/if}
  {/if}
</section>
<style>
  .overview { display:grid; gap:.15rem; user-select:none; }
  /* One coordinate system: every lane's rail is the same grid column, so a
     percentage left and a percentage width resolve against the same box, and the
     drag reads that same box. */
  .lane { display:grid; grid-template-columns:14rem 1fr 6rem; align-items:center; gap:.5rem; }
  .name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .rail { position:relative; display:block; width:100%; height:.9rem; }
  .bar { position:absolute; top:.15rem; height:.6rem; min-width:2px; background:var(--accent, #3b82f6); border-radius:2px; }
  .marker { position:absolute; top:.05rem; width:0; border-left:2px solid var(--muted, #888); height:.8rem; }
  .event-marker { position:absolute; top:0; width:0; border-left:2px solid var(--status-running, #c38b18); height:.9rem; }
  .lane.driver .bar, .lane.driver .marker { background:var(--lane-color, var(--role-driver)); border-color:var(--lane-color, var(--role-driver)); }
  .lane.driver .actor { color:var(--lane-color, var(--role-driver)); }
  .took { color:var(--muted, #888); font-variant-numeric:tabular-nums; }
  .ledger { width:100%; border-collapse:collapse; font-size:.85rem; }
  .ledger td, .ledger th { text-align:left; padding:.15rem .4rem; border-bottom:1px solid var(--line, #eee); }
  .ledger .detail { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:48ch; }
  .inspector { overflow:auto; max-height:20rem; }
  .error { color:#b42318; }
</style>
