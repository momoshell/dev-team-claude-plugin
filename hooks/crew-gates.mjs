// Best-effort shell inspection, not a shell parser; uncommon forms and symlinks may be missed.
import { accessSync, constants, existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'

function checkoutAt(cwd) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return null
  for (let dir = resolve(cwd);; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir
    if (dirname(dir) === dir) return null
  }
}

function expand(value) {
  return value.replace(/^~(?=\/|$)/, process.env.HOME).replace(/\$\{HOME\}|\$HOME\b/g, process.env.HOME)
}

// Resolve links before applying later dotdot segments, including links to missing targets.
function destination(path, links) {
  let dir = '/', hops = 0
  const parts = path.split('/')
  while (parts.length) {
    const part = parts.shift()
    if (!part || part === '.') continue
    if (part === '..') { dir = dirname(dir); continue }
    const next = join(dir, part)
    let link
    try { link = lstatSync(next).isSymbolicLink() } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return null
    }
    if (!link) { dir = next; continue }
    links?.push(next + '/')
    if (++hops > 40) return null
    try {
      const target = readlinkSync(next)
      if (isAbsolute(target)) dir = '/'
      parts.unshift(...target.split('/'))
    } catch { return null }
  }
  return dir
}

function protectedRoot(value, cwd) {
  const target = expand(value)
  const path = isAbsolute(target) ? target : `${cwd}/${target}`
  const projects = join(process.env.HOME, '.claude/projects')
  // Claude Code keeps each project's auto-memory beside its transcripts; only the transcripts are operator words.
  // The exception holds only when the resolved destination is still a memory directory, so a symlink cannot reach a transcript.
  const memoryOf = (p, root) => {
    const parts = p.startsWith(root + '/') ? p.slice(root.length + 1).split('/') : []
    return parts[1] === 'memory' && parts.length > 2 ? parts[0] : null
  }
  const links = [], projectsRoot = destination(projects), landed = destination(path, links)
  if (!landed || !projectsRoot) return undefined
  // A link traversed in one project's memory must not redirect into another project's memory.
  const origin = [...links.map(link => memoryOf(link, projectsRoot)), memoryOf(resolve(path), projects), memoryOf(path, projects)].find(project => project !== null)
  // Unlink and rename operate on the final pathname, even when it is a symlink.
  const parent = destination(dirname(path))
  const pathname = parent && join(parent, basename(path))
  const protectedPaths = [landed, pathname].filter(p => {
    if (!p) return false
    const project = memoryOf(p, projectsRoot)
    return project === null || (origin !== undefined && origin !== project)
  })
  return [projects, join(process.env.HOME, '.crew/briefs/started')]
    .find(root => {
      const resolved = destination(root)
      return resolved && protectedPaths.some(p => p === resolved || p.startsWith(resolved + '/'))
    })
}

function crewHome(words, cwd, crewHome) {
  let executable, verb, direct
  if (words[0] === 'crew') {
    verb = words[1]
    if (crewHome) return ['start', 'finish'].includes(verb) ? [resolve(cwd, expand(crewHome)), verb] : null
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      const candidate = resolve(cwd, dir, 'crew')
      try { accessSync(candidate, constants.X_OK); executable = realpathSync(candidate); break } catch {}
    }
  } else if (words[0] === 'node' && words[1]) {
    const path = resolve(cwd, expand(words[1]))
    const match = path.match(/^(.*)\/crew\/(start|finish)\.mjs$/)
    if (match) { executable = path; direct = match[2] } else if (path.endsWith('/bin/crew.mjs')) executable = path
    verb = direct ?? words[2]
    if (crewHome && !direct && ['start', 'finish'].includes(verb)) return [resolve(cwd, expand(crewHome)), verb]
  }
  if (!executable || !['start', 'finish'].includes(verb)) return null
  try { return [dirname(dirname(realpathSync(executable))), verb] } catch { return null }
}

function staleCrew(words, cwd, home) {
  const found = crewHome(words, cwd, home)
  if (!found) return null
  const [root, verb] = found
  try {
    const source = readFileSync(join(root, 'crew', `${verb}.mjs`), 'utf8')
    if (!source.includes('requireOnboarded') || (verb === 'start' && !source.includes('askProvenance'))) return root
  } catch {}
  return null
}

function inspectBash(command, initialCwd) {
  // Quotes keep whitespace and operators inside a word; expansions other than HOME are unknown.
  const tokens = command.match(/\d*>>?|\d*<|(?:[^\s'";&|<>]+|'[^']*'|"[^"]*")+|&&|\|\||[;|\n]/g) ?? []
  let cwd = initialCwd, segment = []
  function inspect() {
    const words = [], targets = []
    for (let i = 0; i < segment.length; i++) {
      if (/^\d*[<>]/.test(segment[i])) {
        if (segment[i].includes('>') && segment[i + 1]) targets.push(segment[i + 1].replace(/['"]/g, ''))
        i++
      } else words.push(segment[i].replace(/['"]/g, ''))
    }
    let home = process.env.CREW_HOME
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? '')) {
      const assignment = words.shift()
      if (assignment.startsWith('CREW_HOME=')) home = assignment.slice('CREW_HOME='.length)
    }
    const stale = staleCrew(words, cwd, home)
    if (stale) return `crew at ${stale} lacks the required gates; run from the local checkout.`
    const args = words.slice(1).filter(word => !word.startsWith('-'))
    if (['tee', 'rm', 'mv', 'touch', 'truncate', 'unlink'].includes(words[0])) targets.push(...args)
    if (['cp', 'ln'].includes(words[0]) && args.length >= 2) targets.push(args.at(-1))
    if (words[0] === 'sed' && words.some(word => /^-i/.test(word)) && args.length >= 2) targets.push(...args.slice(1))
    for (const target of targets) {
      const root = protectedRoot(target, cwd)
      if (root) return `Writes to ${root} are protected.`
    }
    // Bash's default cd applies dotdot logically; write targets still resolve links physically.
    if (words[0] === 'cd' && words[1]) cwd = resolve(cwd, expand(words[1]))
    return null
  }
  for (const token of tokens) {
    if (['&&', '||', ';', '|', '\n'].includes(token)) {
      const reason = inspect()
      if (reason) return reason
      segment = []
    } else segment.push(token)
  }
  return inspect()
}

async function main() {
  if (process.env.CREW_ROLE !== undefined) return
  const input = JSON.parse(readFileSync(0, 'utf8'))
  const checkout = checkoutAt(input.cwd)
  if (!checkout) return
  if (process.argv[2] === 'session-start') {
    const { requireOnboarded, OnboardRefusal } = await import('../crew/onboard.mjs')
    try { requireOnboarded(checkout) } catch (error) {
      if (!(error instanceof OnboardRefusal)) throw error
      const state = error.reason === 'onboarding-stale' ? 'onboarded but stale' : 'not onboarded'
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `crew: this checkout is ${state} (${error.reason}); run /onboard before dispatching a lane.` } }))
    }
  } else if (process.argv[2] === 'pre-tool-use') {
    let reason
    if (['Write', 'Edit'].includes(input.tool_name) && typeof input.tool_input?.file_path === 'string') {
      const root = protectedRoot(input.tool_input.file_path, input.cwd)
      if (root) reason = `Writes to ${root} are protected.`
    } else if (input.tool_name === 'Bash' && typeof input.tool_input?.command === 'string') reason = inspectBash(input.tool_input.command, input.cwd)
    if (reason) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }))
  }
}

try { await main() } catch {} // Hooks never block on their own failures.
