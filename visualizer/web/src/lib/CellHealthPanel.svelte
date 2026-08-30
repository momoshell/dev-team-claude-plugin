<script>
  import { getCellHealth } from './api.js'
  import { PANEL_REFRESH_MS, cellHealthPanel, panelReadLoop } from './panels.js'
  let payload = $state({ absent: null, silent_unknown: null, window: null, cells: [] })
  let error = $state('')
  let read_at = $state(null)
  let now = $state(null)
  let panel = $derived(cellHealthPanel(error ? { ...payload, absent: error } : payload, { read_at, now, refresh_ms: PANEL_REFRESH_MS }))
  let totals = $derived.by(() => ({
    failures: panel.rows.reduce((sum, row) => sum + (Number(row.failures) || 0), 0),
    affected: panel.rows.filter((row) => (Number(row.failures) || 0) > 0).length,
    quiet: panel.rows.filter((row) => row.state === 'silent').length,
  }))

  $effect(() => {
    let active = true
    const stop = panelReadLoop(() => {
      now = Date.now()
      getCellHealth().then((result) => {
        if (!active) return
        payload = result
        error = ''
        read_at = Date.now()
        now = read_at
      }).catch((err) => {
        if (!active) return
        error = err.message || 'cell health request failed'
      })
    }, { refresh_ms: PANEL_REFRESH_MS })
    return () => { active = false; stop() }
  })
</script>
<section class="panel cell-panel">
  <header class="panel-head">
    <div><p class="eyebrow">Reliability</p><h2>Model cells</h2><p class="meta">{panel.window_label}</p></div>
    <span class={`state-badge ${totals.failures ? 'watch' : 'clear'}`}>{totals.failures ? `${totals.failures} failures` : 'no failures'}</span>
  </header>
  <div class="summary">
    <div><strong>{panel.rows.length}</strong><span>seated cells</span></div>
    <div><strong>{totals.affected}</strong><span>affected</span></div>
    <div><strong>{totals.quiet}</strong><span>without failures</span></div>
  </div>
  <p class={`meta read-age ${panel.freshness.stale ? 'stale' : 'fresh'}`}>{panel.freshness.label} · {panel.freshness.refresh_label}</p>
  {#if panel.absent}
    <p class="notice">Cell health unavailable — {panel.absent}</p>
  {/if}
  {#if panel.silent_unknown && !panel.absent}<p class="notice">{panel.silent_unknown}</p>{/if}
  {#if panel.rows.length || !panel.absent}
    <div class="cells">
      {#each panel.rows as row (row.key)}
        <article class={`cell ${row.tone}`}>
          <div class="cell-main"><span class={`cell-mark ${row.tone}`}>{row.failures ?? '—'}</span><div><h3>{row.model_label}</h3><p>{row.roles_label} · assurance {row.tiers_label}</p></div></div>
          <div class="cell-result"><span class={`state ${row.tone}`}>{row.state === 'silent' ? 'clear window' : row.state === 'recorded' ? `${row.in_run} in-run failures` : row.state}</span>{#if row.kinds.length}<small>{row.kinds.map((kind) => kind.label).join(' · ')}</small>{:else}<small>No failure kinds recorded</small>{/if}</div>
          <details><summary>Evidence and pricing</summary><p>{row.label}</p><p>First {row.first_at || '—'} · last {row.last_at || '—'}</p>{#if row.price_label}<p>{row.price_label}</p>{:else if row.price_pending}<p>{row.price_pending}</p>{/if}</details>
        </article>
      {:else}
        <p class="empty">No cells recorded.</p>
      {/each}
    </div>
  {/if}
  <details class="method"><summary>How to read this</summary><p>{panel.note}</p></details>
</section>
<style>
.panel { min-width:0; background:var(--panel); border:1px solid var(--line); border-radius:var(--radius-lg); padding:1rem; }.panel-head { display:flex; justify-content:space-between; align-items:start; gap:1rem; }.eyebrow { margin:0 0 .22rem; color:var(--muted); font-size:.6rem; font-weight:700; letter-spacing:.13em; text-transform:uppercase; }.panel h2 { margin:0 0 .25rem; font-size:1rem; }.meta { margin:.16rem 0; color:var(--muted); font-size:.6rem; }.state-badge { border:1px solid currentColor; border-radius:2rem; padding:.26rem .48rem; font:600 .58rem var(--mono); }.state-badge.watch { color:var(--status-fail); }.state-badge.clear { color:var(--status-ok); }
.summary { display:grid; grid-template-columns:repeat(3,1fr); gap:.5rem; margin:1rem 0 .75rem; padding:.75rem; border-radius:var(--radius); background:var(--bg); }.summary div { display:grid; gap:.18rem; }.summary strong { font:650 1rem var(--mono); }.summary span { color:var(--muted); font-size:.56rem; }.read-age { margin-bottom:.7rem; }.read-age.stale { color:var(--status-fail); font-weight:600; }.notice { border:1px solid color-mix(in srgb,var(--status-fail) 35%,var(--line)); border-radius:var(--radius-sm); padding:.65rem; color:var(--status-fail); font-size:.68rem; }
.cells { display:grid; }.cell { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:.7rem; align-items:center; padding:.67rem 0; border-top:1px solid var(--line); }.cell-main { min-width:0; display:flex; align-items:center; gap:.65rem; }.cell-mark { flex:0 0 auto; width:2rem; height:2rem; display:grid; place-items:center; border-radius:.48rem; background:var(--panel-raised); color:var(--muted); font:650 .72rem var(--mono); }.cell-mark.recorded { color:var(--status-fail); background:color-mix(in srgb,var(--status-fail) 10%,var(--panel-raised)); }.cell-main > div { min-width:0; }.cell h3 { margin:0; overflow:hidden; text-overflow:ellipsis; font-size:.7rem; white-space:nowrap; }.cell p { margin:.14rem 0 0; color:var(--muted); font-size:.57rem; }.cell-result { display:grid; justify-items:end; gap:.18rem; }.state { font:600 .58rem var(--mono); }.state.recorded,.state.run-less { color:var(--status-fail); }.state.silent { color:var(--status-ok); }.state.undetermined { color:var(--status-running); }.cell-result small { max-width:14rem; overflow:hidden; color:var(--muted); font-size:.55rem; text-overflow:ellipsis; white-space:nowrap; }.cell > details { grid-column:1/-1; padding-left:2.65rem; }.cell details summary,.method summary { width:max-content; color:var(--muted); cursor:pointer; font-size:.58rem; }.cell details p,.method p { color:var(--muted); font-size:.6rem; line-height:1.45; }.method { padding-top:.7rem; border-top:1px solid var(--line); }.empty { color:var(--muted); font-size:.68rem; }
@media (max-width:620px) { .cell { grid-template-columns:1fr; }.cell-result { justify-items:start; padding-left:2.65rem; }.cell > details { padding-left:2.65rem; } }
</style>
