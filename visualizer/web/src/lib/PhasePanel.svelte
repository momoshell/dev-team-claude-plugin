<script>
  import { phasePanel } from './trace.js'
  import EventStory from './EventStory.svelte'
  let { run, phase = null, returns = {}, events = [] } = $props()
  let panel = $derived(phasePanel(run, { phase, events, returns }))
  function duration(value) { return value == null ? 'running' : `${Math.round(value)}ms` }
  function phaseRole(value) {
    const event = (Array.isArray(events) ? events : []).find((entry) => String(entry?.phase_id) === String(value?.id))
    let eventRole = null
    try { eventRole = JSON.parse(event?.payload_json || '{}')?.role || null } catch {}
    const seat = (Array.isArray(run?.agents) ? run.agents : []).find((agent) => String(agent?.lane) === String(value?.lane))
    return eventRole || seat?.role || (value?.lane == null ? 'unlinked' : `lane ${value.lane}`)
  }
  function count(value) { return value == null ? '—' : value }
</script>
{#snippet runs(items)}
  {#each items || [] as part}
    {#if part.kind === 'strong'}<strong>{part.text}</strong>{:else if part.kind === 'emphasis'}<em>{part.text}</em>{:else if part.kind === 'code'}<code>{part.text}</code>{:else if part.kind === 'link' && /^(?:https?:|mailto:)/i.test(part.href || '')}<a href={part.href} rel="noreferrer">{part.text}</a>{:else}<span>{part.text}</span>{/if}
  {/each}
{/snippet}
{#snippet markdown(blocks)}
  {#each blocks || [] as block}
    {#if block.kind === 'heading'}
      {#if block.level === 1}<h3>{@render runs(block.runs)}</h3>{:else if block.level === 2}<h4>{@render runs(block.runs)}</h4>{:else}<h5>{@render runs(block.runs)}</h5>{/if}
    {:else if block.kind === 'paragraph'}<p>{@render runs(block.runs)}</p>
    {:else if block.kind === 'list'}<ul>{#each block.items || [] as item}<li>{@render runs(item.runs)}</li>{/each}</ul>
    {:else if block.kind === 'code'}<pre>{block.text}</pre>
    {:else if block.kind === 'rule'}<hr />
    {/if}
  {/each}
{/snippet}
{#snippet countMark(value)}{#if value == null}<span class="mark" title="not measured">—</span>{:else}{value}{/if}{/snippet}
{#if !phase}<section class="panel"><p class="muted">Select a phase to inspect its gate, events, accept decision, and artifacts.</p></section>
{:else if !panel.found}<section class="panel"><p class="muted">{panel.pending}</p></section>
{:else}
  <section class="panel">
    <header class="phase-header"><div><h2>{panel.phase.name}</h2><p>{phaseRole(panel.phase)} · lane {panel.phase.lane ?? '—'} · {panel.phase.status || '—'}</p></div><span>{duration(panel.phase.duration_ms)}</span></header>
    <section class="subpanel gate"><h3>Gate proof</h3>
      {#if panel.gate.verdict}<span class={`chip ${panel.gate.tone}`} title={panel.gate.note || undefined}>{panel.gate.verdict}</span>{:else}<span class="muted">gate verdict unavailable</span>{/if}
      <div class="counts">checks {@render countMark(panel.gate.checks_total)} · failed {@render countMark(panel.gate.checks_failed)} · errored {@render countMark(panel.gate.checks_errored)}</div>
      {#if panel.gate.note}<p>{panel.gate.note}</p>{/if}
      {#if panel.gate.checks.length}<ul class="checks">{#each panel.gate.checks as check}<li><strong>{check.label}</strong>{#if check.ok != null} · {check.ok ? 'ok' : 'not ok'}{/if}{#if check.note}<span class="note"> — {check.note}</span>{/if}</li>{/each}</ul>{/if}
      {#if panel.gate.checks_pending}<p class="checks-pending muted" title={panel.gate.checks_pending}>checks pending — {panel.gate.checks_pending}</p>{/if}
    </section>
    <section class="subpanel accept"><h3>Typed accept decision</h3>
      {#if panel.accept?.rows?.length}{#each panel.accept.rows as row (row.seq)}<article class="accept-row"><div><span class={`chip ${row.tone}`} title={row.title}>{row.label}</span> · {row.where_at ?? '—'}</div><div class="counts">residuals {@render countMark(row.residual_count)} · refuted {@render countMark(row.refuted_count)} · cosmetic {@render countMark(row.cosmetic_count)} · unverified {@render countMark(row.unverified_count)}</div>{#if row.evidence?.length}<ul class="evidence">{#each row.evidence as item (`${item.kind}-${item.id}`)}<li><strong>{item.id ?? 'finding —'}</strong> · {item.kind}{#if item.blocks?.length}<div>{@render markdown(item.blocks)}</div>{/if}</li>{/each}</ul>{:else if row.evidence_pending}<p class="muted">{row.evidence_pending}</p>{/if}</article>{/each}{:else}<p class="muted">accept decisions unavailable — {panel.accept?.pending || 'not measured'}</p>{/if}
    </section>
    <section class="subpanel events"><h3>Phase activity <span>{panel.events.length} event{panel.events.length === 1 ? '' : 's'}</span></h3>
      {#if panel.events.length}<div class="event-list">{#each panel.events as event (event.id)}<EventStory {event} phases={run.phases || []} />{/each}</div>{:else}<p class="muted">No events recorded for this phase.</p>{/if}
    </section>
    <section class="subpanel artifacts"><h3>Artifacts and envelope text</h3>
      {#if panel.artifacts?.blocks?.length}{@render markdown(panel.artifacts.blocks)}{:else}<p class="muted">No markdown envelope text recorded.</p>{/if}
      {#if panel.artifacts?.paths?.length}<ul class="paths">{#each panel.artifacts.paths as artifact}<li><code>{artifact.path}</code><span class="muted" title={artifact.reason}> — {artifact.reason}</span></li>{/each}</ul>{/if}
    </section>
  </section>
{/if}
<style>
.panel { background:var(--panel); border:1px solid var(--line); border-radius:.6rem; padding:1rem; }.phase-header { display:flex; justify-content:space-between; gap:1rem; align-items:start; }.phase-header h2 { margin:.1rem 0; }.phase-header p { margin:.2rem 0; color:var(--muted); }.subpanel { border-top:1px solid var(--line); margin-top:1rem; padding-top:.7rem; }.subpanel h3 { margin:.1rem 0 .5rem; }.subpanel h3 span { color:var(--muted); font-size:.62rem; font-weight:500; }.chip { border-radius:1rem; padding:.15rem .45rem; font-size:.75rem; white-space:nowrap; }.chip.proven { color:#166534; background:#dcfce7; }.chip.failed { color:#991b1b; background:#fee2e2; }.chip.unproven { color:#92400e; background:#fef3c7; }.counts, .muted { color:var(--muted); }.checks, .evidence, .paths { padding-left:1.2rem; }.note { color:var(--muted); }.mark { border-bottom:1px dashed currentColor; color:var(--muted); }.event-list { max-height:34rem; overflow:auto; padding:.4rem .25rem 0 0; scrollbar-gutter:stable; }.artifacts p { margin:.4rem 0; }.artifacts pre { white-space:pre-wrap; overflow-wrap:anywhere; }.artifacts code { overflow-wrap:anywhere; }.evidence :global(p) { margin:.25rem 0; }.paths li { margin:.3rem 0; }
</style>
