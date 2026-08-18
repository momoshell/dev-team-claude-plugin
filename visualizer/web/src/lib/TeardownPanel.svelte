<script>
  import { getSeatTeardowns } from './api.js'
  import { teardownPanel } from './panels.js'
  let payload = $state({ absent: null, measured: false, window: null, runs: [], totals: null })
  let error = $state('')
  let panel = $derived(teardownPanel(error ? { ...payload, absent: error } : payload))

  $effect(() => {
    let active = true
    getSeatTeardowns().then((result) => {
      if (!active) return
      payload = result
      error = ''
    }).catch((err) => {
      if (!active) return
      error = err.message || 'seat teardown request failed'
    })
    return () => { active = false }
  })
</script>
<section class="panel">
  <h2 class={`headline ${panel.tone}`}>{panel.headline}</h2>
  <p class="meta">{panel.window_label}</p>
  <p class="muted">{panel.note}</p>
  {#if panel.absent}<p class="muted">seat teardown unavailable — {panel.absent}</p>{/if}
  <p class="counts">{panel.totals_label}</p>
  <p class="meta">{panel.window_note}</p>
  <div class="runs">
    {#each panel.rows as row (row.adw_id)}
      <article class={`run ${row.tone}`}>
        <h3>{row.run_label}</h3>
        <p class="meta">{row.task_slug || '—'} · {row.at || '—'}</p>
        <p class={`state ${row.tone}`}>{row.label}</p>
        {#if row.seats.length}
          <div class="seats">
            {#each row.seats as seat (seat.role)}<span class={`chip ${seat.tone}`} title={seat.at || undefined}>{seat.label}</span>{/each}
          </div>
        {/if}
      </article>
    {:else}
      <p class="muted">no runs in this window</p>
    {/each}
  </div>
</section>
<style>
.panel { background:var(--panel); border:1px solid var(--line); border-radius:.6rem; padding:1rem; margin:1rem 0; }.panel h2 { margin-top:0; }.meta, .muted { color:var(--muted); }.headline, .state { font-weight:600; }.counts { font-weight:600; }.runs { display:grid; gap:.65rem; }.run { border-top:1px solid var(--line); padding-top:.6rem; }.run h3 { margin:.1rem 0 .35rem; }.state { margin:.4rem 0; }.seats { display:flex; flex-wrap:wrap; gap:.45rem; }.chip { border:1px solid currentColor; border-radius:999px; padding:.2rem .5rem; font-size:.9rem; }.proven { color:var(--status-ok); }.failed, .leak { color:var(--status-fail); }.unproven { color:var(--status-running); }.not-measured, .undetermined, .unrecognised { color:var(--muted); }.run.not-measured, .run.undetermined { border-color:var(--muted); }
</style>
