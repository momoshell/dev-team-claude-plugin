<script>
  import { getWorkflows, proposeWorkflowEdit } from './api.js'
  import DiffBlock from './DiffBlock.svelte'
  import { workflowPresentation } from './workflows.js'

  const STAGE_ROLES = Object.freeze({
    plan: 'planner', check: 'planner', scout: 'planner', repair: 'planner',
    build: 'builder', review: 'reviewer', review_only: 'reviewer', verify_only: 'reviewer',
  })

  function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  }

  function seatBearingStages(workflow) {
    const stages = workflow?.declaration?.stages
    if (!Array.isArray(stages)) return []
    return stages.map((stage) => {
      const head = typeof stage === 'string' ? stage.split(':')[0] : ''
      return { name: stage, role: STAGE_ROLES[head] || null }
    }).filter((stage) => typeof stage.name === 'string' && stage.name && stage.role)
  }

  function tierRows(value) {
    return Array.isArray(value?.roster?.tiers)
      ? value.roster.tiers.filter((row) => typeof row?.tier === 'string')
      : []
  }

  function seedCellDraft(workflow, tier, role) {
    const seats = workflow?.tier_maps?.[tier]?.seats
    if (!record(seats) || typeof role !== 'string' || !Object.prototype.hasOwnProperty.call(seats, role) || seats[role] === undefined) return ''
    try { return JSON.stringify(seats[role], null, 2) ?? '' } catch { return '' }
  }

  let payload = $state(null)
  let loading = $state(true)
  let requestError = $state('')
  let selectedWorkflowShape = $state('')
  let selectedTier = $state('')
  let selectedStage = $state('')
  let selectedRole = $state('')
  let cellDraft = $state('')
  let proposal = $state(null)
  let proposalBusy = $state(false)
  let parseError = $state('')
  let copyNotice = $state('')

  $effect(() => {
    let active = true
    getWorkflows(5).then((result) => {
      if (!active) return
      payload = result && typeof result === 'object' ? result : { workflows: [] }
      seedEditor(payload)
      requestError = ''
      loading = false
    }).catch((error) => {
      if (!active) return
      requestError = error?.message || 'workflow request failed without a reason'
      loading = false
    })
    return () => { active = false }
  })

  let workflows = $derived(Array.isArray(payload?.workflows) ? payload.workflows : [])
  let presentations = $derived(workflows.map((workflow) => workflowPresentation(workflow?.shape, {
    observedLabels: Array.isArray(workflow?.observed_labels) ? workflow.observed_labels : [],
  })))
  let tierOptions = $derived(tierRows(payload))
  let selectedWorkflow = $derived(workflows.find((workflow) => workflow?.shape === selectedWorkflowShape) || workflows[0] || null)
  let selectedStages = $derived(seatBearingStages(selectedWorkflow))
  let selectedRoles = $derived([...new Set(selectedStages.map((stage) => stage.role))])
  let selectedTierRow = $derived(tierOptions.find((row) => row.tier === selectedTier) || null)
  let selectedTierSeats = $derived(record(selectedWorkflow?.tier_maps?.[selectedTier]?.seats) ? selectedWorkflow.tier_maps[selectedTier].seats : null)
  let selectedCellPresent = $derived(Boolean(selectedTierRow?.measured === true && record(selectedTierSeats) && typeof selectedRole === 'string' && Object.prototype.hasOwnProperty.call(selectedTierSeats, selectedRole) && selectedTierSeats[selectedRole] !== undefined))
  let editorReady = $derived(Boolean(selectedWorkflow && selectedTier && selectedStage && selectedRole && selectedCellPresent && cellDraft.trim()))

  function resetProposalState() {
    proposal = null
    parseError = ''
    copyNotice = ''
  }

  function setEditorSelection(workflow, tier, stage = null, role = null) {
    const stages = seatBearingStages(workflow)
    const chosenStage = stages.find((entry) => entry.name === stage) || stages[0] || null
    const roles = [...new Set(stages.map((entry) => entry.role))]
    const chosenRole = roles.includes(role) ? role : chosenStage?.role || roles[0] || ''
    selectedWorkflowShape = workflow?.shape || ''
    selectedTier = typeof tier === 'string' ? tier : ''
    selectedStage = chosenStage?.name || ''
    selectedRole = chosenRole
    cellDraft = seedCellDraft(workflow, selectedTier, selectedRole)
    resetProposalState()
  }

  function seedEditor(value) {
    const rows = Array.isArray(value?.workflows) ? value.workflows : []
    const tiers = tierRows(value)
    setEditorSelection(rows[0] || null, tiers[0]?.tier || '')
  }

  function selectWorkflow(event) {
    const workflow = workflows.find((row) => row?.shape === event.currentTarget.value) || null
    setEditorSelection(workflow, tierOptions[0]?.tier || '')
  }

  function selectTier(event) {
    setEditorSelection(selectedWorkflow, event.currentTarget.value, selectedStage, selectedRole)
  }

  function selectStage(event) {
    setEditorSelection(selectedWorkflow, selectedTier, event.currentTarget.value, null)
  }

  function selectRole(event) {
    setEditorSelection(selectedWorkflow, selectedTier, selectedStage, event.currentTarget.value)
  }

  function updateCellDraft(event) {
    cellDraft = event.currentTarget.value
    proposal = null
    parseError = ''
    copyNotice = ''
  }

  async function submitProposal(event) {
    event.preventDefault()
    proposal = null
    parseError = ''
    copyNotice = ''
    let cell
    try { cell = JSON.parse(cellDraft) }
    catch { parseError = 'Cell draft is not valid JSON; enter a JSON object or null.'; return }
    proposalBusy = true
    try {
      proposal = await proposeWorkflowEdit({ workflow: selectedWorkflow, edit: { stage: selectedStage, role: selectedRole, cell }, tier: selectedTier })
      if (!proposal || typeof proposal !== 'object') proposal = { ok: false, refusals: [{ code: 'request', message: 'workflow proposal returned no result' }], diff: null }
    } catch (error) {
      proposal = { ok: false, refusals: [{ code: 'request', message: `workflow proposal request failed: ${error?.message || 'no reason was returned'}` }], diff: null }
    } finally { proposalBusy = false }
  }

  async function copyDiff() {
    if (typeof proposal?.diff !== 'string') { copyNotice = 'No proposal diff is available to copy.'; return }
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('clipboard access is unavailable')
      await navigator.clipboard.writeText(proposal.diff)
      copyNotice = 'Proposal diff copied to the clipboard.'
    } catch (error) {
      copyNotice = `Clipboard access was unavailable; the rendered proposal diff is still available${error?.message ? ` (${error.message})` : ''}.`
    }
  }

  function metadataValue(value) {
    if (Array.isArray(value)) return value.length ? value.join(', ') : 'empty'
    if (value && typeof value === 'object') return JSON.stringify(value)
    if (value == null) return 'not recorded'
    return String(value)
  }
</script>

<main class="page workflows-page">
  <div class="page-heading">
    <div><p class="eyebrow">Workflow catalog</p><h1>Workflows</h1><p>Compare every declared execution shape, its canonical stage order, seats, writes, envelope contract, and recommending task profiles.</p></div>
    <span class="updated">Declarations are authoritative · topology comes from executionTopology</span>
  </div>
  <p class="boundary-note">This page composes a workflow proposal diff for copying; it never dispatches or boots a run, posts a review, applies policy, or writes the proposal.</p>

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

      <section class="proposal-editor" aria-labelledby="workflow-proposal-heading">
        <header class="proposal-heading">
          <div><p class="eyebrow">Proposal editor</p><h2 id="workflow-proposal-heading">Compose a workflow step change</h2><p>Choose a declared workflow, roster tier, seat-bearing stage, and role. The cell stays a JSON draft until you request a proposal diff.</p></div>
          <span class="shape-note">Copyable diff only</span>
        </header>
        {#if !workflows.length}
          <p class="absence">No workflow rows are available for this proposal.</p>
        {:else if !selectedStages.length}
          <p class="absence">No seat-bearing stages are available for this workflow declaration.</p>
        {:else if !tierOptions.length}
          <p class="absence">No roster tiers are available for this workflow proposal.</p>
        {:else if !selectedTierRow}
          <p class="absence">The selected roster tier is unavailable, so no cell can be seeded.</p>
        {:else if selectedTierRow.measured !== true || !selectedTierSeats}
          <p class="absence">The selected roster tier has no measured seat data, so no cell draft can be seeded.</p>
        {:else if !selectedCellPresent}
          <p class="absence">The selected tier has no measured cell for the selected seat role, so no cell draft can be seeded.</p>
        {/if}
        <form class="proposal-form" onsubmit={submitProposal}>
          <div class="proposal-fields">
            <label>Workflow<select value={selectedWorkflowShape} onchange={selectWorkflow} disabled={!workflows.length} required><option value="" disabled>Choose a workflow</option>{#each workflows as workflow (workflow.shape)}<option value={workflow.shape}>{workflow.shape}</option>{/each}</select></label>
            <label>Roster tier<select value={selectedTier} onchange={selectTier} disabled={!tierOptions.length} required><option value="" disabled>Choose a tier</option>{#each tierOptions as tier (tier.tier)}<option value={tier.tier}>{tier.tier}{tier.measured === true ? '' : ' (unmeasured)'}</option>{/each}</select></label>
            <label>Seat-bearing stage<select value={selectedStage} onchange={selectStage} disabled={!selectedStages.length} required><option value="" disabled>Choose a stage</option>{#each selectedStages as stage (stage.name)}<option value={stage.name}>{stage.name}</option>{/each}</select></label>
            <label>Seat role<select value={selectedRole} onchange={selectRole} disabled={!selectedRoles.length} required><option value="" disabled>Choose a role</option>{#each selectedRoles as role (role)}<option value={role}>{role}</option>{/each}</select></label>
          </div>
          <label>Cell JSON<textarea value={cellDraft} oninput={updateCellDraft} rows="10" placeholder="A measured seat cell will be seeded here." disabled={!selectedCellPresent} required></textarea></label>
          <button type="submit" disabled={!editorReady || proposalBusy}>{proposalBusy ? 'Composing…' : 'Compose proposal diff'}</button>
        </form>
        {#if parseError}<p class="editor-error" role="alert">{parseError}</p>{/if}
        {#if proposal}
          <section class="proposal-result" aria-live="polite">
            <h3>Proposal result</h3>
            {#if proposal.diff !== null && proposal.diff !== undefined}
              <h4>Unified diff</h4>
              <DiffBlock text={proposal.diff} empty="(no workflow change)" label="Workflow proposal diff" />
              <button type="button" class="copy-button" onclick={copyDiff}>Copy proposal diff</button>
              {#if copyNotice}<p class:editor-error={copyNotice.startsWith('Clipboard')} class="copy-status" role="status">{copyNotice}</p>{/if}
            {/if}
            {#if proposal.refusals?.length}
              <h4>Refusals</h4>
              <ul>{#each proposal.refusals as refusal (refusal.code || refusal.message)}<li>{refusal.code || 'unknown'}: {refusal.message || 'refusal reason unavailable'}</li>{/each}</ul>
            {:else if proposal.ok}
              <p class="success">Proposal is ready to copy; no checkout file was changed.</p>
            {:else}
              <p class="editor-error">Proposal was refused without a reason.</p>
            {/if}
          </section>
        {/if}
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
.proposal-editor { display:grid; gap:.75rem; margin-top:1rem; border:1px solid var(--line); border-radius:var(--radius); background:var(--panel); padding:1rem; }
.proposal-heading { display:flex; justify-content:space-between; align-items:start; gap:1rem; }
.proposal-heading h2 { margin:.12rem 0 .35rem; font-size:1.1rem; }
.proposal-heading p:not(.eyebrow) { margin:0; color:var(--muted); max-width:44rem; font-size:.72rem; }
.proposal-form { display:grid; gap:.7rem; }
.proposal-fields { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:.7rem; }
.proposal-form label { display:grid; gap:.25rem; color:var(--muted); font-size:.64rem; }
.proposal-form select,.proposal-form textarea { min-width:0; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--bg); color:var(--accent); padding:.5rem .6rem; font:inherit; }
.proposal-form textarea { resize:vertical; font-family:var(--mono); font-size:.68rem; line-height:1.5; }
.proposal-form button[type='submit'],.copy-button { width:max-content; border:1px solid var(--accent); border-radius:var(--radius-sm); background:var(--accent); color:var(--bg); padding:.5rem .75rem; cursor:pointer; }
.proposal-form button[type='submit']:disabled,.copy-button:disabled { cursor:not-allowed; opacity:.55; }
.proposal-result { border-top:1px solid var(--line); padding-top:.7rem; }
.proposal-result h3,.proposal-result h4 { margin:.25rem 0 .35rem; font-size:.76rem; }
.proposal-result h4 { color:var(--muted); font-size:.62rem; letter-spacing:.08em; text-transform:uppercase; }
.proposal-result ul { margin:.25rem 0 0; padding-left:1.1rem; color:var(--status-fail); font-size:.68rem; }
.copy-button { margin-top:.55rem; background:var(--panel-raised); color:var(--accent); }
.copy-status { margin:.45rem 0 0; font-size:.68rem; }
.editor-error { color:var(--status-fail); font-size:.7rem; }
.success { color:var(--status-ok); font-size:.7rem; }
@media (max-width:900px) { .proposal-fields { grid-template-columns:repeat(2,minmax(0,1fr)); } }
@media (max-width:700px) {
  .page-heading { align-items:start; }
  .updated { display:none; }
  .workflow-facts { grid-template-columns:1fr; }
  .workflow-facts .catalog-section { border-bottom:1px solid var(--line); }
  .workflow-facts .catalog-section:last-child { border-bottom:0; }
}
</style>
