<script>
  import { deriveDisplayStatus, durationCell, gateCell, reviewCell, runActivity, tokenCell } from './fleet.js'
  import { assuranceMeta, assuranceOption, executionMeta, taskProfileMeta } from './workflow-semantics.js'
  import Pagination from './Pagination.svelte'
  import Dropdown from './Dropdown.svelte'

  let { runs = [], envelopes = new Map(), now = Date.now(), onopen = () => {}, focus = null } = $props()
  let query = $state('')
  let state = $state('all')
  let assurance = $state('all')
  let taskProfile = $state('all')
  let executionShape = $state('all')
  let showArchived = $state(false)
  let page = $state(1)
  let pageSize = $state(12)

  function envelopeFor(id) { return envelopes instanceof Map ? envelopes.get(id) : envelopes?.[id] }
  function statusFor(run) { return deriveDisplayStatus(run, envelopeFor(run.adw_id), now) }
  function activityFor(run) { return runActivity(run, now) }
  function matchesState(run) {
    const status = statusFor(run)
    if (state === 'active') return activityFor(run).live
    if (state === 'completed') return !run.running
    if (state === 'attention') return ['escalated', 'fail', 'aborted', 'silent', 'unverified'].includes(status.key)
    return true
  }
  function matchesQuery(run) {
    const needle = query.trim().toLowerCase()
    if (!needle) return true
    return [run.goal, run.repo_slug, run.adw_id, run.tier, assuranceMeta(run.tier).label, run.task_profile, taskProfileMeta(run.task_profile).label, run.variant, executionMeta(run.variant).label, run.engineer].some((value) => String(value || '').toLowerCase().includes(needle))
  }
  function phaseName(phase) { return String(phase?.name || 'phase').replaceAll('_', ' ') }
  function formatDate(value) {
    if (!value) return 'date unavailable'
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) return String(value)
    return new Intl.DateTimeFormat(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }).format(parsed)
  }
  function shortNumber(value) {
    if (value == null) return '—'
    return Intl.NumberFormat(undefined, { notation:'compact', maximumFractionDigits:1 }).format(value)
  }
  function cacheRate(value) { return value == null ? null : `${value.toFixed(1)}% cache hit` }

  let tiers = $derived([...new Set(runs.map((run) => run.tier).filter(Boolean))].sort())
  let assuranceOptions = $derived([{ value:'all', label:'All assurance' }, ...tiers.map(assuranceOption)])
  let profiles = $derived([...new Set(runs.map((run) => run.task_profile).filter(Boolean))].sort())
  let profileOptions = $derived([{ value:'all', label:'All profiles' }, ...profiles.map((value) => ({ value, label:taskProfileMeta(value).label }))])
  let executionShapes = $derived([...new Set(runs.map((run) => run.variant).filter(Boolean))].sort())
  let executionOptions = $derived([{ value:'all', label:'All execution' }, ...executionShapes.map((value) => ({ value, label:executionMeta(value).label }))])
  let counts = $derived({
    all: runs.filter((run) => !run.triage?.reviewed_at).length,
    active: runs.filter((run) => activityFor(run).live && !run.triage?.reviewed_at).length,
    completed: runs.filter((run) => !run.running && !run.triage?.reviewed_at).length,
    attention: runs.filter((run) => ['escalated', 'fail', 'aborted', 'silent', 'unverified'].includes(statusFor(run).key) && !run.triage?.reviewed_at).length,
  })
  let filtered = $derived(runs.filter((run) => (showArchived || !run.triage?.reviewed_at) && (run.goal || showArchived) && matchesState(run) && (assurance === 'all' || run.tier === assurance) && (taskProfile === 'all' || run.task_profile === taskProfile) && (executionShape === 'all' || run.variant === executionShape) && matchesQuery(run)))
  let paged = $derived(filtered.slice((page - 1) * pageSize, page * pageSize))

  $effect(() => { void `${query}|${state}|${assurance}|${taskProfile}|${executionShape}|${showArchived}`; page = 1 })
  $effect(() => {
    if (!focus?.revision || !['all', 'active', 'completed', 'attention'].includes(focus.state)) return
    state = focus.state
    query = ''
    assurance = 'all'
    taskProfile = 'all'
    executionShape = 'all'
    showArchived = false
    page = 1
  })
</script>

<section class="tasks-panel" id="task-board">
  <div class="status-tabs" role="tablist" aria-label="Task status">
    {#each [['all','All tasks'], ['active','Live now'], ['completed','Completed'], ['attention','Needs attention']] as tab (tab[0])}
      <button type="button" class:active={state === tab[0]} onclick={() => state = tab[0]} role="tab" aria-selected={state === tab[0]}>
        {tab[1]} <span>{counts[tab[0]]}</span>
      </button>
    {/each}
  </div>
  <div class="toolbar">
    <label class="search"><span class="search-mark" aria-hidden="true"></span><input bind:value={query} placeholder="Search tasks, repositories, or run IDs" aria-label="Search tasks" /></label>
    {#if profiles.length}<label class="select-label"><span>Profile</span><Dropdown bind:value={taskProfile} options={profileOptions} ariaLabel="Task profile" width="9rem" variant="compact" /></label>{/if}
    {#if executionShapes.length}<label class="select-label"><span>Execution</span><Dropdown bind:value={executionShape} options={executionOptions} ariaLabel="Execution shape" width="9rem" variant="compact" /></label>{/if}
    <label class="select-label"><span>Assurance</span><Dropdown bind:value={assurance} options={assuranceOptions} ariaLabel="Task assurance" width="10.5rem" variant="compact" /></label>
    <label class="archive"><input type="checkbox" bind:checked={showArchived} /><span>Show archived</span></label>
  </div>

  <div class="table-wrap">
    <table>
      <thead><tr><th>Task</th><th>Status</th><th>Execution</th><th>Proof</th><th>Elapsed</th><th>Usage</th><th><span class="sr-only">Open</span></th></tr></thead>
      <tbody>
        {#each paged as run (run.adw_id)}
          {@const status = statusFor(run)}
          {@const activity = activityFor(run)}
          {@const duration = durationCell(run)}
          {@const gate = gateCell(run)}
          {@const review = reviewCell(run)}
          {@const tokens = tokenCell(run)}
          <tr class:running={activity.live} class:silent={activity.attention && run.running} onclick={() => onopen(run)}>
            <td class="task-cell"><button type="button" class="task-link" onclick={(event) => { event.stopPropagation(); onopen(run) }}><strong>{run.goal || 'Untitled run'}</strong><span>{run.repo_slug || 'repository unavailable'} · <code>{String(run.adw_id || '').slice(0, 8)}</code></span></button></td>
            <td><span class={`status ${status.tone}`}><span class="status-dot" aria-hidden="true"></span>{status.word}</span><small title={assuranceMeta(run.tier).key ? `Stored tier: ${assuranceMeta(run.tier).key}` : assuranceMeta(run.tier).summary}>{assuranceMeta(run.tier).label} assurance</small></td>
            <td class="execution"><div class="phase-line" aria-label={`${run.phases?.length || 0} phases`}>{#each run.phases || [] as phase (phase.id ?? phase.seq)}<span class:active={phase.status === 'running'} class:failed={phase.status === 'fail'} style={`--phase-color:var(--lane-${phase.lane ?? 6})`} title={`${phaseName(phase)} · ${phase.status || 'unknown'}`}></span>{/each}</div><small>{run.variant ? `${executionMeta(run.variant).label} · ` : ''}{run.phases?.length ? `${run.phases.length} phase${run.phases.length === 1 ? '' : 's'} · ${phaseName(run.phases.at(-1))}` : 'Waiting for first phase'}</small></td>
            <td class="proof"><span class:muted={gate.dashed}>{gate.dashed ? 'No gate proof' : gate.text}</span><small class:muted={review.dashed}>{review.dashed ? 'No review yet' : review.text}</small></td>
            <td class="time"><strong>{duration.dashed ? (run.running ? status.word : '—') : duration.text}</strong><small>{formatDate(run.started_at)}</small></td>
            <td class="usage"><strong>{tokens.dashed ? '—' : shortNumber(tokens.value)}</strong><small title={tokens.cacheRate == null ? tokens.cachePending : 'Cache reads ÷ input, cache writes, and cache reads'}>{tokens.dashed ? 'Not measured' : tokens.cacheRate == null ? 'Cache hit not measured' : cacheRate(tokens.cacheRate)}</small></td>
            <td><button class="open" type="button" aria-label={`Open ${run.goal || 'task'}`} onclick={(event) => { event.stopPropagation(); onopen(run) }}>→</button></td>
          </tr>
        {:else}
          <tr><td colspan="7" class="empty"><strong>No tasks match this view.</strong><span>Try another status, assurance preset, or search term.</span></td></tr>
        {/each}
      </tbody>
    </table>
  </div>
  <Pagination bind:page bind:pageSize total={filtered.length} label="tasks" />
</section>

<style>
.tasks-panel { position:relative; overflow:hidden; background:color-mix(in srgb,var(--panel) 94%,transparent); border:1px solid var(--line); border-radius:var(--radius-lg); box-shadow:var(--shadow); }
.status-tabs { display:flex; gap:.3rem; padding:.65rem .75rem 0; overflow-x:auto; overflow-y:hidden; border-bottom:1px solid var(--line); scrollbar-width:none; -ms-overflow-style:none; }
.status-tabs::-webkit-scrollbar { display:none; width:0; height:0; }
.status-tabs button { position:relative; border:0; border-radius:var(--radius-sm) var(--radius-sm) 0 0; background:transparent; color:var(--muted); padding:.65rem .75rem .75rem; white-space:nowrap; cursor:pointer; }
.status-tabs button::after { content:''; position:absolute; height:2px; left:.6rem; right:.6rem; bottom:-1px; background:transparent; }
.status-tabs button.active { color:inherit; }.status-tabs button.active::after { background:var(--accent); }
.status-tabs button span { margin-left:.35rem; color:var(--muted); font-size:.75rem; }
.toolbar { display:flex; align-items:center; gap:.7rem; padding:.85rem; background:color-mix(in srgb,var(--panel-raised) 65%,transparent); border-bottom:1px solid var(--line); }
.search { position:relative; flex:1; min-width:14rem; }.search input { width:100%; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--bg); padding:.55rem .75rem .55rem 2.15rem; }
.search-mark { position:absolute; left:.8rem; top:50%; width:.72rem; height:.72rem; border:1.5px solid var(--muted); border-radius:50%; transform:translateY(-60%); pointer-events:none; }
.search-mark::after { content:''; position:absolute; width:.38rem; height:1.5px; background:var(--muted); right:-.28rem; bottom:-.16rem; transform:rotate(45deg); }
.select-label { display:flex; align-items:center; gap:.45rem; color:var(--muted); font-size:.78rem; }
.archive { display:flex; align-items:center; gap:.4rem; color:var(--muted); font-size:.78rem; white-space:nowrap; }.archive input { min-height:auto; accent-color:var(--accent); }
.table-wrap { overflow:auto; } table { width:100%; min-width:980px; border-collapse:collapse; }
th { padding:.65rem .85rem; color:var(--muted); font-size:.67rem; letter-spacing:.11em; text-transform:uppercase; text-align:left; font-weight:700; }
td { padding:.8rem .85rem; border-top:1px solid color-mix(in srgb,var(--line) 78%,transparent); vertical-align:middle; }
tbody tr { cursor:pointer; transition:background .15s ease; } tbody tr:hover { background:var(--accent-soft); } tbody tr.running { box-shadow:inset 2px 0 var(--status-running); }
tbody tr.silent { box-shadow:inset 2px 0 var(--status-escalated); }
.task-link { display:grid; gap:.2rem; border:0; background:transparent; text-align:left; cursor:pointer; padding:0; }.task-link strong { max-width:20rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:.88rem; }
.task-link span, small { display:block; color:var(--muted); font-size:.71rem; margin-top:.25rem; white-space:nowrap; } code { font-family:var(--mono); color:var(--muted); }
.status { display:inline-flex; align-items:center; gap:.4rem; font-size:.8rem; white-space:nowrap; }.status-dot { width:.45rem; height:.45rem; border-radius:50%; background:currentColor; box-shadow:0 0 0 3px color-mix(in srgb,currentColor 12%,transparent); }
.status.ok { color:var(--status-ok); }.status.fail { color:var(--status-fail); }.status.aborted { color:var(--status-running); }.status.busy { color:var(--status-running); }.status.serious { color:var(--status-escalated); }.status.quiet { color:var(--muted); }
.phase-line { display:flex; align-items:center; gap:3px; width:9rem; }.phase-line span { height:5px; min-width:8px; flex:1; border-radius:1rem; background:color-mix(in srgb,var(--phase-color) 68%,var(--line)); }
.phase-line span.active { height:7px; background:var(--phase-color); box-shadow:0 0 8px color-mix(in srgb,var(--phase-color) 60%,transparent); }.phase-line span.failed { background:var(--status-fail); }
.proof > span { display:block; text-transform:capitalize; font-size:.8rem; }.proof .muted { color:var(--muted); }
.time strong, .usage strong { font-family:var(--mono); font-size:.82rem; font-weight:600; white-space:nowrap; }.open { width:2rem; min-height:2rem; border:1px solid var(--line); border-radius:50%; background:var(--panel-raised); cursor:pointer; }
tr:hover .open { border-color:var(--accent); color:var(--accent); }.empty { height:14rem; text-align:center; color:var(--muted); }.empty strong,.empty span { display:block; }.empty strong { margin-bottom:.35rem; }
.sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0,0,0,0); }
@media (max-width: 760px) { .toolbar { flex-wrap:wrap; } .search { flex-basis:100%; } .archive { margin-left:auto; } }
</style>
