<script>
  import { fleetEscalationRate, fleetMedianDuration, fleetPassRate, fleetPhasesPerRun, fleetTokens } from './panels.js'
  let { runs = [], envelopes = null, degraded = false } = $props()
  let passRate = $derived(fleetPassRate(runs, { degraded, envelopes }))
  let duration = $derived(fleetMedianDuration(runs, { degraded, envelopes }))
  let phases = $derived(fleetPhasesPerRun(runs, { degraded, envelopes }))
  let escalation = $derived(fleetEscalationRate(runs, { degraded, envelopes }))
  let tokens = $derived(fleetTokens(runs))
  let active = $derived.by(() => { let count = 0; for (const run of runs) if (run.running) count += 1; return count })
  function compact(value) { return Intl.NumberFormat(undefined, { notation:'compact', maximumFractionDigits:1 }).format(value) }
  function percent(value) { return value == null ? '—' : `${value.toFixed(1)}%` }
  function time(value) {
    if (value == null) return '—'
    const seconds = Math.round(value / 1000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.round(seconds / 60)
    return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  }
</script>

<section class="metrics" aria-label="Factory summary">
  <article><span class="label">Tasks recorded</span><strong>{runs.length}</strong><small>ledger history</small></article>
  <article class:live={active > 0}><span class="label">In progress</span><strong>{active}</strong><small>{active ? 'refreshing every 3s' : 'factory is idle'}</small></article>
  <article class:pending={passRate.percent == null}><span class="label">Completion quality</span><strong>{passRate.percent == null ? '—' : `${passRate.percent}%`}</strong><small>{passRate.percent == null ? passRate.pending : 'successful finishes'}</small></article>
  <article class:pending={duration.ms == null}><span class="label">Typical duration</span><strong>{time(duration.ms)}</strong><small>median completed task</small></article>
  <article class:pending={phases.average == null}><span class="label">Workflow depth</span><strong>{phases.average == null ? '—' : phases.average.toFixed(1)}</strong><small>phases per task</small></article>
  <article class:pending={escalation.percent == null}><span class="label">Escalation rate</span><strong>{escalation.percent == null ? '—' : `${escalation.percent}%`}</strong><small>{escalation.percent == null ? escalation.pending : 'terminal tasks handed to a human'}</small></article>
  <article class:pending={tokens.total == null}><span class="label">Billed token volume</span><strong>{tokens.total == null ? '—' : compact(tokens.total)}</strong><small title="Cache reads ÷ input, cache writes, and cache reads">{tokens.total == null ? tokens.pending : tokens.cacheRate == null ? tokens.cachePending : `${percent(tokens.cacheRate)} cache hit · ${tokens.measured} tasks`}</small></article>
</section>

<style>
.metrics { display:grid; grid-template-columns:repeat(7,minmax(8.5rem,1fr)); gap:.65rem; margin:.9rem 0 1rem; overflow:auto; padding-bottom:.1rem; }
article { position:relative; min-width:9rem; min-height:6.2rem; display:grid; align-content:space-between; border:1px solid var(--line); border-radius:var(--radius); background:color-mix(in srgb,var(--panel) 91%,transparent); padding:.75rem .8rem; }
article::before { content:''; position:absolute; top:0; left:.8rem; right:.8rem; height:1px; background:linear-gradient(90deg,transparent,var(--line),transparent); }
.label { color:var(--muted); font-size:.65rem; text-transform:uppercase; letter-spacing:.09em; white-space:nowrap; }
strong { font:600 1.45rem/1 var(--mono); letter-spacing:-.04em; }
small { color:var(--muted); font-size:.65rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.live strong { color:var(--status-running); }.live::after { content:''; position:absolute; right:.75rem; top:.75rem; width:.4rem; height:.4rem; border-radius:50%; background:var(--status-running); box-shadow:0 0 8px var(--status-running); }
.pending strong { color:var(--muted); }
@media (max-width: 1100px) { .metrics { grid-template-columns:repeat(3,minmax(9rem,1fr)); } }
@media (max-width: 600px) { .metrics { display:flex; } article { flex:0 0 10.5rem; } }
</style>
