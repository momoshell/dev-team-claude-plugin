<script>
  import { layoutTimeline, layoutStageOrder, formatLeanDuration } from './timeline.js'
  import { leanLabel, leanStageStatus, leanCheckStatus } from './lean.js'
  let { run } = $props()
  let timeline = $derived(layoutTimeline(run))
  let ordered = $derived(layoutStageOrder(run))
  let untimed = $derived(!timeline.blocks.length && ordered.length > 0)
  const ticks = [0, .25, .5, .75, 1]
</script>

<section class="waterfall" aria-labelledby="waterfall-heading">
  <header>
    <div><h2 id="waterfall-heading">Execution waterfall</h2><p>{untimed ? 'Stage order only. This journal has no complete stage timestamps; positions and widths do not measure elapsed time.' : 'Recorded stage intervals share a time scale; open stages and missing boundaries are listed below.'}</p></div>
    <span class="mode">{untimed ? 'Untimed · recorded order' : 'Measured intervals'}</span>
  </header>
  {#if untimed}
    <div class="axis ordinal-axis" aria-hidden="true"><span>First stage</span><span>Recorded order →</span><span>Last stage</span></div>
    <ol class="rows ordinal-rows">
      {#each ordered as entry (entry.id ?? entry.ordinal)}
        {@const state = leanStageStatus(entry.status)}
        <li class={`stage-row ${state.tone}`} data-role={entry.role || 'control'}>
          <details>
            <summary>
              <span class="label"><span class="stage-name"><span class="ordinal">{String(entry.ordinal).padStart(2, '0')}</span><strong>{leanLabel(entry.name)}</strong></span><span class="meta">{entry.role || 'No seat recorded'} · {state.label}<span class="inspect"> · Inspect</span></span></span>
              <span class="track ordinal-track" aria-hidden="true"><span class="bar" style={`left:${entry.x * 100}%;width:${entry.width * 100}%`}></span></span>
            </summary>
            <div class="evidence"><p>{entry.role ? `Recorded seat: ${entry.role}.` : 'No seat role recorded for this stage.'} Timing not recorded.</p>{#if entry.checks?.length}<ul>{#each entry.checks as check}<li><strong>{leanLabel(check.check)}</strong> · {leanCheckStatus(check).label}<pre>{JSON.stringify(check.result, null, 2)}</pre></li>{/each}</ul>{:else}<p>No check evidence recorded for this stage.</p>{/if}</div>
          </details>
        </li>
      {/each}
    </ol>
  {:else if timeline.blocks.length}
    <div class="axis" aria-label={`Elapsed scale spans ${formatLeanDuration(timeline.span_ms)}`}>
      {#each ticks as tick}<span style={`left:${tick * 100}%`}>{formatLeanDuration(Math.round(timeline.span_ms * tick / 1000) * 1000)}</span>{/each}
    </div>
    <ol class="rows">
      {#each timeline.blocks as block (block.phase_id)}
        {@const state = leanStageStatus(block.status)}
        <li class={`stage-row ${state.tone}`} data-role={block.role || 'control'}>
          <div class="label"><strong>{block.name || 'Stage not recorded'}</strong><span>{block.role || 'Seat role not recorded'}</span><span>{state.label}</span><span>{formatLeanDuration(block.duration_ms)}</span></div>
          <div class="track" aria-hidden="true"><span class="bar" style={`left:${block.x * 100}%;width:${block.width * 100}%`}></span></div>
        </li>
      {/each}
    </ol>
    <p class="scale-note">Elapsed from the first complete stage. Short bars have a minimum display width; labels show measured duration.</p>
  {:else}
    <p>No stages recorded yet.</p>
  {/if}
  {#if timeline.open.length}
    <ul class="absent">
      {#each timeline.open as entry (entry.id)}
        <li><strong>{entry.name || 'Stage not recorded'}</strong> · {entry.role || 'Seat role not recorded'} · Open — no stage-end record</li>
      {/each}
    </ul>
  {/if}
  {#if timeline.unrecorded.length}
    <details class="boundary-evidence" open={!untimed}>
      <summary>Timing evidence · {timeline.unrecorded.length} unmeasured {timeline.unrecorded.length === 1 ? 'stage' : 'stages'}</summary>
      <ul class="absent">
        {#each timeline.unrecorded as entry (entry.id)}
          <li><strong>{entry.name || 'Stage not recorded'}</strong> · {entry.role || 'Seat role not recorded'} · Not recorded — {entry.reason}</li>
        {/each}
      </ul>
    </details>
  {/if}
</section>

<style>
  .waterfall{background:var(--panel);border:1px solid var(--line);border-radius:.75rem;padding:1.25rem;min-width:0}
  header{display:flex;align-items:start;justify-content:space-between;gap:1rem}header>div{min-width:0}h2{margin:0;font-size:1.1rem}p{color:var(--muted);font-size:.85rem;line-height:1.5;max-width:75ch}.mode{flex-shrink:0;color:var(--accent);background:var(--accent-soft);border:1px solid var(--line);padding:.35rem .6rem;border-radius:.4rem;font-size:.75rem;line-height:1.5}
  .rows,.absent{list-style:none;margin:0;padding:0}.rows>li,.absent li{border-top:1px solid var(--line);padding:.75rem 0}.stage-row{--stage-color:var(--accent)}.stage-row[data-role=planner]{--stage-color:var(--role-planner)}.stage-row[data-role=builder]{--stage-color:var(--role-builder)}.stage-row[data-role=reviewer]{--stage-color:var(--role-reviewer)}.stage-row[data-role=lead]{--stage-color:var(--role-lead)}.stage-row.fail{--stage-color:var(--status-fail)}.stage-row.attention{--stage-color:var(--status-escalated)}
  .label{display:flex;flex-wrap:wrap;gap:.4rem 1rem;font-size:.85rem;overflow-wrap:anywhere;min-width:0}.label strong{flex:1}.label span,.absent{color:var(--muted);font-variant-numeric:tabular-nums}.track{display:block;position:relative;height:.65rem;margin-top:.6rem;background:var(--bg);border-radius:.2rem;overflow:hidden}.bar{position:absolute;height:100%;background:var(--stage-color);border-radius:.2rem}.absent{font-size:.85rem;line-height:1.5;overflow-wrap:anywhere}
  .axis{position:relative;height:1.5rem;margin:.75rem 0 .25rem;color:var(--muted);font-size:.75rem;font-variant-numeric:tabular-nums}.axis>span{position:absolute;transform:translateX(-50%)}.axis>span:first-child{transform:none}.axis>span:last-child{transform:translateX(-100%)}.ordinal-axis{display:flex;justify-content:space-between;gap:.5rem}.ordinal-axis>span{position:static;transform:none!important}.stage-name{display:flex;gap:.6rem;align-items:baseline;min-width:0}.stage-name strong{color:var(--text)}.ordinal{font:.75rem var(--mono)}.ordinal-rows .label{justify-content:space-between;align-items:baseline}.meta{font-size:.75rem;font-weight:400}.inspect{color:var(--accent)!important}.ordinal-track{height:.8rem}.ordinal-track .bar{min-width:2px}.ordinal-rows>li{padding:0}summary{cursor:pointer;padding:.8rem 0;list-style:none}summary::-webkit-details-marker{display:none}summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:.25rem}.evidence{padding:.25rem 1rem .75rem;border-inline-start:2px solid var(--stage-color);margin-bottom:.75rem;background:var(--bg);overflow-wrap:anywhere}.evidence ul{padding-inline-start:1.25rem;font-size:.85rem}.evidence li{margin-top:.75rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:.75rem/1.6 var(--mono);color:var(--muted);margin:.5rem 0}.boundary-evidence{border-top:1px solid var(--line);margin-top:.5rem}.boundary-evidence>summary{font-size:.8rem;color:var(--accent)}.scale-note{font-size:.75rem;margin-bottom:0}
  @media(hover:hover){summary:hover{background:var(--panel-raised)}}@media(max-width:700px){header{flex-wrap:wrap;gap:.25rem}.waterfall{padding:1rem}.mode{margin-bottom:.75rem}.meta{flex-basis:100%}.ordinal-axis{font-size:.7rem}.axis:not(.ordinal-axis)>span:nth-child(even){display:none}}
</style>
