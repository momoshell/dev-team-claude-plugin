<script>
  import { layoutTimeline } from './timeline.js'
  import { bounceArrows, gateMarkers, laneRows } from './trace.js'

  let { run, events = [], selected = null, onselectphase = () => {} } = $props()
  let timeline = $derived(layoutTimeline(run, events))
  let identities = $derived(laneRows(run, events))
  let gates = $derived(gateMarkers(run))
  let bounces = $derived(bounceArrows(run))
  let blocks = $derived([...timeline.blocks, ...timeline.queued].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)))
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
</script>

<section class="waterfall-panel">
  <header class="panel-heading">
    <div><p class="micro">Execution trace</p><h2>Waterfall</h2><p>Every phase positioned by when it started and how long it ran.</p></div>
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
          <button type="button" class="waterfall-row" class:selected={selected === block.name} class:running={block.status === 'running'} onclick={() => onselectphase(block.name)}>
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
    </div>
  </div>
  {#if identities.collapsed.length}<p class="footnote">No phases for {identities.collapsed.map((row) => row.role || `lane ${row.lane ?? '—'}`).join(', ')}; empty lanes are intentionally hidden.</p>{/if}
  {#if bounces.pending}<p class="footnote">Review bounce links unavailable — {bounces.pending}</p>{/if}
</section>

<style>
.waterfall-panel { overflow:hidden; border:1px solid var(--line); border-radius:var(--radius-lg); background:color-mix(in srgb,var(--panel) 95%,transparent); box-shadow:var(--shadow); }
.panel-heading { display:flex; align-items:end; justify-content:space-between; gap:1rem; padding:1rem 1.1rem; border-bottom:1px solid var(--line); }.panel-heading .micro { margin:0 0 .25rem; color:var(--accent); }.panel-heading h2 { margin:0; font-size:1.15rem; }.panel-heading p:not(.micro) { margin:.25rem 0 0; color:var(--muted); font-size:.72rem; }.legend { display:flex; gap:.8rem; color:var(--muted); font-size:.65rem; }.legend span { display:flex; align-items:center; gap:.35rem; }.legend i { width:.55rem; height:.35rem; border-radius:1rem; background:var(--status-ok); }.legend i.current { background:var(--status-running); box-shadow:0 0 6px var(--status-running); }.legend i.queued { border:1px dashed var(--muted); background:transparent; }
.notice,.footnote { margin:.75rem 1rem; color:var(--muted); font-size:.7rem; }.chart-scroll { overflow:auto; }.chart { min-width:800px; --identity-column:15rem; --lane-gap:.6rem; }.axis-label,.axis,.waterfall-row { display:grid; grid-template-columns:var(--identity-column) minmax(30rem,1fr); column-gap:var(--lane-gap); }.axis-label { padding:.55rem 1rem .25rem; color:var(--muted); font-size:.62rem; letter-spacing:.09em; text-transform:uppercase; }.axis-label span:last-child { padding-left:.85rem; }.axis { padding:0 1rem .55rem; }.ticks { position:relative; height:1rem; margin:0 4.5rem 0 .8rem; }.ticks span { position:absolute; transform:translateX(-50%); color:var(--muted); font:500 .61rem/1 var(--mono); }.ticks span:first-child { transform:none; }.ticks span:last-child { transform:translateX(-100%); }
.rows { position:relative; border-top:1px solid var(--line); }.waterfall-row { position:relative; z-index:1; width:100%; min-height:4.35rem; align-items:stretch; border:0; border-top:1px solid color-mix(in srgb,var(--line) 75%,transparent); background:transparent; padding:0 1rem; color:inherit; text-align:left; cursor:pointer; }.waterfall-row:first-child { border-top:0; }.waterfall-row:hover,.waterfall-row.selected { background:var(--accent-soft); }.waterfall-row.selected { box-shadow:inset 2px 0 var(--accent); }
.phase-meta { display:flex; align-items:center; gap:.65rem; padding:.65rem .8rem .65rem 0; border-right:1px solid var(--line); }.step { color:var(--muted); font:600 .65rem/1 var(--mono); }.phase-copy { display:grid; gap:.25rem; min-width:0; }.phase-copy strong { text-transform:capitalize; font-size:.79rem; }.phase-copy small { display:flex; align-items:center; gap:.35rem; color:var(--muted); font-size:.61rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.phase-copy small i { flex:0 0 auto; width:.4rem; height:.4rem; border-radius:50%; background:var(--role-color); box-shadow:0 0 6px color-mix(in srgb,var(--role-color) 60%,transparent); }
.track { position:relative; margin:.7rem 4.5rem .7rem .8rem; border-radius:.35rem; background:color-mix(in srgb,var(--bg) 65%,transparent); overflow:visible; }.gridline { position:absolute; top:0; bottom:0; width:1px; background:color-mix(in srgb,var(--line) 65%,transparent); }.bar { position:absolute; top:.55rem; bottom:.55rem; min-width:1rem; display:flex; align-items:center; gap:.35rem; overflow:hidden; border-radius:.35rem; background:linear-gradient(90deg,color-mix(in srgb,var(--bar-color) 75%,var(--panel)),var(--bar-color)); box-shadow:0 4px 12px color-mix(in srgb,var(--bar-color) 14%,transparent); padding:0 .5rem; color:#071015; font:700 .62rem/1 var(--mono); white-space:nowrap; }.waterfall-row.running .bar { box-shadow:0 0 13px color-mix(in srgb,var(--bar-color) 50%,transparent); }.bar.queued { border:1px dashed var(--muted); background:var(--panel); color:var(--muted); box-shadow:none; }.bar.failed { background:var(--status-fail); color:#fff; }.gate { border:1px solid currentColor; border-radius:.25rem; padding:.12rem .25rem; font-size:.55rem; }.gate.failed { color:#611; background:#ffd6d6; }.gate.proven { color:#073e24; background:#c6f7d8; }.gate.unproven { color:#614200; background:#ffe7a9; }
.row-status { position:absolute; left:calc(100% + .7rem); top:50%; transform:translateY(-50%); color:var(--muted); font-size:.61rem; }.waterfall-row.running .row-status { color:var(--status-running); }.empty { min-height:10rem; display:grid; place-content:center; text-align:center; color:var(--muted); }.empty span { margin-top:.3rem; font-size:.72rem; }.footnote { border-top:1px solid var(--line); padding-top:.75rem; }
.bounce-layer { position:absolute; z-index:2; pointer-events:none; top:0; bottom:0; left:calc(var(--identity-column) + var(--lane-gap)); right:0; width:auto; height:100%; overflow:visible; }.bounce-path { fill:none; stroke:var(--accent); stroke-width:1.5; stroke-dasharray:5 4; opacity:.78; vector-effect:non-scaling-stroke; }
@media (max-width: 700px) { .panel-heading { align-items:start; }.legend { display:none; } }
</style>
