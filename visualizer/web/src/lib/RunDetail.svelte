<script>
  import { taskDetailSummary, verifiedTaskReturns } from './task-detail.js'
  import { getEvents, getJournal, getReturns } from './api.js'
  import { drainEvents } from './drain.js'
  import { durationCell, gateCell, profileEvidenceView, runDetailConfiguration, runDetailSeats, runDetailState, shipStatus, tokenCell } from './fleet.js'
  import { executionTopology } from './execution-steps.js'
  import { reasonText } from './reason-copy.js'
  import { runConfiguration } from './workflow-semantics.js'
  import { crewSummary } from './crew.js'
  import { applyRead, initialJournalState, journalPulse } from './live.js'
  import PhaseGantt from './PhaseGantt.svelte'
  import EnvelopeInspector from './EnvelopeInspector.svelte'
  import ReviewPanel from './ReviewPanel.svelte'
  import AcceptPanel from './AcceptPanel.svelte'
  import EventStream from './EventStream.svelte'
  import Trajectory from './Trajectory.svelte'
  import PhasePanel from './PhasePanel.svelte'
  import PlanSteps from './PlanSteps.svelte'

  let { run, phase = null, onback = () => {}, onphase = () => {} } = $props()
  let returns = $state({ envelopes: [], task: null })
  let events = $state([])
  let selectedPhase = $state(null)
  let view = $state('overview')
  let loading = $state(false)
  let readAt = $state(null)
  let showWaterfall = $state(true)
  let showReturns = $state(false)
  let showTrajectory = $state(false)
  let showEvents = $state(false)
  let journalState = $state(initialJournalState())
  let error = $state('')
  let copied = $state(false)
  let detailGeneration = 0
  let journalGeneration = 0
  let detailKey = ''
  let journalKey = ''
  let phaseRouteKey = ''

  let evidence = $derived(verifiedTaskReturns(returns))
  let insight = $derived(taskDetailSummary(run, returns, readAt ?? Date.now()))
  let status = $derived(insight.status)
  let ship = $derived(shipStatus(run))
  let prUrl = $derived(safeExternalUrl(run?.ship?.pr_url))
  let duration = $derived(durationCell(run))
  let tokens = $derived(tokenCell(run))
  let gate = $derived(gateCell(run))
  let configuration = $derived(runConfiguration(run))
  let configurationDetail = $derived(runDetailConfiguration(run))
  let taskProfileDetail = $derived(configurationDetail.find((axis) => axis.key === 'task_profile'))
  let executionDetail = $derived(configurationDetail.find((axis) => axis.key === 'execution'))
  let assuranceDetail = $derived(configurationDetail.find((axis) => axis.key === 'assurance'))
  let seatPolicy = $derived(runDetailSeats(run))
  let runState = $derived(runDetailState(run, events))
  let profileEvidence = $derived(profileEvidenceView(configuration.profile.key, evidence))
  let observedStageLabels = $derived((Array.isArray(journalState?.payload?.rows) ? journalState.payload.rows : []).flatMap((row) => [row?.stage, row?.stage_done]).filter((label) => typeof label === 'string' && label.trim()))
  let topology = $derived(executionTopology(configuration.execution.key, observedStageLabels, { complete: run.running !== true }))
  let crew = $derived(crewSummary(run.agents))
  let started = $derived(dateParts(run.started_at))
  let selectedPhaseLabel = $derived(resolvePhase(selectedPhase)?.name ?? selectedPhase)

  async function load(target = { repo_slug:run.repo_slug, task_slug:run.goal, adw_id:run.adw_id }) {
    const generation = ++detailGeneration
    error = ''
    loading = true
    const signal = AbortSignal.timeout(15000)
    const results = await Promise.allSettled([
      target.repo_slug && target.task_slug ? getReturns(target.repo_slug, target.task_slug, target.adw_id, { signal }) : Promise.resolve({ envelopes:[], task:null }),
      drainEvents((after, limit) => getEvents(target.adw_id, after, limit, {}, { signal }), {}),
    ].map((request, index) => request.then((value) => {
      if (generation === detailGeneration) {
        if (index === 0) returns = value
        else events = value.events
      }
      return value
    })))
    if (generation !== detailGeneration) return
    const [returnResult, eventResult] = results
    const failures = []
    if (returnResult.status === 'fulfilled') returns = returnResult.value
    else failures.push('Agent returns could not be refreshed. Previously read reports may be out of date.')
    if (eventResult.status === 'fulfilled') {
      events = eventResult.value.events
      if (eventResult.value.truncated) failures.push('Event history is incomplete.')
    } else failures.push('Event history could not be refreshed. Previously read events may be out of date.')
    error = failures.join(' ')
    readAt = Date.now()
    loading = false
  }

  async function loadJournal(target) {
    const generation = ++journalGeneration
    try {
      const payload = await getJournal(target.repo_slug, target.task_slug, target.adw_id, { signal:AbortSignal.timeout(15000) })
      if (generation === journalGeneration) journalState = applyRead(journalState, { ok:true, payload }, Date.now())
    } catch (err) {
      if (generation === journalGeneration) journalState = applyRead(journalState, { ok:false, error:err.message }, Date.now())
    }
  }
  $effect(() => {
    const target = { repo_slug:run.repo_slug || '', task_slug:run.goal || '', adw_id:run.adw_id || '' }
    if (!target.adw_id || target.adw_id === detailKey) return
    detailKey = target.adw_id; returns = { envelopes: [], task: null }; events = []; readAt = null
    view = 'overview'; phaseRouteKey = ''; showReturns = false; showTrajectory = false; showEvents = false; showWaterfall = true
    void load(target)
  })
  $effect(() => {
    const target = { repo_slug:run.repo_slug || '', task_slug:run.goal || '', adw_id:run.adw_id || '' }
    const key = `${target.repo_slug}\u0000${target.task_slug}\u0000${target.adw_id}`
    if (!target.adw_id || key === journalKey) return
    journalKey = key
    journalState = initialJournalState()
    void loadJournal(target)
  })
  $effect(() => journalPulse.subscribe(() => {
    const target = { repo_slug:run.repo_slug || '', task_slug:run.goal || '', adw_id:run.adw_id || '' }
    void load(target)
    void loadJournal(target)
  }))
  $effect(() => {
    const requested = phase
    const routeKey = `${run.adw_id}:${requested ?? ''}`
    if (routeKey !== phaseRouteKey) {
      phaseRouteKey = routeKey
      if (requested != null) view = 'activity'
    }
    const phases = run.phases || []
    const fallback = phases.find((item) => item.status === 'running') ?? phases.at(-1) ?? null
    selectedPhase = requested ?? fallback?.id ?? fallback?.name ?? null
  })

  function resolvePhase(value) {
    const phases = run.phases || []
    return phases.find((item) => item.id != null && value != null && String(item.id) === String(value))
      ?? phases.find((item) => item.name === value)
      ?? null
  }
  function selectPhase(value) { selectedPhase = value; view = 'activity'; onphase(value) }
  function title(value) { const words = String(value || 'Not recorded').replaceAll('_',' ').replaceAll('-',' '); return words.charAt(0).toUpperCase() + words.slice(1) }
  function dateParts(value) {
    if (!value) return { iso:null, date:'Not recorded', time:'Time unavailable' }
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) return { iso:null, date:String(value), time:'Time unavailable' }
    return {
      iso: parsed.toISOString(),
      date: new Intl.DateTimeFormat(undefined, { month:'short', day:'numeric', year:'numeric' }).format(parsed),
      time: new Intl.DateTimeFormat(undefined, { hour:'numeric', minute:'2-digit' }).format(parsed),
    }
  }
  function safeExternalUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null
    try {
      const parsed = new URL(value)
      return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null
    } catch { return null }
  }
  function compact(value) { return value == null ? '—' : Intl.NumberFormat(undefined, { notation:'compact', maximumFractionDigits:1 }).format(value) }
  async function copyId() {
    try { await navigator.clipboard.writeText(run.adw_id); copied = true; setTimeout(() => copied = false, 1200) } catch {}
  }
  async function copyReconciliation() {
    try { await navigator.clipboard.writeText(run.reconciliation_command) } catch {}
  }
</script>

<main class="detail">
  <div class="breadcrumbs"><button onclick={onback}>← Tasks</button><span>/</span><span>{run.repo_slug || 'Repository unavailable'}</span></div>
  <header class="task-header">
    <div class="task-title"><p class="eyebrow">Task overview</p><h1>{run.goal || 'Untitled task'}</h1><p>Started <time datetime={started.iso || undefined}>{started.date} · {started.time}</time></p></div>
    <button class="id-button" onclick={copyId} title={run.adw_id} aria-label="Copy run ID">{copied ? 'Copied' : 'Run'} <code>{String(run.adw_id || '').slice(0,8)}</code></button>
  </header>
  <section class={`outcome-banner ${status.tone}`} aria-label="Task outcome">
    <div class={`outcome-icon ${status.tone}`} aria-hidden="true">{status.key === 'success' ? '✓' : status.key === 'running' ? '↻' : '!'}</div>
    <div><h2>{insight.headline}</h2><p>{insight.next}</p>{#if insight.reasonPreview}<p class="reason-preview">{insight.reasonPreview}</p>{#if insight.reasonPreview !== status.why}<details class="outcome-reason"><summary>Read full recorded reason</summary><p>{status.why}</p></details>{/if}{/if}</div>
    <button onclick={() => view = insight.target}>Inspect {insight.target === 'details' ? 'runtime' : insight.target} →</button>
  </section>
  <nav class="view-nav" aria-label="Task views">
    {#each ['overview','activity','verification','details'] as item}<button aria-pressed={view === item} onclick={() => view = item}>{title(item)}</button>{/each}
  </nav>
  {#if loading}<p class="read-state" role="status">Reading task evidence…</p>{:else if readAt}<p class="read-state">Task evidence checked at {dateParts(readAt).time}. Use Refresh now to read all sources again.</p>{/if}
  {#if error}<p class="error-banner" role="status">{error}</p>{/if}
  {#if journalState.error}<p class="error-banner" role="status">The journal could not be refreshed. Plan and activity evidence may be out of date.</p>{/if}
  {#if readAt && !insight.identityVerified}<p class="source-notice" role="status">Agent returns are unavailable or cannot be linked to this run. They are excluded from the summary; the raw response is available in Details.</p>{/if}

  {#if view === 'overview' || view === 'activity'}
    <details class="waterfall-disclosure" bind:open={showWaterfall}><summary>Execution waterfall · phases and agent handoffs</summary>{#if showWaterfall}<PhaseGantt {run} {events} {journalState} selected={selectedPhase} onselectphase={selectPhase} />{/if}</details>
  {/if}

  {#if view === 'overview'}
    <div class="overview-grid">
      <section class="report-card">
        <header><div><p class="eyebrow">Reported work</p><h2>Latest work report</h2></div>{#if insight.report}<span class="source-tag">{title(insight.report.role)} · d{insight.report.dispatch_seq}</span>{/if}</header>
        {#if insight.report}<p class="report-text">{insight.reportPreview}</p>{#if insight.reportPreview !== insight.report.summary}<details class="full-report"><summary>Read full work report</summary><p class="report-text">{insight.report.summary}</p></details>{/if}<p class="muted">This is an agent report. Review and final acceptance are separate below.</p>{:else}<p class="empty">{loading ? 'Loading the latest report…' : 'No verified agent report is available for this run.'}</p>{/if}
        {#if insight.files.length}<details class="reported-files"><summary>{insight.files.length} files reported changed across builder turns</summary><p class="muted">Paths reported by builders; this is not a verified final diff.</p><ul>{#each insight.files as file}<li><code>{file}</code></li>{/each}</ul></details>{/if}
      </section>
      <aside class="context-card"><h2>Run context</h2><dl><div><dt>Recorded duration</dt><dd>{duration.dashed ? 'Not measured' : duration.text}</dd></div><div><dt>Last recorded phase</dt><dd>{run.phases?.length ? title(run.phases.at(-1).name) : 'Not recorded'}</dd></div><div><dt>Agent assignments</dt><dd>{crew.assignment_count} across {crew.seat_count} seats</dd></div><div><dt>Recorded tokens</dt><dd>{tokens.dashed ? 'Not measured' : compact(tokens.value)}</dd></div></dl><p class="muted">Duration is elapsed time in the record. Tokens are usage, not a measure of work quality or price.</p></aside>
    </div>
    <section class="confidence-card"><header><h2>Can I rely on the result?</h2><button class="text-button" onclick={() => view = 'verification'}>Inspect evidence →</button></header><div class="confidence-grid">
      <article class:positive={status.key === 'success'} class:attention={['serious','fail'].includes(status.tone)}><span class="eyebrow">Task outcome</span><strong>{status.key === 'success' ? 'Success recorded' : status.key === 'escalated' ? 'Escalated' : run.settlement?.outcome ? title(run.settlement.outcome) : 'No final outcome confirmed'}</strong><p>{status.key === 'success' ? 'The run records a successful terminal outcome.' : 'An agent finishing a turn does not complete the task.'}</p></article>
      <article class:positive={insight.review?.details?.verdict === 'pass'} class:attention={insight.review?.details?.verdict === 'changes-needed'}><span class="eyebrow">Reviewer report</span><strong>{insight.review ? title(insight.review.details.verdict) : 'Not recorded'}</strong><p>{insight.review ? `Latest verified reviewer return · d${insight.review.dispatch_seq}. This verdict applies to that review, not automatically to later edits.` : 'No verified reviewer return is available.'}</p></article>
      <article class:positive={gate.verdict === 'proven'} class:attention={gate.verdict === 'failed'}><span class="eyebrow">Gate discrimination</span><strong>{gate.dashed ? 'Not measured' : title(gate.text)}</strong><p>{gate.dashed ? 'No recorded proof that the automated gate detects a change.' : `Generation ${gate.generation ?? 'unknown'} · tests whether the gate reacts to changes. This does not establish final acceptance.`}</p></article>
    </div></section>
    <section class="delivery-card"><header><h2>Delivery</h2>{#if prUrl}<a href={prUrl} target="_blank" rel="noreferrer">Open pull request ↗</a>{/if}</header><p>{ship.reason || ship.word}</p>{#if ship.key === 'merged'}<p>Merge recorded {run.ship?.merged_at ? dateParts(run.ship.merged_at).date : 'without a timestamp'}{#if run.ship?.merge_commit_sha} · <code>{run.ship.merge_commit_sha}</code>{/if}</p>{/if}</section>
    <details class="data-coverage"><summary>What this page cannot establish</summary><p>The original request is not included in this feed. Agent reports and file paths do not prove the final diff, product quality, or time saved. Review and gate evidence may describe different revisions.</p><p>Per-step cost and a reliable overall completion percentage are not measured. Acceptance text: {journalState.payload?.acceptance ? 'available in the recorded plan evidence' : reasonText(journalState.payload?.acceptance_reason) || 'not available from the journal source'}.</p></details>
  {:else if view === 'activity'}
    <section class="activity-card"><header><div><h2>Phase history</h2><p>Recorded order and duration. Select a phase to inspect its evidence.</p></div><span class="source-tag">{run.phases?.length || 0} phases</span></header>
      <div class="phase-list">{#each run.phases || [] as item, index (item.id ?? index)}<button class:chosen={String(selectedPhase) === String(item.id ?? item.name)} aria-pressed={String(selectedPhase) === String(item.id ?? item.name)} onclick={() => selectPhase(item.id ?? item.name)}><span class="phase-number">{index + 1}</span><strong>{title(item.name)}</strong><span>{item.status === 'ok' ? 'Phase ended' : item.status === 'running' ? 'Open in record' : title(item.status)}</span><span>{durationCell(item).dashed ? 'Not measured' : durationCell(item).text}</span></button>{:else}<p class="empty">No phases were recorded.</p>{/each}</div>
    </section>
    <section class="phase-section"><header><h2>{selectedPhaseLabel ? title(selectedPhaseLabel) : 'Choose a phase'}</h2><span class="muted">Selected phase</span></header><PhasePanel {run} phase={selectedPhase} returns={evidence} {events} /></section>
    <PlanSteps {journalState} />
  {:else if view === 'verification'}
    <section class="verification-intro"><h2>Verification evidence</h2><p>Review, gate proof, and acceptance answer different questions. A pass in one does not imply a pass in all three.</p></section>
    {#if insight.review}<section class="report-card"><header><h2>Latest reviewer report</h2><span class="source-tag">d{insight.review.dispatch_seq} · {title(insight.review.details.verdict)}</span></header><p class="report-text">{insight.review.summary || 'No narrative was recorded.'}</p></section>{/if}
    <section class="report-card"><header><h2>Automated gate discrimination</h2><span class="source-tag">{gate.dashed ? 'Not measured' : `${title(gate.text)} · generation ${gate.generation ?? 'unknown'}`}</span></header><p class="muted">This tests whether the gate detects changes. It does not establish that later edits were accepted or that the task was delivered. Inspect a build phase for individual gate attempts.</p><button class="text-button" onclick={() => view = 'activity'}>Inspect phase evidence →</button></section>
    <ReviewPanel {run} returns={evidence} />
    <AcceptPanel {run} returns={evidence} />
      <details class="profile-evidence" aria-label="Profile evidence summary"><summary>Profile evidence and execution topology</summary>
    <header class="profile-evidence-heading"><div><p class="micro">Measured evidence</p><h2>{profileEvidence.profile.label}</h2><p>{profileEvidence.profile_specific ? 'The ordered blocks below explain why this profile requires each recorded evidence family.' : 'This run has no recorded task profile; the visualizer does not infer one from its envelopes or stages.'}</p></div><span class:unrecorded={!profileEvidence.profile_specific}>{profileEvidence.profile_specific ? 'Profile-specific' : 'Not recorded'}</span></header>
    <div class="evidence-summary-grid">
      {#each profileEvidence.cards as block (block.key)}
        <article class="evidence-summary">
          <header><strong>{block.label}</strong><span>Recorded</span></header>
          <p>{block.reason}</p>
          <small>{block.summary}</small>
          {#if block.references.length}<ul>{#each block.references as reference, index (`${reference.dispatch_seq ?? 'task'}-${reference.field}-${reference.role ?? 'unknown'}-${index}`)}<li><code>{reference.role || 'return'} · {reference.field}</code><span>{typeof reference.value === 'string' ? reference.value : JSON.stringify(reference.value)}</span></li>{/each}</ul>{/if}
        </article>
      {/each}
    </div>
    {#if profileEvidence.footer.length}<details class="not-recorded"><summary>Not recorded: {profileEvidence.footer.map((entry) => entry.label).join(', ')}</summary><ul>{#each profileEvidence.footer as entry (entry.key)}<li>{entry.label} — {entry.text}</li>{/each}</ul></details>{/if}
    <section class="topology-summary" aria-label="Execution topology summary">
      <header><div><p class="micro">Measured execution topology</p><h3>{topology.measured ? configuration.execution.label : 'Not recorded'}</h3><p>{topology.measured ? 'Declared stages are shown in order; repair and reverify checkpoints are conditional.' : 'The execution shape is not recorded or is not declared; no topology is inferred.'}</p></div>{#if topology.measured}<span>{topology.rows.length} declared stages</span>{/if}</header>
      {#if topology.measured}
        <div class="topology-rows" aria-label="Declared execution stages">{#each topology.rows as row (row.stage)}<span class={`topology-stage ${row.status}`} aria-label={row.stage} title={row.stage}></span>{/each}</div>
        {#if topology.defects.length}<div class="topology-defects" aria-label="Execution topology defects"><strong>Topology defects</strong><ul>{#each topology.defects as defect (`${defect.kind}-${defect.stage}`)}<li class={defect.kind}><b>{defect.stage}</b><span>{defect.message}</span></li>{/each}</ul></div>{:else}<p class="topology-clear">No missing or undeclared stages were recorded.</p>{/if}
      {:else}<p class="topology-not-recorded">Not recorded — stage absence is not classified without a measured execution declaration.</p>{/if}
    </section>
  </details>


  {:else}
    <h2 class="view-heading">Runtime and configuration</h2>
      <section class="driver-card run-state-card" aria-label="Run state">
    <div class="run-state-heading"><p class="micro">Run-state audit</p><h2>Recorded execution state</h2><p>Each fact below is shown only when this run measured it.</p></div>
    <div class="run-state-facts">
      <div class="run-state-fact"><span>Settlement</span><strong>{runState.settlement.text}</strong><small>State · {runState.settlement.state ?? 'Not recorded'} · Outcome · {runState.settlement.outcome ?? 'Not recorded'} · Reason · {runState.settlement.reason ?? 'Not recorded'}</small></div>
      <div class="run-state-fact"><span>Driver observation</span><strong>{runState.driver.text}</strong><small>{runState.driver.source ? `Source · ${runState.driver.source}` : 'Source · Not recorded'} · {runState.driver.reason_code ? `Reason · ${runState.driver.reason_code}` : 'Reason · Not recorded'}</small></div>
      <div class="run-state-fact"><span>Heartbeat</span><strong>{runState.heartbeat.text}</strong><small class="run-state-caveat">{runState.heartbeat.caveat}</small></div>
      <div class="run-state-fact"><span>Latest phase</span><strong>{runState.latest.phase}</strong><small>Last phase name in recorded order</small></div>
      <div class="run-state-fact"><span>Latest event</span><strong>{runState.latest.event}</strong><small>Last event type in recorded order</small></div>
      <div class="run-state-fact"><span>Operator remediation</span><strong>{runState.remediation.text}</strong><small>Reconciliation is copy-only in this visualizer.</small></div>
    </div>
    {#if runState.remediation.command}
      <div class="reconcile-copy"><code>{runState.remediation.command}</code><button type="button" onclick={copyReconciliation}>Copy reconciliation command</button><small>Copy only. The visualizer never executes reconciliation.</small></div>
    {/if}
  </section>


    <details class="settings"><summary>Requested and effective configuration</summary>  <section class="configuration-strip" aria-label="Recorded run configuration">
    <article class="assurance-card"><span>Assurance</span><div class="configuration-value"><strong class:missing={!configuration.assurance.key}>{configuration.assurance.label}</strong>{#if configuration.assurance.legacy_alias}<code>{configuration.assurance.legacy_alias}</code>{/if}</div><small>{configuration.assurance.key ? `${configuration.assurance.summary} ${configuration.assurance.recording === 'legacy_alias' ? `Derived from the recorded legacy preset ${configuration.assurance.legacy_alias}; canonical assurance was not stored for this historical run.` : `Recorded canonically as ${configuration.assurance.key}${configuration.assurance.legacy_alias ? `; roster preset ${configuration.assurance.legacy_alias}.` : '.'}`}` : configuration.assurance.summary}</small>
      <div class="configuration-provenance" class:configuration-changed={assuranceDetail?.changed === true} class:configuration-equal={assuranceDetail?.changed === false} class:configuration-unrecorded={assuranceDetail?.changed === null}>
        <div class="configuration-pair"><span><small>Requested</small><strong>{assuranceDetail?.requested_text ?? 'Not recorded'}</strong></span><span><small>Effective</small><strong>{assuranceDetail?.effective_text ?? 'Not recorded'}</strong></span></div>
        <small class="configuration-source">Provenance · {assuranceDetail?.source_text ?? 'Not recorded'}</small>
        {#if assuranceDetail?.changed === true}<small class="configuration-change">{configuration.assurance.recording === 'legacy_alias' || assuranceDetail?.source === 'alias' ? 'Legacy preset mapped to its canonical assurance.' : 'Requested value differs from effective value.'}</small>{:else if assuranceDetail?.changed === false}<small class="configuration-agreement">Requested and effective values agree.</small>{:else}<small class="configuration-unrecorded">Requested and effective comparison unavailable.</small>{/if}
      </div>
    </article>
    <article><span>Task profile</span><strong class:missing={!configuration.profile.key}>{configuration.profile.label}</strong><small>{configuration.profile.summary}</small>
      <div class="configuration-provenance" class:configuration-changed={taskProfileDetail?.changed === true} class:configuration-equal={taskProfileDetail?.changed === false} class:configuration-unrecorded={taskProfileDetail?.changed === null}>
        <div class="configuration-pair"><span><small>Requested</small><strong>{taskProfileDetail?.requested_text ?? 'Not recorded'}</strong></span><span><small>Effective</small><strong>{taskProfileDetail?.effective_text ?? 'Not recorded'}</strong></span></div>
        <small class="configuration-source">Provenance · {taskProfileDetail?.source_text ?? 'Not recorded'}</small>
        {#if taskProfileDetail?.changed === true}<small class="configuration-change">Requested value differs from effective value.</small>{:else if taskProfileDetail?.changed === false}<small class="configuration-agreement">Requested and effective values agree.</small>{:else}<small class="configuration-unrecorded">Requested and effective comparison unavailable.</small>{/if}
      </div>
    </article>
    <article><span>Execution shape</span><strong class:missing={!configuration.execution.key}>{configuration.execution.label}</strong><small>{configuration.execution.summary}</small>
      <div class="configuration-provenance" class:configuration-changed={executionDetail?.changed === true} class:configuration-equal={executionDetail?.changed === false} class:configuration-unrecorded={executionDetail?.changed === null}>
        <div class="configuration-pair"><span><small>Requested</small><strong>{executionDetail?.requested_text ?? 'Not recorded'}</strong></span><span><small>Effective</small><strong>{executionDetail?.effective_text ?? 'Not recorded'}</strong></span></div>
        <small class="configuration-source">Provenance · {executionDetail?.source_text ?? 'Not recorded'}</small>
        {#if executionDetail?.changed === true}<small class="configuration-change">Requested value differs from effective value.</small>{:else if executionDetail?.changed === false}<small class="configuration-agreement">Requested and effective values agree.</small>{:else}<small class="configuration-unrecorded">Requested and effective comparison unavailable.</small>{/if}
      </div>
    </article>
  </section>

</details>
        <aside class="crew-panel">
      <header><p class="micro">Assigned crew</p><h2>{crew.seat_count} seat{crew.seat_count === 1 ? '' : 's'} · {crew.assignment_count} turn{crew.assignment_count === 1 ? '' : 's'}</h2><p>{crew.dispatch_count} dispatch label{crew.dispatch_count === 1 ? '' : 's'} · IDs may repeat across roles</p></header>
      <div class="crew-definition"><strong>Seats are distinct role/lane workers.</strong><span>Turns are recorded assignments. Process count is not shown because transports have different process lifecycles.</span></div>
      <div class="crew-list">
        {#each crew.seats as seat (seat.key)}
          <details class="crew-seat">
            <summary>
              <span class="avatar" style={`--crew-color:var(--role-${seat.role})`}>{seat.role?.slice(0,1).toUpperCase() || '?'}</span>
              <span class="crew-copy"><strong>{seat.role || 'Unlinked seat'}</strong><small title={seat.model_title || 'No assignment carried a measured model'}>{seat.model || 'Model not measured'}{#if seat.model_coverage && seat.model_coverage < seat.assignment_count} · observed on {seat.model_coverage}/{seat.assignment_count}{/if}</small><span>{seat.assignment_count} turn{seat.assignment_count === 1 ? '' : 's'}{#if seat.lane != null} · lane {seat.lane}{/if}</span></span>
              <span class={`outcome ${seat.outcome.key}`}>{seat.outcome.label}</span>
            </summary>
            <div class="assignment-list">
              {#each seat.assignments as assignment (assignment.key)}
                <span><code>{assignment.dispatch_id || 'No ID'}</code><small>{assignment.model || 'Model not measured'}</small><b class={assignment.outcome || 'unknown'}>{assignment.outcome || 'Unknown'}</b></span>
              {/each}
            </div>
          </details>
        {:else}<p>No seat assignments were recorded.</p>{/each}
      </div>
      <section class="seat-policy" aria-label="Seat overrides and policy evidence">
        <header><p class="micro">Seat policy</p><h3>Overrides and warnings</h3></header>
        {#if seatPolicy.state === 'not-recorded'}
          <p class="seat-policy-summary">Not recorded</p>
        {:else if seatPolicy.state === 'measured-empty'}
          <p class="seat-policy-summary">No seat overrides or policy warnings recorded</p>
        {:else}
          <div class="seat-policy-list">
            {#each seatPolicy.rows as seat, index (`${seat.role || 'seat'}-${index}`)}
              <article class="seat-policy-row">
                <header><strong>{seat.role || 'Not recorded'}</strong><span>Source · {seat.source || 'Not recorded'}</span></header>
                <div class="seat-policy-facts"><span>Policy state <b>{seat.policy_state || 'Not recorded'}</b></span></div>
                {#if seat.warnings === null}<p class="seat-policy-warning">Policy warnings · Not recorded</p>{:else if seat.warnings.length === 0}<p class="seat-policy-warning">No policy warnings recorded</p>{:else}<ul class="seat-policy-warnings">{#each seat.warnings as warning, index (index)}<li>{warning}</li>{/each}</ul>{/if}
              </article>
            {/each}
          </div>
        {/if}
      </section>
    </aside>

    <section class="usage-card"><h2>Recorded usage</h2><dl><div><dt>Fresh input tokens</dt><dd>{compact(tokens.input)}</dd></div><div><dt>Output tokens</dt><dd>{compact(tokens.output)}</dd></div><div><dt>Cache reads</dt><dd>{compact(tokens.cacheRead)}</dd></div><div><dt>Cache writes</dt><dd>{compact(tokens.cacheWrite)}</dd></div></dl><p class="muted">Missing values were not measured. Usage can be partial across transports; cost is not inferred from tokens.</p></section>
    <section class="diagnostics"><h2>Source records</h2>
      <details bind:open={showReturns}><summary>Agent returns and task envelope</summary>{#if showReturns}<EnvelopeInspector {run} {returns} />{/if}</details>
      <details bind:open={showTrajectory}><summary>Agent trajectory</summary>{#if showTrajectory}<Trajectory {run} {journalState} returns={evidence} />{/if}</details>
      <details bind:open={showEvents}><summary>Event stream</summary>{#if showEvents}<EventStream {run} {events} phaseFilter={selectedPhase} onrefresh={() => load()} />{/if}</details>
    </section>
  {/if}
</main>

<style>
  .detail { width:min(1240px,100%); margin:auto; padding:2rem 2rem 4rem; display:grid; gap:1.25rem; min-width:0; }
  .detail :global(*) { box-sizing:border-box; }
  .detail h2 { font-size:1.05rem; letter-spacing:-.025em; }
  .detail h3 { font-size:1rem; }
  .detail p { line-height:1.55; }
  .detail :global(code) { overflow-wrap:anywhere; }
  .detail summary { cursor:pointer; padding:.7rem 0; font-size:.875rem; }
  .detail :global(button) { cursor:pointer; }
  .detail :global(button:disabled) { cursor:wait; }
  .detail :global(a) { color:var(--accent); }
  .breadcrumbs { display:flex; align-items:center; gap:.6rem; color:var(--muted); font-size:.85rem; overflow-wrap:anywhere; }
  .breadcrumbs button,.text-button { border:0; padding:0; background:transparent; color:var(--accent); }
  .task-header { display:flex; justify-content:space-between; align-items:center; gap:1rem; }
  .task-title { min-width:0; }.task-title h1 { font-size:clamp(1.65rem,3vw,2.2rem); letter-spacing:-.045em; margin:.35rem 0 .5rem; overflow-wrap:anywhere; }.task-title p { margin:0; color:var(--muted); font-size:.85rem; }
  .eyebrow { color:var(--muted); font-size:.78rem; font-weight:600; }.task-title .eyebrow { font-size:.75rem; text-transform:uppercase; letter-spacing:.08em; }
  .id-button { flex-shrink:0; border:1px solid var(--line); border-radius:.5rem; padding:.55rem .75rem; background:var(--panel); color:var(--muted); font-size:.8rem; }
  .outcome-banner { display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:1rem; padding:1.25rem; border:1px solid var(--line); border-radius:.75rem; background:var(--panel); }
  .outcome-banner .reason-preview { margin-top:.65rem; max-width:85ch; font-size:.82rem; }.outcome-banner h2 { margin:0 0 .25rem; }.outcome-banner p { margin:0; color:var(--muted); font-size:.875rem; }.outcome-banner button { background:var(--panel); border:1px solid var(--line); border-radius:.5rem; padding:.6rem .8rem; color:var(--text); white-space:nowrap; font-size:.85rem; }
  .outcome-icon { width:2.4rem; height:2.4rem; display:grid; place-items:center; border-radius:50%; background:var(--panel-raised); color:var(--status-running); font-size:1.1rem; }.outcome-icon.ok { color:var(--status-ok); }.outcome-icon.fail,.outcome-icon.serious { color:var(--status-escalated); }.outcome-reason { margin-top:.3rem; }
  .view-nav { display:flex; gap:1.25rem; border-bottom:1px solid var(--line); flex-wrap:wrap; }.view-nav button { background:transparent; color:var(--muted); border:0; border-bottom:2px solid transparent; padding:.75rem .1rem; text-transform:capitalize; font-size:.9rem; }.view-nav button[aria-pressed="true"] { color:var(--text); border-bottom-color:var(--accent); font-weight:650; }
  .error-banner { border-left-color:var(--status-fail); }
  .read-state { margin:-.5rem 0 0; font-size:.75rem; color:var(--muted); }
  .overview-grid { display:grid; grid-template-columns:minmax(0,1.8fr) minmax(15rem,1fr); gap:1.25rem; align-items:start; }
  .report-card,.context-card,.confidence-card,.delivery-card,.activity-card,.usage-card { background:var(--panel); border:1px solid var(--line); border-radius:.75rem; padding:1.4rem; min-width:0; }
  .report-card header,.confidence-card > header,.delivery-card header,.activity-card header,.phase-section > header { display:flex; justify-content:space-between; align-items:start; flex-wrap:wrap; gap:.75rem; }
  .report-card header p,.report-card h2,.context-card h2,.confidence-card h2,.delivery-card h2,.activity-card h2,.usage-card h2 { margin:0 0 .4rem; }
  .source-tag { color:var(--muted); background:var(--panel-raised); padding:.3rem .5rem; border-radius:.35rem; font-size:.75rem; white-space:nowrap; }
  .report-text { white-space:pre-wrap; overflow-wrap:anywhere; font-size:.95rem; margin:1.25rem 0; }
  .muted,.empty { color:var(--muted); font-size:.85rem; }.reported-files { margin-top:1rem; border-top:1px solid var(--line); }.reported-files ul { padding-left:1.2rem; font-size:.85rem; }
  dl { margin:1rem 0; display:grid; gap:1rem; }dl > div { display:flex; justify-content:space-between; flex-wrap:wrap; gap:.4rem .8rem; }dt { color:var(--muted); font-size:.82rem; }dd { margin:0; font-size:.85rem; font-variant-numeric:tabular-nums; }
  .context-card .muted { margin-bottom:0; font-size:.78rem; }
  .confidence-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:1.5rem; margin-top:1.3rem; }.confidence-grid article { display:grid; align-content:start; gap:.5rem; }.confidence-grid strong { font-size:.95rem; }.confidence-grid p { margin:0; color:var(--muted); font-size:.82rem; }
  .delivery-card p { margin:.5rem 0 0; color:var(--muted); font-size:.875rem; }.delivery-card a { font-size:.85rem; }
  .data-coverage { color:var(--muted); font-size:.85rem; }.data-coverage p { max-width:80ch; }.source-notice,.error-banner { border:1px solid var(--line); border-left:3px solid var(--status-running); padding:.75rem 1rem; margin:0; font-size:.85rem; color:var(--text); background:var(--panel); }
  .activity-card header p { margin:0; color:var(--muted); font-size:.85rem; }.phase-list { margin-top:1rem; display:grid; }.phase-list button { display:grid; grid-template-columns:2rem minmax(6rem,1fr) minmax(7rem,1fr) auto; gap:.75rem; align-items:center; text-align:left; background:transparent; border:0; border-top:1px solid var(--line); padding:.85rem .5rem; color:var(--text); border-radius:.35rem; }.phase-list button.chosen { background:var(--accent-soft); box-shadow:inset 3px 0 var(--accent); }.phase-list button > span { color:var(--muted); font-size:.82rem; font-variant-numeric:tabular-nums; }.phase-list strong { text-transform:capitalize; font-size:.9rem; }.phase-number { border:1px solid var(--line); border-radius:50%; width:1.6rem; height:1.6rem; display:grid; place-items:center; }
  .phase-section { min-width:0; }.phase-section > header { align-items:center; margin-bottom:.5rem; }.phase-section h2 { text-transform:capitalize; margin:0; }
  .waterfall-disclosure,.settings,.profile-evidence,.diagnostics > details { padding:.3rem 1rem; background:var(--panel); border:1px solid var(--line); border-radius:.6rem; min-width:0; }
  .verification-intro h2 { margin:0; }.verification-intro p { color:var(--muted); font-size:.9rem; margin:.4rem 0 0; }
  .view-heading { margin:0; }.run-state-card { border:1px solid var(--line); border-radius:.75rem; padding:1.25rem; background:var(--panel); }.run-state-heading h2 { margin:.3rem 0; }.run-state-heading p { color:var(--muted); font-size:.85rem; }.micro { color:var(--muted); font-size:.75rem; margin:0; }.run-state-facts { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:1.25rem; margin-top:1rem; }.run-state-fact { display:grid; gap:.35rem; align-content:start; overflow-wrap:anywhere; }.run-state-fact > span { color:var(--muted); font-size:.8rem; }.run-state-fact strong { font-size:.9rem; }.run-state-fact small { color:var(--muted); font-size:.78rem; line-height:1.5; }.reconcile-copy { display:grid; justify-items:start; gap:.5rem; margin-top:1rem; font-size:.8rem; }.reconcile-copy button { padding:.5rem .75rem; border:1px solid var(--line); border-radius:.4rem; color:var(--text); background:var(--panel); }.reconcile-copy small { color:var(--muted); }
  .configuration-strip { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:1rem; padding:1rem 0; }.configuration-strip article { display:grid; gap:.5rem; align-content:start; }.configuration-strip article > span { font-weight:600; }.configuration-strip small { font-size:.8rem; color:var(--muted); line-height:1.5; }.configuration-provenance { display:grid; gap:.6rem; border-top:1px solid var(--line); padding-top:.6rem; }.configuration-pair { display:flex; gap:1rem; flex-wrap:wrap; }.configuration-pair span { display:grid; gap:.3rem; }.configuration-pair strong { font-size:.85rem; }.configuration-value { display:flex; gap:.5rem; flex-wrap:wrap; }.configuration-unrecorded,.configuration-agreement { color:var(--muted); }.configuration-changed .configuration-change { color:var(--status-running); }.configuration-equal { border-top-style:solid; }
  .crew-panel { padding:1.25rem; border:1px solid var(--line); border-radius:.75rem; background:var(--panel); min-width:0; }.crew-panel h2 { margin:.3rem 0; }.crew-panel p,.crew-definition { font-size:.82rem; color:var(--muted); }.crew-definition { display:grid; gap:.3rem; margin:1rem 0; }.crew-seat { border-top:1px solid var(--line); }.crew-seat summary { display:flex; align-items:center; gap:.75rem; flex-wrap:wrap; }.avatar { font-weight:600; color:var(--muted); }.crew-copy { display:grid; gap:.2rem; flex:1; }.crew-copy strong { text-transform:capitalize; }.crew-copy small,.crew-copy > span { color:var(--muted); font-size:.8rem; }.outcome { font-size:.8rem; color:var(--muted); }.assignment-list { display:grid; gap:.5rem; padding:1rem 0; }.assignment-list > span { display:flex; gap:1rem; flex-wrap:wrap; font-size:.8rem; }.seat-policy { margin-top:1rem; }.seat-policy-row { border-top:1px solid var(--line); padding:.5rem 0; font-size:.85rem; }.seat-policy-row header { display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap; }.seat-policy-row header span { color:var(--muted); }.seat-policy-facts,.seat-policy-warning,.seat-policy-warnings { font-size:.82rem; }
  .usage-card dl { grid-template-columns:repeat(2,minmax(0,1fr)); gap:1rem 2rem; }.diagnostics { display:grid; gap:.75rem; }.diagnostics h2 { margin:0; }
  .profile-evidence-heading { display:flex; justify-content:space-between; gap:1rem; margin:1rem 0; }.profile-evidence-heading p { font-size:.85rem; color:var(--muted); }.profile-evidence-heading > span { font-size:.8rem; }.evidence-summary-grid { display:grid; gap:1rem; }.evidence-summary { border-top:1px solid var(--line); padding:.75rem 0; }.evidence-summary header { display:flex; justify-content:space-between; gap:1rem; }.evidence-summary p,.evidence-summary small { font-size:.85rem; color:var(--muted); }.evidence-summary ul { padding-left:1.2rem; font-size:.82rem; }.evidence-summary li { display:grid; gap:.35rem; margin:.75rem 0; overflow-wrap:anywhere; }.topology-summary { margin:1rem 0; }.topology-summary p { font-size:.85rem; color:var(--muted); }.topology-rows { display:flex; gap:.3rem; flex-wrap:wrap; }.topology-stage { width:.65rem; height:.65rem; border-radius:50%; border:1px solid var(--muted); }.topology-stage.observed { background:var(--status-ok); }.topology-defects { font-size:.85rem; }.topology-defects li { display:flex; flex-wrap:wrap; gap:.5rem; }

  .outcome-banner { --outcome-color:var(--muted); border-color:color-mix(in srgb,var(--outcome-color) 30%,var(--line)); border-inline-start:4px solid var(--outcome-color); background:color-mix(in srgb,var(--outcome-color) 6%,var(--panel)); }
  .outcome-banner.serious { --outcome-color:var(--status-escalated); }.outcome-banner.fail { --outcome-color:var(--status-fail); }.outcome-banner.ok { --outcome-color:var(--status-ok); }.outcome-banner.busy,.outcome-banner.aborted { --outcome-color:var(--status-running); }
  .outcome-banner h2 { color:var(--outcome-color); font-size:1.15rem; }.outcome-banner .outcome-icon { color:var(--outcome-color); background:color-mix(in srgb,var(--outcome-color) 14%,var(--panel)); border:1px solid color-mix(in srgb,var(--outcome-color) 28%,var(--line)); font-weight:750; }
  .outcome-banner > button { background:var(--accent-solid); color:var(--on-accent); border-color:var(--accent-solid); font-weight:650; }
  .view-nav { gap:.5rem; }.view-nav button { padding:.75rem 1rem; border-radius:.5rem .5rem 0 0; }.view-nav button[aria-pressed="true"] { color:var(--accent); background:var(--accent-surface); border-bottom-width:3px; }
  .task-title .eyebrow,.report-card header .eyebrow { color:var(--accent); }
  .waterfall-disclosure { border-color:var(--accent-border); border-top:3px solid var(--accent); }.waterfall-disclosure > summary { color:var(--accent); font-weight:650; }
  .report-card { border-top:3px solid var(--accent); }.source-tag { color:var(--accent); background:var(--accent-surface); border:1px solid var(--accent-border); }
  .confidence-grid article { border-inline-start:3px solid var(--line); padding-inline-start:1rem; }.confidence-grid article.positive { border-color:var(--status-ok); }.confidence-grid article.attention { border-color:var(--status-escalated); }
  .confidence-grid article.positive strong { color:var(--status-ok); background:var(--positive-surface); }.confidence-grid article.attention strong { color:var(--status-escalated); background:var(--attention-surface); }
  .confidence-grid strong { width:fit-content; border-radius:.35rem; padding:.25rem .45rem; margin-inline-start:-.45rem; }
  .phase-list button.chosen { background:var(--accent-surface); box-shadow:inset 4px 0 var(--accent); }.phase-list button.chosen strong { color:var(--accent); }.phase-list button.chosen .phase-number { background:var(--accent-solid); color:var(--on-accent); border-color:var(--accent-solid); }
  @media(max-width:1000px) { .detail { padding:1.5rem; }.overview-grid { grid-template-columns:1fr; }.context-card dl { grid-template-columns:repeat(2,minmax(0,1fr)); }.outcome-banner { grid-template-columns:auto minmax(0,1fr); }.outcome-banner > button { grid-column:2; justify-self:start; } }
  @media(max-width:640px) { .detail { padding:1rem; gap:1rem; }.task-header { align-items:start; flex-wrap:wrap; }.outcome-banner { padding:1rem; gap:.75rem; }.view-nav { gap:1rem; }.view-nav button { font-size:.85rem; }.confidence-grid,.configuration-strip,.run-state-facts,.usage-card dl,.context-card dl { grid-template-columns:1fr; }.confidence-grid article + article { border-top:1px solid var(--line); padding-top:1rem; }.report-card,.context-card,.confidence-card,.delivery-card,.activity-card { padding:1rem; }.phase-list button { grid-template-columns:1.5rem minmax(0,1fr) auto; gap:.5rem; }.phase-list button > span:nth-child(3) { grid-column:2; grid-row:2; }.phase-list button > span:last-child { grid-column:3; grid-row:1 / 3; }.profile-evidence-heading { flex-wrap:wrap; } }
</style>
