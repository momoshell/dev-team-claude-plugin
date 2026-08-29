<script>
  import { getCellHealth, getIntake, getIntakeBrake, getRunSet, getSeatTeardowns } from './api.js'
  import { PANEL_REFRESH_MS } from './panels.js'

  let { runs = [], degraded = false, now = Date.now(), onopen = () => {} } = $props()
  let cellHealth = $state(null)
  let teardowns = $state(null)
  let runSet = $state(null)
  let intake = $state(null)
  let brake = $state(null)
  let loading = $state(true)
  let readAt = $state(null)
  let errors = $state([])

  const tokenFields = ['billed_input_tokens', 'billed_output_tokens', 'billed_cache_write_tokens', 'billed_cache_read_tokens']

  function number(value) {
    return typeof value === 'number' && Number.isFinite(value)
      ? Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
      : '—'
  }

  function percent(value, total) {
    return total > 0 && value != null ? Math.round(value / total * 100) : null
  }

  function ageLabel(timestamp) {
    if (!timestamp) return 'awaiting first read'
    const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
    return seconds < 60 ? `updated ${seconds}s ago` : `updated ${Math.floor(seconds / 60)}m ago`
  }

  function shortTime(value) {
    if (!value) return 'time unavailable'
    const date = new Date(value)
    return Number.isFinite(date.valueOf()) ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : String(value)
  }

  async function refresh() {
    const requests = [getCellHealth(), getSeatTeardowns(), getRunSet(), getIntake(), getIntakeBrake()]
    const labels = ['Cell health', 'Seat teardown', 'Run set', 'Intake', 'Intake brake']
    const results = await Promise.allSettled(requests)
    const values = results.map((result) => result.status === 'fulfilled' ? result.value : null)
    ;[cellHealth, teardowns, runSet, intake, brake] = values
    errors = results.flatMap((result, index) => result.status === 'rejected' ? [`${labels[index]} unavailable`] : [])
    readAt = Date.now()
    loading = false
  }

  $effect(() => {
    void refresh()
    const timer = setInterval(refresh, PANEL_REFRESH_MS)
    return () => clearInterval(timer)
  })

  let runSummary = $derived.by(() => {
    const settled = runSet?.settled || {}
    const total = runSet?.runs ?? null
    const running = settled.running ?? 0
    const ok = settled.ok ?? 0
    const fail = (settled.fail ?? 0) + (settled.aborted ?? 0)
    const terminal = ok + fail
    return { total, running, ok, fail, terminal, pass: percent(ok, terminal) }
  })

  let teardownSummary = $derived.by(() => {
    const totals = teardowns?.totals || {}
    const source = Array.isArray(teardowns?.runs) ? teardowns.runs : []
    const measuredRuns = source.filter((run) => run?.state === 'measured').length
    const clean = (totals.failed ?? 0) === 0 && (totals.unproven ?? 0) === 0
    return {
      seats: totals.seats ?? null,
      proven: totals.proven ?? null,
      failed: totals.failed ?? null,
      unproven: totals.unproven ?? null,
      measuredRuns,
      totalRuns: source.length,
      coverage: percent(measuredRuns, source.length),
      clean,
    }
  })

  let healthSummary = $derived.by(() => {
    const cells = Array.isArray(cellHealth?.cells) ? cellHealth.cells : []
    const failures = cells.reduce((sum, cell) => sum + (Number(cell?.failures) || 0), 0)
    const affected = cells.filter((cell) => (Number(cell?.failures) || 0) > 0).length
    const faultDomains = cells
      .filter((cell) => (Number(cell?.failures) || 0) > 0)
      .sort((a, b) => (b.failures ?? 0) - (a.failures ?? 0))
      .slice(0, 4)
      .map((cell) => ({
        key: cell.key,
        model: `${cell.provider}/${cell.model_id}`,
        agent: cell.agent,
        effort: cell.effort,
        failures: cell.failures,
        roles: Array.isArray(cell.roles) ? cell.roles.join(', ') : 'roles unavailable',
        kind: cell.by_kind?.[0]?.kind || 'failure kind unavailable',
      }))
    return { cells: cells.length, failures, affected, faultDomains }
  })

  let coverage = $derived.by(() => {
    const usage = runSet?.coverage || null
    const recent = Array.isArray(runSet?.rows) ? runSet.rows : []
    const gated = recent.filter((row) => runs.find((run) => run.adw_id === row.adw_id)?.gate_discrimination != null).length
    return [
      { label: 'Usage metering', value: usage?.measured ?? null, total: usage?.total ?? runSummary.total, note: 'runs with billed token evidence' },
      { label: 'Seat teardown', value: teardownSummary.measuredRuns, total: teardownSummary.totalRuns, note: 'runs with reclamation evidence' },
      { label: 'Gate proof', value: gated, total: recent.length, note: 'runs with discrimination evidence' },
    ].map((item) => ({ ...item, pct: percent(item.value, item.total) }))
  })

  let totalTokens = $derived.by(() => {
    if (!runSet?.usage) return null
    return tokenFields.reduce((sum, field) => sum + (Number(runSet.usage[field]) || 0), 0)
  })

  let exceptions = $derived.by(() => {
    const source = Array.isArray(runSet?.rows) ? [...runSet.rows] : []
    const indexed = new Map(runs.map((run) => [run.adw_id, run]))
    return source
      .filter((run) => run.status === 'fail' || run.status === 'aborted')
      .sort((a, b) => Date.parse(b.ended_at || b.started_at || 0) - Date.parse(a.ended_at || a.started_at || 0))
      .slice(0, 5)
      .map((run) => ({ ...run, source: indexed.get(run.adw_id) || null }))
  })

  let hourly = $derived.by(() => {
    const end = now
    const start = end - 24 * 60 * 60 * 1000
    const buckets = Array.from({ length: 12 }, (_, index) => ({
      start: start + index * 2 * 60 * 60 * 1000,
      ok: 0,
      fail: 0,
      running: 0,
    }))
    for (const run of runs) {
      const at = Date.parse(run.started_at || '')
      if (!Number.isFinite(at) || at < start || at > end) continue
      const index = Math.min(11, Math.floor((at - start) / (2 * 60 * 60 * 1000)))
      if (run.status === 'ok') buckets[index].ok += 1
      else if (run.status === 'fail' || run.status === 'aborted') buckets[index].fail += 1
      else buckets[index].running += 1
    }
    const maximum = Math.max(1, ...buckets.map((bucket) => bucket.ok + bucket.fail + bucket.running))
    return buckets.map((bucket) => ({ ...bucket, total: bucket.ok + bucket.fail + bucket.running, maximum }))
  })

  let posture = $derived.by(() => {
    if (loading) return { tone: 'quiet', label: 'Reading the factory', message: 'Building an operational picture from the latest ledger evidence.' }
    if (degraded || errors.length) return { tone: 'fail', label: 'Telemetry degraded', message: 'Some operating signals are unavailable. Treat apparent zeros as unknown.' }
    if (brake?.state === 'engaged') return { tone: 'fail', label: 'Intake is paused', message: 'The stop switch is engaged. Work already in flight is unaffected.' }
    if (runSummary.fail > 0 || healthSummary.failures > 0) return {
      tone: 'watch',
      label: 'Factory needs attention',
      message: `${runSummary.fail} task${runSummary.fail === 1 ? '' : 's'} did not complete cleanly and ${healthSummary.affected} model cell${healthSummary.affected === 1 ? '' : 's'} recorded failures in the active windows.`,
    }
    return { tone: 'ok', label: 'Factory is operating cleanly', message: 'No recorded failures or teardown leaks in the active windows.' }
  })

  function openException(row) {
    if (row.source) onopen(row.source)
  }
</script>

<section class={`command ${posture.tone}`} aria-label="Operations command view">
  <header class="command-head">
    <div class="posture">
      <span class="pulse" aria-hidden="true"></span>
      <div><p class="eyebrow">Current posture</p><h2>{posture.label}</h2><p>{posture.message}</p></div>
    </div>
    <div class="readout"><span class:stale={errors.length}>{ageLabel(readAt)}</span><small>{errors.length ? errors.join(' · ') : 'five sources reporting'}</small></div>
  </header>

  <div class="brief-grid">
    <article class="flow-card">
      <div class="section-title"><div><p class="eyebrow">Last 24 hours</p><h3>Production flow</h3></div><span>{runSet?.window?.label || 'window loading'}</span></div>
      <div class="flow">
        <div><strong>{runSummary.total ?? '—'}</strong><span>started</span></div><i>→</i>
        <div><strong>{runSummary.terminal ?? '—'}</strong><span>settled</span></div><i>→</i>
        <div class="good"><strong>{runSummary.ok ?? '—'}</strong><span>successful</span></div><i>→</i>
        <div class:good={teardownSummary.clean}><strong>{teardownSummary.proven ?? '—'}</strong><span>seats reclaimed</span></div>
      </div>
      <div class="outcome-bar" aria-label={`${runSummary.ok} successful, ${runSummary.fail} unsuccessful, ${runSummary.running} running`}>
        <span class="ok" style={`--share:${percent(runSummary.ok, runSummary.total) ?? 0}%`}></span>
        <span class="fail" style={`--share:${percent(runSummary.fail, runSummary.total) ?? 0}%`}></span>
        <span class="running" style={`--share:${percent(runSummary.running, runSummary.total) ?? 0}%`}></span>
      </div>
      <div class="legend"><span><i class="ok"></i>{runSummary.pass ?? '—'}% completion quality</span><span><i class="fail"></i>{runSummary.fail} unsuccessful</span><span><i class="running"></i>{runSummary.running} running</span></div>
    </article>

    <article class="score-card">
      <p class="eyebrow">Proof, not promises</p><h3>Operational confidence</h3>
      <div class="score-row"><div><strong>{teardownSummary.coverage ?? '—'}%</strong><span>teardown coverage</span></div><div><strong>{teardownSummary.failed ?? '—'}</strong><span>reclamation failures</span></div><div><strong>{number(totalTokens)}</strong><span>measured tokens</span></div></div>
      <div class="coverage-list">
        {#each coverage as item (item.label)}
          <div class="coverage-item"><div><span>{item.label}</span><strong>{item.pct == null ? 'not measured' : `${item.value}/${item.total}`}</strong></div><div class="meter"><i style={`--coverage:${item.pct ?? 0}%`}></i></div><small>{item.note}</small></div>
        {/each}
      </div>
    </article>

    <article class="throughput-card">
      <div class="section-title"><div><p class="eyebrow">Start volume</p><h3>Two-hour cadence</h3></div><span>rolling 24h</span></div>
      <div class="histogram" aria-label="Task starts by two-hour interval">
        {#each hourly as bucket, index (bucket.start)}
          <div class="bar-column" title={`${shortTime(bucket.start)} · ${bucket.total} started`}>
            <div class="bar-stack" style={`--height:${Math.max(bucket.total ? 10 : 2, bucket.total / bucket.maximum * 100)}%`}>
              {#if bucket.running}<i class="running" style={`--segment:${bucket.running / bucket.total * 100}%`}></i>{/if}
              {#if bucket.fail}<i class="fail" style={`--segment:${bucket.fail / bucket.total * 100}%`}></i>{/if}
              {#if bucket.ok}<i class="ok" style={`--segment:${bucket.ok / bucket.total * 100}%`}></i>{/if}
            </div>
            {#if index % 3 === 0}<span>{shortTime(bucket.start)}</span>{/if}
          </div>
        {/each}
      </div>
    </article>

    <article class="intake-card">
      <div class="section-title"><div><p class="eyebrow">Next work</p><h3>Intake posture</h3></div><span class:clear={brake?.state === 'clear'} class:stopped={brake?.state === 'engaged'}>{brake?.state === 'clear' ? 'brake clear' : brake?.state === 'engaged' ? 'brake engaged' : 'brake unknown'}</span></div>
      <strong class="intake-state">{intake?.loop?.state === 'never-swept' ? 'Automation has not started' : intake?.loop?.state ? intake.loop.state.replaceAll('-', ' ') : 'Reading intake'}</strong>
      <p>{intake?.loop?.why || 'Waiting for the intake ledger.'}</p>
      <div class="intake-counts"><span><strong>{intake?.loop?.swept ?? '—'}</strong>sweeps</span><span><strong>{intake?.loop?.picked ?? '—'}</strong>picked</span><span><strong>{intake?.loop?.parked ?? '—'}</strong>parked</span></div>
    </article>
  </div>

  <div class="evidence-grid">
    <article class="faults">
      <div class="section-title"><div><p class="eyebrow">Concentrated risk</p><h3>Fault domains</h3></div><span>{healthSummary.failures} events · {cellHealth?.window?.label || 'window loading'}</span></div>
      {#if healthSummary.faultDomains.length}
        <div class="fault-list">
          {#each healthSummary.faultDomains as fault (fault.key)}
            <div class="fault-row"><span class="fault-count">{fault.failures}</span><div><strong>{fault.model}</strong><small>{fault.agent} · {fault.effort} · {fault.roles}</small></div><span class="fault-kind">{fault.kind}</span></div>
          {/each}
        </div>
      {:else}<p class="empty">No cell failures recorded in this window.</p>{/if}
    </article>

    <article class="exceptions">
      <div class="section-title"><div><p class="eyebrow">Act on evidence</p><h3>Recent exceptions</h3></div><span>{exceptions.length} shown</span></div>
      {#if exceptions.length}
        <div class="exception-list">
          {#each exceptions as row (row.adw_id)}
            <button disabled={!row.source} onclick={() => openException(row)}>
              <span class="exception-status">{row.status}</span><span><strong>{row.task_slug || row.adw_id}</strong><small>{row.repo_slug || 'repository unavailable'} · {shortTime(row.ended_at)}</small></span><b>{row.source ? 'Inspect →' : 'Not in task feed'}</b>
            </button>
          {/each}
        </div>
      {:else}<p class="empty">No failed or aborted tasks in this window.</p>{/if}
    </article>
  </div>
</section>

<style>
  .command { --posture:var(--muted); display:grid; gap:1rem; margin:1rem 0 1.5rem; }.command.ok { --posture:var(--status-ok); }.command.watch { --posture:var(--status-running); }.command.fail { --posture:var(--status-fail); }
  .command-head { display:flex; justify-content:space-between; align-items:center; gap:1.5rem; border:1px solid color-mix(in srgb,var(--posture) 45%,var(--line)); border-radius:var(--radius-lg); background:linear-gradient(110deg,color-mix(in srgb,var(--posture) 9%,var(--panel)),var(--panel) 45%); padding:1rem 1.15rem; }
  .posture { display:flex; align-items:center; gap:.9rem; }.pulse { flex:0 0 auto; width:.85rem; height:.85rem; border-radius:50%; background:var(--posture); box-shadow:0 0 0 .35rem color-mix(in srgb,var(--posture) 12%,transparent),0 0 18px color-mix(in srgb,var(--posture) 55%,transparent); }
  .eyebrow { margin:0 0 .25rem; color:var(--muted); font-size:.62rem; font-weight:700; letter-spacing:.13em; text-transform:uppercase; }.posture h2 { margin:0; color:var(--posture); font-size:1.05rem; }.posture p:last-child { margin:.25rem 0 0; color:var(--muted); font-size:.76rem; }.readout { flex:0 0 auto; display:grid; justify-items:end; gap:.18rem; color:var(--muted); font:600 .68rem/1.3 var(--mono); }.readout small { font:400 .62rem/1.3 var(--sans); }.readout .stale { color:var(--status-fail); }
  .brief-grid { display:grid; grid-template-columns:minmax(0,1.45fr) minmax(19rem,.8fr); gap:1rem; }.brief-grid > article,.evidence-grid > article { min-width:0; border:1px solid var(--line); border-radius:var(--radius-lg); background:color-mix(in srgb,var(--panel) 93%,transparent); padding:1rem; }
  .section-title { display:flex; align-items:start; justify-content:space-between; gap:1rem; }.section-title h3,.score-card h3 { margin:0; font-size:.9rem; }.section-title > span { color:var(--muted); font:500 .62rem/1.4 var(--mono); text-align:right; }
  .flow { display:grid; grid-template-columns:repeat(4,1fr auto); align-items:center; gap:.5rem; margin:1.5rem 0 1.15rem; }.flow > div { display:grid; gap:.2rem; }.flow strong { font:650 clamp(1.35rem,2vw,2rem)/1 var(--mono); }.flow span { color:var(--muted); font-size:.64rem; }.flow i { color:var(--line); font:normal 1rem var(--mono); }.flow .good strong { color:var(--status-ok); }
  .outcome-bar { display:flex; width:100%; height:.55rem; overflow:hidden; border-radius:2rem; background:var(--bg); }.outcome-bar span { width:var(--share); }.ok { background:var(--status-ok); }.fail { background:var(--status-fail); }.running { background:var(--status-running); }.legend { display:flex; flex-wrap:wrap; gap:.8rem; margin-top:.55rem; color:var(--muted); font-size:.62rem; }.legend span { display:flex; align-items:center; gap:.3rem; }.legend i { width:.4rem; height:.4rem; border-radius:50%; }
  .score-row { display:grid; grid-template-columns:repeat(3,1fr); gap:.5rem; margin:1.1rem 0; }.score-row div { min-width:0; display:grid; gap:.2rem; }.score-row strong { font:650 1.2rem/1 var(--mono); }.score-row span { color:var(--muted); font-size:.58rem; }.coverage-list { display:grid; gap:.65rem; padding-top:.8rem; border-top:1px solid var(--line); }.coverage-item { display:grid; gap:.24rem; }.coverage-item > div:first-child { display:flex; justify-content:space-between; gap:1rem; font-size:.65rem; }.coverage-item strong { color:var(--muted); font:500 .62rem var(--mono); }.coverage-item small { color:var(--muted); font-size:.56rem; }.meter { height:.25rem; border-radius:1rem; background:var(--bg); overflow:hidden; }.meter i { display:block; width:var(--coverage); height:100%; background:var(--accent); border-radius:inherit; }
  .histogram { height:8.5rem; display:grid; grid-template-columns:repeat(12,1fr); align-items:end; gap:.35rem; margin-top:1rem; border-bottom:1px solid var(--line); background:repeating-linear-gradient(to top,transparent 0,transparent calc(33% - 1px),color-mix(in srgb,var(--line) 45%,transparent) 33%); }.bar-column { height:100%; display:flex; flex-direction:column; justify-content:end; align-items:center; gap:.35rem; }.bar-column > span { height:.7rem; color:var(--muted); font:500 .5rem var(--mono); white-space:nowrap; }.bar-stack { width:min(1.25rem,70%); height:var(--height); min-height:2px; display:flex; flex-direction:column; justify-content:end; border-radius:.2rem .2rem 0 0; overflow:hidden; background:var(--line); }.bar-stack i { display:block; flex:0 0 var(--segment); width:100%; }
  .intake-card .clear { color:var(--status-ok); }.intake-card .stopped { color:var(--status-fail); }.intake-state { display:block; margin:1.2rem 0 .35rem; font-size:1rem; }.intake-card > p { min-height:2.2rem; margin:0; color:var(--muted); font-size:.7rem; line-height:1.5; }.intake-counts { display:grid; grid-template-columns:repeat(3,1fr); gap:.5rem; margin-top:1rem; padding-top:.8rem; border-top:1px solid var(--line); }.intake-counts span { display:grid; gap:.15rem; color:var(--muted); font-size:.58rem; }.intake-counts strong { color:inherit; font:650 1rem var(--mono); }
  .evidence-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1rem; }.fault-list,.exception-list { display:grid; margin-top:.8rem; }.fault-row { display:grid; grid-template-columns:2.2rem minmax(0,1fr) auto; align-items:center; gap:.7rem; padding:.6rem 0; border-top:1px solid var(--line); }.fault-count { width:2rem; height:2rem; display:grid; place-items:center; border-radius:.5rem; background:color-mix(in srgb,var(--status-fail) 10%,var(--panel-raised)); color:var(--status-fail); font:650 .8rem var(--mono); }.fault-row > div { min-width:0; display:grid; gap:.12rem; }.fault-row strong { overflow:hidden; text-overflow:ellipsis; font-size:.7rem; }.fault-row small { overflow:hidden; text-overflow:ellipsis; color:var(--muted); font-size:.58rem; white-space:nowrap; }.fault-kind,.exception-status { border:1px solid color-mix(in srgb,var(--status-fail) 35%,var(--line)); border-radius:2rem; color:var(--status-fail); padding:.2rem .45rem; font:500 .56rem var(--mono); white-space:nowrap; }
  .exception-list button { width:100%; display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:.7rem; border:0; border-top:1px solid var(--line); background:transparent; padding:.63rem 0; text-align:left; cursor:pointer; }.exception-list button:disabled { cursor:default; }.exception-list button > span:nth-child(2) { min-width:0; display:grid; gap:.12rem; }.exception-list strong { overflow:hidden; text-overflow:ellipsis; font-size:.7rem; }.exception-list small { overflow:hidden; text-overflow:ellipsis; color:var(--muted); font-size:.58rem; white-space:nowrap; }.exception-list b { color:var(--accent); font-size:.58rem; }.exception-list button:disabled b { color:var(--muted); }.empty { margin:1rem 0 0; color:var(--muted); font-size:.7rem; }
  @media (max-width: 980px) { .brief-grid,.evidence-grid { grid-template-columns:1fr; }.flow { grid-template-columns:repeat(4,1fr); }.flow > i { display:none; } }
  @media (max-width: 620px) { .command-head { align-items:start; }.readout { display:none; }.flow { gap:.3rem; }.flow strong { font-size:1.15rem; }.score-row { grid-template-columns:1fr 1fr; }.fault-row { grid-template-columns:2.2rem minmax(0,1fr); }.fault-kind { grid-column:2; width:max-content; }.exception-list button { grid-template-columns:auto minmax(0,1fr); }.exception-list b { display:none; } }
</style>
