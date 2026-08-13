<script>
  import { layoutTimeline } from './timeline.js'
  let { run, events = [], onselectphase = () => {} } = $props()
  let timeline = $derived(layoutTimeline(run, events))
  function duration(block) { return block.duration_ms == null ? 'running' : `${Math.round(block.duration_ms)}ms` }
</script>
<section class="panel"><h2>Phases</h2>
  {#if timeline.unavailable}<p class="muted">agent-lane colouring unavailable — {timeline.unavailable}</p>{/if}
  <div class="wide chart"><div class="axis"><span>request</span><span>origin {timeline.origin_at || '—'}</span></div>
    {#each timeline.lanes as lane, laneIndex (lane.key)}
      <div class="lane"><strong>{lane.lane == null ? 'unlinked' : `lane ${lane.lane}`}</strong><div class="track">
        {#if timeline.request && laneIndex === 0}<div class="request block" style={`left:0%;width:${timeline.request.width * 100}%`} title="request"><span>request</span></div>{/if}
        {#each lane.blocks as block (block.phase_id ?? block.seq)}
          <button class:queued={block.queued} class="block" style={`left:${block.x * 100}%;width:${block.width * 100}%;--lane-color:var(--lane-${block.lane ?? 0})`} title={`${block.name} · attempt ${block.attempt}/${block.attempts_total} · ${block.status} · ${duration(block)}`} onclick={() => onselectphase(block.phase_id)}><span>{block.name} · {block.attempt}/{block.attempts_total}</span></button>
        {/each}
      </div></div>
    {:else}<p class="muted">No phases recorded.</p>{/each}
  </div>
</section>
<style>
.panel { background:var(--panel); border:1px solid var(--line); border-radius:.6rem; padding:1rem; }.axis { display:flex; justify-content:space-between; color:var(--muted); font-size:.8rem; min-width:720px; }.chart { min-width:720px; }.lane { display:grid; grid-template-columns:8rem minmax(640px,1fr); gap:.6rem; align-items:center; margin-top:.5rem; }.track { position:relative; height:2.6rem; background:color-mix(in srgb, var(--line) 35%, transparent); }.block { position:absolute; top:.25rem; height:2.1rem; border:0; border-radius:.25rem; overflow:hidden; white-space:nowrap; text-align:left; padding:.25rem .45rem; color:#fff; background:var(--lane-color, var(--lane-0)); cursor:pointer; }.lane:nth-child(2n) .block { --lane-color:var(--lane-1); }.queued { background:transparent; color:inherit; border:1px dashed var(--muted); }.request { background:var(--neutral); cursor:default; }.muted { color:var(--muted); }
</style>
