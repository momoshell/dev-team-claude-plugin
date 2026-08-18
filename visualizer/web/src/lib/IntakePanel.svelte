<script>
  import { getIntake, getIntakeBrake, setIntakeBrake } from './api.js'
  import { brakePanel, intakeCandidateRows, intakePanel } from './panels.js'

  const candidateNote = 'this is what the loop last recorded per issue, not a live read of the board — an item the loop has not seen in this window does not appear here at all, and its absence is not eligibility'
  let payload = $state({ absent: null, window: null, loop: { state: 'unmeasured', why: '', swept: null, picked: null, parked: null, none: null, first_sweep_at: null, last_sweep_at: null, last_sweep_in_window_at: null }, outcomes: [], picks: [], refusals: { measured: false, absent: null, groups: [], unrecognised: [] }, candidates: { measured: false, absent: 'candidate readout has not been loaded', items: [], unmeasured: candidateNote }, unmeasured: {}, readonly: true })
  let brakePayload = $state({ schema: 1, state: null, measured: false, path: null, checkout: null, read_error: 'brake state has not been read yet', readonly: false })
  let error = $state('')
  let actor = $state('')
  let brakeLoading = $state(false)
  let panel = $derived(intakePanel(error ? { ...payload, absent: error } : payload))
  let candidatePanel = $derived(intakeCandidateRows(error ? { ...payload, candidates: { ...payload.candidates, measured: false, absent: error } } : payload))
  let brake = $derived(brakePanel(brakePayload))

  async function refresh() {
    const intakeResult = await getIntake().catch((err) => ({ error: err.message || 'intake request failed' }))
    if (intakeResult?.error) error = intakeResult.error
    else { payload = intakeResult; error = '' }
    try {
      brakePayload = await getIntakeBrake()
    } catch (err) {
      brakePayload = { ...brakePayload, ok: undefined, state: null, measured: false, read_error: err.message || 'brake request failed' }
    }
  }

  $effect(() => {
    void refresh()
    const timer = setInterval(refresh, 3000)
    return () => clearInterval(timer)
  })

  async function toggleBrake() {
    const claimedActor = actor.trim()
    if (!claimedActor || !brake.actionable || brakeLoading) return
    const engaged = brake.state !== 'engaged'
    brakeLoading = true
    let result = null
    let postError = null
    try {
      result = await setIntakeBrake(engaged, claimedActor)
    } catch (err) {
      postError = err.message || 'brake transition request failed'
    }
    try {
      const read = await getIntakeBrake()
      brakePayload = postError || result?.ok === false
        ? { ...read, ok: false, error: postError || result.error || 'brake transition failed' }
        : read
    } catch (err) {
      brakePayload = { ...brakePayload, ok: false, error: postError || result?.error || err.message || 'brake state could not be re-read', state: null, measured: false, read_error: err.message || 'brake state could not be re-read' }
    } finally {
      brakeLoading = false
    }
  }
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
  <section class="candidates">
    <h3>Candidates</h3>
    {#if candidatePanel.measured}
      {#if candidatePanel.rows.length}
        <div class="candidate-rows">
          {#each candidatePanel.rows as row (row.issue)}
            <article class={`candidate ${row.tone}`}>
              <strong>{row.label}</strong>
              <span>{row.verdict_label}</span>
              <span>reason: {row.reason_label}</span>
              <span class="meta">{row.at_label}</span>
            </article>
          {/each}
        </div>
      {:else}<p class="muted">No issue verdicts were recorded in this window.</p>{/if}
    {:else}
      <p class="muted">{candidatePanel.absent}</p>
      <p class="meta">{candidatePanel.note}</p>
    {/if}
  </section>
  <p class="meta">{panel.window_note}</p>
  <p class="muted">{panel.readonly_note}</p>
  <section class="brake">
    <h3>Intake brake</h3>
    <p class={`brake-state ${brake.tone}`}>{brake.label}</p>
    <p class="meta">{brake.path_label}</p>
    <label class="actor">Actor claim <input bind:value={actor} maxlength="120" required placeholder="who is requesting this transition?" /></label>
    <button type="button" disabled={!actor.trim() || !brake.actionable || brakeLoading} onclick={toggleBrake}>{brakeLoading ? 'Reading brake…' : brake.action_label}</button>
    <p class="meta">{brake.note}</p>
  </section>
</section>
<style>.panel { background:var(--panel); border:1px solid var(--line); border-radius:.6rem; padding:1rem; margin:1rem 0; }.panel h2 { margin-top:0; }.meta, .muted { color:var(--muted); }.why { margin:.45rem 0; }.counts { font-weight:600; }.picks, .groups, .candidate-rows { display:grid; gap:.6rem; }.picks h3, .group h3, .candidates h3, .brake h3 { margin:.25rem 0; }.picks p, .reason { margin:.2rem 0; }.group, .candidates, .brake { border-top:1px solid var(--line); padding-top:.6rem; margin-top:.8rem; }.group .meta, .asserts { margin:.2rem 0; }.reason { display:flex; justify-content:space-between; gap:1rem; }.reason.refused, .candidate.refused, .brake-state.refused { color:#9b1c1c; }.reason.unmeasured, .candidate.unmeasured, .brake-state.unmeasured { color:#7a3e9d; }.group.refused h3 { color:#9b1c1c; }.group.unmeasured h3 { color:#7a3e9d; }.candidate { display:grid; gap:.2rem; border-left:.25rem solid var(--line); padding:.45rem .7rem; background:var(--bg); }.candidate.take { border-color:var(--status-ok); }.candidate.refused { border-color:#9b1c1c; }.candidate.unmeasured { border-color:#7a3e9d; }.brake { display:grid; gap:.5rem; }.brake-state { font-weight:600; margin:.1rem 0; }.actor { display:grid; gap:.25rem; max-width:30rem; }.actor input { font:inherit; padding:.35rem .5rem; border:1px solid var(--line); background:var(--bg); color:inherit; }.brake button { width:max-content; font:inherit; border:1px solid var(--line); background:var(--panel); color:inherit; padding:.35rem .55rem; cursor:pointer; }.brake button:disabled { cursor:not-allowed; opacity:.55; }</style>
