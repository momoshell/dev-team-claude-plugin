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
  let activeGroups = $derived.by(() => panel.groups.map((group) => ({ ...group, rows: group.rows.filter((row) => row.state === 'refused') })).filter((group) => group.rows.length))
  let refusalCount = $derived.by(() => activeGroups.reduce((sum, group) => sum + group.rows.reduce((inner, row) => inner + (Number.parseInt(row.count_label) || 0), 0), 0))

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
  <header class="panel-head"><div><p class="eyebrow">Work supply</p><h2>Intake control</h2><p class="meta">{panel.window_label}</p></div><span class={`state-badge ${panel.tone}`}>{panel.state?.replaceAll('-', ' ') || 'unknown'}</span></header>
  {#if panel.absent}<p class="notice">Intake unavailable — {panel.absent}</p>{/if}
  <div class={`loop-state ${panel.tone}`}><span class="loop-mark" aria-hidden="true"></span><div><strong>{panel.headline}</strong><p>{panel.why}</p><small>{panel.last_sweep_label}</small></div></div>
  <div class="intake-summary"><div><strong>{payload.loop?.swept ?? '—'}</strong><span>sweeps</span></div><div><strong>{payload.loop?.picked ?? '—'}</strong><span>picked</span></div><div><strong>{payload.loop?.parked ?? '—'}</strong><span>parked</span></div><div><strong>{refusalCount}</strong><span>refusals</span></div></div>
  <section class="brake">
    <div class="brake-copy"><p class="eyebrow">Safety control</p><h3>Intake brake</h3><p class={`brake-state ${brake.tone}`}>{brake.state === 'clear' ? 'Clear — new work may enter on the next sweep.' : brake.state === 'engaged' ? 'Engaged — the next sweep will park.' : brake.label}</p></div>
    <div class="brake-action"><label class="actor"><span>Operator name</span><input bind:value={actor} maxlength="120" required placeholder="Required for audit trail" /></label><button class:danger={brake.state !== 'engaged'} type="button" disabled={!actor.trim() || !brake.actionable || brakeLoading} onclick={toggleBrake}>{brakeLoading ? 'Reading brake…' : brake.action_label}</button></div>
  </section>

  <div class="intake-evidence">
    <section>
      <div class="section-title"><h3>Candidate decisions</h3><span>{candidatePanel.measured ? `${candidatePanel.rows.length} seen` : 'unavailable'}</span></div>
      {#if candidatePanel.measured && candidatePanel.rows.length}
        <div class="candidate-rows">{#each candidatePanel.rows.slice(0, 6) as row (row.issue)}<article class={`candidate ${row.tone}`}><span class="verdict">{row.verdict_label}</span><div><strong>{row.label}</strong><small>{row.reason_label} · {row.at_label}</small></div></article>{/each}</div>
      {:else if candidatePanel.measured}<p class="empty">No issue verdicts recorded. This is empty evidence, not proof that the board has no work.</p>
      {:else}<p class="empty">{candidatePanel.absent}</p>{/if}
    </section>
    <section>
      <div class="section-title"><h3>Active refusal reasons</h3><span>{refusalCount} recorded</span></div>
      {#if activeGroups.length}
        <div class="groups">{#each activeGroups as group (group.group)}<article><strong>{group.group}</strong><small>{group.title}</small>{#each group.rows as row}<p><span>{row.label}</span><b>{row.count_label}</b></p>{/each}</article>{/each}</div>
      {:else}<p class="empty">No candidates were refused in this window.</p>{/if}
      {#if panel.unrecognised_rows.length}<p class="notice">{panel.unrecognised_rows.length} unrecognised refusal reason{panel.unrecognised_rows.length === 1 ? '' : 's'} need schema review.</p>{/if}
    </section>
  </div>
  {#if panel.picks.length}<details class="method"><summary>Picked work ({panel.picks.length})</summary>{#each panel.picks as pick}<p>{pick.label}</p>{/each}</details>{/if}
  <details class="method"><summary>Measurement and control notes</summary><p>{candidatePanel.note}</p><p>{panel.window_note}</p><p>{panel.readonly_note}</p><p>{brake.path_label}</p><p>{brake.note}</p></details>
</section>
<style>.panel { min-width:0; background:var(--panel); border:1px solid var(--line); border-radius:var(--radius-lg); padding:1rem; }.panel-head { display:flex; justify-content:space-between; align-items:start; gap:1rem; }.eyebrow { margin:0 0 .22rem; color:var(--muted); font-size:.6rem; font-weight:700; letter-spacing:.13em; text-transform:uppercase; }.panel h2 { margin:0 0 .25rem; font-size:1rem; }.meta { margin:.16rem 0; color:var(--muted); font-size:.6rem; }.state-badge { border:1px solid currentColor; border-radius:2rem; padding:.26rem .48rem; color:var(--muted); font:600 .58rem var(--mono); }.state-badge.working { color:var(--status-ok); }.state-badge.parked,.state-badge.stopped { color:var(--status-running); }.notice { border:1px solid color-mix(in srgb,var(--status-fail) 35%,var(--line)); border-radius:var(--radius-sm); padding:.65rem; color:var(--status-fail); font-size:.64rem; }
.loop-state { display:flex; gap:.7rem; align-items:start; margin:.8rem 0; padding:.8rem; border-radius:var(--radius); background:var(--bg); }.loop-mark { flex:0 0 auto; width:.55rem; height:.55rem; margin-top:.23rem; border-radius:50%; background:var(--muted); }.loop-state.working .loop-mark { background:var(--status-ok); box-shadow:0 0 8px var(--status-ok); }.loop-state.stopped .loop-mark,.loop-state.parked .loop-mark { background:var(--status-running); }.loop-state strong { font-size:.72rem; }.loop-state p { margin:.2rem 0; color:var(--muted); font-size:.62rem; line-height:1.45; }.loop-state small { color:var(--muted); font-size:.55rem; }.intake-summary { display:grid; grid-template-columns:repeat(4,1fr); gap:.5rem; margin-bottom:.8rem; }.intake-summary div { display:grid; gap:.15rem; }.intake-summary strong { font:650 .92rem var(--mono); }.intake-summary span { color:var(--muted); font-size:.55rem; }
.brake { display:grid; grid-template-columns:minmax(0,1fr) minmax(15rem,.8fr); align-items:end; gap:1rem; border:1px solid var(--line); border-radius:var(--radius); padding:.75rem; }.brake h3 { margin:0; font-size:.74rem; }.brake-state { margin:.25rem 0 0; color:var(--muted); font-size:.6rem; }.brake-state.refused { color:var(--status-fail); }.brake-action { display:flex; align-items:end; gap:.45rem; }.actor { min-width:0; display:grid; flex:1; gap:.22rem; }.actor span { color:var(--muted); font-size:.54rem; }.actor input { min-width:0; width:100%; min-height:1.95rem; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--bg); padding:.35rem .45rem; font-size:.62rem; }.brake button { min-height:1.95rem; border:1px solid var(--accent); border-radius:var(--radius-sm); background:var(--accent); color:var(--bg); padding:.35rem .55rem; font-size:.6rem; cursor:pointer; white-space:nowrap; }.brake button.danger { border-color:var(--status-fail); background:transparent; color:var(--status-fail); }.brake button:disabled { cursor:not-allowed; opacity:.45; }
.intake-evidence { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1rem; margin-top:.8rem; }.intake-evidence > section { min-width:0; border-top:1px solid var(--line); padding-top:.7rem; }.section-title { display:flex; justify-content:space-between; gap:.7rem; }.section-title h3 { margin:0; font-size:.67rem; }.section-title span { color:var(--muted); font:500 .54rem var(--mono); }.candidate-rows,.groups { display:grid; margin-top:.45rem; }.candidate { display:grid; grid-template-columns:auto minmax(0,1fr); align-items:start; gap:.5rem; padding:.5rem 0; border-top:1px solid var(--line); }.verdict { border:1px solid currentColor; border-radius:2rem; padding:.18rem .35rem; color:var(--muted); font:500 .5rem var(--mono); }.candidate.take .verdict { color:var(--status-ok); }.candidate.refused .verdict { color:var(--status-fail); }.candidate > div { min-width:0; display:grid; gap:.15rem; }.candidate strong,.groups article > strong { font-size:.6rem; }.candidate small,.groups article > small { color:var(--muted); font-size:.52rem; }.groups article { display:grid; gap:.2rem; padding:.48rem 0; border-top:1px solid var(--line); }.groups p { display:flex; justify-content:space-between; gap:.5rem; margin:.1rem 0; color:var(--muted); font-size:.55rem; }.groups b { color:var(--status-fail); font:500 .52rem var(--mono); }.empty { margin:.65rem 0; color:var(--muted); font-size:.6rem; line-height:1.45; }.method { padding-top:.7rem; border-top:1px solid var(--line); }.method summary { width:max-content; color:var(--muted); cursor:pointer; font-size:.58rem; }.method p { color:var(--muted); font-size:.58rem; line-height:1.45; }
@media (max-width:760px) { .brake,.intake-evidence { grid-template-columns:1fr; } } @media (max-width:480px) { .brake-action { align-items:stretch; flex-direction:column; }.brake button { width:100%; } }
</style>
