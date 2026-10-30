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

export function readOnlyCommand(command) {
  return readOnlyCommandResult(command).allowed
}

const SAFE_GIT_VERBS = new Set(['diff', 'log', 'show', 'status', 'blame', 'rev-parse', 'ls-files', 'grep'])
const FORBIDDEN_GIT_ARGS = ['--output', '--ext-diff', '-O', '--open-files-in-pager']

function segmentReadOnly(argv) {
  if (argv[0] === 'git') {
    if (!SAFE_GIT_VERBS.has(argv[1])) return false
    return argv.every((arg) => {
      const name = arg.split('=', 1)[0]
      return !FORBIDDEN_GIT_ARGS.some((prefix) => arg.startsWith(prefix))
        && !/^-[^-]*O/.test(arg)
        && !FORBIDDEN_GIT_ARGS.some((forbidden) => forbidden.startsWith('--') && name.startsWith('--') && name.length > 2 && forbidden.startsWith(name))
    })
  }
  if (['grep', 'rg'].includes(argv[0]))
    return !argv.some((arg) => arg.startsWith('--pre') || arg.startsWith('--hostname-bin'))
  if (['cat', 'head', 'tail', 'wc', 'ls'].includes(argv[0])) return true
  if (argv[0] === 'sed') return argv.length >= 3 && argv.length <= 4 && argv[1] === '-n' && /^\d+(,\d+)?p$/.test(argv[2])
  return false
}

// Segments joined by `&&`, `||`, `;` or `|` are read-only when every segment is. Segments are
// checked in source order, so the reason names the first one that is not.
export function readOnlyCommandResult(command) {
  if (typeof command !== 'string' || command.length === 0) return { allowed: false, reason: 'Not read-only: no command given.' }
  const refuse = (segment, why) => ({ allowed: false, reason: `Not read-only: ${JSON.stringify(segment)} (${why}). Rerun only the read-only parts.` })
  let argv = []
  let token = ''
  let started = false
  let quote = null
  let segStart = 0
  const finishToken = () => {
    if (started) argv.push(token)
    token = ''
    started = false
  }
  // The raw text of the segment that holds `from`, up to its next separator.
  const rawSegment = (from, inQuote) => {
    let q = inQuote
    let end = command.length
    for (let i = from; i < command.length; i++) {
      const c = command[i]
      if (q) { if (c === q) q = null; continue }
      if (c === "'" || c === '"') { q = c; continue }
      if (c === ';' || c === '|' || (c === '&' && command[i + 1] === '&')) { end = i; break }
    }
    return command.slice(segStart, end).trim()
  }
  const closeSegment = (end) => {
    finishToken()
    const raw = command.slice(segStart, end).trim()
    if (argv.length === 0) return refuse(raw, 'empty command segment')
    const done = argv
    argv = []
    return segmentReadOnly(done) ? null : refuse(raw, 'not on the read-only list')
  }
  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    if (char === '\\' || char === '$' || char === '`') return refuse(rawSegment(index, quote), 'shell expansion or escape')
    if (char === '\n' || char === '\r') return refuse(rawSegment(index, quote), 'newline')
    if (quote) {
      if (char === quote) quote = null
      else token += char
      started = true
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
      continue
    }
    let width = 0
    if (char === ';' || char === '|') width = char === '|' && command[index + 1] === '|' ? 2 : 1
    else if (char === '&' && command[index + 1] === '&') width = 2
    if (width) {
      const failure = closeSegment(index)
      if (failure) return failure
      index += width - 1
      segStart = index + 1
      continue
    }
    if ('&><(){}'.includes(char)) return refuse(rawSegment(index, quote), 'background, redirection or grouping')
    if (/^[\t\v\f ]$/.test(char)) {
      finishToken()
      continue
    }
    token += char
    started = true
  }
  if (quote) return refuse(rawSegment(command.length, quote), 'unterminated quote')
  return closeSegment(command.length) ?? { allowed: true, reason: null }
}

export function panelPermission(toolCall) {
  const mutating = ['edit', 'write', 'delete', 'move']
  if (mutating.some((value) => toolCall?.kind === value || toolCall?.title === value))
    return { policy: 'roster', verdict: 'reject' }
  if (toolCall?.kind === 'execute')
    return { policy: 'roster', verdict: readOnlyCommand(toolCall?.rawInput?.command) ? 'allow' : 'reject' }
  return null
}

export function settlePermission({ request, toolCall = request?.toolCall, options = request?.options, policy = {}, lead, log = () => {} }) {
  const reject = options.find((o) => o.kind === 'reject_once') ?? options.find((o) => o.kind === 'reject_always')
  if (!reject) throw Object.assign(new Error('permission-no-reject-option'), { reason: 'permission-no-reject-option' })

  const allow = options.find((o) => o.kind === 'allow_once')
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
      if (answer?.policy === 'roster' && (answer.verdict === 'allow' || answer.verdict === 'reject')) {
        source = answer.policy
        selected = answer.verdict === 'allow' ? options.find((o) => o.kind === 'allow_once') ?? reject : reject
      } else {
        decision = answer?.decision ?? answer?.details?.decision
      }
    } catch {
      decision = null
    }
    if (source !== 'roster') {
      answered = decision ?? null
      const match = options.find((o) => o.optionId === decision)
      selected = match?.kind === 'allow_always' ? options.find((o) => o.kind === 'allow_once') ?? reject : match ?? reject
    }
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
