<script>
  import { getEvents, getReturns } from './api.js'
  import { drainEvents } from './drain.js'
  import { deriveStatus, durationCell, gateCell, reviewCell, tokenCell } from './fleet.js'
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
  let error = $state('')
  let copied = $state(false)

  let status = $derived(deriveStatus(run, returns?.task))
  let duration = $derived(durationCell(run))
  let tokens = $derived(tokenCell(run))
  let gate = $derived(gateCell(run))
  let review = $derived(reviewCell(run))

  async function load() {
    error = ''
    try {
      const [returnResult, eventResult] = await Promise.all([
        run.repo_slug && run.goal ? getReturns(run.repo_slug, run.goal, run.adw_id) : Promise.resolve({ envelopes:[], task:null }),
        drainEvents((after, limit) => getEvents(run.adw_id, after, limit), {}),
      ])
      returns = returnResult
      events = eventResult.events
    } catch (err) { error = err.message || 'Task details could not be loaded.' }
  }
  $effect(() => { const id = run.adw_id; if (id) void load() })
  $effect(() => {
    const requested = phase
    const phases = run.phases || []
    selectedPhase = requested ?? phases.find((item) => item.status === 'running')?.name ?? phases.at(-1)?.name ?? null
  })

  function selectPhase(name) { selectedPhase = name; onphase(name) }
  function title(value) { return String(value || 'phase').replaceAll('_',' ') }
  function formatDate(value, includeTime = true) {
    if (!value) return 'Not recorded'
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) return String(value)
    return new Intl.DateTimeFormat(undefined, includeTime ? { dateStyle:'medium', timeStyle:'short' } : { dateStyle:'medium' }).format(parsed)
  }
  function compact(value) { return value == null ? '—' : Intl.NumberFormat(undefined, { notation:'compact', maximumFractionDigits:1 }).format(value) }
  async function copyId() {
    try { await navigator.clipboard.writeText(run.adw_id); copied = true; setTimeout(() => copied = false, 1200) } catch {}
  }
</script>

<main class="detail">
  <div class="breadcrumbs"><button onclick={onback}>Tasks</button><span>/</span><span>{run.repo_slug || 'repository'}</span><span>/</span><strong>{String(run.adw_id || '').slice(0,8)}</strong></div>

  <header class="task-header">
    <div class="task-title"><div class="status-line"><span class={`status ${status.tone}`}><i></i>{status.word}</span><span>{run.tier || 'tier unavailable'} tier</span>{#if run.mode}<span>{run.mode}</span>{/if}</div><h1>{run.goal || 'Untitled task'}</h1><p>{run.repo_slug || 'Repository unavailable'}</p></div>
    <button class="id-button" onclick={copyId} title={run.adw_id}><span>{copied ? 'Copied' : 'Run ID'}</span><code>{String(run.adw_id || '').slice(0,8)}</code></button>
  </header>

  <section class="summary-grid" aria-label="Task summary">
    <article><span>Elapsed</span><strong>{duration.dashed ? (run.running ? 'In progress' : '—') : duration.text}</strong><small>{run.running ? 'still running' : `finished ${formatDate(run.ended_at)}`}</small></article>
    <article><span>Started</span><strong class="date">{formatDate(run.started_at, false)}</strong><small>{formatDate(run.started_at).split(', ').at(-1)}</small></article>
    <article><span>Workflow</span><strong>{run.phases?.length || 0}</strong><small>{run.phases?.length ? `${title(run.phases.at(-1)?.name)} is latest` : 'no phase recorded'}</small></article>
    <article><span>Gate proof</span><strong class={`proof ${gate.verdict || ''}`}>{gate.dashed ? '—' : gate.text}</strong><small>{gate.dashed ? 'not available' : `generation ${gate.generation ?? '—'}`}</small></article>
    <article><span>Review</span><strong class="review">{review.dashed ? '—' : review.verdict}</strong><small>{review.dashed ? 'not recorded' : `${review.round} round${review.round === 1 ? '' : 's'} · ${review.bounces} bounces`}</small></article>
    <article><span>Billed tokens</span><strong>{tokens.dashed ? '—' : compact(tokens.value)}</strong><small>{tokens.dashed ? 'not measured for this run' : tokens.value.toLocaleString()}</small></article>
  </section>

  {#if error}<p class="error-banner">{error}</p>{/if}

  <div class="execution-layout">
    <PhaseGantt {run} {events} selected={selectedPhase} onselectphase={selectPhase} />
    <aside class="crew-panel">
      <header><p class="micro">Assigned crew</p><h2>{run.agents?.length || 0} seat{run.agents?.length === 1 ? '' : 's'}</h2></header>
      <div class="crew-list">
        {#each run.agents || [] as agent (agent.key)}
          <article><span class="avatar" style={`--crew-color:var(--role-${agent.role})`}>{agent.role?.slice(0,1).toUpperCase() || '?'}</span><span class="crew-copy"><strong>{agent.role || 'Unlinked seat'}</strong><small>{agent.model || 'Model not measured'}</small></span><span class={`outcome ${agent.outcome || 'running'}`}>{agent.outcome || (run.running ? 'active' : 'unknown')}</span></article>
        {:else}<p>No seat assignments were recorded.</p>{/each}
      </div>
      <div class="task-times"><div><span>Start</span><strong>{formatDate(run.started_at)}</strong></div><div><span>Finish</span><strong>{run.running ? 'Still running' : formatDate(run.ended_at)}</strong></div></div>
    </aside>
  </div>

  <section class="phase-section">
    <header><div><p class="micro">Selected phase</p><h2>{selectedPhase ? title(selectedPhase) : 'Choose a phase'}</h2></div>{#if selectedPhase}<span>Click another bar in the waterfall to inspect it.</span>{/if}</header>
    <PhasePanel {run} phase={selectedPhase} {returns} {events} />
  </section>

  <section class="diagnostics">
    <div class="diagnostics-heading"><p class="micro">Deep inspection</p><h2>Evidence & diagnostics</h2><p>The primary execution story is above. Open these only when you need the underlying envelopes, agent trace, or raw events.</p></div>
    <details><summary><span><strong>Outcome & acceptance</strong><small>Envelopes, review findings, and the typed accept decision</small></span><b>Open</b></summary><div class="detail-stack"><EnvelopeInspector {run} {returns} /><ReviewPanel {run} {returns} /><AcceptPanel {run} {returns} /></div></details>
    <details><summary><span><strong>Agent trajectory</strong><small>Seat assignments, handoffs, retries, and operational markers</small></span><b>Open</b></summary><div class="detail-stack"><Trajectory {run} /></div></details>
    <details><summary><span><strong>Event stream</strong><small>Filterable low-level ledger events for this task</small></span><b>Open</b></summary><div class="detail-stack"><EventStream {run} phaseFilter={selectedPhase} /></div></details>
  </section>
</main>

<style>
.detail { position:relative; width:min(1440px,100%); margin:auto; padding:1.2rem 1.25rem 4rem; display:grid; gap:1rem; }.breadcrumbs { display:flex; align-items:center; gap:.45rem; color:var(--muted); font-size:.67rem; }.breadcrumbs button { min-height:auto; border:0; background:transparent; color:var(--accent); padding:0; cursor:pointer; }.breadcrumbs strong { color:inherit; font-family:var(--mono); font-weight:500; }
.task-header { display:flex; justify-content:space-between; align-items:end; gap:1rem; padding:.3rem 0 .2rem; }.status-line { display:flex; gap:.45rem; align-items:center; color:var(--muted); font-size:.65rem; text-transform:capitalize; }.status-line > span:not(.status) { border-left:1px solid var(--line); padding-left:.45rem; }.status { display:inline-flex; align-items:center; gap:.4rem; text-transform:capitalize; }.status i { width:.5rem; height:.5rem; border-radius:50%; background:currentColor; box-shadow:0 0 8px currentColor; }.status.ok { color:var(--status-ok); }.status.fail { color:var(--status-fail); }.status.busy { color:var(--status-running); }.status.serious { color:var(--status-escalated); }.status.quiet { color:var(--muted); }.task-title h1 { margin:.4rem 0 .25rem; font-size:clamp(1.65rem,3vw,2.35rem); letter-spacing:-.045em; }.task-title p { margin:0; color:var(--muted); font-size:.78rem; }
.id-button { display:grid; justify-items:end; gap:.25rem; border:1px solid var(--line); border-radius:var(--radius); background:var(--panel); padding:.55rem .7rem; cursor:pointer; }.id-button span { color:var(--muted); font-size:.58rem; text-transform:uppercase; letter-spacing:.1em; }.id-button code { font-family:var(--mono); color:var(--accent); }
.summary-grid { display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); border:1px solid var(--line); border-radius:var(--radius-lg); background:var(--panel); overflow:hidden; }.summary-grid article { min-height:6.5rem; display:grid; align-content:space-between; gap:.35rem; padding:.8rem .9rem; border-right:1px solid var(--line); }.summary-grid article:last-child { border-right:0; }.summary-grid span { color:var(--muted); font-size:.62rem; letter-spacing:.08em; text-transform:uppercase; }.summary-grid strong { font:600 1.25rem/1.1 var(--mono); text-transform:capitalize; overflow:hidden; text-overflow:ellipsis; }.summary-grid strong.date { font-size:.8rem; }.summary-grid small { color:var(--muted); font-size:.62rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }.proof.proven { color:var(--status-ok); }.proof.failed { color:var(--status-fail); }.proof.unproven { color:var(--status-running); }
.error-banner { margin:0; border:1px solid color-mix(in srgb,var(--status-fail) 45%,var(--line)); border-radius:var(--radius); background:color-mix(in srgb,var(--status-fail) 8%,var(--panel)); color:var(--status-fail); padding:.75rem 1rem; }.execution-layout { display:grid; grid-template-columns:minmax(0,3fr) minmax(16rem,1fr); gap:1rem; align-items:start; }
.crew-panel { overflow:hidden; border:1px solid var(--line); border-radius:var(--radius-lg); background:var(--panel); box-shadow:var(--shadow); }.crew-panel > header { padding:1rem; border-bottom:1px solid var(--line); }.crew-panel .micro { margin:0 0 .25rem; color:var(--accent); }.crew-panel h2 { margin:0; font-size:1.05rem; }.crew-list { padding:.35rem .75rem; }.crew-list article { display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:.55rem; align-items:center; padding:.65rem 0; border-top:1px solid color-mix(in srgb,var(--line) 70%,transparent); }.crew-list article:first-child { border-top:0; }.avatar { display:grid; place-content:center; width:1.8rem; height:1.8rem; border-radius:.5rem; background:color-mix(in srgb,var(--crew-color) 16%,var(--panel)); color:var(--crew-color); font:700 .7rem/1 var(--mono); }.crew-copy { display:grid; min-width:0; gap:.18rem; }.crew-copy strong { font-size:.72rem; text-transform:capitalize; }.crew-copy small { overflow:hidden; color:var(--muted); font-size:.6rem; text-overflow:ellipsis; white-space:nowrap; }.outcome { color:var(--muted); font-size:.58rem; text-transform:capitalize; }.outcome.done { color:var(--status-ok); }.outcome.fail,.outcome.failed { color:var(--status-fail); }.outcome.active,.outcome.running { color:var(--status-running); }
.task-times { display:grid; gap:.6rem; border-top:1px solid var(--line); padding:.75rem; }.task-times div { display:flex; justify-content:space-between; gap:.8rem; font-size:.62rem; }.task-times span { color:var(--muted); }.task-times strong { text-align:right; font-weight:500; }
.phase-section { overflow:hidden; border:1px solid var(--line); border-radius:var(--radius-lg); background:var(--panel); }.phase-section > header { display:flex; align-items:end; justify-content:space-between; gap:1rem; padding:1rem; border-bottom:1px solid var(--line); }.phase-section > header .micro { margin:0 0 .25rem; color:var(--accent); }.phase-section > header h2 { margin:0; font-size:1.05rem; text-transform:capitalize; }.phase-section > header > span { color:var(--muted); font-size:.65rem; }.phase-section :global(> .panel) { border:0; border-radius:0; background:transparent; }
.diagnostics { overflow:hidden; border:1px solid var(--line); border-radius:var(--radius-lg); background:var(--panel); }.diagnostics-heading { padding:1rem; border-bottom:1px solid var(--line); }.diagnostics-heading .micro { margin:0 0 .25rem; color:var(--accent); }.diagnostics-heading h2 { margin:0; font-size:1.05rem; }.diagnostics-heading p:last-child { margin:.3rem 0 0; max-width:45rem; color:var(--muted); font-size:.7rem; }.diagnostics > details { border-top:1px solid var(--line); }.diagnostics > details:first-of-type { border-top:0; }.diagnostics summary { display:flex; justify-content:space-between; align-items:center; gap:1rem; padding:.85rem 1rem; cursor:pointer; list-style:none; }.diagnostics summary::-webkit-details-marker { display:none; }.diagnostics summary > span { display:grid; gap:.2rem; }.diagnostics summary strong { font-size:.76rem; }.diagnostics summary small { color:var(--muted); font-size:.63rem; }.diagnostics summary > b { color:var(--muted); font-size:.64rem; }.diagnostics details[open] summary { background:var(--accent-soft); }.diagnostics details[open] summary > b { color:var(--accent); }.detail-stack { display:grid; gap:.75rem; padding:.75rem; border-top:1px solid var(--line); background:var(--bg); }.detail-stack :global(.panel) { margin:0; }
@media (max-width: 1100px) { .summary-grid { grid-template-columns:repeat(3,1fr); }.summary-grid article:nth-child(3) { border-right:0; }.summary-grid article:nth-child(-n+3) { border-bottom:1px solid var(--line); }.execution-layout { grid-template-columns:1fr; }.crew-panel { order:-1; }.crew-list { display:grid; grid-template-columns:repeat(auto-fit,minmax(13rem,1fr)); gap:0 1rem; } }
@media (max-width: 620px) { .detail { padding:1rem .75rem 3rem; }.task-header { align-items:start; }.id-button { display:none; }.summary-grid { grid-template-columns:repeat(2,1fr); }.summary-grid article { border-bottom:1px solid var(--line); }.summary-grid article:nth-child(2n) { border-right:0; }.summary-grid article:nth-last-child(-n+2) { border-bottom:0; }.phase-section > header > span { display:none; } }
</style>
