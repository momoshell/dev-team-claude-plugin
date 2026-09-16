<script>
  import { getAssurances, proposeAssuranceChange } from './api.js'
  import { assurancePanel } from './panels.js'

  let payload = $state({})
  let loading = $state(true)
  let requestError = $state('')
  let documentDraft = $state('')
  let displayPath = $state('')
  let selectedAssurance = $state('')
  let result = $state(null)
  let shaped = $derived(assurancePanel(payload))

  $effect(() => {
    let active = true
    getAssurances().then((value) => {
      if (!active) return
      payload = value && typeof value === 'object' ? value : {}
      requestError = ''
      loading = false
    }).catch((cause) => {
      if (!active) return
      requestError = cause?.message || 'Assurance policy unavailable — request failed without a reason'
      loading = false
    })
    return () => { active = false }
  })

  async function submitProposal(event) {
    event.preventDefault()
    result = null
    try {
      result = await proposeAssuranceChange(documentDraft, selectedAssurance, displayPath)
    } catch (cause) {
      result = { ok: false, diff: null, wrote: false, refusals: [{ code: 'request', message: cause?.message || 'Assurance proposal request failed without a reason' }] }
    }
  }
</script>

<section class="assurance-page" aria-label="Assurance policy">
  <div class="page-heading">
    <div><p class="eyebrow">Policy readout</p><h1>Assurance presets</h1><p>Review strength is separate from model seating. This page reads the ratified declarations and prepares a caller-supplied lane-request diff.</p></div>
    <span class="updated">Read-only policy · no checkout changes</span>
  </div>

  {#if loading}
    <section class="state-card"><strong>Loading assurance policy</strong><p>Reading preset declarations, model seating floors, and protected paths.</p></section>
  {:else if requestError}
    <section class="state-card degraded"><strong>Assurance policy unavailable</strong><p>{requestError}</p></section>
  {:else}
    <section class="policy-section" aria-labelledby="review-strength-heading">
      <header class="section-heading"><div><p class="eyebrow">Assurance axis</p><h2 id="review-strength-heading">Review strength</h2></div><span class="axis-label">{shaped.assurance_axis}</span></header>
      {#if shaped.assurance_absent && !shaped.presets.length}<p class="unmeasured">{shaped.assurance_absent}</p>{/if}
      <div class="preset-grid">
        {#each shaped.presets as preset, index (preset.key ?? index)}
          <article class="preset-card">
            <header><div><p class="eyebrow">Preset</p><h3>{preset.name || 'Preset name unavailable'}</h3></div><span class="preset-key">{preset.key || 'key unavailable'}</span></header>
            <dl class="facts">
              <div><dt>Alias</dt><dd>{preset.alias || 'Alias unavailable'}</dd></div>
              <div><dt>Description</dt><dd>{preset.description || 'Description unavailable'}</dd></div>
              <div><dt>Ordinal review strength</dt><dd>{preset.rank == null ? 'Ordinal strength unmeasured' : `${preset.rank} of ${shaped.presets.length}`}</dd></div>
            </dl>
            <p class="forcing"><strong>Protected-path rule</strong> {preset.forcing}</p>
          </article>
        {/each}
      </div>
    </section>

    <section class="policy-section" aria-labelledby="model-seating-heading">
      <header class="section-heading"><div><p class="eyebrow">Capability axis</p><h2 id="model-seating-heading">Model seating eligibility</h2></div><span class="axis-label">{shaped.band_floor_axis}</span></header>
      {#if shaped.band_floors}
        <dl class="floor-list">
          {#each Object.entries(shaped.band_floors) as [tier, band] (tier)}<div><dt>{tier}</dt><dd>{band}</dd></div>{/each}
        </dl>
      {:else}
        <p class="unmeasured">{shaped.band_floors_absent}</p>
      {/if}
    </section>

    <section class="policy-section protected-section" aria-labelledby="protected-path-heading">
      <header class="section-heading"><div><p class="eyebrow">Forcing authority</p><h2 id="protected-path-heading">Protected paths</h2></div></header>
      {#if shaped.protected_paths.length}
        <ul class="path-list">{#each shaped.protected_paths as path (path)}<li><code>{path}</code></li>{/each}</ul>
      {:else}
        <p class="unmeasured">Protected path list unavailable — endpoint supplied no paths.</p>
      {/if}
    </section>

    <section class="policy-section proposal-section" aria-labelledby="proposal-heading">
      <header class="section-heading"><div><p class="eyebrow">Caller-supplied preview</p><h2 id="proposal-heading">Prepare a lane-request change</h2><p>Paste canonical JSON to see the one-line assurance change. Formatting is checked, not silently rewritten.</p></div></header>
      <p class="proposal-note">Proposal only — nothing was applied.</p>
      <form class="proposal-form" onsubmit={submitProposal}>
        <label>Lane-request JSON<textarea bind:value={documentDraft} rows="12" placeholder="Paste canonical JSON here" required></textarea></label>
        <div class="proposal-fields">
          <label>Display label (optional)<input bind:value={displayPath} placeholder="request.json" /></label>
          <label>Assurance preset<select bind:value={selectedAssurance} required><option value="" disabled>Choose a preset</option>{#each shaped.presets as preset, index (preset.key ?? index)}<option value={preset.key}>{preset.name || preset.key}</option>{/each}</select></label>
        </div>
        <button type="submit" disabled={!selectedAssurance || !documentDraft}>Prepare proposal</button>
      </form>

      {#if result}
        <section class="proposal-result" aria-live="polite">
          <h3>Proposal result</h3>
          {#if result.diff}<h4>Unified diff</h4><pre>{result.diff}</pre>{/if}
          {#if result.refusals?.length}<h4>Refusals</h4><ul>{#each result.refusals as refusal (refusal.code || refusal.message)}<li>{refusal.code ? `${refusal.code}: ` : ''}{refusal.message}</li>{/each}</ul>{:else if result.ok}<p class="success">Proposal is ready for review; no checkout file was changed.</p>{/if}
        </section>
      {/if}
    </section>
  {/if}
</section>

<style>
.assurance-page { display:grid; gap:1rem; }
.page-heading { display:flex; justify-content:space-between; align-items:end; gap:1rem; }
.page-heading h1 { margin:.1rem 0 .35rem; font-size:clamp(1.7rem,3vw,2.35rem); letter-spacing:-.04em; }
.page-heading p { margin:0; color:var(--muted); max-width:44rem; font-size:.9rem; }
.eyebrow { margin:0 0 .22rem; color:var(--accent); font-size:.66rem; font-weight:700; letter-spacing:.14em; text-transform:uppercase; }
.updated,.axis-label { color:var(--muted); font-size:.7rem; }
.state-card,.policy-section { border:1px solid var(--line); border-radius:var(--radius); background:var(--panel); padding:1rem; }
.state-card p,.unmeasured,.proposal-note { margin:.35rem 0 0; color:var(--muted); font-size:.72rem; }
.state-card.degraded { border-color:color-mix(in srgb,var(--status-escalated) 45%,var(--line)); }
.state-card.degraded p { color:var(--status-escalated); }
.section-heading { display:flex; justify-content:space-between; align-items:start; gap:1rem; margin-bottom:.8rem; }
.section-heading h2 { margin:.1rem 0 0; font-size:1.1rem; }
.section-heading p:not(.eyebrow) { margin:.35rem 0 0; color:var(--muted); font-size:.72rem; max-width:44rem; }
.preset-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:.8rem; }
.preset-card { min-width:0; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--panel-raised); padding:.8rem; }
.preset-card header { display:flex; justify-content:space-between; align-items:start; gap:.7rem; }
.preset-card h3 { margin:0; font-size:.95rem; }
.preset-key { color:var(--muted); font:600 .62rem var(--mono); }
.facts,.floor-list { display:grid; gap:.55rem; margin:1rem 0 0; }
.facts div,.floor-list div { display:grid; gap:.15rem; border-top:1px solid var(--line); padding-top:.5rem; }
.facts dt,.floor-list dt { color:var(--muted); font-size:.59rem; letter-spacing:.08em; text-transform:uppercase; }
.facts dd,.floor-list dd { margin:0; font-size:.7rem; overflow-wrap:anywhere; }
.forcing { margin:1rem 0 0; border-top:1px solid var(--line); padding-top:.6rem; color:var(--accent); font-size:.68rem; line-height:1.45; }
.forcing strong { display:block; margin-bottom:.15rem; color:var(--muted); font-size:.59rem; letter-spacing:.08em; text-transform:uppercase; }
.floor-list { grid-template-columns:repeat(3,minmax(0,1fr)); }
.path-list { display:flex; flex-wrap:wrap; gap:.45rem; margin:0; padding:0; list-style:none; }
.path-list li { border:1px solid var(--line); border-radius:.4rem; background:var(--panel-raised); padding:.4rem .5rem; }
.path-list code { font:600 .62rem var(--mono); overflow-wrap:anywhere; }
.proposal-section { display:grid; gap:.75rem; }
.proposal-section .section-heading { margin-bottom:0; }
.proposal-form { display:grid; gap:.7rem; }
.proposal-form label { display:grid; gap:.25rem; color:var(--muted); font-size:.64rem; }
.proposal-fields { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.7rem; }
input,select,textarea { min-width:0; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--bg); color:inherit; padding:.5rem .6rem; font:inherit; }
textarea { resize:vertical; font-family:var(--mono); font-size:.68rem; line-height:1.5; }
button[type='submit'] { width:max-content; border:1px solid var(--accent); border-radius:var(--radius-sm); background:var(--accent); color:var(--bg); padding:.5rem .75rem; cursor:pointer; }
button[type='submit']:disabled { cursor:not-allowed; opacity:.55; }
.proposal-result { border-top:1px solid var(--line); padding-top:.7rem; }
.proposal-result h3,.proposal-result h4 { margin:.25rem 0 .35rem; font-size:.76rem; }
.proposal-result h4 { color:var(--muted); font-size:.62rem; letter-spacing:.08em; text-transform:uppercase; }
.proposal-result pre { overflow:auto; margin:0; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--bg); padding:.7rem; white-space:pre-wrap; font: .65rem/1.5 var(--mono); }
.proposal-result ul { margin:.25rem 0 0; padding-left:1.1rem; color:var(--status-fail); font-size:.68rem; }
.success { color:var(--status-ok); font-size:.7rem; }
@media (max-width:900px) { .preset-grid { grid-template-columns:1fr; } .floor-list { grid-template-columns:1fr; } }
@media (max-width:620px) { .page-heading,.section-heading { align-items:start; flex-direction:column; } .proposal-fields { grid-template-columns:1fr; } .updated { display:none; } }
</style>
