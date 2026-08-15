<script>
  import { getRoster } from './api.js'
  import { rosterPanel } from './panels.js'
  let payload = $state({ tiers: null, models: null, path: null, error: null })
  let error = $state('')
  let panel = $derived(rosterPanel(error ? { ...payload, error } : payload))

  $effect(() => {
    let active = true
    getRoster().then((result) => {
      if (!active) return
      payload = result
      error = ''
    }).catch((err) => {
      if (!active) return
      error = err.message || 'roster request failed'
      payload = { ...payload, tiers: null, models: null }
    })
    return () => { active = false }
  })
</script>
<section class="panel">
  <h2>Roster</h2>
  {#if panel.pending}
    <p class="muted">roster unavailable — {panel.pending}</p>
  {:else}
    <p class="meta">{panel.path || 'runtime roster path unavailable'} · updated {panel.updated_at || '—'}</p>
    <div class="tiers">
      {#each panel.tiers as tier (tier.tier)}
        <article class="tier">
          <h3>{tier.tier}</h3>
          {#each tier.seats as seat (seat.role)}
            <div class="seat">
              <div>{seat.role} · {seat.provider ?? '—'}/{seat.id ?? '—'} · {seat.agent ?? '—'} · {seat.effort ?? '—'}</div>
              {#if seat.model}
                <small>in ${seat.model.cost_in_per_mtok ?? '—'}/Mtok · out ${seat.model.cost_out_per_mtok ?? '—'}/Mtok · verified {seat.model.last_verified ?? '—'}</small>
              {:else}
                <small title={seat.model_pending}>—</small>
              {/if}
            </div>
          {/each}
          {#if tier.unseated?.length}<p class="muted">unseated: {tier.unseated.join(', ')}</p>{/if}
        </article>
      {/each}
    </div>
    <h3>Model catalog</h3>
    <div class="wide">
      <table>
        <thead><tr><th>model</th><th>in/Mtok</th><th>out/Mtok</th><th>context</th><th>tags</th><th>source</th><th>verified</th></tr></thead>
        <tbody>
          {#each panel.models as model (model.key)}
            <tr><td>{model.key}</td><td>{model.cost_in_per_mtok ?? '—'}</td><td>{model.cost_out_per_mtok ?? '—'}</td><td>{model.context ?? '—'}</td><td>{Array.isArray(model.tags) ? model.tags.join(', ') : model.tags ?? '—'}</td><td>{model.source ?? '—'}</td><td>{model.last_verified ?? '—'}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>
<style>
.panel { background:var(--panel); border:1px solid var(--line); border-radius:.6rem; padding:1rem; }.panel h2 { margin-top:0; }.meta, .muted { color:var(--muted); }.tiers { display:grid; gap:.75rem; }.tier { border-top:1px solid var(--line); padding-top:.6rem; }.tier h3 { margin:.1rem 0 .5rem; }.seat { border-top:1px solid var(--line); padding:.45rem 0; }.seat small { color:var(--muted); }.wide { overflow-x:auto; } table { border-collapse:collapse; width:100%; } th, td { border-top:1px solid var(--line); padding:.4rem; text-align:left; white-space:nowrap; }
</style>
