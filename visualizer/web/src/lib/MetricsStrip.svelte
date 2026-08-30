<script>
  import { fleetEscalationRate, fleetMedianDuration, fleetPassRate, fleetPhasesPerRun, fleetTokens } from './panels.js'
  import { fleetActivity } from './fleet.js'
  let { runs = [], envelopes = null, degraded = false, now = Date.now(), onactivity = () => {} } = $props()
  let passRate = $derived(fleetPassRate(runs, { degraded, envelopes }))
  let duration = $derived(fleetMedianDuration(runs, { degraded, envelopes }))
  let phases = $derived(fleetPhasesPerRun(runs, { degraded, envelopes }))
  let escalation = $derived(fleetEscalationRate(runs, { degraded, envelopes }))
  let tokens = $derived(fleetTokens(runs))
  let activity = $derived(fleetActivity(runs, now))
  let unverified = $derived(activity.silent + activity.unverified)
  let activityNote = $derived(activity.open
    ? `${activity.live} live${activity.silent ? ` · ${activity.silent} stale` : ''}${activity.unverified ? ` · ${activity.unverified} unverified` : ''}`
    : 'No open records')
  let activityTitle = $derived(unverified
    ? `${activity.silent ? `${activity.silent} stale heartbeat${activity.silent === 1 ? '' : 's'}` : ''}${activity.silent && activity.unverified ? ' · ' : ''}${activity.unverified ? `${activity.unverified} heartbeat${activity.unverified === 1 ? '' : 's'} unavailable` : ''}. Open the attention view to inspect.`
    : activity.live
      ? `${activity.live} open record${activity.live === 1 ? '' : 's'} confirmed by a fresh heartbeat.`
      : 'The factory has no open task records.')
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
  <button type="button" class="metric-card activity-card" class:live={activity.live > 0 && !unverified} class:uncertain={unverified > 0} onclick={onactivity} title={activityTitle} aria-label={`Activity now: ${activity.open} open, ${activity.live} live, ${activity.silent} stale, ${activity.unverified} unverified. View matching tasks.`}><span class="label">Activity now</span><strong>{activity.open}<em>open</em></strong><small><span>{activityNote}</span><b>{unverified ? 'Review' : 'View'} →</b></small></button>
  <article class:pending={passRate.percent == null}><span class="label">Completion quality</span><strong>{passRate.percent == null ? '—' : `${passRate.percent}%`}</strong><small>{passRate.percent == null ? passRate.pending : 'successful finishes'}</small></article>
  <article class:pending={duration.ms == null}><span class="label">Typical duration</span><strong>{time(duration.ms)}</strong><small>median completed task</small></article>
  <article class:pending={phases.average == null}><span class="label">Workflow depth</span><strong>{phases.average == null ? '—' : phases.average.toFixed(1)}</strong><small>phases per task</small></article>
  <article class:pending={escalation.percent == null}><span class="label">Escalation rate</span><strong>{escalation.percent == null ? '—' : `${escalation.percent}%`}</strong><small>{escalation.percent == null ? escalation.pending : 'terminal tasks handed to a human'}</small></article>
  <article class:pending={tokens.total == null}><span class="label">Billed token volume</span><strong>{tokens.total == null ? '—' : compact(tokens.total)}</strong><small title="Cache reads ÷ input, cache writes, and cache reads">{tokens.total == null ? tokens.pending : tokens.cacheRate == null ? tokens.cachePending : `${percent(tokens.cacheRate)} cache hit · ${tokens.measured} tasks`}</small></article>
</section>

<style>
.metrics { display:grid; grid-template-columns:repeat(7,minmax(8.5rem,1fr)); gap:.65rem; margin:.9rem 0 1rem; overflow:auto; padding-bottom:.1rem; }
article,.metric-card { position:relative; min-width:9rem; min-height:6.2rem; display:grid; align-content:space-between; border:1px solid var(--line); border-radius:var(--radius); background:color-mix(in srgb,var(--panel) 91%,transparent); padding:.75rem .8rem; color:inherit; text-align:left; }
article::before,.metric-card::before { content:''; position:absolute; top:0; left:.8rem; right:.8rem; height:1px; background:linear-gradient(90deg,transparent,var(--line),transparent); }
.metric-card { font:inherit; cursor:pointer; transition:border-color .15s ease,background .15s ease,transform .15s ease; }.metric-card:hover { border-color:color-mix(in srgb,var(--accent) 45%,var(--line)); background:color-mix(in srgb,var(--accent) 4%,var(--panel)); transform:translateY(-1px); }.metric-card:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.label { color:var(--muted); font-size:.65rem; text-transform:uppercase; letter-spacing:.09em; white-space:nowrap; }
strong { font:600 1.45rem/1 var(--mono); letter-spacing:-.04em; }.activity-card strong { display:flex; align-items:baseline; gap:.35rem; }.activity-card strong em { color:var(--muted); font:.65rem/1 var(--sans); font-style:normal; letter-spacing:0; }
small { color:var(--muted); font-size:.65rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.activity-card small { display:flex; align-items:center; gap:.35rem; }.activity-card small span { min-width:0; overflow:hidden; text-overflow:ellipsis; }.activity-card small b { margin-left:auto; color:var(--accent); font-size:.57rem; font-weight:700; }.live strong { color:var(--status-ok); }.live::after { content:''; position:absolute; right:.75rem; top:.75rem; width:.4rem; height:.4rem; border-radius:50%; background:var(--status-ok); box-shadow:0 0 8px var(--status-ok); }.uncertain strong { color:var(--status-running); }.uncertain::after { content:'?'; position:absolute; right:.7rem; top:.65rem; width:1.15rem; height:1.15rem; display:grid; place-content:center; border:1px solid color-mix(in srgb,var(--status-running) 65%,var(--line)); border-radius:50%; color:var(--status-running); font:700 .58rem/1 var(--mono); }
.pending strong { color:var(--muted); }
@media (max-width: 1100px) { .metrics { grid-template-columns:repeat(3,minmax(9rem,1fr)); } }
@media (max-width: 600px) { .metrics { display:flex; } article,.metric-card { flex:0 0 10.5rem; } }
</style>
