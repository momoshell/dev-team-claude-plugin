<script>
  import { diffEnvelopes } from './envelope-diff.js'
  let { run, returns = {} } = $props()
  let selected = $state({})
  let showDiff = $state({})
  let groups = $derived((returns.envelopes || []).reduce((map, envelope) => { (map[envelope.role] ||= []).push(envelope); return map }, {}))
  function current(role, entries) { return entries.find((entry) => entry.dispatch_seq === selected[role]) || entries.at(-1) }
  function json(value) { return JSON.stringify(value, null, 2) }
</script>
<section class="panel"><h2>Envelopes</h2>
  {#if returns.error}<p class="error">{returns.error}</p>
  {:else}
    {#each Object.entries(groups) as [role, entries] (role)}<article class="role"><h3>{role}</h3><div class="chips">{#each entries as entry (entry.dispatch_seq)}<button class:active={current(role, entries) === entry} onclick={() => selected[role] = entry.dispatch_seq}>d{entry.dispatch_seq}</button>{/each}</div>
      {@const entry = current(role, entries)}
      {@const entryIndex = entries.indexOf(entry)}
      {#if !entry.valid}<p class="error">{entry.invalid_reason}</p>
      {:else}<p><strong>{entry.status || '—'}</strong></p><p>{entry.summary || '—'}</p><h4>artifacts</h4><pre>{json(entry.artifacts)}</pre><h4>details</h4><pre>{json(entry.details)}</pre>
        {#if entryIndex > 0}<label><input type="checkbox" checked={showDiff[role] || false} onchange={(event) => showDiff[role] = event.currentTarget.checked} /> diff vs previous attempt</label>{/if}
        {#if showDiff[role] && entryIndex > 0}<div class="diff">{#each diffEnvelopes(entries[entryIndex - 1], entry) as change (change.path)}<div class={change.change}><code>{change.path}</code> {change.change}: {json(change.from)} → {json(change.to)}</div>{:else}<p>No changes.</p>{/each}</div>{/if}
      {/if}
    </article>{:else}<p class="muted">No envelopes recorded.</p>{/each}
    {#if returns.task}<article class="task"><h3>task</h3><pre>{json(returns.task)}</pre></article>{/if}
  {/if}
</section>
<style>.panel { background:var(--panel); border:1px solid var(--line); border-radius:.6rem; padding:1rem; }.role { border-top:1px solid var(--line); padding:.7rem 0; }.chips { display:flex; gap:.3rem; }.chips button { cursor:pointer; }.active { background:var(--accent); color:white; }.wide, pre { max-width:100%; overflow:auto; white-space:pre-wrap; }.error { color:#b42318; }.diff { margin-top:.6rem; display:grid; gap:.3rem; }.added { color:var(--status-ok); }.removed { color:var(--status-fail); }.changed { color:var(--accent); }.muted { color:var(--muted); }</style>
