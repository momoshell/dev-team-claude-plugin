<script>
  import { planSteps } from './plan-steps.js'

  let { journalState } = $props()
  let view = $derived(planSteps({ ...journalState.payload, error: journalState.error || journalState.payload?.error }))
  let hasError = $derived(Boolean(journalState.error || journalState.payload?.error))
</script>

<section class="plan-view" aria-label="Plan view">
  <header><p class="micro">PLAN VIEW</p><h2>Accepted plan steps</h2></header>
  {#if hasError}
    <p class="muted" role="status">Journal read failed. Reload run detail to retry and verify step evidence.</p>
  {:else if journalState.reads === 0}
    <p class="muted">Loading accepted plan and step events…</p>
  {:else if view.absent}
    <p class="muted" title={view.absent}>Plan unavailable: {view.absent}. Inspect the accepted planner return.</p>
  {:else if view.steps.length === 0}
    <p class="muted">The accepted plan has no valid chunks. Inspect the accepted planner return.</p>
  {:else}
    <div class="step-list">
      {#each view.steps as step (step.id)}
        <article class="step-row">
          <div><strong>{step.id}</strong><span>Checks owned: {Array.isArray(step.checks_owned) ? step.checks_owned.join(', ') : 'Not recorded'}</span></div>
          <span class:muted={step.status === null} title={step.reason || undefined}>{step.status ?? `Unmeasured — ${step.reason}`}</span>
          <span class="rounds" class:muted={step.rounds === null} title={step.rounds === null ? (step.reason || 'no-start-round-recorded') : undefined}>{step.rounds ?? `Unmeasured — ${step.reason || 'no-start-round-recorded'}`}</span>
        </article>
      {/each}
    </div>
    {#if view.unplanned.length}<p class="muted">Unplanned step ids: {view.unplanned.join(', ')}</p>{/if}
  {/if}
</section>

<style>
  .plan-view { background:var(--panel); border:1px solid var(--line); border-radius:.6rem; padding:1rem; margin:1rem 0; }
  .plan-view > header { border-bottom:1px solid var(--line); margin-bottom:.5rem; }
  .plan-view h2 { margin:.25rem 0 .75rem; font-size:1rem; }
  .micro { color:var(--muted); margin:0; font-size:.7rem; }
  .step-row { display:grid; grid-template-columns:minmax(0,2fr) minmax(8rem,1fr) minmax(7rem,.5fr); gap:1rem; padding:.65rem 0; border-top:1px solid var(--line); }
  .step-row > div { display:grid; gap:.25rem; }
  .step-row > div > span, .muted { color:var(--muted); }
  .rounds { font-variant-numeric:tabular-nums; }
  @media (max-width:640px) { .step-row { grid-template-columns:1fr; gap:.35rem; } }
</style>
