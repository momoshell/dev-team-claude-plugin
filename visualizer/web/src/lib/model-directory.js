const EFFORT_ORDER = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function measured(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function preferredVariant(variants, familySlug) {
  const exact = variants.find((variant) => variant.slug === familySlug)
  if (exact) return exact
  return [...variants].sort((left, right) => (measured(right.intelligence) ?? -Infinity) - (measured(left.intelligence) ?? -Infinity))[0]
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
