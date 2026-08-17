<script>
  import { bounceArrows } from './trace.js'
  import { findingRows, reviewRows } from './panels.js'
  let { run, returns = {} } = $props()
  let reviews = $derived(reviewRows(run))
  let findings = $derived(findingRows(returns))
  let bounces = $derived(bounceArrows(run))
  function bounceFor(round) { return bounces.arrows.find((arrow) => arrow.round === round) }
</script>
<section class="panel">
  <h2>Reviews</h2>
  {#if reviews.rows.length}
    <div class="review-rows">{#each reviews.rows as row (row.dispatch_id ?? row.round)}{@const bounce = row.verdict === 'changes-needed' ? bounceFor(row.round) : null}<div>{row.round} · {row.role ?? '—'} · {row.verdict ?? '—'} · must-fix <span title={row.must_fix == null ? 'predates this measurement' : undefined}>{row.must_fix == null ? '—' : row.must_fix}</span>{#if bounce} · bounced into {bounce.to_phase}<span class="muted" title={bounce.title}> ({bounce.label})</span>{/if}</div>{/each}</div>
  {:else if reviews.pending}<p class="muted">review outcomes unavailable — {reviews.pending}</p>
  {:else}<p class="muted">No review outcomes recorded.</p>{/if}
  <h2>Findings</h2>
  {#if findings.groups.length}
    <div class="finding-groups">{#each findings.groups as group, index (`${group.role ?? 'unknown'}-${group.dispatch_seq ?? index}`)}<article><h3>{group.role ?? '—'} · dispatch {group.dispatch_seq ?? '—'}</h3>{#if group.findings.length}<ul>{#each group.findings as finding (finding.id)}<li>{finding.severity ?? '—'} · {finding.location ?? '—'} · {finding.summary ?? '—'}</li>{/each}</ul>{:else}<p class="muted">No findings recorded.</p>{/if}</article>{/each}</div>
  {:else if findings.pending}<p class="muted">structured findings unavailable — {findings.pending}</p>
  {:else}<p class="muted">No findings recorded.</p>{/if}
</section>
<style>
.panel { background:var(--panel); border:1px solid var(--line); border-radius:.6rem; padding:1rem; }.panel h2 { margin-top:0; }.panel h2:not(:first-child) { margin-top:1rem; }.review-rows, .finding-groups { display:grid; gap:.4rem; }.finding-groups article { border-top:1px solid var(--line); padding-top:.5rem; }.finding-groups h3 { margin:.1rem 0 .4rem; font-size:.95rem; }.finding-groups ul { margin:.2rem 0; padding-left:1.2rem; }.muted { color:var(--muted); }
</style>
