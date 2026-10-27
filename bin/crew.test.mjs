import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crewHome, rebuildPlan } from './crew.mjs'

const BIN = fileURLToPath(new URL('./crew.mjs', import.meta.url))
const scratch = (name) => realpathSync(mkdtempSync(join(tmpdir(), `bin-crew-${name}-`)))

// A fake crew home whose entry points print what they were handed.
function fakeHome(root) {
  const echo = (code) => `process.stdout.write(JSON.stringify({ entry: process.argv[1], argv: process.argv.slice(2), cwd: process.cwd() })); process.exitCode = ${code}\n`
  mkdirSync(join(root, 'crew'), { recursive: true })
  mkdirSync(join(root, 'scripts', 'factory'), { recursive: true })
  writeFileSync(join(root, 'crew', 'crew.mjs'), echo(3))
  writeFileSync(join(root, 'crew', 'factoryctl.mjs'), echo(0))
  writeFileSync(join(root, 'crew', 'start.mjs'), echo(0))
  writeFileSync(join(root, 'crew', 'show.mjs'), echo(7))
  writeFileSync(join(root, 'crew', 'roster-generate.mjs'), echo(0))
  writeFileSync(join(root, 'crew', 'record-pr.mjs'), echo(0))
  writeFileSync(join(root, 'crew', 'closeout.mjs'), echo(0))
  writeFileSync(join(root, 'crew', 'finish.mjs'), echo(0))
  writeFileSync(join(root, 'crew', 'lanes.mjs'), echo(0))
  writeFileSync(join(root, 'scripts', 'factory', 'ledger.mjs'), echo(0))
  return root
}

function crew(args, { cwd, env = {} }) {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, ...env }, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

// origin (bare) -> home on branch stable, with node_modules and a built dist so
// a plain fast-forward obliges no npm step.
function gitHome(root) {
  const seed = join(root, 'seed')
  mkdirSync(seed)
  git(seed, 'init', '-q', '-b', 'main')
  writeFileSync(join(seed, 'README'), 'one\n')
  git(seed, 'add', '.')
  git(seed, 'commit', '-qm', 'one')
  const origin = join(root, 'origin.git')
  git(root, 'clone', '-q', '--bare', seed, origin)
  const home = join(root, 'home')
  git(root, 'clone', '-q', origin, home)
  git(home, 'checkout', '-qb', 'stable')
  mkdirSync(join(home, 'node_modules'))
  mkdirSync(join(home, 'visualizer', 'web', 'dist'), { recursive: true })
  writeFileSync(join(home, 'visualizer', 'web', 'dist', 'index.html'), '')
  return { seed, origin, home }
}

test('a crew.mjs verb passes through with its argv, the caller cwd and its exit code', () => {
  const root = scratch('pass')
  try {
    const home = fakeHome(join(root, 'home'))
    const project = join(root, 'project')
    mkdirSync(project)
    const out = crew(['boot', '--task', 'x', '--tier', 'build'], { cwd: project, env: { CREW_HOME: home } })
    assert.equal(out.status, 3)
    assert.deepEqual(JSON.parse(out.stdout), { entry: join(home, 'crew', 'crew.mjs'), argv: ['boot', '--task', 'x', '--tier', 'build'], cwd: project })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// MUTATION: drop start from ENTRY and `crew start` reaches crew.mjs as an unknown verb.
test('ctl, ledger, start, show, roster, record-pr, closeout, finish and lanes route to their own entry points with the verb stripped', () => {
  const root = scratch('route')
  try {
    const home = fakeHome(join(root, 'home'))
    for (const [verb, entry] of [['ctl', 'crew/factoryctl.mjs'], ['ledger', 'scripts/factory/ledger.mjs'], ['start', 'crew/start.mjs'], ['show', 'crew/show.mjs'], ['roster', 'crew/roster-generate.mjs'], ['record-pr', 'crew/record-pr.mjs'], ['closeout', 'crew/closeout.mjs'], ['finish', 'crew/finish.mjs'], ['lanes', 'crew/lanes.mjs']]) {
      const out = crew([verb, 'cells', '--since', '2026-10-01'], { cwd: root, env: { CREW_HOME: home } })
      assert.equal(out.status, verb === 'show' ? 7 : 0)
      assert.deepEqual(JSON.parse(out.stdout).entry, join(home, entry))
      assert.deepEqual(JSON.parse(out.stdout).argv, ['cells', '--since', '2026-10-01'])
      assert.equal(JSON.parse(out.stdout).cwd, root)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the home is the checkout the file lives in after symlinks resolve, unless CREW_HOME is set', () => {
  const root = scratch('home')
  try {
    mkdirSync(join(root, 'checkout', 'bin'), { recursive: true })
    writeFileSync(join(root, 'checkout', 'bin', 'crew.mjs'), '')
    symlinkSync(join(root, 'checkout', 'bin', 'crew.mjs'), join(root, 'crew'))
    assert.equal(crewHome({}, join(root, 'crew')), join(root, 'checkout'))
    assert.equal(crewHome({ CREW_HOME: join(root, 'elsewhere') }, join(root, 'crew')), join(root, 'elsewhere'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('rebuildPlan installs on a lockfile move or absent modules, and builds on any web change or absent dist', () => {
  const present = { hasModules: true, hasDist: true }
  assert.deepEqual(rebuildPlan(['crew/roster.json'], present), { install: false, build: false })
  assert.deepEqual(rebuildPlan(['package-lock.json'], present), { install: true, build: true })
  assert.deepEqual(rebuildPlan(['visualizer/web/src/App.svelte'], present), { install: false, build: true })
  assert.deepEqual(rebuildPlan(['visualizer/server/server.mjs'], present), { install: false, build: false })
  assert.deepEqual(rebuildPlan([], { hasModules: false, hasDist: true }), { install: true, build: true })
  assert.deepEqual(rebuildPlan([], { hasModules: true, hasDist: false }), { install: false, build: true })
})

test('update fast-forwards stable to origin/main and reports the range', () => {
  const root = scratch('ff')
  try {
    const { seed, origin, home } = gitHome(root)
    writeFileSync(join(seed, 'README'), 'two\n')
    git(seed, 'commit', '-qam', 'two')
    git(seed, 'push', '-q', origin, 'main')
    const out = crew(['update'], { cwd: root, env: { CREW_HOME: home } })
    assert.equal(out.status, 0, out.stderr)
    assert.equal(git(home, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'main'))
    assert.match(out.stdout, /^crew update: [0-9a-f]{8}\.\.[0-9a-f]{8}$/m)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('update refuses a home off stable and a home with local changes, and moves nothing', () => {
  const root = scratch('refuse')
  try {
    const { home } = gitHome(root)
    const head = git(home, 'rev-parse', 'HEAD')
    git(home, 'checkout', '-q', 'main')
    let out = crew(['update'], { cwd: root, env: { CREW_HOME: home } })
    assert.equal(out.status, 1)
    assert.match(out.stderr, /is on main, not stable/)
    git(home, 'checkout', '-q', 'stable')
    writeFileSync(join(home, 'README'), 'edited\n')
    out = crew(['update'], { cwd: root, env: { CREW_HOME: home } })
    assert.equal(out.status, 1)
    assert.match(out.stderr, /has local changes/)
    assert.equal(git(home, 'rev-parse', 'HEAD'), head)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('update refuses while a process runs from the home, and --force goes ahead', async () => {
  const root = scratch('busy')
  const { home } = gitHome(root)
  writeFileSync(join(home, 'idle.mjs'), 'setInterval(() => {}, 1000)\n')
  const child = spawn(process.execPath, [join(home, 'idle.mjs')], { stdio: 'ignore' })
  try {
    await new Promise((done) => child.once('spawn', done))
    let out = crew(['update'], { cwd: root, env: { CREW_HOME: home } })
    assert.equal(out.status, 1)
    assert.match(out.stderr, /process\(es\) run from/)
    assert.match(out.stderr, new RegExp(`^  ${child.pid} `, 'm'))
    out = crew(['update', '--force'], { cwd: root, env: { CREW_HOME: home } })
    assert.equal(out.status, 0, out.stderr)
    assert.match(out.stdout, /--force used/)
  } finally {
    process.kill(child.pid)
    rmSync(root, { recursive: true, force: true })
  }
})

test('viz injects the caller cwd as DEVTEAM_INTAKE_CHECKOUT unless preset', () => {
  const root = scratch('viz')
  try {
    const home = fakeHome(join(root, 'home'))
    mkdirSync(join(home, 'visualizer', 'server'), { recursive: true })
    writeFileSync(join(home, 'visualizer', 'server', 'server.mjs'), 'process.stdout.write(JSON.stringify({ env: process.env.DEVTEAM_INTAKE_CHECKOUT ?? null, cwd: process.cwd() }))\n')
    const caller = join(root, 'caller')
    mkdirSync(caller, { recursive: true })
    const clean = { ...process.env }
    delete clean.DEVTEAM_INTAKE_CHECKOUT
    const unset = crew(['viz'], { cwd: caller, env: { ...clean, CREW_HOME: home } })
    assert.equal(unset.status, 0, unset.stderr)
    assert.deepEqual(JSON.parse(unset.stdout), { env: caller, cwd: home })
    const preset = crew(['viz'], { cwd: caller, env: { ...clean, CREW_HOME: home, DEVTEAM_INTAKE_CHECKOUT: '/preset/checkout' } })
    assert.equal(preset.status, 0, preset.stderr)
    assert.equal(JSON.parse(preset.stdout).env, '/preset/checkout')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('where prints the home, branch, head and roster date', () => {
  const root = scratch('where')
  try {
    const { home } = gitHome(root)
    mkdirSync(join(home, 'crew'))
    writeFileSync(join(home, 'crew', 'roster.json'), JSON.stringify({ updated_at: '2026-10-16' }))
    const out = crew(['where'], { cwd: root, env: { CREW_HOME: home } })
    assert.equal(out.status, 0, out.stderr)
    assert.match(out.stdout, new RegExp(`^home    ${home}$`, 'm'))
    assert.match(out.stdout, /^branch  stable$/m)
    assert.match(out.stdout, /^roster  updated 2026-10-16$/m)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
