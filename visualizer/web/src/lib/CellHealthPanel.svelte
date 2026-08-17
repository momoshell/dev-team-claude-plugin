<script>
  import { getCellHealth } from './api.js'
  import { cellHealthPanel } from './panels.js'
  let payload = $state({ absent: null, silent_unknown: null, window: null, cells: [] })
  let error = $state('')
  let panel = $derived(cellHealthPanel(error ? { ...payload, absent: error } : payload))

  $effect(() => {
    let active = true
    getCellHealth().then((result) => {
      if (!active) return
      payload = result
      error = ''
    }).catch((err) => {
      if (!active) return
      error = err.message || 'cell health request failed'
    })
    return () => { active = false }
  })
</script>
<section class="panel">
  <h2>Cell health</h2>
  <p class="meta">{panel.window_label}</p>
  <p class="muted">{panel.note}</p>
  {#if panel.absent}
    <p class="muted">cell health unavailable — {panel.absent}</p>
  {/if}
  {#if panel.silent_unknown && !panel.absent}<p class="muted">{panel.silent_unknown}</p>{/if}
  {#if panel.rows.length || !panel.absent}
    <div class="cells">
      {#each panel.rows as row (row.key)}
        <article class={`cell ${row.tone}`}>
          <h3>{row.title}</h3>
          <p class="meta">model: {row.model_label}</p>
          <p class="meta">roles: {row.roles_label} · tiers: {row.tiers_label}</p>
          {#if row.price_label}<p class="meta">price: {row.price_label}</p>{:else if row.price_pending}<p class="muted">price: {row.price_pending}</p>{/if}
          <p class={`state ${row.tone}`}>{row.label}</p>
          {#if row.state !== 'silent' && row.state !== 'undetermined'}
            <div class="counts"><span>failures {row.failures}</span><span>run-less {row.run_less}</span><span>in run {row.in_run}</span></div>
          {/if}
          {#if row.kinds.length}
            <div class="kinds">{#each row.kinds as kind (kind.kind)}<span class="chip">{kind.label}</span>{/each}</div>
          {/if}
          <small class="muted">first {row.first_at || '—'} · last {row.last_at || '—'}</small>
        </article>
      {:else}
        <p class="muted">no cells recorded</p>
      {/each}
    </div>
  {/if}
</section>
<style>
.panel { background:var(--panel); border:1px solid var(--line); border-radius:.6rem; padding:1rem; }.panel h2 { margin-top:0; }.meta, .muted { color:var(--muted); }.cells { display:grid; gap:.75rem; }.cell { border-top:1px solid var(--line); padding-top:.6rem; }.cell h3 { margin:.1rem 0 .35rem; }.state { margin:.4rem 0; font-weight:600; }.state.silent { color:var(--muted); }.state.undetermined { color:#7a3e9d; }.state.run-less { color:#9a6700; }.state.recorded { color:#176b3a; }.counts, .kinds { display:flex; flex-wrap:wrap; gap:.45rem; margin:.45rem 0; }.counts span, .chip { border:1px solid var(--line); border-radius:999px; padding:.2rem .5rem; font-size:.9rem; }.cell small { display:block; }
</style>
