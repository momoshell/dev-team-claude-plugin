<script>
  import { getJournal, getSeatSessions } from './api.js'
  import { leanView } from './lean.js'
  import { journalPulse } from './live.js'

  let { run, onback = () => {} } = $props()
  let journal = $state(null)
  let journalError = $state('')
  let role = $state('')
  let sessions = $state({ sessions: [], absent: null, error: '' })
  let journalGeneration = 0
  let sessionGeneration = 0

  let view = $derived(leanView(run, journal))
  let activeRole = $derived(role || view.seats[0]?.role || '')

  async function loadJournal() {
    const generation = ++journalGeneration
    const lane = run.goal
    try {
      const result = await getJournal(run.repo_slug, run.goal, run.adw_id)
      if (generation !== journalGeneration || lane !== run.goal) return
      journal = result; journalError = result?.error ?? ''
    } catch (err) { if (generation === journalGeneration) journalError = err.message || 'journal request failed' }
  }
  async function loadSessions(name) {
    const generation = ++sessionGeneration
    if (!name) { sessions = { sessions: [], absent: 'no seats recorded', error: '' }; return }
    try {
      const result = await getSeatSessions(run.repo_slug, run.goal, run.adw_id, name)
      if (generation === sessionGeneration) sessions = { sessions: result.sessions ?? [], absent: result.absent ?? null, error: '' }
    } catch (err) { if (generation === sessionGeneration) sessions = { sessions: [], absent: null, error: err.message || 'session request failed' } }
  }
  $effect(() => { void run.adw_id; journal = null; void loadJournal() })
  $effect(() => { void run.adw_id; void activeRole; void loadSessions(activeRole) })
  $effect(() => journalPulse.subscribe(() => { void loadJournal(); void loadSessions(activeRole) }))
</script>

<main class="page lean">
  <button type="button" class="back" onclick={onback}>← Tasks</button>
  <h1>{view.lane}</h1>
  <p class="status">{view.status.word}{#if view.status.why} · {view.status.why}{/if}</p>
  <p>Latest stage: <strong>{view.stage ?? '—'}</strong>{#if view.stageReason} <small>({view.stageReason})</small>{/if}</p>
  {#if view.pr}<p>Pull request recorded: {view.pr.url ?? `#${view.pr.number}`} (merge state not recorded)</p>{/if}
  <section><h2>Journal</h2>
    {#if journalError}<p role="alert">{journalError}</p>{/if}
    <ol>{#each view.lines as line (line.index)}<li><code>{line.event}</code> {line.stage} {#if line.detail}— {line.detail}{/if}</li>{:else}<li>{journal ? 'no rows recorded' : 'loading…'}</li>{/each}</ol>
  </section>
  <section><h2>Seats</h2>
    <div role="group" aria-label="Seat role">{#each view.seats as seat (seat.role)}<button type="button" aria-pressed={activeRole === seat.role} onclick={() => role = seat.role}>{seat.role}</button>{/each}</div>
    {#if sessions.error}<p role="alert">{sessions.error}</p>{/if}
    {#if sessions.absent}<p>{sessions.absent}</p>{/if}
    {#each sessions.sessions as session (session.file)}<details><summary>{session.file}</summary><pre>{session.raw}</pre></details>{/each}
  </section>
  <section><h2>Not recorded</h2>
    <ul>{#each view.pending as item (item.field)}<li><code>{item.field}</code>: {item.reason}</li>{/each}</ul>
  </section>
</main>

<style>
.lean pre { white-space:pre-wrap; overflow-wrap:anywhere; max-height:24rem; overflow:auto; font-size:.72rem; }.lean section { margin-top:1.5rem; }.lean button { cursor:pointer; margin-inline-end:.4rem; }.lean [aria-pressed='true'] { font-weight:700; }.back { border:0; background:transparent; }
</style>
