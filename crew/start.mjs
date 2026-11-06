// crew start <brief.md> [--check] [--checkout <dir>]
//
// The lean entry (ADR-052 phase 1): one P1 brief in, one running lane out. It checks the
// brief, creates the lane worktree and starts the run detached, handing the brief to the
// planner as its whole input. No compile, no baseline, no gate. The lane name is the
// brief's file name. --check validates the brief and the checkout's onboarding.
//
// The start stands on the brief parser and the agent definitions alone. It refuses before any
// git call when the brief is not P1 or the definitions do not resolve.
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LANE } from './lane-core.mjs'
import { ISSUE_SOURCE, parseBrief } from './protocols.mjs'
import { resolveAgents } from './agents.mjs'
import { writeRunPid } from './run-pid.mjs'
import { askProvenance, readOperatorMessages } from './brief-provenance.mjs'
import { OnboardRefusal, requireOnboarded, SUITE_TIMEOUT_DEFAULT_MS } from './onboard.mjs'

const HOME = dirname(dirname(fileURLToPath(import.meta.url)))
const LEAN = join(HOME, 'crew', 'lean.mjs')

export class StartRefusal extends Error {}

export function laneName(briefPath) {
  const lane = basename(briefPath).replace(/\.md$/, '')
  if (!LANE.test(lane)) throw new StartRefusal(`the brief file name ${JSON.stringify(basename(briefPath))} is not a lane name: lowercase letters, digits and -, then .md`)
  return lane
}

export function runBrief(text, closes, ask = null) {
  if (ask !== null) {
    const quote = ask.trimEnd().split(/\r?\n/).map((line) => line.trim() ? `> ${line}` : '>').join('\n')
    text = text.replace(/^([^\S\r\n]*---[^\S\r\n]*\r?\n[\s\S]*?\r?\n[^\S\r\n]*---[^\S\r\n]*\r?\n)/, (front) => `${front}## The ask\n\n${quote}\n\n`)
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
  readFileSync, existsSync, mkdirSync, writeFileSync, rmSync, openSync, closeSync, resolveAgents,
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

export async function startLane({ briefPath, checkout, check = false, deps = {} }) {
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
  if (check) { logLine(`crew start: brief ok lane=${lane} tier=${tier} shape=${fields.shape} closes=${fields.closes ?? 'none'}`); return { lane, fields, checked: true } }
  const worktree = join(dirname(checkout), `dt-${lane}`)
  const crewDir = join(d.crewRoot, `dt-${lane}`, lane)
  if (d.existsSync(crewDir)) throw new StartRefusal(`crew lane directory ${crewDir} already exists; pick another lane name or close that lane out`)
  if (d.existsSync(worktree)) throw new StartRefusal(`worktree ${worktree} already exists; pick another lane name or close that lane out`)
  const remoteHead = git(d, checkout, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (!remoteHead) throw new StartRefusal('cannot read origin/HEAD; repair it with git remote set-head origin --auto')
  const base = remoteHead.replace(/^origin\//, '')
  const missing = paths.filter((path) => {
    const name = posix.normalize(path).replace(/\/+$/, '') || '.'
    if (git(d, checkout, ['cat-file', '-e', `${base}:${name}`]) === null) return true
    const parts = name === '.' ? [] : name.split('/')
    return parts.some((_, i) => {
      const prefix = parts.slice(0, i + 1).join('/')
      const entry = git(d, checkout, ['--literal-pathspecs', 'ls-tree', '-z', base, '--', prefix])
      return !entry || !/^(?:040000 tree|100(?:644|755) blob) [0-9a-f]+\t/.test(entry) || entry.slice(entry.indexOf('\t') + 1).replace(/\0$/, '') !== prefix
    })
  })
  if (missing.length) throw new StartRefusal(`brief ${briefPath} could not verify ## Context paths on ${base} (ADR-056 Amendment 1); they may be missing, symlinks, submodules, or the git check may have failed:\n- ${missing.join('\n- ')}`)
  const baseCommit = git(d, checkout, ['rev-parse', '--verify', `${base}^{commit}`])
  if (!baseCommit) throw new StartRefusal(`cannot resolve lane base ${base}`)
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
    if (error instanceof OnboardRefusal) throw new StartRefusal(`lane base ${base}: ${error.message}; commit the approved .crew/project.json to ${base} before starting`, { cause: error })
    throw error
  }
  let ask = null
  const issue = ISSUE_SOURCE.exec(fields.source)
  if (issue) {
    const result = d.spawnSync('gh', ['issue', 'view', issue[1], '--json', 'body', '--jq', '.body'], { cwd: checkout })
    if (result.status !== 0) throw new StartRefusal(`cannot read the body of issue ${issue[1]}: ${result.error?.message || String(result.stderr ?? '').trim() || `gh exited with status ${result.status}`}`)
    if (!/[\p{L}\p{N}]/u.test(String(result.stdout ?? ''))) throw new StartRefusal(`issue ${issue[1]} has an empty body: no letter or digit`)
    ask = String(result.stdout)
  }
  const run = runBrief(text, fields.closes, ask)
  if (git(d, checkout, ['worktree', 'add', '-b', lane, worktree, baseCommit]) === null) throw new StartRefusal(`git worktree add -b ${lane} ${worktree} ${base} failed in ${checkout}`)

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
    suite: suiteSpec(project.suite, project.suiteTimeoutMs), onboarded: project.hash,
    ...(fields.generated === undefined ? {} : { generated: { paths: fields.generated, ...suiteSpec(fields.regenerate) } }),
  }
  try {
    d.mkdirSync(taskDir, { recursive: true })
    d.writeFileSync(join(crewDir, 'crew.json'), `${JSON.stringify({ members }, null, 2)}\n`)
    d.writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`)
  } catch (cause) {
    throw new StartRefusal(`cannot record lean lane ${lane} in ${crewDir}: ${cause.code ?? cause.message}; the worktree ${worktree} and branch ${lane} are left for inspection`, { cause })
  }
  let pid
  try {
    pid = d.spawnDetached(process.execPath, [LEAN, specPath], { cwd: worktree, log, env: process.env })
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('no valid pid')
  } catch (cause) {
    throw new StartRefusal(`cannot launch lane ${lane}; the worktree ${worktree} and branch ${lane} are left for inspection`, { cause })
  }
  if (!writeRunPid(taskDir, pid, d)) logLine('crew start: run pid not recorded; finish, record-pr and closeout cannot prove this run dead')
  logLine(`crew start: lane=${lane} loop=lean tier=${tier} shape=${fields.shape} closes=${fields.closes ?? 'none'} pid=${pid}`)
  logLine(`  worktree ${worktree}`)
  logLine(`  brief    ${brief}`)
  logLine(`  log      ${log}`)
  logLine(`  spec     ${specPath}`)
  logLine(`  sessions node ${join(HOME, 'bin', 'crew.mjs')} show ${lane} [<role>]`)
  return { lane, fields, worktree, brief, log, pid, specPath }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const FLAGS = { '--check': { value: false }, '--checkout': { value: true } }
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
    process.stderr.write('usage: crew start <brief.md> [--check] [--checkout <dir>]\n')
    return 2
  }
  // Resolve the checkout only after the brief passes.
  const checkout = flags['--checkout'] ? resolve(flags['--checkout']) : null
  try {
    await startLane({ briefPath: resolve(rest[0]), checkout, check: flags['--check'] ?? false, deps })
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
