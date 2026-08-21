<script>
  import { fleetCost, fleetEscalationRate, fleetMedianDuration, fleetPassRate, fleetPhasesPerRun, fleetTokens } from './panels.js'
  let { runs = [], envelopes = null, degraded = false } = $props()
  let passRate = $derived(fleetPassRate(runs, { degraded, envelopes }))
  let duration = $derived(fleetMedianDuration(runs, { degraded, envelopes }))
  let phases = $derived(fleetPhasesPerRun(runs, { degraded, envelopes }))
  let escalation = $derived(fleetEscalationRate(runs, { degraded, envelopes }))
  let tokens = $derived(fleetTokens(runs))
  let cost = $derived(fleetCost(runs))
</script>
<section class="metrics">
  <span><b>{runs.length}</b> runs</span>
  <span class:pending={passRate.percent == null}>{#if passRate.percent == null}pass rate — {passRate.pending}{:else}<b>{passRate.percent}%</b> pass rate{/if}</span>
  <span class:pending={duration.ms == null}>{#if duration.ms == null}median duration — {duration.pending}{:else}<b>{Math.round(duration.ms / 1000)}s</b> median duration{/if}</span>
  <span class:pending={phases.average == null}>{#if phases.average == null}phases / run — {phases.pending}{:else}<b>{phases.average.toFixed(1)}</b> phases / run{/if}</span>
  <span class:pending={escalation.percent == null}>{#if escalation.percent == null}escalation rate — {escalation.pending}{:else}<b>{escalation.percent}%</b> escalation rate{/if}</span>
  <span class:pending={tokens.total == null}>{#if tokens.total == null}tokens — {tokens.pending}{:else}<b>{tokens.total.toLocaleString()}</b> billed tokens{#if tokens.measured < tokens.runs}<small> ({tokens.measured} of {tokens.runs} runs measured)</small>{/if}{/if}</span>
  <span class="pending">cost — {cost.pending}</span>
  <span class="pending">read/write — awaiting the metering daemon (#83)</span>
</section>
<style>.metrics { display:flex; gap:1rem; overflow-x:auto; padding:.8rem 0; }.metrics span { background:var(--panel); border:1px solid var(--line); padding:.65rem .8rem; white-space:nowrap; }.metrics b { font-size:1.2rem; }.metrics .pending { color:var(--muted); }</style>
