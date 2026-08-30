<script>
  let { rows = [], onopen = () => {} } = $props()
</script>
<div class="wide">
  {#snippet mark(cell)}
    <span class="mark dashed" title={cell?.title || undefined}>{cell?.text || 'not measured'}</span>
  {/snippet}
  <table>
    <thead><tr><th class="micro">run</th><th class="micro">status</th><th class="micro">assurance</th><th class="micro">gate</th><th class="micro">review</th><th class="micro">duration</th><th class="micro">tokens</th><th class="micro">cost</th><th class="micro">heartbeat</th></tr></thead>
    <tbody>
      {#each rows as row (row.adw_id)}
        <tr>
          <td class="run mono"><button class="run-link" title={row.adw_id} onclick={() => onopen(row)}>{row.run_label}</button></td>
          <td><span class={`status ${row.status.tone}`} title={row.status.why}><span class="status-dot" aria-hidden="true"></span>{row.status.word}</span></td>
          <td class="mono">{#if row.tier.dashed}{@render mark(row.tier)}{:else}{row.tier.text}{/if}</td>
          <td>{#if row.gate.dashed}{@render mark(row.gate)}{:else}<span title={row.gate.verdict}>{row.gate.text}</span>{/if}</td>
          <td class="mono">{#if row.review.dashed}{@render mark(row.review)}{:else}<span title={row.review.verdict}>{row.review.text}</span>{/if}</td>
          <td class="mono">{#if row.duration.dashed}{@render mark(row.duration)}{:else}{row.duration.text}{/if}</td>
          <td class="mono">{#if row.tokens.dashed}{@render mark(row.tokens)}{:else}{row.tokens.text}{/if}</td>
          <td class="mono">{@render mark(row.cost)}</td>
          <td class="mono" class:stale={row.heartbeat.stale}>{#if row.heartbeat.dashed}{@render mark(row.heartbeat)}{:else}{row.heartbeat.text}{/if}</td>
        </tr>
      {:else}
        <tr><td colspan="9" class="muted">No runs found.</td></tr>
      {/each}
    </tbody>
  </table>
</div>
<style>
.wide { overflow-x:auto; }
table { width:100%; border-collapse:collapse; background:var(--panel); border:1px solid var(--line); }
th, td { border-top:1px solid var(--line); padding:.55rem .6rem; text-align:left; white-space:nowrap; }
th { color:var(--muted); }
.run-link { border:0; background:transparent; color:var(--accent); cursor:pointer; padding:0; text-align:left; }
.status { display:inline-flex; align-items:center; gap:.35rem; }
.status-dot { width:.55rem; height:.55rem; background:var(--neutral); display:inline-block; }
.status.ok { color:var(--status-ok); }
.status.fail { color:var(--status-fail); }
.status.busy { color:var(--status-running); }
.status.serious { color:var(--status-escalated); }
.stale { color:var(--status-escalated); }
.status-dot { background:currentColor; }
.mark { color:var(--muted); }
.dashed { border-bottom:1px dashed currentColor; }
.muted { color:var(--muted); }
</style>
