<script>
  import { getRunSet } from './api.js'
  import { PANEL_REFRESH_MS, runSetPanel, panelReadLoop } from './panels.js'
  let payload = $state({ absent: null, window: null, runs: null, settled: null, usage: null, coverage: null, usage_mean_tokens_per_measured_run: null, budget: null, unmeasured: {}, rows: [] })
  let error = $state('')
  let read_at = $state(null)
  let now = $state(null)
  let panel = $derived(runSetPanel(error ? { ...payload, absent: error } : payload, { read_at, now, refresh_ms: PANEL_REFRESH_MS }))
  let visibleRows = $derived.by(() => [...panel.rows].sort((a, b) => {
    const risk = (row) => row.status === 'fail' ? 3 : row.status === 'aborted' ? 2 : row.status === 'running' ? 1 : 0
    return risk(b) - risk(a) || Date.parse(b.started_at || 0) - Date.parse(a.started_at || 0)
  }).slice(0, 7))
  let totalTokens = $derived.by(() => {
    if (!payload?.usage) return null
    return ['billed_input_tokens', 'billed_output_tokens', 'billed_cache_write_tokens', 'billed_cache_read_tokens'].reduce((sum, key) => sum + (Number(payload.usage[key]) || 0), 0)
  })
  let coveragePercent = $derived(payload?.coverage?.total > 0 ? Math.round(payload.coverage.measured / payload.coverage.total * 100) : null)

  function compact(value) { return value == null ? '—' : Intl.NumberFormat(undefined, { notation:'compact', maximumFractionDigits:1 }).format(value) }

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
<section class="panel runset-panel">
  <header class="panel-head"><div><p class="eyebrow">Throughput</p><h2>Run window</h2><p class="meta">{panel.window_label}</p></div>{#if !panel.absent}<span class="run-count">{panel.runs_label}</span>{/if}</header>
  <p class={`meta read-age ${panel.freshness.stale ? 'stale' : 'fresh'}`}>{panel.freshness.label} · {panel.freshness.refresh_label}</p>
  {#if panel.absent}
    <p class="notice">Run set unavailable — {panel.absent}</p>
  {:else}
    <div class="status-strip" aria-label="Run outcomes">{#each panel.settled_chips as chip (chip.status)}<div class={chip.tone}><strong>{chip.count}</strong><span>{chip.status}</span></div>{/each}</div>
    <div class="usage-summary">
      <div><span>Measured usage</span><strong>{compact(totalTokens)}</strong><small>billed tokens across the window</small></div>
      <div><span>Metering coverage</span><strong>{coveragePercent == null ? '—' : `${coveragePercent}%`}</strong><small>{panel.coverage_label || 'coverage unavailable'}</small></div>
    </div>
    {#if !panel.empty && visibleRows.length}
      <div class="list-head"><span>Priority runs</span><small>exceptions first · {visibleRows.length} of {panel.rows.length}</small></div>
      <div class="rows">
        {#each visibleRows as row (row.adw_id)}
          <article class={`row ${row.tone}`}>
            <span class={`status ${row.tone}`}>{row.status || '—'}</span><div><h3>{row.title}</h3><p>{row.started_at || '—'} · {row.duration_label}</p></div><span class={`usage ${row.usage_tone}`}>{row.agent_sessions_label}</span>
          </article>
        {/each}
      </div>
    {/if}
    <details class="method"><summary>Measurement notes</summary><p>{panel.usage_label}</p>{#if panel.budget_label}<p>{panel.budget_label}</p>{/if}{#if panel.budget_pending}<p>{panel.budget_pending}</p>{/if}{#if panel.budget_note}<p>{panel.budget_note}</p>{/if}{#if panel.mean_label}<p>{panel.mean_label}</p>{/if}{#if panel.usage_note}<p>{panel.usage_note}</p>{/if}{#if panel.parked_note}<p>{panel.parked_note}</p>{/if}{#if panel.unmeasured_note}<p>{panel.unmeasured_note}</p>{/if}</details>
  {/if}
</section>
<style>.panel { min-width:0; background:var(--panel); border:1px solid var(--line); border-radius:var(--radius-lg); padding:1rem; }.panel-head { display:flex; justify-content:space-between; align-items:start; gap:1rem; }.eyebrow { margin:0 0 .22rem; color:var(--muted); font-size:.6rem; font-weight:700; letter-spacing:.13em; text-transform:uppercase; }.panel h2 { margin:0 0 .25rem; font-size:1rem; }.meta { margin:.16rem 0; color:var(--muted); font-size:.6rem; }.run-count { border:1px solid var(--line); border-radius:2rem; padding:.26rem .48rem; color:var(--muted); font:600 .58rem var(--mono); }.read-age { margin:.55rem 0 .75rem; }.read-age.stale { color:var(--status-fail); font-weight:600; }.notice { border:1px solid color-mix(in srgb,var(--status-fail) 35%,var(--line)); border-radius:var(--radius-sm); padding:.65rem; color:var(--status-fail); font-size:.68rem; }
.status-strip { display:grid; grid-template-columns:repeat(4,1fr); overflow:hidden; border:1px solid var(--line); border-radius:var(--radius); }.status-strip div { position:relative; display:grid; gap:.12rem; padding:.65rem .7rem; border-left:1px solid var(--line); }.status-strip div:first-child { border-left:0; }.status-strip strong { font:650 .95rem var(--mono); }.status-strip span { color:var(--muted); font-size:.55rem; }.status-strip .ok strong { color:var(--status-ok); }.status-strip .fail strong,.status-strip .aborted strong { color:var(--status-fail); }.status-strip .running strong { color:var(--status-running); }
.usage-summary { display:grid; grid-template-columns:repeat(2,1fr); gap:.6rem; margin:.7rem 0; }.usage-summary > div { display:grid; gap:.22rem; border-radius:var(--radius); background:var(--bg); padding:.7rem; }.usage-summary span { color:var(--muted); font-size:.56rem; }.usage-summary strong { font:650 1.08rem var(--mono); }.usage-summary small { overflow:hidden; color:var(--muted); font-size:.54rem; text-overflow:ellipsis; white-space:nowrap; }.list-head { display:flex; justify-content:space-between; gap:1rem; padding:.65rem 0 .35rem; color:var(--muted); font-size:.57rem; text-transform:uppercase; letter-spacing:.08em; }.list-head small { font-size:.54rem; text-transform:none; letter-spacing:0; }.rows { display:grid; }.row { display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:.6rem; border-top:1px solid var(--line); padding:.6rem 0; }.status { border:1px solid currentColor; border-radius:2rem; padding:.2rem .38rem; font:600 .53rem var(--mono); }.status.ok { color:var(--status-ok); }.status.fail,.status.aborted { color:var(--status-fail); }.status.running { color:var(--status-running); }.row > div { min-width:0; }.row h3 { margin:0; overflow:hidden; font-size:.67rem; text-overflow:ellipsis; white-space:nowrap; }.row p { margin:.14rem 0 0; color:var(--muted); font-size:.54rem; }.usage { color:var(--muted); font:500 .55rem var(--mono); }.usage.unmeasured { text-decoration:underline dotted; text-underline-offset:.2rem; }.method { padding-top:.7rem; border-top:1px solid var(--line); }.method summary { width:max-content; color:var(--muted); cursor:pointer; font-size:.58rem; }.method p { color:var(--muted); font-size:.58rem; line-height:1.45; }
@media (max-width:620px) { .usage-summary { grid-template-columns:1fr; }.row { grid-template-columns:auto minmax(0,1fr); }.row > .usage { grid-column:2; } }
</style>
