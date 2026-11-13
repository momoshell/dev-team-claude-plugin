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
  if (argv[0] === 'cd') return argv.length === 2
  if (['cat', 'head', 'tail', 'wc', 'ls'].includes(argv[0])) return true
  if (argv[0] === 'sed') return argv.length >= 3 && argv.length <= 4 && argv[1] === '-n' && /^\d+(,\d+)?p$/.test(argv[2]) && (argv.length === 3 || !argv[3].startsWith('-'))
  return false
}

// Segments joined by `&&`, `||`, `;` or `|` are checked in source order. A one-argument cd,
// literal quoted backslashes and the exact stderr redirects 2>/dev/null and 2>&1 are allowed.
// Only git is refused alongside cd: cat, head, tail, wc, ls, sed, grep and rg were checked
// and do not load configuration or code from their working directory. rg reads ignore files there.
export function readOnlyCommandResult(command, { gitRefusal } = {}) {
  if (typeof command !== 'string' || command.length === 0) return { allowed: false, reason: 'Not read-only: no command given.' }
  const refuse = (segment, why) => ({ allowed: false, reason: `Not read-only: ${JSON.stringify(segment)} (${why}). Rerun only the read-only parts.` })
  let argv = []
  let token = ''
  let started = false
  let quote = null
  let segStart = 0
  let sawCd = false, gitSegment = null
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
    sawCd ||= done[0] === 'cd'
    if (done[0] === 'git') gitSegment = raw
    if (sawCd && gitSegment !== null) return refuse(raw, `git is not allowed in a command with cd: ${JSON.stringify(gitSegment)} reads the configuration of the directory it runs in`)
    if (done[0] === 'git' && typeof gitRefusal === 'string' && gitRefusal.length > 0) return refuse(raw, gitRefusal)
    return segmentReadOnly(done) ? null : refuse(raw, 'not on the read-only list')
  }
  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    if (char === '$' || char === '`' || (char === '\\' && (!quote || (quote === '"' && (index + 1 === command.length || '"\\$`\n\r'.includes(command[index + 1]))))))
      return refuse(rawSegment(index, quote), 'shell expansion or escape')
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
    if (!started && char === '2') {
      const redirect = ['2>/dev/null', '2>&1'].find((value) => command.startsWith(value, index))
      const next = redirect && command[index + redirect.length]
      if (redirect && (next === undefined || /^[\t\v\f ;|&]$/.test(next))) {
        index += redirect.length - 1
        continue
      }
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

function settlePermission({ toolCall, options, permit }) {
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
