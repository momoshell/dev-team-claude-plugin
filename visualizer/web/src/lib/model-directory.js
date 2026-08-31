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

export function directoryModelMatchesChip(model, chip) {
  if (!model || !chip) return false
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
