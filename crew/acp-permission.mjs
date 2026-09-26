export const PERMISSION_POLICIES = Object.freeze(['roster', 'lead', 'no-lead'])
export const PERMISSION_REFUSALS = Object.freeze(['permission-no-reject-option'])

export function permitQuestion({ toolCall, options }) {
  return [
    `Permit tool call: ${toolCall?.title ?? ''}`,
    `Kind: ${toolCall?.kind ?? ''}`,
    `Input: ${JSON.stringify(toolCall?.rawInput)}`,
    ...options.map((o) => `Option: optionId=${o.optionId}, kind=${o.kind}, name=${o.name}`),
    'Out-of-task-scope calls must be rejected.',
    'Provide exactly one request optionId in details.decision.',
  ].join('\n')
}

export function settlePermission({ request, toolCall = request?.toolCall, options = request?.options, policy = {}, lead, log = () => {} }) {
  const reject = options.find((o) => o.kind === 'reject_once') ?? options.find((o) => o.kind === 'reject_always')
  if (!reject) throw Object.assign(new Error('permission-no-reject-option'), { reason: 'permission-no-reject-option' })

  const allow = options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.kind === 'allow_always')
  const keys = [toolCall?.title, toolCall?.kind].filter((key) => typeof key === 'string')
  policy = { autoDeny: policy.autoDeny ?? [], autoApprove: policy.autoApprove ?? [] }
  let selected
  let source
  let answered
  if (keys.some((key) => policy.autoDeny.includes(key))) selected = reject
  else if (keys.some((key) => policy.autoApprove.includes(key))) selected = allow ?? reject
  if (selected) source = 'roster'
  else if (lead == null) { selected = reject; source = 'no-lead' }
  else {
    source = 'lead'
    const payload = { question: 'permit', tool_call: toolCall, options: options.map((o) => o.optionId), text: permitQuestion({ toolCall, options }) }
    let decision
    try {
      const answer = lead(payload)
      decision = answer?.decision ?? answer?.details?.decision
    } catch {
      decision = null
    }
    answered = decision ?? null
    const match = options.find((o) => o.optionId === decision)
    selected = match ?? reject
  }

  const row = {
    kind: 'permission',
    tool: toolCall?.kind ?? null,
    title: toolCall?.title ?? null,
    option_kind: selected.kind,
    option: selected.optionId,
    policy: source,
    ...(source === 'lead' ? { answered: answered ?? null } : {}),
  }
  try { log(row) } catch { /* journal is advisory */ }
  return { optionId: selected.optionId, row }
}

export function permissionHandler({ policy, lead, log } = {}) {
  return ({ toolCall, options }) => {
    try {
      return settlePermission({ toolCall, options, policy, lead, log }).optionId
    } catch (err) {
      if (err?.reason === 'permission-no-reject-option') {
        try { log?.({ kind: 'permission', reason: 'permission-no-reject-option' }) } catch { /* journal is advisory */ }
        return null
      }
      throw err
    }
  }
}
