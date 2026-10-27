#!/usr/bin/env node
// crew — run the deployed crew from any folder.
//
//   crew <crew.mjs verb> [...]   run crew/crew.mjs; the current folder stays the checkout
//   crew start <brief.md>        run crew/start.mjs: start a lane from a P1 brief (ADR-052)
//   crew show <lane> [<role>] [--json]  read a lane's recorded sessions (crew/show.mjs)
//   crew record-pr <lane> --pr <url>  record the PR a stopped lean lane was hand-finished in (crew/record-pr.mjs)
//   crew finish <lane>           finish a stopped lean lane with its own builder seat; stops committed and rebased, unpublished (crew/finish.mjs)
//   crew closeout <lane>         remove a merged lean lane's worktree and branch, archive its lane directory (crew/closeout.mjs)
//   crew lanes [--all] [--json]  list lean lanes from their journals (crew/lanes.mjs)
//   crew roster generate [--check]  write crew/roster.json from crew/agents/*.md (crew/roster-generate.mjs)
//   crew ctl [...]               run crew/factoryctl.mjs
//   crew ledger [...]            run scripts/factory/ledger.mjs
//   crew viz                     serve the visualizer from the crew home
//   crew where                   print the crew home, its commit and its roster date
//   crew update [--force]        fast-forward the crew home to origin/main and rebuild what changed
//
// The crew home is the checkout this file lives in, after symlinks resolve
// (~/.local/bin/crew -> ~/Dev/dev-team-stable/bin/crew.mjs), or CREW_HOME when set.
// Running the home's own crew.mjs is what makes its roster.json the seating roster (#983).
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function crewHome(env = process.env, self = fileURLToPath(import.meta.url)) {
  return env.CREW_HOME ? resolve(env.CREW_HOME) : dirname(dirname(realpathSync(self)))
}

const ENTRY = { ctl: 'crew/factoryctl.mjs', ledger: 'scripts/factory/ledger.mjs', start: 'crew/start.mjs', show: 'crew/show.mjs', roster: 'crew/roster-generate.mjs', 'record-pr': 'crew/record-pr.mjs', closeout: 'crew/closeout.mjs', finish: 'crew/finish.mjs', lanes: 'crew/lanes.mjs' }

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (result.error) throw result.error
  return result.status ?? 1
}

function git(home, args) {
  const result = spawnSync('git', ['-C', home, ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${(result.stderr || '').trim()}`)
  return result.stdout.trim()
}

// Processes started from the home, other than this one and its parent shell:
// lanes, drivers, the daemon and the visualizer all carry the home path in argv.
export function homeProcesses(home, self = [process.pid, process.ppid]) {
  const result = spawnSync('pgrep', ['-fl', `${home}/`], { encoding: 'utf8' })
  return (result.stdout || '').split('\n').filter(Boolean)
    .filter((line) => !self.includes(Number(line.split(' ')[0])))
    .filter((line) => !line.includes(`${home}/bin/crew.mjs`))
}

export function changedPaths(home, from, to) {
  if (from === to) return []
  return git(home, ['diff', '--name-only', `${from}..${to}`]).split('\n').filter(Boolean)
}

// What a fast-forward from..to obliges: npm ci when the lockfile moved or node_modules
// is absent, viz:build when the visualizer or its dependencies moved or dist is absent.
export function rebuildPlan(changed, { hasModules, hasDist }) {
  const lock = changed.includes('package-lock.json') || changed.includes('package.json')
  const install = lock || !hasModules
  const build = install || !hasDist || changed.some((path) => path.startsWith('visualizer/web/'))
  return { install, build }
}

function where(home) {
  const head = git(home, ['log', '-1', '--format=%h %s'])
  const branch = git(home, ['rev-parse', '--abbrev-ref', 'HEAD'])
  let roster = 'unreadable'
  try { roster = JSON.parse(readFileSync(join(home, 'crew', 'roster.json'), 'utf8')).updated_at } catch {}
  process.stdout.write(`home    ${home}\nbranch  ${branch}\nhead    ${head}\nroster  updated ${roster}\n`)
  return 0
}

function update(home, args) {
  const force = args.includes('--force')
  const branch = git(home, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch !== 'stable') { process.stderr.write(`crew update: ${home} is on ${branch}, not stable — refusing\n`); return 1 }
  if (git(home, ['status', '--porcelain', '--untracked-files=no'])) { process.stderr.write(`crew update: ${home} has local changes — refusing\n`); return 1 }
  const busy = homeProcesses(home)
  if (busy.length && !force) {
    process.stderr.write(`crew update: ${busy.length} process(es) run from ${home}; updating would change code under them:\n${busy.map((l) => `  ${l}`).join('\n')}\nStop them, or pass --force.\n`)
    return 1
  }
  git(home, ['fetch', '--quiet', 'origin'])
  const from = git(home, ['rev-parse', 'HEAD'])
  git(home, ['merge', '--ff-only', '--quiet', 'origin/main'])
  const to = git(home, ['rev-parse', 'HEAD'])
  const plan = rebuildPlan(changedPaths(home, from, to), {
    hasModules: existsSync(join(home, 'node_modules')),
    hasDist: existsSync(join(home, 'visualizer', 'web', 'dist', 'index.html')),
  })
  process.stdout.write(from === to ? `crew update: already at ${to.slice(0, 8)}\n` : `crew update: ${from.slice(0, 8)}..${to.slice(0, 8)}\n`)
  if (plan.install && run('npm', ['ci', '--silent'], { cwd: home }) !== 0) return 1
  if (plan.build && run('npm', ['run', '-s', 'viz:build'], { cwd: home }) !== 0) return 1
  if (busy.length) process.stdout.write('crew update: --force used; restart the processes listed above to pick up the update\n')
  return 0
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const home = crewHome(env)
  const [verb, ...rest] = argv
  if (verb === 'where') return where(home)
  if (verb === 'update') return update(home, rest)
  if (verb === 'viz') { const vizEnv = env.DEVTEAM_INTAKE_CHECKOUT ? env : { ...env, DEVTEAM_INTAKE_CHECKOUT: process.cwd() }; return run(process.execPath, ['--env-file-if-exists=.env.local', 'visualizer/server/server.mjs', ...rest], { cwd: home, env: vizEnv }) }
  const entry = ENTRY[verb]
  if (entry) return run(process.execPath, [join(home, entry), ...rest])
  return run(process.execPath, [join(home, 'crew', 'crew.mjs'), ...argv])
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main()
}
