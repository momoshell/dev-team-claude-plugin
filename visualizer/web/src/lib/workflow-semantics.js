const ASSURANCE = Object.freeze({
  mechanical: Object.freeze({
    key: 'mechanical',
    label: 'Quick',
    summary: 'Lean oversight for routine, low-risk work.',
    staffing: 'Planner, builder and reviewer; no lead seat.',
  }),
  build: Object.freeze({
    key: 'build',
    label: 'Standard',
    summary: 'Balanced oversight for normal implementation work.',
    staffing: 'Lead, planner, builder and reviewer.',
  }),
  judge: Object.freeze({
    key: 'judge',
    label: 'Rigorous',
    summary: 'Reinforced judgment for sensitive or high-risk work.',
    staffing: 'Lead, planner, builder, reviewer and tech lead.',
  }),
})

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
  if (key && ASSURANCE[key]) return ASSURANCE[key]
  if (key) return { key, label: humanize(key), summary: 'Recorded assurance preset.', staffing: 'Staffing details are not described by this visualizer.' }
  return { key: null, label: 'Not recorded', summary: 'This run records no assurance preset.', staffing: 'It may predate tier recording or have been booted with explicit roles.' }
}

export function assuranceOption(value) {
  const meta = assuranceMeta(value)
  return { value, label: meta.key ? `${meta.label} · ${meta.key}` : meta.label }
}

export function executionMeta(value) {
  const key = typeof value === 'string' && value.trim() ? value.trim() : null
  if (key && EXECUTION[key]) return EXECUTION[key]
  if (key) return { key, label: humanize(key), summary: 'Recorded execution shape.' }
  return { key: null, label: 'Not recorded', summary: 'The run shape was not measured; it is never inferred from phase names.' }
}

export function taskProfileMeta(value) {
  const key = typeof value === 'string' && value.trim() ? value.trim() : null
  if (key) return { key, label: humanize(key), summary: 'Recorded task intent.' }
  return { key: null, label: 'Not recorded', summary: 'Task profiles are not recorded by the current runtime, so this UI does not infer one.' }
}

export function runConfiguration(run = {}) {
  return {
    profile: taskProfileMeta(run?.task_profile),
    execution: executionMeta(run?.variant),
    assurance: assuranceMeta(run?.tier),
  }
}

export const ASSURANCE_KEYS = Object.freeze(Object.keys(ASSURANCE))
