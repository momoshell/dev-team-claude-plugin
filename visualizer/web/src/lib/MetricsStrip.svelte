<script>
  let { summary } = $props()
  const number = (value) => value == null ? '—' : Intl.NumberFormat(undefined, { notation:'compact', maximumFractionDigits:1 }).format(value)
  function duration(ms) {
    if (ms == null) return '—'
    if (ms < 60000) return `${Math.round(ms / 1000)}s`
    const minutes = Math.round(ms / 60000)
    return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  }
</script>

<section class="metrics" aria-label="Activity summary">
  <article class:featured={summary.total != null}><span>Runs started</span><strong>{number(summary.total)}</strong><small>{summary.total == null ? 'Feed unavailable' : `${summary.counts.open} still open · ${summary.counts.unknown} unknown outcomes`}</small></article>
  <article class:positive={summary.successRate > 0}><span>Successful outcomes</span><strong>{summary.successRate == null ? '—' : `${summary.successRate}%`}</strong><small>{summary.unavailable ? 'Feed unavailable' : summary.successRate == null ? 'No measured terminal outcomes' : `${summary.counts.success} of ${summary.settled} terminal runs`}</small></article>
  <article><span>Median duration</span><strong>{duration(summary.median)}</strong><small>{summary.unavailable ? 'Feed unavailable' : summary.median == null ? 'No measured terminal durations' : `${summary.durationMeasured} of ${summary.settled} terminal runs measured`}</small></article>
  <article><span>Recorded tokens</span><strong>{number(summary.usage?.total)}</strong><small>{summary.unavailable ? 'Feed unavailable' : summary.usage?.total == null ? 'Token usage not measured' : `${summary.usage.complete} of ${summary.total} runs fully measured`}</small></article>
</section>

<style>
.metrics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:1rem; margin:1.25rem 0; }
article { min-width:0; display:grid; gap:.65rem; padding:1.15rem; border:1px solid var(--line); border-radius:var(--radius-lg); background:var(--panel); }
article > span { color:var(--muted); font-size:.85rem; }
strong { font-size:1.8rem; line-height:1.2; font-weight:600; font-variant-numeric:tabular-nums; letter-spacing:-.03em; }
small { color:var(--muted); font-size:.75rem; line-height:1.5; }
article.featured { border-top:3px solid var(--accent); background:var(--accent-surface); }article.featured strong { color:var(--accent); }article.positive { border-top:3px solid var(--status-ok); }article.positive strong { color:var(--status-ok); }
@media (max-width:1050px) { .metrics { grid-template-columns:repeat(2,minmax(0,1fr)); } }
@media (max-width:480px) { .metrics { grid-template-columns:1fr; } }
</style>
