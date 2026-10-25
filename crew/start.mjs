// crew start <brief.md> [--check] [--checkout <dir>]
//
// The lean entry (ADR-052 phase 1): one P1 brief in, one running lane out. It checks the
// brief, creates the lane worktree, boots the crew headless and starts the run detached,
// handing the brief to the planner as its whole input. No compile, no baseline, no gate.
// The lane name is the brief's file name. The crew boots the roster generated from the P5
// agent definitions, refused before any git call if it cannot boot. --check validates the
// brief and that generated roster, needs no checkout, and stops.
//
// Until phase 3 the lane runs on today's driver, so the brief the run reads carries the
// driver's fixed header (`# Task`, then the bound-issue slot when `closes` is set) and is
// checked with the driver's own parsers: the driver refuses to publish an issue-bound lane
// whose plan declares no issue, and promotes the bound issue to a Closes trailer.
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseBrief } from './protocols.mjs'
import { resolveAgents } from './agents.mjs'
import { bootRefusals } from './roster-validate.mjs'
import { normalizeRoster } from './roster.mjs'
import { generateRoster } from './roster-generate.mjs'
import { SLOT_ENV } from './reclaim.mjs'
import { acceptanceIds, boundIssueOf } from './drive.mjs'

const HOME = dirname(dirname(fileURLToPath(import.meta.url)))
const CREW = join(HOME, 'crew', 'crew.mjs')
const LEAN = join(HOME, 'crew', 'lean.mjs')
const LANE = /^[a-z0-9][a-z0-9-]{0,62}$/

export class StartRefusal extends Error {}

export function laneName(briefPath) {
  const lane = basename(briefPath).replace(/\.md$/, '')
  if (!LANE.test(lane)) throw new StartRefusal(`the brief file name ${JSON.stringify(basename(briefPath))} is not a lane name: lowercase letters, digits and -, then .md`)
  return lane
}

export function runBrief(text, closes) {
  return `# Task\n${closes ? `<!-- crew:bound-issue #${closes} -->\n` : ''}\n${text}`
}

const defaultDeps = () => ({
  readFileSync, existsSync, mkdirSync, writeFileSync, openSync, closeSync, resolveAgents, bootRefusals,
  driverReads: (text) => ({ acceptance: acceptanceIds(text), bound: boundIssueOf(text) }),
  spawnSync: (file, args, options) => spawnSync(file, args, { encoding: 'utf8', ...options }),
  spawnDetached: (file, args, { cwd, log, env }) => {
    const out = openSync(log, 'a')
    try {
      const child = spawn(file, args, { cwd, env, detached: true, stdio: ['ignore', out, out] })
      child.unref()
      return child.pid
    } finally { closeSync(out) }
  },
  crewRoot: join(homedir(), '.crew'),
  log: (line) => process.stdout.write(`${line}\n`),
})

function git(d, checkout, args) {
  const result = d.spawnSync('git', ['-C', checkout, ...args])
  return result.status === 0 ? String(result.stdout).trim() : null
}

export async function startLane({ briefPath, checkout, check = false, loop, deps = {} }) {
  const d = { ...defaultDeps(), ...deps }
  if (loop !== undefined && loop !== 'lean') throw Object.assign(new StartRefusal(`--loop takes lean, got ${JSON.stringify(loop)}`), { exitCode: 2 })
  const lane = laneName(briefPath)
  const text = d.readFileSync(briefPath, 'utf8')
  const { fields, defects } = parseBrief(text)
  if (defects.length) throw new StartRefusal(`brief ${briefPath} is not a P1 brief:\n- ${defects.join('\n- ')}`)
  const run = runBrief(text, fields.closes)
  const driver = d.driverReads(run)
  const bound = fields.closes === null ? null : String(fields.closes)
  if (JSON.stringify(driver.acceptance) !== JSON.stringify(fields.acceptance) || driver.bound !== bound) {
    throw new StartRefusal(`the driver reads brief ${briefPath} differently: acceptance ${JSON.stringify(driver.acceptance)} and bound issue ${driver.bound ?? 'none'}, against ${JSON.stringify(fields.acceptance)} and ${bound ?? 'none'}`)
  }
  if (fields.shape === 'finish') throw new StartRefusal('shape finish starts from an escalated lane, not a new brief; crew start runs standard and stepped')
  if (loop === 'lean' && fields.shape !== 'standard') throw new StartRefusal(`--loop lean runs the standard shape only; brief ${briefPath} declares shape ${fields.shape}`)

  // The deployed roster.json supplies what the agent definitions do not carry; every seat
  // and the advisor come from the definitions (crew/roster-generate.mjs). The check runs on
  // those bytes normalized exactly as boot will normalize them.
  let rosterText, roster
  try {
    rosterText = generateRoster(d.readFileSync(join(HOME, 'crew', 'roster.json'), 'utf8'), d.resolveAgents) + '\n'
    roster = normalizeRoster(JSON.parse(rosterText))
  } catch (cause) {
    throw new StartRefusal(`cannot generate the roster from the agent definitions: ${cause.message}`, { cause })
  }
  let refusals
  try { refusals = await d.bootRefusals(roster) } catch (cause) {
    throw new StartRefusal(`cannot check the generated roster: ${cause.message}`, { cause })
  }
  const refusalText = refusals.map((refusal) => JSON.stringify(refusal)).join('\n')
  if (refusals.length) throw new StartRefusal('generated roster is refused:\n' + refusalText)
  if (check) { d.log(`crew start: brief ok lane=${lane} tier=${fields.tier} shape=${fields.shape} closes=${fields.closes ?? 'none'}`); return { lane, fields, checked: true } }

  checkout ??= git(d, process.cwd(), ['rev-parse', '--show-toplevel'])
  if (!checkout) throw Object.assign(new StartRefusal('not inside a git checkout; pass --checkout <dir>'), { exitCode: 2 })
  const worktree = join(dirname(checkout), `dt-${lane}`)
  if (d.existsSync(worktree)) throw new StartRefusal(`worktree ${worktree} already exists; pick another lane name or close that lane out`)
  const base = (git(d, checkout, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']) || 'origin/main').replace(/^origin\//, '')
  if (git(d, checkout, ['worktree', 'add', '-b', lane, worktree, base]) === null) throw new StartRefusal(`git worktree add -b ${lane} ${worktree} ${base} failed in ${checkout}`)

  // The run reads a snapshot, so editing the draft cannot change a running lane; the
  // boot reads the validated roster beside it, not a re-resolution.
  const started = join(d.crewRoot, 'briefs', 'started')
  const brief = join(started, `${lane}.md`)
  const rosterPath = join(started, `${lane}.roster.json`)
  try {
    d.mkdirSync(started, { recursive: true })
    d.writeFileSync(brief, run)
    d.writeFileSync(rosterPath, rosterText)
  } catch (cause) {
    throw new StartRefusal(`cannot snapshot lane ${lane} into ${started}: ${cause.code ?? cause.message}; the worktree ${worktree} and branch ${lane} are left for inspection`, { cause })
  }

  const log = join(started, `${lane}.run.log`)
  // No suite slot queue (ADR-052 D9, operator 2026-10-25): the slots are shared with every
  // project on the host, and a lane that waited out the 30-minute ceiling ran unslotted anyway.
  const env = { ...process.env, [SLOT_ENV.capacity]: '0' }

  // The lean loop has no boot: the crew directory holds the member metadata `crew show` reads
  // and the spec the detached bridge runs, and the bridge plays each turn itself.
  if (loop === 'lean') {
    const crewDir = join(d.crewRoot, `dt-${lane}`, lane)
    const taskDir = join(crewDir, 'task')
    const specPath = join(taskDir, 'lean.json')
    const members = Object.fromEntries(Object.entries(roster.tiers[fields.tier])
      .filter(([role, cell]) => role !== 'advisor' && cell)
      .map(([role, cell]) => [role, { agent: cell.agent, model: `${cell.provider}/${cell.id}`, transport: 'lean-acp' }]))
    const spec = {
      id: lane, cwd: worktree, taskDir, tier: fields.tier, shape: fields.shape, brief: run, acceptance: fields.acceptance,
      subject: `feat: ${lane}`, branch: lane, base, closes: fields.closes === null ? [] : [fields.closes],
      suite: { command: 'npm', args: ['test'], timeoutMs: 1800000 },
    }
    try {
      d.mkdirSync(taskDir, { recursive: true })
      d.writeFileSync(join(crewDir, 'crew.json'), `${JSON.stringify({ members }, null, 2)}\n`)
      d.writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`)
    } catch (cause) {
      throw new StartRefusal(`cannot record lean lane ${lane} in ${crewDir}: ${cause.code ?? cause.message}; the worktree ${worktree} and branch ${lane} are left for inspection`, { cause })
    }
    const pid = d.spawnDetached(process.execPath, [LEAN, specPath], { cwd: worktree, log, env })
    d.log(`crew start: lane=${lane} loop=lean tier=${fields.tier} shape=${fields.shape} closes=${fields.closes ?? 'none'} pid=${pid}`)
    d.log(`  worktree ${worktree}`)
    d.log(`  brief    ${brief}`)
    d.log(`  log      ${log}`)
    d.log(`  spec     ${specPath}`)
    d.log(`  sessions node ${join(HOME, 'bin', 'crew.mjs')} show ${lane} [<role>]`)
    return { lane, fields, worktree, brief, rosterPath, log, pid, specPath }
  }

  const boot = d.spawnSync(process.execPath, [CREW, 'boot', '--task', lane, '--checkout', worktree, '--tier', fields.tier, '--roster', rosterPath, '--headless-all'], { cwd: worktree })
  if (boot.status !== 0) throw new StartRefusal(`crew boot refused lane ${lane} (exit ${boot.status}):\n${String(boot.stderr || boot.stdout).trim()}\nthe worktree ${worktree} and branch ${lane} are left for inspection`)

  const args = [CREW, 'run', '--task', lane, '--checkout', worktree, '--brief-file', brief, '--keep', ...(fields.shape === 'stepped' ? ['--execution', 'stepped'] : [])]
  const pid = d.spawnDetached(process.execPath, args, { cwd: worktree, log, env })
  d.log(`crew start: lane=${lane} tier=${fields.tier} shape=${fields.shape} closes=${fields.closes ?? 'none'} pid=${pid}`)
  d.log(`  worktree ${worktree}`)
  d.log(`  brief    ${brief}`)
  d.log(`  log      ${log}`)
  d.log(`  status   node ${CREW} status --task ${lane} --checkout ${worktree}`)
  return { lane, fields, worktree, brief, rosterPath, log, pid }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const check = argv.includes('--check')
  const at = argv.indexOf('--checkout')
  const flagAt = argv.indexOf('--loop')
  const valued = new Set([...(at >= 0 ? [at, at + 1] : []), ...(flagAt >= 0 ? [flagAt, flagAt + 1] : [])])
  const rest = argv.filter((arg, index) => arg !== '--check' && !valued.has(index))
  const badLoop = flagAt >= 0 && (argv[flagAt + 1] !== 'lean' || argv.indexOf('--loop', flagAt + 1) >= 0)
  if (rest.length !== 1 || rest[0].startsWith('--') || (at >= 0 && !argv[at + 1]) || badLoop) {
    process.stderr.write('usage: crew start <brief.md> [--check] [--checkout <dir>] [--loop lean]\n')
    return 2
  }
  // --check needs no checkout, and a real start finds one only after the roster passes.
  const checkout = at >= 0 ? resolve(argv[at + 1]) : null
  try {
    await startLane({ briefPath: resolve(rest[0]), checkout, check, loop: flagAt >= 0 ? 'lean' : undefined, deps })
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
