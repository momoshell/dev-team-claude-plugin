import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ONBOARD_REASONS, OnboardRefusal, checkOnboarding, main, projectHash, requireOnboarded } from './onboard.mjs'
import { git, scratchDir } from '../test/helpers.mjs'

test('projectHash changes when a proof entry gains a list command', () => {
  const entry = { match: '*.xml', run: 'node run.mjs' }
  const project = { suite: 'npm test', proof: [entry] }
  assert.notEqual(projectHash(project), projectHash({ ...project, proof: [{ ...entry, list: 'node list.mjs' }] }))
})

test('projectHash changes when a proof entry gains a manifest', () => {
  const entry = { match: '*.xml', run: 'node run.mjs' }
  const project = { suite: 'npm test', proof: [entry] }
  const withManifest = { ...project, proof: [{ ...entry, manifest: 'Cargo.toml' }] }
  assert.notEqual(projectHash(project), projectHash(withManifest))
  assert.notEqual(projectHash(withManifest), projectHash({ ...project, proof: [{ ...entry, manifest: 'pkg.json' }] }))
  assert.throws(() => requireOnboarded('/repo', () => JSON.stringify({ ...withManifest, onboarded: { hash: createHash('sha256').update(JSON.stringify([project.suite, [[entry.match, null, entry.run, null]]])).digest('hex') } })), (error) => error.reason === 'onboarding-stale')
})

// MUTATION: hash an absent list as null and every project onboarded before list existed reads stale.
test('projectHash of an entry without list matches the hash recorded before list existed', () => {
  const proof = [{ match: 'crates/**', run: 'sh tools/crew-proof.sh {file} {title} {report}' }, { match: 'ui/**', setup: 'npm ci', run: 'vitest {file}' }]
  const before = createHash('sha256').update(JSON.stringify(['sh tools/crew-suite.sh', proof.map((e) => [e.match, e.setup ?? null, e.run])])).digest('hex')
  assert.equal(projectHash({ suite: 'sh tools/crew-suite.sh', proof }), before)
  assert.doesNotThrow(() => requireOnboarded('/repo', () => JSON.stringify({ suite: 'sh tools/crew-suite.sh', proof, onboarded: { hash: before } })))
})

// MUTATION: compare only against projectHash and a record written while list hashed as null reads stale.
test('requireOnboarded accepts a record written while an absent list hashed as null', () => {
  const suite = 'npm test', proof = [{ match: '*.xml', run: 'node run.mjs' }]
  const hash = createHash('sha256').update(JSON.stringify([suite, [['*.xml', null, 'node run.mjs', null]]])).digest('hex')
  assert.notEqual(hash, projectHash({ suite, proof }))
  assert.equal(requireOnboarded('/repo', () => JSON.stringify({ suite, proof, onboarded: { hash } })).hash, hash)
})

test('requireOnboarded distinguishes missing and stale project records', () => {
  const suite = 'npm test', proof = []
  const hash = createHash('sha256').update(JSON.stringify([suite, proof])).digest('hex')
  const valid = { suite, proof, onboarded: { hash } }
  assert.deepEqual(ONBOARD_REASONS, ['not-onboarded', 'onboarding-stale'])
  assert.ok(Object.isFrozen(ONBOARD_REASONS))
  assert.deepEqual(requireOnboarded('/repo', () => JSON.stringify(valid)), { suite, proof, hash, suiteTimeoutMs: 1800000, proofTimeoutMs: 120000 })
  for (const [input, reason] of [
    [null, 'not-onboarded'], [{ suite, proof }, 'not-onboarded'],
    ['{', 'onboarding-stale'], [{ ...valid, suite: 'cargo test' }, 'onboarding-stale'],
    [{ ...valid, suite: '"npm test"' }, 'onboarding-stale'], [{ ...valid, proof: null }, 'onboarding-stale'],
    [{ ...valid, onboarded: null }, 'onboarding-stale'],
  ]) {
    const read = () => { if (input === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return typeof input === 'string' ? input : JSON.stringify(input) }
    assert.throws(() => requireOnboarded('/repo', read), (error) => error.reason === reason && error.message.includes('/onboard'))
  }
})

test('requireOnboarded returns a configured suiteTimeoutMs, defaults an absent one to 1800000, and refuses invalid values as onboarding-stale', () => {
  const suite = 'npm test', proof = []
  const hash = createHash('sha256').update(JSON.stringify([suite, proof])).digest('hex')
  const project = { suite, proof, onboarded: { hash } }
  for (const [field, expected] of [[{}, 1800000], [{ suiteTimeoutMs: 1 }, 1], [{ suiteTimeoutMs: 2147483647 }, 2147483647], [{ suiteTimeoutMs: 3600000 }, 3600000]]) {
    assert.deepEqual(requireOnboarded('/repo', () => JSON.stringify({ ...project, ...field })), { suite, proof, hash, suiteTimeoutMs: expected, proofTimeoutMs: 120000 })
  }
  for (const value of [null, 0, -1, 1.5, 2147483648, Number.MAX_SAFE_INTEGER + 1, '1000', true, [], {}]) {
    assert.throws(() => requireOnboarded('/repo', () => JSON.stringify({ ...project, suiteTimeoutMs: value })), (error) => error.reason === 'onboarding-stale')
  }
})

test('requireOnboarded returns a configured proofTimeoutMs, defaults an absent one to 120000, and refuses invalid values as onboarding-stale', () => {
  const suite = 'npm test', proof = []
  const hash = createHash('sha256').update(JSON.stringify([suite, proof])).digest('hex')
  const project = { suite, proof, onboarded: { hash } }
  for (const [field, expected] of [[{}, 120000], [{ proofTimeoutMs: 1 }, 1], [{ proofTimeoutMs: 2147483647 }, 2147483647], [{ proofTimeoutMs: 360000 }, 360000]]) {
    assert.equal(requireOnboarded('/repo', () => JSON.stringify({ ...project, ...field })).proofTimeoutMs, expected)
  }
  for (const value of [null, 0, -1, 1.5, 2147483648, Number.MAX_SAFE_INTEGER + 1, '1000', true, [], {}]) {
    assert.throws(() => requireOnboarded('/repo', () => JSON.stringify({ ...project, proofTimeoutMs: value })), (error) => error instanceof OnboardRefusal && error.reason === 'onboarding-stale')
  }
})

test('requireOnboarded returns a configured builderChecks, omits an absent one, and refuses invalid values as onboarding-stale', () => {
  const suite = 'npm test', proof = []
  const hash = createHash('sha256').update(JSON.stringify([suite, proof])).digest('hex')
  const project = { suite, proof, onboarded: { hash } }
  const builderChecks = ['cargo clippy -- -D warnings', 'cargo test -p fence']
  assert.deepEqual(requireOnboarded('/repo', () => JSON.stringify({ ...project, builderChecks })).builderChecks, builderChecks)
  assert.equal(projectHash({ ...project, builderChecks }), hash)
  assert.deepEqual(requireOnboarded('/repo', () => JSON.stringify(project)), { suite, proof, hash, suiteTimeoutMs: 1800000, proofTimeoutMs: 120000 })
  for (const value of ['x', null, {}, [''], ['  '], ['a\nb'], ['a\rb'], [1]]) {
    assert.throws(() => requireOnboarded('/repo', () => JSON.stringify({ ...project, builderChecks: value })), (error) => error instanceof OnboardRefusal && error.reason === 'onboarding-stale')
  }
})

test('checkOnboarding records a valid builderChecks list in project.json and refuses a string, an empty entry or a multi-line entry without writing', async () => {
  const checks = ['cargo clippy -- -D warnings', 'cargo test -p fence']
  for (const [field, status] of [[{ builderChecks: checks }, 'green'], [{}, 'green'], [{ builderChecks: 'cargo test' }, 'red'], [{ builderChecks: [''] }, 'red'], [{ builderChecks: ['  '] }, 'red'], [{ builderChecks: ['a\nb'] }, 'red']]) {
    const repo = scratchDir('onboard-builder-checks-')
    git(repo, 'init'); writeFileSync(join(repo, 'initial'), 'initial')
    git(repo, 'add', 'initial'); git(repo, 'commit', '-m', 'initial')
    const draft = join(repo, 'draft.json'), target = join(repo, '.crew', 'project.json')
    writeFileSync(draft, JSON.stringify({ suite: 'npm test', proof: [], ...field }))
    assert.equal((await checkOnboarding({ checkout: repo, draft })).status, status)
    assert.equal(existsSync(target), status === 'green')
    if (status === 'green') {
      const project = JSON.parse(readFileSync(target, 'utf8'))
      assert.equal(Object.hasOwn(project, 'builderChecks'), Object.hasOwn(field, 'builderChecks'))
      assert.deepEqual(project.builderChecks, field.builderChecks)
    }
  }
})

test('checkOnboarding records a configured proofTimeoutMs in project.json and refuses an invalid one without writing it', async () => {
  for (const [field, status] of [[{ proofTimeoutMs: 360000 }, 'green'], [{}, 'green'], [{ proofTimeoutMs: 0 }, 'red']]) {
    const repo = scratchDir('onboard-proof-timeout-')
    git(repo, 'init'); writeFileSync(join(repo, 'initial'), 'initial')
    git(repo, 'add', 'initial'); git(repo, 'commit', '-m', 'initial')
    const draft = join(repo, 'draft.json'), target = join(repo, '.crew', 'project.json')
    writeFileSync(draft, JSON.stringify({ suite: 'npm test', proof: [], ...field }))
    assert.equal((await checkOnboarding({ checkout: repo, draft })).status, status)
    assert.equal(existsSync(target), status === 'green')
    if (status === 'green') {
      const project = JSON.parse(readFileSync(target, 'utf8'))
      assert.equal(Object.hasOwn(project, 'proofTimeoutMs'), Object.hasOwn(field, 'proofTimeoutMs'))
      assert.equal(project.proofTimeoutMs, field.proofTimeoutMs)
      assert.equal(requireOnboarded(repo).proofTimeoutMs, field.proofTimeoutMs ?? 120000)
    }
  }
})

test('checkOnboarding records a configured suiteTimeoutMs in project.json and refuses an invalid one without writing it', async () => {
  for (const [value, status] of [[3600000, 'green'], [0, 'red']]) {
    const repo = scratchDir('onboard-timeout-')
    git(repo, 'init')
    writeFileSync(join(repo, 'initial'), 'initial')
    git(repo, 'add', 'initial')
    git(repo, 'commit', '-m', 'initial')
    const draft = join(repo, 'draft.json'), target = join(repo, '.crew', 'project.json')
    writeFileSync(draft, JSON.stringify({ suite: 'npm test', proof: [], suiteTimeoutMs: value }))
    assert.equal((await checkOnboarding({ checkout: repo, draft })).status, status)
    assert.equal(existsSync(target), status === 'green')
    if (status === 'green') {
      assert.equal(JSON.parse(readFileSync(target, 'utf8')).suiteTimeoutMs, value)
      assert.equal(requireOnboarded(repo).suiteTimeoutMs, value)
    }
  }
})

test('checkOnboarding records worktreeSetup, and a changed or added worktreeSetup reads onboarding-stale', async () => {
  for (const value of ['node seed.mjs', undefined, ' ']) {
    const repo = scratchDir('onboard-worktree-setup-')
    git(repo, 'init'); writeFileSync(join(repo, 'initial'), 'initial')
    git(repo, 'add', 'initial'); git(repo, 'commit', '-m', 'initial')
    const draft = join(repo, 'draft.json'), target = join(repo, '.crew', 'project.json')
    writeFileSync(draft, JSON.stringify({ suite: 'npm test', proof: [], ...(value === undefined ? {} : { worktreeSetup: value }) }))
    assert.equal((await checkOnboarding({ checkout: repo, draft })).status, value === ' ' ? 'red' : 'green')
    if (value === ' ') { assert.equal(existsSync(target), false); continue }
    const record = JSON.parse(readFileSync(target, 'utf8'))
    assert.equal(record.worktreeSetup, value)
    assert.equal(requireOnboarded(repo).worktreeSetup, value)
    record.worktreeSetup = 'node other.mjs'
    writeFileSync(target, JSON.stringify(record))
    assert.throws(() => requireOnboarded(repo), (error) => error.reason === 'onboarding-stale')
  }
})

function seatFixture(overrides = {}, behavior = () => ({})) {
  const repo = scratchDir('onboard-seats-')
  git(repo, 'init'); writeFileSync(join(repo, 'initial'), 'initial')
  git(repo, 'add', 'initial'); git(repo, 'commit', '-m', 'initial')
  mkdirSync(join(repo, '.crew'))
  writeFileSync(join(repo, '.crew', 'agents.json'), JSON.stringify(overrides))
  const draft = join(repo, 'draft.json'), target = join(repo, '.crew', 'project.json')
  writeFileSync(draft, JSON.stringify({ suite: 'npm test', proof: [] }))
  const launches = [], output = []
  const clientFactory = ({ launch }) => {
    const model = launch.sessionParams?._meta?.claudeCode?.options?.model ?? launch.args[launch.args.indexOf('--model') + 1]
    launches.push({ model, args: launch.args })
    const result = behavior(model)
    return { start() {}, initialize() {}, newSession() { if (result.error) throw result.error }, setMode() {}, beginPrompt: () => 1,
      pollPrompt: () => result.turn ?? { stopReason: 'end_turn', refusal: null }, cancelPrompt() {}, cancel() {}, hasExitMarker: () => false, close: () => ({ outcome: 'proven' }) }
  }
  const deps = { crewRoot: join(repo, 'personal'), binaries: Object.fromEntries(['claudeAcp', 'claude', 'pi', 'muse'].map((key) => [key, process.execPath])), clientFactory, write: (text) => output.push(text) }
  return { repo, draft, target, launches, output, deps }
}

test('crew onboard refuses and writes no record when the planner seat cell is unavailable', async () => {
  for (const [agent, model, failure, text] of [
    ['muse', 'meta/probe-login', { error: Object.assign(new Error('refused'), { method: 'session/new', errorKind: null, errorMessage: 'log in to Muse before opening a session' }) }, 'log in to Muse before opening a session'],
    ['claude', 'anthropic/probe-key', { turn: { stopReason: null, refusal: { code: -32603, message: 'Internal error: Invalid API key · Fix external API key', errorKind: 'authentication_failed' } } }, 'Internal error: Invalid API key · Fix external API key'],
  ]) {
    const f = seatFixture({ planner: { agent, model, effort: 'high' } }, (selected) => selected === model.split('/')[1] ? failure : {})
    assert.equal(await main(['--check', f.draft, '--checkout', f.repo], f.deps), 1)
    assert.equal(existsSync(f.target), false)
    const out = f.output.join('')
    assert.ok(out.includes(`seat ${agent} ${model} high`)); assert.ok(out.includes('planner@build')); assert.ok(out.includes(text))
    assert.ok(out.includes('~/.crew/agents.json')); assert.ok(out.includes(join(f.repo, '.crew', 'agents.json')))
  }
})

test('crew onboard reports an unmeasured cell with its closed reason and not as available', async () => {
  for (const missing of [false, true]) {
    const f = seatFixture({ planner: { agent: 'muse', model: 'meta/probe-timeout', effort: 'high' } }, (model) => model === 'probe-timeout' ? { error: Object.assign(new Error('timeout'), { reason: 'acp-request-timeout', method: 'session/new' }) } : {})
    if (missing) { delete f.deps.binaries; f.deps.env = { PATH: '' } }
    assert.equal(await main(['--check', f.draft, '--checkout', f.repo], f.deps), 0)
    assert.equal(existsSync(f.target), true)
    const line = f.output.find((row) => row.includes('seat muse meta/probe-timeout high'))
    assert.ok(line?.includes(`unmeasured: ${missing ? 'binary-missing' : 'timeout'}`)); assert.ok(!line.includes('available'))
  }
  const { SEAT_UNMEASURED_REASONS } = await import('./seat-probe.mjs')
  assert.deepEqual(SEAT_UNMEASURED_REASONS, ['timeout', 'binary-missing', 'spawn-failed', 'agent-exited', 'rate-limited', 'provider-error', 'turn-incomplete', 'probe-failed'])
  assert.ok(Object.isFrozen(SEAT_UNMEASURED_REASONS)); assert.equal(new Set(SEAT_UNMEASURED_REASONS).size, SEAT_UNMEASURED_REASONS.length)
})

test('crew onboard --seats probes the roster without running proof calibration', async () => {
  for (const refused of [false, true]) {
    const f = seatFixture({ planner: { agent: 'muse', model: 'meta/probe-seats', effort: 'high' } }, (model) => refused && model === 'probe-seats' ? { turn: { refusal: { message: 'no access' } } } : {})
    assert.equal(await main(['--seats', '--checkout', f.repo], f.deps), refused ? 1 : 0)
    assert.ok(f.launches.length > 0); assert.equal(existsSync(f.target), false)
    assert.ok(!f.output.join('').includes('project recorded'))
  }
})

test('crew onboard probes each distinct seat cell once across roles and tiers, the advisor included', async () => {
  const shared = { agent: 'pi', model: 'openai/probe-shared', effort: 'high' }
  const f = seatFixture({ lead: shared, planner: shared, builder: { advisor: { agent: 'pi', model: 'openai/probe-advisor', effort: 'medium' } } })
  assert.equal(await main(['--seats', '--checkout', f.repo], f.deps), 0)
  const lines = f.output.filter((row) => row.startsWith('crew onboard: seat '))
  assert.equal(f.launches.length, lines.length)
  assert.equal(new Set(lines.map((line) => line.split(' (')[0])).size, lines.length)
  assert.equal(f.launches.filter(({ model, args }) => model === 'openai-codex/probe-shared' && args[args.indexOf('--thinking') + 1] === 'high').length, 1)
  assert.ok(f.launches.some(({ model, args }) => model === 'openai-codex/probe-advisor' && args[args.indexOf('--thinking') + 1] === 'medium'))
  assert.ok(lines.some((line) => line.includes('openai/probe-advisor') && line.includes('advisor@')))
})

test('crew onboard refuses a roster override it cannot resolve without recording', async () => {
  const f = seatFixture({ unknown: { model: 'openai/nope' } })
  assert.equal(await main(['--check', f.draft, '--checkout', f.repo], f.deps), 1)
  assert.ok(f.output.join('').includes('roster:')); assert.ok(f.output.join('').includes('unknown is not a role'))
  assert.equal(existsSync(f.target), false); assert.equal(f.launches.length, 0)
})
