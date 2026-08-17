<script>
  import { layoutTimeline } from './timeline.js'
  import { bounceArrows, gateMarkers, laneRows } from './trace.js'
  import RoleTag from './RoleTag.svelte'
  let { run, events = [], onselectphase = () => {} } = $props()
  let timeline = $derived(layoutTimeline(run, events))
  let identities = $derived(laneRows(run, events))
  let bounces = $derived(bounceArrows(run))
  let gates = $derived(gateMarkers(run))
  function duration(block) { return block.duration_ms == null ? 'running' : `${Math.round(block.duration_ms)}ms` }
  function select(block) { if (block?.name != null) onselectphase(block.name) }
  function sameId(left, right) { return left != null && right != null && String(left) === String(right) }
  function identityFor(lane) { return identities.lanes.find((row) => sameId(row.lane, lane.lane) || (row.lane == null && lane.lane == null)) }
  function markersFor(id) { return gates.markers.filter((marker) => sameId(marker.phase_id, id)) }
  function blockFor(id) {
    for (let laneIndex = 0; laneIndex < timeline.lanes.length; laneIndex += 1) {
      const block = timeline.lanes[laneIndex].blocks.find((entry) => sameId(entry.phase_id, id))
      if (block) return { block, laneIndex }
    }
    return null
  }
  function connectorPath(from, to) {
    const fromX = (from.block.x + from.block.width) * 1000, toX = to.block.x * 1000
    const fromY = from.laneIndex * 100 + 58, toY = to.laneIndex * 100 + 58
    const bend = (fromX + toX) / 2
    return `M ${fromX} ${fromY} C ${bend} ${fromY}, ${bend} ${toY}, ${toX} ${toY}`
  }
  function connectorLabel(from, to, arrow) { return `${arrow.from_phase} ↗ ${arrow.to_phase} · ${arrow.label}` }
  function connectorTextX(from, to) { return ((from.block.x + from.block.width + to.block.x) / 2) * 1000 }
  function connectorTextY(from, to) { return ((from.laneIndex + to.laneIndex) * 50) + 51 }
</script>
<section class="panel"><h2>Phases</h2>
  {#if timeline.unavailable}<p class="muted">agent-lane colouring unavailable — {timeline.unavailable}</p>{/if}
  {#if identities.unavailable && !timeline.unavailable}<p class="muted">role identity unavailable — {identities.unavailable}</p>{/if}
  <div class="wide chart"><div class="axis"><span>request</span><span>origin {timeline.origin_at || '—'}</span></div><div class="timeline-body">
    {#each timeline.lanes as lane, laneIndex (lane.key)}
      {@const identity = identityFor(lane)}
      {@const header = identity?.header}
      <div class="lane"><div class="identity">
        {#if identity}<RoleTag role={identity.role || 'unlinked'} lane={identity.lane} />{:else}<span class="muted">unlinked</span>{/if}
        {#if header?.model != null}<span class="model">{header.model}</span>{:else if header?.model_mark}<span class="mark" title={header.model_mark.title}>{header.model_mark.text}</span>{/if}
        {#if header?.effort_mark}<span class="mark" title={header.effort_mark.title}>{header.effort_mark.text}</span>{/if}
        {#if header?.context_mark}<span class="mark" title={header.context_mark.title}>{header.context_mark.text}</span>{/if}
      </div><div class="track">
        {#if timeline.request && laneIndex === 0}<div class="request block" style={`left:0%;width:${timeline.request.width * 100}%`} title="request"><span>request</span></div>{/if}
        {#each lane.blocks as block (block.phase_id ?? block.seq)}
          {@const markers = markersFor(block.phase_id)}
          <button class:queued={block.queued} class="block" style={`left:${block.x * 100}%;width:${block.width * 100}%;--lane-color:var(--lane-${block.lane ?? 0})`} title={`${block.name} · attempt ${block.attempt}/${block.attempts_total} · ${block.status} · ${duration(block)}`} onclick={() => select(block)}><span>{block.name} · {block.attempt}/{block.attempts_total}</span>{#each markers as marker (`${marker.generation}-${marker.verdict}`)}<span class={`gate-marker ${marker.tone}`} title={marker.title}>{marker.label}</span>{/each}</button>
        {/each}
      </div></div>
    {:else}<p class="muted">No phases recorded.</p>{/each}
    {#if bounces.arrows.length}<svg class="bounce-layer" viewBox={`0 0 1000 ${Math.max(timeline.lanes.length, 1) * 100}`} preserveAspectRatio="none" aria-label="review bounce connectors"><defs><marker id="bounce-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="var(--accent)" /></marker></defs>{#each bounces.arrows as arrow (`${arrow.from_phase_id}-${arrow.to_phase_id}`)}{@const from = blockFor(arrow.from_phase_id)}{@const to = blockFor(arrow.to_phase_id)}{#if from && to}<path d={connectorPath(from, to)} class="bounce-path" marker-end="url(#bounce-arrow)"><title>{arrow.title}</title></path><text x={connectorTextX(from, to)} y={connectorTextY(from, to)} class="bounce-label">{connectorLabel(from, to, arrow)}</text>{/if}{/each}</svg>{/if}
  </div></div>
  {#if identities.collapsed.length}<p class="collapsed muted">No phases for {identities.collapsed.map((row) => row.role || `lane ${row.lane ?? '—'}`).join(', ')} — collapsed rather than drawn.</p>{/if}
  {#if bounces.pending}<p class="muted">bounce arrows unavailable — {bounces.pending}</p>{/if}
  {#if gates.pending}<p class="muted">gate markers unavailable — {gates.pending}</p>{/if}
</section>
<style>
.panel { background:var(--panel); border:1px solid var(--line); border-radius:.6rem; padding:1rem; }.axis { display:flex; justify-content:space-between; color:var(--muted); font-size:.8rem; min-width:720px; }.chart { min-width:720px; }.timeline-body { position:relative; min-width:calc(var(--identity-column) + var(--lane-gap) + 640px); --identity-column:15rem; --lane-gap:.6rem; }.lane { display:grid; grid-template-columns:var(--identity-column) minmax(640px,1fr); gap:var(--lane-gap); align-items:center; margin-top:.5rem; }.identity { display:flex; align-items:center; gap:.45rem; flex-wrap:wrap; min-width:0; }.model { font-family:var(--mono); font-size:.75rem; overflow-wrap:anywhere; }.mark { color:var(--muted); border-bottom:1px dashed currentColor; white-space:nowrap; font-size:.78rem; }.track { position:relative; height:2.6rem; background:color-mix(in srgb, var(--line) 35%, transparent); }.block { position:absolute; top:.25rem; height:2.1rem; border:0; border-radius:.25rem; overflow:hidden; white-space:nowrap; text-align:left; padding:.25rem .45rem; color:#fff; background:var(--lane-color, var(--lane-0)); cursor:pointer; display:flex; gap:.35rem; align-items:center; }.lane:nth-child(2n) .block { --lane-color:var(--lane-1); }.queued { background:transparent; color:inherit; border:1px dashed var(--muted); }.request { background:var(--neutral); cursor:default; }.gate-marker { border:1px solid currentColor; border-radius:.2rem; padding:0 .2rem; font-size:.68rem; }.gate-marker.proven { color:#d8ffd9; }.gate-marker.failed { color:#ffd1d1; }.gate-marker.unproven { color:#ffe4a3; }.bounce-layer { position:absolute; top:0; right:0; bottom:0; left:calc(var(--identity-column) + var(--lane-gap)); width:auto; height:100%; pointer-events:none; overflow:visible; }.bounce-path { fill:none; stroke:var(--accent); stroke-width:2; stroke-dasharray:7 4; vector-effect:non-scaling-stroke; }.bounce-label { fill:var(--accent); font-size:18px; paint-order:stroke; stroke:var(--panel); stroke-width:5px; stroke-linejoin:round; }.collapsed { margin:.7rem 0 0; }.muted { color:var(--muted); }
</style>
