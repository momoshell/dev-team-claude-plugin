<script>
  import { activitySummary, ACTIVITY_PERIODS, OUTCOMES } from './activity.js'
  import { deriveDisplayStatus, operationsOverview } from './fleet.js'
  import MetricsStrip from './MetricsStrip.svelte'

  let { loading = false, runs = [], envelopes = new Map(), degraded = false, now = Date.now(), onopen = () => {} } = $props()
  let period = $state('7')
  let selectedBucket = $state(null)
  let summary = $derived(activitySummary(runs, { period, envelopes, degraded, now }))
  let operations = $derived(operationsOverview(summary.rows))
  let maximum = $derived(Math.max(1, ...summary.buckets.map(bucket => bucket.count)))
  let selected = $derived(selectedBucket == null ? null : summary.buckets[selectedBucket])
  let inspectRows = $derived(selected ? selected.rows : summary.attention.map(row => row.run))
  const number = (value) => value == null ? '—' : Intl.NumberFormat(undefined, { notation:'compact', maximumFractionDigits:1 }).format(value)
  const stamp = (value) => new Intl.DateTimeFormat(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }).format(value)
  const bucketLabel = (value) => new Intl.DateTimeFormat(undefined, period === '1' ? { hour:'2-digit', minute:'2-digit' } : { month:'short', day:'numeric' }).format(value)
  const usageFields = [{ key:'input', label:'Fresh input' }, { key:'output', label:'Output' }, { key:'cacheRead', label:'Cache reads' }, { key:'cacheWrite', label:'Cache writes' }]
  function statusFor(run) { return deriveDisplayStatus(run, envelopes instanceof Map ? envelopes.get(run.adw_id) : envelopes?.[run.adw_id], now) }
</script>

<section aria-label="Operations activity">
  <div class="scope-row">
    <div><h2>Run activity</h2><p>Runs started in this period, including archived history. Outcomes reflect the latest recorded evidence.</p></div>
    <label>Period<select bind:value={period} onchange={() => selectedBucket = null}>{#each ACTIVITY_PERIODS as option}<option value={option.value}>{option.label}</option>{/each}</select></label>
  </div>
  <p class="scope-note">{stamp(summary.start)} – {stamp(summary.end)} · local time{#if summary.undated} · {summary.undated} records with missing or future start times {period === 'all' ? 'included in totals, omitted from the chart' : 'excluded'}{/if}</p>
  {#if degraded}<p class="error" role="alert">{summary.unavailable} Use Refresh in the sidebar.</p>{/if}
  {#if loading}<p class="empty" role="status">Loading run activity…</p>{:else}
  <MetricsStrip {summary} />

  {#if !degraded && summary.total === 0}
    <p class="empty">No runs started in this period. Choose a wider period or open Tasks to see your history.</p>
  {:else if !degraded}
    <div class="chart-grid">
      <article class="panel starts">
        <header><h3>Runs started over time</h3><span>{summary.buckets.length} intervals</span></header>
        <p class="hint">Select a bar to inspect its runs.</p>
        <div class="chart" aria-label="Run starts by interval">
          <div class="axis"><span>{maximum} runs</span><span>0</span></div>
          <div class="plot">
            <div class="bars">
              {#each summary.buckets as bucket, index}
                <button class:selected={selectedBucket === index} aria-pressed={selectedBucket === index} aria-label={`${stamp(bucket.start)} to ${stamp(bucket.end)}: ${bucket.count} ${bucket.count === 1 ? 'run' : 'runs'}. Inspect runs.`} onclick={() => selectedBucket = selectedBucket === index ? null : index}>
                  <span class="bar" style={`height:${bucket.count / maximum * 100}%`}></span>
                  <span class="bar-value">{bucket.count}</span>
                </button>
              {/each}
            </div>
            <div class="x-labels"><span>{bucketLabel(summary.start)}</span><span>{bucketLabel(summary.end)}</span></div>
          </div>
        </div>
        <details class="chart-data"><summary>View interval counts</summary><div class="table-scroll"><table><thead><tr><th>Interval start (local time)</th><th>Runs started</th></tr></thead><tbody>{#each summary.buckets as bucket, index}<tr><td>{stamp(bucket.start)}</td><td><button class="clear" aria-pressed={selectedBucket === index} onclick={() => selectedBucket = index}>Inspect {bucket.count} runs</button></td></tr>{/each}</tbody></table></div></details>
      </article>
      <article class="panel">
        <header><h3>Run outcomes</h3><span>{summary.total} runs</span></header>
        <p class="hint">Open means no terminal outcome; it does not establish liveness.</p>
        <div class="outcomes">{#each OUTCOMES as outcome}<div class={`outcome ${outcome.tone}`}><span>{outcome.label}</span><div class="track"><i style={`width:${summary.counts[outcome.key] / Math.max(1, summary.total) * 100}%`}></i></div><strong>{summary.counts[outcome.key]}</strong></div>{/each}</div>
      </article>
      <article class="panel usage">
        <header><h3>Token breakdown</h3><span>Recorded usage · tokens</span></header>
        {#if summary.usage.total == null}<p class="empty">Usage has not been recorded for these runs. Open a run to inspect its measurement notes.</p>
        {:else}
          <div class="usage-grid">{#each usageFields as field}<div><span>{field.label}</span><strong>{number(summary.usage[field.key])}</strong></div>{/each}</div>
          <p class="hint">{summary.usage.complete} fully measured · {summary.usage.measured - summary.usage.complete} partly measured · {summary.total - summary.usage.measured} unmeasured runs. Totals include recorded fields only.</p>
        {/if}
        <p class="hint">Cost unavailable: token counts do not establish subscription or provider charges.</p>
      </article>
      <article class="panel review" class:needs-review={!selected && inspectRows.length > 0}>
        <header><h3>{selected ? 'Runs in selected interval' : 'Runs to review'}</h3><span>{inspectRows.length} runs</span></header>
        <p class="hint">{selected ? `${stamp(selected.start)} – ${stamp(selected.end)}` : 'Unarchived runs in this period that need attention.'}</p>
        {#if selected}<button class="clear" onclick={() => selectedBucket = null}>Clear interval selection</button>{/if}
        <div class="run-list" aria-live="polite">
          {#each inspectRows.slice(0, 8) as run (run.adw_id)}
            {@const status = statusFor(run)}
            <button onclick={() => onopen(run)}><span><strong>{run.goal || run.adw_id}</strong><small>{run.repo_slug || 'Repository not recorded'}</small></span><span class={status.tone}>{status.word} →</span></button>
          {:else}<p class="empty">{selected ? 'No runs started in this interval.' : 'No unarchived runs need attention in this period.'}</p>{/each}
        </div>
        {#if inspectRows.length > 8}<p class="hint">Showing 8 of {inspectRows.length}. <a href="#/">Open Tasks for the full history</a>.</p>{/if}
      </article>
    </div>
    <details class="provenance"><summary>Configuration and runtime evidence for this period</summary><p class="hint">These diagnostics use recorded settlement fields. Legacy envelope fallbacks used in the overview may be unavailable here.</p>
  <div class="operations-grid" aria-label="Measured operations evidence">
    {#each operations.dimensions as dimension (dimension.key)}
      <article class="operations-card dimension-card">
        <div class="section-title"><div><p class="eyebrow">Recorded configuration outcomes</p><h3>{dimension.label}</h3></div><span>{dimension.rows.length} measured value{dimension.rows.length === 1 ? '' : 's'}</span></div>
        <div class="table-wrap">
          <table class="operations-table">
            <thead><tr><th>Value</th><th>Runs</th><th>Success</th><th>Escalated</th><th>Aborted</th><th>Failed</th><th>Unsettled</th><th>Unknown</th></tr></thead>
            <tbody>
              {#each dimension.rows as row (row.value)}
                <tr><th scope="row">{row.label}</th><td>{row.denominator}</td><td>{row.outcomes.success}</td><td>{row.outcomes.escalated}</td><td>{row.outcomes.aborted}</td><td>{row.outcomes.failed}</td><td>{row.outcomes.unsettled}</td><td>{row.outcomes.unknown}</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
      </article>
    {/each}

    <article class="operations-card">
      <div class="section-title"><div><p class="eyebrow">Typed terminal evidence</p><h3>Escalation causes</h3></div><span>{operations.escalations.length} recorded</span></div>
      {#if operations.escalations.length}
        <div class="operations-list">
          {#each operations.escalations as cause (cause.cause)}
            <div class="operations-row"><strong>{cause.cause}</strong><span>{cause.count} · denominator {cause.denominator}</span></div>
          {/each}
        </div>
      {:else}<p class="empty">No escalated outcomes recorded.</p>{/if}
    </article>

    <article class="operations-card">
      <div class="section-title"><div><p class="eyebrow">Typed terminal evidence</p><h3>Mechanical failures</h3></div><span>source window</span></div>
      <div class="operations-stat"><strong>{operations.failures.count}</strong><span>failed outcomes</span><small>denominator {operations.failures.denominator}</small></div>
    </article>

    <article class="operations-card">
      <div class="section-title"><div><p class="eyebrow">Open sessions</p><h3>Unsettled driver state</h3></div><span>denominator {operations.unsettled.denominator}</span></div>
      <div class="state-grid">
        <div><strong>{operations.unsettled.alive}</strong><span>alive</span></div>
        <div><strong>{operations.unsettled.gone}</strong><span>gone</span></div>
        <div><strong>{operations.unsettled.unknown}</strong><span>unknown</span></div>
      </div>
    </article>

    <article class="operations-card">
      <div class="section-title"><div><p class="eyebrow">Configuration provenance</p><h3>Requested changes</h3></div><span>{operations.configurationChanges.length} recorded</span></div>
      {#if operations.configurationChanges.length}
        <div class="operations-list">
          {#each operations.configurationChanges as change (change.adw_id + change.dimension)}
            <div class="operations-row evidence-row"><strong>{change.label}</strong><span>{change.requested} → {change.effective}</span><small>source: {change.source ?? 'source not recorded'} · {change.adw_id ?? 'run id not recorded'}</small></div>
          {/each}
        </div>
      {:else}<p class="empty">No requested-to-effective changes recorded.</p>{/if}
    </article>

    <article class="operations-card">
      <div class="section-title"><div><p class="eyebrow">Seat provenance</p><h3>Effective-seat evidence</h3></div><span>{operations.seatEvidence.length} measured</span></div>
      {#if operations.seatEvidence.length}
        <div class="operations-list">
          {#each operations.seatEvidence as seat (seat.adw_id + seat.role + seat.source)}
            <div class="operations-row evidence-row"><strong>{seat.role ?? 'role not recorded'}</strong><span>{seat.source} · {seat.policy_state ?? 'policy state not recorded'}</span><small>{seat.warnings === null ? 'warnings not recorded' : seat.warnings.length ? seat.warnings.join(' · ') : 'no warnings recorded'}</small></div>
          {/each}
        </div>
      {:else}<p class="empty">No measured effective-seat provenance in this window.</p>{/if}
    </article>
  </div>
    </details>
  {/if}
  {/if}
</section>

<style>
h2,h3,p { margin:0; } h2 { font-size:1.05rem; } h3 { font-size:.95rem; font-weight:600; }
.scope-row { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:1rem; }.scope-row p { margin-top:.4rem; color:var(--muted); font-size:.85rem; max-width:65ch; line-height:1.5; }.scope-row label { display:flex; align-items:center; gap:.6rem; font-size:.8rem; }.scope-row select { background:var(--panel); border:1px solid var(--line); border-radius:var(--radius-sm); padding:.5rem; }
.scope-note,.hint { color:var(--muted); font-size:.75rem; line-height:1.5; }.scope-note { margin-top:.75rem; }.hint { margin:.6rem 0 1rem; }
.chart-grid { display:grid; grid-template-columns:minmax(0,1.3fr) minmax(0,1fr); gap:1rem; }
.panel { padding:1.25rem; border:1px solid var(--line); border-radius:var(--radius-lg); background:var(--panel); min-width:0; }
header { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:.5rem; } header > span { font-size:.75rem; color:var(--muted); }
.chart { display:flex; height:13rem; gap:.65rem; margin-top:1.3rem; }.axis { display:flex; flex-direction:column; justify-content:space-between; padding-bottom:1.65rem; min-width:3rem; font-size:.7rem; color:var(--muted); }.plot { flex:1; min-width:0; }.bars { display:flex; align-items:stretch; height:calc(100% - 1.6rem); gap:4px; border-bottom:1px solid var(--line); background:repeating-linear-gradient(to top,transparent 0,transparent calc(25% - 1px),var(--line) 25%); }.bars button { flex:1; min-width:0; position:relative; display:flex; align-items:end; padding:0; background:transparent; border:0; cursor:pointer; }.bar { width:100%; background:var(--accent); opacity:.9; border-radius:3px 3px 0 0; }.selected .bar { opacity:1; }.selected { outline:2px solid var(--accent); outline-offset:1px; }.bar-value { display:none; position:absolute; top:0; left:50%; transform:translateX(-50%); background:var(--panel-raised); color:inherit; padding:.2rem .35rem; border:1px solid var(--line); border-radius:4px; font-size:.75rem; z-index:1; }.bars button:focus-visible .bar-value,.bars button:hover .bar-value { display:block; }.x-labels { display:flex; justify-content:space-between; padding-top:.5rem; font-size:.7rem; color:var(--muted); }
.chart-data { margin-top:1rem; font-size:.75rem; } summary { cursor:pointer; padding:.4rem 0; } table { width:100%; border-collapse:collapse; } td,th { padding:.5rem; text-align:start; border-bottom:1px solid var(--line); font-size:.75rem; }.table-scroll { overflow:auto; }
.outcomes { display:grid; gap:1rem; margin-top:1.5rem; }.outcome { display:grid; grid-template-columns:6rem minmax(0,1fr) 3rem; align-items:center; gap:.7rem; font-size:.8rem; }.outcome > span,.outcome strong { color:var(--text); }.outcome strong { text-align:end; font-weight:500; font-variant-numeric:tabular-nums; }.track { height:.45rem; background:var(--panel-raised); }.track i { display:block; height:100%; background:currentColor; }
.ok { color:var(--status-ok); }.serious { color:var(--status-escalated); }.fail { color:var(--status-fail); }.aborted,.busy { color:var(--status-running); }.quiet { color:var(--muted); }
.usage-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1.5rem; margin:1.5rem 0; }.usage-grid > div { display:grid; gap:.5rem; }.usage-grid span { color:var(--muted); font-size:.8rem; }.usage-grid strong { font-size:1.4rem; font-weight:500; font-variant-numeric:tabular-nums; }
.run-list button { width:100%; display:flex; justify-content:space-between; gap:1rem; text-align:start; border:0; border-top:1px solid var(--line); background:transparent; padding:.8rem 0; cursor:pointer; font-size:.8rem; }.run-list button > span { min-width:0; overflow-wrap:anywhere; }.run-list button > span:first-child { flex:1; }.run-list small { display:block; margin-top:.3rem; color:var(--muted); }.run-list strong { font-weight:500; }.clear { border:1px solid var(--line); border-radius:var(--radius-sm); padding:.3rem .6rem; background:var(--panel); cursor:pointer; font-size:.75rem; }
.empty { padding:1.5rem 0; color:var(--muted); font-size:.85rem; line-height:1.5; }.error { padding:1rem; color:var(--status-fail); border:1px solid var(--line); border-radius:var(--radius); }
.provenance { margin-top:1.5rem; }.provenance > summary { color:var(--muted); font-size:.85rem; }.operations-grid { display:grid; gap:1rem; grid-template-columns:repeat(2,minmax(0,1fr)); margin-top:1rem; }.operations-card { min-width:0; padding:1rem; background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); }.section-title,.operations-stat,.state-grid { display:flex; flex-wrap:wrap; gap:.6rem; margin-bottom:.6rem; }.section-title span,.eyebrow,.operations-row small,.operations-stat small { color:var(--muted); font-size:.75rem; }.operations-row { display:flex; flex-wrap:wrap; gap:.5rem; padding:.65rem 0; border-top:1px solid var(--line); font-size:.8rem; }.operations-row small { flex-basis:100%; }.operations-list { overflow-wrap:anywhere; }.state-grid > div { display:grid; gap:.3rem; padding:.5rem; }.table-wrap { overflow:auto; } a { color:var(--accent); }
@media (max-width:1000px) { .chart-grid,.operations-grid { grid-template-columns:1fr; } }
@media (max-width:480px) { .panel { padding:.85rem; }.scope-row select { font-size:1rem; }.outcome { grid-template-columns:5rem minmax(0,1fr) 2.5rem; }.bars { gap:2px; }.run-list button { flex-wrap:wrap; } }
.panel.starts { border-top:3px solid var(--accent); }.panel.review.needs-review { border-top:3px solid var(--status-escalated); }.panel.review.needs-review header h3 { color:var(--status-escalated); }.panel.review.needs-review header > span { color:var(--status-escalated); background:var(--attention-surface); border-radius:.35rem; padding:.25rem .5rem; font-weight:650; }
</style>
