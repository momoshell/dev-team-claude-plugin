<script>
  import { stepTimeline } from './plan-steps.js'

  let { journalState } = $props()
  let view = $derived(stepTimeline({ ...journalState.payload, error: journalState.error || journalState.payload?.error }))
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
    {#if view.degraded.value === true}<aside class="degradation" role="status">Lane degradation · {view.degraded.reason || 'Source reason not recorded'} · step {view.degraded.step ?? 'Unmeasured — degrade-step-not-recorded'} · remaining {view.degraded.remaining?.join(', ') ?? 'Unmeasured — degrade-remaining-not-recorded'} · budget {view.degraded.budget ?? 'Unmeasured — degrade-budget-not-recorded'}</aside>{/if}
    <ol class="step-timeline">
      {#each view.steps as step (step.id)}
        <li aria-current={step.state === 'active' ? 'step' : undefined} class={`tone-${step.tone}`}>
          <article class="step-card">
            <header><strong>{step.id}</strong><span title={step.reason || undefined}>{step.state ?? `Unmeasured — ${step.reason}`}</span></header>
            <p class:dashed={step.intent == null} title={step.intent_reason || undefined}>{step.intent == null ? `Unmeasured — ${step.intent_reason}` : step.intent}</p>
            <dl><dt>Files</dt><dd class:dashed={step.files == null} title={step.files_reason || undefined}>{step.files?.join(', ') ?? `Unmeasured — ${step.files_reason}`}</dd><dt>Dependencies</dt><dd class:dashed={step.depends_on == null} title={step.depends_on_reason || undefined}>{step.depends_on?.join(', ') ?? `Unmeasured — ${step.depends_on_reason}`}</dd></dl>
            <div class="checks"><strong>Checks</strong>{#if step.checks}{#each step.checks as check (check.id)}<span class={`tone-${check.tone}`} title={check.reason || undefined}>{check.id}: {check.result ?? `Unmeasured — ${check.reason}`}{#if check.regressed} · regressed{/if}</span>{/each}{:else}<span class="dashed">Unmeasured — {step.checks_reason}</span>{/if}</div>
            {#if step.rounds === null}<p class="dashed" title={step.reason || undefined}>Unmeasured — {step.reason}</p>{:else}
              {#each step.rounds as round, i (i)}
                <section class="round"><strong>Round {round.round} · {round.outcome ?? `Unmeasured — ${round.reason}`}</strong>{#if round.bounce_status}<span>Bounce status · {round.bounce_status}</span>{/if}
                  <span class:dashed={round.failed == null} title={round.failed_reason || undefined}>Failed · {round.failed?.join(', ') ?? `Unmeasured — ${round.failed_reason}`}</span><span class:dashed={round.regressed == null} title={round.regressed_reason || undefined}>Regressed · {round.regressed?.join(', ') ?? `Unmeasured — ${round.regressed_reason}`}</span>
                  <span class:dashed={round.duration_ms == null} title={round.duration_reason || undefined}>Duration · {round.duration_ms ?? `Unmeasured — ${round.duration_reason}`}</span><span class:dashed={round.turns == null} title={round.turns_reason || undefined}>Turns · {round.turns ?? `Unmeasured — ${round.turns_reason}`}</span><span class="dashed" title={round.cost_reason}>Cost · Unmeasured — {round.cost_reason}</span>
                </section>
              {/each}
            {/if}
            {#if step.escalation}<small>Escalation · {step.escalation}</small>{/if}
          </article>
        </li>
      {/each}
    </ol>
    {#if view.unplanned.length}<p class="muted">Unplanned step ids: {view.unplanned.join(', ')}</p>{/if}
  {/if}
</section>

<style>
  .plan-view { background:var(--panel); border:1px solid var(--line); border-radius:.6rem; padding:1rem; margin:1rem 0; }
  .plan-view > header { border-bottom:1px solid var(--line); margin-bottom:.75rem; }
  .plan-view h2 { margin:.25rem 0 .75rem; font-size:1rem; }
  .micro { color:var(--muted); margin:0; font-size:.7rem; }
  .step-timeline { list-style:none; margin:0; padding:.25rem 0 .25rem 1rem; border-inline-start:1px solid var(--line); display:grid; gap:.75rem; }
  .step-timeline li { min-width:0; }
  .step-card { min-width:0; background:var(--panel); border:1px solid var(--line); border-radius:.6rem; padding:.75rem; }
  .step-card > header { display:flex; justify-content:space-between; gap:1rem; }
  .step-card p { margin:.5rem 0; }
  dl { display:grid; grid-template-columns:auto minmax(0,1fr); gap:.35rem .75rem; margin:.5rem 0; }
  dd { margin:0; overflow-wrap:anywhere; }
  .checks,.round { display:flex; flex-wrap:wrap; gap:.5rem; margin-top:.5rem; }
  .round { background:var(--bg); border-top:1px solid var(--line); padding:.5rem; font-variant-numeric:tabular-nums; }
  .round span { overflow-wrap:anywhere; }
  .degradation { border:1px solid var(--line); padding:.5rem; margin-bottom:.75rem; overflow-wrap:anywhere; }
  .muted { color:var(--muted); }
  .dashed { color:var(--muted); text-decoration:underline dashed; text-underline-offset:.2em; }
  .tone-ok { color:var(--status-ok); } .tone-busy { color:var(--status-running); } .tone-fail { color:var(--status-fail); } .tone-serious { color:var(--status-escalated); } .tone-muted { color:var(--muted); }
  @media (max-width:640px) { .step-card > header { flex-wrap:wrap; } }
</style>
