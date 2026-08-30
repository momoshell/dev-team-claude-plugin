<script>
  import { getEvents, getJournal, getReturns } from './api.js'
  import { drainEvents } from './drain.js'
  import { deriveDisplayStatus, durationCell, gateCell, reviewCell, tokenCell } from './fleet.js'
  import { runConfiguration } from './workflow-semantics.js'
  import { applyRead, initialJournalState, journalPulse, shouldRead } from './live.js'
  import PhaseGantt from './PhaseGantt.svelte'
  import EnvelopeInspector from './EnvelopeInspector.svelte'
  import ReviewPanel from './ReviewPanel.svelte'
  import AcceptPanel from './AcceptPanel.svelte'
  import EventStream from './EventStream.svelte'
  import Trajectory from './Trajectory.svelte'
  import PhasePanel from './PhasePanel.svelte'

  let { run, phase = null, onback = () => {}, onphase = () => {} } = $props()
  let returns = $state({ envelopes: [], task: null })
  let events = $state([])
  let selectedPhase = $state(null)
  let journalState = $state(initialJournalState())
  let error = $state('')
  let copied = $state(false)
  let detailGeneration = 0
  let journalGeneration = 0
  let detailKey = ''
  let journalKey = ''

  let status = $derived(deriveDisplayStatus(run, returns?.task, Date.now()))
  let duration = $derived(durationCell(run))
  let tokens = $derived(tokenCell(run))
  let gate = $derived(gateCell(run))
  let review = $derived(reviewCell(run))
  let configuration = $derived(runConfiguration(run))
  let started = $derived(dateParts(run.started_at))
  let finished = $derived(dateParts(run.ended_at))

  async function load(target = { repo_slug:run.repo_slug, task_slug:run.goal, adw_id:run.adw_id }) {
    const generation = ++detailGeneration
    error = ''
    try {
      const [returnResult, eventResult] = await Promise.all([
        target.repo_slug && target.task_slug ? getReturns(target.repo_slug, target.task_slug, target.adw_id) : Promise.resolve({ envelopes:[], task:null }),
        drainEvents((after, limit) => getEvents(target.adw_id, after, limit), {}),
      ])
      if (generation === detailGeneration) {
        returns = returnResult
        events = eventResult.events
      }
    } catch (err) { if (generation === detailGeneration) error = err.message || 'Task details could not be loaded.' }
  }
  async function loadJournal(target) {
    const generation = ++journalGeneration
    try {
      const payload = await getJournal(target.repo_slug, target.task_slug, target.adw_id)
      if (generation === journalGeneration) journalState = applyRead(journalState, { ok:true, payload }, Date.now())
    } catch (err) {
      if (generation === journalGeneration) journalState = applyRead(journalState, { ok:false, error:err.message }, Date.now())
    }
  }
  $effect(() => {
    const target = { repo_slug:run.repo_slug || '', task_slug:run.goal || '', adw_id:run.adw_id || '' }
    if (!target.adw_id || target.adw_id === detailKey) return
    detailKey = target.adw_id
    void load(target)
  })
  $effect(() => {
    const target = { repo_slug:run.repo_slug || '', task_slug:run.goal || '', adw_id:run.adw_id || '' }
    const key = `${target.repo_slug}\u0000${target.task_slug}\u0000${target.adw_id}`
    if (!target.adw_id || key === journalKey) return
    journalKey = key
    journalState = initialJournalState()
    void loadJournal(target)
  })
  $effect(() => journalPulse.subscribe(() => {
    if (!shouldRead({ running:run.running })) return
    const target = { repo_slug:run.repo_slug || '', task_slug:run.goal || '', adw_id:run.adw_id || '' }
    void load(target)
    void loadJournal(target)
  }))
  $effect(() => {
    const requested = phase
    const phases = run.phases || []
    selectedPhase = requested ?? phases.find((item) => item.status === 'running')?.name ?? phases.at(-1)?.name ?? null
  })

  function selectPhase(name) { selectedPhase = name; onphase(name) }
  function title(value) { return String(value || 'phase').replaceAll('_',' ') }
  function dateParts(value) {
    if (!value) return { iso:null, date:'Not recorded', time:'Time unavailable' }
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) return { iso:null, date:String(value), time:'Time unavailable' }
    return {
      iso: parsed.toISOString(),
      date: new Intl.DateTimeFormat(undefined, { month:'short', day:'numeric', year:'numeric' }).format(parsed),
      time: new Intl.DateTimeFormat(undefined, { hour:'numeric', minute:'2-digit' }).format(parsed),
    }
  }
  function compact(value) { return value == null ? '—' : Intl.NumberFormat(undefined, { notation:'compact', maximumFractionDigits:1 }).format(value) }
  function percent(value) { return value == null ? '—' : `${value.toFixed(1)}%` }
  async function copyId() {
    try { await navigator.clipboard.writeText(run.adw_id); copied = true; setTimeout(() => copied = false, 1200) } catch {}
  }
</script>

<main class="detail">
  <div class="breadcrumbs"><button onclick={onback}>Tasks</button><span>/</span><span>{run.repo_slug || 'repository'}</span><span>/</span><strong>{String(run.adw_id || '').slice(0,8)}</strong></div>

  <header class="task-header">
    <div class="task-title"><div class="status-line"><span class={`status ${status.tone}`}><i></i>{status.word}</span><span>{configuration.assurance.label} assurance</span>{#if run.mode}<span>{run.mode}</span>{/if}</div><h1>{run.goal || 'Untitled task'}</h1><p><span>{run.repo_slug || 'Repository unavailable'}</span><span class="header-start">Started <time datetime={started.iso || undefined}>{started.date} · {started.time}</time></span></p></div>
    <button class="id-button" onclick={copyId} title={run.adw_id}><span>{copied ? 'Copied' : 'Run ID'}</span><code>{String(run.adw_id || '').slice(0,8)}</code></button>
  </header>

  <section class="configuration-strip" aria-label="Recorded run configuration">
    <article><span>Task profile</span><strong class:missing={!configuration.profile.key}>{configuration.profile.label}</strong><small>{configuration.profile.summary}</small></article>
    <article><span>Execution shape</span><strong class:missing={!configuration.execution.key}>{configuration.execution.label}</strong><small>{configuration.execution.summary}</small></article>
    <article><span>Assurance</span><strong class:missing={!configuration.assurance.key}>{configuration.assurance.label}</strong><small>{configuration.assurance.key ? `${configuration.assurance.summary} · stored as ${configuration.assurance.key}` : configuration.assurance.summary}</small></article>
  </section>

  <section class="summary-grid" aria-label="Task summary">
    <article class="timing-summary"><span class="summary-label">Timing</span><strong>{duration.dashed ? (run.running ? 'In progress' : '—') : duration.text}</strong><div class="date-pair"><time datetime={started.iso || undefined}><b>{started.date}</b><small>{started.time} start</small></time>{#if !run.running}<time datetime={finished.iso || undefined}><b>{finished.date}</b><small>{finished.time} finish</small></time>{/if}</div></article>
    <article><span class="summary-label">Workflow</span><strong>{run.phases?.length || 0} <small>phase{run.phases?.length === 1 ? '' : 's'}</small></strong><div class="fact-row"><span>{run.agents?.length || 0} crew seats</span><span>{run.phases?.length ? `${title(run.phases.at(-1)?.name)} latest` : 'No phase recorded'}</span></div></article>
    <article><span class="summary-label">Evidence</span><div class="proof-grid"><span><small>Gate proof</small><strong class={`proof ${gate.verdict || ''}`}>{gate.dashed ? '—' : gate.text}</strong></span><span><small>Review</small><strong>{review.dashed ? '—' : review.verdict}</strong></span></div><div class="fact-row"><span>{gate.dashed ? 'Not available' : `Generation ${gate.generation ?? '—'}`}</span><span>{review.dashed ? 'Not recorded' : `${review.round} rounds · ${review.bounces} bounces`}</span></div></article>
    <article class="usage-summary"><span class="summary-label">Billed token volume</span><div class="usage-head"><strong>{tokens.dashed ? '—' : compact(tokens.value)}</strong>{#if tokens.cacheRate != null}<span class="cache-badge" title="Cache reads ÷ input, cache writes, and cache reads">{percent(tokens.cacheRate)} cache hit</span>{/if}</div>{#if !tokens.dashed}<div class="cache-meter" aria-label={`${percent(tokens.cacheRate)} cache hit`}><i style={`width:${tokens.cacheRate ?? 0}%`}></i></div><div class="usage-breakdown"><span>{compact(tokens.cacheRead)} cache reads</span><span>{compact(tokens.cacheWrite)} cache writes</span><span>{compact(tokens.input)} fresh input</span><span>{compact(tokens.output)} output</span></div>{:else}<small>{tokens.title || 'Not measured for this run'}</small>{/if}</article>
  </section>

  {#if status.key === 'silent' || status.key === 'unverified'}
    <section class="liveness-note"><span aria-hidden="true">!</span><div><strong>{status.key === 'silent' ? 'Stale open record' : 'Open record not verified'}</strong><p>{status.why} The waterfall below preserves the recorded phase state; it is not evidence that a worker is still alive.</p></div></section>
  {/if}

  {#if error}<p class="error-banner">{error}</p>{/if}

  <div class="execution-layout">
    <PhaseGantt {run} {events} {journalState} selected={selectedPhase} onselectphase={selectPhase} />
    <aside class="crew-panel">
      <header><p class="micro">Assigned crew</p><h2>{run.agents?.length || 0} seat{run.agents?.length === 1 ? '' : 's'}</h2></header>
      <div class="crew-list">
        {#each run.agents || [] as agent (agent.key)}
          <article><span class="avatar" style={`--crew-color:var(--role-${agent.role})`}>{agent.role?.slice(0,1).toUpperCase() || '?'}</span><span class="crew-copy"><strong>{agent.role || 'Unlinked seat'}</strong><small>{agent.model || 'Model not measured'}</small></span><span class={`outcome ${agent.outcome || status.key}`}>{agent.outcome || (run.running ? status.key === 'silent' ? 'stale' : status.key : 'unknown')}</span></article>
        {:else}<p>No seat assignments were recorded.</p>{/each}
      </div>
      <div class="task-times"><div><span>Started</span><time datetime={started.iso || undefined}><strong>{started.date}</strong><small>{started.time}</small></time></div><div><span>Finished</span>{#if run.running}<strong>{status.key === 'silent' ? 'Stale open record' : status.key === 'unverified' ? 'Not verified' : 'Still running'}</strong>{:else}<time datetime={finished.iso || undefined}><strong>{finished.date}</strong><small>{finished.time}</small></time>{/if}</div></div>
    </aside>
  </div>

  <section class="phase-section">
    <header><div><p class="micro">Selected phase</p><h2>{selectedPhase ? title(selectedPhase) : 'Choose a phase'}</h2></div>{#if selectedPhase}<span>Click another bar in the waterfall to inspect it.</span>{/if}</header>
    <PhasePanel {run} phase={selectedPhase} {returns} {events} />
  </section>

  <section class="diagnostics">
    <div class="diagnostics-heading"><p class="micro">Deep inspection</p><h2>Evidence & diagnostics</h2><p>The primary execution story is above. Open these only when you need the underlying envelopes, agent trace, or raw events.</p></div>
    <details><summary><span><strong>Agent returns & outcome</strong><small>What each seat handed back, the review evidence, and final acceptance</small></span><b>Open</b></summary><div class="detail-stack"><EnvelopeInspector {run} {returns} /><ReviewPanel {run} {returns} /><AcceptPanel {run} {returns} /></div></details>
    <details><summary><span><strong>Agent trajectory</strong><small>How work moved between seats, how long each handoff took, and where retries occurred</small></span><b>Open</b></summary><div class="detail-stack"><Trajectory {run} {journalState} /></div></details>
    <details><summary><span><strong>Event stream</strong><small>An ordered, filterable account of turns, decisions, and workflow signals</small></span><b>Open</b></summary><div class="detail-stack"><EventStream {run} {events} phaseFilter={selectedPhase} onrefresh={load} /></div></details>
  </section>
</main>

<style>
.detail { position:relative; width:min(1440px,100%); margin:auto; padding:1.2rem 1.25rem 4rem; display:grid; gap:1rem; }.breadcrumbs { display:flex; align-items:center; gap:.45rem; color:var(--muted); font-size:.67rem; }.breadcrumbs button { min-height:auto; border:0; background:transparent; color:var(--accent); padding:0; cursor:pointer; }.breadcrumbs strong { color:inherit; font-family:var(--mono); font-weight:500; }
.task-header { display:flex; justify-content:space-between; align-items:end; gap:1rem; padding:.3rem 0 .2rem; }.status-line { display:flex; gap:.45rem; align-items:center; color:var(--muted); font-size:.65rem; text-transform:capitalize; }.status-line > span:not(.status) { border-left:1px solid var(--line); padding-left:.45rem; }.status { display:inline-flex; align-items:center; gap:.4rem; text-transform:capitalize; }.status i { width:.5rem; height:.5rem; border-radius:50%; background:currentColor; box-shadow:0 0 8px currentColor; }.status.ok { color:var(--status-ok); }.status.fail { color:var(--status-fail); }.status.aborted,.status.busy { color:var(--status-running); }.status.serious { color:var(--status-escalated); }.status.quiet { color:var(--muted); }.task-title h1 { margin:.4rem 0 .25rem; font-size:clamp(1.65rem,3vw,2.35rem); letter-spacing:-.045em; }.task-title p { display:flex; align-items:center; flex-wrap:wrap; gap:.4rem .7rem; margin:0; color:var(--muted); font-size:.72rem; }.header-start { border-left:1px solid var(--line); padding-left:.7rem; }.header-start time { color:inherit; }
.id-button { display:grid; justify-items:end; gap:.25rem; border:1px solid var(--line); border-radius:var(--radius); background:var(--panel); padding:.55rem .7rem; cursor:pointer; }.id-button span { color:var(--muted); font-size:.58rem; text-transform:uppercase; letter-spacing:.1em; }.id-button code { font-family:var(--mono); color:var(--accent); }
.configuration-strip { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); overflow:hidden; border:1px solid var(--line); border-radius:var(--radius-lg); background:color-mix(in srgb,var(--panel) 94%,transparent); }.configuration-strip article { display:grid; align-content:start; gap:.25rem; min-width:0; padding:.72rem .9rem; border-right:1px solid var(--line); }.configuration-strip article:last-child { border-right:0; }.configuration-strip span { color:var(--muted); font-size:.55rem; font-weight:750; letter-spacing:.1em; text-transform:uppercase; }.configuration-strip strong { font-size:.76rem; }.configuration-strip strong.missing { color:var(--muted); }.configuration-strip small { overflow:hidden; color:var(--muted); font-size:.57rem; line-height:1.4; text-overflow:ellipsis; }
.summary-grid { display:grid; grid-template-columns:1.05fr .85fr 1.15fr 1.45fr; border:1px solid var(--line); border-radius:var(--radius-lg); background:var(--panel); overflow:hidden; }.summary-grid article { min-height:8.4rem; display:grid; align-content:space-between; gap:.65rem; padding:.9rem 1rem; border-right:1px solid var(--line); }.summary-grid article:last-child { border-right:0; }.summary-label { color:var(--muted); font-size:.61rem; font-weight:700; letter-spacing:.1em; text-transform:uppercase; }.summary-grid article > strong,.usage-head > strong { font:650 1.4rem/1 var(--mono); letter-spacing:-.04em; }.summary-grid article > strong small { color:var(--muted); font:500 .63rem/1 var(--sans); letter-spacing:0; }.date-pair { display:flex; flex-wrap:wrap; gap:.4rem .9rem; }.date-pair time { display:grid; gap:.12rem; }.date-pair b { font-size:.65rem; font-weight:600; }.date-pair small,.summary-grid article > small { color:var(--muted); font-size:.58rem; }.fact-row { display:flex; justify-content:space-between; gap:.5rem; color:var(--muted); font-size:.58rem; }.fact-row span:last-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-transform:capitalize; }.proof-grid { display:grid; grid-template-columns:1fr 1fr; gap:.7rem; }.proof-grid > span { display:grid; gap:.25rem; min-width:0; }.proof-grid small { color:var(--muted); font-size:.58rem; }.proof-grid strong { overflow:hidden; font:650 .78rem/1.1 var(--mono); text-overflow:ellipsis; text-transform:capitalize; white-space:nowrap; }.proof.proven { color:var(--status-ok); }.proof.failed { color:var(--status-fail); }.proof.unproven { color:var(--status-running); }.usage-head { display:flex; align-items:center; justify-content:space-between; gap:.6rem; }.cache-badge { border:1px solid color-mix(in srgb,var(--status-ok) 45%,var(--line)); border-radius:1rem; background:color-mix(in srgb,var(--status-ok) 9%,transparent); color:var(--status-ok); padding:.25rem .45rem; font-size:.57rem; white-space:nowrap; }.cache-meter { height:.3rem; overflow:hidden; border-radius:1rem; background:var(--bg); }.cache-meter i { display:block; height:100%; border-radius:inherit; background:linear-gradient(90deg,var(--accent),var(--status-ok)); }.usage-breakdown { display:grid; grid-template-columns:1fr 1fr; gap:.22rem .65rem; color:var(--muted); font-size:.57rem; }.usage-breakdown span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.liveness-note { display:grid; grid-template-columns:auto minmax(0,1fr); align-items:start; gap:.65rem; border:1px solid color-mix(in srgb,var(--status-running) 45%,var(--line)); border-radius:var(--radius); background:color-mix(in srgb,var(--status-running) 7%,var(--panel)); padding:.75rem .85rem; }.liveness-note > span { display:grid; place-content:center; width:1.45rem; height:1.45rem; border-radius:50%; background:color-mix(in srgb,var(--status-running) 14%,var(--panel-raised)); color:var(--status-running); font:750 .68rem/1 var(--mono); }.liveness-note div { display:grid; gap:.18rem; }.liveness-note strong { color:var(--status-running); font-size:.72rem; }.liveness-note p { margin:0; color:var(--muted); font-size:.64rem; line-height:1.45; }
.error-banner { margin:0; border:1px solid color-mix(in srgb,var(--status-fail) 45%,var(--line)); border-radius:var(--radius); background:color-mix(in srgb,var(--status-fail) 8%,var(--panel)); color:var(--status-fail); padding:.75rem 1rem; }.execution-layout { display:grid; grid-template-columns:minmax(0,3fr) minmax(16rem,1fr); gap:1rem; align-items:start; }
.crew-panel { overflow:hidden; border:1px solid var(--line); border-radius:var(--radius-lg); background:var(--panel); box-shadow:var(--shadow); }.crew-panel > header { padding:1rem; border-bottom:1px solid var(--line); }.crew-panel .micro { margin:0 0 .25rem; color:var(--accent); }.crew-panel h2 { margin:0; font-size:1.05rem; }.crew-list { padding:.35rem .75rem; }.crew-list article { display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:.55rem; align-items:center; padding:.65rem 0; border-top:1px solid color-mix(in srgb,var(--line) 70%,transparent); }.crew-list article:first-child { border-top:0; }.avatar { display:grid; place-content:center; width:1.8rem; height:1.8rem; border-radius:.5rem; background:color-mix(in srgb,var(--crew-color) 16%,var(--panel)); color:var(--crew-color); font:700 .7rem/1 var(--mono); }.crew-copy { display:grid; min-width:0; gap:.18rem; }.crew-copy strong { font-size:.72rem; text-transform:capitalize; }.crew-copy small { overflow:hidden; color:var(--muted); font-size:.6rem; text-overflow:ellipsis; white-space:nowrap; }.outcome { color:var(--muted); font-size:.58rem; text-transform:capitalize; }.outcome.done { color:var(--status-ok); }.outcome.fail,.outcome.failed { color:var(--status-fail); }.outcome.active,.outcome.running,.outcome.silent,.outcome.unverified { color:var(--status-running); }
.task-times { display:grid; grid-template-columns:1fr 1fr; gap:.6rem; border-top:1px solid var(--line); padding:.75rem; }.task-times div { display:grid; gap:.3rem; font-size:.6rem; }.task-times span { color:var(--muted); }.task-times time { display:grid; gap:.12rem; }.task-times strong { font-weight:600; }.task-times small { color:var(--muted); }
.phase-section { overflow:hidden; border:1px solid var(--line); border-radius:var(--radius-lg); background:var(--panel); }.phase-section > header { display:flex; align-items:end; justify-content:space-between; gap:1rem; padding:1rem; border-bottom:1px solid var(--line); }.phase-section > header .micro { margin:0 0 .25rem; color:var(--accent); }.phase-section > header h2 { margin:0; font-size:1.05rem; text-transform:capitalize; }.phase-section > header > span { color:var(--muted); font-size:.65rem; }.phase-section :global(> .panel) { border:0; border-radius:0; background:transparent; }
.diagnostics { overflow:hidden; border:1px solid var(--line); border-radius:var(--radius-lg); background:var(--panel); }.diagnostics-heading { padding:1rem; border-bottom:1px solid var(--line); }.diagnostics-heading .micro { margin:0 0 .25rem; color:var(--accent); }.diagnostics-heading h2 { margin:0; font-size:1.05rem; }.diagnostics-heading p:last-child { margin:.3rem 0 0; max-width:45rem; color:var(--muted); font-size:.7rem; }.diagnostics > details { border-top:1px solid var(--line); }.diagnostics > details:first-of-type { border-top:0; }.diagnostics summary { display:flex; justify-content:space-between; align-items:center; gap:1rem; padding:.85rem 1rem; cursor:pointer; list-style:none; }.diagnostics summary::-webkit-details-marker { display:none; }.diagnostics summary > span { display:grid; gap:.2rem; }.diagnostics summary strong { font-size:.76rem; }.diagnostics summary small { color:var(--muted); font-size:.63rem; }.diagnostics summary > b { color:var(--muted); font-size:.64rem; }.diagnostics details[open] summary { background:var(--accent-soft); }.diagnostics details[open] summary > b { color:var(--accent); }.detail-stack { display:grid; gap:.75rem; padding:.75rem; border-top:1px solid var(--line); background:var(--bg); }.detail-stack :global(.panel) { margin:0; }
@media (max-width: 1100px) { .summary-grid { grid-template-columns:repeat(2,1fr); }.summary-grid article { border-bottom:1px solid var(--line); }.summary-grid article:nth-child(2n) { border-right:0; }.summary-grid article:nth-last-child(-n+2) { border-bottom:0; }.execution-layout { grid-template-columns:1fr; }.crew-panel { order:-1; }.crew-list { display:grid; grid-template-columns:repeat(auto-fit,minmax(13rem,1fr)); gap:0 1rem; } }
@media (max-width: 620px) { .detail { padding:1rem .75rem 3rem; }.task-header { align-items:start; }.id-button { display:none; }.header-start { width:100%; border-left:0; padding-left:0; }.configuration-strip { grid-template-columns:1fr; }.configuration-strip article { border-right:0; border-bottom:1px solid var(--line); }.configuration-strip article:last-child { border-bottom:0; }.summary-grid { grid-template-columns:1fr; }.summary-grid article { min-height:7.5rem; border-right:0; border-bottom:1px solid var(--line); }.summary-grid article:nth-last-child(-n+2) { border-bottom:1px solid var(--line); }.summary-grid article:last-child { border-bottom:0; }.phase-section > header > span { display:none; } }
</style>
