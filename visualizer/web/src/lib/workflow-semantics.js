const ASSURANCE = Object.freeze({
  quick: Object.freeze({
    key: 'quick',
    alias: 'mechanical',
    label: 'Quick',
    summary: 'Lean oversight for routine, low-risk work.',
  }),
  standard: Object.freeze({
    key: 'standard',
    alias: 'build',
    label: 'Standard',
    summary: 'Balanced oversight for normal implementation work.',
  }),
  rigorous: Object.freeze({
    key: 'rigorous',
    alias: 'judge',
    label: 'Rigorous',
    summary: 'Reinforced judgment for sensitive or high-risk work.',
  }),
})
const ASSURANCE_ALIAS = Object.freeze(Object.fromEntries(Object.values(ASSURANCE).map((entry) => [entry.alias, entry.key])))

const EXECUTION = Object.freeze({
  standard: Object.freeze({ key: 'standard', label: 'Standard', summary: 'Runs a lane using its selected assurance tier.' }),
  finish: Object.freeze({ key: 'finish', label: 'Finish', summary: 'Continues a stopped lane for an operator decision.' }),
})

function humanize(value) {
  return String(value || '').trim().replaceAll(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export function assuranceMeta(value) {
  const key = typeof value === 'string' && value.trim() ? value.trim() : null
  const canonical = key && ASSURANCE[key] ? key : ASSURANCE_ALIAS[key] ?? null
  if (canonical) return { ...ASSURANCE[canonical], recorded: key, source: key === canonical ? 'canonical' : 'legacy_alias' }
  if (key) return { key, alias: null, recorded: key, source: 'unknown', label: humanize(key), summary: 'Recorded assurance preset.' }
  return { key: null, alias: null, recorded: null, source: 'missing', label: 'Not recorded', summary: 'This run records no assurance preset.' }
}

export function executionMeta(value) {
  const key = typeof value === 'string' && value.trim() ? value.trim() : null
  if (key && EXECUTION[key]) return EXECUTION[key]
  if (key) return { key, label: humanize(key), summary: 'Recorded execution shape.' }
  return { key: null, label: 'Not recorded', summary: 'This run has no recorded execution shape. It may predate configuration recording; the UI never infers one from phase names.' }
}
