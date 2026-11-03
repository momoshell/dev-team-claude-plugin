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

export function settlePermission({ toolCall, options, permit }) {
  const reject = options.find((o) => o.kind === 'reject_once') ?? options.find((o) => o.kind === 'reject_always')
  if (!reject) throw Object.assign(new Error('permission-no-reject-option'), { reason: 'permission-no-reject-option' })
  let allowed = false
  try { allowed = permit(toolCall) === true } catch { /* fail closed */ }
  const selected = allowed ? options.find((o) => o.kind === 'allow_once') ?? reject : reject
  return { optionId: selected.optionId }
}

export function permissionHandler({ permit } = {}) {
  return ({ toolCall, options }) => {
    try {
      return settlePermission({ toolCall, options, permit }).optionId
    } catch (err) {
      if (err?.reason === 'permission-no-reject-option') return null
      throw err
    }
  }
}
