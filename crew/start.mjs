// crew start <brief.md> [--checkout <dir>]
//
// The lean entry (ADR-052): one P1 brief in, one running lane out. It checks the
// brief, creates the lane worktree and starts the run detached, handing the brief to the
// planner as its whole input. No compile, no baseline, no gate. The lane name is the
// brief's file name.
//
// The start stands on the brief parser and the agent definitions alone. It refuses before any
// git call when the brief is not P1 or the definitions do not resolve.
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GIT_STATUS_ARGS, LANE } from './lane-core.mjs'
import { runSuite } from './checks.mjs'
import { ISSUE_SOURCE, parseBrief, TIERS } from './protocols.mjs'
import { resolveAgents, loadRoster, snapshotRoster } from './agents.mjs'
import { writeRunPid } from './run-pid.mjs'
import { askProvenance, readOperatorMessages } from './brief-provenance.mjs'
import { OnboardRefusal, requireOnboarded, SUITE_TIMEOUT_DEFAULT_MS, WORKTREE_SETUP_TIMEOUT_MS } from './onboard.mjs'

const HOME = dirname(dirname(fileURLToPath(import.meta.url)))
const LEAN = join(HOME, 'crew', 'lean.mjs')

export class StartRefusal extends Error {}

export function laneName(briefPath) {
  const lane = basename(briefPath).replace(/\.md$/, '')
  if (!LANE.test(lane)) throw new StartRefusal(`the brief file name ${JSON.stringify(basename(briefPath))} is not a lane name: lowercase letters, digits and -, then .md`)
  return lane
}

export function runBrief(text, closes, ask = null, title = null) {
  if (ask !== null) {
    const quote = ask.trimEnd().split(/\r?\n/).map((line) => line.trim() ? `> ${line}` : '>').join('\n')
    text = text.replace(/^([^\S\r\n]*---[^\S\r\n]*\r?\n[\s\S]*?\r?\n[^\S\r\n]*---[^\S\r\n]*\r?\n)/, (front) => `${front}${title === null ? '' : `Issue title: ${title.replace(/\s+/g, ' ').trim()}\n`}## The ask\n\n${quote}\n\n`)
  }
  return `# Task\n${closes ? `<!-- crew:bound-issue #${closes} -->\n` : ''}\n${text}`
}

// Keep the handler installed for errors emitted after the write (or main) returns.
const ignoreStdoutError = () => {}
function logStdout(line) {
  try {
    if (!process.stdout.listeners('error').includes(ignoreStdoutError)) process.stdout.on('error', ignoreStdoutError)
    process.stdout.write(`${line}\n`)
  } catch { /* Printing is best-effort. */ }
}

const defaultDeps = () => ({
  readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync, rmSync, openSync, closeSync, resolveAgents, snapshotRoster, runSuite,
  spawnSync: (file, args, options) => spawnSync(file, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024, ...options }),
  spawnDetached: (file, args, { cwd, log, env }) => {
    const out = openSync(log, 'a')
    try {
      const child = spawn(file, args, { cwd, env, detached: true, stdio: ['ignore', out, out] })
      child.on('error', () => {})
      child.unref()
      return child.pid
    } finally { closeSync(out) }
  },
  now: Date.now,
  crewRoot: join(homedir(), '.crew'),
  transcriptRoot: join(homedir(), '.claude', 'projects'),
  log: logStdout,
})

function git(d, checkout, args) {
  const result = d.spawnSync('git', ['-C', checkout, ...args])
  return result.status === 0 ? String(result.stdout).trim() : null
}

// A project command as a spec command: whitespace-split, no shell.
function suiteSpec(suite, timeoutMs = SUITE_TIMEOUT_DEFAULT_MS) {
  const [command, ...args] = suite.trim().split(/\s+/)
  return { command, args, timeoutMs }
}

export async function startLane({ briefPath, checkout, deps = {} }) {
  const d = { ...defaultDeps(), ...deps }
  const logLine = (line) => { try { d.log(line) } catch { /* Instrumentation must not affect the start. */ } }
  const lane = laneName(briefPath)
  const text = d.readFileSync(briefPath, 'utf8')
  const { fields, ask: quotedAsk, paths, defects } = parseBrief(text)
  if (defects.length) throw new StartRefusal(`brief ${briefPath} is not a P1 brief:\n- ${defects.join('\n- ')}`)
  if (fields.shape === 'finish') throw new StartRefusal('shape finish starts from an escalated lane, not a new brief; crew start runs standard only')
  if (quotedAsk.length) {
    const { messages, reason } = readOperatorMessages({ root: d.transcriptRoot })
    if (messages === null) logLine(`crew start: ask provenance unmeasured: ${reason}`)
    else {
      const missing = askProvenance(quotedAsk, messages)
      if (missing.length) throw new StartRefusal(`brief ${briefPath} quotes words the operator did not type (ADR-056):\n- ${missing.join('\n- ')}`)
    }
  }
  const tier = fields.mechanical === true ? 'mechanical' : 'build'
  let resolved
  try { resolved = d.resolveAgents(tier) } catch (cause) { throw new StartRefusal(`cannot resolve the agent definitions: ${cause.message}`, { cause }) }
  checkout ??= git(d, process.cwd(), ['rev-parse', '--show-toplevel'])
  if (!checkout) throw Object.assign(new StartRefusal('not inside a git checkout; pass --checkout <dir>'), { exitCode: 2 })
  let project
  try { project = requireOnboarded(checkout, d.readFileSync) } catch (error) {
    if (error instanceof OnboardRefusal) throw new StartRefusal(error.message, { cause: error })
    throw error
  }
  let roster
  try {
    roster = loadRoster({ personal: join(d.crewRoot, 'agents.json'), project: join(checkout, '.crew', 'agents.json'), readFileSync: d.readFileSync })
    if (roster.files.length) for (const t of TIERS) {
      let result
      try { result = d.resolveAgents(t, undefined, roster.overrides) } catch (cause) {
        const keys = Object.entries(roster.overrides).flatMap(([role, entry]) => Object.keys(entry).map((key) => `${role}.${key}`))
        throw new Error(`${keys.join(', ')}: ${cause.message}`, { cause })
      }
      const required = t === 'mechanical' ? ['builder'] : t === 'judge' ? ['planner', 'builder', 'reviewer', 'tech-lead'] : ['planner', 'builder', 'reviewer']
      for (const role of required) if (!result.seats?.[role]) throw new Error(`${role}.tiers.${t} leaves a required seat unseated`)
      if (t === tier) resolved = result
    }
    roster.snapshot = d.snapshotRoster(roster.overrides)
  } catch (cause) {
    throw new StartRefusal(`cannot resolve roster ${roster?.files.map((file) => file.path).join(', ') ?? ''}: ${cause.message}`, { cause })
  }
  const worktree = join(dirname(checkout), `dt-${lane}`)
  const crewDir = join(d.crewRoot, `dt-${lane}`, lane)
  if (d.existsSync(crewDir)) throw new StartRefusal(`crew lane directory ${crewDir} already exists; pick another lane name or use crew closeout ${lane} or crew closeout ${lane} --discard`)
  if (d.existsSync(worktree)) throw new StartRefusal(`worktree ${worktree} already exists; pick another lane name or use crew closeout ${lane} or crew closeout ${lane} --discard`)
  const remoteHead = git(d, checkout, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (!remoteHead) throw new StartRefusal('cannot read origin/HEAD; repair it with git remote set-head origin --auto')
  const base = remoteHead.replace(/^origin\//, '')
  const fetch = d.spawnSync('git', ['-C', checkout, 'fetch', '--refmap=', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`])
  if (fetch.status !== 0) throw new StartRefusal(`cannot fetch ${base} from origin: ${fetch.error?.message || String(fetch.stderr ?? '').trim() || (fetch.signal ? 'git interrupted' : `git exited with status ${fetch.status}`)}${fetch.signal ? ` (signal ${fetch.signal})` : ''}; the lane was not started and the local branch was not used`)
  const baseCommit = git(d, checkout, ['rev-parse', '--verify', `refs/remotes/origin/${base}^{commit}`])
  if (!baseCommit) throw new StartRefusal(`cannot resolve lane base origin/${base}`)
  const missing = paths.filter((path) => {
    const name = posix.normalize(path).replace(/\/+$/, '') || '.'
    if (git(d, checkout, ['cat-file', '-e', `${baseCommit}:${name}`]) === null) return true
    const parts = name === '.' ? [] : name.split('/')
    return parts.some((_, i) => {
      const prefix = parts.slice(0, i + 1).join('/')
      const entry = git(d, checkout, ['--literal-pathspecs', 'ls-tree', '-z', baseCommit, '--', prefix])
      return !entry || !/^(?:040000 tree|100(?:644|755) blob) [0-9a-f]+\t/.test(entry) || entry.slice(entry.indexOf('\t') + 1).replace(/\0$/, '') !== prefix
    })
  })
  if (missing.length) throw new StartRefusal(`brief ${briefPath} could not verify ## Context paths on origin/${base} (ADR-056 Amendment 1); they may be missing, symlinks, submodules, or the git check may have failed:\n- ${missing.join('\n- ')}`)
  const entry = git(d, checkout, ['ls-tree', baseCommit, '--', '.crew/project.json'])
  const config = /^100(?:644|755) blob [0-9a-f]+\t\.crew\/project\.json$/.test(entry ?? '')
    ? git(d, checkout, ['show', `${baseCommit}:.crew/project.json`]) : null
  try {
    const baseProject = requireOnboarded(checkout, () => {
      if (config === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return config
    })
    if (baseProject.hash !== project.hash) throw new OnboardRefusal('onboarding-stale')
  } catch (error) {
    if (error instanceof OnboardRefusal) throw new StartRefusal(`lane base origin/${base}: ${error.message}; commit the approved .crew/project.json to ${base} and push it so the commit reaches origin/${base} before starting`, { cause: error })
    throw error
  }
  let ask = null, title = null
  const issue = ISSUE_SOURCE.exec(fields.source)
  if (issue) {
    const result = d.spawnSync('gh', ['issue', 'view', issue[1], '--json', 'body', '--jq', '.body'], { cwd: checkout })
    if (result.status !== 0) throw new StartRefusal(`cannot read the body of issue ${issue[1]}: ${result.error?.message || String(result.stderr ?? '').trim() || `gh exited with status ${result.status}`}`)
    if (!/[\p{L}\p{N}]/u.test(String(result.stdout ?? ''))) throw new StartRefusal(`issue ${issue[1]} has an empty body: no letter or digit`)
    ask = String(result.stdout)
    const titleResult = d.spawnSync('gh', ['issue', 'view', issue[1], '--json', 'title', '--jq', '.title'], { cwd: checkout })
    if (titleResult.status !== 0) throw new StartRefusal(`cannot read the title of issue ${issue[1]}: ${titleResult.error?.message || String(titleResult.stderr ?? '').trim() || `gh exited with status ${titleResult.status}`}`)
    title = String(titleResult.stdout ?? '').replace(/\s+/g, ' ').trim()
    if (!title) throw new StartRefusal(`issue ${issue[1]} has an empty title`)
  }
  const run = runBrief(text, fields.closes, ask, title)
  if (git(d, checkout, ['worktree', 'add', '-b', lane, worktree, baseCommit]) === null) throw new StartRefusal(`git worktree add -b ${lane} ${worktree} ${base} failed in ${checkout}`)

  let setup
  if (project.worktreeSetup !== undefined) {
    try {
      setup = await d.runSuite({ cwd: worktree, ...suiteSpec(project.worktreeSetup, WORKTREE_SETUP_TIMEOUT_MS) })
      if (!setup || !['green', 'red', 'unmeasured'].includes(setup.status) || (setup.status !== 'green' && (typeof setup.reason !== 'string' || !setup.reason))) throw new Error('malformed result')
    } catch { setup = { status: 'unmeasured', reason: 'runner-threw' } }
    const reason = setup.status === 'green' ? null : setup.reason
    const taskDir = join(crewDir, 'task')
    try {
      d.mkdirSync(taskDir, { recursive: true })
      d.appendFileSync(join(taskDir, 'journal.jsonl'), `${JSON.stringify({ event: 'worktree-setup', lane, stage: null, status: setup.status, reason, command: project.worktreeSetup, at: new Date(d.now()).toISOString() })}\n`)
    } catch (error) { logLine(`crew start: worktree setup journal not recorded: ${error.message}`) }
    logLine(`crew start: worktree setup ${setup.status}${reason === null ? '' : `: ${reason}`}`)
    let result
    try { result = d.spawnSync('git', ['-C', worktree, ...GIT_STATUS_ARGS]) } catch {}
    const prefix = `worktree setup ${setup.status}${setup.status === 'green' ? '' : `: ${setup.reason}`}`
    const left = `the worktree ${worktree} and branch ${lane} are left for inspection`
    if (result?.status !== 0 || typeof result.stdout !== 'string' || (result.stdout && !result.stdout.endsWith('\0'))) throw new StartRefusal(`${prefix}; git status could not be read; ${left}`)
    const fields = result.stdout.split('\0'), paths = []
    for (let i = 0; i < fields.length && fields[i]; i++) {
      const entry = fields[i]
      if (entry.length < 4 || entry[2] !== ' ' || ((entry[0] === 'R' || entry[0] === 'C') && !fields[i + 1])) throw new StartRefusal(`${prefix}; git status could not be read; ${left}`)
      paths.push(entry.slice(3))
      if (entry[0] === 'R' || entry[0] === 'C') i++
    }
    if (paths.length) throw new StartRefusal(`${prefix}; changed or untracked paths:\n- ${paths.join('\n- ')}; ${left}`)
  }

  // The run reads a snapshot, so editing the draft cannot change a running lane.
  const started = join(d.crewRoot, 'briefs', 'started')
  const brief = join(started, `${lane}.md`)
  try {
    d.mkdirSync(started, { recursive: true })
    d.writeFileSync(brief, run)
  } catch (cause) {
    throw new StartRefusal(`cannot snapshot lane ${lane} into ${started}: ${cause.code ?? cause.message}; the worktree ${worktree} and branch ${lane} are left for inspection`, { cause })
  }

  const log = join(started, `${lane}.run.log`)

  // The lean loop has no boot: the crew directory holds the member metadata `crew show` reads
  // and the spec the detached bridge runs, and the bridge plays each turn itself.
  const taskDir = join(crewDir, 'task')
  const specPath = join(taskDir, 'lean.json')
  const members = Object.fromEntries(Object.entries(resolved.seats)
    .filter(([, cell]) => cell)
    .map(([role, cell]) => [role, { agent: cell.agent, model: `${cell.provider}/${cell.id}`, transport: 'lean-acp' }]))
  const spec = {
    id: lane, cwd: worktree, taskDir, tier, shape: fields.shape, brief: run,
    source: fields.source, branch: lane, base, closes: fields.closes === null ? [] : [fields.closes],
    suite: suiteSpec(project.suite, project.suiteTimeoutMs), proofTimeoutMs: project.proofTimeoutMs, onboarded: project.hash,
    ...(project.builderChecks === undefined ? {} : { builderChecks: project.builderChecks }),
    ...(fields.generated === undefined ? {} : { generated: { paths: fields.generated, ...suiteSpec(fields.regenerate) } }),
    roster,
  }
  try {
    d.mkdirSync(taskDir, { recursive: true })
    d.writeFileSync(join(crewDir, 'crew.json'), `${JSON.stringify({ members }, null, 2)}\n`)
    d.writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`)
  } catch (cause) {
    throw new StartRefusal(`cannot record lean lane ${lane} in ${crewDir}: ${cause.code ?? cause.message}; the worktree ${worktree} and branch ${lane} are left for inspection`, { cause })
  }
  let pid, startedAt
  try {
    pid = d.spawnDetached(process.execPath, [LEAN, specPath], { cwd: worktree, log, env: process.env })
    startedAt = d.now()
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('no valid pid')
  } catch (cause) {
    throw new StartRefusal(`cannot launch lane ${lane}; the worktree ${worktree} and branch ${lane} are left for inspection`, { cause })
  }
  if (!writeRunPid(taskDir, pid, d, startedAt)) logLine('crew start: run pid not recorded; finish, record-pr and closeout cannot prove this run dead')
  logLine(`crew start: lane=${lane} loop=lean tier=${tier} shape=${fields.shape} closes=${fields.closes ?? 'none'} pid=${pid}`)
  logLine(`  worktree ${worktree}`)
  logLine(`  brief    ${brief}`)
  logLine(`  log      ${log}`)
  logLine(`  spec     ${specPath}`)
  logLine(`  sessions node ${join(HOME, 'bin', 'crew.mjs')} show ${lane} [<role>]`)
  return { lane, fields, worktree, brief, log, pid, specPath }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const FLAGS = { '--checkout': { value: true } }
  const flags = {}, rest = []
  let bad = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('-')) { rest.push(arg); continue }
    if (!Object.hasOwn(FLAGS, arg) || Object.hasOwn(flags, arg)) { bad = true; break }
    if (FLAGS[arg].value) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) { bad = true; break }
      flags[arg] = argv[++i]
    } else flags[arg] = true
  }
  if (bad || rest.length !== 1) {
    process.stderr.write('usage: crew start <brief.md> [--checkout <dir>]\n')
    return 2
  }
  // Resolve the checkout only after the brief passes.
  const checkout = flags['--checkout'] ? resolve(flags['--checkout']) : null
  try {
    await startLane({ briefPath: resolve(rest[0]), checkout, deps })
    return 0
  } catch (error) {
    if (!(error instanceof StartRefusal)) throw error
    process.stderr.write(`crew start: ${error.message}\n`)
    return error.exitCode ?? 1
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main()
}
