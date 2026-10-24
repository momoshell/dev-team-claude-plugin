// crew start <brief.md> [--check] [--checkout <dir>]
//
// The lean entry (ADR-052 phase 1): one P1 brief in, one running lane out. It checks the
// brief, creates the lane worktree, boots the crew headless and starts the run detached,
// handing the brief to the planner as its whole input. No compile, no baseline, no gate.
// The lane name is the brief's file name. --check validates the brief and stops.
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseBrief } from './protocols.mjs'

const HOME = dirname(dirname(fileURLToPath(import.meta.url)))
const CREW = join(HOME, 'crew', 'crew.mjs')
const LANE = /^[a-z0-9][a-z0-9-]{0,62}$/

export class StartRefusal extends Error {}

export function laneName(briefPath) {
  const lane = basename(briefPath).replace(/\.md$/, '')
  if (!LANE.test(lane)) throw new StartRefusal(`the brief file name ${JSON.stringify(basename(briefPath))} is not a lane name: lowercase letters, digits and -, then .md`)
  return lane
}

const defaultDeps = () => ({
  readFileSync, existsSync, mkdirSync, copyFileSync, openSync, closeSync,
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

export function startLane({ briefPath, checkout, check = false, deps = {} }) {
  const d = { ...defaultDeps(), ...deps }
  const lane = laneName(briefPath)
  const { fields, defects } = parseBrief(d.readFileSync(briefPath, 'utf8'))
  if (defects.length) throw new StartRefusal(`brief ${briefPath} is not a P1 brief:\n- ${defects.join('\n- ')}`)
  if (fields.shape === 'finish') throw new StartRefusal('shape finish starts from an escalated lane, not a new brief; crew start runs standard and stepped')
  if (check) { d.log(`crew start: brief ok lane=${lane} tier=${fields.tier} shape=${fields.shape} closes=${fields.closes ?? 'none'}`); return { lane, fields, checked: true } }

  const worktree = join(dirname(checkout), `dt-${lane}`)
  if (d.existsSync(worktree)) throw new StartRefusal(`worktree ${worktree} already exists; pick another lane name or close that lane out`)
  const base = (git(d, checkout, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']) || 'origin/main').replace(/^origin\//, '')
  if (git(d, checkout, ['worktree', 'add', '-b', lane, worktree, base]) === null) throw new StartRefusal(`git worktree add -b ${lane} ${worktree} ${base} failed in ${checkout}`)

  // The run reads a snapshot, so editing the draft cannot change a running lane.
  const started = join(d.crewRoot, 'briefs', 'started')
  d.mkdirSync(started, { recursive: true })
  const brief = join(started, `${lane}.md`)
  d.copyFileSync(briefPath, brief)

  const boot = d.spawnSync(process.execPath, [CREW, 'boot', '--task', lane, '--checkout', worktree, '--tier', fields.tier, '--roster', join(HOME, 'crew', 'roster.json'), '--headless-all'], { cwd: worktree })
  if (boot.status !== 0) throw new StartRefusal(`crew boot refused lane ${lane} (exit ${boot.status}):\n${String(boot.stderr || boot.stdout).trim()}\nthe worktree ${worktree} and branch ${lane} are left for inspection`)

  const log = join(started, `${lane}.run.log`)
  const run = [CREW, 'run', '--task', lane, '--checkout', worktree, '--brief-file', brief, '--keep', ...(fields.shape === 'stepped' ? ['--execution', 'stepped'] : [])]
  const pid = d.spawnDetached(process.execPath, run, { cwd: worktree, log })
  d.log(`crew start: lane=${lane} tier=${fields.tier} shape=${fields.shape} closes=${fields.closes ?? 'none'} pid=${pid}`)
  d.log(`  worktree ${worktree}`)
  d.log(`  brief    ${brief}`)
  d.log(`  log      ${log}`)
  d.log(`  status   node ${CREW} status --task ${lane} --checkout ${worktree}`)
  return { lane, fields, worktree, brief, log, pid }
}

export function main(argv = process.argv.slice(2), deps = {}) {
  const check = argv.includes('--check')
  const at = argv.indexOf('--checkout')
  const rest = argv.filter((arg, index) => arg !== '--check' && (at < 0 || (index !== at && index !== at + 1)))
  if (rest.length !== 1 || rest[0].startsWith('--') || (at >= 0 && !argv[at + 1])) {
    process.stderr.write('usage: crew start <brief.md> [--check] [--checkout <dir>]\n')
    return 2
  }
  const d = { ...defaultDeps(), ...deps }
  // --check reads only the brief, so it needs no checkout.
  const checkout = at >= 0 ? resolve(argv[at + 1]) : check ? null : git(d, process.cwd(), ['rev-parse', '--show-toplevel'])
  if (!checkout && !check) { process.stderr.write('crew start: not inside a git checkout; pass --checkout <dir>\n'); return 2 }
  try {
    startLane({ briefPath: resolve(rest[0]), checkout, check, deps })
    return 0
  } catch (error) {
    if (!(error instanceof StartRefusal)) throw error
    process.stderr.write(`crew start: ${error.message}\n`)
    return 1
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main()
}
