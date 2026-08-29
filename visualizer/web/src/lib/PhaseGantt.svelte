<script>
  import { layoutTimeline } from './timeline.js'
  import { bounceArrows, gateMarkers, laneRows } from './trace.js'
  import { factoryStepTrace } from './execution-steps.js'
  import { initialJournalState } from './live.js'

  let { run, events = [], journalState = initialJournalState(), selected = null, onselectphase = () => {} } = $props()
  let timeline = $derived(layoutTimeline(run, events))
  let identities = $derived(laneRows(run, events))
  let gates = $derived(gateMarkers(run))
  let bounces = $derived(bounceArrows(run))
  let blocks = $derived([...timeline.blocks, ...timeline.queued].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)))
  let factory = $derived(factoryStepTrace(journalState, timeline))
  let selectedStep = $state(null)
  let factoryOpen = $state(false)
  let linkedPhase = $derived(factory.steps.find((step) => step.started_index === selectedStep)?.phase_id ?? null)
  const ticks = [0, .25, .5, .75, 1]

  function sameId(left, right) { return left != null && right != null && String(left) === String(right) }
  function identityFor(lane) { return identities.lanes.find((row) => sameId(row.lane, lane.lane) || (row.lane == null && lane.lane == null)) }
  function markersFor(phaseId) { return gates.markers.filter((marker) => sameId(marker.phase_id, phaseId)) }
  function blockFor(id) { const index = blocks.findIndex((block) => sameId(block.phase_id, id)); return index < 0 ? null : { block:blocks[index], index } }
  function connectorPath(from, to) {
    const fromX = (from.block.x + from.block.width) * 1000, toX = to.block.x * 1000
    const fromY = from.index * 70 + 35, toY = to.index * 70 + 35, bend = (fromX + toX) / 2
    return `M ${fromX} ${fromY} C ${bend} ${fromY}, ${bend} ${toY}, ${toX} ${toY}`
  }
  function connectorLabel(from, to, arrow) { return `${arrow.from_phase} ↗ ${arrow.to_phase} · ${arrow.label}` }
  function formatDuration(value) {
    if (value == null) return 'running'
    const seconds = Math.max(0, Math.round(value / 1000))
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
  function handoffName(step) {
    if (!step.handoffs?.length) return 'Factory controlled'
    return step.handoffs.map((handoff) => `${title(handoff.role)} ${handoff.id || ''}`.trim()).join(', ')
  }
</script>

<section class="waterfall-panel">
  <header class="panel-heading">
    <div><p class="micro">Execution trace</p><h2>Waterfall</h2><p>Major phases show the workflow; measured factory steps reveal what happened inside them.</p></div>
    <div class="legend"><span><i class="done"></i>Complete</span><span><i class="current"></i>Current</span><span><i class="queued"></i>Queued</span></div>
  </header>

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
          {@const header = identity?.header}
          {@const markers = markersFor(block.phase_id)}
          <button type="button" class="waterfall-row" class:selected={linkedPhase == null && selected === block.name} class:step-linked={sameId(block.phase_id, linkedPhase)} class:running={block.status === 'running'} onclick={() => onselectphase(block.name)}>
            <span class="phase-meta"><span class="step">{String(index + 1).padStart(2,'0')}</span><span class="phase-copy"><strong>{title(block.name)}</strong><small><i style={`--role-color:var(--lane-${block.lane ?? 6})`}></i>{identity?.role || (block.lane == null ? 'driver' : `lane ${block.lane}`)}{#if header?.model} · {header.model}{/if}</small></span></span>
            <span class="track">
              {#each ticks as tick}<i class="gridline" style={`left:${tick * 100}%`}></i>{/each}
              <span class:queued={block.queued} class:failed={block.status === 'fail'} class="bar" style={`left:${block.x * 100}%;width:${Math.max(block.width * 100,2)}%;--bar-color:var(--lane-${block.lane ?? 6})`}>
                <span>{formatDuration(block.duration_ms)}</span>
                {#each markers as marker (`${marker.generation}-${marker.verdict}`)}<b class={`gate ${marker.tone}`} title={marker.title}>{marker.label}</b>{/each}
              </span>
              <span class="row-status">{statusLabel(block.status)}</span>
            </span>
          </button>
        {:else}
          <div class="empty"><strong>No phases recorded</strong><span>The task is waiting for its first execution event.</span></div>
        {/each}
        {#if bounces.arrows.length}
          <svg class="bounce-layer" viewBox={`0 0 1000 ${Math.max(blocks.length,1) * 70}`} preserveAspectRatio="none" aria-label="Review bounce connectors"><defs><marker id="review-bounce" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="var(--accent)" /></marker></defs>{#each bounces.arrows as arrow (`${arrow.from_phase_id}-${arrow.to_phase_id}`)}{@const from = blockFor(arrow.from_phase_id)}{@const to = blockFor(arrow.to_phase_id)}{#if from && to}<path d={connectorPath(from, to)} class="bounce-path" marker-end="url(#review-bounce)"><title>{connectorLabel(from, to, arrow)}</title></path>{/if}{/each}</svg>
        {/if}
      </div>
      <details class="factory-steps" open={factoryOpen} ontoggle={(event) => { factoryOpen = event.currentTarget.open }}>
        <summary>
          <span class="steps-mark" aria-hidden="true"><i></i><i></i><i></i></span>
          <span><strong>Factory steps</strong><small>{#if factory.unavailable}Detailed timing unavailable{:else if factory.steps.length}{factory.steps.length} measured checkpoint{factory.steps.length === 1 ? '' : 's'} across this run{:else}No measured checkpoints in this journal{/if}</small></span>
          <b>{factory.steps.length ? 'Show detailed steps' : 'Details'}</b>
        </summary>
        <div class="steps-body">
          {#if factory.unavailable}
            <div class="steps-empty"><strong>Detailed step timing is unavailable.</strong><span>{factory.unavailable}</span></div>
          {:else if factory.steps.length}
            <div class="steps-intro"><p>Measured programmatic checkpoints—not inferred agent tool calls. Select a checkpoint to highlight its parent phase above.</p><div class="step-key"><span class="agent-rail">Agent handoff</span><span class="factory-rail">Factory step</span></div></div>
            <div class="step-list">
              {#each factory.steps as step (step.started_index)}
                <button type="button" class:selected-step={selectedStep === step.started_index} class="step-row" onclick={() => inspectStep(step)}>
                  <span class="step-meta" style={`--depth:${Math.min(step.depth || 0,3)}`}><i class={step.category.key}></i><span><strong>{step.name}</strong><small>{step.category.label} inside {step.phase ? title(step.phase) : 'an unlinked phase'} · Agent: {handoffName(step)}</small></span></span>
                  <span class="step-track">
                    {#each ticks as tick}<i class="gridline" style={`left:${tick * 100}%`}></i>{/each}
                    {#each step.handoffs || [] as handoff (handoff.started_index)}{#if handoff.marker}<span class="agent-marker" title={`${title(handoff.role)} ${handoff.id || ''}`} style={`left:${handoff.x * 100}%;--agent-color:var(--role-${handoff.role})`}></span>{:else}<span class="agent-bar" title={`${title(handoff.role)} ${handoff.id || ''}`} style={`left:${handoff.x * 100}%;width:${Math.max(handoff.width * 100,.25)}%;--agent-color:var(--role-${handoff.role})`}></span>{/if}{/each}
                    {#if step.marker}<span class={`step-marker ${step.category.key}`} style={`left:${step.x * 100}%`}></span>{:else}<span class={`step-bar ${step.category.key}`} style={`left:${step.x * 100}%;width:${Math.max(step.width * 100,.25)}%`}></span>{/if}
                    <span class="rail-labels" aria-hidden="true"><i>Agent</i><b>Factory</b></span>
                    <span class="step-time">{step.marker ? 'In progress' : formatDuration(step.duration_ms)}</span>
                  </span>
                </button>
                {#if selectedStep === step.started_index}
                  <div class="step-evidence">
                    <span><small>Owning phase</small><strong>{step.phase ? title(step.phase) : 'Not linked'}</strong></span>
                    <span><small>Active handoff</small><strong>{handoffName(step)}</strong></span>
                    <span><small>Started</small><strong>{clock(step.started_at)}</strong></span>
                    <span><small>Finished</small><strong>{step.marker ? 'Still running' : clock(step.ended_at)}</strong></span>
                    <span><small>Journal evidence</small><strong>Entries {step.started_index + 1}{step.ended_index == null ? '' : `–${step.ended_index + 1}`}</strong></span>
                    <code>{step.label}</code>
                  </div>
                {/if}
              {/each}
            </div>
          {:else}
            <div class="steps-empty"><strong>No programmatic checkpoints were recorded.</strong><span>The phase waterfall remains valid; this run predates detailed journal measurement or did not emit factory stages.</span></div>
          {/if}
          {#if factory.anomalies.length}<p class="steps-note">{factory.anomalies.length} journal pairing note{factory.anomalies.length === 1 ? '' : 's'} retained in Agent trajectory.</p>{/if}
        </div>
      </details>
    </div>
  </div>
  {#if identities.collapsed.length}<p class="footnote">No phases for {identities.collapsed.map((row) => row.role || `lane ${row.lane ?? '—'}`).join(', ')}; empty lanes are intentionally hidden.</p>{/if}
  {#if bounces.pending}<p class="footnote">Review bounce links unavailable — {bounces.pending}</p>{/if}
</section>

<style>
.waterfall-panel { overflow:hidden; border:1px solid var(--line); border-radius:var(--radius-lg); background:color-mix(in srgb,var(--panel) 95%,transparent); box-shadow:var(--shadow); }
.panel-heading { display:flex; align-items:end; justify-content:space-between; gap:1rem; padding:1rem 1.1rem; border-bottom:1px solid var(--line); }.panel-heading .micro { margin:0 0 .25rem; color:var(--accent); }.panel-heading h2 { margin:0; font-size:1.15rem; }.panel-heading p:not(.micro) { margin:.25rem 0 0; color:var(--muted); font-size:.72rem; }.legend { display:flex; gap:.8rem; color:var(--muted); font-size:.65rem; }.legend span { display:flex; align-items:center; gap:.35rem; }.legend i { width:.55rem; height:.35rem; border-radius:1rem; background:var(--status-ok); }.legend i.current { background:var(--status-running); box-shadow:0 0 6px var(--status-running); }.legend i.queued { border:1px dashed var(--muted); background:transparent; }
.notice,.footnote { margin:.75rem 1rem; color:var(--muted); font-size:.7rem; }.chart-scroll { overflow:auto; }.chart { min-width:800px; --identity-column:15rem; --lane-gap:.6rem; }.axis-label,.axis,.waterfall-row { display:grid; grid-template-columns:var(--identity-column) minmax(30rem,1fr); column-gap:var(--lane-gap); }.axis-label { padding:.55rem 1rem .25rem; color:var(--muted); font-size:.62rem; letter-spacing:.09em; text-transform:uppercase; }.axis-label span:last-child { padding-left:.85rem; }.axis { padding:0 1rem .55rem; }.ticks { position:relative; height:1rem; margin:0 4.5rem 0 .8rem; }.ticks span { position:absolute; transform:translateX(-50%); color:var(--muted); font:500 .61rem/1 var(--mono); }.ticks span:first-child { transform:none; }.ticks span:last-child { transform:translateX(-100%); }
.rows { position:relative; border-top:1px solid var(--line); }.waterfall-row { position:relative; z-index:1; width:100%; min-height:4.35rem; align-items:stretch; border:0; border-top:1px solid color-mix(in srgb,var(--line) 75%,transparent); background:transparent; padding:0 1rem; color:inherit; text-align:left; cursor:pointer; }.waterfall-row:first-child { border-top:0; }.waterfall-row:hover,.waterfall-row.selected { background:var(--accent-soft); }.waterfall-row.selected { box-shadow:inset 2px 0 var(--accent); }.waterfall-row.step-linked { z-index:3; background:color-mix(in srgb,var(--accent) 10%,var(--panel)); box-shadow:inset 3px 0 var(--accent),inset 0 0 0 1px color-mix(in srgb,var(--accent) 28%,transparent); }
.phase-meta { display:flex; align-items:center; gap:.65rem; padding:.65rem .8rem .65rem 0; border-right:1px solid var(--line); }.step { color:var(--muted); font:600 .65rem/1 var(--mono); }.phase-copy { display:grid; gap:.25rem; min-width:0; }.phase-copy strong { text-transform:capitalize; font-size:.79rem; }.phase-copy small { display:flex; align-items:center; gap:.35rem; color:var(--muted); font-size:.61rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.phase-copy small i { flex:0 0 auto; width:.4rem; height:.4rem; border-radius:50%; background:var(--role-color); box-shadow:0 0 6px color-mix(in srgb,var(--role-color) 60%,transparent); }
.track { position:relative; margin:.7rem 4.5rem .7rem .8rem; border-radius:.35rem; background:color-mix(in srgb,var(--bg) 65%,transparent); overflow:visible; }.gridline { position:absolute; top:0; bottom:0; width:1px; background:color-mix(in srgb,var(--line) 65%,transparent); }.bar { position:absolute; top:.55rem; bottom:.55rem; min-width:1rem; display:flex; align-items:center; gap:.35rem; overflow:hidden; border-radius:.35rem; background:linear-gradient(90deg,color-mix(in srgb,var(--bar-color) 75%,var(--panel)),var(--bar-color)); box-shadow:0 4px 12px color-mix(in srgb,var(--bar-color) 14%,transparent); padding:0 .5rem; color:#071015; font:700 .62rem/1 var(--mono); white-space:nowrap; }.waterfall-row.running .bar { box-shadow:0 0 13px color-mix(in srgb,var(--bar-color) 50%,transparent); }.bar.queued { border:1px dashed var(--muted); background:var(--panel); color:var(--muted); box-shadow:none; }.bar.failed { background:var(--status-fail); color:#fff; }.gate { border:1px solid currentColor; border-radius:.25rem; padding:.12rem .25rem; font-size:.55rem; }.gate.failed { color:#611; background:#ffd6d6; }.gate.proven { color:#073e24; background:#c6f7d8; }.gate.unproven { color:#614200; background:#ffe7a9; }
.row-status { position:absolute; left:calc(100% + .7rem); top:50%; transform:translateY(-50%); color:var(--muted); font-size:.61rem; }.waterfall-row.running .row-status { color:var(--status-running); }.empty { min-height:10rem; display:grid; place-content:center; text-align:center; color:var(--muted); }.empty span { margin-top:.3rem; font-size:.72rem; }.footnote { border-top:1px solid var(--line); padding-top:.75rem; }
.bounce-layer { position:absolute; z-index:2; pointer-events:none; top:0; bottom:0; left:calc(var(--identity-column) + var(--lane-gap)); right:0; width:auto; height:100%; overflow:visible; }.bounce-path { fill:none; stroke:var(--accent); stroke-width:1.5; stroke-dasharray:5 4; opacity:.78; vector-effect:non-scaling-stroke; }
.factory-steps { border-top:1px solid var(--line); background:color-mix(in srgb,var(--bg) 36%,transparent); }.factory-steps > summary { display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:.65rem; min-height:3.5rem; padding:.65rem 1rem; cursor:pointer; list-style:none; }.factory-steps > summary::-webkit-details-marker { display:none; }.factory-steps > summary:hover { background:var(--accent-soft); }.factory-steps > summary > span:nth-child(2) { display:grid; gap:.15rem; }.factory-steps > summary strong { font-size:.7rem; }.factory-steps > summary small { color:var(--muted); font-size:.58rem; }.factory-steps > summary b { color:var(--accent); font-size:.58rem; }.factory-steps[open] > summary { background:var(--accent-soft); }.factory-steps[open] > summary b { font-size:0; }.factory-steps[open] > summary b::after { content:'Hide detailed steps'; font-size:.58rem; }.steps-mark { display:grid; gap:2px; width:1.8rem; }.steps-mark i { height:2px; border-radius:1rem; background:var(--muted); }.steps-mark i:nth-child(1) { width:65%; }.steps-mark i:nth-child(2) { width:100%; background:var(--accent); }.steps-mark i:nth-child(3) { width:45%; margin-left:30%; }.steps-body { max-height:min(38rem,65vh); overflow:auto; overscroll-behavior:contain; scrollbar-gutter:stable; contain:layout paint; border-top:1px solid var(--line); }.steps-intro { position:sticky; z-index:4; top:0; display:flex; justify-content:space-between; align-items:center; gap:1rem; padding:.6rem 1rem; border-bottom:1px solid color-mix(in srgb,var(--line) 70%,transparent); background:color-mix(in srgb,var(--bg) 96%,transparent); }.steps-intro p { margin:0; color:var(--muted); font-size:.58rem; }.step-key { display:flex; gap:.55rem; color:var(--muted); font-size:.54rem; }.step-key span { display:flex; align-items:center; gap:.25rem; }.step-key span::before { content:''; width:.42rem; height:.42rem; border-radius:50%; background:var(--step-color); }.step-list { padding:.3rem 0; }.step-row { width:100%; display:grid; grid-template-columns:var(--identity-column) minmax(30rem,1fr); column-gap:var(--lane-gap); align-items:stretch; min-height:2.9rem; border:0; border-top:1px solid color-mix(in srgb,var(--line) 45%,transparent); background:transparent; color:inherit; padding:0 1rem; text-align:left; cursor:pointer; }.step-row:first-child { border-top:0; }.step-row:hover,.step-row.selected-step { background:color-mix(in srgb,var(--accent) 5%,transparent); }.step-meta { display:flex; align-items:center; gap:.5rem; min-width:0; padding:.42rem .8rem .42rem calc(var(--depth) * .65rem); border-right:1px solid var(--line); }.step-meta > i { flex:0 0 auto; width:.45rem; height:.45rem; border-radius:50%; background:var(--step-color); box-shadow:0 0 6px color-mix(in srgb,var(--step-color) 45%,transparent); }.step-meta > i.work { --step-color:var(--builder-color); }.step-meta > i.validation { --step-color:var(--status-ok); }.step-meta > i.review { --step-color:var(--reviewer-color); }.step-meta > i.factory { --step-color:var(--accent); }.step-meta > span { display:grid; min-width:0; gap:.14rem; }.step-meta strong { overflow:hidden; font-size:.61rem; font-weight:600; text-overflow:ellipsis; text-transform:capitalize; white-space:nowrap; }.step-meta small { overflow:hidden; color:var(--muted); font-size:.52rem; text-overflow:ellipsis; white-space:nowrap; }.step-track { position:relative; margin:.4rem 4.5rem .4rem .8rem; border-radius:var(--radius-sm); background:color-mix(in srgb,var(--panel) 75%,transparent); }.agent-bar { position:absolute; top:.42rem; height:.22rem; min-width:2px; border-radius:1rem; background:var(--agent-color); opacity:.72; }.agent-marker { position:absolute; top:.25rem; height:.55rem; border-left:2px solid var(--agent-color); }.step-bar { position:absolute; top:1.25rem; height:.35rem; min-width:2px; border-radius:1rem; background:var(--step-color); box-shadow:0 0 7px color-mix(in srgb,var(--step-color) 28%,transparent); }.step-marker { position:absolute; top:1.03rem; height:.8rem; border-left:2px solid var(--step-color); }.step-bar.work,.step-marker.work { --step-color:var(--builder-color); }.step-bar.validation,.step-marker.validation { --step-color:var(--status-ok); }.step-bar.review,.step-marker.review { --step-color:var(--reviewer-color); }.step-bar.factory,.step-marker.factory { --step-color:var(--accent); }.step-time { position:absolute; left:calc(100% + .7rem); top:50%; transform:translateY(-50%); color:var(--muted); font:500 .54rem/1 var(--mono); white-space:nowrap; }.step-evidence { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); align-items:center; gap:.75rem; margin:0 1rem .4rem calc(var(--identity-column) + var(--lane-gap) + 1rem); border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--panel); padding:.55rem .65rem; }.step-evidence span { display:grid; gap:.15rem; }.step-evidence small { color:var(--muted); font-size:.49rem; text-transform:uppercase; letter-spacing:.06em; }.step-evidence strong { overflow:hidden; font-size:.56rem; font-weight:600; text-overflow:ellipsis; text-transform:capitalize; white-space:nowrap; }.step-evidence code { grid-column:1/-1; border-top:1px solid var(--line); padding-top:.45rem; color:var(--accent); font:500 .52rem/1 var(--mono); }.steps-empty { min-height:6.5rem; display:grid; place-content:center; gap:.25rem; color:var(--muted); text-align:center; }.steps-empty strong { color:inherit; font-size:.68rem; }.steps-empty span { max-width:34rem; font-size:.57rem; line-height:1.45; }.steps-note { margin:0; border-top:1px solid var(--line); padding:.55rem 1rem; color:var(--muted); font-size:.54rem; }
.step-key .agent-rail::before { width:.8rem; height:0; border-top:2px dashed var(--muted); border-radius:0; background:transparent; }.step-key .factory-rail::before { width:.8rem; height:.24rem; border-radius:1rem; background:var(--accent); box-shadow:0 0 5px color-mix(in srgb,var(--accent) 35%,transparent); }.step-track { margin-right:8.5rem; }.step-track::after { content:''; position:absolute; left:0; right:0; top:1rem; border-top:1px solid color-mix(in srgb,var(--line) 55%,transparent); }.agent-bar { z-index:1; height:0; border-top:2px dashed var(--agent-color); border-radius:0; background:transparent; opacity:.78; }.agent-marker { z-index:1; border-left-style:dashed; opacity:.78; }.step-bar,.step-marker { z-index:2; }.rail-labels { position:absolute; left:calc(100% + .55rem); top:.28rem; display:grid; gap:.42rem; color:var(--muted); font:600 .46rem/1 var(--sans); letter-spacing:.06em; text-transform:uppercase; }.rail-labels i { font-style:normal; }.rail-labels b { color:var(--accent); font-weight:700; }.step-time { left:calc(100% + 4.25rem); }
@media (max-width: 700px) { .panel-heading { align-items:start; }.legend { display:none; } }
</style>
