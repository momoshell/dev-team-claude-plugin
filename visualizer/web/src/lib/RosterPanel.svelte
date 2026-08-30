<script>
  import { composeRosterLadder, getModelCatalog, getRosterLadder, setModelCatalogKey, stageRosterLadder } from './api.js'
  import { directoryVariantLabel, groupDirectoryModels, selectedDirectoryVariant } from './model-directory.js'
  import Dropdown from './Dropdown.svelte'

  const CHECK_NAMES = ['band_floor', 'vendor_diversity', 'breaker_state', 'cost_ceiling']
  const DRAFT_KEY = 'dev-team.roster-draft.v1'
  const DIRECTORY_SORTS = [
    { value:'intelligence', label:'Intelligence' }, { value:'coding', label:'Coding' },
    { value:'agentic', label:'Agentic' }, { value:'price_output', label:'Lowest output price' },
    { value:'output_tokens_per_second', label:'Output speed' },
  ]

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
  let customModels = $state([])
  let draftReady = $state(false)
  let catalogQuery = $state('')
  let catalogScope = $state('all')
  let addModelOpen = $state(false)
  let draftNotice = $state('')
  let modelForm = $state({ provider:'local-pi', id:'', context:'32768', cost_out_per_mtok:'0', band:'utility' })
  let directory = $state(null)
  let directoryLoading = $state(true)
  let catalogMode = $state('discover')
  let directoryQuery = $state('')
  let directorySort = $state('intelligence')
  let directoryPage = $state(1)
  let directorySelections = $state({})
  let catalogKey = $state('')
  let connectingCatalog = $state(false)
  let catalogKeyError = $state('')
  let catalogKeyOpen = $state(false)
  let rememberCatalogKey = $state(true)
  const DIRECTORY_PAGE_SIZE = 12

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
  let chips = $derived([...(payload?.chips || []), ...customModels])
  let bandOptions = $derived((payload?.bands || []).map((band) => ({ value:band.band, label:band.band })))
  let rail = $derived(projectRail(payload?.rail || [], staged))
  let visibleResult = $derived(attemptResult || stagedResult)
  let seatCount = $derived(rail.reduce((sum, tier) => sum + (tier.seats?.length || 0), 0))
  let uniqueModels = $derived(new Set(rail.flatMap((tier) => tier.seats || []).map((seat) => seat.model_key).filter(Boolean)).size)
  let customKeys = $derived(new Set(customModels.map((model) => model.key)))
  let containsCustomMoves = $derived(staged.some((move) => customKeys.has(modelKey(move.cell))))
  let filteredChips = $derived(chips.filter((chip) => {
    const query = catalogQuery.trim().toLowerCase()
    const inScope = catalogScope === 'all' || (catalogScope === 'local' ? chip.local_draft : chip.band === catalogScope)
    return inScope && (!query || `${chip.key} ${chip.band || ''}`.toLowerCase().includes(query))
  }))
  let draftCount = $derived(staged.length + customModels.length)
  let workflowStep = $derived(selectedModel ? 2 : stagedResult?.ok && !customModels.length ? 4 : draftCount > 0 ? 3 : 1)
  let directoryFamilies = $derived(groupDirectoryModels(directory?.models || []))
  let directoryModels = $derived(directoryFamilies.filter((model) => {
    const query = directoryQuery.trim().toLowerCase()
    return !query || `${model.name} ${model.creator} ${model.slug} ${model.variants.map((variant) => variant.name).join(' ')}`.toLowerCase().includes(query)
  }).sort((left, right) => {
    const direction = directorySort === 'price_output' ? 1 : -1
    const leftValue = left[directorySort], rightValue = right[directorySort]
    if (leftValue == null && rightValue == null) return left.name.localeCompare(right.name)
    if (leftValue == null) return 1
    if (rightValue == null) return -1
    return direction * (leftValue - rightValue) || left.name.localeCompare(right.name)
  }))
  let directoryPages = $derived(Math.max(1, Math.ceil(directoryModels.length / DIRECTORY_PAGE_SIZE)))
  let visibleDirectoryModels = $derived(directoryModels.slice((Math.min(directoryPage, directoryPages) - 1) * DIRECTORY_PAGE_SIZE, Math.min(directoryPage, directoryPages) * DIRECTORY_PAGE_SIZE))

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

  $effect(() => {
    let active = true
    getModelCatalog().then((result) => { if (active) directory = result }).catch((err) => {
      if (active) directory = { configured:true, models:null, absent:err.message || 'model catalog request failed', source:'Artificial Analysis', source_url:'https://artificialanalysis.ai/' }
    }).finally(() => { if (active) directoryLoading = false })
    return () => { active = false }
  })

  $effect(() => {
    if (loading || !payload || draftReady) return
    try {
      const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}')
      staged = Array.isArray(saved.moves) ? saved.moves : []
      customModels = Array.isArray(saved.models) ? saved.models : []
    } catch { draftNotice = 'The previous local draft could not be read, so a clean draft was opened.' }
    draftReady = true
  })

  $effect(() => {
    if (!draftReady) return
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ moves: staged, models: customModels, saved_at: new Date().toISOString() }))
  })

  function chipFor(key) { return chips.find((chip) => chip.key === key) || null }
  function modelName(key) { return String(key || '').split('/').at(-1) || 'Unassigned' }
  function provider(key) { return String(key || '').split('/')[0] || 'none' }
  function providerMark(key) { return provider(key).slice(0, 2).toUpperCase() }
  function roleColor(role) { return `var(--${role}-color)` }
  function money(value) { return value == null ? '—' : value < 0.01 ? `$${value.toFixed(3)}` : `$${value.toFixed(2)}` }
  function score(value) { return value == null ? '—' : Number(value).toFixed(1) }
  function suggestedBand(intelligence) {
    if (intelligence == null) return 'utility'
    return [...(payload?.bands || [])].sort((left, right) => right.rank - left.rank).find((band) => intelligence >= band.floor_reference_score)?.band || 'basement'
  }
  function directoryKey(model) { return `${model.provider_hint || 'provider'}/${model.slug}` }
  function isKnownDirectoryModel(model) { return chips.some((chip) => chip.key === directoryKey(model) || chip.id === model.slug) }
  function sourceCell(chip, target) {
    const source = rail.flatMap((column) => column.seats || []).find((seat) => seat.model_key === chip.key)?.cell
    const base = source || target?.cell || { agent:'pi', effort:'medium' }
    return { provider:chip.provider, id:chip.id, agent:chip.local_draft ? 'pi' : (base.agent || 'pi'), effort:chip.reasoning_effort || base.effort || 'medium' }
  }
  async function move(tier, role, key) {
    const chip = chipFor(key)
    if (!chip?.id) return
    const target = rail.find((column) => column.tier === tier)?.seats?.find((seat) => seat.role === role)
    const next = [...staged.filter((candidate) => !(candidate.tier === tier && candidate.role === role)), { tier, role, cell:sourceCell(chip, target) }]
    composed = null; draftNotice = ''
    if (chip.local_draft || next.some((candidate) => customKeys.has(modelKey(candidate.cell)))) {
      staged = next
      attemptResult = null
      stagedResult = null
      return
    }
    staging = true
    try {
      const result = await stageRosterLadder(next)
      attemptResult = result
      if (result.ok) { staged = next; stagedResult = result }
    } catch (err) { requestError = err.message || 'roster ladder staging failed' } finally { staging = false }
  }
  function drop(event, tier, role) { event.preventDefault(); move(tier, role, event.dataTransfer?.getData('text/plain')) }
  function dragStart(event, chip) { event.dataTransfer?.setData('text/plain', chip.key); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move' }
  function addLocalModel(event) {
    event.preventDefault()
    const providerValue = modelForm.provider.trim().toLowerCase()
    const idValue = modelForm.id.trim()
    const key = `${providerValue}/${idValue}`
    const context = Number(modelForm.context)
    const cost = Number(modelForm.cost_out_per_mtok)
    if (!/^[a-z0-9-]+$/.test(providerValue) || !/^[A-Za-z0-9._-]+$/.test(idValue) || !Number.isFinite(context) || context <= 0 || !Number.isFinite(cost) || cost < 0) {
      draftNotice = 'Add a provider key, model ID, positive context window, and non-negative output cost.'
      return
    }
    if (chips.some((chip) => chip.key === key)) { draftNotice = `${key} is already in this catalog.`; return }
    customModels = [...customModels, {
      key, provider:providerValue, id:idValue, band:modelForm.band, local_draft:true,
      context, cost_out_per_mtok:cost, reference:null,
      reference_pending:'Local draft — no external reference score', measured:null,
      measured_pending:'Local draft — no factory runs measured', seated_at:[],
    }]
    selectedModel = key
    addModelOpen = false
    draftNotice = `${key} was added to this browser draft. Choose a seat above to try it.`
    modelForm = { ...modelForm, id:'' }
  }
  function addDirectoryModel(model) {
    const variant = selectedDirectoryVariant(model, directorySelections)
    const key = directoryKey(model)
    if (chips.some((chip) => chip.key === key)) { draftNotice = `${model.name} is already in the roster or draft.`; return }
    customModels = [...customModels, {
      key, provider:model.provider_hint || 'provider', id:model.slug, band:suggestedBand(variant.intelligence),
      local_draft:true, benchmark_draft:true, source_id:variant.source_id, source:'Artificial Analysis',
      reasoning_effort:variant.reasoning_effort, reasoning_mode:variant.reasoning_mode, benchmark_variant:variant.name,
      context:variant.context_window_tokens, cost_in_per_mtok:variant.price_input, cost_out_per_mtok:variant.price_output,
      cost_cache_read_per_mtok:variant.price_cache_hit, intelligence:variant.intelligence, coding:variant.coding, agentic:variant.agentic,
      reference:variant.intelligence, reference_pending:variant.intelligence == null ? 'Not measured by Artificial Analysis' : null,
      measured:null, measured_pending:'Not yet measured by this factory', seated_at:[],
    }]
    selectedModel = key
    catalogMode = 'roster'
    draftNotice = `${model.name} was added at ${directoryVariantLabel(variant).toLowerCase()} effort. Confirm its runtime provider and exact API model ID before activation.`
  }
  function chooseDirectoryVariant(model, sourceId) { directorySelections = { ...directorySelections, [model.family_key]:sourceId } }
  function activeDirectoryVariant(model) { return selectedDirectoryVariant(model, directorySelections) }
  function directoryVariantOptions(model) { return model.variants.map((option) => ({ value:option.source_id, label:directoryVariantLabel(option) })) }
  async function connectCatalog(event) {
    event.preventDefault()
    if (catalogKey.trim().length < 8) { catalogKeyError = 'Enter a valid Artificial Analysis API key.'; return }
    connectingCatalog = true; catalogKeyError = ''
    const secret = catalogKey
    catalogKey = ''
    try {
      const result = await setModelCatalogKey(secret, { persist:rememberCatalogKey })
      directory = result
      if (!result.models) catalogKeyError = result.absent || 'The model catalog could not be loaded with that key.'
      else {
        catalogKeyOpen = false
        draftNotice = rememberCatalogKey ? 'Model catalog connected. The key was saved in the ignored .env.local file.' : 'Model catalog connected for this server run.'
      }
    } catch (err) { catalogKeyError = err.message || 'Could not connect the model catalog.' }
    finally { connectingCatalog = false }
  }
  async function disconnectCatalog() {
    try { directory = await setModelCatalogKey(null); catalogKeyError = ''; catalogKeyOpen = false; directoryPage = 1 }
    catch (err) { catalogKeyError = err.message || 'Could not clear the session key.' }
  }
  function removeCustomModel(key) {
    customModels = customModels.filter((model) => model.key !== key)
    staged = staged.filter((move) => modelKey(move.cell) !== key)
    if (selectedModel === key) selectedModel = null
    draftNotice = `${key} was removed from the local draft.`
  }
  function resetDraft() {
    staged = []; customModels = []; selectedModel = null; stagedResult = null; attemptResult = null; composed = null
    draftNotice = 'Local roster draft cleared.'
  }
  async function exportDraft() {
    const text = JSON.stringify({ models:customModels, moves:staged }, null, 2)
    try { await navigator.clipboard.writeText(text); draftNotice = 'Draft JSON copied to the clipboard.' }
    catch { draftNotice = 'Clipboard access was unavailable. Your draft is still saved locally.' }
  }
  async function validateDraft() {
    if (!staged.length || containsCustomMoves || customModels.length) return
    staging = true; requestError = ''; composed = null
    try {
      const result = await stageRosterLadder(staged)
      attemptResult = result
      stagedResult = result.ok ? result : null
    } catch (err) { requestError = err.message || 'roster ladder staging failed' } finally { staging = false }
  }
  async function compose() {
    if (!stagedResult?.ok || containsCustomMoves || customModels.length) return
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
      <article><span>Task profiles</span><strong>{rail.length}</strong></article>
      <article><span>Active seats</span><strong>{seatCount}</strong></article>
      <article><span>Models in use</span><strong>{uniqueModels}</strong></article>
      <article><span>Ratified</span><strong class="date">{payload.ratified_at || '—'}</strong><small>{payload.ratified_by || 'owner unavailable'}</small></article>
      <p>Health evidence covers <strong>{payload.measured_window?.label || 'an unavailable window'}</strong>. A failure count is evidence about recent operation, not a model ranking.</p>
    </div>

    <section class="profile-area" aria-labelledby="task-profiles-title">
      <header class="section-intro">
        <div><p class="micro">Factory routing</p><h2 id="task-profiles-title">Task profiles</h2></div>
        <p><strong>Profiles shape the run.</strong> They determine crew seats and assurance depth; they are not model rankings.</p>
      </header>
      <div class="tier-grid">
        {#each rail as column, tierIndex (column.tier)}
          <article class="tier-card" style={`--tier-index:${tierIndex}`}>
            <header><div><p class="micro">Task profile {tierIndex + 1}</p><h2>{column.tier}</h2></div><span class="floor">Minimum {column.floor_band || 'unrated'}</span></header>
            <p class="tier-note">Crew preset · up to ${column.cost_ceiling_out_per_mtok ?? '—'} output / Mtok</p>
            <div class="seats">
              {#each column.seats || [] as seat (seat.role)}
                {@const health = chipFor(seat.model_key)?.measured}
                <button type="button" class="seat" class:changeable={selectedModel} onclick={() => selectedModel && move(column.tier, seat.role, selectedModel)} ondragover={(event) => event.preventDefault()} ondrop={(event) => drop(event, column.tier, seat.role)}>
                  <span class="role"><i style={`--seat-color:${roleColor(seat.role)}`}></i>{seat.role}</span>
                  <span class="model"><b class={`provider ${provider(seat.model_key)}`}>{providerMark(seat.model_key)}</b><span><strong>{modelName(seat.model_key)}</strong><small>{seat.cell?.agent || 'agent —'} · {seat.cell?.effort || 'effort —'}</small></span></span>
                  {#if health == null}<span class="health">Not measured</span>{:else if health.failures > 0}<span class="health warn" title={`${health.failures} measured failures across ${health.cells} cells`}>{health.failures} recent failure{health.failures === 1 ? '' : 's'}</span>{:else}<span class="health">No recent failures</span>{/if}
                </button>
              {/each}
              {#each column.unseated || [] as role (role)}
                <button type="button" class="seat empty" class:changeable={selectedModel} onclick={() => selectedModel && move(column.tier, role, selectedModel)} ondragover={(event) => event.preventDefault()} ondrop={(event) => drop(event, column.tier, role)}><span class="role"><i style={`--seat-color:${roleColor(role)}`}></i>{role}</span><span>Unassigned</span></button>
              {/each}
            </div>
          </article>
        {/each}
      </div>
    </section>

    <section class="bands">
      <header><div><p class="micro">Model suitability</p><h2>Capability bands</h2></div><p><strong>Separate from task profiles.</strong> Bands group ratified models by capability; local and unmeasured are evidence states, not extra bands.</p></header>
      <div class="band-list">
        {#each payload.bands || [] as band (band.band)}
          <article class={`band ${band.band}`}><span class="band-name"><b>{band.band}</b><small>reference floor {band.floor_reference_score}</small></span><div>{#each band.members as key (key)}<span class="model-pill"><b class={`provider ${provider(key)}`}>{providerMark(key)}</b>{modelName(key)}</span>{/each}</div></article>
        {/each}
      </div>
    </section>

    <section class="studio">
      <header class="studio-title">
        <div><p class="micro">Roster workspace</p><h2>Try locally, publish deliberately</h2><p>Build a private browser draft first. Preparing a repository patch is a separate final step.</p></div>
        <span class="draft-state"><i></i>{draftCount ? `${draftCount} draft change${draftCount === 1 ? '' : 's'} · saved locally` : 'No local changes'}</span>
      </header>

      <ol class="workflow" aria-label="Roster change workflow">
        <li class:active={workflowStep === 1} aria-current={workflowStep === 1 ? 'step' : undefined}><b>1</b><span><strong>Choose or add</strong><small>Find a catalog model or describe a local one.</small></span></li>
        <li class:active={workflowStep === 2} aria-current={workflowStep === 2 ? 'step' : undefined}><b>2</b><span><strong>Assign a seat</strong><small>Click above; local models use pi and keep the seat effort.</small></span></li>
        <li class:active={workflowStep === 3} aria-current={workflowStep === 3 ? 'step' : undefined}><b>3</b><span><strong>Review the draft</strong><small>Warnings stay visible beside your changes.</small></span></li>
        <li class:active={workflowStep === 4} aria-current={workflowStep === 4 ? 'step' : undefined}><b>4</b><span><strong>Prepare a patch</strong><small>A PR is optional until you choose to publish.</small></span></li>
      </ol>

      <div class="studio-layout">
        <div class="catalog">
          <div class="studio-heading">
            <div><h3>Model catalog</h3><p>Discover models using independent intelligence and pricing data, then add one to your private roster draft.</p></div>
            {#if catalogMode === 'roster'}<button type="button" class="add-model" onclick={() => addModelOpen = !addModelOpen}>{addModelOpen ? 'Close form' : '+ Add manually'}</button>{/if}
          </div>

          <div class="catalog-tabs" role="tablist" aria-label="Model catalog views">
            <button type="button" role="tab" aria-selected={catalogMode === 'discover'} class:active={catalogMode === 'discover'} onclick={() => catalogMode = 'discover'}>Discover models</button>
            <button type="button" role="tab" aria-selected={catalogMode === 'roster'} class:active={catalogMode === 'roster'} onclick={() => catalogMode = 'roster'}>Roster & draft <span>{chips.length}</span></button>
          </div>

          {#if catalogMode === 'discover'}
            {#if directoryLoading}
              <div class="directory-loading"><span></span><p>Loading current model intelligence and pricing…</p></div>
            {:else if !directory?.models}
              <section class="source-setup">
                <header>
                  <span class:warning={directory?.configured} class="source-state"><i></i>{directory?.configured ? 'Connection needs attention' : 'Model source not configured'}</span>
                  <a href="https://artificialanalysis.ai/data-api" target="_blank" rel="noreferrer">Get a key ↗</a>
                </header>
                <div class="source-message">
                  <div><h3>{directory?.configured ? 'Artificial Analysis could not load' : 'Connect model intelligence'}</h3><p>{catalogKeyError || directory?.absent}</p></div>
                  <button type="button" class="temporary-key" aria-expanded={catalogKeyOpen} onclick={() => catalogKeyOpen = !catalogKeyOpen}>{catalogKeyOpen ? 'Cancel' : directory?.configured ? 'Replace key' : 'Add API key'}</button>
                </div>
                <p class="persistent-hint"><b>Persistent by default.</b> Keep “Remember on this machine” selected to save the key in the ignored <code>.env.local</code> file. Uncheck it for this server run only.</p>
                {#if catalogKeyOpen}
                  <form onsubmit={connectCatalog}>
                    <label><span>Artificial Analysis API key</span><div><input type="password" bind:value={catalogKey} autocomplete="off" placeholder="Paste key…" aria-describedby="catalog-key-note" /><button type="submit" disabled={connectingCatalog || catalogKey.trim().length < 8}>{connectingCatalog ? 'Connecting…' : rememberCatalogKey ? 'Save & connect' : 'Connect for this run'}</button></div></label>
                    <label class="remember-key"><input type="checkbox" bind:checked={rememberCatalogKey} /><span><b>Remember on this machine</b><small>Save to the git-ignored <code>.env.local</code> file and reconnect automatically after restarts.</small></span></label>
                  </form>
                  <small id="catalog-key-note">{rememberCatalogKey ? 'Only the named environment variable is updated; the key is never returned to the browser.' : 'Temporary mode holds the key only in local server memory until it restarts.'}</small>
                {/if}
              </section>
            {:else}
              <div class="directory-tools">
                <label class="search"><span>Find a model</span><input bind:value={directoryQuery} oninput={() => directoryPage = 1} placeholder="Grok, Kimi, GLM, Gemma…" /></label>
                <label class="sort"><span>Sort by</span><Dropdown bind:value={directorySort} options={DIRECTORY_SORTS} onchange={() => directoryPage = 1} ariaLabel="Sort model catalog" /></label>
                <div class="source-meta"><strong>{directoryModels.length}</strong><span>models · Index v{directory.intelligence_index_version ?? '—'}</span></div>
              </div>
              <div class="directory-list">
                <div class="directory-head"><span>Model</span><span>Intelligence</span><span>Coding</span><span>Price / Mtok</span><span>Speed</span><span></span></div>
                {#each visibleDirectoryModels as model (model.family_key)}
                  {@const variant = activeDirectoryVariant(model)}
                  <article>
                    <div class="directory-name"><b class="provider">{model.creator.slice(0,2).toUpperCase()}</b><span><strong>{model.name}</strong><small>{model.creator}{model.release_date ? ` · ${model.release_date}` : ''}</small>{#if model.variant_count > 1}<label class="effort-control"><span>Effort</span><Dropdown value={variant.source_id} options={directoryVariantOptions(model)} onchange={(value) => chooseDirectoryVariant(model, value)} ariaLabel={`Reasoning effort for ${model.name}`} width="7rem" variant="pill" /></label>{:else if variant.reasoning_effort || variant.reasoning_mode}<small class="variant-note">{directoryVariantLabel(variant)} benchmark</small>{/if}</span></div>
                    <div class="score"><strong>{score(variant.intelligence)}</strong><small>AA Index</small></div>
                    <div class="score"><strong>{score(variant.coding)}</strong><small>Coding</small></div>
                    <div class="price"><strong>{money(variant.price_output)}</strong><small>{money(variant.price_input)} input</small></div>
                    <div class="speed"><strong>{variant.output_tokens_per_second == null ? '—' : Math.round(variant.output_tokens_per_second)}</strong><small>tok/s</small></div>
                    <button type="button" disabled={isKnownDirectoryModel(model)} onclick={() => addDirectoryModel(model)}>{isKnownDirectoryModel(model) ? 'Added' : '+ Add'}</button>
                  </article>
                {/each}
                {#if !visibleDirectoryModels.length}<p class="empty-catalog">No benchmarked models match that search.</p>{/if}
              </div>
              <footer class="directory-footer">
                <p>Intelligence, coding, pricing, and performance data from <a href={directory.source_url} target="_blank" rel="noreferrer">Artificial Analysis ↗</a>. Null means not measured—not zero.{directory.stale ? ` Showing cached data because refresh failed: ${directory.absent}` : ''}</p>
                <div><span class="connection-chip"><i></i>Connected · {directory.credential_source === 'environment' ? '.env.local' : 'temporary key'}</span>{#if directory.credential_source === 'session'}<button class="forget-key" type="button" title="Clear the temporary API key" onclick={disconnectCatalog}>Clear key</button>{/if}<button type="button" disabled={directoryPage <= 1} onclick={() => directoryPage -= 1}>←</button><span>Page {Math.min(directoryPage,directoryPages)} of {directoryPages}</span><button type="button" disabled={directoryPage >= directoryPages} onclick={() => directoryPage += 1}>→</button></div>
              </footer>
            {/if}
          {:else}
            {#if addModelOpen}
              <form class="model-form" onsubmit={addLocalModel}>
                <header><div><h3>Add a model manually</h3><p>Use this for a model missing from the benchmark directory. The provider key must later match a checkout-pinned <code>local_providers</code> entry, and custom models run through the <code>pi</code> adapter.</p></div><span>Local draft</span></header>
                <label><span>Provider key</span><input bind:value={modelForm.provider} placeholder="local-pi" autocomplete="off" /><small>The provider namespace configured for your endpoint.</small></label>
                <label class="wide"><span>Model ID</span><input bind:value={modelForm.id} placeholder="gemma-3-27b or qwen3-27b" autocomplete="off" /><small>Use the exact ID exposed by the provider.</small></label>
                <label><span>Context window</span><input bind:value={modelForm.context} inputmode="numeric" placeholder="32768" /></label>
                <label><span>Output / Mtok</span><input bind:value={modelForm.cost_out_per_mtok} inputmode="decimal" placeholder="0" /></label>
                <label><span>Provisional band</span><Dropdown bind:value={modelForm.band} options={bandOptions} ariaLabel="Provisional capability band" /><small>A draft placement, not a capability claim.</small></label>
                <button class="create-model" type="submit">Add to local draft</button>
              </form>
            {/if}

            <div class="catalog-tools">
              <label class="search"><span>Search roster</span><input bind:value={catalogQuery} placeholder="Provider or model…" /></label>
              <div class="scope" aria-label="Filter model catalog">
                <button type="button" class:active={catalogScope === 'all'} onclick={() => catalogScope = 'all'}>All <span>{chips.length}</span></button>
                <button type="button" class:active={catalogScope === 'local'} onclick={() => catalogScope = 'local'}>Draft <span>{customModels.length}</span></button>
                {#each payload.bands || [] as band}<button type="button" class:active={catalogScope === band.band} onclick={() => catalogScope = band.band}>{band.band}</button>{/each}
              </div>
            </div>

            <div class="model-palette">
              {#each filteredChips as chip (chip.key)}
                <article class:selected={selectedModel === chip.key} class:local={chip.local_draft} class:benchmark={chip.benchmark_draft}>
                  <button class="model-choice" type="button" draggable="true" ondragstart={(event) => dragStart(event, chip)} onclick={() => selectedModel = selectedModel === chip.key ? null : chip.key}>
                    <b class={`provider ${provider(chip.key)}`}>{providerMark(chip.key)}</b>
                    <span><strong>{modelName(chip.key)}</strong><small>{chip.provider} · {chip.band || 'unratified'} · ${chip.cost_out_per_mtok ?? '—'} output / Mtok</small>{#if chip.intelligence != null}<small>Intelligence {score(chip.intelligence)} · Coding {score(chip.coding)}</small>{:else if chip.measured}<small>{chip.measured.failures ? `${chip.measured.failures} recent failures` : 'No recent failures'} · {chip.measured.cells} cells measured</small>{:else}<small>{chip.measured_pending}</small>{/if}{#if chip.drift}<small class="drift">Band review: {chip.drift.proposed || chip.drift.why}</small>{/if}</span>
                  </button>
                  {#if chip.local_draft}<button class="remove-model" type="button" title={`Remove ${chip.key}`} onclick={() => removeCustomModel(chip.key)}>×</button>{/if}
                </article>
              {/each}
              {#if !filteredChips.length}<p class="empty-catalog">No models match this view.</p>{/if}
            </div>
          {/if}
        </div>

        <aside class="draft-panel">
          <header><div><p class="micro">Local draft</p><h3>{draftCount ? `${draftCount} pending change${draftCount === 1 ? '' : 's'}` : 'Ready when you are'}</h3></div>{#if draftCount}<button type="button" class="clear" onclick={resetDraft}>Clear draft</button>{/if}</header>

          {#if requestError}<div class="inline-alert fail"><strong>Could not validate</strong><p>{requestError}</p></div>{/if}
          {#if draftNotice}<div class="inline-alert"><strong>Draft update</strong><p>{draftNotice}</p></div>{/if}
          {#if selectedModel}<div class="selected-model"><b class={`provider ${provider(selectedModel)}`}>{providerMark(selectedModel)}</b><span><small>Selected model</small><strong>{modelName(selectedModel)}</strong><em>Choose a seat above</em></span><button type="button" onclick={() => selectedModel = null}>×</button></div>{/if}

          {#if customModels.length}
            <section class="setup-warning"><header><span>Setup required before activation</span><b>{customModels.length}</b></header><p>These models exist only in this browser draft. Before factory use:</p><ul><li>confirm the runtime provider and exact API model ID</li><li>register its endpoint when it is not built in</li><li>complete model metadata and ratify a capability band</li><li>keep custom-provider seats on the <code>pi</code> adapter</li></ul><small>Benchmark identity and runtime identity are different. The factory probes custom endpoints at boot and refuses an unavailable provider.</small></section>
          {/if}

          {#if visibleResult && !containsCustomMoves && !customModels.length}
            <section class="validation"><header><h3>Factory checks</h3><span class:pass={visibleResult.ok} class:fail={!visibleResult.ok}>{visibleResult.ok ? 'Ready' : 'Needs changes'}</span></header>
              <ul>{#each CHECK_NAMES.map((name) => visibleResult.checks?.find((check) => check.check === name)).filter(Boolean) as check (check.check)}<li class:pass={check.ok} class:fail={!check.ok}><b>{check.ok ? '✓' : '×'}</b><span><strong>{check.check.replaceAll('_',' ')}</strong><small>{check.message}</small></span></li>{/each}</ul>
              {#if visibleResult.refusals?.length}<div class="refusals">{#each visibleResult.refusals as refusal (refusal.code + refusal.message)}<p>{refusal.message}</p>{/each}</div>{/if}
              {#if visibleResult.diff !== null}<details class="diff"><summary>Preview roster diff</summary><pre>{visibleResult.diff || '(no roster change)'}</pre></details>{/if}
            </section>
          {/if}

          <div class="draft-actions">
            <button type="button" class="secondary" disabled={!draftCount} onclick={exportDraft}>Copy local draft</button>
            <button type="button" class="secondary" disabled={!staged.length || containsCustomMoves || customModels.length || staging} onclick={validateDraft}>{staging ? 'Checking…' : 'Run factory checks'}</button>
            <button class="compose" type="button" disabled={!stagedResult?.ok || staging || composing || containsCustomMoves || customModels.length} onclick={compose}>{composing ? 'Preparing…' : 'Prepare repository patch'}</button>
          </div>
          <p class="publish-note">Local drafts are private to this browser and do not change the active factory. A repository patch is prepared only when you choose it; creating a PR remains a separate decision.</p>
        </aside>
      </div>

      {#if composed?.ok}<section class="bundle"><h3>Repository-ready bundle</h3><p><strong>{composed.branch}</strong> · {composed.commit_subject}</p><pre>{composed.patch}</pre><small>The live roster was not changed and no PR was created.</small></section>{/if}
    </section>
  </section>
{/if}

<style>
.loading,.notice { min-height:16rem; display:grid; place-content:center; justify-items:center; border:1px solid var(--line); border-radius:var(--radius-lg); background:var(--panel); color:var(--muted); }.loading span { width:1.6rem; height:1.6rem; border:2px solid var(--line); border-top-color:var(--accent); border-radius:50%; animation:spin .8s linear infinite; }@keyframes spin{to{transform:rotate(360deg)}}
.notice strong { color:var(--status-fail); }.notice p { margin:.4rem 0; }
.roster-shell { display:grid; gap:1rem; }.roster-summary { display:grid; grid-template-columns:repeat(4,minmax(7rem,1fr)) minmax(18rem,2fr); border:1px solid var(--line); border-radius:var(--radius-lg); background:color-mix(in srgb,var(--panel) 94%,transparent); overflow:hidden; }
.roster-summary article { display:grid; gap:.35rem; padding:1rem; border-right:1px solid var(--line); }.roster-summary article span { color:var(--muted); font-size:.65rem; text-transform:uppercase; letter-spacing:.08em; }.roster-summary article strong { font:600 1.5rem/1 var(--mono); }.roster-summary article .date { font-size:.92rem; }.roster-summary article small { color:var(--muted); font-size:.68rem; }.roster-summary > p { align-self:center; margin:0; padding:1rem; color:var(--muted); font-size:.76rem; line-height:1.5; }.roster-summary > p strong { color:inherit; }
.profile-area { display:grid; gap:.65rem; }.section-intro { display:flex; align-items:end; justify-content:space-between; gap:1.5rem; padding:0 .15rem; }.section-intro h2 { margin:.15rem 0 0; font-size:1.05rem; }.section-intro > p { max-width:34rem; margin:0; color:var(--muted); font-size:.68rem; line-height:1.45; text-align:right; }.section-intro > p strong { color:var(--text); }
.tier-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:.8rem; }.tier-card { position:relative; overflow:hidden; border:1px solid var(--line); border-radius:var(--radius-lg); background:color-mix(in srgb,var(--panel) 95%,transparent); padding:1rem; box-shadow:var(--shadow); }.tier-card::before { content:''; position:absolute; inset:0 auto 0 0; width:2px; background:var(--planner-color); }.tier-card:nth-child(2)::before { background:var(--builder-color); }.tier-card:nth-child(3)::before { background:var(--tech-lead-color); }
.tier-card > header { display:flex; align-items:start; justify-content:space-between; gap:1rem; }.micro { margin:0 0 .25rem; color:var(--muted); }.tier-card h2 { margin:0; text-transform:capitalize; font-size:1.2rem; }.floor { border:1px solid var(--line); border-radius:1rem; padding:.25rem .5rem; color:var(--muted); font-size:.67rem; text-transform:capitalize; }.tier-note { margin:.35rem 0 .9rem; color:var(--muted); font-size:.7rem; }
.seats { display:grid; gap:.45rem; }.seat { width:100%; display:grid; grid-template-columns:5.5rem minmax(0,1fr) auto; align-items:center; gap:.65rem; min-height:4rem; border:1px solid var(--line); border-radius:var(--radius); background:var(--panel-raised); padding:.65rem; text-align:left; }.seat.changeable { cursor:copy; border-style:dashed; }.seat.changeable:hover { border-color:var(--accent); background:var(--accent-soft); }.role { display:flex; align-items:center; gap:.4rem; color:var(--muted); font-size:.68rem; text-transform:capitalize; }.role i { width:.42rem; height:.42rem; border-radius:50%; background:var(--seat-color); box-shadow:0 0 7px color-mix(in srgb,var(--seat-color) 60%,transparent); }.model { display:flex; align-items:center; gap:.55rem; min-width:0; }.model > span { min-width:0; display:grid; gap:.16rem; }.model strong { font-size:.78rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.model small,.health { color:var(--muted); font-size:.62rem; }.provider { display:grid; place-content:center; flex:0 0 auto; width:1.7rem; height:1.7rem; border:1px solid var(--line); border-radius:.45rem; background:var(--bg); color:var(--muted); font:700 .58rem/1 var(--mono); }.provider.openai { color:var(--builder-color); }.provider.anthropic { color:var(--tech-lead-color); }.health { text-align:right; white-space:nowrap; }.health.warn { color:var(--status-escalated); }.seat.empty { color:var(--muted); border-style:dashed; }
.bands { border:1px solid var(--line); border-radius:var(--radius-lg); background:var(--panel); overflow:hidden; }.bands > header { display:flex; justify-content:space-between; align-items:end; gap:1.5rem; padding:1rem; border-bottom:1px solid var(--line); }.bands h2 { margin:.15rem 0 0; font-size:1.05rem; }.bands header > p { max-width:36rem; margin:0; color:var(--muted); font-size:.68rem; line-height:1.45; text-align:right; }.bands header > p strong { color:var(--text); }.band { display:grid; grid-template-columns:9rem 1fr; align-items:center; min-height:4.25rem; border-top:1px solid var(--line); }.band:first-child { border-top:0; }.band-name { align-self:stretch; display:grid; align-content:center; gap:.2rem; padding:.8rem 1rem; border-right:1px solid var(--line); text-transform:capitalize; }.band-name b { font-size:.82rem; }.band-name small { color:var(--muted); font-size:.6rem; }.band > div { display:flex; flex-wrap:wrap; gap:.45rem; padding:.75rem; }.model-pill { display:inline-flex; align-items:center; gap:.45rem; border:1px solid var(--line); border-radius:2rem; background:var(--panel-raised); padding:.3rem .6rem .3rem .35rem; font:600 .7rem/1 var(--mono); }.model-pill .provider { width:1.35rem; height:1.35rem; border-radius:50%; }.frontier .band-name { box-shadow:inset 3px 0 var(--lead-color); }.workhorse .band-name { box-shadow:inset 3px 0 var(--tech-lead-color); }.utility .band-name { box-shadow:inset 3px 0 var(--reviewer-color); }.basement .band-name { box-shadow:inset 3px 0 var(--muted); }
.studio { border:1px solid var(--line); border-radius:var(--radius-lg); background:var(--panel); overflow:hidden; }
.studio-title { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:1.1rem 1.2rem; border-bottom:1px solid var(--line); background:linear-gradient(110deg,color-mix(in srgb,var(--accent) 7%,var(--panel)),var(--panel) 45%); }.studio-title h2 { margin:.1rem 0 .25rem; font-size:1.2rem; }.studio-title p:last-child { margin:0; color:var(--muted); font-size:.72rem; }.draft-state { display:flex; align-items:center; gap:.45rem; border:1px solid var(--line); border-radius:2rem; padding:.45rem .7rem; color:var(--muted); font-size:.68rem; white-space:nowrap; }.draft-state i { width:.45rem; height:.45rem; border-radius:50%; background:var(--status-ok); box-shadow:0 0 8px color-mix(in srgb,var(--status-ok) 65%,transparent); }
.workflow { display:grid; grid-template-columns:repeat(4,1fr); margin:0; padding:0; list-style:none; border-bottom:1px solid var(--line); }.workflow li { position:relative; display:flex; align-items:center; gap:.55rem; min-height:4.2rem; padding:.75rem 1rem; border-right:1px solid var(--line); color:var(--muted); }.workflow li:last-child { border-right:0; }.workflow li::after { content:''; position:absolute; inset:auto 1rem 0; height:2px; background:transparent; }.workflow li.active::after { background:var(--accent); }.workflow li > b { display:grid; place-content:center; width:1.45rem; height:1.45rem; flex:0 0 auto; border:1px solid var(--line); border-radius:50%; font:600 .65rem/1 var(--mono); }.workflow li.active > b { border-color:var(--accent); background:var(--accent-soft); color:var(--accent); }.workflow li span { display:grid; gap:.15rem; }.workflow strong { color:var(--text); font-size:.7rem; }.workflow small { font-size:.58rem; line-height:1.35; }
.studio-layout { display:grid; grid-template-columns:minmax(0,1fr) 21rem; align-items:start; }.catalog { min-width:0; padding:1rem 1.1rem 1.2rem; border-right:1px solid var(--line); }.draft-panel { position:sticky; top:1rem; display:grid; gap:.8rem; padding:1rem; }.studio-heading,.draft-panel > header { display:flex; align-items:start; justify-content:space-between; gap:1rem; }.studio-heading h3,.draft-panel h3 { margin:0 0 .2rem; font-size:.9rem; }.studio-heading p { margin:0; color:var(--muted); font-size:.68rem; line-height:1.5; }.add-model,.clear,.secondary { border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--panel-raised); color:var(--text); padding:.48rem .65rem; cursor:pointer; font-size:.67rem; white-space:nowrap; }.add-model { border-color:color-mix(in srgb,var(--accent) 45%,var(--line)); color:var(--accent); }.clear { padding:.35rem .5rem; color:var(--muted); }
.catalog-tabs { display:flex; gap:1rem; margin-top:.8rem; border-bottom:1px solid var(--line); }.catalog-tabs button { position:relative; border:0; background:transparent; color:var(--muted); padding:.6rem .1rem; cursor:pointer; font-size:.68rem; font-weight:700; }.catalog-tabs button::after { content:''; position:absolute; inset:auto 0 -1px; height:2px; background:transparent; }.catalog-tabs button.active { color:var(--text); }.catalog-tabs button.active::after { background:var(--accent); }.catalog-tabs span { margin-left:.2rem; color:var(--muted); font-family:var(--mono); font-size:.58rem; }
.directory-loading { min-height:18rem; display:grid; place-content:center; justify-items:center; gap:.6rem; color:var(--muted); font-size:.7rem; }.directory-loading span { width:1.4rem; height:1.4rem; border:2px solid var(--line); border-top-color:var(--accent); border-radius:50%; animation:spin .8s linear infinite; }.source-setup { display:grid; gap:.75rem; margin-top:.8rem; border:1px solid var(--line); border-radius:var(--radius); background:var(--panel-raised); padding:.9rem 1rem; }.source-setup > header,.source-message { display:flex; align-items:center; justify-content:space-between; gap:1rem; }.source-setup h3 { margin:0 0 .2rem; font-size:.82rem; }.source-message p { margin:0; color:var(--muted); font-size:.64rem; line-height:1.45; }.source-setup a { color:var(--muted); text-decoration:none; font-size:.6rem; white-space:nowrap; }.source-setup a:hover { color:var(--accent); }.source-state,.connection-chip { display:inline-flex; align-items:center; gap:.35rem; color:var(--muted); font-size:.57rem; font-weight:700; }.source-state i,.connection-chip i { width:.42rem; height:.42rem; border-radius:50%; background:var(--status-running); box-shadow:0 0 .4rem color-mix(in srgb,var(--status-running) 65%,transparent); }.source-state.warning { color:var(--status-escalated); }.temporary-key { border:1px solid color-mix(in srgb,var(--accent) 55%,var(--line)); border-radius:var(--radius-sm); background:var(--accent-soft); color:var(--accent); padding:.5rem .7rem; cursor:pointer; font-size:.62rem; font-weight:700; white-space:nowrap; }.persistent-hint { margin:0; border-left:2px solid var(--line); padding:.35rem 0 .35rem .65rem; color:var(--muted); font-size:.59rem; line-height:1.5; }.persistent-hint b { color:var(--text); }.persistent-hint code { color:var(--accent); font-size:.56rem; }.source-setup form { display:grid; gap:.55rem; border-top:1px solid var(--line); padding-top:.7rem; }.source-setup form label { display:grid; gap:.35rem; color:var(--text); font-size:.62rem; font-weight:700; }.source-setup form label > div { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:.45rem; }.source-setup input { min-width:0; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--bg); color:var(--text); padding:.6rem .65rem; font:inherit; outline:none; }.source-setup input:focus { border-color:var(--accent); box-shadow:0 0 0 2px var(--accent-soft); }.source-setup form button { border:1px solid var(--accent); border-radius:var(--radius-sm); background:var(--accent); color:var(--bg); padding:.55rem .75rem; cursor:pointer; font-size:.67rem; font-weight:700; }.source-setup form button:disabled { opacity:.4; cursor:not-allowed; }.source-setup form .remember-key { display:flex; align-items:start; gap:.45rem; color:var(--muted); cursor:pointer; font-weight:400; }.source-setup form .remember-key input { flex:0 0 auto; width:.85rem; height:.85rem; margin:.1rem 0 0; accent-color:var(--accent); }.remember-key > span { display:grid; gap:.12rem; }.remember-key b { color:var(--text); font-size:.59rem; }.remember-key small { font-size:.55rem; font-weight:400; line-height:1.4; }.remember-key code { color:var(--accent); }.source-setup > small { color:var(--muted); font-size:.57rem; line-height:1.4; }
.directory-tools { display:grid; grid-template-columns:minmax(12rem,1fr) 10rem auto; align-items:end; gap:.65rem; margin:.85rem 0 .6rem; }.directory-tools .search { width:auto; }.sort { display:grid; gap:.3rem; color:var(--text); font-size:.62rem; font-weight:600; }.source-meta { display:grid; justify-items:end; padding-bottom:.15rem; }.source-meta strong { font:600 1rem/1 var(--mono); }.source-meta span { color:var(--muted); font-size:.55rem; white-space:nowrap; }.directory-list { border:1px solid var(--line); border-radius:var(--radius); overflow:hidden; }.directory-head,.directory-list article { display:grid; grid-template-columns:minmax(14rem,2fr) repeat(2,minmax(4.5rem,.55fr)) minmax(6rem,.7fr) minmax(4rem,.5fr) 4rem; align-items:center; gap:.55rem; }.directory-head { min-height:2.1rem; background:var(--bg); padding:0 .65rem; color:var(--muted); font-size:.52rem; text-transform:uppercase; letter-spacing:.04em; }.directory-list article { min-height:3.9rem; border-top:1px solid var(--line); padding:.5rem .65rem; }.directory-list article:hover { background:color-mix(in srgb,var(--accent) 3%,var(--panel)); }.directory-name { display:flex; align-items:center; gap:.55rem; min-width:0; }.directory-name > span,.score,.price,.speed { display:grid; gap:.14rem; min-width:0; }.directory-name strong { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:.7rem; }.directory-name small,.score small,.price small,.speed small { color:var(--muted); font-size:.53rem; }.effort-control { display:flex; align-items:center; gap:.35rem; width:max-content; max-width:100%; margin-top:.15rem; color:var(--muted); font-size:.5rem; }.effort-control > span { text-transform:uppercase; letter-spacing:.05em; }.variant-note { margin-top:.12rem; color:var(--accent)!important; }.score strong,.price strong,.speed strong { font:600 .72rem/1 var(--mono); }.directory-list article > button { border:1px solid color-mix(in srgb,var(--accent) 50%,var(--line)); border-radius:var(--radius-sm); background:var(--accent-soft); color:var(--accent); padding:.4rem; cursor:pointer; font-size:.62rem; font-weight:700; }.directory-list article > button:disabled { border-color:var(--line); background:transparent; color:var(--muted); cursor:default; }.directory-footer { display:flex; align-items:center; justify-content:space-between; gap:1rem; margin-top:.55rem; }.directory-footer p { max-width:42rem; margin:0; color:var(--muted); font-size:.56rem; line-height:1.4; }.directory-footer a { color:inherit; }.directory-footer > div { display:flex; align-items:center; gap:.45rem; white-space:nowrap; }.directory-footer button { display:grid; place-content:center; width:1.7rem; height:1.7rem; border:1px solid var(--line); border-radius:50%; background:var(--panel-raised); color:var(--text); cursor:pointer; }.directory-footer button:disabled { opacity:.35; cursor:default; }.directory-footer .forget-key { width:auto; border-radius:var(--radius-sm); padding:0 .5rem; color:var(--muted); font-size:.55rem; }.directory-footer span { color:var(--muted); font-size:.58rem; }.directory-footer .connection-chip { border-right:1px solid var(--line); padding-right:.55rem; color:var(--muted); }.directory-footer .connection-chip i { background:var(--status-ok); box-shadow:0 0 .35rem color-mix(in srgb,var(--status-ok) 65%,transparent); }
.model-form { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:.75rem; margin-top:.85rem; border:1px solid color-mix(in srgb,var(--accent) 35%,var(--line)); border-radius:var(--radius); background:color-mix(in srgb,var(--accent) 5%,var(--panel-raised)); padding:.85rem; }.model-form header { grid-column:1/-1; display:flex; align-items:start; justify-content:space-between; gap:1rem; }.model-form header h3 { margin:0 0 .2rem; font-size:.8rem; }.model-form header p { max-width:46rem; margin:0; color:var(--muted); font-size:.64rem; line-height:1.5; }.model-form header span { border:1px solid var(--accent); border-radius:2rem; padding:.3rem .5rem; color:var(--accent); font-size:.6rem; white-space:nowrap; }.model-form label,.search { display:grid; gap:.3rem; color:var(--muted); font-size:.62rem; }.model-form label > span,.search > span { color:var(--text); font-weight:600; }.model-form label.wide { grid-column:span 2; }.model-form input,.search input { min-width:0; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--bg); color:var(--text); padding:.52rem .6rem; font:inherit; outline:none; }.model-form input:focus,.search input:focus { border-color:var(--accent); box-shadow:0 0 0 2px var(--accent-soft); }.model-form small { line-height:1.35; }.create-model { align-self:end; min-height:2.1rem; border:1px solid var(--accent); border-radius:var(--radius-sm); background:var(--accent); color:var(--bg); cursor:pointer; font-weight:700; }
.catalog-tools { display:flex; align-items:end; justify-content:space-between; gap:.75rem; margin:.9rem 0 .65rem; }.search { width:min(17rem,38%); }.scope { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:.3rem; }.scope button { border:1px solid transparent; border-radius:2rem; background:transparent; color:var(--muted); padding:.38rem .55rem; cursor:pointer; font-size:.62rem; text-transform:capitalize; }.scope button:hover { background:var(--panel-raised); color:var(--text); }.scope button.active { border-color:var(--line); background:var(--panel-raised); color:var(--text); }.scope span { margin-left:.15rem; color:var(--muted); font-family:var(--mono); }
.model-palette { display:grid; grid-template-columns:repeat(auto-fit,minmax(14rem,1fr)); gap:.5rem; }.model-palette article { position:relative; display:flex; border:1px solid var(--line); border-radius:var(--radius); background:var(--panel-raised); overflow:hidden; }.model-palette article:hover { border-color:color-mix(in srgb,var(--accent) 55%,var(--line)); }.model-palette article.selected { border-color:var(--accent); background:var(--accent-soft); box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--accent) 30%,transparent); }.model-palette article.local::before { content:'LOCAL DRAFT'; position:absolute; top:.32rem; right:.38rem; color:var(--accent); font:600 .48rem/1 var(--mono); letter-spacing:.06em; }.model-choice { display:flex; align-items:center; gap:.6rem; width:100%; min-width:0; border:0; background:transparent; color:var(--text); padding:.65rem; text-align:left; cursor:grab; }.model-choice > span { min-width:0; display:grid; gap:.15rem; }.model-choice strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:.72rem; }.model-choice small { overflow:hidden; color:var(--muted); font-size:.57rem; line-height:1.35; text-overflow:ellipsis; white-space:nowrap; }.model-choice .drift { color:var(--status-escalated); }.remove-model { position:absolute; right:.35rem; bottom:.25rem; border:0; background:transparent; color:var(--muted); cursor:pointer; font-size:.9rem; }.remove-model:hover { color:var(--status-fail); }.empty-catalog { grid-column:1/-1; margin:0; border:1px dashed var(--line); border-radius:var(--radius); padding:2rem; color:var(--muted); text-align:center; font-size:.7rem; }
.model-palette article.benchmark::before { content:'CATALOG DRAFT'; }
.inline-alert,.setup-warning { border:1px solid var(--line); border-radius:var(--radius); background:var(--panel-raised); padding:.7rem; }.inline-alert { border-left:2px solid var(--accent); }.inline-alert.fail { border-left-color:var(--status-fail); }.inline-alert strong { font-size:.68rem; }.inline-alert p { margin:.2rem 0 0; color:var(--muted); font-size:.62rem; line-height:1.45; }.selected-model { display:flex; align-items:center; gap:.55rem; border:1px solid var(--accent); border-radius:var(--radius); background:var(--accent-soft); padding:.65rem; }.selected-model span { display:grid; gap:.1rem; min-width:0; }.selected-model small,.selected-model em { color:var(--muted); font-size:.56rem; font-style:normal; }.selected-model strong { font-size:.72rem; }.selected-model button { margin-left:auto; border:0; background:transparent; color:var(--muted); cursor:pointer; }.setup-warning { border-color:color-mix(in srgb,var(--status-escalated) 45%,var(--line)); background:color-mix(in srgb,var(--status-escalated) 5%,var(--panel-raised)); }.setup-warning header { display:flex; justify-content:space-between; color:var(--status-escalated); font-size:.66rem; font-weight:700; }.setup-warning header b { display:grid; place-content:center; width:1.25rem; height:1.25rem; border:1px solid currentColor; border-radius:50%; }.setup-warning p,.setup-warning small { color:var(--muted); font-size:.6rem; line-height:1.45; }.setup-warning ul { margin:.5rem 0; padding-left:1.1rem; color:var(--text); font-size:.61rem; line-height:1.6; }
.validation { display:grid; gap:.55rem; }.validation > header { display:flex; align-items:center; justify-content:space-between; }.validation h3,.bundle h3 { margin:.1rem 0; font-size:.78rem; }.validation header span { font-size:.62rem; }.validation ul { display:grid; gap:.35rem; margin:0; padding:0; list-style:none; }.validation li { display:flex; align-items:start; gap:.45rem; border:1px solid var(--line); border-radius:var(--radius-sm); padding:.5rem; }.validation li span { display:grid; gap:.12rem; }.validation li strong { font-size:.62rem; text-transform:capitalize; }.validation li small { color:var(--muted); font-size:.56rem; line-height:1.35; }.pass { color:var(--status-ok); }.fail,.error { color:var(--status-fail); }.refusals p { margin:.35rem 0; border-left:2px solid var(--status-fail); padding-left:.5rem; color:var(--status-fail); font-size:.6rem; line-height:1.4; }.diff { margin:.15rem 0; }.diff summary { color:var(--muted); cursor:pointer; font-size:.65rem; }.diff pre,.bundle pre { max-height:20rem; overflow:auto; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--bg); padding:.75rem; white-space:pre-wrap; font-size:.62rem; }.draft-actions { display:grid; grid-template-columns:1fr 1fr; gap:.45rem; }.draft-actions .compose { grid-column:1/-1; }.draft-actions button { min-height:2.35rem; }.compose { border:1px solid var(--accent); border-radius:var(--radius-sm); background:var(--accent); color:var(--bg); padding:.55rem .65rem; cursor:pointer; font-size:.67rem; font-weight:700; }.compose:disabled,.secondary:disabled { opacity:.38; cursor:not-allowed; }.publish-note { margin:0; color:var(--muted); font-size:.58rem; line-height:1.45; }.bundle { border-top:1px solid var(--line); padding:1rem; }.bundle p { color:var(--muted); font-size:.7rem; }.bundle small { color:var(--muted); }
@media (max-width: 1100px) { .roster-summary { grid-template-columns:repeat(4,1fr); }.roster-summary > p { grid-column:1/-1; border-top:1px solid var(--line); }.tier-grid { grid-template-columns:1fr; }.seat { grid-template-columns:7rem minmax(0,1fr) auto; }.studio-layout { grid-template-columns:1fr; }.catalog { border-right:0; border-bottom:1px solid var(--line); }.draft-panel { position:static; grid-template-columns:repeat(2,minmax(0,1fr)); }.draft-panel > header,.draft-actions,.publish-note { grid-column:1/-1; } }
@media (max-width: 760px) { .workflow { grid-template-columns:repeat(2,1fr); }.workflow li:nth-child(2) { border-right:0; }.workflow li:nth-child(-n+2) { border-bottom:1px solid var(--line); }.model-form { grid-template-columns:1fr 1fr; }.model-form label.wide { grid-column:span 1; }.catalog-tools { align-items:stretch; flex-direction:column; }.search { width:100%; }.scope { justify-content:flex-start; }.draft-panel { grid-template-columns:1fr; }.draft-panel > * { grid-column:1!important; }.directory-tools { grid-template-columns:1fr 1fr; }.source-meta { justify-items:start; }.directory-head { display:none; }.directory-list article { grid-template-columns:minmax(10rem,1.5fr) repeat(2,4rem) 3.5rem; }.directory-list article .price { grid-column:2; }.directory-list article .speed { grid-column:3; }.directory-list article > button { grid-column:4; grid-row:1/3; }.directory-footer { align-items:start; flex-direction:column; } }
@media (max-width: 620px) { .roster-summary { grid-template-columns:repeat(2,1fr); }.roster-summary article:nth-child(2) { border-right:0; }.section-intro { align-items:start; flex-direction:column; gap:.35rem; }.section-intro > p { text-align:left; }.seat { grid-template-columns:5rem minmax(0,1fr); }.health { grid-column:2; text-align:left; }.bands > header { align-items:start; flex-direction:column; gap:.35rem; }.bands header > p { text-align:left; }.band { grid-template-columns:1fr; }.band-name { border-right:0; border-bottom:1px solid var(--line); }.studio-title { align-items:start; flex-direction:column; }.model-form { grid-template-columns:1fr; }.model-form label,.model-form label.wide,.create-model { grid-column:1; }.workflow { grid-template-columns:1fr; }.workflow li { border-right:0; border-bottom:1px solid var(--line); }.workflow li:last-child { border-bottom:0; } }
</style>
