<script>
  import { getRunSet } from './api.js'
  import { PANEL_REFRESH_MS, runSetPanel, panelReadLoop } from './panels.js'
  let payload = $state({ absent: null, window: null, runs: null, settled: null, usage: null, coverage: null, usage_mean_tokens_per_measured_run: null, budget: null, unmeasured: {}, rows: [] })
  let error = $state('')
  let read_at = $state(null)
  let now = $state(null)
  let panel = $derived(runSetPanel(error ? { ...payload, absent: error } : payload, { read_at, now, refresh_ms: PANEL_REFRESH_MS }))

  $effect(() => {
    let active = true
    const stop = panelReadLoop(() => {
      now = Date.now()
      getRunSet().then((result) => {
        if (!active) return
        payload = result
        error = ''
        read_at = Date.now()
        now = read_at
      }).catch((err) => {
        if (!active) return
        error = err.message || 'run-set request failed'
      })
    }, { refresh_ms: PANEL_REFRESH_MS })
    return () => { active = false; stop() }
  })
</script>
<section class="panel">
  <p class={`meta read-age ${panel.freshness.stale ? 'stale' : 'fresh'}`}>{panel.freshness.label} · {panel.freshness.refresh_label}</p>
  {#if panel.absent}
    <p class="muted">run-set unavailable — {panel.absent}</p>
  {:else}
    <h2>Run set</h2>
    <p class="meta">{panel.window_label}</p>
    <p class="runs">{panel.runs_label}</p>
    <div class="chips">{#each panel.settled_chips as chip (chip.status)}<span class={`chip ${chip.tone}`}>{chip.status} {chip.count}</span>{/each}</div>
    <div class="usage">
      <p>{panel.usage_label}</p>
      {#if panel.budget_label}<p>{panel.budget_label}</p>{/if}
      {#if panel.budget_pending}<p class="muted">{panel.budget_pending}</p>{/if}
      {#if panel.budget_note}<p class="meta">{panel.budget_note}</p>{/if}
      {#if panel.mean_label}<p class="meta">{panel.mean_label}</p>{/if}
      {#if panel.coverage_label}<p class="meta">{panel.coverage_label}</p>{/if}
      {#if panel.usage_note}<p class="muted">{panel.usage_note}</p>{/if}
    </div>
    {#if panel.parked_note}<p class="muted">{panel.parked_note}</p>{/if}
    {#if !panel.empty}
      <div class="rows">
        {#each panel.rows as row (row.adw_id)}
          <article class={`row ${row.tone}`}>
            <h3>{row.title}</h3>
            <p class="meta">{row.status || '—'} · {row.started_at || '—'} → {row.ended_at || 'now'} · {row.duration_label}</p>
            <p class={`usage ${row.usage_tone}`}>{row.agent_sessions_label} · {row.usage_label}</p>
          </article>
        {/each}
      </div>
    {/if}
    {#if panel.unmeasured_note}<p class="muted">{panel.unmeasured_note}</p>{/if}
  {/if}
</section>
<style>.panel { background:var(--panel); border:1px solid var(--line); border-radius:.6rem; padding:1rem; margin:1rem 0; }.panel h2 { margin-top:0; }.meta, .muted { color:var(--muted); }.runs { font-weight:600; }.chips { display:flex; flex-wrap:wrap; gap:.45rem; margin:.5rem 0; }.chip { border:1px solid var(--line); border-radius:999px; padding:.2rem .5rem; font-size:.9rem; }.chip.ok { color:#176b3a; }.chip.fail, .chip.aborted { color:#9b1c1c; }.rows { display:grid; gap:.65rem; }.row { border-top:1px solid var(--line); padding-top:.6rem; }.row h3 { margin:.1rem 0 .35rem; }.usage p { margin:.35rem 0; }.usage.unmeasured { color:#7a3e9d; }.usage.measured { color:inherit; }.read-age.stale { color:var(--status-fail); font-weight:600; }
</style>
