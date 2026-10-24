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
import { parseBrief, TIERS } from './protocols.mjs'
import { resolveAgents } from './agents.mjs'
import { bootRefusals } from './roster-validate.mjs'
import { normalizeRoster, serializeRosterV1, serializeRosterV2 } from './roster.mjs'
import { acceptanceIds, boundIssueOf } from './drive.mjs'

const HOME = dirname(dirname(fileURLToPath(import.meta.url)))
const CREW = join(HOME, 'crew', 'crew.mjs')
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
  spawnDetached: (file, args, { cwd, log }) => {
    const out = openSync(log, 'a')
    try {
      const child = spawn(file, args, { cwd, detached: true, stdio: ['ignore', out, out] })
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

export async function startLane({ briefPath, checkout, check = false, deps = {} }) {
  const d = { ...defaultDeps(), ...deps }
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

  // The deployed roster.json, read the way boot reads it, supplies the schema version,
  // updated_at, models, policy and which roles each tier lists; every seat and the advisor
  // come from the agent definitions. The file keeps the template's schema version, and
  // the check runs on those bytes normalized exactly as boot will normalize them.
  let rosterText, roster
  try {
    const template = normalizeRoster(JSON.parse(d.readFileSync(join(HOME, 'crew', 'roster.json'), 'utf8')))
    const tiers = Object.fromEntries(TIERS.map((tier) => {
      const { seats, advisor } = d.resolveAgents(tier)
      const cells = Object.fromEntries(Object.keys(template.tiers[tier]).filter((role) => role !== 'advisor').map((role) => [role, seats[role] ?? null]))
      return [tier, { ...cells, ...seats, advisor }]
    }))
    const serialize = template.schema_version === 2 ? serializeRosterV2 : serializeRosterV1
    rosterText = serialize({ updated_at: template.updated_at, models: template.models, policy: template.policy, tiers }) + '\n'
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

  const boot = d.spawnSync(process.execPath, [CREW, 'boot', '--task', lane, '--checkout', worktree, '--tier', fields.tier, '--roster', rosterPath, '--headless-all'], { cwd: worktree })
  if (boot.status !== 0) throw new StartRefusal(`crew boot refused lane ${lane} (exit ${boot.status}):\n${String(boot.stderr || boot.stdout).trim()}\nthe worktree ${worktree} and branch ${lane} are left for inspection`)

  const log = join(started, `${lane}.run.log`)
  const args = [CREW, 'run', '--task', lane, '--checkout', worktree, '--brief-file', brief, '--keep', ...(fields.shape === 'stepped' ? ['--execution', 'stepped'] : [])]
  const pid = d.spawnDetached(process.execPath, args, { cwd: worktree, log })
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
  const rest = argv.filter((arg, index) => arg !== '--check' && (at < 0 || (index !== at && index !== at + 1)))
  if (rest.length !== 1 || rest[0].startsWith('--') || (at >= 0 && !argv[at + 1])) {
    process.stderr.write('usage: crew start <brief.md> [--check] [--checkout <dir>]\n')
    return 2
  }
  // --check needs no checkout, and a real start finds one only after the roster passes.
  const checkout = at >= 0 ? resolve(argv[at + 1]) : null
  try {
    await startLane({ briefPath: resolve(rest[0]), checkout, check, deps })
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
