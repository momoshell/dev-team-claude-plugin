// Pure scope matching and tier reconciliation shared by dispatch and its preview.
import { ASSURANCE_NAMES, ASSURANCE_ALIAS_OF, ASSURANCE_ALIASES } from './assurances.mjs'
import { protectedHitsIn } from './protected-paths.mjs'
import { parseFenceScope } from './fence-scope.mjs'
const tiers = ASSURANCE_NAMES.map(name => ASSURANCE_ALIAS_OF[name])
export function assuranceScopeHits(files, paths) {
  return protectedHitsIn((Array.isArray(files) ? files : []).map(entry => {
    const parsed = parseFenceScope(entry)
    return parsed.kind === 'span' ? parsed.path : entry
  }), paths)
}
export function reconcileTierChoice({forced,recommended,requested,requestedFrom='lane'}={}) {
  const conflict = !!(forced && requestedFrom !== 'batch' && requested && tiers.indexOf(requested) < tiers.indexOf(forced))
  const known = [forced,requested,requested == null ? recommended : null].filter(tier => tiers.includes(tier))
  const tier = known.length === 0 ? null : known.reduce((best,candidate) => tiers.indexOf(candidate)>tiers.indexOf(best) ? candidate : best)
  const warning = requested != null && tiers.includes(recommended) && tiers.includes(requested) && tiers.indexOf(recommended)>tiers.indexOf(requested)
    ? `requested ${ASSURANCE_ALIASES[requested] || requested} below recommendation ${ASSURANCE_ALIASES[recommended] || recommended}; request retained` : null
  return {tier,conflict,warning}
}
