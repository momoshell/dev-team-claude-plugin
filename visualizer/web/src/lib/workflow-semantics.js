const ASSURANCE = Object.freeze({
  quick: Object.freeze({
    key: 'quick',
    alias: 'mechanical',
    label: 'Quick',
    summary: 'Lean oversight for routine, low-risk work.',
    staffing: 'Planner, builder and reviewer; no lead seat.',
  }),
  standard: Object.freeze({
    key: 'standard',
    alias: 'build',
    label: 'Standard',
    summary: 'Balanced oversight for normal implementation work.',
    staffing: 'Lead, planner, builder and reviewer.',
  }),
  rigorous: Object.freeze({
    key: 'rigorous',
    alias: 'judge',
    label: 'Rigorous',
    summary: 'Reinforced judgment for sensitive or high-risk work.',
    staffing: 'Lead, planner, builder, reviewer and tech lead.',
  }),
})
const ASSURANCE_ALIAS = Object.freeze(Object.fromEntries(Object.values(ASSURANCE).map((entry) => [entry.alias, entry.key])))

const EXECUTION = Object.freeze({
  full: Object.freeze({ key: 'full', label: 'Full reviewed', summary: 'Plan, build, validate, review and finish.' }),
  scout: Object.freeze({ key: 'scout', label: 'Scout', summary: 'Read-only investigation ending in a structured return.' }),
  repair: Object.freeze({ key: 'repair', label: 'Repair', summary: 'Bounded continuation from a recorded failure.' }),
  directed: Object.freeze({ key: 'directed', label: 'Directed', summary: 'Build from an orchestrator-authored plan and gate.' }),
})

function humanize(value) {
  return String(value || '').trim().replaceAll(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export function assuranceMeta(value) {
  const key = typeof value === 'string' && value.trim() ? value.trim() : null
  const canonical = key && ASSURANCE[key] ? key : ASSURANCE_ALIAS[key] ?? null
  if (canonical) return { ...ASSURANCE[canonical], recorded: key, source: key === canonical ? 'canonical' : 'legacy_alias' }
  if (key) return { key, alias: null, recorded: key, source: 'unknown', label: humanize(key), summary: 'Recorded assurance preset.', staffing: 'Staffing details are not described by this visualizer.' }
  return { key: null, alias: null, recorded: null, source: 'missing', label: 'Not recorded', summary: 'This run records no assurance preset.', staffing: 'It may predate configuration recording or have been booted with explicit roles.' }
}

export function assuranceOption(value) {
  const meta = assuranceMeta(value)
  return { value, label: meta.key ? `${meta.label} · ${meta.recorded}` : meta.label }
}

export function executionMeta(value) {
  const key = typeof value === 'string' && value.trim() ? value.trim() : null
  if (key && EXECUTION[key]) return EXECUTION[key]
  if (key) return { key, label: humanize(key), summary: 'Recorded execution shape.' }
  return { key: null, label: 'Not recorded', summary: 'This run has no recorded execution shape. It may predate configuration recording; the UI never infers one from phase names.' }
}

export function taskProfileMeta(value) {
  const key = typeof value === 'string' && value.trim() ? value.trim() : null
  if (key) return { key, label: humanize(key), summary: 'Recorded task intent.' }
  return { key: null, label: 'Not recorded', summary: 'This run has no recorded task profile. It may predate configuration recording; this UI does not infer one.' }
}

export function runConfiguration(run = {}) {
  const recorded = run?.configuration && typeof run.configuration === 'object' ? run.configuration : null
  const profileValue = recorded?.task_profile?.effective ?? run?.task_profile
  const executionValue = recorded?.execution?.effective ?? run?.execution_shape ?? run?.variant
  const canonicalAssurance = recorded?.assurance?.effective ?? (typeof run?.assurance === 'string' && run.assurance.trim() ? run.assurance : null)
  const legacyTier = recorded?.legacy_tier ?? (typeof run?.tier === 'string' && run.tier.trim() ? run.tier : null)
  const assurance = assuranceMeta(canonicalAssurance ?? legacyTier)
  return {
    profile: { ...taskProfileMeta(profileValue), requested: recorded?.task_profile?.requested ?? null, source: recorded?.task_profile?.source ?? (profileValue ? 'recorded' : 'legacy_missing') },
    execution: { ...executionMeta(executionValue), requested: recorded?.execution?.requested ?? null, source: recorded?.execution?.source ?? (executionValue ? 'recorded' : 'legacy_missing') },
    assurance: {
      ...assurance,
      requested: recorded?.assurance?.requested ?? null,
      legacy_alias: legacyTier,
      source: recorded?.assurance?.source ?? (canonicalAssurance ? 'recorded' : legacyTier ? 'legacy_alias' : 'legacy_missing'),
      recording: canonicalAssurance ? 'canonical' : legacyTier ? 'legacy_alias' : 'missing',
    },
  }
}

export const ASSURANCE_KEYS = Object.freeze(Object.keys(ASSURANCE))
