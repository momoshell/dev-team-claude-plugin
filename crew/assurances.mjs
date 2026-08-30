// The closed assurance-preset vocabulary lives in this import-free leaf (TRD
// §3.4). It NAMES the presets, their legacy aliases, their ascending order and
// their public descriptions. It does not staff them: required seats, capability
// floors, default effort, vendor-diversity policy, reseat order and
// protected-path minimums stay with crew/roster.json and the runtime policy
// that reads it, and nothing here may name one.
// Keep this file import-free because daemon.test.mjs allowlists it as a LEAF.
export const ASSURANCES = Object.freeze({
  quick: Object.freeze({
    name: 'Quick',
    alias: 'mechanical',
    description: 'Lean oversight for routine, low-risk work',
  }),
  standard: Object.freeze({
    name: 'Standard',
    alias: 'build',
    description: 'Balanced oversight for normal change work',
  }),
  rigorous: Object.freeze({
    name: 'Rigorous',
    alias: 'judge',
    description: 'Reinforced judgment for sensitive or high-risk work',
  }),
})

// Ascending: quick → standard → rigorous (TRD §3.4). The current ladder maps
// exactly onto this order, so the index IS the rank.
export const ASSURANCE_NAMES = Object.freeze(['quick', 'standard', 'rigorous'])
// ONE literal source for the aliases: ASSURANCES[key].alias. Both directions are
// derived from it, so the two maps cannot drift from the presets or from each
// other — the parallel-source risk the TRD names, in miniature.
export const ASSURANCE_ALIASES = Object.freeze(Object.fromEntries(
  ASSURANCE_NAMES.map((key) => [ASSURANCES[key].alias, key]),
))
export const ASSURANCE_ALIAS_OF = Object.freeze(Object.fromEntries(
  ASSURANCE_NAMES.map((key) => [key, ASSURANCES[key].alias]),
))
export const DEFAULT_ASSURANCE = 'standard'

export function canonicalAssurance(value) {
  if (typeof value !== 'string') return null
  if (ASSURANCE_NAMES.includes(value)) return value
  return ASSURANCE_ALIASES[value] ?? null
}

export function assuranceRank(value) {
  const index = ASSURANCE_NAMES.indexOf(canonicalAssurance(value))
  return index === -1 ? null : index
}
