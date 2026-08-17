<script>
  import { getIntake } from './api.js'
  import { intakePanel } from './panels.js'
  let payload = $state({ absent: null, window: null, loop: { state: 'unmeasured', why: '', swept: null, picked: null, parked: null, none: null, first_sweep_at: null, last_sweep_at: null, last_sweep_in_window_at: null }, outcomes: [], picks: [], refusals: { measured: false, absent: null, groups: [], unrecognised: [] }, unmeasured: {}, readonly: true })
  let error = $state('')
  let panel = $derived(intakePanel(error ? { ...payload, absent: error } : payload))

  $effect(() => {
    let active = true
    getIntake().then((result) => {
      if (!active) return
      payload = result
      error = ''
    }).catch((err) => {
      if (!active) return
      error = err.message || 'intake request failed'
    })
    return () => { active = false }
  })
</script>
<section class="panel">
  <h2 class={`headline ${panel.tone}`}>{panel.headline}</h2>
  <p class="why">{panel.why}</p>
  <p class="meta">{panel.window_label}</p>
  {#if panel.absent}<p class="muted">intake unavailable — {panel.absent}</p>{/if}
  <p class="counts">{panel.counts_label}</p>
  <p class="meta">{panel.last_sweep_label}</p>
  {#if panel.picks.length}
    <div class="picks">
      <h3>Picks</h3>
      {#each panel.picks as pick}<p>{pick.label}</p>{/each}
    </div>
  {/if}
  <div class="groups">
    {#each panel.groups as group (group.group)}
      <section class={`group ${group.tone}`}>
        <h3>{group.group}</h3>
        <p class="meta">{group.title}</p>
        <p class="asserts">{group.asserts}</p>
        <div class="reasons">
          <!-- Unkeyed deliberately. A reason is NOT unique within a group: a parked
               sweep and a refusal can carry the same reason, and the rows must stay
               unmerged, so keying on it throws a duplicate-key error at render. The
               unrecognised-rows loop below is unkeyed for the same reason. -->
          {#each group.rows as row}<p class={`reason ${row.tone}`}><span>{row.label}</span> <span class="meta">{row.count_label}</span></p>{/each}
        </div>
      </section>
    {/each}
    {#if panel.unrecognised_rows.length}
      <section class="group unrecognised">
        <h3>unrecognised</h3>
        {#each panel.unrecognised_rows as row}<p class={`reason ${row.tone}`}><span>{row.label}</span> <span class="meta">{row.count_label}</span></p>{/each}
      </section>
    {/if}
  </div>
  <p class="meta">{panel.window_note}</p>
  <p class="muted">{panel.readonly_note}</p>
</section>
<style>.panel { background:var(--panel); border:1px solid var(--line); border-radius:.6rem; padding:1rem; margin:1rem 0; }.panel h2 { margin-top:0; }.meta, .muted { color:var(--muted); }.why { margin:.45rem 0; }.counts { font-weight:600; }.picks, .groups { display:grid; gap:.6rem; }.picks h3, .group h3 { margin:.25rem 0; }.picks p, .reason { margin:.2rem 0; }.group { border-top:1px solid var(--line); padding-top:.6rem; }.group .meta, .asserts { margin:.2rem 0; }.reason { display:flex; justify-content:space-between; gap:1rem; }.reason.refused { color:#9b1c1c; }.reason.unmeasured { color:#7a3e9d; }.group.refused h3 { color:#9b1c1c; }.group.unmeasured h3 { color:#7a3e9d; }</style>
