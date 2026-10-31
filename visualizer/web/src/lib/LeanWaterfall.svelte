<script>
  import { layoutTimeline, formatLeanDuration } from './timeline.js'
  let { run } = $props()
  let timeline = $derived(layoutTimeline(run))
</script>

<section class="waterfall" aria-labelledby="waterfall-heading">
  <h2 id="waterfall-heading">Execution waterfall</h2>
  <p>Recorded stage intervals share a time scale; open stages and missing boundaries are listed below.</p>
  {#if timeline.blocks.length}
    <ol class="rows">
      {#each timeline.blocks as block (block.phase_id)}
        <li>
          <div class="label"><strong>{block.name || 'Stage not recorded'}</strong><span>{block.role || 'Seat role not recorded'}</span><span>{formatLeanDuration(block.duration_ms)}</span></div>
          <div class="track" aria-hidden="true"><span class="bar" style={`left:${block.x * 100}%;width:${block.width * 100}%`}></span></div>
        </li>
      {/each}
    </ol>
  {:else}
    <p>No complete stage intervals recorded. Open stages and boundary evidence appear below.</p>
  {/if}
  {#if timeline.open.length}
    <ul class="absent">
      {#each timeline.open as entry (entry.id)}
        <li><strong>{entry.name || 'Stage not recorded'}</strong> · {entry.role || 'Seat role not recorded'} · Open — no stage-end record</li>
      {/each}
    </ul>
  {/if}
  {#if timeline.unrecorded.length}
    <ul class="absent">
      {#each timeline.unrecorded as entry (entry.id)}
        <li><strong>{entry.name || 'Stage not recorded'}</strong> · {entry.role || 'Seat role not recorded'} · Not recorded — {entry.reason}</li>
      {/each}
    </ul>
  {/if}
</section>

<style>
.waterfall{background:var(--panel);border:1px solid var(--line);border-radius:.75rem;padding:1.25rem;min-width:0}
h2{margin:0;font-size:1.1rem}p{color:var(--muted);font-size:.85rem;line-height:1.5}.rows,.absent{list-style:none;margin:0;padding:0}.rows li,.absent li{border-top:1px solid var(--line);padding:.75rem 0}.label{display:flex;flex-wrap:wrap;gap:.4rem 1rem;font-size:.85rem;overflow-wrap:anywhere}.label strong{flex:1}.label span,.absent{color:var(--muted);font-variant-numeric:tabular-nums}.track{position:relative;height:.65rem;margin-top:.6rem;background:var(--bg)}.bar{position:absolute;height:100%;background:var(--accent)}.absent{font-size:.85rem;line-height:1.5;overflow-wrap:anywhere}
</style>
