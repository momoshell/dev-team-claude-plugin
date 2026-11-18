import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkOnboarding, main, projectHash, requireOnboarded } from './onboard.mjs'
import { git, scratchDir } from '../test/helpers.mjs'

test('projectHash changes when a proof entry gains a manifest', () => {
  const entry = { match: '*.xml', run: 'node run.mjs' }
  const project = { suite: 'npm test', proof: [entry] }
  const withManifest = { ...project, proof: [{ ...entry, manifest: 'Cargo.toml' }] }
  assert.notEqual(projectHash(project), projectHash(withManifest))
  assert.notEqual(projectHash(withManifest), projectHash({ ...project, proof: [{ ...entry, manifest: 'pkg.json' }] }))
  assert.throws(() => requireOnboarded('/repo', () => JSON.stringify({ ...withManifest, onboarded: { hash: createHash('sha256').update(JSON.stringify([project.suite, [[entry.match, null, entry.run, null]]])).digest('hex') } })), (error) => error.reason === 'onboarding-stale')
})

test('projectHash changes when a proof entry gains newTestFile', () => {
  const entry = { match: '*.xml', run: 'node run.mjs' }
  const project = { suite: 'npm test', proof: [entry] }
  const opted = { ...project, proof: [{ ...entry, newTestFile: true }] }
  const oldHash = projectHash(project)
  const oldNullListHash = createHash('sha256').update(JSON.stringify([project.suite, [[entry.match, null, entry.run, null]]])).digest('hex')
  assert.notEqual(projectHash(opted), oldHash)
  for (const hash of [oldHash, oldNullListHash]) assert.throws(() => requireOnboarded('/repo', () => JSON.stringify({ ...opted, onboarded: { hash } })), (error) => error.reason === 'onboarding-stale')
  assert.equal(requireOnboarded('/repo', () => JSON.stringify({ ...opted, onboarded: { hash: projectHash(opted) } })).proof[0].newTestFile, true)
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

test('crew onboard refuses a roster override it cannot resolve without recording', async () => {
  const f = seatFixture({ unknown: { model: 'openai/nope' } })
  assert.equal(await main(['--check', f.draft, '--checkout', f.repo], f.deps), 1)
  assert.ok(f.output.join('').includes('roster:')); assert.ok(f.output.join('').includes('unknown is not a role'))
  assert.equal(existsSync(f.target), false); assert.equal(f.launches.length, 0)
})
