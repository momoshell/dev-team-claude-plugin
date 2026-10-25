<script>
  import { tick } from 'svelte'
  import { candidateExplanation, candidateMetrics, rosterRecommendation } from './roster-recommendation.js'
  import { replaceRosterMove, rosterChanges } from './roster-draft.js'
  import { applyRosterLadder, composeRosterLadder, getModelCatalog, getPluginWriteMode, getRosterLadder, getRosterPick, proposeRosterEdit, setModelCatalogKey, stageRosterLadder } from './api.js'
  import { directoryModelMatchesChip, directoryVariantLabel, fallbackModelName, groupDirectoryModels, providerDisplayName, selectedDirectoryVariant } from './model-directory.js'
  import { assuranceMeta } from './workflow-semantics.js'
  import { rosterPickPanel, rosterProposal } from './panels.js'
  import DiffBlock from './DiffBlock.svelte'
  import Dropdown from './Dropdown.svelte'

  const CHECK_NAMES = ['band_floor', 'vendor_diversity', 'breaker_state', 'cost_ceiling']
  const CHECK_LABELS = {
    band_floor:'Capability fit', vendor_diversity:'Provider mix',
    breaker_state:'Runtime health', cost_ceiling:'Cost guardrail',
  }
  const DRAFT_KEY = 'dev-team.roster-draft.v1'
  const DIRECTORY_SORTS = [
    { value:'intelligence', label:'Intelligence' }, { value:'coding', label:'Coding' },
    { value:'agentic', label:'Agentic' }, { value:'price_output', label:'Lowest output price' },
    { value:'output_tokens_per_second', label:'Output speed' },
  ]
  const EFFORT_OPTIONS = [
    { value:'low', label:'Low' }, { value:'medium', label:'Medium' },
    { value:'high', label:'High' }, { value:'xhigh', label:'Extra high' },
    { value:'max', label:'Max' },
  ]

  let payload = $state(null)
  let loading = $state(true)
  let requestError = $state('')
  let staged = $state([])
  let stagedResult = $state(null)
  let attemptResult = $state(null)
  let composed = $state(null)
  let rosterView = $state('assignments')
  let selectedTier = $state('build')
  let showUnassigned = $state(false)
  let modelSearch = $state('')
  let assignmentTrigger
  let selectedModel = $state(null)
  let assignmentDraft = $state(null)
  let staging = $state(false)
  let composing = $state(false)
  let applying = $state(false)
  let customModels = $state([])
  let clearedDraft = $state(null)
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
  let policyPicks = $state({})
  let pickProposals = $state({})
  let pickRevision = 0
  let catalogKeyError = $state('')
  let catalogKeyOpen = $state(false)
  let rememberCatalogKey = $state(true)
  let pluginWriteMode = $state(null)
  let pluginReadOnly = $derived(pluginWriteMode?.writable === false)
  let validationRevision = 0
  const DIRECTORY_PAGE_SIZE = 12

  function modelKey(cell) { return cell?.provider != null && cell?.id != null ? `${cell.provider}/${cell.id}` : null }
  function projectRail(baseRail, moves) {
    return baseRail.map((column) => {
      const tierMoves = moves.filter((move) => move.tier === column.tier)
      if (!tierMoves.length) return column
      const seats = new Map((column.seats || []).map((seat) => [seat.role, { ...seat }]))
      const unseated = new Set(column.unseated || [])
      for (const move of tierMoves) {
        unseated.delete(move.role)
        if (move.cell === null) { seats.delete(move.role); unseated.add(move.role) }
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
  let failedChecks = $derived((visibleResult?.checks || []).filter((check) => !check.ok))
  let publishReady = $derived(Boolean(stagedResult?.ok) && !containsCustomMoves)
  let localReady = $derived(Boolean(staged.length) && !containsCustomMoves && Boolean(visibleResult?.local_apply_allowed))
  let filteredChips = $derived(chips.filter((chip) => {
    const query = catalogQuery.trim().toLowerCase()
    const inScope = catalogScope === 'all' || (catalogScope === 'local' ? chip.local_draft : chip.band === catalogScope)
    return inScope && (!query || `${chip.key} ${chip.band || ''}`.toLowerCase().includes(query))
  }))
  let draftCount = $derived(staged.length + customModels.length)
  let changes = $derived(rosterChanges(payload?.rail || [], staged))
  let activeColumn = $derived(rail.find((column) => column.tier === selectedTier) || rail[0])
  let assignmentChoices = $derived(chips.filter((chip) => !modelSearch.trim() || `${chip.key} ${chip.band || ''}`.toLowerCase().includes(modelSearch.trim().toLowerCase())))
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

  function pickKey(tier, role) { return `${tier}\u001f${role}` }
  function seatRows(column) {
    return [
      ...(column?.seats || []).map((seat) => ({ ...seat, assigned:true })),
      ...(column?.unseated || []).map((role) => ({ role, assigned:false, model_key:null, cell:null })),
    ]
  }
  function pickFor(tier, role) { return policyPicks[pickKey(tier, role)] || null }
  function proposalFor(tier, role) { return pickProposals[pickKey(tier, role)] || null }

  $effect(() => {
    let active = true
    getPluginWriteMode().then((result) => {
      if (!active) return
      pluginWriteMode = result
      if (result.writable === false) rememberCatalogKey = false
    }).catch(() => {})
    return () => { active = false }
  })

  async function reloadRoster() {
    loading = true; requestError = ''
    try { payload = await getRosterLadder(); pickRevision += 1; policyPicks = {} }
    catch (err) { requestError = err.message || 'Roster request failed'; payload = { degraded:true, error:requestError } }
    finally { loading = false }
  }
  $effect(() => { void reloadRoster() })

  async function loadPick(tier, role, retry = false) {
    const key = pickKey(tier, role)
    if (policyPicks[key] && !retry) return
    const revision = pickRevision
    policyPicks = { ...policyPicks, [key]: { loading:true, pick:null, error:null } }
    try {
      const result = await getRosterPick(tier, role)
      if (revision !== pickRevision) return
      policyPicks = { ...policyPicks, [key]: { loading:false, pick:rosterPickPanel(result), error:null } }
    } catch (err) {
      if (revision !== pickRevision) return
      policyPicks = { ...policyPicks, [key]: { loading:false, pick:null, error:err.message || 'Routing evidence unavailable' } }
    }
  }

  $effect(() => {
    let active = true
    getModelCatalog().then((result) => { if (active) directory = result }).catch((err) => {
      if (active) directory = { configured:true, models:null, absent:err.message || 'model catalog request failed', source:'OpenRouter', source_url:'https://openrouter.ai/api/v1/models' }
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
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ moves: staged, models: customModels, saved_at: new Date().toISOString() })) }
    catch { draftNotice = 'Browser storage is unavailable. Keep this page open or copy the draft before leaving.' }
  })

  function chipFor(key) { return chips.find((chip) => chip.key === key) || null }
  function modelName(key) { return String(key || '').split('/').at(-1) || 'Unassigned' }
  function provider(key) { return String(key || '').split('/')[0] || 'none' }
  function providerMark(key) { return provider(key).slice(0, 2).toUpperCase() }
  function directoryModelForChip(chip) { return directoryFamilies.find((model) => directoryModelMatchesChip(model, chip)) || null }
  function capabilityModel(key) {
    const chip = chipFor(key) || { key, provider:provider(key), id:modelName(key) }
    const directoryModel = directoryModelForChip(chip)
    const providerName = directoryModel?.creator || providerDisplayName(chip.provider)
    return {
      name:directoryModel?.name || fallbackModelName(chip.id),
      provider:providerName,
      providerKey:chip.provider || provider(key),
      mark:providerName.slice(0, 2).toUpperCase(),
    }
  }
  function roleColor(role) { return `var(--${role}-color)` }
  function money(value) { return value == null ? '—' : value === 0 ? '$0.00' : value < 0.001 ? '<$0.001' : value < 0.01 ? `$${value.toFixed(3)}` : `$${value.toFixed(2)}` }
  function score(value) { return value == null ? '—' : Number(value).toFixed(1) }
  function suggestedBand(intelligence) {
    if (intelligence == null) return null
    return [...(payload?.bands || [])].sort((left, right) => right.rank - left.rank).find((band) => intelligence >= band.floor_reference_score)?.band || 'basement'
  }
  function catalogConnectionState() {
    if (directory?.artificial_analysis_unavailable) return 'Artificial Analysis not loading'
    if (directory?.credential_source === 'environment') return 'Connected · .env.local'
    if (directory?.credential_source === 'session') return 'Connected · temporary key'
    return 'OpenRouter listing · Artificial Analysis not connected'
  }
  function directoryChip(model) { return chips.find((chip) => directoryModelMatchesChip(model, chip)) || null }
  function directoryModelState(model) {
    const variant = selectedDirectoryVariant(model, directorySelections)
    if (variant?.runtime_id == null) return { known:true, noRuntime:true, label:'No runtime listing' }
    const chip = directoryChip(variant)
    return chip ? { known:true, noRuntime:false, label:chip.local_draft ? 'In draft' : 'In roster' } : { known:false, noRuntime:false, label:'Add to draft' }
  }
  function sourceCell(chip, target, effort = null) {
    const source = rail.flatMap((column) => column.seats || []).find((seat) => seat.model_key === chip.key)?.cell
    const agent = chip.local_draft ? 'pi' : modelKey(target?.cell) === chip.key ? target.cell.agent : (source?.agent || target?.cell?.agent || 'pi')
    const selectedEffort = effort || chip.reasoning_effort || target?.cell?.effort || source?.effort || 'medium'
    return { ...(modelKey(target?.cell) === chip.key ? target.cell : {}), provider:chip.provider, id:chip.id, agent, effort:selectedEffort }
  }
  function beginAssignment(tier, role, key) {
    if (applying || composing) return
    const target = rail.find((column) => column.tier === tier)?.seats?.find((seat) => seat.role === role)
    const chosen = key || target?.model_key || null
    const chip = chipFor(chosen)
    const cell = chip ? sourceCell(chip, target) : target?.cell
    assignmentTrigger = document.activeElement
    modelSearch = ''
    assignmentDraft = { tier, role, key:chosen, effort:cell?.effort || 'medium', agent:cell?.agent || 'pi', previousEffort:target?.cell?.effort || null }
  }
  function assignmentModal(node) {
    node.showModal()
    node.querySelector('input')?.focus()
    return { destroy() { node.close(); assignmentTrigger?.focus() } }
  }
  function closeAssignment() { assignmentDraft = null }
  function chooseAssignment(key) {
    const chip = chipFor(key)
    const target = rail.find((column) => column.tier === assignmentDraft.tier)?.seats?.find((seat) => seat.role === assignmentDraft.role)
    const cell = sourceCell(chip, target, assignmentDraft.effort)
    assignmentDraft = { ...assignmentDraft, key, agent:cell.agent }
  }
  function chooseModel(key) {
    selectedModel = key
    rosterView = 'assignments'
    assignmentDraft = null
  }
  async function undoMove(tier, role) {
    if (applying || composing) return
    validationRevision += 1
    staged = staged.filter((move) => move.tier !== tier || move.role !== role)
    stagedResult = null; attemptResult = null; composed = null; staging = false
    draftNotice = 'Change removed from the draft.'
    if (staged.length && !staged.some((move) => customKeys.has(modelKey(move.cell)))) await validateDraft()
  }
  async function applyAssignment() {
    if (!assignmentDraft?.key || applying || composing) return
    const { tier, role, key, effort } = assignmentDraft
    assignmentDraft = null
    await move(tier, role, key, effort)
    await tick()
    document.getElementById('roster-draft-heading')?.focus()
  }
  async function move(tier, role, key, effort = null) {
    const chip = chipFor(key)
    if (!chip?.id) return
    const target = rail.find((column) => column.tier === tier)?.seats?.find((seat) => seat.role === role)
    if (applying || composing) return
    clearedDraft = null
    const next = replaceRosterMove(payload?.rail || [], staged, { tier, role, cell:sourceCell(chip, target, effort) })
    const revision = ++validationRevision
    staged = next
    stagedResult = null
    attemptResult = null
    composed = null
    requestError = ''
    staging = false
    selectedModel = null
    draftNotice = next.length ? `${modelName(chip.key)} is in the draft. Apply when you are ready.` : 'This matches the current roster. No change is needed.'
    if (!next.length) return
    if (chip.local_draft || next.some((candidate) => customKeys.has(modelKey(candidate.cell)))) {
      return
    }
    staging = true
    try {
      const result = await stageRosterLadder(next)
      if (revision !== validationRevision) return
      attemptResult = result
      stagedResult = result.ok ? result : null
      const recommendationCount = result.checks?.filter((check) => !check.ok).length || result.refusals?.length || 0
      draftNotice = result.ok
        ? `${modelName(chip.key)} is saved in the private draft and passes the activation checks.`
        : result.local_apply_allowed
          ? `${modelName(chip.key)} is saved with ${recommendationCount || 1} policy warning${recommendationCount === 1 ? '' : 's'}. You can apply it locally for testing; repository sharing remains paused.`
          : `${modelName(chip.key)} is saved in the private draft. Resolve the readiness guidance before activation or sharing.`
    } catch (err) {
      if (revision === validationRevision) requestError = err.message || 'roster guidance could not be loaded'
    } finally {
      if (revision === validationRevision) staging = false
    }
  }
  async function proposePolicyPick(column, seat, pick) {
    if (!pick?.chosen_cell) return
    const key = pickKey(column.tier, seat.role)
    pickProposals = { ...pickProposals, [key]: { loading:true, response:null, error:null } }
    try {
      const response = await proposeRosterEdit(column.tier, seat.role, pick.chosen_cell)
      pickProposals = { ...pickProposals, [key]: { loading:false, response, error:null } }
    } catch (err) {
      pickProposals = { ...pickProposals, [key]: { loading:false, response:null, error:err.message || 'roster pick proposal failed' } }
    }
  }
  function drop(event, tier, role) { event.preventDefault(); beginAssignment(tier, role, event.dataTransfer?.getData('text/plain')) }
  function dragStart(event, chip) { event.dataTransfer?.setData('text/plain', chip.key); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move' }
  function addLocalModel(event) {
    event.preventDefault()
    if (applying || composing) return
    clearedDraft = null
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
    rosterView = 'assignments'
    addModelOpen = false
    draftNotice = `${key} was added to this browser draft. Choose a seat above to try it.`
    modelForm = { ...modelForm, id:'' }
  }
  function addDirectoryModel(model) {
    if (applying || composing) return
    clearedDraft = null
    const variant = selectedDirectoryVariant(model, directorySelections)
    if (!variant?.runtime_id) { draftNotice = `${model.name} has no OpenRouter runtime listing and cannot be added.`; return }
    const key = variant.runtime_id
    if (directoryChip(variant)) { draftNotice = `${model.name} is already in the roster or draft.`; return }
    customModels = [...customModels, {
      key, provider:variant.runtime_id.split('/')[0], id:variant.runtime_id.split('/').slice(1).join('/'), band:suggestedBand(variant.intelligence),
      local_draft:true, benchmark_draft:true, source_id:variant.source_id, source:'OpenRouter',
      reasoning_effort:variant.reasoning_effort, reasoning_mode:variant.reasoning_mode, benchmark_variant:variant.benchmark_variant,
      context:variant.context_window_tokens ?? variant.context_length, cost_in_per_mtok:variant.price_input, cost_out_per_mtok:variant.price_output,
      cost_cache_read_per_mtok:variant.price_cache_hit, intelligence:variant.intelligence, coding:variant.coding, agentic:variant.agentic,
      reference:variant.intelligence, reference_pending:variant.intelligence == null ? variant.score_absent_reason : null,
      measured:null, measured_pending:'Not yet measured by this factory', seated_at:[],
    }]
    selectedModel = key
    rosterView = 'assignments'
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
    if (applying || composing) return
    validationRevision += 1
    customModels = customModels.filter((model) => model.key !== key)
    staged = staged.filter((move) => modelKey(move.cell) !== key)
    stagedResult = null; attemptResult = null; composed = null; staging = false
    if (selectedModel === key) selectedModel = null
    if (assignmentDraft?.key === key) assignmentDraft = null
    draftNotice = `${key} was removed from the local draft.`
  }
  function resetDraft() {
    if (applying || composing) return
    clearedDraft = { moves:staged, models:customModels }
    validationRevision += 1
    staged = []; customModels = []; selectedModel = null; assignmentDraft = null; stagedResult = null; attemptResult = null; composed = null; staging = false
    draftNotice = 'Local roster draft cleared.'
  }
  async function restoreDraft() {
    if (!clearedDraft || applying || composing) return
    staged = clearedDraft.moves; customModels = clearedDraft.models; clearedDraft = null
    draftNotice = 'Draft restored.'
    if (staged.length && !staged.some((move) => customKeys.has(modelKey(move.cell)))) await validateDraft()
  }
  async function exportDraft() {
    const text = JSON.stringify({ models:customModels, moves:staged }, null, 2)
    try { await navigator.clipboard.writeText(text); draftNotice = 'Draft JSON copied to the clipboard.' }
    catch { draftNotice = 'Clipboard access was unavailable. Your draft is still saved locally.' }
  }
  async function validateDraft() {
    if (!staged.length || containsCustomMoves || applying || composing) return
    const revision = ++validationRevision
    staging = true; requestError = ''; composed = null
    try {
      const result = await stageRosterLadder(staged)
      if (revision !== validationRevision) return
      attemptResult = result
      stagedResult = result.ok ? result : null
      draftNotice = result.ok
        ? 'This draft is ready to apply locally or prepare as a repository patch.'
        : result.local_apply_allowed
          ? 'This draft has policy warnings. You can apply it anyway for the next local task; resolve the warnings before preparing a repository patch.'
          : 'The draft is still saved. Resolve the readiness guidance below before activation or sharing.'
    } catch (err) {
      if (revision === validationRevision) requestError = err.message || 'roster guidance could not be loaded'
    } finally {
      if (revision === validationRevision) staging = false
    }
  }
  async function compose() {
    if (!publishReady) return
    composing = true; requestError = ''
    try { composed = await composeRosterLadder(staged) } catch (err) { requestError = err.message || 'roster ladder compose failed'; composed = null } finally { composing = false }
  }
  async function applyLocal() {
    if (!localReady || applying) return
    applying = true; requestError = ''; composed = null
    try {
      const result = await applyRosterLadder(staged, { allowWarnings:!visibleResult?.ok })
      if (!result.applied) {
        attemptResult = result
        stagedResult = null
        draftNotice = result.refusals?.[0]?.message || result.error || 'The local roster was not changed.'
        return
      }
      validationRevision += 1
      staged = []; selectedModel = null; assignmentDraft = null; stagedResult = null; attemptResult = null; composed = null
      draftNotice = result.warnings_overridden
        ? 'Applied locally with policy warnings. The next newly booted task will try these seat settings; running tasks and the remote repository were not changed.'
        : 'Applied locally. The next newly booted task will use these seat settings; running tasks and the remote repository were not changed.'
      try { payload = await getRosterLadder(); pickRevision += 1; policyPicks = {} }
      catch (err) { requestError = `The roster was applied, but the refreshed view could not load: ${err.message || 'unknown error'}` }
    } catch (err) { requestError = err.message || 'local roster apply failed' }
    finally { applying = false }
  }
</script>

<div class="roster-shell">
  <nav class="roster-views" aria-label="Roster views">
    <button type="button" aria-pressed={rosterView === 'assignments'} onclick={() => rosterView = 'assignments'}>Role assignments{#if staged.length}<span>{staged.length} pending</span>{/if}</button>
    <button type="button" aria-pressed={rosterView === 'models'} onclick={() => rosterView = 'models'}>Browse models</button>
  </nav>
  <p class="draft-feedback" role="status">{draftNotice}</p>
  {#if clearedDraft}<button type="button" class="restore-draft" disabled={applying || composing} onclick={restoreDraft}>Undo clear draft</button>{/if}
  {#if pluginReadOnly && pluginWriteMode.notice}<section class="notice" role="status"><p>{pluginWriteMode.notice}</p></section>{/if}
  {#if loading}<p role="status">Loading roster…</p>
  {:else if payload?.degraded}<section class="notice"><h2>Roster unavailable</h2><p>{payload.error || requestError}</p><button type="button" onclick={reloadRoster}>Retry roster</button></section>
  {:else if rosterView === 'assignments'}
    <div class="roster-workspace">
      <section class="profile-area" aria-labelledby="assurance-presets-title">
        <header class="section-intro"><h2 id="assurance-presets-title">Who does the work</h2><p>Choose an assurance preset, then change the model for a role.</p></header>
        <nav class="preset-tabs" aria-label="Assurance preset">{#each rail as column}<button type="button" aria-pressed={activeColumn?.tier === column.tier} onclick={() => selectedTier = column.tier}>{assuranceMeta(column.tier).label}</button>{/each}</nav>
        {#if selectedModel}<div class="selection-callout"><p><strong>{modelName(selectedModel)}</strong> selected. Choose a role to assign it.</p><button type="button" onclick={() => selectedModel = null}>Cancel selection</button></div>{/if}
        {#if activeColumn}
          {@const column = activeColumn}
          {@const assurance = assuranceMeta(column.tier)}
          <p class="preset-description">{assurance.summary} <a href="#/assurances">Assurance rules →</a></p>
          {#if column.unseated?.length}<button type="button" class="unassigned-toggle" aria-expanded={showUnassigned} onclick={() => showUnassigned = !showUnassigned}>{showUnassigned ? 'Hide unassigned roles' : `Show ${column.unseated.length} unassigned role${column.unseated.length === 1 ? '' : 's'}`}</button>{/if}
          <div class="seats">
            {#each seatRows(column).filter((seat) => seat.assigned || showUnassigned) as seat (seat.role)}
              {@const changed = staged.some((move) => move.tier === column.tier && move.role === seat.role)}
              {@const pickEntry = pickFor(column.tier, seat.role)}
              {@const pick = pickEntry?.pick}
              {@const recommendation = rosterRecommendation(pick)}
              {@const proposalEntry = proposalFor(column.tier, seat.role)}
              {@const proposal = rosterProposal(proposalEntry?.response)}
              <article class="seat-row" class:changed>
                <div class="seat-summary" ondragover={(event) => event.preventDefault()} ondrop={(event) => drop(event, column.tier, seat.role)} role="group" aria-label={`${assurance.label} ${seat.role}`}>
                  <div class="role-name"><strong>{seat.role}</strong>{#if changed}<span class="pending-label">Draft change</span>{/if}</div>
                  <div class="assigned-model"><strong>{seat.assigned ? modelName(seat.model_key) : 'Unassigned'}</strong><small>{seat.assigned ? `${providerDisplayName(provider(seat.model_key))} · ${seat.cell?.effort || 'unrecorded'} effort · ${seat.cell?.agent || 'adapter unrecorded'}` : 'No model configured for this role.'}</small></div>
                  <button type="button" class="change-model" disabled={applying || composing} aria-label={`Change model for ${assurance.label} ${seat.role}`} onclick={() => beginAssignment(column.tier, seat.role, selectedModel || seat.model_key)}>Change model</button>
                </div>
                <details class="pick-explanation" ontoggle={(event) => { if (event.currentTarget.open) void loadPick(column.tier, seat.role) }} aria-label={`Model recommendation for ${assurance.label} ${seat.role}`}>
                  <summary>Model recommendation</summary>
                  {#if pickEntry?.loading}<p class="pick-muted" role="status">Checking recommendation…</p>
                  {:else if pickEntry?.error || pick?.unavailable}
                    <p class="pick-result">Recommendation unavailable</p>
                    <p class="pick-muted">We couldn’t read the recommendation. You can still change the model manually.</p>
                    <button type="button" onclick={() => loadPick(column.tier, seat.role, true)}>Retry recommendation</button>
                  {:else if pick}
                    <div class="recommendation-summary" class:has-suggestion={recommendation.suggested}>
                      <strong>{recommendation.title}</strong>
                      {#if recommendation.chosen}<p class="suggested-model">{recommendation.chosen.id}<span>{providerDisplayName(recommendation.chosen.provider)} · {recommendation.chosen.effort} effort · {recommendation.chosen.agent}</span></p>{/if}
                      <p>{recommendation.description}</p>
                      {#if changed}<p class="draft-basis">Based on the saved roster. Your pending change has not been evaluated.</p>{/if}
                    </div>
                    {#if pick.policy_candidates?.length}
                      <details class="pick-candidates">
                        <summary>Candidate details · {pick.policy_candidates.length}</summary>
                        <p class="pick-muted">Only models configured in the routing policy are considered. Evaluations must match the role, model, adapter and effort.</p>
                        {#each pick.policy_candidates as candidate (candidate.policy_order)}
                          <article>
                            <strong>{candidate.cell?.id || 'Unidentified model'}</strong>
                            <span>{providerDisplayName(candidate.cell?.provider)} · {candidate.cell?.effort || 'unrecorded'} effort · {candidate.cell?.agent || 'adapter unrecorded'}</span>
                            <p>{candidateExplanation(candidate)}</p>
                            {#each candidateMetrics(candidate) as fact}<span>{fact}</span>{/each}
                          </article>
                        {/each}
                        {#if pick.eval_cells?.length}
                          <details class="pick-evidence"><summary>Technical details · {pick.eval_cells.length} evaluation record{pick.eval_cells.length === 1 ? '' : 's'}</summary><p class="pick-muted">Recorded evaluation data used to assess these candidates.</p><pre>{JSON.stringify(pick.eval_cells, null, 2)}</pre></details>
                        {/if}
                      </details>
                    {/if}
                    {#if recommendation.suggested}
                      <button type="button" class="propose-pick" disabled={proposalEntry?.loading} onclick={() => proposePolicyPick(column, seat, pick)}>{proposalEntry?.loading ? 'Preparing preview…' : 'Preview suggested change'}</button>
                    {/if}
                    {#if proposalEntry?.error}<p class="pick-unavailable">{proposalEntry.error}</p>{/if}
                    {#if proposal.diff !== null}<DiffBlock text={proposal.diff} empty="(no roster change)" label="Suggested roster change" />{/if}
                  {/if}
                </details>
              </article>
            {/each}
          </div>
        {/if}
        <p class="roster-help">Drafts are saved in this browser. Apply changes when you are ready.</p>
      </section>
      <aside class="draft-panel" aria-label="Pending roster changes">
        <header><h2 id="roster-draft-heading" tabindex="-1">{changes.length ? `${changes.length} pending change${changes.length === 1 ? '' : 's'}` : 'No pending changes'}</h2></header>
        {#if !draftCount}<p>Use <strong>Change model</strong> beside a role to get started.</p>{/if}
        {#if requestError}<div class="inline-alert fail" role="alert"><p>{requestError} Your draft is saved. Try Check readiness again.</p></div>{/if}
        {#if changes.length}<ul class="change-list">{#each changes as change (change.tier + change.role)}<li><div><strong>{assuranceMeta(change.tier).label} · {change.role}</strong><span>{modelName(change.beforeKey)} · {change.before?.effort || 'no effort'}</span><span class="change-after">→ {modelName(change.afterKey)} · {change.cell?.effort || 'no effort'}</span></div><button type="button" disabled={applying || composing} aria-label={`Undo ${assuranceMeta(change.tier).label} ${change.role} change`} onclick={() => undoMove(change.tier, change.role)}>Undo</button></li>{/each}</ul>{/if}
        {#if customModels.length}<div class="setup-warning"><strong>{customModels.length} model{customModels.length === 1 ? '' : 's'} need setup</strong><p>Catalog and manual additions stay in the browser draft until their provider and model metadata are configured.</p><button type="button" onclick={() => { rosterView = 'models'; catalogMode = 'roster' }}>Review added models</button></div>{/if}
                  {#if visibleResult && !containsCustomMoves}
            <section class="validation"><header><div><p class="micro">Activation check</p><h3>Roster readiness</h3></div><span class:pass={visibleResult.ok} class:advice={!visibleResult.ok}>{visibleResult.ok ? 'Ready' : visibleResult.local_apply_allowed ? `${failedChecks.length || 1} warning${failedChecks.length === 1 ? '' : 's'}` : `${failedChecks.length || visibleResult.refusals?.length || 1} to review`}</span></header>
              <p class="guidance-intro">Policy warnings do not block a local experiment. Repository patches stay strict, and structurally invalid seats still cannot be activated.</p>
              <ul>{#each failedChecks as check (check.check)}<li class:pass={check.ok} class:advice={!check.ok}><b>{check.ok ? '✓' : '!'}</b><span><strong>{CHECK_LABELS[check.check] || check.check.replaceAll('_',' ')}</strong><small>{check.message}</small><em>{check.ok ? 'Within current policy' : visibleResult.local_apply_allowed ? 'Warning · blocks repository patch' : 'Resolve before activation'}</em></span></li>{/each}</ul>
              <details><summary>All readiness checks</summary><ul>{#each visibleResult.checks || [] as check (check.check)}<li><span><strong>{CHECK_LABELS[check.check] || check.check.replaceAll('_',' ')} · {check.ok ? 'Passed' : 'Needs review'}</strong><small>{check.message}</small></span></li>{/each}</ul></details>
              {#if visibleResult.refusals?.length}<div class="refusals"><strong>{visibleResult.local_apply_allowed ? 'Warnings for this local experiment' : 'Why activation is paused'}</strong>{#each visibleResult.refusals as refusal (refusal.code + refusal.message)}<p>{refusal.message}</p>{/each}</div>{/if}
              {#if (visibleResult.diff ?? visibleResult.local_diff) !== null}<details class="diff"><summary>Preview roster diff</summary><DiffBlock text={visibleResult.diff ?? visibleResult.local_diff} empty="(no roster change)" label="Roster draft diff" /></details>{/if}
            </section>
          {/if}

        {#if containsCustomMoves}<p class="activation-note">Complete model setup before applying this draft. Custom models require a configured provider, exact model ID and ratified capability band.</p>{/if}
        {#if draftCount}
          <div class="draft-actions"><button type="button" class="secondary" disabled={!staged.length || containsCustomMoves || staging || applying || composing} onclick={validateDraft}>{staging ? 'Checking…' : 'Check readiness'}</button><button class="apply-local" type="button" disabled={pluginReadOnly || !localReady || staging || applying || composing} onclick={applyLocal}>{applying ? 'Applying…' : localReady && !publishReady ? 'Apply anyway for next task' : 'Apply for next task'}</button></div>
          <p class="publish-note">Changes apply on this machine to the next newly booted task. Running tasks continue unchanged.</p>
          <details class="draft-options"><summary>Export &amp; draft options</summary><button type="button" class="secondary" onclick={exportDraft}>Copy experiment draft</button><button class="secondary prepare-patch" type="button" disabled={!publishReady || staging || applying || composing} onclick={compose}>{composing ? 'Preparing…' : 'Prepare repository patch'}</button><button type="button" class="secondary" disabled={applying || composing} onclick={resetDraft}>Clear draft</button><p>Applying creates no branch, commit, PR, or remote push. A repository patch requires all readiness checks to pass.</p></details>
        {/if}
        {#if composed?.ok}<section class="bundle"><h3>Repository-ready bundle</h3><p>{composed.branch} · {composed.commit_subject}</p><DiffBlock text={composed.patch} empty="(no roster change)" label="Repository-ready roster patch" /><small>No PR was created.</small></section>{/if}
      </aside>
    </div>
        <details class="bands"><summary>Capability bands &amp; roster metadata</summary>
      <header><div><p class="micro">Model suitability</p><h2>Capability bands</h2></div><p><strong>Separate from assurance.</strong> Bands recommend model capability; local and unmeasured are evidence states, not extra bands.</p></header>
      <div class="band-list">
        {#each payload.bands || [] as band (band.band)}
          <article class={`band ${band.band}`}><span class="band-name"><b>{band.band}</b><small>reference floor {band.floor_reference_score}</small></span><div>{#each band.members as key (key)}{@const display = capabilityModel(key)}<span class="model-pill" title={key}><b class={`provider ${display.providerKey}`}>{display.mark}</b><span><strong>{display.name}</strong><small>{display.provider}</small></span></span>{/each}</div></article>
        {/each}
      </div>
    <p>Ratified {payload.ratified_at || 'date unavailable'} · {payload.ratified_by || 'owner unavailable'}. {seatCount} assigned roles across {rail.length} presets, using {uniqueModels} models.</p></details>


  {:else}
            <div class="catalog">
          <div class="studio-heading">
            <div><h3>Model catalog</h3><p>Search models, compare available measurements, or choose one for a role.</p></div>
            {#if catalogMode === 'roster'}<button type="button" class="add-model" onclick={() => addModelOpen = !addModelOpen}>{addModelOpen ? 'Close form' : '+ Add manually'}</button>{/if}
          </div>

          <div class="catalog-tabs"  aria-label="Model catalog views">
            <button type="button" aria-pressed={catalogMode === 'discover'} class:active={catalogMode === 'discover'} onclick={() => catalogMode = 'discover'}>Discover models</button>
            <button type="button" aria-pressed={catalogMode === 'roster'} class:active={catalogMode === 'roster'} onclick={() => catalogMode = 'roster'}>Configured models <span>{chips.length}</span></button>
          </div>

          {#if catalogMode === 'discover'}
            {#if directoryLoading}
              <div class="directory-loading"><span></span><p>Loading the OpenRouter model listing and optional intelligence scores…</p></div>
            {:else}
              {#if directory?.configured === false || directory?.artificial_analysis_unavailable || !directory?.models}
              <details class="source-setup"><summary>Optional benchmark connection &amp; API key</summary>
                <header>
                  <span class:warning={directory?.configured} class="source-state"><i></i>{directory?.configured ? 'Connection needs attention' : 'Model intelligence not configured'}</span>
                  <a href="https://artificialanalysis.ai/data-api" target="_blank" rel="noreferrer">Get a key ↗</a>
                </header>
                <div class="source-message">
                  <div><h3>{directory?.configured ? 'Artificial Analysis could not load' : 'Connect model intelligence'}</h3><p>{catalogKeyError || directory?.artificial_analysis_absent || directory?.absent}</p></div>
                  <button type="button" class="temporary-key" aria-expanded={catalogKeyOpen} onclick={() => catalogKeyOpen = !catalogKeyOpen}>{catalogKeyOpen ? 'Cancel' : directory?.configured ? 'Replace key' : 'Add API key'}</button>
                </div>
                <p class="persistent-hint"><b>Persistent by default.</b> Keep “Remember on this machine” selected to save the key in the ignored <code>.env.local</code> file. Uncheck it for this server run only.</p>
                {#if catalogKeyOpen}
                  <form onsubmit={connectCatalog}>
                    <label><span>Artificial Analysis API key</span><div><input type="password" bind:value={catalogKey} autocomplete="off" placeholder="Paste key…" aria-describedby="catalog-key-note" /><button type="submit" disabled={connectingCatalog}>{connectingCatalog ? 'Connecting…' : rememberCatalogKey ? 'Save & connect' : 'Connect for this run'}</button></div></label>
                    <label class="remember-key"><input type="checkbox" bind:checked={rememberCatalogKey} disabled={pluginReadOnly} /><span><b>Remember on this machine</b><small>Save to the git-ignored <code>.env.local</code> file and reconnect automatically after restarts.</small></span></label>
                  </form>
                  <small id="catalog-key-note">{rememberCatalogKey ? 'Only the named environment variable is updated; the key is never returned to the browser.' : 'Temporary mode holds the key only in local server memory until it restarts.'}</small>
                {/if}
              </details>
              {/if}
              {#if directory?.models}
              <div class="directory-tools">
                <label class="search"><span>Find a model</span><input bind:value={directoryQuery} oninput={() => directoryPage = 1} placeholder="Grok, Kimi, GLM, Gemma…" /></label>
                <label class="sort"><span>Sort by</span><Dropdown bind:value={directorySort} options={DIRECTORY_SORTS} onchange={() => directoryPage = 1} ariaLabel="Sort model catalog" /></label>
                <div class="source-meta"><strong>{directoryModels.length}</strong><span>models · Index v{directory.intelligence_index_version ?? '—'}</span></div>
              </div>
              <p class="catalog-units">Benchmark scores compare models; they do not measure your tasks. New models need runtime setup before use.</p>
              <div class="directory-list">
                {#each visibleDirectoryModels as model (model.family_key)}
                  {@const variant = activeDirectoryVariant(model)}
                  {@const modelState = directoryModelState(model)}
                  {@const taskScore = directorySort === 'agentic' ? variant.agentic : variant.coding}
                  <article class="directory-card">
                    <header class="directory-card-header">
                      <div class="directory-name"><b class="provider" aria-hidden="true">{model.creator.slice(0,2).toUpperCase()}</b><div><h4>{model.name}</h4><p>{providerDisplayName(model.creator)}{model.release_date ? ` · Released ${model.release_date}` : ''}</p></div></div>
                      <button type="button" class="directory-add" disabled={modelState.known || modelState.noRuntime} aria-label={`${modelState.label}: ${model.name}`} onclick={() => addDirectoryModel(model)}>{modelState.label}</button>
                    </header>
                    <div class="benchmark-setting">
                      {#if model.variant_count > 1}<label class="effort-control"><span>Benchmark effort</span><Dropdown value={variant.source_id} options={directoryVariantOptions(model)} onchange={(value) => chooseDirectoryVariant(model, value)} ariaLabel={`Reasoning effort for ${model.name}`} width="8rem" variant="pill" /></label>{:else if variant.reasoning_effort || variant.reasoning_mode}<span>Benchmark effort <strong>{directoryVariantLabel(variant)}</strong></span>{:else}<span>Benchmark effort not reported</span>{/if}
                    </div>
                    <dl class="catalog-metrics">
                      <div class:metric-featured={directorySort === 'intelligence'}><dt>Intelligence</dt><dd class:metric-absent={variant.intelligence == null}>{variant.intelligence == null ? 'Not measured' : score(variant.intelligence)}</dd><small>AA Index</small></div>
                      <div class:metric-featured={directorySort === 'coding' || directorySort === 'agentic'}><dt>{directorySort === 'agentic' ? 'Agentic' : 'Coding'}</dt><dd class:metric-absent={taskScore == null}>{taskScore == null ? 'Not measured' : score(taskScore)}</dd><small>AA benchmark</small></div>
                      <div><dt>Input price</dt><dd class:metric-absent={variant.price_input == null}>{variant.price_input == null ? 'Not listed' : money(variant.price_input)}</dd><small>/ 1M tokens</small></div>
                      <div class:metric-featured={directorySort === 'price_output'}><dt>Output price</dt><dd class:metric-absent={variant.price_output == null}>{variant.price_output == null ? 'Not listed' : money(variant.price_output)}</dd><small>/ 1M tokens</small></div>
                      <div class:metric-featured={directorySort === 'output_tokens_per_second'}><dt>Output speed</dt><dd class:metric-absent={variant.output_tokens_per_second == null}>{variant.output_tokens_per_second == null ? 'Not measured' : Math.round(variant.output_tokens_per_second)}</dd><small>tokens / second</small></div>
                    </dl>
                  </article>
                {/each}
                {#if !visibleDirectoryModels.length}<p class="empty-catalog">No models match this search. Clear the search to see all models.</p>{/if}
              </div>
              <footer class="directory-footer">
                <p>Current model listings, runtime IDs, context windows, and token prices from <a href={directory.openrouter_source_url || 'https://openrouter.ai/api/v1/models'} target="_blank" rel="noreferrer">OpenRouter ↗</a>. Optional intelligence, coding, and performance scores from <a href={directory.artificial_analysis_source_url || 'https://artificialanalysis.ai/'} target="_blank" rel="noreferrer">Artificial Analysis ↗</a>. Null means not measured—not zero.{directory.stale ? ` Showing cached data because refresh failed: ${directory.absent}` : ''}</p>
                <div>
                  <span class="connection-chip"><i></i>{catalogConnectionState()}</span>
                  {#if directory.credential_source === 'session'}<button class="forget-key" type="button" title="Clear the temporary API key" onclick={disconnectCatalog}>Clear key</button>{/if}
                  <nav class="directory-pager" aria-label="Model catalog pages">
                    <button type="button" aria-label="Previous model page" disabled={directoryPage <= 1} onclick={() => directoryPage -= 1}>Previous</button>
                    <span>Page <strong>{Math.min(directoryPage,directoryPages)}</strong> of {directoryPages}</span>
                    <button type="button" aria-label="Next model page" disabled={directoryPage >= directoryPages} onclick={() => directoryPage += 1}>Next</button>
                  </nav>
                </div>
              </footer>
              {/if}
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
                  <button class="model-choice" type="button" draggable="true" ondragstart={(event) => dragStart(event, chip)} aria-label={`Choose ${fallbackModelName(chip.key)} for a role`} onclick={() => chooseModel(chip.key)}>
                    <span class="configured-identity"><b class={`provider ${provider(chip.key)}`} aria-hidden="true">{providerMark(chip.key)}</b><span><strong>{fallbackModelName(chip.key)}</strong><small>{providerDisplayName(chip.provider)}</small></span></span>
                    <span class="configured-facts">
                      <span><span class="fact-label">Capability</span><span class="capability-tag" class:unrated={!chip.band}>{chip.band || 'Not rated'}</span>{#if chip.local_draft}<small>Provisional · needs setup</small>{/if}</span>
                      <span class="configured-price"><span class="fact-label">Output price</span><strong class:metric-absent={chip.cost_out_per_mtok == null}>{chip.cost_out_per_mtok == null ? 'Not listed' : money(chip.cost_out_per_mtok)}</strong><small>/ 1M tokens{chip.rate_estimated ? ' · estimated' : ''}</small></span>
                    </span>
                    {#if chip.drift}<span class="model-review-note">Capability review suggested</span>{/if}
                    <span class="choose-model-cta">Choose for a role <span aria-hidden="true">→</span></span>
                  </button>
                  <details class="configured-details"><summary>Model details</summary><div><span class="fact-label">Model ID</span><code>{chip.key}</code>{#if chip.intelligence != null}<p>AA intelligence: {score(chip.intelligence)}{chip.coding != null ? ` · Coding: ${score(chip.coding)}` : ''}</p>{/if}{#if chip.measured}<p><strong>{chip.measured.failures} recorded failure event{chip.measured.failures === 1 ? '' : 's'}</strong> · {payload.measured_window?.label || 'window unavailable'}</p><p>Across {chip.measured.cells} adapter / effort configuration{chip.measured.cells === 1 ? '' : 's'}. Events are not failed-task counts or a success rate.</p>{:else}<p>Failure history unavailable.</p>{/if}{#if chip.drift}<p>Band review: {chip.drift.proposed || chip.drift.why}</p>{/if}</div></details>
                  {#if chip.local_draft}<button class="remove-model" type="button" aria-label={`Remove ${chip.key} from draft`} onclick={() => removeCustomModel(chip.key)}>Remove from draft</button>{/if}
                </article>
              {/each}
              {#if !filteredChips.length}<p class="empty-catalog">No models match this view. <button type="button" onclick={() => { catalogQuery = ''; catalogScope = 'all' }}>Clear filters</button></p>{/if}
            </div>
          {/if}
        </div>

  {/if}
  {#if assignmentDraft}
    <dialog class="assignment-dialog" use:assignmentModal onclose={closeAssignment} oncancel={closeAssignment} aria-labelledby="assignment-title">
      <header><div><p class="micro">{assuranceMeta(assignmentDraft.tier).label} · {assignmentDraft.role}</p><h2 id="assignment-title">Change model</h2></div><button type="button" aria-label="Close assignment" onclick={closeAssignment}>×</button></header>
      <p>Choose a model and its thinking effort. This saves a draft for review.</p>
      <label class="picker-search"><span>Find a configured model</span><input bind:value={modelSearch} placeholder="Search by model or provider…" /></label>
      <div class="assignment-choices" aria-label="Available models">{#each assignmentChoices as chip (chip.key)}<button type="button" aria-pressed={assignmentDraft.key === chip.key} onclick={() => chooseAssignment(chip.key)}><span><strong>{modelName(chip.key)}</strong><small>{providerDisplayName(chip.provider)} · {chip.local_draft ? 'Setup required' : chip.band || 'Capability unmeasured'}</small></span><span>{assignmentDraft.key === chip.key ? 'Selected' : 'Select'}</span></button>{/each}{#if !assignmentChoices.length}<p>No models match “{modelSearch}”. <button type="button" onclick={() => modelSearch = ''}>Clear search</button></p>{/if}</div>
      <button type="button" class="browse-more" onclick={() => { closeAssignment(); rosterView = 'models' }}>Browse more models →</button>
      <label class="assignment-effort"><span>Thinking effort</span><Dropdown bind:value={assignmentDraft.effort} options={EFFORT_OPTIONS} ariaLabel="Thinking effort" width="100%" /><small>Effort is stored independently for every assurance profile and seat.</small></label>
      {#if chipFor(assignmentDraft.key)?.local_draft}<p class="setup-warning">This model needs setup before it can be applied.</p>{/if}
      <footer><button type="button" class="secondary" onclick={closeAssignment}>Cancel</button><button type="button" class="confirm-assignment" disabled={!assignmentDraft.key} onclick={applyAssignment}>Add to draft</button></footer>
    </dialog>
  {/if}
</div>
<style>
.roster-policy-link { margin:0 0 1rem; font-size:.8rem; }
.loading,.notice { min-height:16rem; display:grid; place-content:center; justify-items:center; border:1px solid var(--line); border-radius:var(--radius-lg); background:var(--panel); color:var(--muted); }.loading span { width:1.6rem; height:1.6rem; border:2px solid var(--line); border-top-color:var(--accent); border-radius:50%; animation:spin .8s linear infinite; }@keyframes spin{to{transform:rotate(360deg)}}
.notice strong { color:var(--status-fail); }.notice p { margin:.4rem 0; }
.roster-shell { display:grid; gap:1rem; }.roster-summary { display:grid; grid-template-columns:repeat(4,minmax(7rem,1fr)) minmax(18rem,2fr); border:1px solid var(--line); border-radius:var(--radius-lg); background:color-mix(in srgb,var(--panel) 94%,transparent); overflow:hidden; }

.profile-area { display:grid; gap:.65rem; }.section-intro { display:flex; align-items:end; justify-content:space-between; gap:1.5rem; padding:0 .15rem; }.section-intro h2 { margin:.15rem 0 0; font-size:1.05rem; }.section-intro > p { max-width:34rem; margin:0; color:var(--muted); font-size:.68rem; line-height:1.45; text-align:right; }

.tier-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:.8rem; }.tier-card { position:relative; overflow:hidden; border:1px solid var(--line); border-radius:var(--radius-lg); background:color-mix(in srgb,var(--panel) 95%,transparent); padding:1rem; box-shadow:var(--shadow); }.tier-card::before { content:''; position:absolute; inset:0 auto 0 0; width:2px; background:var(--planner-color); }.tier-card:nth-child(2)::before { background:var(--builder-color); }.tier-card:nth-child(3)::before { background:var(--tech-lead-color); }
.micro { margin:0 0 .25rem; color:var(--muted); }.floor { border:1px solid var(--line); border-radius:1rem; padding:.25rem .5rem; color:var(--muted); font-size:.67rem; text-transform:capitalize; }.tier-note { display:grid; gap:.18rem; margin:.45rem 0 .9rem; }.tier-note strong { font-size:.65rem; }.tier-note span,.tier-note small { color:var(--muted); font-size:.57rem; line-height:1.4; }
.seats { display:grid; gap:.45rem; }.seat { width:100%; display:grid; grid-template-columns:5.5rem minmax(0,1fr) auto; align-items:center; gap:.65rem; min-height:4rem; border:1px solid var(--line); border-radius:var(--radius); background:var(--panel-raised); padding:.65rem; text-align:left; }.seat.changeable { cursor:copy; border-style:dashed; }.seat.changeable:hover { border-color:var(--accent); background:var(--accent-soft); }.role { display:flex; align-items:center; gap:.4rem; color:var(--muted); font-size:.68rem; text-transform:capitalize; }.model { display:flex; align-items:center; gap:.55rem; min-width:0; }.model > span { min-width:0; display:grid; gap:.16rem; }.model strong { font-size:.78rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.model small,.health { color:var(--muted); font-size:.62rem; }.provider { display:grid; place-content:center; flex:0 0 auto; width:1.7rem; height:1.7rem; border:1px solid var(--line); border-radius:.45rem; background:var(--bg); color:var(--muted); font:700 .58rem/1 var(--mono); }.provider.openai { color:var(--builder-color); }.provider.anthropic { color:var(--tech-lead-color); }.health { text-align:right; white-space:nowrap; }.health.warn { color:var(--status-escalated); }.seat.empty { color:var(--muted); border-style:dashed; }
.bands { border:1px solid var(--line); border-radius:var(--radius-lg); background:var(--panel); overflow:hidden; }.bands > header { display:flex; justify-content:space-between; align-items:end; gap:1.5rem; padding:1rem; border-bottom:1px solid var(--line); }.bands h2 { margin:.15rem 0 0; font-size:1.05rem; }.bands header > p { max-width:36rem; margin:0; color:var(--muted); font-size:.68rem; line-height:1.45; text-align:right; }.bands header > p strong { color:var(--text); }.band { display:grid; grid-template-columns:9rem 1fr; align-items:center; min-height:4.25rem; border-top:1px solid var(--line); }.band:first-child { border-top:0; }.band-name { align-self:stretch; display:grid; align-content:center; gap:.2rem; padding:.8rem 1rem; border-right:1px solid var(--line); text-transform:capitalize; }.band-name b { font-size:.82rem; }.band-name small { color:var(--muted); font-size:.6rem; }.band > div { display:flex; flex-wrap:wrap; gap:.45rem; padding:.75rem; }.model-pill { display:inline-flex; align-items:center; gap:.5rem; min-width:9rem; border:1px solid var(--line); border-radius:2rem; background:var(--panel-raised); padding:.35rem .7rem .35rem .4rem; }.model-pill .provider { width:1.45rem; height:1.45rem; border-radius:50%; }.model-pill > span { display:grid; gap:.12rem; }.model-pill strong { font-size:.67rem; line-height:1.1; }.model-pill small { color:var(--muted); font-size:.5rem; line-height:1; }.frontier .band-name { box-shadow:inset 3px 0 var(--lead-color); }.workhorse .band-name { box-shadow:inset 3px 0 var(--tech-lead-color); }.utility .band-name { box-shadow:inset 3px 0 var(--reviewer-color); }.basement .band-name { box-shadow:inset 3px 0 var(--muted); }
.studio { border:1px solid var(--line); border-radius:var(--radius-lg); background:var(--panel); overflow:hidden; }
.studio-title { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:1.1rem 1.2rem; border-bottom:1px solid var(--line); background:linear-gradient(110deg,color-mix(in srgb,var(--accent) 7%,var(--panel)),var(--panel) 45%); }.draft-state { display:flex; align-items:center; gap:.45rem; border:1px solid var(--line); border-radius:2rem; padding:.45rem .7rem; color:var(--muted); font-size:.68rem; white-space:nowrap; }
.workspace-modes { display:grid; grid-template-columns:minmax(0,1fr) auto minmax(0,1fr); align-items:center; gap:.8rem; padding:.8rem 1.2rem; border-bottom:1px solid var(--line); background:color-mix(in srgb,var(--bg) 35%,var(--panel)); }.workspace-modes strong { font-size:.68rem; }.workspace-modes small { color:var(--muted); font-size:.57rem; line-height:1.35; }
.workflow { display:grid; grid-template-columns:repeat(4,1fr); margin:0; padding:0; list-style:none; border-bottom:1px solid var(--line); }.workflow strong { color:var(--text); font-size:.7rem; }.workflow small { font-size:.58rem; line-height:1.35; }
.studio-layout { display:grid; grid-template-columns:minmax(0,1fr) 21rem; align-items:start; }.catalog { min-width:0; padding:1rem 1.1rem 1.2rem; border-right:1px solid var(--line); }.draft-panel { position:sticky; top:1rem; display:grid; gap:.8rem; padding:1rem; }.studio-heading,.draft-panel > header { display:flex; align-items:start; justify-content:space-between; gap:1rem; }.studio-heading h3,.draft-panel h3 { margin:0 0 .2rem; font-size:.9rem; }.studio-heading p { margin:0; color:var(--muted); font-size:.68rem; line-height:1.5; }.add-model,.clear,.secondary { border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--panel-raised); color:var(--text); padding:.48rem .65rem; cursor:pointer; font-size:.67rem; white-space:nowrap; }.add-model { border-color:color-mix(in srgb,var(--accent) 45%,var(--line)); color:var(--accent); }.clear { padding:.35rem .5rem; color:var(--muted); }
.catalog-tabs { display:flex; gap:1rem; margin-top:.8rem; border-bottom:1px solid var(--line); }.catalog-tabs button { position:relative; border:0; background:transparent; color:var(--muted); padding:.6rem .1rem; cursor:pointer; font-size:.68rem; font-weight:700; }.catalog-tabs button::after { content:''; position:absolute; inset:auto 0 -1px; height:2px; background:transparent; }.catalog-tabs button.active { color:var(--text); }.catalog-tabs button.active::after { background:var(--accent); }.catalog-tabs span { margin-left:.2rem; color:var(--muted); font-family:var(--mono); font-size:.58rem; }
.directory-loading { min-height:18rem; display:grid; place-content:center; justify-items:center; gap:.6rem; color:var(--muted); font-size:.7rem; }.directory-loading span { width:1.4rem; height:1.4rem; border:2px solid var(--line); border-top-color:var(--accent); border-radius:50%; animation:spin .8s linear infinite; }.source-setup { display:grid; gap:.75rem; margin-top:.8rem; border:1px solid var(--line); border-radius:var(--radius); background:var(--panel-raised); padding:.9rem 1rem; }.source-setup > header,.source-message { display:flex; align-items:center; justify-content:space-between; gap:1rem; }.source-setup h3 { margin:0 0 .2rem; font-size:.82rem; }.source-message p { margin:0; color:var(--muted); font-size:.64rem; line-height:1.45; }.source-setup a { color:var(--muted); text-decoration:none; font-size:.6rem; white-space:nowrap; }.source-setup a:hover { color:var(--accent); }.source-state,.connection-chip { display:inline-flex; align-items:center; gap:.35rem; color:var(--muted); font-size:.57rem; font-weight:700; }.source-state i,.connection-chip i { width:.42rem; height:.42rem; border-radius:50%; background:var(--status-running); box-shadow:0 0 .4rem color-mix(in srgb,var(--status-running) 65%,transparent); }.source-state.warning { color:var(--status-escalated); }.temporary-key { border:1px solid color-mix(in srgb,var(--accent) 55%,var(--line)); border-radius:var(--radius-sm); background:var(--accent-soft); color:var(--accent); padding:.5rem .7rem; cursor:pointer; font-size:.62rem; font-weight:700; white-space:nowrap; }.persistent-hint { margin:0; border-left:2px solid var(--line); padding:.35rem 0 .35rem .65rem; color:var(--muted); font-size:.59rem; line-height:1.5; }.persistent-hint b { color:var(--text); }.persistent-hint code { color:var(--accent); font-size:.56rem; }.source-setup form { display:grid; gap:.55rem; border-top:1px solid var(--line); padding-top:.7rem; }.source-setup form label { display:grid; gap:.35rem; color:var(--text); font-size:.62rem; font-weight:700; }.source-setup form label > div { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:.45rem; }.source-setup input { min-width:0; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--bg); color:var(--text); padding:.6rem .65rem; font:inherit; outline:none; }.source-setup input:focus { border-color:var(--accent); box-shadow:0 0 0 2px var(--accent-soft); }.source-setup form button { border:1px solid var(--accent); border-radius:var(--radius-sm); background:var(--accent); color:var(--bg); padding:.55rem .75rem; cursor:pointer; font-size:.67rem; font-weight:700; }.source-setup form button:disabled { opacity:.4; cursor:not-allowed; }.source-setup form .remember-key { display:flex; align-items:start; gap:.45rem; color:var(--muted); cursor:pointer; font-weight:400; }.source-setup form .remember-key input { flex:0 0 auto; width:.85rem; height:.85rem; margin:.1rem 0 0; accent-color:var(--accent); }.remember-key > span { display:grid; gap:.12rem; }.remember-key b { color:var(--text); font-size:.59rem; }.remember-key small { font-size:.55rem; font-weight:400; line-height:1.4; }.remember-key code { color:var(--accent); }.source-setup > small { color:var(--muted); font-size:.57rem; line-height:1.4; }
.directory-tools { display:grid; grid-template-columns:minmax(12rem,1fr) 10rem auto; align-items:end; gap:.65rem; margin:.85rem 0 .6rem; }.directory-tools .search { width:auto; }.sort { display:grid; gap:.3rem; color:var(--text); font-size:.62rem; font-weight:600; }.source-meta { display:grid; justify-items:end; padding-bottom:.15rem; }.source-meta strong { font:600 1rem/1 var(--mono); }.source-meta span { color:var(--muted); font-size:.55rem; white-space:nowrap; }.directory-footer { display:flex; align-items:center; justify-content:space-between; gap:1rem; margin-top:.55rem; }.directory-footer p { max-width:42rem; margin:0; color:var(--muted); font-size:.56rem; line-height:1.4; }.directory-footer a { color:inherit; }.directory-footer > div { display:flex; align-items:center; gap:.45rem; white-space:nowrap; }.directory-footer button { display:grid; place-content:center; width:1.7rem; height:1.7rem; border:1px solid var(--line); border-radius:50%; background:var(--panel-raised); color:var(--text); cursor:pointer; }.directory-footer button:disabled { opacity:.35; cursor:default; }.directory-footer .forget-key { width:auto; border-radius:var(--radius-sm); padding:0 .5rem; color:var(--muted); font-size:.55rem; }.directory-footer span { color:var(--muted); font-size:.58rem; }.directory-footer .connection-chip { border-right:1px solid var(--line); padding-right:.55rem; color:var(--muted); }.directory-footer .connection-chip i { background:var(--status-ok); box-shadow:0 0 .35rem color-mix(in srgb,var(--status-ok) 65%,transparent); }
.directory-footer .connection-chip { border-right:0; padding-right:0; }.directory-footer .forget-key { width:auto; min-height:1.5rem; height:auto; border-radius:var(--radius-sm); padding:0 .45rem; color:var(--muted); font-size:.53rem; }.directory-pager { display:inline-grid; grid-template-columns:auto auto auto; align-items:stretch; overflow:hidden; border:1px solid color-mix(in srgb,var(--line) 82%,transparent); border-radius:var(--radius-sm); background:color-mix(in srgb,var(--panel-raised) 72%,transparent); }.directory-pager button { width:auto; min-width:0; height:auto; min-height:1.5rem; border:0; border-radius:0; background:transparent; padding:0 .45rem; color:var(--text); cursor:pointer; font-size:.53rem; font-weight:700; }.directory-pager button:hover:not(:disabled) { background:var(--accent-soft); color:var(--accent); }.directory-pager button:disabled { color:var(--muted); opacity:.65; cursor:default; }.directory-pager > span { min-height:1.5rem; display:flex; align-items:center; gap:.18rem; border-right:1px solid var(--line); border-left:1px solid var(--line); padding:0 .45rem; }.directory-pager strong { color:var(--text); font:600 .56rem/1 var(--mono); }
.model-form { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:.75rem; margin-top:.85rem; border:1px solid color-mix(in srgb,var(--accent) 35%,var(--line)); border-radius:var(--radius); background:color-mix(in srgb,var(--accent) 5%,var(--panel-raised)); padding:.85rem; }.model-form header { grid-column:1/-1; display:flex; align-items:start; justify-content:space-between; gap:1rem; }.model-form header h3 { margin:0 0 .2rem; font-size:.8rem; }.model-form header p { max-width:46rem; margin:0; color:var(--muted); font-size:.64rem; line-height:1.5; }.model-form header span { border:1px solid var(--accent); border-radius:2rem; padding:.3rem .5rem; color:var(--accent); font-size:.6rem; white-space:nowrap; }.model-form label,.search { display:grid; gap:.3rem; color:var(--muted); font-size:.62rem; }.model-form label > span,.search > span { color:var(--text); font-weight:600; }.model-form label.wide { grid-column:span 2; }.model-form input,.search input { min-width:0; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--bg); color:var(--text); padding:.52rem .6rem; font:inherit; outline:none; }.model-form input:focus,.search input:focus { border-color:var(--accent); box-shadow:0 0 0 2px var(--accent-soft); }.model-form small { line-height:1.35; }.create-model { align-self:end; min-height:2.1rem; border:1px solid var(--accent); border-radius:var(--radius-sm); background:var(--accent); color:var(--bg); cursor:pointer; font-weight:700; }
.catalog-tools { display:flex; align-items:end; justify-content:space-between; gap:.75rem; margin:.9rem 0 .65rem; }.search { width:min(17rem,38%); }.scope { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:.3rem; }.scope button { border:1px solid transparent; border-radius:2rem; background:transparent; color:var(--muted); padding:.38rem .55rem; cursor:pointer; font-size:.62rem; text-transform:capitalize; }.scope button:hover { background:var(--panel-raised); color:var(--text); }.scope button.active { border-color:var(--line); background:var(--panel-raised); color:var(--text); }.scope span { margin-left:.15rem; color:var(--muted); font-family:var(--mono); }
.empty-catalog { grid-column:1/-1; margin:0; border:1px dashed var(--line); border-radius:var(--radius); padding:2rem; color:var(--muted); text-align:center; font-size:.7rem; }

.inline-alert,.setup-warning { border:1px solid var(--line); border-radius:var(--radius); background:var(--panel-raised); padding:.7rem; }.inline-alert { border-left:2px solid var(--accent); }.inline-alert.fail { border-left-color:var(--status-fail); }.inline-alert strong { font-size:.68rem; }.inline-alert p { margin:.2rem 0 0; color:var(--muted); font-size:.62rem; line-height:1.45; }.selected-model { display:flex; align-items:center; gap:.55rem; border:1px solid var(--accent); border-radius:var(--radius); background:var(--accent-soft); padding:.65rem; }.selected-model span { display:grid; gap:.1rem; min-width:0; }.selected-model small { color:var(--muted); font-size:.56rem; font-style:normal; }.selected-model strong { font-size:.72rem; }.setup-warning { border-color:color-mix(in srgb,var(--status-escalated) 45%,var(--line)); background:color-mix(in srgb,var(--status-escalated) 5%,var(--panel-raised)); }.setup-warning p,.setup-warning small { color:var(--muted); font-size:.6rem; line-height:1.45; }
.assignment-backdrop { position:fixed; z-index:80; inset:0; display:grid; place-items:center; background:color-mix(in srgb,var(--bg) 72%,transparent); padding:1rem; backdrop-filter:blur(4px); }.assignment-dialog { width:min(31rem,100%); overflow:hidden; border:1px solid color-mix(in srgb,var(--accent) 48%,var(--line)); border-radius:var(--radius-lg); background:var(--panel); box-shadow:0 1.5rem 5rem rgba(0,0,0,.48); }.assignment-dialog > header { display:flex; align-items:start; justify-content:space-between; gap:1rem; border-bottom:1px solid var(--line); background:linear-gradient(110deg,color-mix(in srgb,var(--accent) 8%,var(--panel)),var(--panel)); padding:1rem 1.1rem; }.assignment-dialog h2 { margin:0; font-size:1.05rem; }.assignment-dialog > header button { display:grid; place-content:center; width:2rem; height:2rem; min-width:2rem; min-height:2rem; flex:0 0 2rem; border:1px solid var(--line); border-radius:50%; background:transparent; color:var(--muted); padding:0; cursor:pointer; font-size:1rem; }.assignment-intro { margin:0; padding:.9rem 1.1rem 0; color:var(--muted); font-size:.68rem; line-height:1.5; }.assignment-effort { display:grid; gap:.4rem; margin:.9rem 1.1rem; }.assignment-effort > span { font-size:.65rem; font-weight:700; }.assignment-effort > small { color:var(--muted); font-size:.56rem; line-height:1.45; }.assignment-dialog > footer { display:flex; justify-content:flex-end; gap:.45rem; border-top:1px solid var(--line); padding:.8rem 1.1rem; }.assignment-dialog > footer button { min-height:2rem; padding:.45rem .75rem; }.confirm-assignment { border:1px solid var(--accent); border-radius:var(--radius-sm); background:var(--accent); color:var(--bg); cursor:pointer; font-size:.67rem; font-weight:750; }
.validation { display:grid; gap:.55rem; }.validation > header { display:flex; align-items:center; justify-content:space-between; }.validation h3,.bundle h3 { margin:.1rem 0; font-size:.78rem; }.validation header span { border:1px solid currentColor; border-radius:2rem; padding:.28rem .45rem; font-size:.58rem; font-weight:700; }.guidance-intro { margin:0; color:var(--muted); font-size:.58rem; line-height:1.45; }.validation ul { display:grid; gap:.35rem; margin:0; padding:0; list-style:none; }.validation li { display:flex; align-items:start; gap:.45rem; border:1px solid var(--line); border-radius:var(--radius-sm); padding:.5rem; }.validation li.advice { border-color:color-mix(in srgb,var(--status-escalated) 36%,var(--line)); background:color-mix(in srgb,var(--status-escalated) 4%,var(--panel)); }.validation li > b { display:grid; place-content:center; flex:0 0 auto; width:1.15rem; height:1.15rem; border:1px solid currentColor; border-radius:50%; font-size:.57rem; }.validation li span { display:grid; gap:.12rem; }.validation li strong { color:var(--text); font-size:.62rem; text-transform:capitalize; }.validation li small { color:var(--muted); font-size:.56rem; line-height:1.35; }.validation li em { color:currentColor; font-size:.5rem; font-style:normal; text-transform:uppercase; letter-spacing:.04em; }.pass { color:var(--status-ok); }.advice { color:var(--status-escalated); }.fail,.error { color:var(--status-fail); }.refusals { border:1px solid color-mix(in srgb,var(--status-escalated) 35%,var(--line)); border-radius:var(--radius-sm); padding:.55rem; }.refusals > strong { color:var(--status-escalated); font-size:.6rem; }.refusals p { margin:.35rem 0 0; border-left:2px solid var(--status-escalated); padding-left:.5rem; color:var(--muted); font-size:.58rem; line-height:1.4; }.activation-note { display:grid; gap:.25rem; border:1px solid color-mix(in srgb,var(--accent) 35%,var(--line)); border-radius:var(--radius); background:var(--accent-soft); padding:.7rem; }.activation-note span { color:var(--accent); font-size:.54rem; font-weight:800; text-transform:uppercase; letter-spacing:.06em; }.activation-note strong { font-size:.68rem; }.diff { margin:.15rem 0; }.diff summary { color:var(--muted); cursor:pointer; font-size:.65rem; }.draft-actions { display:grid; grid-template-columns:1fr 1fr; gap:.45rem; }.draft-actions .apply-local,.draft-actions .prepare-patch { grid-column:1/-1; }.draft-actions button { min-height:2.35rem; }.apply-local { border:1px solid var(--accent); border-radius:var(--radius-sm); background:var(--accent); color:var(--bg); padding:.55rem .65rem; cursor:pointer; font-size:.67rem; font-weight:750; }.apply-local:disabled,.secondary:disabled { opacity:.38; cursor:not-allowed; }.prepare-patch { color:var(--accent); }.publish-note { margin:0; border-top:1px solid var(--line); padding-top:.65rem; color:var(--muted); font-size:.58rem; line-height:1.45; }.publish-note strong { color:var(--text); }.bundle { border-top:1px solid var(--line); padding:1rem; }.bundle p { color:var(--muted); font-size:.7rem; }.bundle small { color:var(--muted); }
@media (max-width: 1100px) { .roster-summary { grid-template-columns:repeat(4,1fr); }.tier-grid { grid-template-columns:1fr; }.seat { grid-template-columns:7rem minmax(0,1fr) auto; }.studio-layout { grid-template-columns:1fr; }.catalog { border-right:0; border-bottom:1px solid var(--line); }.draft-panel { position:static; grid-template-columns:repeat(2,minmax(0,1fr)); }.draft-panel > header,.draft-actions,.publish-note { grid-column:1/-1; } }
@media (max-width: 760px) { .workflow { grid-template-columns:repeat(2,1fr); }.workspace-modes { grid-template-columns:1fr; }.model-form { grid-template-columns:1fr 1fr; }.model-form label.wide { grid-column:span 1; }.catalog-tools { align-items:stretch; flex-direction:column; }.search { width:100%; }.scope { justify-content:flex-start; }.draft-panel { grid-template-columns:1fr; }.draft-panel > * { grid-column:1!important; }.directory-tools { grid-template-columns:1fr 1fr; }.source-meta { justify-items:start; }.directory-footer { align-items:start; flex-direction:column; } }
@media (max-width: 620px) { .roster-summary { grid-template-columns:repeat(2,1fr); }.section-intro { align-items:start; flex-direction:column; gap:.35rem; }.section-intro > p { text-align:left; }.seat { grid-template-columns:5rem minmax(0,1fr); }.health { grid-column:2; text-align:left; }.bands > header { align-items:start; flex-direction:column; gap:.35rem; }.bands header > p { text-align:left; }.band { grid-template-columns:1fr; }.band-name { border-right:0; border-bottom:1px solid var(--line); }.studio-title { align-items:start; flex-direction:column; }.model-form { grid-template-columns:1fr; }.model-form label,.model-form label.wide,.create-model { grid-column:1; }.workflow { grid-template-columns:1fr; } }
.seat-row { display:grid; gap:.35rem; }.pick-result { color:var(--text); font-weight:650; }.pick-muted { color:var(--muted); line-height:1.5; }.pick-unavailable { color:var(--status-escalated); }
.recommendation-summary { margin:.6rem 0 .8rem; padding:.75rem .85rem; border-left:3px solid var(--line); border-radius:0 var(--radius-sm) var(--radius-sm) 0; background:var(--panel-raised); }.recommendation-summary.has-suggestion { border-left-color:var(--accent); background:var(--accent-soft); }.recommendation-summary > strong { color:var(--text); }.recommendation-summary p { margin:.35rem 0 0; color:var(--muted); line-height:1.5; }.recommendation-summary .suggested-model { color:var(--text); font-weight:650; }.suggested-model span { display:block; font-weight:400; color:var(--muted); }.recommendation-summary .draft-basis { margin-top:.65rem; }
.pick-candidates { margin-bottom:.85rem; }.pick-candidates > summary,.pick-evidence summary { color:var(--muted); cursor:pointer; font-size:.8rem; padding:.35rem 0; }.pick-candidates article { display:grid; gap:.25rem; border-top:1px solid var(--line); padding:.75rem 0; }.pick-candidates article > span { color:var(--muted); line-height:1.5; }.pick-candidates article > p { margin:0; line-height:1.5; color:var(--text); }.pick-evidence { border-top:1px solid var(--line); padding-top:.35rem; }.pick-evidence pre { max-height:12rem; margin:.35rem 0 0; overflow:auto; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--bg); padding:.5rem; color:var(--muted); font:500 .75rem/1.4 var(--mono); white-space:pre-wrap; }.propose-pick { margin-bottom:.85rem; border:1px solid var(--accent); border-radius:var(--radius-sm); background:var(--accent-soft); color:var(--accent); padding:.5rem .7rem; cursor:pointer; font-size:.8rem; font-weight:650; }.propose-pick:disabled { cursor:not-allowed; opacity:.45; }
/* Task-oriented roster controls. */
.roster-shell { display:grid; gap:1.25rem; min-width:0; }
.roster-shell :global(button),.roster-shell :global(input),.roster-shell :global(select) { font:inherit; }
.roster-shell :global(button) { cursor:pointer; }
.roster-shell :global(button:disabled) { cursor:not-allowed; }
.roster-shell :global(p) { line-height:1.5; }
.roster-shell :global(a) { color:var(--accent); }
.roster-shell :global(summary) { cursor:pointer; font-size:.85rem; padding:.6rem 0; }
.roster-shell :global(input:not([type=checkbox])),.roster-shell :global(select) { font-size:1rem; border:1px solid var(--muted); border-radius:.45rem; background:var(--panel); color:var(--text); padding:.6rem .7rem; min-width:0; max-width:100%; }
.roster-views,.preset-tabs { display:flex; flex-wrap:wrap; gap:.5rem; }
.roster-views { border-bottom:1px solid var(--line); }
.roster-views button,.preset-tabs button { color:var(--muted); background:transparent; border:0; padding:.75rem 1rem; font-size:.9rem; border-bottom:3px solid transparent; }
.roster-views button[aria-pressed=true],.preset-tabs button[aria-pressed=true] { color:var(--accent); background:var(--accent-surface); border-bottom-color:var(--accent); font-weight:650; }
.roster-views span { margin-inline-start:.5rem; font-size:.75rem; }
.draft-feedback { color:var(--accent); font-size:.875rem; margin:0; }.draft-feedback:empty { display:none; }
.roster-workspace { display:grid; grid-template-columns:minmax(0,1fr) minmax(17rem,.65fr); gap:1.5rem; align-items:start; }
.profile-area { min-width:0; display:block; }.section-intro { display:block; margin:0 0 1rem; }.section-intro h2 { margin:0; font-size:1.1rem; }.section-intro p,.preset-description,.roster-help { color:var(--muted); font-size:.85rem; margin:.5rem 0 1rem; }.preset-description a { display:inline-block; margin-inline-start:.25rem; }
.seats { display:grid; gap:.75rem; margin:0; }
.seat-row { border:1px solid var(--line); border-radius:.65rem; background:var(--panel); min-width:0; overflow:visible; }
.seat-row.changed { border-inline-start:3px solid var(--accent); }
.seat-summary { display:grid; grid-template-columns:minmax(6rem,.6fr) minmax(0,1fr) auto; gap:1rem; padding:1rem; align-items:center; }
.role-name,.assigned-model { display:grid; gap:.3rem; min-width:0; }.role-name > strong { text-transform:capitalize; font-size:.9rem; }.assigned-model > strong { font-size:.9rem; overflow-wrap:anywhere; }.assigned-model small { font-size:.78rem; color:var(--muted); line-height:1.5; overflow-wrap:anywhere; }
.pending-label { color:var(--accent); font-size:.75rem; }.change-model,.selection-callout button,.draft-panel button.secondary,.draft-panel .change-list button,.setup-warning button { border:1px solid var(--line); border-radius:.45rem; background:var(--panel); color:var(--accent); padding:.6rem .75rem; font-size:.85rem; min-height:2.5rem; }
.pick-explanation { margin:0; border:0; border-top:1px solid var(--line); border-radius:0 0 .65rem .65rem; background:transparent; padding:0 1rem; min-width:0; }.pick-explanation > summary { color:var(--muted); }.pick-explanation :global(p),.pick-explanation :global(span),.pick-explanation :global(strong),.pick-explanation :global(code) { font-size:.8rem; overflow-wrap:anywhere; white-space:normal; }.pick-explanation :global(pre) { font-size:.75rem; overflow:auto; max-width:100%; }
.selection-callout { border-inline-start:3px solid var(--accent); background:var(--accent-surface); padding:1rem; margin:1rem 0; }.selection-callout p { margin:0 0 .5rem; font-size:.85rem; }
.draft-panel { position:static; display:grid; grid-template-columns:minmax(0,1fr); gap:1rem; padding:1.25rem; background:var(--panel); border:1px solid var(--line); border-top:3px solid var(--accent); border-radius:.65rem; min-width:0; }
.draft-panel > header { grid-column:auto; }.draft-panel h2,.draft-panel h3 { font-size:1rem; margin:0; }.draft-panel p,.draft-panel small { font-size:.82rem; color:var(--muted); margin:0; line-height:1.5; }.draft-panel :global(code) { overflow-wrap:anywhere; }
.change-list { list-style:none; display:grid; gap:.75rem; padding:0; margin:0; }.change-list li { display:flex; align-items:start; gap:.5rem; justify-content:space-between; padding-bottom:.75rem; border-bottom:1px solid var(--line); }.change-list li > div { display:grid; gap:.4rem; min-width:0; }.change-list strong { font-size:.85rem; text-transform:capitalize; }.change-list span { color:var(--muted); font-size:.8rem; overflow-wrap:anywhere; }.change-list .change-after { color:var(--accent); }
.draft-actions { display:grid; grid-template-columns:1fr; gap:.6rem; }.draft-actions .apply-local { background:var(--accent-solid); color:var(--on-accent); font-size:.9rem; padding:.7rem; min-height:2.75rem; }.draft-panel .draft-options { border-top:1px solid var(--line); }.draft-options button { display:block; margin:.5rem 0; width:100%; }.draft-options p { margin-top:.75rem; }
.validation > header { flex-wrap:wrap; gap:.5rem; }.validation header span { font-size:.78rem; }.validation li { padding:.7rem; }.validation li strong { font-size:.85rem; }.validation li small,.validation li em,.refusals p,.refusals > strong { font-size:.8rem; line-height:1.5; }.validation li > b { font-size:.8rem; }.validation .guidance-intro { font-size:.8rem; }.setup-warning,.activation-note { padding:.8rem; background:var(--attention-surface); border:1px solid var(--line); border-inline-start:3px solid var(--status-escalated); font-size:.85rem; line-height:1.5; }.setup-warning strong { font-size:.85rem; color:var(--status-escalated); }.setup-warning p { margin:.5rem 0; }.inline-alert { padding:.75rem; }.inline-alert p { font-size:.85rem; }
.bands { padding:1rem; border:1px solid var(--line); border-radius:.65rem; }.bands > header { margin-top:.75rem; }.bands h2 { font-size:1rem; }.bands p,.bands small,.band-name b,.model-pill strong,.model-pill small { font-size:.8rem; }.band-list article { grid-template-columns:minmax(7rem,.3fr) minmax(0,1fr); }.model-pill { max-width:100%; }.model-pill strong { white-space:normal; overflow-wrap:anywhere; }
.catalog { padding:0; border:0; min-width:0; }.studio-heading h3 { font-size:1.1rem; }.studio-heading p { font-size:.85rem; }.catalog-tabs button,.scope button { font-size:.85rem; min-height:2.5rem; }.source-setup { padding:1rem; }.source-setup p,.source-setup small,.source-setup h3,.source-state,.source-setup a,.temporary-key,.source-setup button { font-size:.82rem; line-height:1.5; }.source-setup header { margin-top:.5rem; }.directory-tools { gap:1rem; flex-wrap:wrap; }.search > span,.sort > span { font-size:.85rem; }.directory-footer p { font-size:.8rem; line-height:1.5; }.directory-pager { flex-wrap:wrap; }.directory-pager button { width:auto; min-width:0; height:auto; min-height:1.5rem; font-size:.85rem; padding:.5rem .75rem; }.directory-pager span,.connection-chip,.forget-key { font-size:.8rem; }.model-form h3 { font-size:1rem; }.model-form p,.model-form label > span,.model-form small { font-size:.8rem; }.model-form button { font-size:.9rem; }.empty-catalog { font-size:.9rem; }
.assignment-dialog { width:min(36rem,calc(100% - 2rem)); max-height:calc(100dvh - 2rem); overflow:auto; overscroll-behavior:contain; padding:1.25rem; margin:auto; color:var(--text); background:var(--panel); border:1px solid var(--accent-border); border-radius:.85rem; box-shadow:0 1rem 4rem rgba(0,0,0,.2); }
.assignment-dialog::backdrop { background:rgba(0,0,0,.45); }
.assignment-dialog > header { background:transparent; padding:0 0 1rem; align-items:center; }.assignment-dialog > header .micro { font-size:.8rem; color:var(--accent); text-transform:capitalize; }.assignment-dialog h2 { font-size:1.2rem; }.assignment-dialog > p { font-size:.85rem; color:var(--muted); line-height:1.5; }.picker-search { display:grid; gap:.4rem; font-size:.85rem; }.assignment-choices { display:grid; gap:.5rem; max-height:16rem; overflow:auto; overscroll-behavior:contain; margin:1rem 0; padding:.2rem; }.assignment-choices button { display:flex; align-items:center; justify-content:space-between; gap:1rem; border:1px solid var(--line); border-radius:.5rem; background:var(--panel); color:var(--text); padding:.75rem; text-align:start; font-size:.85rem; }.assignment-choices button[aria-pressed=true] { background:var(--accent-surface); border-color:var(--accent); }.assignment-choices button > span:first-child { display:grid; gap:.25rem; min-width:0; }.assignment-choices strong { overflow-wrap:anywhere; }.assignment-choices small { color:var(--muted); font-size:.8rem; }.assignment-choices button > span:last-child { color:var(--accent); font-size:.8rem; }
.browse-more { background:transparent; border:0; color:var(--accent); padding:.5rem 0; font-size:.85rem; }.assignment-effort { margin:1rem 0; }.assignment-effort > span { font-size:.85rem; }.assignment-effort > small { font-size:.8rem; }.assignment-dialog > footer { padding:1rem 0 0; flex-wrap:wrap; gap:.75rem; }.assignment-dialog > footer button { font-size:.9rem; min-height:2.5rem; }.confirm-assignment { color:var(--on-accent); }
@media(max-width:1150px) { .roster-workspace { grid-template-columns:minmax(0,1fr); }.draft-panel { grid-template-columns:minmax(0,1fr); } }
@media(max-width:640px) { .seat-summary { grid-template-columns:minmax(0,1fr); gap:.6rem; }.change-model { justify-self:start; }.roster-views button,.preset-tabs button { padding:.65rem .75rem; }.directory-tools { display:grid; grid-template-columns:minmax(0,1fr); }.model-form { grid-template-columns:minmax(0,1fr); }.band-list article { grid-template-columns:minmax(0,1fr); }.assignment-dialog { padding:1rem; }.source-message { flex-wrap:wrap; }.source-setup form label > div { flex-wrap:wrap; }.change-list li { flex-wrap:wrap; } }


.section-intro > p { max-width:none; text-align:start; margin:.5rem 0 0; }
.seat-summary { padding:.85rem 1rem; }.pick-explanation > summary { padding:.4rem 0; font-size:.78rem; }
.assignment-choices { scrollbar-gutter:stable; }
.restore-draft { justify-self:start; padding:.6rem .8rem; color:var(--accent); background:var(--panel); border:1px solid var(--line); border-radius:.45rem; }
.unassigned-toggle { display:block; width:fit-content; text-align:start; color:var(--accent); background:transparent; border:0; padding:.3rem 0 .75rem; font-size:.8rem; }

.roster-shell :global(.dropdown-trigger),.roster-shell :global(.dropdown-menu button) { font-size:.85rem; min-height:2.4rem; }
.roster-shell :global(.dropdown-menu) { overscroll-behavior:contain; }
.catalog-units { font-size:.8rem; color:var(--muted); margin:.5rem 0 .8rem; }

/* Model comparison: identity, labeled measures, then action. */
.directory-list { display:grid; gap:1rem; border:0; overflow:visible; }
.directory-list .directory-card { display:block; padding:1rem; background:var(--panel); border:1px solid var(--line); border-radius:var(--radius-lg); }
.directory-card-header { display:flex; align-items:start; justify-content:space-between; gap:1rem; }
.directory-name { display:flex; gap:.75rem; min-width:0; flex:1; width:auto; align-items:center; }
.directory-name > div { min-width:0; }
.directory-name .provider,.configured-identity .provider { width:2.25rem; height:2.25rem; border-radius:.6rem; font-size:.7rem; }
.directory-name h4 { margin:0; font-size:1.05rem; line-height:1.35; font-weight:650; overflow-wrap:anywhere; }
.directory-name p { margin:.3rem 0 0; font-size:.8rem; line-height:1.5; color:var(--muted); }
.directory-add { flex:0 0 auto; padding:.6rem .85rem; border:1px solid var(--accent-border); background:var(--accent-surface); color:var(--accent); border-radius:var(--radius-sm); min-height:2.5rem; font-weight:650; cursor:pointer; }
.directory-add:disabled { background:var(--bg); border-color:var(--line); color:var(--muted); cursor:default; }
.benchmark-setting { margin:.85rem 0; color:var(--muted); font-size:.8rem; }
.benchmark-setting > span { display:flex; align-items:center; gap:.6rem; flex-wrap:wrap; }
.benchmark-setting strong { color:var(--text); font-weight:500; }
.effort-control { display:flex; align-items:center; flex-wrap:wrap; gap:.65rem; margin:0; font-size:.8rem; }
.effort-control > span { text-transform:none; letter-spacing:normal; }
.catalog-metrics { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:.5rem; margin:0; }
.catalog-metrics > div { min-width:0; display:flex; flex-direction:column; align-items:start; padding:.75rem; border-radius:var(--radius-sm); background:var(--bg); border-top:2px solid transparent; }
.catalog-metrics > .metric-featured { background:var(--accent-surface); border-top-color:var(--accent); }
.catalog-metrics dt,.fact-label { color:var(--muted); font-size:.75rem; line-height:1.4; font-weight:500; }
.catalog-metrics dd { margin:.5rem 0 .25rem; font-size:1.25rem; line-height:1.2; font-weight:650; font-variant-numeric:tabular-nums; letter-spacing:-.025em; overflow-wrap:anywhere; }
.catalog-metrics small { color:var(--muted); font-size:.7rem; line-height:1.4; }
.catalog-metrics .metric-absent,.configured-price .metric-absent { font-size:.85rem; line-height:1.5; font-weight:400; letter-spacing:normal; color:var(--muted); }
.model-palette { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,20rem),1fr)); gap:1rem; }
.model-palette article { display:flex; flex-direction:column; border:1px solid var(--line); border-radius:var(--radius-lg); background:var(--panel); overflow:visible; min-width:0; }
.model-palette article:hover { border-color:var(--accent-border); }
.model-palette article.selected { border-color:var(--accent); background:var(--accent-surface); }
.model-choice { border:0; background:transparent; color:var(--text); text-align:start; width:100%; min-width:0; flex:1; display:flex; flex-direction:column; align-items:stretch; gap:1rem; padding:1rem; cursor:pointer; border-radius:var(--radius); }
.model-choice:hover .choose-model-cta { text-decoration:underline; text-underline-offset:.2em; }
.model-choice .configured-identity { display:flex; align-items:center; gap:.7rem; }
.configured-identity > span { display:grid; gap:.25rem; min-width:0; }
.configured-identity strong { font-size:1.05rem; line-height:1.35; font-weight:650; }
.model-choice .configured-facts { display:grid; grid-template-columns:1fr 1fr; gap:1rem; padding:.85rem; border-radius:var(--radius-sm); background:var(--bg); }
.configured-facts > span { display:flex; flex-direction:column; align-items:start; gap:.4rem; min-width:0; }
.model-choice small { color:var(--muted); white-space:normal; overflow:visible; font-size:.75rem; }
.capability-tag { display:inline-block; padding:.3rem .5rem; border:1px solid var(--accent-border); border-radius:.35rem; color:var(--accent); background:var(--accent-surface); font-size:.8rem; font-weight:600; text-transform:capitalize; }
.capability-tag.unrated { background:transparent; border-color:var(--line); color:var(--muted); font-weight:400; }
.configured-price strong { font-size:1.35rem; font-variant-numeric:tabular-nums; font-weight:650; line-height:1.25; }
.model-review-note { color:var(--status-escalated); font-size:.8rem; }
.model-choice .choose-model-cta { display:flex; justify-content:space-between; align-items:center; color:var(--accent); font-size:.85rem; font-weight:600; margin-top:auto; }
.configured-details { border-top:1px solid var(--line); padding:0 1rem; }
.configured-details > summary { padding:.7rem 0; color:var(--muted); font-size:.8rem; cursor:pointer; }
.configured-details > div { display:grid; gap:.3rem; padding-bottom:.85rem; }
.configured-details code { font-size:.75rem; overflow-wrap:anywhere; }
.configured-details p { margin:.3rem 0 0; color:var(--muted); font-size:.8rem; line-height:1.5; }
.model-palette .remove-model { position:static; align-self:start; padding:.5rem 1rem; font-size:.8rem; margin-bottom:.5rem; }
@media(max-width:640px) {
 .directory-card-header { flex-wrap:wrap; }
 .directory-name { flex-basis:100%; }
 .catalog-metrics { grid-template-columns:repeat(2,minmax(0,1fr)); }
 .catalog-metrics > div:last-child { grid-column:1/-1; }
 .model-palette { grid-template-columns:minmax(0,1fr); }
 .catalog-tools .search { width:100%; }
}
</style>
