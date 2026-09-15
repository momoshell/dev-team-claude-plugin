const EFFORT_ORDER = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

const PROVIDER_NAMES = Object.freeze({
  anthropic:'Anthropic', google:'Google', meta:'Meta', mistral:'Mistral AI',
  moonshotai:'Moonshot AI', openai:'OpenAI', 'openai-codex':'OpenAI',
  xai:'xAI', zhipuai:'Zhipu AI', 'local-pi':'Local',
})

function measured(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function preferredVariant(variants, familySlug) {
  const exact = variants.find((variant) => variant.slug === familySlug)
  if (exact) return exact
  return [...variants].sort((left, right) => (measured(right.intelligence) ?? -Infinity) - (measured(left.intelligence) ?? -Infinity))[0]
}

function identity(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function providerIdentity(value) {
  const key = String(value || '').toLowerCase().trim()
  return key === 'openai-codex' ? 'openai' : identity(key)
}

const TIER_SUFFIX = /(?:-contributor|:batch|:free)$/
const SCORE_FIELDS = Object.freeze(['intelligence', 'coding', 'agentic'])
const PERFORMANCE_FIELDS = Object.freeze(['benchmark_cost_per_task', 'output_tokens_per_second', 'time_to_first_token_seconds'])
const REASONING_FIELDS = Object.freeze(['reasoning_effort', 'reasoning_mode'])

function openRouterSlug(model) {
  if (typeof model?.runtime_id === 'string' && model.runtime_id.includes('/')) return model.runtime_id.split('/').slice(1).join('/')
  return typeof model?.slug === 'string' ? model.slug : ''
}

function openRouterFamilySlug(model) {
  return openRouterSlug(model).replace(TIER_SUFFIX, '') || model?.family_slug || model?.slug || null
}

function addCandidate(index, key, candidate) {
  if (!key) return
  const existing = index.get(key)
  if (existing) existing.push(candidate)
  else index.set(key, [candidate])
}

function aaCandidateIndex(models) {
  const byFamily = new Map()
  const bySlug = new Map()
  const candidates = []
  for (const [index, model] of (Array.isArray(models) ? models : []).entries()) {
    if (!model || typeof model !== 'object') continue
    const candidate = { model, index }
    candidates.push(candidate)
    addCandidate(byFamily, identity(model.family_slug || model.slug), candidate)
    addCandidate(bySlug, identity(model.slug), candidate)
  }
  return { byFamily, bySlug, candidates }
}

function chooseAaCandidate(index, key) {
  const candidates = []
  const seen = new Set()
  for (const candidate of [...(index.byFamily.get(key) || []), ...(index.bySlug.get(key) || [])]) {
    if (seen.has(candidate.index)) continue
    seen.add(candidate.index)
    candidates.push(candidate)
  }
  candidates.sort((left, right) => left.index - right.index)
  const exact = candidates.find((candidate) => identity(candidate.model.slug) === key)
  if (exact) return exact
  let best = null
  for (const candidate of candidates) {
    const score = measured(candidate.model.intelligence)
    if (score === null) continue
    if (!best || score > measured(best.model.intelligence)) best = candidate
  }
  return best || candidates[0] || null
}

function scoreMetadata(candidate) {
  const metadata = {}
  for (const field of [...SCORE_FIELDS, ...PERFORMANCE_FIELDS, ...REASONING_FIELDS]) {
    metadata[field] = candidate?.[field] ?? null
  }
  metadata.benchmark_variant = typeof candidate?.name === 'string' ? candidate.name : null
  return metadata
}

function unbenchmarkedOpenRouterModel(model, scoreReason) {
  return {
    ...model,
    family_slug: openRouterFamilySlug(model),
    intelligence: null, score_absent_reason: scoreReason,
    coding: null,
    agentic: null,
    benchmark_cost_per_task: null,
    output_tokens_per_second: null,
    time_to_first_token_seconds: null,
    reasoning_effort: null,
    reasoning_mode: null,
    benchmark_variant: null,
  }
}

function mergeOpenRouterModel(model, candidate, scoreReason) {
  const primary = {
    ...model,
    source_id: model?.source_id || model?.runtime_id || null,
    family_slug: openRouterFamilySlug(model),
    runtime_id: typeof model?.runtime_id === 'string' ? model.runtime_id : null,
  }
  if (!candidate) return unbenchmarkedOpenRouterModel(primary, scoreReason)
  return { ...primary, ...scoreMetadata(candidate.model), score_absent_reason: null }
}

function artificialAnalysisUnavailable(artificialAnalysis) {
  return artificialAnalysis?.configured === true && !Array.isArray(artificialAnalysis?.models)
}

function catalogMetadata(openRouter, artificialAnalysis) {
  return {
    ...(openRouter || {}),
    ...(artificialAnalysis || {}),
    configured: artificialAnalysis?.configured === undefined ? true : artificialAnalysis.configured,
    credential_source: artificialAnalysis?.credential_source ?? null,
    source: 'OpenRouter',
    source_url: openRouter?.source_url || 'https://openrouter.ai/api/v1/models',
    openrouter_source: openRouter?.source || 'OpenRouter',
    openrouter_source_url: openRouter?.source_url || 'https://openrouter.ai/api/v1/models',
    artificial_analysis_source: artificialAnalysis?.source || 'Artificial Analysis',
    artificial_analysis_source_url: artificialAnalysis?.source_url || 'https://artificialanalysis.ai/',
    artificial_analysis_unavailable: artificialAnalysisUnavailable(artificialAnalysis),
    artificial_analysis_absent: firstAbsent(artificialAnalysis?.absent),
  }
}

function firstAbsent(...values) {
  return values.find((value) => typeof value === 'string' && value.length > 0) || null
}

function aaOnlyDirectory(artificialAnalysis, absent = null) {
  const aaModels = Array.isArray(artificialAnalysis?.models) ? artificialAnalysis.models : []
  return {
    ...catalogMetadata(null, artificialAnalysis),
    models: aaModels.map((model) => ({ ...model, runtime_id: null, runtime_id_hint: null, score_absent_reason: 'no-runtime-listing' })),
    absent: firstAbsent(absent, artificialAnalysis?.absent),
    stale: artificialAnalysis?.stale === true,
    join: { matched: 0, total: 0 },
  }
}

export function directoryModelMatchesChip(model, chip) {
  if (!model || !chip) return false
  const runtimeIds = [model.runtime_id, ...(model.variants || []).map((variant) => variant.runtime_id)]
    .filter((runtimeId) => typeof runtimeId === 'string' && runtimeId)
  if (runtimeIds.length) return runtimeIds.includes(chip.key)
  const modelProvider = providerIdentity(model.provider_hint || model.creator)
  const chipProvider = providerIdentity(chip.provider || String(chip.key || '').split('/')[0])
  if (modelProvider && chipProvider && modelProvider !== chipProvider) return false
  const chipId = identity(chip.id || String(chip.key || '').split('/').at(-1))
  if (!chipId) return false
  const candidates = [model.family_slug, model.slug, ...(model.variants || []).map((variant) => variant.family_slug)]
  return candidates.some((candidate) => identity(candidate) === chipId)
}

export function providerDisplayName(value) {
  const key = String(value || '').toLowerCase().trim()
  if (PROVIDER_NAMES[key]) return PROVIDER_NAMES[key]
  return key.split(/[-_]+/).filter(Boolean).map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join(' ') || 'Unknown provider'
}

export function fallbackModelName(value) {
  const id = String(value || '').split('/').at(-1) || 'Unassigned'
  const parts = id.split(/[-_]+/).filter(Boolean)
  if (parts[0]?.toLowerCase() === 'claude' && /^\d$/.test(parts.at(-2) || '') && /^\d$/.test(parts.at(-1) || '')) {
    parts.splice(-2, 2, `${parts.at(-2)}.${parts.at(-1)}`)
  }
  return parts.map((part) => {
    const lower = part.toLowerCase()
    if (lower === 'gpt' || lower === 'glm') return lower.toUpperCase()
    if (/^\d+b$/i.test(part)) return part.toUpperCase()
    return `${part[0].toUpperCase()}${part.slice(1)}`
  }).join(' ')
}

export function directoryVariantLabel(variant) {
  const effort = variant?.reasoning_effort === 'xhigh' ? 'Extra high'
    : variant?.reasoning_effort ? `${variant.reasoning_effort[0].toUpperCase()}${variant.reasoning_effort.slice(1)}` : null
  const mode = variant?.reasoning_mode === 'non-reasoning' ? 'No reasoning'
    : variant?.reasoning_mode === 'adaptive' ? 'Adaptive' : variant?.reasoning_mode === 'reasoning' ? 'Reasoning' : null
  return [effort, mode].filter(Boolean).join(' · ') || 'Default'
}

export function groupDirectoryModels(models) {
  const families = new Map()
  for (const model of Array.isArray(models) ? models : []) {
    if (!model?.source_id) continue
    const familySlug = model.family_slug || model.slug
    const key = `${model.creator_id || model.provider_hint || model.creator || 'unknown'}/${familySlug}`
    const existing = families.get(key)
    if (existing) existing.variants.push(model)
    else families.set(key, { family_key:key, name:model.family_name || model.name, slug:familySlug, variants:[model] })
  }
  return [...families.values()].map((family) => {
    family.variants.sort((left, right) => {
      const leftRank = EFFORT_ORDER.indexOf(left.reasoning_effort)
      const rightRank = EFFORT_ORDER.indexOf(right.reasoning_effort)
      if (leftRank !== -1 || rightRank !== -1) return (leftRank === -1 ? -1 : leftRank) - (rightRank === -1 ? -1 : rightRank)
      return directoryVariantLabel(left).localeCompare(directoryVariantLabel(right))
    })
    const primary = preferredVariant(family.variants, family.slug)
    return { ...primary, ...family, primary_source_id:primary.source_id, variant_count:family.variants.length }
  })
}

export function selectedDirectoryVariant(family, selections = {}) {
  const sourceId = selections?.[family?.family_key]
  return family?.variants?.find((variant) => variant.source_id === sourceId)
    || family?.variants?.find((variant) => variant.source_id === family.primary_source_id)
    || family?.variants?.[0]
    || family
}

export function mergeModelDirectory({ openRouter, artificialAnalysis } = {}) {
  const openRouterModels = Array.isArray(openRouter?.models) ? openRouter.models : null
  if (!openRouterModels) return aaOnlyDirectory(artificialAnalysis, openRouter?.absent)
  const scoreReason = artificialAnalysis?.configured === false
    ? 'aa-unconfigured'
    : artificialAnalysisUnavailable(artificialAnalysis) ? 'aa-unavailable' : 'not-benchmarked'
  const index = aaCandidateIndex(artificialAnalysis?.models)
  const used = new Set()
  let matched = 0
  const models = openRouterModels.map((model) => {
    const key = identity(openRouterFamilySlug(model))
    const candidate = chooseAaCandidate(index, key)
    if (candidate) { used.add(candidate.index); matched += 1 }
    return mergeOpenRouterModel(model, candidate, scoreReason)
  })
  for (const candidate of index.candidates) {
    if (used.has(candidate.index)) continue
    models.push({ ...candidate.model, runtime_id: null, runtime_id_hint: null, score_absent_reason: 'no-runtime-listing' })
  }
  return {
    ...catalogMetadata(openRouter, artificialAnalysis),
    models,
    absent: firstAbsent(openRouter?.absent, artificialAnalysis?.absent),
    stale: openRouter?.stale === true || artificialAnalysis?.stale === true,
    join: { matched, total: openRouterModels.length },
  }
}
