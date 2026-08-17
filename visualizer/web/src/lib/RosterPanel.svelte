<script>
  import { composeRosterLadder, getRosterLadder, stageRosterLadder } from './api.js'

  const CHECK_NAMES = ['band_floor', 'vendor_diversity', 'breaker_state', 'cost_ceiling']
  let payload = $state(null)
  let loading = $state(true)
  let requestError = $state('')
  let staged = $state([])
  let stagedResult = $state(null)
  let attemptResult = $state(null)
  let composed = $state(null)
  let staging = $state(false)
  let composing = $state(false)

  function modelKey(cell) {
    return cell?.provider != null && cell?.id != null ? `${cell.provider}/${cell.id}` : null
  }

  function projectRail(baseRail, moves) {
    return baseRail.map((column) => {
      const tierMoves = moves.filter((move) => move.tier === column.tier)
      if (!tierMoves.length) return column
      const seats = new Map((column.seats || []).map((seat) => [seat.role, { ...seat }]))
      const unseated = new Set(column.unseated || [])
      for (const move of tierMoves) {
        seats.delete(move.role)
        unseated.delete(move.role)
        if (move.cell === null) unseated.add(move.role)
        else seats.set(move.role, { role: move.role, model_key: modelKey(move.cell), cell: { ...move.cell } })
      }
      return { ...column, seats: [...seats.values()], unseated: [...unseated] }
    })
  }

  let rail = $derived(projectRail(payload?.rail || [], staged))
  let visibleResult = $derived(attemptResult || stagedResult)

  $effect(() => {
    let active = true
    getRosterLadder().then((result) => {
      if (!active) return
      payload = result
      requestError = ''
      loading = false
    }).catch((err) => {
      if (!active) return
      requestError = err.message || 'roster ladder request failed'
      payload = { degraded: true, error: requestError, bands: null, chips: null, rail: null }
      loading = false
    })
    return () => { active = false }
  })

  function chipFor(key) {
    return payload?.chips?.find((chip) => chip.key === key) || null
  }

  function dragStart(event, chip) {
    event.dataTransfer?.setData('text/plain', chip.key)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  }

  function sourceCell(chip, target) {
    const source = rail.flatMap((column) => column.seats || []).find((seat) => seat.model_key === chip.key)?.cell
    const current = target?.cell
    const base = source || current || { agent: 'pi', effort: 'medium' }
    return { provider: chip.provider, id: chip.id, agent: base.agent || 'pi', effort: base.effort || 'medium' }
  }

  async function drop(event, tier, role) {
    event.preventDefault()
    const key = event.dataTransfer?.getData('text/plain')
    const chip = chipFor(key)
    if (!chip || !chip.id) return
    const move = { tier, role, cell: sourceCell(chip, rail.find((column) => column.tier === tier)?.seats?.find((seat) => seat.role === role)) }
    const next = [...staged.filter((candidate) => !(candidate.tier === tier && candidate.role === role)), move]
    staging = true
    composed = null
    try {
      const result = await stageRosterLadder(next)
      attemptResult = result
      if (result.ok) {
        staged = next
        stagedResult = result
      }
    } catch (err) {
      requestError = err.message || 'roster ladder staging failed'
    } finally {
      staging = false
    }
  }

  async function compose() {
    if (!stagedResult?.ok) return
    composing = true
    requestError = ''
    try {
      composed = await composeRosterLadder(staged)
    } catch (err) {
      requestError = err.message || 'roster ladder compose failed'
      composed = null
    } finally {
      composing = false
    }
  }
</script>
<section class="panel">
  <h2>Roster ladder</h2>
  {#if loading}
    <p class="muted">loading roster ladder…</p>
  {:else if payload?.degraded}
    <p class="muted">{payload.error || requestError || 'roster ladder is unavailable'}</p>
  {:else}
    <p class="meta">{payload.path} · ratified {payload.ratified_at || '—'} by {payload.ratified_by || '—'} · measured {payload.measured_window?.label || 'window unavailable'}</p>
    <section class="bands">
      <h3>Ratified capability bands</h3>
      {#each payload.bands || [] as band (band.band)}
        <article class="band">
          <h4>{band.band} · floor reference {band.floor_reference_score}</h4>
          <p class="meta">ratified {payload.ratified_at || '—'} by {payload.ratified_by || '—'}</p>
          <div class="chips">
            {#each band.members as key (key)}
              {@const chip = chipFor(key)}
              {#if chip}{@render chipCard(chip)}{/if}
            {/each}
          </div>
        </article>
      {/each}
    </section>
    <section class="catalog">
      <h3>Model axes</h3>
      <div class="chips">
        {#each payload.chips || [] as chip (chip.key)}{@render chipCard(chip)}{/each}
      </div>
    </section>
    <section class="rail">
      <h3>Seats rail</h3>
      <div class="rail-grid">
        {#each rail as column (column.tier)}
          <article class="tier">
            <h4>{column.tier}</h4>
            <p class="meta">floor {column.floor_band || '—'} · ceiling {column.cost_ceiling_out_per_mtok ?? '—'} out/Mtok</p>
            {#each column.seats || [] as seat (seat.role)}
              <div class="drop" role="button" tabindex="0" ondragover={(event) => event.preventDefault()} ondrop={(event) => drop(event, column.tier, seat.role)}>{seat.role}: {seat.model_key || 'unseated'}</div>
            {/each}
            {#each column.unseated || [] as role (role)}
              <div class="drop" role="button" tabindex="0" ondragover={(event) => event.preventDefault()} ondrop={(event) => drop(event, column.tier, role)}>{role}: unseated</div>
            {/each}
          </article>
        {/each}
      </div>
    </section>
    {#if visibleResult}
      <section class="staged">
        <h3>Staged result</h3>
        <ul class="checks">
          {#each visibleResult.checks || [] as check (check.check)}
            <li class:pass={check.ok} class:fail={!check.ok}><strong>{check.check}</strong> · {check.ok ? 'pass' : 'fail'} — {check.message}</li>
          {/each}
        </ul>
        {#if visibleResult.refusals?.length}
          <ul class="refusals">{#each visibleResult.refusals as refusal (refusal.code + refusal.message)}<li>{refusal.message}</li>{/each}</ul>
        {/if}
        {#if visibleResult.diff !== null}<pre>{visibleResult.diff || '(no roster change)'}</pre>{/if}
        <button type="button" disabled={!stagedResult?.ok || staging || composing} onclick={compose}>{composing ? 'Composing…' : 'Compose PR-ready bundle'}</button>
      </section>
    {/if}
    {#if composed?.ok}
      <section class="composed">
        <p><strong>{composed.branch}</strong> · {composed.commit_subject}</p>
        <pre>{composed.patch}</pre>
        <p class="muted">PR-ready patch only; the live roster was not written.</p>
      </section>
    {/if}
    {#if requestError}<p class="error">{requestError}</p>{/if}
  {/if}
</section>
{#snippet chipCard(chip)}
  <div class="chip" role="button" tabindex="0" draggable="true" ondragstart={(event) => dragStart(event, chip)}>
    <strong>{chip.key}</strong>
    {#if chip.drift}<span class="drift" title={chip.drift.why}>drift: {chip.drift.proposed || 'none'}</span>{/if}
    <span class="axis"><b>reference</b>{chip.reference ?? chip.reference_pending}</span>
    <span class="axis"><b>measured</b>{chip.measured ? `${chip.measured.failures} failures · ${chip.measured.run_less} run-less · ${chip.measured.in_run} in-run · ${chip.measured.cells} cells` : chip.measured_pending}</span>
    <span class="meta">cost out/Mtok: {chip.cost_out_per_mtok ?? chip.cost_pending}</span>
  </div>
{/snippet}
<style>.panel { background:var(--panel); border:1px solid var(--line); padding:1rem; }.panel h2 { margin-top:0; }.meta, .muted { color:var(--muted); }.bands, .catalog, .rail, .staged { border-top:1px solid var(--line); margin-top:1rem; padding-top:.75rem; }.band { border-top:1px solid var(--line); padding:.5rem 0; }.band h4, .tier h4 { margin:.1rem 0 .25rem; }.chips { display:grid; gap:.5rem; grid-template-columns:repeat(auto-fit,minmax(16rem,1fr)); }.chip { background:var(--bg); border:1px solid var(--line); padding:.55rem; display:grid; gap:.25rem; cursor:grab; }.axis { display:flex; gap:.45rem; justify-content:space-between; }.axis b { color:var(--accent); }.drift { color:var(--status-escalated); }.rail-grid { display:grid; gap:.75rem; grid-template-columns:repeat(auto-fit,minmax(12rem,1fr)); }.tier { border:1px solid var(--line); padding:.5rem; }.drop { border:1px dashed var(--line); margin-top:.4rem; padding:.5rem; min-height:2rem; }.checks, .refusals { padding-left:1.25rem; }.pass { color:var(--status-ok); }.fail, .error { color:var(--status-fail); }pre { background:var(--bg); border:1px solid var(--line); max-height:20rem; overflow:auto; padding:.75rem; white-space:pre-wrap; }button { background:var(--accent); border:1px solid var(--line); color:var(--panel); cursor:pointer; padding:.5rem .75rem; }button:disabled { cursor:not-allowed; opacity:.55; }</style>
