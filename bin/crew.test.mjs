import { test } from 'node:test'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
  writeFileSync(join(root, 'crew', 'start.mjs'), echo(0))
  writeFileSync(join(root, 'crew', 'show.mjs'), echo(7))
  writeFileSync(join(root, 'crew', 'record-pr.mjs'), echo(0))
  writeFileSync(join(root, 'crew', 'closeout.mjs'), echo(0))
  writeFileSync(join(root, 'crew', 'finish.mjs'), echo(0))
  writeFileSync(join(root, 'crew', 'lanes.mjs'), echo(0))
  writeFileSync(join(root, 'scripts', 'factory', 'ledger.mjs'), echo(0))
  return root
}

function fakeBin(root, name, script) {
  const dir = join(root, 'fakebin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
  return dir
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

test('onboard --check writes .crew/project.json only when the pass probe reads green and the fail probe red by failure', () => {
  const root = scratch('onboard')
  try {
    const repo = join(root, 'repo')
    mkdirSync(repo)
    git(repo, 'init', '-q')
    writeFileSync(join(repo, 'README'), 'base\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'base')
    const draft = join(root, 'draft.json')
    const entry = { match: 'probe/**', run: 'node --test --test-reporter=junit --test-reporter-destination={report} {file}', calibrate: { file: 'probe/calibrate.mjs', text: "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('passes', () => {})\ntest('fails', () => assert.fail())\n", pass: 'passes', fail: 'fails' } }
    writeFileSync(draft, JSON.stringify({ suite: 'npm test', proof: [entry] }))
    const gitPath = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim()
    const dir = fakeBin(root, 'git', `exec "${gitPath}" "$@"`)
    fakeBin(root, 'node', `exec "${process.execPath}" "$@"`)
    const env = { CREW_HOME: '', HOME: root, PATH: dir }
    const out = crew(['onboard', '--check', draft, '--checkout', repo], { cwd: root, env })
    assert.equal(out.status, 0, out.stderr + out.stdout)
    const project = JSON.parse(readFileSync(join(repo, '.crew/project.json'), 'utf8'))
    assert.deepEqual(project.proof, [{ match: entry.match, run: entry.run }])
    assert.equal(project.onboarded.hash, createHash('sha256').update(JSON.stringify(['npm test', [[entry.match, null, entry.run]]])).digest('hex'))
    assert.equal(git(repo, 'status', '--porcelain'), '?? .crew/')
    rmSync(join(repo, '.crew'), { recursive: true })
    entry.calibrate.text = entry.calibrate.text.replace('assert.fail()', '{}')
    writeFileSync(draft, JSON.stringify({ suite: 'npm test', proof: [entry] }))
    const failed = crew(['onboard', '--check', draft, '--checkout', repo], { cwd: root, env })
    assert.equal(failed.status, 1, failed.stderr + failed.stdout)
    assert.equal(existsSync(join(repo, '.crew/project.json')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('an unknown or missing verb is refused with exit 2 and runs nothing', () => {
  const root = scratch('unknown')
  try {
    const home = fakeHome(join(root, 'home'))
    for (const args of [['boot', '--task', 'x'], []]) {
      const out = crew(args, { cwd: root, env: { CREW_HOME: home } })
      assert.equal(out.status, 2)
      assert.equal(out.stdout, '')
      assert.match(out.stderr, /^crew: unknown verb ".*"; expected onboard, start, show, record-pr, closeout, finish, lanes, viz, where or update$/m)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// MUTATION: replace Object.hasOwn(ENTRY, verb) with verb in ENTRY.
test('a verb naming an Object.prototype member is refused as unknown with exit 2 and runs nothing', () => {
  const root = scratch('prototype')
  try {
    const home = fakeHome(join(root, 'home'))
    for (const verb of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const out = crew([verb], { cwd: root, env: { CREW_HOME: home } })
      assert.equal(out.status, 2)
      assert.equal(out.stdout, '')
      assert.match(out.stderr, new RegExp(`^crew: unknown verb "${verb}"; expected onboard, start, show, record-pr, closeout, finish, lanes, viz, where or update$`, 'm'))
      assert.doesNotMatch(out.stderr, /\n\s+at /)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// MUTATION: drop the result.error check in git().
test('a git step whose output overflows maxBuffer is reported as exceeded output, not a git failure', () => {
  const root = scratch('git-overflow')
  try {
    const dir = fakeBin(root, 'git', 'head -c 20000000 /dev/zero')
    const out = crew(['where'], { cwd: root, env: { CREW_HOME: root, PATH: `${dir}:${process.env.PATH}` } })
    assert.equal(out.status, 1)
    assert.match(out.stderr, /^crew where: git log -1 --format=%h %s: output exceeded \d+ bytes\n$/)
    assert.equal(out.stderr.trim().split('\n').length, 1)
    assert.doesNotMatch(out.stderr, /\n\s+at /)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// MUTATION: drop the result.error check in homeProcesses().
test('update refuses when pgrep cannot run, rather than reading it as no processes', () => {
  const root = scratch('pgrep-overflow')
  try {
    const { seed, origin, home } = gitHome(root)
    const head = git(home, 'rev-parse', 'HEAD')
    writeFileSync(join(seed, 'README'), 'two\n')
    git(seed, 'commit', '-qam', 'two')
    git(seed, 'push', '-q', origin, 'main')
    const dir = fakeBin(root, 'pgrep', 'head -c 20000000 /dev/zero')
    const out = crew(['update', '--force'], { cwd: root, env: { CREW_HOME: home, PATH: `${dir}:${process.env.PATH}` } })
    assert.equal(out.status, 1)
    assert.match(out.stderr, /^crew update: pgrep -fl .*: output exceeded \d+ bytes\n$/)
    assert.equal(out.stderr.trim().split('\n').length, 1)
    assert.equal(git(home, 'rev-parse', 'HEAD'), head)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// MUTATION: drop start from ENTRY and `crew start` is refused as an unknown verb.
test('start, show, record-pr, closeout, finish and lanes route to their own entry points with the verb stripped', () => {
  const root = scratch('route')
  try {
    const home = fakeHome(join(root, 'home'))
    for (const [verb, entry] of [['start', 'crew/start.mjs'], ['show', 'crew/show.mjs'], ['record-pr', 'crew/record-pr.mjs'], ['closeout', 'crew/closeout.mjs'], ['finish', 'crew/finish.mjs'], ['lanes', 'crew/lanes.mjs']]) {
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
  assert.deepEqual(rebuildPlan(['crew/start.mjs'], present), { install: false, build: false })
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

test('viz injects the caller cwd as DEVTEAM_VIZ_CHECKOUT unless preset', () => {
  const root = scratch('viz')
  try {
    const home = fakeHome(join(root, 'home'))
    mkdirSync(join(home, 'visualizer', 'server'), { recursive: true })
    writeFileSync(join(home, 'visualizer', 'server', 'server.mjs'), 'process.stdout.write(JSON.stringify({ env: process.env.DEVTEAM_VIZ_CHECKOUT ?? null, cwd: process.cwd() }))\n')
    const caller = join(root, 'caller')
    mkdirSync(caller, { recursive: true })
    const clean = { ...process.env }
    delete clean.DEVTEAM_VIZ_CHECKOUT
    const unset = crew(['viz'], { cwd: caller, env: { ...clean, CREW_HOME: home } })
    assert.equal(unset.status, 0, unset.stderr)
    assert.deepEqual(JSON.parse(unset.stdout), { env: caller, cwd: home })
    const preset = crew(['viz'], { cwd: caller, env: { ...clean, CREW_HOME: home, DEVTEAM_VIZ_CHECKOUT: '/preset/checkout' } })
    assert.equal(preset.status, 0, preset.stderr)
    assert.equal(JSON.parse(preset.stdout).env, '/preset/checkout')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('where and update refuse arguments they do not read with exit 2 and run nothing', () => {
  const root = scratch('argv')
  try {
    const { home } = gitHome(root)
    const head = git(home, 'rev-parse', 'HEAD')
    for (const args of [['where', 'extra'], ['update', '--bogus'], ['update', '--force', '--force']]) {
      const out = crew(args, { cwd: root, env: { CREW_HOME: home } })
      assert.equal(out.status, 2)
      assert.match(out.stderr, /^usage: crew /)
      assert.equal(out.stdout, '')
      assert.equal(git(home, 'rev-parse', 'HEAD'), head)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a failed git step in update prints one crew update line and no stack', () => {
  const root = scratch('git-failure')
  try {
    const { home } = gitHome(root)
    git(home, 'remote', 'set-url', 'origin', join(root, 'missing.git'))
    const out = crew(['update', '--force'], { cwd: root, env: { CREW_HOME: home } })
    assert.equal(out.status, 1)
    assert.ok(/^crew update: git fetch/.test(out.stderr))
    assert.doesNotMatch(out.stderr, /\n\s+at /)
    assert.equal(out.stderr.trim().split('\n').length, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('where prints the home, branch and head', () => {
  const root = scratch('where')
  try {
    const { home } = gitHome(root)
    const out = crew(['where'], { cwd: root, env: { CREW_HOME: home } })
    assert.equal(out.status, 0, out.stderr)
    assert.match(out.stdout, new RegExp(`^home    ${home}$`, 'm'))
    assert.match(out.stdout, /^branch  stable$/m)
    assert.doesNotMatch(out.stdout, /roster/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
