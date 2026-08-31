<script>
  import { layoutTimeline } from './timeline.js'
  import { bounceArrows, gateMarkers, laneRows } from './trace.js'
  import { factoryStepTrace } from './execution-steps.js'
  import { runActivity } from './fleet.js'
  import { initialJournalState } from './live.js'

  let { run, events = [], journalState = initialJournalState(), selected = null, onselectphase = () => {} } = $props()
  let timeline = $derived(layoutTimeline(run, events))
  let identities = $derived(laneRows(run, events))
  let gates = $derived(gateMarkers(run))
  let bounces = $derived(bounceArrows(run))
  let blocks = $derived([...timeline.blocks, ...timeline.queued].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)))
  let activity = $derived(runActivity(run))
  let factory = $derived(factoryStepTrace(journalState, timeline, { activity:activity.key }))
  let selectedStep = $state(null)
  let selectedDetail = $derived(factory.steps.find((step) => step.started_index === selectedStep) ?? null)
  let linkedPhase = $derived(factory.steps.find((step) => step.started_index === selectedStep)?.phase_id ?? null)
  let selectedPhaseId = $derived(resolveSelectedPhaseId(selected))
  let checkpointGroups = $derived(blocks.map((block) => ({ block, steps:controlsFor(block) })).filter((group) => group.steps.length))
  let traceHeight = $derived(blocks.reduce((height, block) => height + 70 + roundsFor(block).length * 64, 0))
  const ticks = [0, .25, .5, .75, 1]

  function sameId(left, right) { return left != null && right != null && String(left) === String(right) }
  function resolveSelectedPhaseId(value) {
    return (blocks.find((block) => sameId(block.phase_id, value)) ?? blocks.find((block) => block.name === value))?.phase_id ?? null
  }
  function identityFor(lane) { return identities.lanes.find((row) => sameId(row.lane, lane.lane) || (row.lane == null && lane.lane == null)) }
  function markersFor(phaseId) { return gates.markers.filter((marker) => sameId(marker.phase_id, phaseId)) }
  function stepsFor(block) { return factory.steps.filter((step) => sameId(step.phase_id, block.phase_id)) }
  function roundsFor(block) { return stepsFor(block).filter((step) => step.kind === 'agent') }
  function controlsFor(block) { return stepsFor(block).filter((step) => step.kind === 'control') }
  function visualTop(index) { return blocks.slice(0,index).reduce((height, block) => height + 70 + roundsFor(block).length * 64, 0) }
  function blockFor(id) { const index = blocks.findIndex((block) => sameId(block.phase_id, id)); return index < 0 ? null : { block:blocks[index], index } }
  function connectorPath(from, to) {
    const fromX = (from.block.x + from.block.width) * 1000, toX = to.block.x * 1000
    const fromY = visualTop(from.index) + 35, toY = visualTop(to.index) + 35, bend = (fromX + toX) / 2
    return `M ${fromX} ${fromY} C ${bend} ${fromY}, ${bend} ${toY}, ${toX} ${toY}`
  }
  function connectorLabel(from, to, arrow) { return `Review requested changes: ${title(arrow.from_phase)} returned to ${title(arrow.to_phase)} · ${arrow.label}` }
  function gateChipLabel(marker) {
    const gate = marker.generation == null ? 'Gate' : `G${marker.generation}`
    const verdict = marker.tone === 'proven' ? 'Proven' : marker.tone === 'failed' ? 'Failed' : 'Incomplete'
    return `${gate} · ${verdict}`
  }
  function formatDuration(value) {
    if (value == null) return 'running'
    const seconds = Math.max(0, Math.round(value / 1000))
    if (value > 0 && seconds === 0) return '<1s'
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  }
  function tickLabel(position) { return formatDuration(timeline.span_ms * position).replace('running','0s') }
  function title(value) { return String(value || 'phase').replaceAll('_',' ') }
  function statusLabel(value) { return value === 'ok' ? 'Completed' : value === 'running' ? 'Running' : value === 'fail' ? 'Failed' : value || 'Queued' }
  function clock(value) {
    if (value == null) return 'Not recorded'
    return new Intl.DateTimeFormat(undefined, { hour:'numeric', minute:'2-digit', second:'2-digit' }).format(new Date(value))
  }
  function inspectStep(step) {
    selectedStep = selectedStep === step.started_index ? null : step.started_index
  }
  function choosePhase(block) {
    selectedStep = null
    onselectphase(block.phase_id ?? block.name)
  }
  function handoffIdentity(handoff) {
    return [title(handoff.role), handoff.model, handoff.effort].filter(Boolean).join(' · ')
  }
  function handoffName(step) {
    if (!step.handoffs?.length) return step.category.label
    return step.handoffs.map(handoffIdentity).join(', ')
  }
  function phaseSummary(rounds, controls) {
    const parts = []
    if (rounds.length) parts.push(`${rounds.length} agent ${rounds.length === 1 ? 'round' : 'rounds'}`)
    if (controls.length) parts.push(`${controls.length} factory ${controls.length === 1 ? 'checkpoint' : 'checkpoints'}`)
    return parts.join(' · ')
  }
  function checkpointType(step) {
    return step.category.key === 'work' ? 'Coordination' : step.category.label
  }
  function handoffTooltip(handoff) {
    const identity = [title(handoff.role), handoff.model, handoff.effort].filter(Boolean).join(' · ')
    return `${identity || 'Seat assignment'} — ${handoff.state.label}. Seat rail: ${clock(handoff.started_at)} → ${handoff.ended_at == null ? 'no recorded return' : clock(handoff.ended_at)}.`
  }
  function visibleGaps(step) {
    return (step.coverage?.gaps || []).filter((gap) => gap.duration_ms >= 1000)
  }
  function visibleFactoryMs(step) {
    return visibleGaps(step).reduce((total, gap) => total + gap.duration_ms, 0)
  }
  function stepTooltip(step) {
    const factoryMs = visibleFactoryMs(step)
    const coverage = step.coverage == null ? '' : factoryMs > 0
      ? ` Seats were assigned for ${formatDuration(step.coverage.seat_ms)}; ${formatDuration(factoryMs)} was factory-only coordination.`
      : ` A seat covered the full measured round; sub-second timestamp skew is suppressed.`
    return `${step.name} — solid rail marks the factory stage from ${clock(step.started_at)} to ${step.marker ? 'now' : clock(step.ended_at)}.${coverage}`
  }
  function coverageTooltip(step) {
    if (!step.coverage) return 'Seat coverage is not measurable for this round.'
    const factoryMs = visibleFactoryMs(step)
    return factoryMs > 0
      ? `${formatDuration(step.coverage.seat_ms)} with a seat assigned · ${formatDuration(factoryMs)} factory-only dispatch, validation, or closeout.`
      : `${formatDuration(step.coverage.seat_ms)} with a seat assigned · full measured round covered.`
  }
  function factoryGapTooltip(gap) {
    return `Factory-only interval · ${formatDuration(gap.duration_ms)} · no seat assignment was recorded from ${clock(gap.started_at)} to ${clock(gap.ended_at)}.`
  }
</script>

<section class="waterfall-panel">
  <header class="panel-heading">
    <div><p class="micro">Execution trace</p><h2>Waterfall</h2><p>Phases show the workflow. Indented rows show measured seat assignments inside each phase.</p></div>
    <div class="legend"><span><i class="done"></i>Phase</span><span><i class="round"></i>Agent round</span><span><i class="missing"></i>No return</span>{#if bounces.arrows.length}<span title="A review requested changes, so work returned to a later build phase."><i class="bounce"></i>Review → rework</span>{/if}</div>
  </header>

  <details class="trace-guide">
    <summary><span class="help-mark">?</span><span><strong>How to read this trace</strong><small>Rounds, seat coverage, role colors, and gate proof</small></span><b>Open guide</b></summary>
    <div class="trace-guide-grid">
      <article><span class="guide-number">01</span><div><strong>Phase → agent rounds</strong><p>A phase is the broad workflow window. An agent round is one factory-managed stage containing one or more measured seat assignments. The branch shows execution order.</p></div></article>
      <article><span class="rail-demo" aria-hidden="true"><i></i><b><em></em></b></span><div><strong>Thin seat · solid round</strong><p>The upper rail shows when a seat was assigned. The lower rail is the full factory-managed round; hatched sections are measured time with no seat assigned.</p></div></article>
      <article><span class="color-demo" aria-hidden="true"><i></i><i></i><i></i></span><div><strong>Role color = seat owner</strong><p>Each continuous color is one seat assignment. A color change is a handoff to another role. Empty track is genuinely unassigned time—not decorative spacing.</p></div></article>
      <article><span class="proof-demo">G1</span><div><strong>Gate proof</strong><p>“Proven” means the gate passed with the built changes and turned red without them. Each G-number is a distinct authored or repaired gate generation—not overall task acceptance.</p></div></article>
    </div>
  </details>

  {#if timeline.unavailable}<p class="notice">Lane mapping unavailable — {timeline.unavailable}</p>{/if}
  <div class="chart-scroll">
    <div class="chart">
      <div class="axis-label"><span>Phase / owner</span><span>Elapsed time</span></div>
      <div class="axis">
        <div></div><div class="ticks">{#each ticks as tick}<span style={`left:${tick * 100}%`}>{tickLabel(tick)}</span>{/each}</div>
      </div>
      <div class="rows">
        {#each blocks as block, index (block.phase_id ?? block.seq)}
          {@const identity = identityFor(block)}
          {@const markers = markersFor(block.phase_id)}
          {@const rounds = roundsFor(block)}
          {@const controls = controlsFor(block)}
          <button type="button" class="waterfall-row" class:has-rounds={rounds.length > 0} class:selected={linkedPhase == null && sameId(block.phase_id, selectedPhaseId)} class:step-linked={sameId(block.phase_id, linkedPhase)} class:running={block.status === 'running'} onclick={() => choosePhase(block)}>
            <span class="phase-meta"><span class="step">{String(index + 1).padStart(2,'0')}</span><span class="phase-copy"><strong>{title(block.name)}</strong><small><i style={`--role-color:var(--lane-${block.lane ?? 6})`}></i>{identity?.role || (block.lane == null ? 'driver' : `lane ${block.lane}`)}{#if phaseSummary(rounds, controls)}<span class="phase-count">{phaseSummary(rounds, controls)}</span>{/if}</small></span></span>
            <span class="track">
              {#each ticks as tick}<i class="gridline" style={`left:${tick * 100}%`}></i>{/each}
              <span class:queued={block.queued} class:failed={block.status === 'fail'} class="bar" style={`left:${block.x * 100}%;width:${Math.max(block.width * 100,2)}%;--bar-color:var(--lane-${block.lane ?? 6})`}>
                <span>{formatDuration(block.duration_ms)}</span>
                {#each markers as marker (`${marker.generation}-${marker.verdict}`)}<b class={`gate ${marker.tone}`} title={marker.title} aria-label={marker.title}>{gateChipLabel(marker)}</b>{/each}
              </span>
              <span class="row-status">{statusLabel(block.status)}</span>
            </span>
          </button>
          {#each rounds as step, roundIndex (step.started_index)}
            <button type="button" class="round-row" class:first-round={roundIndex === 0} class:last-round={roundIndex === rounds.length - 1} class:selected-step={selectedStep === step.started_index} class:missing-return={step.state.key === 'missing'} onclick={() => inspectStep(step)}>
              <span class="round-meta" style={`--depth:${Math.min(step.depth || 0,3)}`}>
                <i class={step.category.key}></i>
                <span>
                  <strong>{step.name}</strong>
                  <small class="handoff-list">{#each step.handoffs || [] as handoff (handoff.started_index)}<span title={handoffTooltip(handoff)}><i style={`--owner-color:var(--role-${handoff.role})`}></i>{handoffIdentity(handoff)}</span>{/each}</small>
                  {#if step.coverage}<small class="coverage-line" title={coverageTooltip(step)}><span>{formatDuration(step.coverage.seat_ms)} seat</span>{#if visibleFactoryMs(step) > 0}<span class="factory-time">{formatDuration(visibleFactoryMs(step))} factory-only</span>{:else}<span>full coverage</span>{/if}</small>{/if}
                </span>
                <b class={step.state.key}>{step.state.label}</b>
              </span>
              <span class="round-track">
                {#each ticks as tick}<i class="gridline" style={`left:${tick * 100}%`}></i>{/each}
                {#each step.handoffs || [] as handoff (handoff.started_index)}
                  {#if handoff.marker}<span class="agent-marker" title={handoffTooltip(handoff)} style={`left:${handoff.x * 100}%;--agent-color:var(--role-${handoff.role})`}></span>
                  {:else}<span class:no-return={handoff.no_return} class="agent-bar" title={handoffTooltip(handoff)} style={`left:${handoff.x * 100}%;width:${Math.max(handoff.width * 100,.25)}%;--agent-color:var(--role-${handoff.role})`}></span>{/if}
                {/each}
                {#if step.marker}<span class={`step-marker ${step.category.key}`} title={stepTooltip(step)} style={`left:${step.x * 100}%`}></span>{:else}<span class={`step-bar ${step.category.key}`} title={stepTooltip(step)} style={`left:${step.x * 100}%;width:${Math.max(step.width * 100,.25)}%`}></span>{/if}
                {#each visibleGaps(step) as gap (`${gap.started_at}-${gap.ended_at}`)}<span class="factory-gap" title={factoryGapTooltip(gap)} style={`left:${gap.x * 100}%;width:${Math.max(gap.width * 100,.25)}%`}></span>{/each}
                <span class="step-time">{step.state.key === 'missing' ? 'No return' : step.state.key === 'unverified' ? 'Unverified' : step.marker ? 'In progress' : formatDuration(step.duration_ms)}</span>
              </span>
            </button>
          {/each}
        {:else}
          <div class="empty"><strong>No phases recorded</strong><span>The task is waiting for its first execution event.</span></div>
        {/each}
        {#if bounces.arrows.length}
          <svg class="bounce-layer" viewBox={`0 0 1000 ${Math.max(traceHeight,1)}`} preserveAspectRatio="none" aria-label="Review rework connectors"><desc>Dashed arrows show a review that requested changes and returned work to a later build phase.</desc><defs><marker id="review-bounce" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="var(--accent)" /></marker></defs>{#each bounces.arrows as arrow (`${arrow.from_phase_id}-${arrow.to_phase_id}`)}{@const from = blockFor(arrow.from_phase_id)}{@const to = blockFor(arrow.to_phase_id)}{#if from && to}<path d={connectorPath(from, to)} class="bounce-path" marker-end="url(#review-bounce)"><title>{connectorLabel(from, to, arrow)}</title></path>{/if}{/each}</svg>
          <div class="bounce-hit-layer">
            {#each bounces.arrows as arrow (`tip-${arrow.from_phase_id}-${arrow.to_phase_id}`)}
              {@const from = blockFor(arrow.from_phase_id)}
              {@const to = blockFor(arrow.to_phase_id)}
              {#if from && to}
                <button type="button" class="bounce-hotspot" style={`left:${((from.block.x + from.block.width + to.block.x) / 2) * 100}%;top:${(visualTop(from.index) + visualTop(to.index)) / 2 + 35}px`} aria-label={connectorLabel(from, to, arrow)}>
                  <span role="tooltip"><strong>Review → rework</strong>{connectorLabel(from, to, arrow)}</span>
                </button>
              {/if}
            {/each}
          </div>
        {/if}
      </div>
      <details class="factory-steps">
        <summary>
          <span class="steps-mark" aria-hidden="true"><i></i><i></i><i></i></span>
          <span><strong>Factory internals</strong><small>{#if factory.unavailable}Detailed timing unavailable{:else if checkpointGroups.length}{factory.steps.filter((step) => step.kind === 'control').length} validation and control checkpoints · grouped by phase{:else}No factory-only checkpoints in this journal{/if}</small></span>
          <b>View checkpoints</b>
        </summary>
        <div class="steps-body">
          {#if factory.unavailable}
            <div class="steps-empty"><strong>Detailed step timing is unavailable.</strong><span>{factory.unavailable}</span></div>
          {:else if factory.steps.length}
            <div class="steps-intro">
              <div class="guide-copy"><strong>Agent work above, factory control here</strong><p>Agent rounds stay in the main waterfall. These are measured validations, gates, suites, and coordination steps run by the factory itself.</p></div>
              <div class="guide-rules">
                <span class="agent-guide"><i></i><b>Agent round</b><small>Assigned seat, model, and effort</small></span>
                <span class="factory-guide"><i></i><b>Factory checkpoint</b><small>Programmatic control or validation</small></span>
                <span class="control-guide"><i></i><b>No return</b><small>Seat assignment ended without a return</small></span>
              </div>
            </div>
            <div class="checkpoint-groups">
              {#each checkpointGroups as group (group.block.phase_id ?? group.block.seq)}
                <section class="checkpoint-group">
                  <header><span><strong>{title(group.block.name)}</strong><small>{group.steps.length} measured {group.steps.length === 1 ? 'checkpoint' : 'checkpoints'}</small></span><b>{formatDuration(group.steps.reduce((total, step) => total + (step.duration_ms || 0), 0))} measured</b></header>
                  <div class="checkpoint-list">
                    {#each group.steps as step (step.started_index)}
                      <button type="button" class="checkpoint" class:selected-step={selectedStep === step.started_index} onclick={() => inspectStep(step)}>
                        <span class="checkpoint-name"><i class={step.category.key}></i><span><strong>{step.name}</strong><small>{checkpointType(step)}</small></span></span>
                        <span class="checkpoint-track">{#each ticks as tick}<i class="gridline" style={`left:${tick * 100}%`}></i>{/each}{#if step.marker}<span class={`step-marker ${step.category.key}`} style={`left:${step.x * 100}%`}></span>{:else}<span class={`step-bar ${step.category.key}`} style={`left:${step.x * 100}%;width:${Math.max(step.width * 100,.25)}%`}></span>{/if}</span>
                        <span class="checkpoint-outcome"><b class={step.state.key}>{step.state.label}</b><small>{step.marker ? 'In progress' : formatDuration(step.duration_ms)}</small></span>
                      </button>
                    {/each}
                  </div>
                </section>
              {/each}
            </div>
          {:else}
            <div class="steps-empty"><strong>No programmatic checkpoints were recorded.</strong><span>The phase waterfall remains valid; this run predates detailed journal measurement or did not emit factory stages.</span></div>
          {/if}
          {#if factory.anomalies.length}<p class="steps-note">{factory.anomalies.length} journal pairing note{factory.anomalies.length === 1 ? '' : 's'} retained in Agent trajectory.</p>{/if}
        </div>
      </details>
      {#if selectedDetail}
        <div class="step-evidence">
          <span><small>{selectedDetail.kind === 'agent' ? 'Agent round' : 'Factory checkpoint'}</small><strong>{selectedDetail.name}</strong></span>
          <span><small>Owning phase</small><strong>{selectedDetail.phase ? title(selectedDetail.phase) : 'Not linked'}</strong></span>
          <span><small>{selectedDetail.kind === 'agent' ? 'Seat / model / effort' : 'Controlled by'}</small><strong>{selectedDetail.kind === 'agent' ? handoffName(selectedDetail) : 'Factory runtime'}</strong></span>
          <span><small>Outcome</small><strong class={selectedDetail.state.key}>{selectedDetail.state.label}</strong></span>
          <span><small>Timing</small><strong>{clock(selectedDetail.started_at)} → {selectedDetail.marker ? 'now' : clock(selectedDetail.ended_at)}</strong></span>
          <code>{selectedDetail.label} · journal entries {selectedDetail.started_index + 1}{selectedDetail.ended_index == null ? '' : `–${selectedDetail.ended_index + 1}`}</code>
        </div>
      {/if}
    </div>
  </div>
  {#if identities.collapsed.length}<p class="footnote">No phases for {identities.collapsed.map((row) => row.role || `lane ${row.lane ?? '—'}`).join(', ')}; empty lanes are intentionally hidden.</p>{/if}
  {#if bounces.pending}<p class="footnote">Review bounce links unavailable — {bounces.pending}</p>{/if}
</section>

<style>
.waterfall-panel { overflow:hidden; border:1px solid var(--line); border-radius:var(--radius-lg); background:color-mix(in srgb,var(--panel) 95%,transparent); box-shadow:var(--shadow); }
.panel-heading { display:flex; align-items:end; justify-content:space-between; gap:1rem; padding:1rem 1.1rem; border-bottom:1px solid var(--line); }.panel-heading .micro { margin:0 0 .25rem; color:var(--accent); }.panel-heading h2 { margin:0; font-size:1.15rem; }.panel-heading p:not(.micro) { margin:.25rem 0 0; color:var(--muted); font-size:.72rem; }.legend { display:flex; gap:.8rem; color:var(--muted); font-size:.65rem; }.legend span { display:flex; align-items:center; gap:.35rem; }.legend i { width:.55rem; height:.35rem; border-radius:1rem; background:var(--status-ok); }.legend i.round { height:0; border-top:2px solid var(--accent); background:transparent; }.legend i.missing { height:.42rem; border:1px dashed var(--status-fail); background:transparent; }.legend i.bounce { position:relative; width:.8rem; height:0; border-top:1px dashed var(--accent); border-radius:0; background:transparent; }.legend i.bounce::after { content:''; position:absolute; top:-3px; right:-1px; border-top:2px solid transparent; border-bottom:2px solid transparent; border-left:4px solid var(--accent); }
.trace-guide { border-bottom:1px solid var(--line); background:color-mix(in srgb,var(--bg) 36%,transparent); }.trace-guide > summary { display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:.6rem; min-height:2.9rem; padding:.5rem 1rem; cursor:pointer; list-style:none; }.trace-guide > summary::-webkit-details-marker { display:none; }.trace-guide > summary:hover,.trace-guide[open] > summary { background:color-mix(in srgb,var(--accent) 6%,transparent); }.trace-guide > summary > span:nth-child(2) { display:grid; gap:.08rem; }.trace-guide > summary strong { font-size:.64rem; }.trace-guide > summary small { color:var(--muted); font-size:.52rem; }.trace-guide > summary > b { color:var(--accent); font-size:.52rem; }.trace-guide[open] > summary > b { font-size:0; }.trace-guide[open] > summary > b::after { content:'Close guide'; font-size:.52rem; }.help-mark { width:1.3rem; height:1.3rem; display:grid; place-items:center; border:1px solid color-mix(in srgb,var(--accent) 48%,var(--line)); border-radius:50%; color:var(--accent); font:700 .62rem/1 var(--mono); }.trace-guide-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); border-top:1px solid var(--line); }.trace-guide-grid article { min-height:6.2rem; display:grid; grid-template-columns:auto minmax(0,1fr); align-content:center; gap:.65rem; border-left:1px solid var(--line); padding:.75rem 1rem; }.trace-guide-grid article:first-child { border-left:0; }.trace-guide-grid article > div { display:grid; gap:.18rem; }.trace-guide-grid strong { font-size:.6rem; }.trace-guide-grid p { margin:0; color:var(--muted); font-size:.52rem; line-height:1.45; }.guide-number { color:var(--accent); font:700 .6rem/1 var(--mono); }.rail-demo { width:1.8rem; display:grid; gap:.38rem; }.rail-demo i { height:2px; border-radius:1rem; background:var(--planner-color); }.rail-demo b { position:relative; overflow:hidden; height:.28rem; border-radius:1rem; background:var(--builder-color); box-shadow:0 0 6px color-mix(in srgb,var(--builder-color) 35%,transparent); }.rail-demo b em { position:absolute; right:0; width:35%; height:100%; background:repeating-linear-gradient(135deg,color-mix(in srgb,var(--panel) 72%,transparent) 0 2px,transparent 2px 4px); }.color-demo { width:1.8rem; display:flex; gap:0; }.color-demo i { width:.6rem; height:.18rem; background:var(--planner-color); box-shadow:0 0 5px color-mix(in srgb,var(--planner-color) 40%,transparent); }.color-demo i:first-child { border-radius:1rem 0 0 1rem; }.color-demo i:last-child { border-radius:0 1rem 1rem 0; }.color-demo i:nth-child(2) { background:var(--builder-color); }.color-demo i:nth-child(3) { background:var(--reviewer-color); }.proof-demo { border:1px solid color-mix(in srgb,var(--status-ok) 55%,var(--line)); border-radius:.3rem; background:color-mix(in srgb,var(--status-ok) 13%,transparent); padding:.22rem .3rem; color:var(--status-ok); font:700 .5rem/1 var(--mono); }
.notice,.footnote { margin:.75rem 1rem; color:var(--muted); font-size:.7rem; }.chart-scroll { overflow:auto; }.chart { min-width:800px; --identity-column:17rem; --lane-gap:.6rem; }.axis-label,.axis,.waterfall-row,.round-row { display:grid; grid-template-columns:var(--identity-column) minmax(30rem,1fr); column-gap:var(--lane-gap); }.axis-label { padding:.55rem 1rem .25rem; color:var(--muted); font-size:.62rem; letter-spacing:.09em; text-transform:uppercase; }.axis-label span:last-child { padding-left:.85rem; }.axis { padding:0 1rem .55rem; }.ticks { position:relative; height:1rem; margin:0 4.5rem 0 .8rem; }.ticks span { position:absolute; transform:translateX(-50%); color:var(--muted); font:500 .61rem/1 var(--mono); }.ticks span:first-child { transform:none; }.ticks span:last-child { transform:translateX(-100%); }
.rows { position:relative; border-top:1px solid var(--line); }.waterfall-row { position:relative; z-index:1; width:100%; min-height:4.35rem; align-items:stretch; border:0; border-top:1px solid color-mix(in srgb,var(--line) 75%,transparent); background:transparent; padding:0 1rem; color:inherit; text-align:left; cursor:pointer; }.waterfall-row:first-child { border-top:0; }.waterfall-row:hover,.waterfall-row.selected { background:var(--accent-soft); }.waterfall-row.selected { box-shadow:inset 2px 0 var(--accent); }.waterfall-row.step-linked { z-index:3; background:color-mix(in srgb,var(--accent) 10%,var(--panel)); box-shadow:inset 3px 0 var(--accent),inset 0 0 0 1px color-mix(in srgb,var(--accent) 28%,transparent); }
.phase-meta { position:relative; display:flex; align-items:center; gap:.65rem; padding:.65rem .8rem .65rem 0; border-right:1px solid var(--line); }.waterfall-row.has-rounds .phase-meta::before { content:''; position:absolute; left:.42rem; top:calc(50% + .72rem); width:.65rem; border-top:1px solid color-mix(in srgb,var(--accent) 50%,var(--line)); }.waterfall-row.has-rounds .phase-meta::after { content:''; position:absolute; left:.42rem; top:calc(50% + .72rem); bottom:-1px; border-left:1px solid color-mix(in srgb,var(--accent) 50%,var(--line)); }.step { color:var(--muted); font:600 .65rem/1 var(--mono); }.phase-copy { display:grid; gap:.25rem; min-width:0; }.phase-copy strong { text-transform:capitalize; font-size:.82rem; }.phase-copy small { display:flex; align-items:center; gap:.35rem; overflow:hidden; color:var(--muted); font-size:.61rem; text-overflow:ellipsis; white-space:nowrap; }.phase-copy small i { flex:0 0 auto; width:.4rem; height:.4rem; border-radius:50%; background:var(--role-color); box-shadow:0 0 6px color-mix(in srgb,var(--role-color) 60%,transparent); }.phase-count { margin-left:.15rem; border-left:1px solid var(--line); padding-left:.5rem; color:color-mix(in srgb,var(--muted) 84%,var(--accent)); font-size:.5rem; }
.track { position:relative; margin:.7rem 4.5rem .7rem .8rem; border-radius:.35rem; background:color-mix(in srgb,var(--bg) 65%,transparent); overflow:visible; }.gridline { position:absolute; top:0; bottom:0; width:1px; background:color-mix(in srgb,var(--line) 65%,transparent); }.bar { position:absolute; top:.55rem; bottom:.55rem; min-width:1rem; display:flex; align-items:center; gap:.35rem; overflow:visible; border-radius:.35rem; background:linear-gradient(90deg,color-mix(in srgb,var(--bar-color) 75%,var(--panel)),var(--bar-color)); box-shadow:0 4px 12px color-mix(in srgb,var(--bar-color) 14%,transparent); padding:0 .5rem; color:#071015; font:700 .62rem/1 var(--mono); white-space:nowrap; }.bar > span,.gate { flex:0 0 auto; }.waterfall-row.running .bar { box-shadow:0 0 13px color-mix(in srgb,var(--bar-color) 50%,transparent); }.bar.queued { border:1px dashed var(--muted); background:var(--panel); color:var(--muted); box-shadow:none; }.bar.failed { background:var(--status-fail); color:#fff; }.gate { border:1px solid currentColor; border-radius:.25rem; padding:.12rem .25rem; font-size:.55rem; }.gate.failed { color:#611; background:#ffd6d6; }.gate.proven { color:#073e24; background:#c6f7d8; }.gate.unproven { color:#614200; background:#ffe7a9; }.row-status { position:absolute; left:calc(100% + .7rem); top:50%; transform:translateY(-50%); color:var(--muted); font-size:.61rem; }.waterfall-row.running .row-status { color:var(--status-running); }
.empty { min-height:10rem; display:grid; place-content:center; text-align:center; color:var(--muted); }.empty span { margin-top:.3rem; font-size:.72rem; }.footnote { border-top:1px solid var(--line); padding-top:.75rem; }.bounce-layer,.bounce-hit-layer { position:absolute; top:0; bottom:0; left:calc(var(--identity-column) + var(--lane-gap)); width:calc(100% - var(--identity-column) - var(--lane-gap)); height:100%; }.bounce-layer { z-index:2; pointer-events:none; overflow:visible; }.bounce-path { fill:none; stroke:var(--accent); stroke-width:1.5; stroke-dasharray:5 4; opacity:.78; vector-effect:non-scaling-stroke; }.bounce-hit-layer { z-index:4; pointer-events:none; }.bounce-hotspot { position:absolute; width:1.15rem; height:1.15rem; transform:translate(-50%,-50%); border:0; border-radius:50%; background:transparent; padding:0; pointer-events:auto; cursor:help; }.bounce-hotspot::before { content:''; position:absolute; inset:calc(50% - .14rem); border-radius:50%; background:var(--accent); box-shadow:0 0 7px color-mix(in srgb,var(--accent) 48%,transparent); }.bounce-hotspot > span { position:absolute; z-index:8; left:50%; bottom:calc(100% + .4rem); width:max-content; max-width:18rem; display:none; transform:translateX(-50%); border:1px solid color-mix(in srgb,var(--accent) 38%,var(--line)); border-radius:.4rem; background:var(--panel); box-shadow:var(--shadow); padding:.48rem .6rem; color:var(--muted); font:.52rem/1.45 var(--sans); text-align:left; white-space:normal; }.bounce-hotspot > span strong { display:block; margin-bottom:.16rem; color:var(--text); font-size:.56rem; }.bounce-hotspot:hover > span,.bounce-hotspot:focus-visible > span { display:block; }.bounce-hotspot:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }

.round-row { position:relative; z-index:3; width:100%; min-height:4rem; align-items:stretch; border:0; border-top:1px solid color-mix(in srgb,var(--line) 42%,transparent); background:linear-gradient(90deg,color-mix(in srgb,var(--accent) 4%,var(--bg)),color-mix(in srgb,var(--bg) 28%,transparent)); padding:0 1rem; color:inherit; text-align:left; cursor:pointer; }.round-row:hover,.round-row.selected-step { background:color-mix(in srgb,var(--accent) 9%,var(--panel)); }.round-row.selected-step { box-shadow:inset 3px 0 var(--accent); }.round-row.missing-return { background:linear-gradient(90deg,color-mix(in srgb,var(--status-fail) 8%,var(--panel)),color-mix(in srgb,var(--status-fail) 2%,var(--panel))); }
.round-meta { position:relative; min-width:0; display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:.55rem; padding:.48rem .65rem .48rem calc(1.1rem + var(--depth) * .65rem); border-right:1px solid var(--line); }.round-meta::before { content:''; position:absolute; left:.42rem; top:-1px; bottom:-1px; border-left:1px solid color-mix(in srgb,var(--accent) 50%,var(--line)); }.round-meta::after { content:''; position:absolute; left:.42rem; top:50%; width:calc(.68rem + var(--depth) * .65rem); border-top:1px solid color-mix(in srgb,var(--accent) 50%,var(--line)); }.round-row.last-round .round-meta::before { bottom:50%; }.round-meta > i { position:relative; z-index:1; width:.45rem; height:.45rem; border-radius:50%; background:var(--step-color); box-shadow:0 0 7px color-mix(in srgb,var(--step-color) 48%,transparent); }.round-meta > i.work { --step-color:var(--builder-color); }.round-meta > i.validation { --step-color:var(--status-ok); }.round-meta > i.review { --step-color:var(--reviewer-color); }.round-meta > i.factory { --step-color:var(--accent); }.round-meta > span { display:grid; min-width:0; gap:.12rem; }.round-meta strong { overflow:hidden; font-size:.68rem; font-weight:680; text-overflow:ellipsis; text-transform:capitalize; white-space:nowrap; }.round-meta small { overflow:hidden; color:var(--muted); font-size:.52rem; text-overflow:ellipsis; text-transform:none; white-space:nowrap; }.handoff-list { display:flex; align-items:center; gap:.4rem; }.handoff-list > span { min-width:0; display:flex; align-items:center; gap:.22rem; overflow:hidden; text-overflow:ellipsis; }.handoff-list > span + span { border-left:1px solid var(--line); padding-left:.4rem; }.handoff-list i { flex:0 0 auto; width:.38rem; height:.16rem; border-radius:1rem; background:var(--owner-color); box-shadow:0 0 4px color-mix(in srgb,var(--owner-color) 42%,transparent); }.coverage-line { display:flex; align-items:center; gap:.35rem; font:500 .47rem/1 var(--mono); }.coverage-line span + span { border-left:1px solid var(--line); padding-left:.35rem; }.coverage-line .factory-time { color:color-mix(in srgb,var(--accent) 76%,var(--muted)); }.round-meta > b { border:1px solid var(--line); border-radius:1rem; padding:.2rem .4rem; color:var(--muted); font-size:.48rem; font-weight:680; white-space:nowrap; }.round-meta > b.returned { border-color:color-mix(in srgb,var(--status-ok) 35%,var(--line)); color:var(--status-ok); }.round-meta > b.active,.round-meta > b.unverified { border-color:color-mix(in srgb,var(--status-running) 45%,var(--line)); color:var(--status-running); }.round-meta > b.missing { border-color:color-mix(in srgb,var(--status-fail) 55%,var(--line)); background:color-mix(in srgb,var(--status-fail) 7%,transparent); color:var(--status-fail); }
.round-track { position:relative; margin:.48rem 4.5rem .48rem .8rem; border-radius:var(--radius-sm); background:color-mix(in srgb,var(--panel) 68%,transparent); }.round-track::after { content:''; position:absolute; left:0; right:0; top:50%; border-top:1px solid color-mix(in srgb,var(--line) 52%,transparent); }.agent-bar { position:absolute; z-index:1; top:.52rem; height:.2rem; min-width:2px; border-radius:1rem; background:var(--agent-color); box-shadow:0 0 5px color-mix(in srgb,var(--agent-color) 25%,transparent); opacity:.9; }.agent-marker { position:absolute; z-index:1; top:.32rem; height:.62rem; border-left:2px solid var(--agent-color); opacity:.9; }.agent-bar.no-return { height:.38rem; border:1px dashed var(--status-fail); border-radius:.2rem; background:color-mix(in srgb,var(--status-fail) 8%,transparent); box-shadow:none; opacity:1; }.step-bar { position:absolute; z-index:2; top:1.7rem; height:.36rem; min-width:2px; border-radius:1rem; background:var(--step-color); box-shadow:0 0 7px color-mix(in srgb,var(--step-color) 28%,transparent); }.step-marker { position:absolute; z-index:2; top:1.4rem; height:.84rem; border-left:2px solid var(--step-color); }.step-bar.work,.step-marker.work { --step-color:var(--builder-color); }.step-bar.validation,.step-marker.validation { --step-color:var(--status-ok); }.step-bar.review,.step-marker.review { --step-color:var(--reviewer-color); }.step-bar.factory,.step-marker.factory { --step-color:var(--accent); }.factory-gap { position:absolute; z-index:3; top:1.7rem; height:.36rem; min-width:2px; border-radius:1rem; background:repeating-linear-gradient(135deg,color-mix(in srgb,var(--panel) 74%,transparent) 0 3px,transparent 3px 6px); outline:1px solid color-mix(in srgb,var(--muted) 32%,transparent); outline-offset:-1px; }.step-time { position:absolute; left:calc(100% + .7rem); top:50%; transform:translateY(-50%); color:var(--muted); font:500 .55rem/1 var(--mono); white-space:nowrap; }.missing-return .step-time { color:var(--status-fail); }

.factory-steps { border-top:1px solid var(--line); background:color-mix(in srgb,var(--bg) 36%,transparent); }.factory-steps > summary { display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:.7rem; min-height:3.8rem; padding:.7rem 1rem; cursor:pointer; list-style:none; }.factory-steps > summary::-webkit-details-marker { display:none; }.factory-steps > summary:hover { background:var(--accent-soft); }.factory-steps > summary > span:nth-child(2) { display:grid; gap:.15rem; }.factory-steps > summary strong { font-size:.74rem; }.factory-steps > summary small { color:var(--muted); font-size:.6rem; }.factory-steps > summary b { border:1px solid color-mix(in srgb,var(--accent) 36%,var(--line)); border-radius:1rem; padding:.25rem .5rem; color:var(--accent); font-size:.54rem; }.factory-steps[open] > summary { background:var(--accent-soft); }.factory-steps[open] > summary b { font-size:0; }.factory-steps[open] > summary b::after { content:'Hide checkpoints'; font-size:.54rem; }.steps-mark { display:grid; gap:3px; width:1.8rem; }.steps-mark i { height:2px; border-radius:1rem; background:var(--muted); }.steps-mark i:nth-child(1) { width:65%; }.steps-mark i:nth-child(2) { width:100%; background:var(--accent); }.steps-mark i:nth-child(3) { width:45%; margin-left:30%; }.steps-body { border-top:1px solid var(--line); }.steps-intro { display:grid; grid-template-columns:minmax(15rem,1.1fr) minmax(28rem,2fr); align-items:center; gap:1rem; padding:.75rem 1rem; border-bottom:1px solid color-mix(in srgb,var(--line) 70%,transparent); background:color-mix(in srgb,var(--bg) 72%,transparent); }.guide-copy { display:grid; gap:.2rem; }.guide-copy strong { font-size:.68rem; }.guide-copy p { max-width:36rem; margin:0; color:var(--muted); font-size:.58rem; line-height:1.45; }.guide-rules { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:.45rem; }.guide-rules > span { display:grid; grid-template-columns:auto minmax(0,1fr); gap:.1rem .4rem; align-items:center; min-width:0; border-left:1px solid var(--line); padding-left:.6rem; }.guide-rules i { grid-row:1/3; width:1rem; }.guide-rules b { overflow:hidden; font-size:.56rem; text-overflow:ellipsis; white-space:nowrap; }.guide-rules small { overflow:hidden; color:var(--muted); font-size:.48rem; text-overflow:ellipsis; white-space:nowrap; }.agent-guide i { height:2px; border-radius:1rem; background:var(--planner-color); }.factory-guide i { height:.28rem; border-radius:1rem; background:var(--accent); box-shadow:0 0 5px color-mix(in srgb,var(--accent) 35%,transparent); }.control-guide i { height:.55rem; border:1px dashed var(--status-fail); border-radius:.2rem; }
.checkpoint-groups { display:grid; gap:.65rem; padding:.75rem 1rem 1rem; }.checkpoint-group { overflow:hidden; border:1px solid var(--line); border-radius:var(--radius-md); background:color-mix(in srgb,var(--panel) 84%,transparent); }.checkpoint-group > header { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:.55rem .7rem; border-bottom:1px solid var(--line); background:color-mix(in srgb,var(--accent) 4%,var(--panel)); }.checkpoint-group > header span { display:flex; align-items:baseline; gap:.45rem; }.checkpoint-group > header strong { font-size:.66rem; text-transform:capitalize; }.checkpoint-group > header small,.checkpoint-group > header > b { color:var(--muted); font-size:.5rem; font-weight:500; }.checkpoint-list { display:grid; }.checkpoint { width:100%; min-height:2.7rem; display:grid; grid-template-columns:15rem minmax(22rem,1fr) 6.5rem; align-items:stretch; border:0; border-top:1px solid color-mix(in srgb,var(--line) 55%,transparent); background:transparent; color:inherit; padding:0; text-align:left; cursor:pointer; }.checkpoint:first-child { border-top:0; }.checkpoint:hover,.checkpoint.selected-step { background:color-mix(in srgb,var(--accent) 7%,transparent); }.checkpoint.selected-step { box-shadow:inset 3px 0 var(--accent); }.checkpoint-name { min-width:0; display:flex; align-items:center; gap:.5rem; padding:.48rem .65rem; border-right:1px solid var(--line); }.checkpoint-name > i { flex:0 0 auto; width:.42rem; height:.42rem; border-radius:50%; background:var(--step-color); box-shadow:0 0 6px color-mix(in srgb,var(--step-color) 45%,transparent); }.checkpoint-name > i.validation { --step-color:var(--status-ok); }.checkpoint-name > i.review { --step-color:var(--reviewer-color); }.checkpoint-name > i.factory { --step-color:var(--accent); }.checkpoint-name > i.work { --step-color:var(--builder-color); }.checkpoint-name > span { display:grid; min-width:0; gap:.1rem; }.checkpoint-name strong { overflow:hidden; font-size:.59rem; font-weight:650; text-overflow:ellipsis; white-space:nowrap; }.checkpoint-name small { color:var(--muted); font-size:.48rem; }.checkpoint-track { position:relative; margin:.55rem .7rem; border-radius:.25rem; background:color-mix(in srgb,var(--bg) 58%,transparent); }.checkpoint-track .step-bar { top:50%; height:.32rem; transform:translateY(-50%); }.checkpoint-track .step-marker { top:50%; height:.72rem; transform:translateY(-50%); }.checkpoint-outcome { display:grid; place-content:center start; gap:.12rem; border-left:1px solid var(--line); padding:.4rem .65rem; }.checkpoint-outcome b { color:var(--accent); font-size:.52rem; }.checkpoint-outcome b.missing { color:var(--status-fail); }.checkpoint-outcome small { color:var(--muted); font:500 .49rem/1 var(--mono); }
.step-evidence { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); align-items:center; gap:.75rem; margin:.7rem 1rem; border:1px solid color-mix(in srgb,var(--accent) 32%,var(--line)); border-radius:var(--radius-sm); background:color-mix(in srgb,var(--accent) 5%,var(--panel)); padding:.6rem .7rem; }.step-evidence span { display:grid; gap:.15rem; }.step-evidence small { color:var(--muted); font-size:.49rem; text-transform:uppercase; letter-spacing:.06em; }.step-evidence strong { overflow:hidden; font-size:.57rem; font-weight:600; text-overflow:ellipsis; text-transform:capitalize; white-space:nowrap; }.step-evidence code { grid-column:1/-1; border-top:1px solid var(--line); padding-top:.45rem; color:var(--accent); font:500 .52rem/1 var(--mono); }.step-evidence strong.missing { color:var(--status-fail); }.step-evidence strong.active,.step-evidence strong.unverified { color:var(--status-running); }.step-evidence strong.returned { color:var(--status-ok); }.steps-empty { min-height:6.5rem; display:grid; place-content:center; gap:.25rem; color:var(--muted); text-align:center; }.steps-empty strong { color:inherit; font-size:.68rem; }.steps-empty span { max-width:34rem; font-size:.57rem; line-height:1.45; }.steps-note { margin:0; border-top:1px solid var(--line); padding:.55rem 1rem; color:var(--muted); font-size:.54rem; }
@media (max-width: 1100px) { .trace-guide-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }.trace-guide-grid article:nth-child(3) { border-left:0; border-top:1px solid var(--line); }.trace-guide-grid article:nth-child(4) { border-top:1px solid var(--line); } }
@media (max-width: 900px) { .steps-intro { grid-template-columns:1fr; align-items:start; }.guide-rules { width:100%; }.checkpoint { grid-template-columns:13rem minmax(20rem,1fr) 6rem; } }
@media (max-width: 700px) { .panel-heading { align-items:start; }.legend { display:none; } }
</style>
