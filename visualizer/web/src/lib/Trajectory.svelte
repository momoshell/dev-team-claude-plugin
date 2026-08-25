<script>
  import { buildTrajectory, focusTrajectory, projectSpan } from './spans.js'
  let { run } = $props()
  let payload = $state({ rows: [], channels: { record: null, operational: null }, skipped_malformed: 0, skipped_line_numbers: [], dir: null, degraded: false, error: undefined })
  let reveal = $state(false)
  let selected = $state(null)
  let range = $state(null)
  let error = $state('')
  let dragFrom = $state(null)
  async function load() {
    try {
      const params = new URLSearchParams({ repo_slug: run.repo_slug || '', task_slug: run.goal || '', adw_id: run.adw_id || '' })
      const response = await fetch(`/api/journal?${params}`)
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || `request failed (${response.status})`)
      payload = data
    } catch (err) { error = err.message }
  }
  $effect(() => { const id = run.adw_id; if (id) void load() })
  let operational_channel = $derived(payload.channels.operational ?? null)
  let trajectory = $derived(buildTrajectory(payload.rows, { operational_channel, reveal }))
  let origin = $derived(trajectory.spans.length ? Math.min(...trajectory.spans.map((span) => span.started_at)) : 0)
  let total = $derived(Math.max(1, (trajectory.spans.length ? Math.max(...trajectory.spans.map((span) => span.ended_at ?? span.started_at)) : 0) - origin))
  let focus = $derived(range ? focusTrajectory(trajectory, range.from, range.to) : null)
  let focusedSpans = $derived(focus ? focus.spans : trajectory.spans)
  let focusedRows = $derived(focus ? focus.rows : trajectory.rows)
  // The drag reads the geometry of a RAIL, the same box the bars are laid out in,
  // so the interval the operator sees is the interval that is selected.
  function fraction(event) {
    const box = event.currentTarget.getBoundingClientRect()
    return box.width > 0 ? Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) : 0
  }
  function down(event) { dragFrom = origin + fraction(event) * total; range = null }
  function up(event) {
    if (dragFrom == null) return
    const to = origin + fraction(event) * total
    range = { from: Math.min(dragFrom, to), to: Math.max(dragFrom, to) }
    dragFrom = null
  }
  function clear() { range = null; selected = null }
  function seconds(span) { return `${Math.round(span.duration_ms / 1000)}s` }
</script>
<section class="panel"><h2>Trajectory</h2>
  {#if error}<p class="error">{error}</p>{/if}
  {#if payload.degraded || payload.error}<p class="error">journal unavailable — {payload.error || 'the reader reported a degraded read'}</p>{/if}
  {#if payload.skipped_malformed > 0}<p class="muted">{payload.skipped_malformed} malformed line(s) skipped: {payload.skipped_line_numbers.join(', ')}</p>{/if}
  {#if trajectory.excluded_no_timestamp > 0}<p class="muted">{trajectory.excluded_no_timestamp} row(s) carry no usable timestamp and are excluded rather than dated</p>{/if}
  {#each trajectory.anomalies as anomaly}<p class="muted">{anomaly.kind}: {anomaly.label} (expected {anomaly.expected ?? 'no open stage'})</p>{/each}
  <div class="overview">
    {#each focusedSpans as span (span.started_index)}
      {@const box = projectSpan(span, origin, total)}
      <div class="lane">
        <span class="name" title={span.label}>{span.label}</span>
        <span class="rail" onmousedown={down} onmouseup={up} role="presentation">
          {#if box.marker}
            <span class="marker" style={`left:${box.left * 100}%`}></span>
          {:else}
            <span class="bar" style={`left:${box.left * 100}%;width:${box.width * 100}%`}></span>
          {/if}
        </span>
        <span class="took">{box.marker ? 'in flight' : seconds(span)}</span>
      </div>
    {/each}
  </div>
  <div class="controls">
    <label><input type="checkbox" bind:checked={reveal} /> reveal operational</label>
    <span class="muted">{reveal ? `${trajectory.hidden_operational} operational row(s) revealed` : `${trajectory.hidden_operational} operational row(s) hidden`}</span>
    {#if range}<button onclick={clear}>clear focus</button>{/if}
  </div>
  <table class="ledger"><thead><tr><th>#</th><th>event</th><th>channel</th><th>detail</th></tr></thead><tbody>
    {#each focusedRows as row (row.index)}
      <tr class:selected={selected === row.index} onclick={() => { selected = row.index }}><td>{row.index}</td><td>{row.event}</td><td>{row.channel ?? '—'}</td><td class="detail">{row.detail}</td></tr>
    {/each}
  </tbody></table>
  {#if selected != null}
    {@const row = trajectory.rows.find((entry) => entry.index === selected)}
    {#if row}<pre class="inspector">{JSON.stringify(row.row, null, 2)}</pre>{/if}
  {/if}
</section>
<style>
  .overview { display:grid; gap:.15rem; user-select:none; }
  /* One coordinate system: every lane's rail is the same grid column, so a
     percentage left and a percentage width resolve against the same box, and the
     drag reads that same box. */
  .lane { display:grid; grid-template-columns:14rem 1fr 6rem; align-items:center; gap:.5rem; }
  .name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .rail { position:relative; display:block; width:100%; height:.9rem; }
  .bar { position:absolute; top:.15rem; height:.6rem; min-width:2px; background:var(--accent, #3b82f6); border-radius:2px; }
  .marker { position:absolute; top:.05rem; width:0; border-left:2px solid var(--muted, #888); height:.8rem; }
  .took { color:var(--muted, #888); font-variant-numeric:tabular-nums; }
  .ledger { width:100%; border-collapse:collapse; font-size:.85rem; }
  .ledger td, .ledger th { text-align:left; padding:.15rem .4rem; border-bottom:1px solid var(--line, #eee); }
  .ledger .detail { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:48ch; }
  .inspector { overflow:auto; max-height:20rem; }
  .error { color:#b42318; }
</style>
