<script>
  import { getSeatTeardowns } from './api.js'
  import { PANEL_REFRESH_MS, teardownPanel, panelReadLoop } from './panels.js'
  let payload = $state({ absent: null, measured: false, window: null, runs: [], totals: null })
  let error = $state('')
  let read_at = $state(null)
  let now = $state(null)
  let panel = $derived(teardownPanel(error ? { ...payload, absent: error } : payload, { read_at, now, refresh_ms: PANEL_REFRESH_MS }))
  let measuredRuns = $derived(panel.rows.filter((row) => row.state !== 'not-measured' && row.state !== 'undetermined').length)
  let coverage = $derived(panel.rows.length ? Math.round(measuredRuns / panel.rows.length * 100) : null)
  let exceptions = $derived.by(() => panel.rows.filter((row) => row.tone !== 'proven'))
  let visibleRows = $derived(exceptions.length ? exceptions.slice(0, 7) : panel.rows.slice(0, 5))

  $effect(() => {
    let active = true
    const stop = panelReadLoop(() => {
      now = Date.now()
      getSeatTeardowns().then((result) => {
        if (!active) return
        payload = result
        error = ''
        read_at = Date.now()
        now = read_at
      }).catch((err) => {
        if (!active) return
        error = err.message || 'seat teardown request failed'
      })
    }, { refresh_ms: PANEL_REFRESH_MS })
    return () => { active = false; stop() }
  })
</script>
<section class="panel">
  <header class="panel-head"><div><p class="eyebrow">Runtime hygiene</p><h2>Seat reclamation</h2><p class="meta">{panel.window_label}</p></div><span class={`state-badge ${panel.tone}`}>{panel.tone === 'proven' ? 'clean' : panel.tone}</span></header>
  <p class={`meta read-age ${panel.freshness.stale ? 'stale' : 'fresh'}`}>{panel.freshness.label} · {panel.freshness.refresh_label}</p>
  {#if panel.absent}<p class="notice">Seat teardown unavailable — {panel.absent}</p>{/if}
  <div class="teardown-score"><div><strong>{coverage == null ? '—' : `${coverage}%`}</strong><span>run coverage</span></div><div><strong>{panel.totals?.proven ?? '—'}</strong><span>seats proven reclaimed</span></div><div><strong>{panel.totals?.failed ?? '—'}</strong><span>failed</span></div><div><strong>{panel.totals?.unproven ?? '—'}</strong><span>unproven</span></div></div>
  <div class="proof-bar"><i class="proven" style={`--share:${panel.totals?.seats ? (panel.totals.proven / panel.totals.seats * 100) : 0}%`}></i><i class="failed" style={`--share:${panel.totals?.seats ? (panel.totals.failed / panel.totals.seats * 100) : 0}%`}></i><i class="unproven" style={`--share:${panel.totals?.seats ? (panel.totals.unproven / panel.totals.seats * 100) : 0}%`}></i></div>
  <div class="list-head"><span>{exceptions.length ? 'Coverage gaps and leaks' : 'Recent proof'}</span><small>{exceptions.length ? `${exceptions.length} run-level exceptions` : panel.totals_label}</small></div>
  <div class="runs">
    {#each visibleRows as row (row.adw_id)}
      <article class={`run ${row.tone}`}>
        <span class={`run-mark ${row.tone}`}>{row.tone === 'proven' ? '✓' : row.tone === 'leak' ? '!' : '?'}</span><div class="run-copy"><h3>{row.run_label}</h3><p>{row.at || '—'}</p><span class={`state ${row.tone}`}>{row.label}</span></div>
        {#if row.seats.length}
          <details><summary>{row.seats.length} seat{row.seats.length === 1 ? '' : 's'}</summary><div class="seats">{#each row.seats as seat (seat.role)}<span class={`chip ${seat.tone}`} title={seat.at || undefined}>{seat.label}</span>{/each}</div></details>
        {/if}
      </article>
    {:else}
      <p class="empty">No runs in this window.</p>
    {/each}
  </div>
  <details class="method"><summary>Measurement notes</summary><p>{panel.note}</p><p>{panel.window_note}</p></details>
</section>
<style>
.panel { min-width:0; background:var(--panel); border:1px solid var(--line); border-radius:var(--radius-lg); padding:1rem; }.panel-head { display:flex; justify-content:space-between; align-items:start; gap:1rem; }.eyebrow { margin:0 0 .22rem; color:var(--muted); font-size:.6rem; font-weight:700; letter-spacing:.13em; text-transform:uppercase; }.panel h2 { margin:0 0 .25rem; font-size:1rem; }.meta { margin:.16rem 0; color:var(--muted); font-size:.6rem; }.state-badge { border:1px solid currentColor; border-radius:2rem; padding:.26rem .48rem; font:600 .58rem var(--mono); }.state-badge.proven { color:var(--status-ok); }.state-badge.leak { color:var(--status-fail); }.state-badge.unproven { color:var(--status-running); }.state-badge.not-measured,.state-badge.undetermined { color:var(--muted); }.read-age { margin:.55rem 0 .75rem; }.read-age.stale { color:var(--status-fail); font-weight:600; }.notice { border:1px solid color-mix(in srgb,var(--status-fail) 35%,var(--line)); border-radius:var(--radius-sm); padding:.65rem; color:var(--status-fail); font-size:.68rem; }
.teardown-score { display:grid; grid-template-columns:repeat(4,1fr); gap:.5rem; padding:.75rem; border-radius:var(--radius); background:var(--bg); }.teardown-score div { min-width:0; display:grid; gap:.18rem; }.teardown-score strong { font:650 .95rem var(--mono); }.teardown-score span { color:var(--muted); font-size:.54rem; }.proof-bar { display:flex; height:.3rem; overflow:hidden; margin:.55rem 0 .8rem; border-radius:1rem; background:var(--bg); }.proof-bar i { display:block; width:var(--share); }.proven { color:var(--status-ok); background:var(--status-ok); }.failed { color:var(--status-fail); background:var(--status-fail); }.unproven { color:var(--status-running); background:var(--status-running); }.list-head { display:flex; justify-content:space-between; gap:1rem; padding:.35rem 0; color:var(--muted); font-size:.57rem; text-transform:uppercase; letter-spacing:.08em; }.list-head small { font-size:.54rem; text-align:right; text-transform:none; letter-spacing:0; }.runs { display:grid; }.run { display:grid; grid-template-columns:2rem minmax(0,1fr) auto; align-items:start; gap:.65rem; padding:.65rem 0; border-top:1px solid var(--line); }.run-mark { width:2rem; height:2rem; display:grid; place-items:center; border-radius:.45rem; background:var(--panel-raised); font:650 .72rem var(--mono); }.run-mark.proven { color:var(--status-ok); background:color-mix(in srgb,var(--status-ok) 10%,var(--panel-raised)); }.run-mark.leak { color:var(--status-fail); }.run-mark.unproven { color:var(--status-running); }.run-copy { min-width:0; }.run h3 { margin:0; overflow:hidden; font-size:.68rem; text-overflow:ellipsis; white-space:nowrap; }.run-copy p { margin:.15rem 0; color:var(--muted); font-size:.54rem; }.state { color:var(--muted); font-size:.57rem; line-height:1.4; }.state.leak { color:var(--status-fail); }.state.unproven { color:var(--status-running); }.run details summary,.method summary { width:max-content; color:var(--muted); cursor:pointer; font-size:.57rem; }.seats { grid-column:1/-1; display:flex; flex-wrap:wrap; gap:.35rem; margin-top:.4rem; }.chip { border:1px solid var(--line); border-radius:999px; padding:.2rem .4rem; color:var(--muted); background:transparent; font-size:.53rem; }.chip.proven { color:var(--status-ok); border-color:color-mix(in srgb,var(--status-ok) 35%,var(--line)); }.chip.failed { color:var(--status-fail); }.chip.unproven { color:var(--status-running); }.method { padding-top:.7rem; border-top:1px solid var(--line); }.method p { color:var(--muted); font-size:.58rem; line-height:1.45; }.empty { color:var(--muted); font-size:.68rem; }
@media (max-width:620px) { .teardown-score { grid-template-columns:repeat(2,1fr); }.run { grid-template-columns:2rem minmax(0,1fr); }.run > details { grid-column:2; } }
</style>
