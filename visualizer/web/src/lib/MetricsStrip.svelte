<script>
  import { fleetCost, fleetTokens } from './panels.js'
  let { runs = [] } = $props()
  let durations = $derived(runs.map((run) => run.duration_ms).filter((value) => Number.isFinite(value)).sort((a, b) => a - b))
  let medianDuration = $derived(durations.length ? (durations.length % 2 ? durations[Math.floor(durations.length / 2)] : (durations[durations.length / 2 - 1] + durations[durations.length / 2]) / 2) : null)
  let passRate = $derived(runs.length ? Math.round(runs.filter((run) => run.status === 'ok').length / runs.length * 100) : 0)
  let phasesPerRun = $derived(runs.length ? (runs.reduce((sum, run) => sum + run.phases.length, 0) / runs.length).toFixed(1) : '0.0')
  let escalationRate = $derived(runs.length ? Math.round(runs.filter((run) => run.status === 'fail' || run.agents.some((agent) => agent.outcome === 'escalate')).length / runs.length * 100) : 0)
  let tokens = $derived(fleetTokens(runs))
  let cost = $derived(fleetCost(runs))
</script>
<section class="metrics">
  <span><b>{runs.length}</b> runs</span>
  <span><b>{passRate}%</b> pass rate</span>
  <span><b>{medianDuration == null ? '—' : `${Math.round(medianDuration / 1000)}s`}</b> median duration</span>
  <span><b>{phasesPerRun}</b> phases / run</span>
  <span><b>{escalationRate}%</b> escalation rate</span>
  <span class:pending={tokens.total == null}>{#if tokens.total == null}tokens — {tokens.pending}{:else}<b>{tokens.total.toLocaleString()}</b> billed tokens{#if tokens.measured < tokens.runs}<small> ({tokens.measured} of {tokens.runs} runs measured)</small>{/if}{/if}</span>
  <span class="pending">cost — {cost.pending}</span>
  <span class="pending">read/write — awaiting the metering daemon (#83)</span>
</section>
<style>.metrics { display:flex; gap:1rem; overflow-x:auto; padding:.8rem 0; }.metrics span { background:var(--panel); border:1px solid var(--line); padding:.65rem .8rem; white-space:nowrap; }.metrics b { font-size:1.2rem; }</style>
