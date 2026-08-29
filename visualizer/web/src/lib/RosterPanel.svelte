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
  let selectedModel = $state(null)
  let staging = $state(false)
  let composing = $state(false)

  function modelKey(cell) { return cell?.provider != null && cell?.id != null ? `${cell.provider}/${cell.id}` : null }
  function projectRail(baseRail, moves) {
    return baseRail.map((column) => {
      const tierMoves = moves.filter((move) => move.tier === column.tier)
      if (!tierMoves.length) return column
      const seats = new Map((column.seats || []).map((seat) => [seat.role, { ...seat }]))
      const unseated = new Set(column.unseated || [])
      for (const move of tierMoves) {
        seats.delete(move.role); unseated.delete(move.role)
        if (move.cell === null) unseated.add(move.role)
        else seats.set(move.role, { role: move.role, model_key: modelKey(move.cell), cell: { ...move.cell } })
      }
      return { ...column, seats: [...seats.values()], unseated: [...unseated] }
    })
  }
  let rail = $derived(projectRail(payload?.rail || [], staged))
  let visibleResult = $derived(attemptResult || stagedResult)
  let seatCount = $derived(rail.reduce((sum, tier) => sum + (tier.seats?.length || 0), 0))
  let uniqueModels = $derived(new Set(rail.flatMap((tier) => tier.seats || []).map((seat) => seat.model_key).filter(Boolean)).size)

  $effect(() => {
    let active = true
    getRosterLadder().then((result) => { if (active) { payload = result; requestError = ''; loading = false } }).catch((err) => {
      if (!active) return
      requestError = err.message || 'roster ladder request failed'
      payload = { degraded: true, error: requestError, bands: null, chips: null, rail: null }
      loading = false
    })
    return () => { active = false }
  })

  function chipFor(key) { return payload?.chips?.find((chip) => chip.key === key) || null }
  function modelName(key) { return String(key || '').split('/').at(-1) || 'Unassigned' }
  function provider(key) { return String(key || '').split('/')[0] || 'none' }
  function providerMark(key) { return provider(key).slice(0, 2).toUpperCase() }
  function roleColor(role) { return `var(--${role}-color)` }
  function sourceCell(chip, target) {
    const source = rail.flatMap((column) => column.seats || []).find((seat) => seat.model_key === chip.key)?.cell
    const base = source || target?.cell || { agent:'pi', effort:'medium' }
    return { provider:chip.provider, id:chip.id, agent:base.agent || 'pi', effort:base.effort || 'medium' }
  }
  async function move(tier, role, key) {
    const chip = chipFor(key)
    if (!chip?.id) return
    const target = rail.find((column) => column.tier === tier)?.seats?.find((seat) => seat.role === role)
    const next = [...staged.filter((candidate) => !(candidate.tier === tier && candidate.role === role)), { tier, role, cell:sourceCell(chip, target) }]
    staging = true; composed = null
    try {
      const result = await stageRosterLadder(next)
      attemptResult = result
      if (result.ok) { staged = next; stagedResult = result }
    } catch (err) { requestError = err.message || 'roster ladder staging failed' } finally { staging = false }
  }
  function drop(event, tier, role) { event.preventDefault(); move(tier, role, event.dataTransfer?.getData('text/plain')) }
  function dragStart(event, chip) { event.dataTransfer?.setData('text/plain', chip.key); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move' }
  async function compose() {
    if (!stagedResult?.ok) return
    composing = true; requestError = ''
    try { composed = await composeRosterLadder(staged) } catch (err) { requestError = err.message || 'roster ladder compose failed'; composed = null } finally { composing = false }
  }
</script>

{#if loading}
  <section class="loading"><span></span><p>Loading the ratified roster…</p></section>
{:else if payload?.degraded}
  <section class="notice"><strong>Roster unavailable</strong><p>{payload.error || requestError || 'The roster ladder could not be read.'}</p></section>
{:else}
  <section class="roster-shell">
    <div class="roster-summary">
      <article><span>Tiers</span><strong>{rail.length}</strong></article>
      <article><span>Active seats</span><strong>{seatCount}</strong></article>
      <article><span>Models in use</span><strong>{uniqueModels}</strong></article>
      <article><span>Ratified</span><strong class="date">{payload.ratified_at || '—'}</strong><small>{payload.ratified_by || 'owner unavailable'}</small></article>
      <p>Health evidence covers <strong>{payload.measured_window?.label || 'an unavailable window'}</strong>. A failure count is evidence about recent operation, not a model ranking.</p>
    </div>

    <div class="tier-grid">
      {#each rail as column, tierIndex (column.tier)}
        <article class="tier-card" style={`--tier-index:${tierIndex}`}>
          <header><div><p class="micro">Tier {tierIndex + 1}</p><h2>{column.tier}</h2></div><span class="floor">{column.floor_band || 'no'} floor</span></header>
          <p class="tier-note">Up to ${column.cost_ceiling_out_per_mtok ?? '—'} output / Mtok</p>
          <div class="seats">
            {#each column.seats || [] as seat (seat.role)}
              {@const health = chipFor(seat.model_key)?.measured}
              <button type="button" class="seat" class:changeable={selectedModel} onclick={() => selectedModel && move(column.tier, seat.role, selectedModel)} ondragover={(event) => event.preventDefault()} ondrop={(event) => drop(event, column.tier, seat.role)}>
                <span class="role"><i style={`--seat-color:${roleColor(seat.role)}`}></i>{seat.role}</span>
                <span class="model"><b class={`provider ${provider(seat.model_key)}`}>{providerMark(seat.model_key)}</b><span><strong>{modelName(seat.model_key)}</strong><small>{seat.cell?.agent || 'agent —'} · {seat.cell?.effort || 'effort —'}</small></span></span>
                {#if health?.failures > 0}<span class="health warn" title={`${health.failures} measured failures across ${health.cells} cells`}>{health.failures} recent failure{health.failures === 1 ? '' : 's'}</span>{:else}<span class="health">No recent failures</span>{/if}
              </button>
            {/each}
            {#each column.unseated || [] as role (role)}
              <button type="button" class="seat empty" class:changeable={selectedModel} onclick={() => selectedModel && move(column.tier, role, selectedModel)} ondragover={(event) => event.preventDefault()} ondrop={(event) => drop(event, column.tier, role)}><span class="role"><i style={`--seat-color:${roleColor(role)}`}></i>{role}</span><span>Unassigned</span></button>
            {/each}
          </div>
        </article>
      {/each}
    </div>

    <section class="bands">
      <header><div><p class="micro">Capability policy</p><h2>Model bands</h2></div><p>Ratified capability ceiling and everyday operating bands.</p></header>
      <div class="band-list">
        {#each payload.bands || [] as band (band.band)}
          <article class={`band ${band.band}`}><span class="band-name"><b>{band.band}</b><small>reference floor {band.floor_reference_score}</small></span><div>{#each band.members as key (key)}<span class="model-pill"><b class={`provider ${provider(key)}`}>{providerMark(key)}</b>{modelName(key)}</span>{/each}</div></article>
        {/each}
      </div>
    </section>

    <details class="studio">
      <summary><span><strong>Plan a roster change</strong><small>Stage a validated change and compose a PR-ready patch. Nothing writes the live roster.</small></span><b>Open studio</b></summary>
      <div class="studio-body">
        <div class="studio-heading"><div><h3>Choose a model, then choose its seat</h3><p>Click or drag a model onto a seat. Existing agent and effort settings are preserved.</p></div>{#if selectedModel}<button type="button" class="clear" onclick={() => selectedModel = null}>Clear selection</button>{/if}</div>
        <div class="model-palette">
          {#each payload.chips || [] as chip (chip.key)}
            <button type="button" class:selected={selectedModel === chip.key} draggable="true" ondragstart={(event) => dragStart(event, chip)} onclick={() => selectedModel = selectedModel === chip.key ? null : chip.key}><b class={`provider ${provider(chip.key)}`}>{providerMark(chip.key)}</b><span><strong>{modelName(chip.key)}</strong><small>${chip.cost_out_per_mtok ?? '—'} output / Mtok · {chip.reference ?? chip.reference_pending}</small>{#if chip.measured}<small>{chip.measured.failures} failures · {chip.measured.cells} cells measured</small>{:else}<small>{chip.measured_pending}</small>{/if}{#if chip.drift}<small class="drift">Drift: {chip.drift.proposed || chip.drift.why}</small>{/if}</span></button>
          {/each}
        </div>
        {#if selectedModel}<p class="selection">Selected <strong>{modelName(selectedModel)}</strong>. Choose any seat above to stage it.</p>{/if}
        {#if visibleResult}
          <section class="validation"><header><h3>Validation</h3><span class:pass={visibleResult.ok} class:fail={!visibleResult.ok}>{visibleResult.ok ? 'Ready to compose' : 'Change refused'}</span></header>
            <ul>{#each CHECK_NAMES.map((name) => visibleResult.checks?.find((check) => check.check === name)).filter(Boolean) as check (check.check)}<li class:pass={check.ok} class:fail={!check.ok}><b>{check.ok ? '✓' : '×'}</b><span><strong>{check.check.replaceAll('_',' ')}</strong><small>{check.message}</small></span></li>{/each}</ul>
            {#if visibleResult.refusals?.length}<div class="refusals">{#each visibleResult.refusals as refusal (refusal.code + refusal.message)}<p>{refusal.message}</p>{/each}</div>{/if}
            {#if visibleResult.diff !== null}<details class="diff"><summary>Preview unified diff</summary><pre>{visibleResult.diff || '(no roster change)'}</pre></details>{/if}
            <button class="compose" type="button" disabled={!stagedResult?.ok || staging || composing} onclick={compose}>{composing ? 'Composing…' : 'Compose PR-ready bundle'}</button>
          </section>
        {/if}
        {#if composed?.ok}<section class="bundle"><h3>PR-ready bundle</h3><p><strong>{composed.branch}</strong> · {composed.commit_subject}</p><pre>{composed.patch}</pre><small>The live roster was not changed.</small></section>{/if}
        {#if requestError}<p class="error">{requestError}</p>{/if}
      </div>
    </details>
  </section>
{/if}

<style>
.loading,.notice { min-height:16rem; display:grid; place-content:center; justify-items:center; border:1px solid var(--line); border-radius:var(--radius-lg); background:var(--panel); color:var(--muted); }.loading span { width:1.6rem; height:1.6rem; border:2px solid var(--line); border-top-color:var(--accent); border-radius:50%; animation:spin .8s linear infinite; }@keyframes spin{to{transform:rotate(360deg)}}
.notice strong { color:var(--status-fail); }.notice p { margin:.4rem 0; }
.roster-shell { display:grid; gap:1rem; }.roster-summary { display:grid; grid-template-columns:repeat(4,minmax(7rem,1fr)) minmax(18rem,2fr); border:1px solid var(--line); border-radius:var(--radius-lg); background:color-mix(in srgb,var(--panel) 94%,transparent); overflow:hidden; }
.roster-summary article { display:grid; gap:.35rem; padding:1rem; border-right:1px solid var(--line); }.roster-summary article span { color:var(--muted); font-size:.65rem; text-transform:uppercase; letter-spacing:.08em; }.roster-summary article strong { font:600 1.5rem/1 var(--mono); }.roster-summary article .date { font-size:.92rem; }.roster-summary article small { color:var(--muted); font-size:.68rem; }.roster-summary > p { align-self:center; margin:0; padding:1rem; color:var(--muted); font-size:.76rem; line-height:1.5; }.roster-summary > p strong { color:inherit; }
.tier-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:.8rem; }.tier-card { position:relative; overflow:hidden; border:1px solid var(--line); border-radius:var(--radius-lg); background:color-mix(in srgb,var(--panel) 95%,transparent); padding:1rem; box-shadow:var(--shadow); }.tier-card::before { content:''; position:absolute; inset:0 auto 0 0; width:2px; background:var(--planner-color); }.tier-card:nth-child(2)::before { background:var(--builder-color); }.tier-card:nth-child(3)::before { background:var(--tech-lead-color); }
.tier-card > header { display:flex; align-items:start; justify-content:space-between; gap:1rem; }.micro { margin:0 0 .25rem; color:var(--muted); }.tier-card h2 { margin:0; text-transform:capitalize; font-size:1.2rem; }.floor { border:1px solid var(--line); border-radius:1rem; padding:.25rem .5rem; color:var(--muted); font-size:.67rem; text-transform:capitalize; }.tier-note { margin:.35rem 0 .9rem; color:var(--muted); font-size:.7rem; }
.seats { display:grid; gap:.45rem; }.seat { width:100%; display:grid; grid-template-columns:5.5rem minmax(0,1fr) auto; align-items:center; gap:.65rem; min-height:4rem; border:1px solid var(--line); border-radius:var(--radius); background:var(--panel-raised); padding:.65rem; text-align:left; }.seat.changeable { cursor:copy; border-style:dashed; }.seat.changeable:hover { border-color:var(--accent); background:var(--accent-soft); }.role { display:flex; align-items:center; gap:.4rem; color:var(--muted); font-size:.68rem; text-transform:capitalize; }.role i { width:.42rem; height:.42rem; border-radius:50%; background:var(--seat-color); box-shadow:0 0 7px color-mix(in srgb,var(--seat-color) 60%,transparent); }.model { display:flex; align-items:center; gap:.55rem; min-width:0; }.model > span { min-width:0; display:grid; gap:.16rem; }.model strong { font-size:.78rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.model small,.health { color:var(--muted); font-size:.62rem; }.provider { display:grid; place-content:center; flex:0 0 auto; width:1.7rem; height:1.7rem; border:1px solid var(--line); border-radius:.45rem; background:var(--bg); color:var(--muted); font:700 .58rem/1 var(--mono); }.provider.openai { color:var(--builder-color); }.provider.anthropic { color:var(--tech-lead-color); }.health { text-align:right; white-space:nowrap; }.health.warn { color:var(--status-escalated); }.seat.empty { color:var(--muted); border-style:dashed; }
.bands { border:1px solid var(--line); border-radius:var(--radius-lg); background:var(--panel); overflow:hidden; }.bands > header { display:flex; justify-content:space-between; align-items:end; gap:1rem; padding:1rem; border-bottom:1px solid var(--line); }.bands h2 { margin:.15rem 0 0; font-size:1.05rem; }.bands header > p { margin:0; color:var(--muted); font-size:.72rem; }.band { display:grid; grid-template-columns:9rem 1fr; align-items:center; min-height:4.25rem; border-top:1px solid var(--line); }.band:first-child { border-top:0; }.band-name { align-self:stretch; display:grid; align-content:center; gap:.2rem; padding:.8rem 1rem; border-right:1px solid var(--line); text-transform:capitalize; }.band-name b { font-size:.82rem; }.band-name small { color:var(--muted); font-size:.6rem; }.band > div { display:flex; flex-wrap:wrap; gap:.45rem; padding:.75rem; }.model-pill { display:inline-flex; align-items:center; gap:.45rem; border:1px solid var(--line); border-radius:2rem; background:var(--panel-raised); padding:.3rem .6rem .3rem .35rem; font:600 .7rem/1 var(--mono); }.model-pill .provider { width:1.35rem; height:1.35rem; border-radius:50%; }.frontier .band-name { box-shadow:inset 3px 0 var(--lead-color); }.workhorse .band-name { box-shadow:inset 3px 0 var(--tech-lead-color); }.utility .band-name { box-shadow:inset 3px 0 var(--reviewer-color); }.basement .band-name { box-shadow:inset 3px 0 var(--muted); }
.studio { border:1px solid var(--line); border-radius:var(--radius-lg); background:var(--panel); overflow:hidden; }.studio > summary { display:flex; justify-content:space-between; align-items:center; gap:1rem; padding:1rem; cursor:pointer; list-style:none; }.studio > summary::-webkit-details-marker { display:none; }.studio > summary span { display:grid; gap:.2rem; }.studio > summary strong { font-size:.85rem; }.studio > summary small { color:var(--muted); font-size:.7rem; }.studio > summary > b { border:1px solid var(--line); border-radius:var(--radius-sm); padding:.45rem .65rem; font-size:.7rem; }.studio[open] > summary { border-bottom:1px solid var(--line); }.studio-body { padding:1rem; }.studio-heading { display:flex; justify-content:space-between; gap:1rem; }.studio-heading h3 { margin:0 0 .2rem; }.studio-heading p { margin:0; color:var(--muted); font-size:.76rem; }.clear { border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--panel-raised); cursor:pointer; }
.model-palette { display:grid; grid-template-columns:repeat(auto-fit,minmax(12rem,1fr)); gap:.5rem; margin:1rem 0; }.model-palette button { display:flex; align-items:center; gap:.55rem; border:1px solid var(--line); border-radius:var(--radius); background:var(--panel-raised); padding:.55rem; text-align:left; cursor:grab; }.model-palette button.selected { border-color:var(--accent); background:var(--accent-soft); }.model-palette button > span { display:grid; gap:.1rem; }.model-palette strong { font-size:.72rem; }.model-palette small { color:var(--muted); font-size:.6rem; }.selection { color:var(--accent); font-size:.76rem; }
.validation,.bundle { margin-top:1rem; border-top:1px solid var(--line); padding-top:1rem; }.validation header { display:flex; align-items:center; justify-content:space-between; }.validation h3,.bundle h3 { margin:.1rem 0; }.validation header span { font-size:.7rem; }.validation ul { display:grid; grid-template-columns:repeat(auto-fit,minmax(14rem,1fr)); gap:.5rem; padding:0; list-style:none; }.validation li { display:flex; align-items:start; gap:.45rem; border:1px solid var(--line); border-radius:var(--radius-sm); padding:.55rem; }.validation li span { display:grid; gap:.15rem; }.validation li strong { font-size:.7rem; text-transform:capitalize; }.validation li small { color:var(--muted); font-size:.62rem; }.pass { color:var(--status-ok); }.fail,.error { color:var(--status-fail); }.diff { margin:.7rem 0; }.diff summary { color:var(--muted); cursor:pointer; font-size:.75rem; }.diff pre,.bundle pre { max-height:20rem; overflow:auto; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--bg); padding:.75rem; white-space:pre-wrap; font-size:.68rem; }.compose { border:1px solid var(--accent); border-radius:var(--radius-sm); background:var(--accent); color:var(--bg); padding:.55rem .75rem; cursor:pointer; }.compose:disabled { opacity:.45; cursor:not-allowed; }.bundle small { color:var(--muted); }
@media (max-width: 1100px) { .roster-summary { grid-template-columns:repeat(4,1fr); }.roster-summary > p { grid-column:1/-1; border-top:1px solid var(--line); }.tier-grid { grid-template-columns:1fr; }.seat { grid-template-columns:7rem minmax(0,1fr) auto; } }
@media (max-width: 620px) { .roster-summary { grid-template-columns:repeat(2,1fr); }.roster-summary article:nth-child(2) { border-right:0; }.seat { grid-template-columns:5rem minmax(0,1fr); }.health { grid-column:2; text-align:left; }.bands > header { align-items:start; }.bands header > p { display:none; }.band { grid-template-columns:1fr; }.band-name { border-right:0; border-bottom:1px solid var(--line); }.studio > summary > b { display:none; } }
</style>
