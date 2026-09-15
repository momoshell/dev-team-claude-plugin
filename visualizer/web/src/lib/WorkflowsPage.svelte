<script>
  import { getWorkflows, proposeWorkflowEdit } from './api.js'
  import { draftTopologyEdit, inspectWorkflowNode, layoutWorkflowGraph, shapeWorkflowGraph, validateTopologyEdit } from './workflows.js'
  import WorkflowGraph from './WorkflowGraph.svelte'

  let payload = $state(null)
  let loading = $state(true)
  let requestError = $state('')
  let selectedShape = $state('')
  let selectedTier = $state('')
  let selectedNodeId = $state(null)
  let topologyDraft = $state(null)
  let topologyVerdict = $state(null)
  let proposal = $state(null)
  let seatDrafts = $state({})

  $effect(() => {
    let active = true
    getWorkflows(5).then((result) => {
      if (!active) return
      payload = result
      const firstShape = result?.workflows?.[0]?.shape || result?.shapes?.[0]?.shape || ''
      const firstTier = result?.roster?.tiers?.[0]?.tier || result?.tiers?.[0]?.tier || ''
      if (!selectedShape) selectedShape = firstShape
      if (!selectedTier) selectedTier = firstTier
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
  let tiers = $derived(Array.isArray(payload?.roster?.tiers) ? payload.roster.tiers : Array.isArray(payload?.tiers) ? payload.tiers : [])
  let selectedWorkflow = $derived(workflows.find((workflow) => workflow.shape === selectedShape) || workflows[0] || null)
  let tierMap = $derived(selectedWorkflow?.tier_maps?.[selectedTier] || null)
  let selectedMap = $derived(selectedWorkflow?.source === 'workflow-map' ? selectedWorkflow.map : tierMap || selectedWorkflow?.map || null)
  let graph = $derived(layoutWorkflowGraph(shapeWorkflowGraph(selectedWorkflow?.shape || selectedShape, {
    observedLabels: selectedWorkflow?.observed_labels || [],
    workflow: selectedMap,
    tier: selectedTier,
    roster: payload?.roster,
    docs: payload?.docs || {},
    bootSeats: selectedWorkflow?.boot_seats || {},
  })))
  let selectedNode = $derived(graph?.nodes?.find((node) => node.id === selectedNodeId) || graph?.nodes?.[0] || null)
  let inspection = $derived(inspectWorkflowNode(graph, selectedNode?.id, {
    docs: payload?.docs || {},
    recentRuns: selectedWorkflow?.recent_runs || [],
  }))
  let seatRoles = $derived(Object.keys(selectedWorkflow?.seats || selectedMap?.seats || {}).filter((role) => role))

  function chooseNode(node) { selectedNodeId = node?.id || null }
  function beginTopology(stage) {
    topologyDraft = draftTopologyEdit({ shape: selectedShape, stage, action: 'toggle' })
    topologyVerdict = validateTopologyEdit(topologyDraft)
  }
  function updateSeat(role, field, value) {
    seatDrafts = { ...seatDrafts, [role]: { ...(seatDrafts[role] || {}), [field]: value } }
  }
  async function proposeSeat(role) {
    const current = selectedMap?.seats?.[role] || selectedWorkflow?.seats?.[role] || {}
    const edit = { role, cell: { ...current, ...(seatDrafts[role] || {}) } }
    proposal = null
    try { proposal = await proposeWorkflowEdit(selectedShape, edit) } catch (error) { proposal = { ok: false, refusals: [{ code: 'request', message: error?.message || 'proposal request failed' }] } }
  }
</script>

<main class="page workflows-page">
  <div class="page-heading">
    <div><p class="eyebrow">Read-only topology</p><h1>Workflows</h1><p>Inspect executor order, measured evidence, and the patch a seat edit would propose. Nothing is applied from this view.</p></div>
    <span class="updated">Declarations are bounds · validator pending</span>
  </div>

  {#if loading}
    <section class="state-card"><strong>Loading workflows</strong><p>Reading declarations, roster maps, stage documentation, and measured runs.</p></section>
  {:else if requestError}
    <section class="state-card degraded"><strong>Workflow evidence unavailable</strong><p>{requestError}</p></section>
  {:else if !workflows.length}
    <section class="state-card"><strong>No workflows declared</strong><p>The variant declaration source returned no workflow shapes.</p></section>
  {:else}
    <section class="selector-card" aria-label="Workflow selectors">
      <label>Workflow
        <select bind:value={selectedShape}>
          {#each workflows as workflow (workflow.shape)}<option value={workflow.shape}>{workflow.shape}</option>{/each}
        </select>
      </label>
      <label>Assurance tier <span class="selector-note">initial: first roster tier</span>
        <select bind:value={selectedTier}>
          {#each tiers as tier (tier.tier)}<option value={tier.tier}>{tier.tier}</option>{/each}
        </select>
      </label>
      <span class:degraded={payload?.degraded} class="readout">{payload?.degraded ? 'Degraded evidence' : 'Declarations loaded'}{#if payload?.error} · {payload.error}{/if}</span>
    </section>

    <div class="workflow-layout">
      <div class="workflow-main">
        <WorkflowGraph graph={graph} onnodeclick={chooseNode} />
        <section class="history-card">
          <header><div><p class="eyebrow">Observed history</p><h2>Last five measured runs</h2></div><span class="muted">newest first</span></header>
          {#if selectedWorkflow?.evidence?.error && !selectedWorkflow?.recent_runs?.length}<p class="unmeasured">{selectedWorkflow.evidence.error} · unmeasured, not zero.</p>{:else if !selectedWorkflow?.recent_runs?.length}<p class="unmeasured">No measured run carries this workflow shape.</p>{:else}
            <div class="run-table" role="table">
              <div class="run-row run-head" role="row"><span>Run</span><span>Outcome</span><span>Stages</span><span>Enforcement</span></div>
              {#each selectedWorkflow.recent_runs as run (run.run_id)}
                <div class="run-row" role="row"><span class="mono">{run.run_id || 'unidentified'}</span><span>{run.outcome || 'unmeasured'}</span><span>{run.stages?.length || 0} observed</span><span>{selectedWorkflow.boot_seats ? 'boot seat recorded' : 'unmeasured'}</span></div>
              {/each}
            </div>
          {/if}
        </section>
      </div>

      <aside class="inspect-column">
        <section class="inspect-card">
          <header><div><p class="eyebrow">Inspect</p><h2>{inspection.stage || 'Select a stage'}</h2></div><span class="enforcement-mark">{inspection.enforcement?.status || 'unmeasured'}</span></header>
          {#if inspection.docs}<p>{inspection.docs.description}</p><dl><dt>Declaration</dt><dd>{inspection.declaration?.status || 'unmeasured'} · {inspection.declaration?.shape || selectedShape}</dd><dt>Charter</dt><dd>{inspection.charter || 'Control stage; no seat charter.'}</dd><dt>History</dt><dd>{inspection.history?.filter((row) => row.measured).length || 0} measured observations</dd></dl>{:else}<p class="unmeasured">Stage documentation is unmeasured.</p>{/if}
          {#if inspection.history?.length}<ul class="history-list">{#each inspection.history as row (row.run_id)}<li><span>{row.run_id || 'unidentified'}</span><span>{row.duration_ms == null ? 'duration unmeasured' : `${row.duration_ms} ms`}</span><span>{row.outcome || 'outcome unmeasured'}</span></li>{/each}</ul>{/if}
        </section>

        <section class="seat-card">
          <header><div><p class="eyebrow">Seat proposal</p><h2>Map controls</h2></div><span class="muted">proposal only</span></header>
          {#if !seatRoles.length}<p class="unmeasured">No seat-bearing map fields are measured.</p>{:else}{#each seatRoles as role (role)}
            <div class="seat-control"><strong>{role}</strong><input aria-label={`${role} agent`} value={selectedMap?.seats?.[role]?.agent || ''} oninput={(event) => updateSeat(role, 'agent', event.currentTarget.value)} placeholder="agent" /><input aria-label={`${role} effort`} value={selectedMap?.seats?.[role]?.effort || ''} oninput={(event) => updateSeat(role, 'effort', event.currentTarget.value)} placeholder="effort" /><button onclick={() => proposeSeat(role)}>Prepare diff</button></div>
          {/each}{/if}
          {#if proposal}<div class="proposal-result" class:refused={!proposal.ok}>{#if proposal.ok}<strong>Proposed workflow patch</strong><pre>{proposal.diff || 'No text changes.'}</pre>{:else}<strong>Proposal refused</strong><ul>{#each proposal.refusals || [] as refusal}<li>{refusal.code}: {refusal.message}</li>{/each}</ul>{/if}</div>{/if}
        </section>

        <section class="topology-card">
          <header><div><p class="eyebrow">Topology draft</p><h2>Validator adapter</h2></div><span class="enforcement-mark">warning</span></header>
          <p>Topology controls stay local until #1291 supplies the validator.</p>
          {#each graph?.nodes || [] as node (node.id)}<button class="topology-button" onclick={() => beginTopology(node.stage)}>{node.stage} <span>draft</span></button>{/each}
          {#if topologyVerdict}<p class="verdict-warning">{topologyVerdict.status} · {topologyVerdict.reason}</p>{/if}
        </section>
      </aside>
    </div>
  {/if}
</main>

<style>
.workflows-page { padding-top:2rem; }
.page-heading { display:flex; justify-content:space-between; align-items:end; gap:1rem; margin-bottom:1rem; }
.page-heading h1 { margin:.1rem 0 .35rem; font-size:clamp(1.7rem,3vw,2.35rem); letter-spacing:-.04em; }
.page-heading p { margin:0; color:var(--muted); max-width:44rem; font-size:.9rem; }
.eyebrow { color:var(--accent); font-size:.66rem; font-weight:700; letter-spacing:.14em; text-transform:uppercase; }
.updated,.muted { color:var(--muted); font-size:.7rem; }
.selector-card,.history-card,.inspect-card,.seat-card,.topology-card,.state-card { border:1px solid var(--line); border-radius:var(--radius); background:var(--panel); }
.selector-card { display:flex; align-items:end; flex-wrap:wrap; gap:.8rem; padding:.8rem; margin-bottom:1rem; }
.selector-card label { display:grid; gap:.28rem; min-width:12rem; color:var(--muted); font-size:.64rem; font-weight:700; }
.selector-card select,.seat-control input { min-width:0; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--panel-raised); padding:.4rem .5rem; }
.selector-note { color:var(--accent); font-size:.56rem; font-weight:400; }
.readout { margin-left:auto; color:var(--status-ok); font:600 .62rem var(--mono); }
.readout.degraded { color:var(--status-escalated); }
.workflow-layout { display:grid; grid-template-columns:minmax(0,2fr) minmax(15rem,1fr); gap:1rem; align-items:start; }
.workflow-main,.inspect-column { display:grid; gap:1rem; min-width:0; }
.graph-card { min-width:0; }
.history-card,.inspect-card,.seat-card,.topology-card { overflow:hidden; padding:.8rem; }
.history-card header,.inspect-card header,.seat-card header,.topology-card header { display:flex; justify-content:space-between; align-items:start; gap:.7rem; margin-bottom:.7rem; }
.history-card h2,.inspect-card h2,.seat-card h2,.topology-card h2 { margin:.12rem 0 0; font-size:1rem; }
.history-card .eyebrow,.inspect-card .eyebrow,.seat-card .eyebrow,.topology-card .eyebrow { margin:0; }
.run-table { display:grid; overflow:auto; }
.run-row { display:grid; grid-template-columns:minmax(7rem,1fr) minmax(5rem,1fr) minmax(5rem,1fr) minmax(7rem,1fr); gap:.5rem; border-top:1px solid var(--line); padding:.5rem 0; color:var(--muted); font-size:.63rem; }
.run-head { border-top:0; color:var(--accent); font-weight:700; text-transform:uppercase; letter-spacing:.08em; }
.mono { font-family:var(--mono); }
.unmeasured { color:var(--muted); font-size:.7rem; }
.enforcement-mark { color:var(--status-running); font:600 .58rem var(--mono); text-transform:uppercase; }
.inspect-card p,.topology-card p { color:var(--muted); font-size:.7rem; line-height:1.5; }
dl { display:grid; grid-template-columns:max-content minmax(0,1fr); gap:.35rem .6rem; margin:.8rem 0; font-size:.64rem; } dt { color:var(--accent); font-weight:700; } dd { min-width:0; margin:0; color:var(--muted); }
.history-list { display:grid; gap:.35rem; list-style:none; margin:.7rem 0 0; padding:0; } .history-list li { display:grid; grid-template-columns:minmax(0,1fr) auto auto; gap:.45rem; border-top:1px solid var(--line); padding-top:.35rem; color:var(--muted); font-size:.58rem; }
.seat-control { display:grid; grid-template-columns:4rem minmax(0,1fr) minmax(0,1fr) auto; align-items:center; gap:.4rem; border-top:1px solid var(--line); padding:.5rem 0; } .seat-control strong { color:var(--accent); font-size:.65rem; }.seat-control button,.topology-button { border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--panel-raised); color:var(--accent); padding:.4rem .5rem; cursor:pointer; font-size:.6rem; }
.proposal-result { margin-top:.7rem; border-top:1px solid var(--line); padding-top:.6rem; color:var(--status-ok); font-size:.65rem; }.proposal-result.refused { color:var(--status-escalated); }.proposal-result pre { max-height:15rem; overflow:auto; margin:.45rem 0 0; color:var(--muted); font: .58rem/1.45 var(--mono); white-space:pre-wrap; }
.topology-button { display:flex; justify-content:space-between; width:100%; margin-top:.35rem; text-align:left; }.topology-button span { color:var(--muted); }.verdict-warning { border-top:1px solid var(--line); padding-top:.6rem; color:var(--status-escalated) !important; font-family:var(--mono); }
.state-card { max-width:42rem; margin:3rem auto; padding:1.4rem; text-align:center; }.state-card strong { color:var(--accent); }.state-card p { color:var(--muted); font-size:.75rem; }.state-card.degraded { border-color:var(--status-escalated); }
@media (max-width: 980px) { .workflow-layout { grid-template-columns:1fr; }.inspect-column { grid-template-columns:repeat(2,minmax(0,1fr)); }.topology-card { grid-column:1/-1; } }
@media (max-width: 650px) { .page-heading { align-items:start; }.updated { display:none; }.inspect-column { grid-template-columns:1fr; }.seat-control { grid-template-columns:1fr 1fr; }.seat-control strong { grid-column:1/-1; }.seat-control button { grid-column:1/-1; } }
</style>
