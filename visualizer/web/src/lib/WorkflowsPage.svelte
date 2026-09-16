<script>
  import { getWorkflows } from './api.js'
  import { workflowPresentation } from './workflows.js'

  let payload = $state(null)
  let loading = $state(true)
  let requestError = $state('')

  $effect(() => {
    let active = true
    getWorkflows(5).then((result) => {
      if (!active) return
      payload = result && typeof result === 'object' ? result : { workflows: [] }
      requestError = ''
      loading = false
    }).catch((error) => {
      if (!active) return
      requestError = error?.message || 'workflow request failed'
      loading = false
    })
    return () => { active = false }
  })

  let workflows = $derived(Array.isArray(payload?.workflows) ? payload.workflows : [])
  let presentations = $derived(workflows.map((workflow) => workflowPresentation(workflow?.shape, {
    observedLabels: Array.isArray(workflow?.observed_labels) ? workflow.observed_labels : [],
  })))

  function metadataValue(value) {
    if (Array.isArray(value)) return value.length ? value.join(', ') : 'empty'
    if (value && typeof value === 'object') return JSON.stringify(value)
    if (value == null) return 'not recorded'
    return String(value)
  }
</script>

<main class="page workflows-page">
  <div class="page-heading">
    <div><p class="eyebrow">Read-only catalog</p><h1>Workflows</h1><p>Compare every declared execution shape, its canonical stage order, seats, writes, envelope contract, and recommending task profiles.</p></div>
    <span class="updated">Declarations are authoritative · topology comes from executionTopology</span>
  </div>
  <p class="boundary-note">Read-only catalog. This page has no editing, compose, dispatch, apply, or post action.</p>

  {#if loading}
    <section class="state-card"><strong>Loading workflows</strong><p>Reading the declared workflow catalog.</p></section>
  {:else if requestError}
    <section class="state-card degraded"><strong>Workflow catalog unavailable</strong><p>{requestError}</p></section>
  {:else}
    {#if payload?.degraded}
      <p class="degraded-note" role="status">Workflow declarations are shown; supporting evidence is degraded{#if payload?.error}: {payload.error}{/if}.</p>
    {/if}
    {#if !workflows.length}
      <section class="state-card"><strong>No workflows declared</strong><p>The workflow declaration feed returned no shapes, so no catalog facts can be displayed.</p></section>
    {:else}
      <section class="workflow-catalog" aria-label="All declared workflows">
        {#each presentations as presentation (presentation.shape)}
          <article class="workflow-card" aria-labelledby={`workflow-${presentation.shape}`}>
            <header class="workflow-heading">
              <div><p class="eyebrow">Execution shape</p><h2 id={`workflow-${presentation.shape}`}>{presentation.shape || 'undeclared'}</h2></div>
              <span class="shape-note">Canonical declaration</span>
            </header>

            <section class="catalog-section stages-section" aria-labelledby={`workflow-${presentation.shape}-stages`}>
              <h3 id={`workflow-${presentation.shape}-stages`}>Stage order</h3>
              {#if presentation.stages.length}
                <ol class="stage-order">
                  {#each presentation.stages as stage (stage.position)}
                    <li><span class="stage-position">{stage.position}</span><strong>{stage.name}</strong></li>
                  {/each}
                </ol>
              {:else}
                <p class="absence">No canonical stages are available for this workflow shape.</p>
              {/if}
            </section>

            <div class="workflow-facts">
              <section class="catalog-section" aria-labelledby={`workflow-${presentation.shape}-seats`}>
                <h3 id={`workflow-${presentation.shape}-seats`}>Seats</h3>
                {#if presentation.seats.items.length}
                  <ul class="fact-list">
                    {#each presentation.seats.items as role (role)}<li><strong>{role}</strong></li>{/each}
                  </ul>
                {:else}
                  <p class="absence">{presentation.seats.absence_reason}</p>
                {/if}
              </section>

              <section class="catalog-section" aria-labelledby={`workflow-${presentation.shape}-writes`}>
                <h3 id={`workflow-${presentation.shape}-writes`}>Writes</h3>
                {#if presentation.writes.value == null}
                  <p class="absence">{presentation.writes.absence_reason}</p>
                {:else}
                  <p class="fact-value mono">{metadataValue(presentation.writes.value)}</p>
                {/if}
              </section>
            </div>

            <section class="catalog-section envelope-section" aria-labelledby={`workflow-${presentation.shape}-envelope`}>
              <h3 id={`workflow-${presentation.shape}-envelope`}>Envelope fields</h3>
              {#if presentation.envelope_fields.items.length}
                <div class="envelope-list">
                  {#each presentation.envelope_fields.items as field (field.name)}
                    <article class="envelope-field">
                      <header><strong>{field.name}</strong><span>{field.kind || 'kind unavailable'}</span></header>
                      <dl class="metadata-list">
                        <div><dt>Kind</dt><dd>{metadataValue(field.kind)}</dd></div>
                        {#if field.values !== undefined}<div><dt>Values</dt><dd>{metadataValue(field.values)}</dd></div>{/if}
                        {#if field.item_fields !== undefined}<div><dt>Item fields</dt><dd>{metadataValue(field.item_fields)}</dd></div>{/if}
                        {#if field.optional_item_fields !== undefined}<div><dt>Optional item fields</dt><dd>{metadataValue(field.optional_item_fields)}</dd></div>{/if}
                        {#if field.item_values !== undefined}<div><dt>Item values</dt><dd>{metadataValue(field.item_values)}</dd></div>{/if}
                        {#if field.item_patterns !== undefined}<div><dt>Item patterns</dt><dd>{metadataValue(field.item_patterns)}</dd></div>{/if}
                        {#if field.cardinality !== undefined}<div><dt>Cardinality</dt><dd>{metadataValue(field.cardinality)}</dd></div>{/if}
                        {#if field.covers !== undefined}<div><dt>Covers</dt><dd>{metadataValue(field.covers)}</dd></div>{/if}
                        {#if field.allow_empty !== undefined}<div><dt>Allow empty</dt><dd>{metadataValue(field.allow_empty)}</dd></div>{/if}
                      </dl>
                    </article>
                  {/each}
                </div>
              {:else}
                <p class="absence">{presentation.envelope_fields.absence_reason}</p>
              {/if}
            </section>

            <section class="catalog-section" aria-labelledby={`workflow-${presentation.shape}-profiles`}>
              <h3 id={`workflow-${presentation.shape}-profiles`}>Recommending profiles</h3>
              {#if presentation.recommended_profiles.items.length}
                <ul class="profile-list">
                  {#each presentation.recommended_profiles.items as profile (profile.key)}
                    <li><strong>{profile.name}</strong><span class="mono">{profile.key}</span></li>
                  {/each}
                </ul>
              {:else}
                <p class="absence">{presentation.recommended_profiles.absence_reason}</p>
              {/if}
            </section>
          </article>
        {/each}
      </section>
    {/if}
  {/if}
</main>

<style>
.workflows-page { padding-top:2rem; }
.page-heading { display:flex; justify-content:space-between; align-items:end; gap:1rem; margin-bottom:1rem; }
.page-heading h1 { margin:.1rem 0 .35rem; font-size:clamp(1.7rem,3vw,2.35rem); letter-spacing:-.04em; }
.page-heading p { margin:0; color:var(--muted); max-width:46rem; font-size:.9rem; }
.eyebrow { color:var(--accent); font-size:.66rem; font-weight:700; letter-spacing:.14em; text-transform:uppercase; }
.updated,.shape-note { color:var(--muted); font-size:.7rem; }
.boundary-note { margin:0 0 1rem; border:1px dashed var(--accent); border-radius:var(--radius); padding:.7rem .8rem; color:var(--muted); font-size:.7rem; }
.degraded-note { margin:0 0 1rem; border:1px solid var(--status-escalated); border-radius:var(--radius); padding:.7rem .8rem; color:var(--status-escalated); font-size:.7rem; }
.workflow-catalog { display:grid; grid-template-columns:repeat(auto-fit,minmax(20rem,1fr)); gap:1rem; align-items:start; }
.workflow-card,.state-card { min-width:0; border:1px solid var(--line); border-radius:var(--radius); background:var(--panel); }
.workflow-card { overflow:hidden; }
.workflow-heading { display:flex; justify-content:space-between; align-items:start; gap:1rem; padding:1rem; border-bottom:1px solid var(--line); }
.workflow-heading h2 { margin:.12rem 0 0; color:var(--accent); font-size:1.15rem; }
.workflow-heading .eyebrow { margin:0; }
.catalog-section { min-width:0; padding:1rem; border-bottom:1px solid var(--line); }
.catalog-section:last-child { border-bottom:0; }
.catalog-section h3 { margin:0 0 .65rem; color:var(--accent); font-size:.72rem; letter-spacing:.08em; text-transform:uppercase; }
.workflow-facts { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); border-bottom:1px solid var(--line); }
.workflow-facts .catalog-section { border-bottom:0; }
.stage-order,.fact-list,.profile-list { display:grid; gap:.35rem; margin:0; padding:0; list-style:none; }
.stage-order li { display:grid; grid-template-columns:2rem minmax(0,1fr); align-items:center; gap:.45rem; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--panel-raised); padding:.4rem .5rem; }
.stage-order strong { overflow-wrap:anywhere; font-size:.7rem; }
.stage-position { display:grid; width:1.45rem; height:1.45rem; place-items:center; border-radius:50%; background:var(--accent); color:var(--bg); font:700 .62rem var(--mono); }
.fact-list li,.profile-list li { display:flex; justify-content:space-between; gap:.7rem; border-top:1px solid var(--line); padding:.45rem 0; font-size:.7rem; }
.fact-list li:first-child,.profile-list li:first-child { border-top:0; padding-top:0; }
.fact-list strong { color:var(--accent); }
.profile-list strong { overflow-wrap:anywhere; }
.profile-list span { color:var(--muted); font-size:.62rem; }
.fact-value { margin:0; color:var(--accent); font-size:.75rem; }
.envelope-list { display:grid; gap:.65rem; }
.envelope-field { min-width:0; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--panel-raised); padding:.65rem; }
.envelope-field header { display:flex; justify-content:space-between; align-items:start; gap:.7rem; margin-bottom:.5rem; }
.envelope-field header strong { overflow-wrap:anywhere; color:var(--accent); font-size:.72rem; }
.envelope-field header span { color:var(--neutral); font:600 .58rem var(--mono); text-transform:uppercase; }
.metadata-list { display:grid; gap:.35rem; margin:0; }
.metadata-list div { display:grid; grid-template-columns:minmax(6rem,max-content) minmax(0,1fr); gap:.55rem; border-top:1px solid var(--line); padding-top:.35rem; }
.metadata-list dt { color:var(--muted); font-size:.58rem; text-transform:uppercase; letter-spacing:.05em; }
.metadata-list dd { min-width:0; margin:0; overflow-wrap:anywhere; color:var(--accent); font: .61rem/1.4 var(--mono); }
.absence { margin:0; color:var(--muted); font-size:.68rem; line-height:1.45; }
.mono { font-family:var(--mono); }
.state-card { max-width:42rem; margin:3rem auto; padding:1.4rem; text-align:center; }
.state-card strong { color:var(--accent); }
.state-card p { color:var(--muted); font-size:.75rem; }
.state-card.degraded { border-color:var(--status-escalated); }
@media (max-width:700px) {
  .page-heading { align-items:start; }
  .updated { display:none; }
  .workflow-facts { grid-template-columns:1fr; }
  .workflow-facts .catalog-section { border-bottom:1px solid var(--line); }
  .workflow-facts .catalog-section:last-child { border-bottom:0; }
}
</style>
