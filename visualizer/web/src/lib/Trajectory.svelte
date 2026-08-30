<script>
  import { clearFocus, initialJournalState, select, setRange, setReveal, trajectoryView } from './live.js'
  import { projectMarker } from './spans.js'
  import { assignmentPath, trajectoryRowStory, trajectorySummary } from './diagnostic-story.js'
  import { PANEL_REFRESH_MS } from './panels.js'

  let { run, journalState = initialJournalState() } = $props()
  let state = $state({ selected:null, range:null, reveal:false })
  let now = $state(Date.now())
  let dragFrom = null
  let trajectoryRunKey = ''
  let sourceState = $derived({ ...journalState, selected:state.selected, range:state.range, reveal:state.reveal })
  let view = $derived(trajectoryView(sourceState, { now, refresh_ms: run.running ? PANEL_REFRESH_MS : null }))
  let summary = $derived(trajectorySummary(view))
  let handoffs = $derived(assignmentPath(view))
  let driverStages = $derived(view.spans.filter((span) => span.family === 'stage' && span.actor === 'driver'))

  function fraction(event) {
    const box = event.currentTarget.getBoundingClientRect()
    return box.width > 0 ? Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) : 0
  }
  function markerTitle(marker) {
    if (marker.kind !== 'substrate') return `${marker.event} ${marker.detail}`
    const episode = marker.outage_ms == null ? 'still open' : `${Math.round(marker.outage_ms / 1000)}s`
    return `${marker.event} — pane-manager substrate outage (${episode}); correlated across every lane in this batch ${marker.detail}`
  }
  $effect(() => { const readAt = journalState.read_at; now = readAt ?? Date.now() })
  $effect(() => {
    const id = run.adw_id || ''
    if (!id || id === trajectoryRunKey) return
    trajectoryRunKey = id
    state = { selected:null, range:null, reveal:false }
  })

  function down(event) { dragFrom = view.origin + fraction(event) * view.total; state = setRange(state, null) }
  function up(event) {
    if (dragFrom == null) return
    const to = view.origin + fraction(event) * view.total
    state = setRange(state, { from: Math.min(dragFrom, to), to: Math.max(dragFrom, to) })
    dragFrom = null
  }
  function label(value) { return String(value || 'unknown').replaceAll('_',' ').replaceAll('-',' ') }
  function clock(value) {
    if (value == null) return '—'
    return new Intl.DateTimeFormat(undefined, { hour:'numeric', minute:'2-digit', second:'2-digit' }).format(new Date(value))
  }
  function elapsed(value) {
    const seconds = Math.max(0, Math.round((value - view.origin) / 1000))
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2,'0')}s`
  }
  function stageName(value) {
    const match = String(value || '').match(/^(.+):r(\d+)$/)
    return match ? `${label(match[1])} ${match[2]}` : label(value)
  }
</script>

<section class="panel">
  <header class="panel-head"><div><p class="micro">Agent trajectory</p><h2>How work moved between seats</h2><p>Each handoff begins when the factory assigns a dispatch and ends when that seat returns an envelope. Factory-only coordination is separated below.</p></div><span class:stale={view.freshness.stale} class="freshness">{view.freshness.refresh_label}</span></header>

  {#if view.degraded}<p class="error">Trajectory unavailable — {view.payload_error || 'the journal reader reported a degraded read'}</p>
  {:else}
    <div class="overview" aria-label="Trajectory summary"><div><strong>{summary.handoffs}</strong><span>agent handoffs</span></div><div><strong>{summary.completed}</strong><span>returns received</span></div><div class:warn={summary.seatIncidents > 0}><strong>{summary.seatIncidents}</strong><span>seat retry incidents</span></div><div class:fail={summary.substrateOutages > 0}><strong>{summary.substrateOutages}</strong><span>shared substrate outages</span></div></div>

    <section class="path-section"><div class="section-head"><div><h3>Handoff path</h3><p>Who received work, in dispatch order, and what came back.</p></div>{#if state.range}<button onclick={() => { state = clearFocus(state) }}>Show full run</button>{/if}</div>
      {#if handoffs.length}<div class="handoff-path">{#each handoffs as handoff (handoff.started_index)}<article style={`--role-color:var(--role-${handoff.role})`}><span class="order">{String(handoff.order).padStart(2,'0')}</span><span class="role-icon">{handoff.role.slice(0,1).toUpperCase()}</span><div><strong>{label(handoff.role)}</strong><small>{handoff.dispatch} · {handoff.duration}</small></div><span class={`outcome ${handoff.outcome}`}>{label(handoff.outcome)}</span></article>{/each}</div>{:else}<div class="empty"><strong>No agent handoffs in this view.</strong><span>The factory may have completed this interval without dispatching a seat.</span></div>{/if}
    </section>

    {#if handoffs.length}<section class="lanes"><div class="section-head"><div><h3>Seat timing</h3><p>Bars are agent work. Amber ticks are seat retries; coral bands are shared substrate outages. Drag across a rail to focus an interval.</p></div><div class="axis"><span>{clock(view.origin)}</span><span>+{elapsed(view.origin + view.total)}</span></div></div>
      <div class="lane-list">{#each handoffs as handoff (handoff.started_index)}<div class="lane" style={`--role-color:var(--role-${handoff.role})`}><span class="lane-name"><strong>{handoff.dispatch}</strong><small>{label(handoff.role)}</small></span><span class="rail" onmousedown={down} onmouseup={up} role="presentation">{#if handoff.box.marker}<span class="open-marker" style={`left:${handoff.box.left * 100}%`}></span>{:else}<span class="bar" style={`left:${handoff.box.left * 100}%;width:${Math.max(handoff.box.width * 100,.3)}%`}></span>{/if}{#each handoff.markers ?? [] as marker (marker.index)}{#if marker.outage_ms != null && marker.down_at_ms != null}<span class="outage" style={`left:${projectMarker(marker.down_at_ms, view.origin, view.total).left * 100}%;width:${(marker.outage_ms / view.total) * 100}%`}></span>{/if}<span class:substrate={marker.kind === 'substrate'} class="event-marker" title={markerTitle(marker)} style={`left:${projectMarker(marker.at_ms, view.origin, view.total).left * 100}%`}></span>{/each}</span><span class="lane-time">{handoff.duration}</span></div>{/each}</div>
    </section>{/if}

    {#if driverStages.length}<details class="coordination"><summary><span><strong>Factory coordination between handoffs</strong><small>{driverStages.length} stage{driverStages.length === 1 ? '' : 's'} performed without an active agent assignment</small></span><b>Show</b></summary><div class="stage-grid">{#each driverStages as span (span.started_index)}<span><strong>{stageName(span.label)}</strong><small>{span.took}</small></span>{/each}</div></details>{/if}

    <section class="journal"><div class="section-head"><div><h3>Activity journal</h3><p>The readable record behind the handoff path. Open any item for the exact journal row.</p></div><label><input type="checkbox" checked={state.reveal} onchange={(event) => { state = setReveal(state, event.currentTarget.checked) }} /> Show operational events <span>{view.hidden_operational}</span></label></div>
      <div class="activity-list">{#each view.rows as row (row.index)}{@const story = trajectoryRowStory(row)}<article class={`activity ${story.tone}`}><button onclick={() => { state = select(state, state.selected === row.index ? null : row.index) }}><span class="sequence">{row.index}</span><span class="activity-copy"><small>{clock(row.at_ms)} · {row.channel ?? 'unclassified'}</small><strong>{story.title}</strong>{#if story.detail}<span>{story.detail}</span>{/if}</span><b>{state.selected === row.index ? 'Close' : 'Inspect'}</b></button>{#if state.selected === row.index}<pre>{story.raw}</pre>{/if}</article>{:else}<div class="empty"><strong>No journal rows in this interval.</strong><span>Clear the time focus or reveal operational events.</span></div>{/each}</div>
    </section>

    {#if view.skipped_malformed > 0 || view.excluded_no_timestamp > 0 || view.anomalies.length}<details class="data-health"><summary>Journal data notes</summary><ul>{#if view.skipped_malformed > 0}<li>{view.skipped_malformed} malformed line(s) skipped: {view.skipped_line_numbers.join(', ')}</li>{/if}{#if view.excluded_no_timestamp > 0}<li>{view.excluded_no_timestamp} row(s) had no usable timestamp and were excluded rather than assigned a time.</li>{/if}{#each view.anomalies as anomaly}<li>{label(anomaly.kind)}: {anomaly.label} · expected {anomaly.expected ?? 'no open stage'}</li>{/each}</ul></details>{/if}
  {/if}
</section>

<style>
.panel { background:var(--panel); border:1px solid var(--line); border-radius:.6rem; padding:1rem; }.panel-head,.section-head { display:flex; align-items:start; justify-content:space-between; gap:1rem; }.micro { margin:0 0 .22rem; color:var(--accent); font-size:.58rem; font-weight:700; letter-spacing:.11em; text-transform:uppercase; }.panel-head h2 { margin:0; font-size:1.05rem; }.panel-head p:last-child,.section-head p { max-width:44rem; margin:.3rem 0 0; color:var(--muted); font-size:.65rem; line-height:1.45; }.freshness { flex:0 0 auto; border:1px solid var(--line); border-radius:2rem; color:var(--muted); padding:.28rem .5rem; font-size:.56rem; }.freshness.stale { border-color:var(--status-fail); color:var(--status-fail); }.overview { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); margin:.9rem 0; overflow:hidden; border:1px solid var(--line); border-radius:var(--radius); background:var(--bg); }.overview div { display:grid; gap:.2rem; padding:.65rem .75rem; border-left:1px solid var(--line); }.overview div:first-child { border-left:0; }.overview strong { font:650 1rem/1 var(--mono); }.overview span { color:var(--muted); font-size:.56rem; }.overview .warn strong { color:var(--status-running); }.overview .fail strong { color:var(--status-fail); }
.path-section,.lanes,.journal { margin-top:.8rem; border:1px solid var(--line); border-radius:var(--radius); background:var(--bg); padding:.8rem; }.section-head { align-items:end; margin-bottom:.65rem; }.section-head h3 { margin:0; font-size:.76rem; }.section-head button { min-height:1.9rem; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--panel-raised); color:var(--accent); padding:.3rem .5rem; font-size:.58rem; cursor:pointer; }
.handoff-path { display:flex; gap:.65rem; overflow:auto; padding:.15rem .1rem .3rem; }.handoff-path article { position:relative; flex:1 0 11rem; display:grid; grid-template-columns:auto auto minmax(0,1fr); align-items:center; gap:.45rem; min-height:3.4rem; border:1px solid color-mix(in srgb,var(--role-color) 40%,var(--line)); border-radius:var(--radius); background:color-mix(in srgb,var(--role-color) 7%,var(--panel)); padding:.55rem .65rem; }.handoff-path article:not(:last-child)::after { content:'→'; position:absolute; z-index:2; right:-.55rem; color:var(--muted); }.order { color:var(--muted); font:600 .56rem/1 var(--mono); }.role-icon { display:grid; place-items:center; width:1.8rem; height:1.8rem; border-radius:.5rem; background:color-mix(in srgb,var(--role-color) 16%,var(--panel)); color:var(--role-color); font:700 .67rem/1 var(--mono); }.handoff-path article > div { display:grid; min-width:0; gap:.18rem; }.handoff-path strong { font-size:.66rem; text-transform:capitalize; }.handoff-path small { color:var(--muted); font:500 .54rem/1 var(--mono); }.outcome { grid-column:3; width:max-content; border-radius:1rem; color:var(--muted); font-size:.53rem; text-transform:capitalize; }.outcome.done { color:var(--status-ok); }
.axis { display:flex; min-width:10rem; justify-content:space-between; color:var(--muted); font:500 .55rem/1 var(--mono); }.lane-list { display:grid; gap:.25rem; }.lane { display:grid; grid-template-columns:7rem minmax(12rem,1fr) 4rem; align-items:center; gap:.55rem; min-height:2.25rem; }.lane-name { display:grid; gap:.15rem; min-width:0; }.lane-name strong { color:var(--role-color); font:650 .62rem/1 var(--mono); }.lane-name small { overflow:hidden; color:var(--muted); font-size:.54rem; text-overflow:ellipsis; text-transform:capitalize; white-space:nowrap; }.rail { position:relative; display:block; height:1rem; border-radius:var(--radius-sm); background:var(--panel); cursor:crosshair; }.bar { position:absolute; top:.25rem; height:.5rem; min-width:2px; border-radius:1rem; background:var(--role-color); box-shadow:0 0 7px color-mix(in srgb,var(--role-color) 35%,transparent); }.open-marker { position:absolute; top:.12rem; width:0; height:.76rem; border-left:2px solid var(--role-color); }.event-marker { position:absolute; z-index:2; top:.05rem; width:0; height:.9rem; border-left:2px solid var(--status-running); }.event-marker.substrate { top:-.05rem; height:1.1rem; border-left-width:3px; border-left-color:var(--status-escalated); }.outage { position:absolute; z-index:1; top:.3rem; height:.4rem; background:var(--status-escalated); opacity:.28; }.lane-time { color:var(--muted); font:500 .56rem/1 var(--mono); text-align:right; }
.coordination,.data-health { margin-top:.8rem; border:1px solid var(--line); border-radius:var(--radius); background:var(--bg); }.coordination summary { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:.7rem .8rem; cursor:pointer; list-style:none; }.coordination summary::-webkit-details-marker { display:none; }.coordination summary span { display:grid; gap:.2rem; }.coordination summary strong { font-size:.68rem; }.coordination summary small { color:var(--muted); font-size:.57rem; }.coordination summary b { color:var(--accent); font-size:.57rem; }.stage-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(9rem,1fr)); gap:.4rem; border-top:1px solid var(--line); padding:.65rem .8rem; }.stage-grid span { display:grid; gap:.2rem; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--panel); padding:.5rem .6rem; }.stage-grid strong { overflow:hidden; font-size:.6rem; font-weight:600; text-overflow:ellipsis; text-transform:capitalize; white-space:nowrap; }.stage-grid small { color:var(--muted); font:500 .54rem/1 var(--mono); }
.journal .section-head label { display:flex; align-items:center; gap:.35rem; color:var(--muted); font-size:.58rem; white-space:nowrap; cursor:pointer; }.journal label span { border-radius:1rem; background:var(--panel); padding:.12rem .3rem; font-family:var(--mono); }.activity-list { max-height:38rem; overflow:auto; padding-right:.2rem; scrollbar-gutter:stable; }.activity { --activity-color:var(--muted); border-top:1px solid var(--line); }.activity:first-child { border-top:0; }.activity.active { --activity-color:var(--accent); }.activity.ok { --activity-color:var(--status-ok); }.activity.warn { --activity-color:var(--status-running); }.activity.fail { --activity-color:var(--status-fail); }.activity > button { display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:.6rem; align-items:start; width:100%; min-height:3.4rem; border:0; background:transparent; color:inherit; padding:.6rem .2rem; text-align:left; cursor:pointer; }.activity > button:hover { background:color-mix(in srgb,var(--activity-color) 5%,transparent); }.sequence { display:grid; place-items:center; width:1.6rem; height:1.6rem; border:1px solid color-mix(in srgb,var(--activity-color) 55%,var(--line)); border-radius:50%; color:var(--activity-color); font:600 .52rem/1 var(--mono); }.activity-copy { display:grid; min-width:0; gap:.18rem; }.activity-copy small { color:var(--muted); font:500 .52rem/1 var(--mono); }.activity-copy strong { font-size:.65rem; }.activity-copy > span { overflow:hidden; color:var(--muted); font-size:.58rem; text-overflow:ellipsis; white-space:nowrap; }.activity button b { color:var(--activity-color); font-size:.54rem; font-weight:600; }.activity pre { max-height:16rem; margin:0 0 .65rem 2.4rem; overflow:auto; border-radius:var(--radius-sm); background:var(--panel); padding:.6rem; font-size:.56rem; line-height:1.45; white-space:pre-wrap; overflow-wrap:anywhere; }
.data-health summary { padding:.65rem .8rem; color:var(--muted); font-size:.6rem; cursor:pointer; }.data-health ul { margin:0; border-top:1px solid var(--line); padding:.6rem 1.8rem; color:var(--muted); font-size:.58rem; }.error { border:1px solid color-mix(in srgb,var(--status-fail) 40%,var(--line)); border-radius:var(--radius-sm); color:var(--status-fail); padding:.6rem .7rem; }.empty { min-height:7rem; display:grid; place-content:center; gap:.3rem; color:var(--muted); text-align:center; }.empty strong { font-size:.72rem; }.empty span { font-size:.6rem; }
@media (max-width:720px) { .overview { grid-template-columns:repeat(2,1fr); }.overview div:nth-child(3) { border-left:0; border-top:1px solid var(--line); }.overview div:nth-child(4) { border-top:1px solid var(--line); }.panel-head { flex-direction:column; }.freshness { align-self:start; }.lane { grid-template-columns:5rem minmax(10rem,1fr) 3.5rem; }.section-head { align-items:start; flex-direction:column; }.axis { width:100%; }.journal .section-head label { white-space:normal; } }
</style>
