<script>
  import { diffEnvelopes } from './envelope-diff.js'
  import { renderMarkdown } from './trace.js'
  let { run, returns = {} } = $props()
  let selected = $state({})
  let showDiff = $state({})
  let groups = $derived((returns.envelopes || []).reduce((map, envelope) => { (map[envelope.role] ||= []).push(envelope); return map }, {}))
  function current(role, entries) { return entries.find((entry) => entry.dispatch_seq === selected[role]) || entries.at(-1) }
  function json(value) { return JSON.stringify(value, null, 2) }
  function artifactReason() { return 'artifact bytes are not served: no endpoint serves file bytes and server.mjs is fenced this batch' }
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
<section class="panel"><h2>Envelopes</h2>
  {#if returns.error}<p class="error">{returns.error}</p>
  {:else}
    {#each Object.entries(groups) as [role, entries] (role)}
      {@const entry = current(role, entries)}
      {@const entryIndex = entries.indexOf(entry)}
      <article class="role"><h3>{role}</h3><div class="chips">{#each entries as inner (inner.dispatch_seq)}<button class:active={entry === inner} onclick={() => selected[role] = inner.dispatch_seq}>d{inner.dispatch_seq}</button>{/each}</div>
      {#if !entry.valid}<p class="error">{entry.invalid_reason}</p>
      {:else}<p><strong>{entry.status || '—'}</strong></p>{@render markdown(renderMarkdown(entry.summary || '—'))}
        {#if entry.artifacts?.length}<h4>artifacts</h4><ul class="artifacts">{#each entry.artifacts as path}<li><code>{path}</code> <span class="muted" title={artifactReason()}>{artifactReason()}</span></li>{/each}</ul>{/if}
        <h4>details</h4>
        {#if entry.details?.reason}<h5>reason</h5>{@render markdown(renderMarkdown(entry.details.reason))}{/if}
        {#if entry.details?.guidance}<h5>guidance</h5>{@render markdown(renderMarkdown(entry.details.guidance))}{/if}
        {#if entry.details?.why}<h5>why</h5>{@render markdown(renderMarkdown(entry.details.why))}{/if}
        {#if entry.details?.findings?.length}<h5>finding summaries</h5><ul>{#each entry.details.findings as finding}<li><strong>{finding.id ?? 'finding —'}</strong>{#if finding.summary}{@render markdown(renderMarkdown(finding.summary))}{/if}</li>{/each}</ul>{/if}
        {#if entryIndex > 0}<label><input type="checkbox" checked={showDiff[role] || false} onchange={(event) => showDiff[role] = event.currentTarget.checked} /> diff vs previous attempt</label>{/if}
        {#if showDiff[role] && entryIndex > 0}<div class="diff">{#each diffEnvelopes(entries[entryIndex - 1], entry) as change (change.path)}<div class={change.change}><code>{change.path}</code> {change.change}: {json(change.from)} → {json(change.to)}</div>{:else}<p>No changes.</p>{/each}</div>{/if}
      {/if}
    </article>{:else}<p class="muted">No envelopes recorded.</p>{/each}
    {#if returns.task}<article class="task"><h3>task</h3><pre>{json(returns.task)}</pre></article>{/if}
  {/if}
</section>
<style>.panel { background:var(--panel); border:1px solid var(--line); border-radius:.6rem; padding:1rem; }.role { border-top:1px solid var(--line); padding:.7rem 0; }.chips { display:flex; gap:.3rem; }.chips button { min-height:1.9rem; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--panel-raised); color:var(--muted); padding:.3rem .5rem; cursor:pointer; }.chips button:hover { border-color:var(--accent); color:var(--accent); }.chips button.active { border-color:var(--accent); background:var(--accent); color:var(--bg); }.wide, pre { max-width:100%; overflow:auto; white-space:pre-wrap; }.error { color:#b42318; }.diff { margin-top:.6rem; display:grid; gap:.3rem; }.added { color:var(--status-ok); }.removed { color:var(--status-fail); }.changed { color:var(--accent); }.muted { color:var(--muted); }.artifacts { padding-left:1.2rem; }.artifacts li { overflow-wrap:anywhere; margin:.3rem 0; }.role h5 { margin:.6rem 0 .2rem; }.role p { margin:.35rem 0; }
</style>
