<script>
  import { acceptEvidence } from './trace.js'
  let { run, returns = {} } = $props()
  let panel = $derived(acceptEvidence(run, returns))
</script>
{#snippet runs(items)}
  {#each items || [] as part}
    {#if part.kind === 'strong'}<strong>{part.text}</strong>{:else if part.kind === 'emphasis'}<em>{part.text}</em>{:else if part.kind === 'code'}<code>{part.text}</code>{:else if part.kind === 'link' && /^(?:https?:|mailto:)/i.test(part.href || '')}<a href={part.href} rel="noreferrer">{part.text}</a>{:else}<span>{part.text}</span>{/if}
  {/each}
{/snippet}
{#snippet markdown(blocks)}
  {#each blocks || [] as block}
    {#if block.kind === 'heading'}<h4>{@render runs(block.runs)}</h4>
    {:else if block.kind === 'paragraph'}<p>{@render runs(block.runs)}</p>
    {:else if block.kind === 'list'}<ul>{#each block.items || [] as item}<li>{@render runs(item.runs)}</li>{/each}</ul>
    {:else if block.kind === 'code'}<pre>{block.text}</pre>
    {:else if block.kind === 'rule'}<hr />{/if}
  {/each}
{/snippet}
<section class="panel">
  <h2>Accept decisions</h2>
  {#if panel.rows.length}
    <div class="accept-rows">
      {#each panel.rows as row (row.seq)}
        <article class="accept-row">
          <div class="decision"><span class={`chip ${row.tone}`} title={row.title}>{row.label}</span> <span>{row.where_at ?? '—'}</span></div>
          <div class="counts"><span>residuals {#if row.residual_count == null}<span class="dashed" title="predates this measurement">—</span>{:else}{row.residual_count}{/if}</span> · <span>refuted {#if row.refuted_count == null}<span class="dashed" title="predates this measurement">—</span>{:else}{row.refuted_count}{/if}</span> · <span>cosmetic {#if row.cosmetic_count == null}<span class="dashed" title="predates this measurement">—</span>{:else}{row.cosmetic_count}{/if}</span> · <span>unverified {#if row.unverified_count == null}<span class="dashed" title="predates this measurement">—</span>{:else}{row.unverified_count}{/if}</span></div>
          {#if row.tone === 'refused' && row.invalid_reasons != null}<p class="reasons">{row.invalid_reasons}</p>{/if}
          {#if row.evidence?.length}<ul class="evidence">{#each row.evidence as item (`${item.kind}-${item.id}`)}<li><strong>{item.id ?? 'finding —'}</strong> · {item.kind}{#if item.blocks?.length}<div>{@render markdown(item.blocks)}</div>{/if}</li>{/each}</ul>{:else if row.evidence_pending}<p class="muted">{row.evidence_pending}</p>{/if}
        </article>
      {/each}
    </div>
  {:else}<p class="muted">accept decisions unavailable — {panel.pending}</p>{/if}
</section>
<style>
.panel { background:var(--panel); border:1px solid var(--line); border-radius:.6rem; padding:1rem; }.panel h2 { margin-top:0; }.accept-rows { display:grid; gap:.5rem; }.accept-row { border-top:1px solid var(--line); padding-top:.5rem; }.decision { display:flex; align-items:center; gap:.4rem; flex-wrap:wrap; }.chip { border-radius:1rem; padding:.15rem .45rem; font-size:.75rem; white-space:nowrap; }.chip.held { color:#166534; background:#dcfce7; }.chip.refused { color:#991b1b; background:#fee2e2; }.counts { margin-top:.3rem; color:var(--muted); }.dashed { border-bottom:1px dashed currentColor; }.reasons { margin:.3rem 0 0; overflow-wrap:anywhere; }.evidence { margin:.5rem 0 0; padding-left:1.2rem; }.evidence :global(p) { margin:.25rem 0; }.evidence pre { white-space:pre-wrap; overflow-wrap:anywhere; }.muted { color:var(--muted); }
</style>
