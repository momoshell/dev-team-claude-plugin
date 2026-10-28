<script>
  import { onMount, tick } from 'svelte'
  import { ListTodo, Bot, BookOpen, Workflow, RefreshCw } from 'lucide-svelte'
  import { getSessions } from './lib/api.js'
  import { sessionsFeedState } from './lib/activity.js'
  import { attentionBreakdown, deriveDisplayStatus, fleetActivity, needsAttention } from './lib/fleet.js'
  import { createRefreshLoop, journalPulse } from './lib/live.js'
  import { formatHash, parseHash, subscribeHash } from './lib/route.js'
  import TaskList from './lib/TaskList.svelte'
  import AgentsPage from './lib/AgentsPage.svelte'
  import SkillsPage from './lib/SkillsPage.svelte'
  import LeanRunDetail from './lib/LeanRunDetail.svelte'
  import Dropdown from './lib/Dropdown.svelte'

  const THEME_OPTIONS = [{ value:'ink', label:'Dark' }, { value:'paper', label:'Light' }, { value:'os', label:'System' }]

  let route = $state(parseHash(location.hash))
  let themeValue = 'os'
  try { themeValue = localStorage.getItem('dt-theme') || 'os' } catch {}
  let theme = $state(themeValue)
  let runs = $state([])
  // Lean lanes carry no ledger envelope: status comes from the journal row itself.
  const envelopes = new Map()
  let feedDegraded = $state(false)
  let feedSources = $state(null)
  let error = $state('')
  let now = $state(Date.now())
  let taskFocus = $state(null)
  let refreshGeneration = 0
  let refreshInFlight = false
  let refreshing = $state(false)
  let lastRead = $state(null)
  let autoRefresh = $state(true)
  let refreshLoop

  let activity = $derived(fleetActivity(runs, now))
  let runIndex = $derived(new Map(runs.map((run) => [run.adw_id, run])))
  let selectedRun = $derived(route.view === 'run' || route.view === 'phase' ? runIndex.get(route.adw_id) : null)
  let attentionRows = $derived(runs.map((run) => {
    const status = deriveDisplayStatus(run, envelopes.get(run.adw_id), now)
    const why = status.why || (status.key === 'fail'
      ? 'The run recorded a failure. Inspect its terminal phase and proof.'
      : status.key === 'aborted'
        ? 'The run stopped without an acceptance verdict. Inspect its preserved execution context.'
        : status.key === 'silent' || status.key === 'unverified'
          ? status.why
          : 'Code declined to fake a result and handed the preserved context to a human.')
    return { run, status, why }
  }).filter((row) => needsAttention(row.status.key) && !row.run.triage?.reviewed_at))
  let attentionSummary = $derived(attentionBreakdown(attentionRows))
  let pageTitle = $derived(selectedRun ? `${selectedRun.goal || 'Task'} · Factory` : route.view === 'agents' ? 'Agents · Factory' : route.view === 'skills' ? 'Skills · Factory' : route.view === 'prompts' ? 'Prompts · Factory' : route.view === 'ops' ? 'Operations · Factory' : route.view === 'workflows' ? 'Workflows · Factory' : route.view === 'assurances' ? 'Assurances · Factory' : 'Tasks · Factory')

  $effect(() => subscribeHash((next) => route = next))
  $effect(() => {
    if (typeof document === 'undefined') return
    if (theme === 'ink' || theme === 'paper') document.documentElement.dataset.theme = theme
    else delete document.documentElement.dataset.theme
    try { localStorage.setItem('dt-theme', theme) } catch {}
  })

  const sourceLine = (sources) => ['lean'].map((name) => `Lean ${sources[name].readable ? 'readable' : `unavailable${sources[name].absent ? ` — ${sources[name].absent}` : ''}`}`).join(' · ')

  async function refresh() {
    if (refreshInFlight) return
    refreshInFlight = true
    const generation = ++refreshGeneration
    refreshing = true
    try {
      const result = await getSessions({}, { signal: AbortSignal.timeout(15000) })
      if (generation !== refreshGeneration) return
      const nextRuns = Array.isArray(result?.runs) ? result.runs : []
      runs = nextRuns
      const nextFeed = sessionsFeedState(result)
      feedDegraded = nextFeed.degraded
      feedSources = nextFeed.sources
      now = Date.now()
      lastRead = now
      error = ''
      journalPulse.pulse()
    } catch (err) {
      if (generation === refreshGeneration) {
        error = err.message || 'session request failed'
        feedDegraded = true
        feedSources = null
      }
    } finally {
      refreshInFlight = false
      if (generation === refreshGeneration) refreshing = false
    }
  }

  onMount(() => {
    refreshLoop = createRefreshLoop(refresh, { delay:30000, visible:() => !document.hidden })
    void refreshLoop.refresh()
    return () => { refreshGeneration += 1; refreshLoop.stop() }
  })

  function navigate(next) { location.hash = formatHash(next) }
  function openRun(run) { navigate({ view: 'run', adw_id: run.adw_id }) }
  function backToTasks() { navigate({ view: 'fleet' }) }
  async function focusActivity() {
    const state = attentionRows.length ? 'attention' : activity.live ? 'active' : 'all'
    taskFocus = { state, revision: Date.now() }
    if (route.view !== 'fleet') navigate({ view: 'fleet' })
    await tick()
    requestAnimationFrame(() => document.getElementById('task-board')?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block:'start' }))
  }
</script>

<svelte:head><title>{pageTitle}</title><meta name="description" content="Factory task execution, lean lanes, agents and skills." /></svelte:head>

<a class="skip-link" href="#main-content" onclick={(event) => { event.preventDefault(); document.getElementById('main-content')?.focus() }}>Skip to content</a>
<aside class="sidebar" aria-label="Factory navigation">
  <a class="brand" href="#/" aria-label="Factory tasks"><span class="brand-mark" aria-hidden="true"><Workflow size={23} /></span><strong>Factory</strong></a>
  <nav aria-label="Primary navigation">
    <span class="nav-label">Workspace</span>
    <button class:active={route.view === 'fleet' || route.view === 'run' || route.view === 'phase'} onclick={() => navigate({ view:'fleet' })}><ListTodo size={18} aria-hidden="true" />Tasks</button>
    <span class="nav-label">Configuration</span>
    <button class:active={route.view === 'agents'} onclick={() => navigate({ view:'agents' })}><Bot size={18} aria-hidden="true" />Agents</button>
    <button class:active={route.view === 'skills'} onclick={() => navigate({ view:'skills' })}><BookOpen size={18} aria-hidden="true" />Skills</button>
  </nav>
  <div class="sidebar-footer">
    <span class="connection" class:degraded={feedDegraded}>{feedDegraded ? 'Feed unavailable' : feedSources ? '' : 'Connecting to sources…'}{#if feedSources}{feedDegraded ? ' — ' : ''}{sourceLine(feedSources)}{/if}</span>
    <small>{lastRead ? `Read at ${new Date(lastRead).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}` : 'Waiting for the first reading'}</small>
    <button class="refresh" onclick={() => refreshLoop?.refresh()} disabled={refreshing}><RefreshCw size={15} aria-hidden="true" />{refreshing ? 'Refreshing…' : 'Refresh now'}</button>
    <label class="auto-refresh"><input type="checkbox" bind:checked={autoRefresh} onchange={(event) => refreshLoop?.setEnabled(event.currentTarget.checked)} />Auto-refresh</label>
    <small>{autoRefresh ? 'Waits 30s after each reading' : 'Automatic reads paused'}</small>
    <label class="theme"><span>Theme</span><Dropdown bind:value={theme} options={THEME_OPTIONS} ariaLabel="Theme" width="6rem" variant="compact" /></label>
  </div>
</aside>
<div class="workspace" id="main-content" tabindex="-1">
{#if error}<p class="error-banner" role="alert">Could not refresh the lane list: {error}. Use Refresh to try again. Existing rows may be out of date.</p>{/if}

{#if route.view === 'run' || route.view === 'phase'}
  {#if selectedRun?.source === 'lean'}
    <LeanRunDetail run={selectedRun} onback={backToTasks} />
  {:else if !lastRead && !error}
    <main class="page"><section class="empty-state" role="status"><h1>Loading task…</h1><p>Reading the lane journals.</p></section></main>
  {:else if error || feedDegraded}
    <main class="page"><section class="empty-state"><h1>Task records unavailable</h1><p>Refresh the lane list before checking whether this task exists.</p></section></main>
  {:else}
    <main class="page"><section class="empty-state"><span>404</span><h1>Task not found</h1><p>No lane journal holds this run, or the URL is incomplete.</p><button onclick={backToTasks}>Return to tasks</button></section></main>
  {/if}
{:else if route.view === 'agents'}
  <main class="page">
    <div class="page-heading"><div><p class="eyebrow">Seat composition</p><h1>Agents</h1><p>Create reusable agents, edit their instructions, or start from one already on your system.</p></div></div>
    <AgentsPage />
  </main>
{:else if route.view === 'skills'}
  <main class="page">
    <div class="page-heading"><div><p class="eyebrow">Skill library</p><h1>Skills</h1><p>Create reusable skills, edit instructions and choose when Crew uses them.</p></div></div>
    <SkillsPage />
  </main>
{:else}
  <main class="page">
    <div class="page-heading task-heading"><div><p class="eyebrow">Work history</p><h1>Tasks</h1><p>Find a run, understand its outcome, and inspect the evidence.</p></div><span class="updated">{autoRefresh ? 'Automatic updates enabled' : 'Automatic updates paused'}</span></div>
    {#if attentionRows.length}
      <div class="attention-notice"><div><strong>{attentionSummary.total} runs to review</strong><p>{attentionSummary.text} · unarchived history</p></div><button onclick={focusActivity}>Review tasks →</button></div>
    {/if}
    {#if !lastRead && !error}<p role="status">Loading task history…</p>{:else}<TaskList {runs} {envelopes} {now} onopen={openRun} focus={taskFocus} />{/if}
  </main>
{/if}

</div>

<style>
.auto-refresh { display:flex; align-items:center; gap:.5rem; color:var(--muted); font-size:.75rem; }.auto-refresh input { margin:0; min-height:0; }
.sidebar { position:fixed; inset:0 auto 0 0; width:13.5rem; display:flex; flex-direction:column; gap:1.75rem; padding:1.6rem 1rem; background:var(--panel); border-right:1px solid var(--line); z-index:20; overflow-y:auto; }
.brand { display:flex; align-items:center; gap:.65rem; color:inherit; text-decoration:none; padding:.25rem .6rem; }.brand strong { font-size:1.1rem; font-weight:600; }.brand-mark { display:flex; }
nav { display:flex; flex-direction:column; gap:.25rem; }.nav-label { font-size:.7rem; color:var(--muted); padding:0 .7rem .6rem; }.nav-label:not(:first-child) { margin-top:1.5rem; } nav button { display:flex; align-items:center; gap:.7rem; border:0; border-radius:var(--radius-sm); padding:.65rem .7rem; background:transparent; color:var(--muted); cursor:pointer; text-align:start; font-size:.85rem; }nav button.active { color:var(--accent); background:var(--accent-surface); box-shadow:inset 3px 0 var(--accent); font-weight:650; }
.sidebar-footer { margin-top:auto; display:grid; gap:.65rem; padding:.6rem; }.sidebar-footer small { color:var(--muted); font-size:.7rem; }.connection { font-size:.75rem; }.connection.degraded { color:var(--status-fail); }.theme { display:flex; align-items:center; justify-content:space-between; gap:.5rem; font-size:.75rem; color:var(--muted); }.refresh { display:flex; align-items:center; gap:.5rem; border:1px solid var(--line); border-radius:var(--radius-sm); padding:.4rem .65rem; background:var(--panel); cursor:pointer; font-size:.75rem; }.refresh:disabled { opacity:.6; cursor:wait; }
.workspace { margin-inline-start:13.5rem; min-width:0; }.page { width:min(1440px,100%); margin:auto; padding:2.5rem clamp(1rem,3vw,3rem) 4rem; }.page-heading { display:flex; align-items:end; justify-content:space-between; gap:1rem; margin-bottom:2rem; }.page-heading h1 { margin:.2rem 0 .5rem; font-size:1.65rem; font-weight:600; letter-spacing:-.03em; }.page-heading p { margin:0; color:var(--muted); font-size:.85rem; line-height:1.5; max-width:65ch; }.page-heading .eyebrow { display:none; }.updated { font-size:.7rem; color:var(--muted); }
.attention-notice { display:flex; align-items:center; justify-content:space-between; gap:1rem; flex-wrap:wrap; padding:1rem 1.2rem; margin-bottom:1.25rem; border:1px solid var(--line); border-radius:var(--radius); background:var(--panel); }.attention-notice strong { font-size:.85rem; font-weight:500; }.attention-notice p { margin:.35rem 0 0; color:var(--muted); font-size:.75rem; }.attention-notice button { border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--panel); padding:.4rem .65rem; font-size:.8rem; cursor:pointer; }
.ops-grid { display:grid; gap:1rem; grid-template-columns:repeat(2,minmax(0,1fr)); }.diagnostics { margin-top:2rem; }.diagnostics summary { cursor:pointer; font-size:.9rem; padding:.5rem 0; }.diagnostics > p { color:var(--muted); font-size:.8rem; }
.error-banner { margin:1rem; border:1px solid var(--status-fail); color:var(--status-fail); border-radius:var(--radius); padding:1rem; font-size:.85rem; overflow-wrap:anywhere; }.empty-state { margin:4rem auto; max-width:34rem; text-align:center; }.empty-state p { color:var(--muted); }.empty-state button { padding:.5rem .8rem; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--panel); cursor:pointer; }
.skip-link { position:fixed; inset-block-start:.5rem; inset-inline-start:.5rem; z-index:100; padding:.6rem; background:var(--panel); color:var(--text); transform:translateY(-200%); }.skip-link:focus { transform:none; }
.brand-mark { color:var(--accent); }.attention-notice { border-color:color-mix(in srgb,var(--status-escalated) 30%,var(--line)); border-inline-start:4px solid var(--status-escalated); background:var(--attention-surface); }.attention-notice strong { color:var(--status-escalated); font-size:1rem; font-weight:650; }.attention-notice button { background:var(--accent-solid); border-color:var(--accent-solid); color:var(--on-accent); font-weight:650; }
@media (hover:hover) { nav button:hover,.refresh:hover { background:var(--panel-raised); color:var(--text); } }
@media (max-width:1000px) { .ops-grid { grid-template-columns:1fr; } }
@media (max-width:760px) { .sidebar { position:relative; width:100%; padding:1rem; gap:1rem; border-right:0; border-bottom:1px solid var(--line); overflow:visible; }nav { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:.3rem; }.nav-label { display:none; }nav button { padding:.55rem .3rem; justify-content:center; font-size:.75rem; gap:.35rem; }.sidebar-footer { grid-template-columns:1fr auto; align-items:center; margin:0; padding:0; }.sidebar-footer small { display:none; }.theme { grid-column:1/-1; justify-content:start; }.workspace { margin:0; }.page { padding:1.5rem 1rem 3rem; }.updated { display:none; } }
@media (max-width:420px) { nav { grid-template-columns:repeat(2,minmax(0,1fr)); }nav button { justify-content:start; padding:.5rem; }.page-heading { flex-wrap:wrap; } }
</style>
