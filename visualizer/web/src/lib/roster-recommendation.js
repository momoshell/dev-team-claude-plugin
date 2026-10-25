// Presentation only. Eligibility and selection remain owned by the routing policy.
const REASONS = {
  'measurement-absent': 'No matching evaluation results for this role and configuration.',
  'rate-absent': 'Evaluation pass counts are missing.',
  'rate-thin': 'Too few evaluation results to meet the policy’s minimum sample size.',
  'rate-invalid': 'Evaluation pass counts need correction.',
  'cost-absent': 'Token usage or pricing is missing, so cost cannot be compared.',
  'cost-invalid': 'Token usage or pricing needs correction before cost can be compared.',
  'measurement-invalid': 'Evaluation data needs correction.',
  'capability-shortfall': 'Does not meet the required capabilities.',
  'agent-unresolved': 'The execution adapter could not be resolved.',
  'band-unknown': 'The capability level has not been established.',
  'band-below-floor': 'Below the minimum capability level for this preset.',
  'breaker-open': 'Temporarily excluded by runtime health checks.',
  'undeclared-candidate': 'Not included in the configured routing policy.',
}

export function candidateExplanation(candidate) {
  if (candidate?.eligible === true) return 'Meets the routing policy’s selection requirements.'
  return REASONS[candidate?.exclusion_reason || candidate?.reason]
    || 'Not eligible for a recommendation; no recognized reason was reported.'
}

export function candidateMetrics(candidate) {
  const facts = []
  const rate = candidate?.rate
  if (!rate?.reason && Number.isFinite(rate?.value) && Number.isSafeInteger(rate.numerator)
    && Number.isSafeInteger(rate.denominator) && rate.denominator > 0 && rate.numerator >= 0
    && rate.numerator <= rate.denominator) {
    facts.push(`Evaluation pass rate: ${(rate.numerator / rate.denominator * 100).toFixed(0)}% (${rate.numerator}/${rate.denominator})`)
  }
  const cost = candidate?.cost
  if (!cost?.reason && Number.isFinite(cost?.value) && cost.value >= 0) {
    const amount = cost.value === 0 ? '$0' : cost.value < 0.0001 ? '<$0.0001' : `$${cost.value.toFixed(4)}`
    facts.push(`Estimated evaluation cost: ${amount}`)
  }
  return facts
}

export function rosterRecommendation(pick) {
  if (!pick || pick.unavailable || !['chosen', 'abstained'].includes(pick.outcome)) {
    return { title: 'Recommendation unavailable', description: 'The recommendation could not be read. You can still choose a model manually.', suggested: false }
  }
  const chosen = pick.chosen_cell
  if (pick.outcome === 'chosen' && chosen?.provider && chosen?.id && chosen?.agent && chosen?.effort) {
    const same = ['provider', 'id', 'agent', 'effort'].every((key) => chosen[key] === pick.current_cell?.[key])
    return {
      title: same ? 'Current assignment recommended' : 'Suggested assignment',
      description: 'Selected from the configured candidates by the routing policy’s evaluation and cost rules. This does not change your roster.',
      suggested: !same,
      chosen,
    }
  }
  const candidates = Array.isArray(pick.policy_candidates) ? pick.policy_candidates : []
  const missing = candidates.length > 0 && candidates.every((candidate) => (candidate.exclusion_reason || candidate.reason) === 'measurement-absent')
  return {
    title: 'No recommendation yet',
    description: missing
      ? 'The configured candidates have no matching evaluation results for this role. You can keep the current assignment or choose a model manually.'
      : 'No candidate could be recommended from the available evidence and routing rules. You can keep the current assignment or choose a model manually.',
    suggested: false,
  }
}
