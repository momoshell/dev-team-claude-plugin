import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { execSync, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openLedger } from '../scripts/factory/ledger.mjs'
import { openRun, _resetNoticeGuardsForTest } from '../scripts/factory/emit.mjs'
import { composeLayout, DEFAULT_ROLES, bootAllocation, resolveWorkerBin, docOpenArgs, resolveTier, resolveSeatModels, FALLBACK_REFUSALS, refuseFallback, loadRoster, normalizeRoster, refuseRoster, rosterSeating, serializeRosterV1, serializeRosterV2, ROSTER_REFUSALS, ROSTER_SCHEMA_VERSIONS, rosterSourcePath, loadRosterSource, writeRosterSnapshot, rosterSnapshotReader, loadLadder, assertBandFloors, grantedDefModels, assertDefBandFloors, refuseBandFloor, seatModelKey, bandForMember, bandForRaw, seatBand, LADDER_PATH, BAND_FLOOR_REFUSALS, shadowCandidates, assertSeats, parkSeats, parkOnOutcome, escalationAttention, bootCmd, runCmd, RUN_START_EVENT, assignmentsFromJournal, resolveRunConfig, aliasDeprecationLines, persistedRunConfig, awaitSeatsReady, teardownCore, teardownCmd, TEARDOWN_EXIT_SEATLESS, TEARDOWN_EXIT_UNPROVEN, TEARDOWN_ABSENT_CAUSES, teardownAbsentCause, TEARDOWN_DRAIN_MS, TEARDOWN_DRAIN_ERROR_MS, installRunFinalizers, writeTerminalLine, BOOT_DESCENDANT_REFUSALS, descendantRefusal, refuseStaleDescendants, loadCapabilities, reviewIdentityFromArgs } from './crew.mjs'
import { specExecution } from './child.mjs'
import { resolveRunConfig as resolveDaemonRunConfig } from './daemon.mjs'
import { resolveRunConfig as resolveFactoryRunConfig, parseArgs as parseFactoryArgs, runVerb } from './factoryctl.mjs'
import { TASK_PROFILES } from './task-profiles.mjs'
import { ASSURANCES, ASSURANCE_ALIASES, ASSURANCE_ALIAS_OF } from './assurances.mjs'
import { VARIANT_NAMES, DEFAULT_VARIANT } from './drive.mjs'
import { reclaimStore } from './reclaim.mjs'
import { modelString as claudeModelString } from './adapters/adapter-claude.mjs'
import { modelString as piModelString } from './adapters/adapter-pi.mjs'
import { seatIo, paneTeardownRows, PANE_SETTLE_POLLS, PANE_SETTLE_MS } from './seat-io.mjs'
import { testCheckout } from '../test/fixtures.mjs'
import { scratchDir } from '../test/helpers.mjs'
import { shippedRoster, roster, nodeMeetsLedgerFloor, withHome, testCrewDir, callCounter } from './crew-test-helpers.mjs'

// Keep lexical import reach visible before byte-pinned regex test bodies.
void [test, assert, createHash, readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, renameSync, execSync, spawn, tmpdir, join, fileURLToPath, openLedger, openRun, _resetNoticeGuardsForTest, composeLayout, DEFAULT_ROLES, bootAllocation, resolveWorkerBin, docOpenArgs, resolveTier, resolveSeatModels, FALLBACK_REFUSALS, refuseFallback, loadRoster, normalizeRoster, refuseRoster, rosterSeating, serializeRosterV1, serializeRosterV2, ROSTER_REFUSALS, ROSTER_SCHEMA_VERSIONS, rosterSourcePath, loadRosterSource, writeRosterSnapshot, rosterSnapshotReader, loadLadder, assertBandFloors, grantedDefModels, assertDefBandFloors, refuseBandFloor, seatModelKey, bandForMember, bandForRaw, seatBand, LADDER_PATH, BAND_FLOOR_REFUSALS, shadowCandidates, assertSeats, parkSeats, parkOnOutcome, escalationAttention, bootCmd, runCmd, RUN_START_EVENT, assignmentsFromJournal, resolveRunConfig, aliasDeprecationLines, persistedRunConfig, awaitSeatsReady, teardownCore, teardownCmd, TEARDOWN_EXIT_SEATLESS, TEARDOWN_EXIT_UNPROVEN, TEARDOWN_ABSENT_CAUSES, teardownAbsentCause, TEARDOWN_DRAIN_MS, TEARDOWN_DRAIN_ERROR_MS, installRunFinalizers, writeTerminalLine, BOOT_DESCENDANT_REFUSALS, descendantRefusal, refuseStaleDescendants, loadCapabilities, reviewIdentityFromArgs, specExecution, resolveDaemonRunConfig, resolveFactoryRunConfig, parseFactoryArgs, runVerb, TASK_PROFILES, ASSURANCES, ASSURANCE_ALIASES, ASSURANCE_ALIAS_OF, VARIANT_NAMES, DEFAULT_VARIANT, reclaimStore, claudeModelString, piModelString, seatIo, paneTeardownRows, PANE_SETTLE_POLLS, PANE_SETTLE_MS, testCheckout, scratchDir, shippedRoster, roster, nodeMeetsLedgerFloor, withHome, testCrewDir, callCounter]

const rosterLadder = JSON.parse(readFileSync(new URL('./model-ladder.json', import.meta.url), 'utf8'))

// Focused test-local schema evaluator for the fallback fixtures. The production
// refresh validator intentionally supports a smaller keyword set, so these
// tests exercise the shipped $ref chain, minItems and closed entry objects.

function fallbackSchemaErrors(value, entry = 'seat', document = 'roster.schema.json') {
  const schema = JSON.parse(readFileSync(new URL('./roster.schema.json', import.meta.url), 'utf8'))
  const documents = {
    'roster.schema.json': schema,
    'roster.v2.schema.json': JSON.parse(readFileSync(new URL('./roster.v2.schema.json', import.meta.url), 'utf8')),
  }
  const deref = (raw, docName = 'roster.schema.json', depth = 0) => {
    if (!raw || typeof raw !== 'object' || typeof raw.$ref !== 'string') return { schema: raw, docName }
    if (depth > 8) throw new Error(`$ref chain too deep: ${raw.$ref}`)
    const [file, pointer = ''] = raw.$ref.split('#')
    const targetName = file ? file.replace(/^.*\//, '') : docName
    let target = documents[targetName]
    for (const part of pointer.replace(/^\//, '').split('/').filter(Boolean)) target = target?.[part]
    return deref(target, targetName, depth + 1)
  }
  const errors = []
  const walk = (raw, docName, actual, path) => {
    const { schema: shape, docName: here } = deref(raw, docName)
    if (!shape || typeof shape !== 'object') { errors.push(`${path}: unresolved schema`); return }
    if (Object.hasOwn(shape, 'const')) {
      if (actual !== shape.const) errors.push(`${path}: const`)
      return
    }
    const types = Array.isArray(shape.type) ? shape.type : shape.type ? [shape.type] : []
    if (types.length) {
      const kinds = actual === null ? ['null'] : Array.isArray(actual) ? ['array'] : typeof actual === 'number' && Number.isInteger(actual) ? ['number', 'integer'] : [typeof actual]
      if (!types.some((type) => kinds.includes(type))) { errors.push(`${path}: expected ${types.join('|')}, found ${kinds.join('|')}`); return }
    }
    if (actual === null) return
    if (Array.isArray(shape.enum) && !shape.enum.includes(actual)) errors.push(`${path}: enum`)
    if (typeof actual === 'string' && shape.pattern && !new RegExp(shape.pattern).test(actual)) errors.push(`${path}: pattern`)
    if (typeof actual === 'number' && shape.minimum !== undefined && actual < shape.minimum) errors.push(`${path}: minimum`)
    if (Array.isArray(actual)) {
      if (Number.isFinite(shape.minItems) && actual.length < shape.minItems) errors.push(`${path}: minItems`)
      if (shape.items) actual.forEach((child, i) => walk(shape.items, here, child, `${path}[${i}]`))
      return
    }
    if (actual && typeof actual === 'object') {
      for (const key of shape.required || []) if (!Object.hasOwn(actual, key)) errors.push(`${path}: required ${key}`)
      const properties = shape.properties || {}
      const patterns = Object.entries(shape.patternProperties || {}).map(([pattern, child]) => [new RegExp(pattern), child])
      if (shape.additionalProperties === false) {
        for (const key of Object.keys(actual)) {
          if (Object.hasOwn(properties, key) || patterns.some(([pattern]) => pattern.test(key))) continue
          errors.push(`${path}: additional ${key}`)
        }
      }
      for (const [key, child] of Object.entries(properties)) if (Object.hasOwn(actual, key)) walk(child, here, actual[key], `${path}.${key}`)
      for (const [key, value] of Object.entries(actual)) {
        if (Object.hasOwn(properties, key)) continue
        const pattern = patterns.find(([candidate]) => candidate.test(key))
        if (pattern) walk(pattern[1], here, value, `${path}.${key}`)
      }
    }
  }
  const root = typeof entry === 'string' ? documents[document]?.$defs?.[entry] : (entry || documents[document])
  walk(root, document, value, typeof entry === 'string' ? entry : '$')
  return errors
}

const PARK_CREW = {
  roles: ['lead', 'planner', 'builder', 'reviewer'],
  members: {
    lead: { surface_id: 'surface-lead', pane_id: 'pane-lead', transport: 'pane' },
    planner: { surface_id: null, pane_id: 'pane-planner', transport: 'pane' },
    builder: { surface_id: null, pane_id: null, transport: 'headless' },
    reviewer: { surface_id: 'surface-reviewer', pane_id: 'pane-reviewer', transport: 'pane' },
  },
}


const mk = (role) => `run-${role}`


function assertBinary(node) {
  if (node.pane) {
    assert.equal(node.pane.surfaces.length, 1)
    return 1
  }
  assert.ok(['horizontal', 'vertical'].includes(node.direction))
  assert.equal(node.children.length, 2, 'split nodes must be strictly binary')
  return node.children.reduce((n, c) => n + assertBinary(c), 0)
}



const KEEPALIVE_LIFETIME_ENV = 'CREW_TEST_KEEPALIVE_LIFETIME_MS'

const KEEPALIVE_LIFETIME_DEFAULT_MS = 300_000

const KEEPALIVE_LIFETIME_TEST_MS = 750

const KEEPALIVE_READY_TIMEOUT_MS = 5000

const KEEPALIVE_EXIT_TIMEOUT_MS = 5000

const KEEPALIVE_OBSERVATION_WINDOW_MS = 250

const KEEPALIVE_CLEANUP_TIMEOUT_MS = 1000

const KEEPALIVE_POLL_MS = 25

const KEEPALIVE_INTERVAL = ['set', 'Interval', '(() => {}, 1000)'].join('')

const KEEPALIVE_TIMER_STATEMENT = [
  'setTimeout(() => process.exit(0), Number(process.env.',
  KEEPALIVE_LIFETIME_ENV,
  ' || ${KEEPALIVE_LIFETIME_DEFAULT_MS}))',
].join('')


function finalizerChildFixture() {
  const root = scratchDir('crew-run-finalizer-')
  const stateDir = join(root, 'state')
  const dbPath = join(root, 'ledger.db')
  const readyPath = join(root, 'ready.json')
  const script = join(root, 'run-finalizer-child.mjs')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(script, `import { openRun } from ${JSON.stringify(new URL('../scripts/factory/emit.mjs', import.meta.url).href)}
import { installRunFinalizers } from ${JSON.stringify(new URL('./crew.mjs', import.meta.url).href)}
import { writeFileSync, renameSync } from 'node:fs'
const stateDir = ${JSON.stringify(stateDir)}
const dbPath = ${JSON.stringify(dbPath)}
const readyPath = ${JSON.stringify(readyPath)}
const emitter = openRun({ stateDir, repoSlug: 'crew', taskSlug: 'run-finalizer', dbPath, stderr: { write: () => {} } })
emitter.startRun()
installRunFinalizers(emitter)
writeFileSync(readyPath + '.tmp', JSON.stringify({ adw_id: emitter.adwId }))
renameSync(readyPath + '.tmp', readyPath)
setTimeout(() => process.exit(0), Number(process.env.CREW_TEST_KEEPALIVE_LIFETIME_MS || ${KEEPALIVE_LIFETIME_DEFAULT_MS}))
setInterval(() => {}, 1000)
`)
  return { root, stateDir, dbPath, readyPath, script }
}


async function runFinalizerChild() {
  const fixture = finalizerChildFixture()
  let child
  let stdout = ''
  let stderr = ''
  try {
    const result = await new Promise((resolve, reject) => {
      let settled = false
      let signalled = false
      const timeout = setTimeout(() => {
        try { child?.kill('SIGKILL') } catch {}
        finish(new Error('run finalizer child timed out'), true)
      }, 15000)
      const poll = setInterval(() => {
        if (signalled || !existsSync(fixture.readyPath)) return
        signalled = true
        try { child.kill('SIGTERM') } catch (err) { finish(err, true) }
      }, 10)
      const finish = (value, failed = false) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        clearInterval(poll)
        if (failed) reject(value)
        else resolve(value)
      }
      child = spawn(process.execPath, [fixture.script], { stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.on('data', (chunk) => { stdout += String(chunk) })
      child.stderr.on('data', (chunk) => { stderr += String(chunk) })
      child.once('error', (err) => finish(err, true))
      child.once('close', (code, signal) => finish({ code, signal }))
    })
    const ready = JSON.parse(readFileSync(fixture.readyPath, 'utf8'))
    const sidecar = JSON.parse(readFileSync(join(fixture.stateDir, 'ledger', 'run.json'), 'utf8'))
    const ledger = openLedger({ dbPath: fixture.dbPath, stderr: { write: () => {} } })
    let sessions
    try { sessions = ledger.dumpTable('sessions').filter((row) => row.adw_id === sidecar.adw_id) }
    finally { ledger.close() }
    const jsonl = readFileSync(join(fixture.root, 'ledger.jsonl'), 'utf8').trim()
      .split('\n').filter(Boolean).map((line) => JSON.parse(line))
    return {
      ...result, stdout, stderr, ready, sidecar, sessions,
      endRows: jsonl.filter((row) => row.kind === 'endSession' && row.args?.adw_id === sidecar.adw_id),
    }
  } finally {
    if (child && child.exitCode == null && child.signalCode == null) {
      try { child.kill('SIGKILL') } catch {}
    }
    rmSync(fixture.root, { recursive: true, force: true })
  }
}


function rememberKeepaliveError(child) {
  child._keepaliveError = null
  child.once('error', (error) => { child._keepaliveError = error })
  return child
}


function launchKeepaliveChild(fixture, env) {
  return rememberKeepaliveError(spawn(process.execPath, [fixture.script], {
    env, stdio: ['ignore', 'ignore', 'ignore'],
  }))
}


function keepaliveChildRunning(child) {
  return child != null && child.exitCode == null && child.signalCode == null
}


async function waitForKeepaliveReady(fixture, child) {
  const deadline = Date.now() + KEEPALIVE_READY_TIMEOUT_MS
  while (!existsSync(fixture.readyPath)) {
    if (child?._keepaliveError) throw child._keepaliveError
    if (!keepaliveChildRunning(child)) throw new Error(`keepalive child exited before readiness: code=${child?.exitCode ?? 'unknown'} signal=${child?.signalCode ?? 'unknown'}`)
    if (Date.now() >= deadline) throw new Error(`keepalive child never wrote ${fixture.readyPath}`)
    await new Promise((resolve) => setTimeout(resolve, KEEPALIVE_POLL_MS))
  }
}


function waitForKeepaliveClose(child, timeoutMs) {
  if (!child) return Promise.resolve(null)
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  return new Promise((resolve) => {
    let timer
    const onClose = (code, signal) => finish({ code, signal })
    const finish = (result) => {
      clearTimeout(timer)
      child.removeListener('close', onClose)
      resolve(result)
    }
    child.once('close', onClose)
    timer = setTimeout(() => finish(null), timeoutMs)
  })
}


function probeKeepaliveProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'ESRCH' ? false : null
  }
}


async function waitForKeepaliveProcessGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (probeKeepaliveProcess(pid) === false) return true
    await new Promise((resolve) => setTimeout(resolve, KEEPALIVE_POLL_MS))
  }
  return probeKeepaliveProcess(pid) === false
}


function readKeepalivePid(path) {
  try {
    const raw = readFileSync(path, 'utf8').trim()
    const pid = Number(raw)
    return raw && Number.isSafeInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}


function disposableKeepaliveParentFixture(fixture) {
  const pidPath = join(fixture.root, 'keepalive-child.pid')
  const parentScript = join(fixture.root, 'keepalive-parent.mjs')
  writeFileSync(parentScript, `import { existsSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
const child = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(fixture.script)}], { stdio: 'ignore' })
writeFileSync(${JSON.stringify(pidPath)}, String(child.pid))
const deadline = Date.now() + ${KEEPALIVE_READY_TIMEOUT_MS}
const wait = () => {
  if (existsSync(${JSON.stringify(fixture.readyPath)})) {
    child.unref()
    process.exit(0)
  }
  if (Date.now() >= deadline) {
    try { child.kill('SIGKILL') } catch {}
    process.exit(1)
  }
  setTimeout(wait, ${KEEPALIVE_POLL_MS})
}
wait()
`)
  return { parentScript, pidPath }
}


function readKeepaliveSource(file) {
  try {
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')
    if (file !== './crew.test.mjs') return source
    const cliSource = readFileSync(fileURLToPath(new URL('./crew-cli.test.mjs', import.meta.url)), 'utf8')
    return `${source}\n${cliSource}`
  } catch (error) { throw new Error(`keepalive source unavailable: ${file}: ${error?.code || 'unknown'}`, { cause: error }) }
}


async function runCmdEmitterProbe() {
  const home = scratchDir('crew-run-finalizer-seam-home-')
  const checkoutRoot = scratchDir('crew-run-finalizer-seam-checkout-')
  const checkout = join(checkoutRoot, 'checkout')
  const task = 'run-finalizer-seam'
  const brief = join(home, 'brief.md')
  const dir = join(home, '.crew', 'checkout', task)
  mkdirSync(checkout, { recursive: true })
  mkdirSync(join(dir, 'returns'), { recursive: true })
  mkdirSync(join(dir, 'task'), { recursive: true })
  execSync('git init -q && git -c user.email=seam@example.test -c user.name=seam commit --allow-empty -q -m seed', { cwd: checkout })
  writeFileSync(brief, '# seam brief\\n')
  writeFileSync(join(dir, 'journal.jsonl'), '')
  writeFileSync(join(dir, 'crew.json'), JSON.stringify({
    schema_version: 3, task, checkout, tier: 'build',
    roles: ['planner', 'builder', 'reviewer'],
    members: Object.fromEntries(['planner', 'builder', 'reviewer'].map((role) => [role, {
      surface_id: null, pane_id: null, transport: 'headless-json', model: 'sonnet', agent: 'claude',
    }])),
    task_return: join(dir, 'returns', 'task.json'),
  }))
  const started = { adwId: 'started-facade', starts: 0, startRun() { this.starts += 1 }, endRun() {} }
  const replacement = { adwId: 'replacement-facade', starts: 0, startRun() { this.starts += 1 }, endRun() {} }
  let opened = 0
  let handed
  const previousExitCode = process.exitCode
  try {
    await withHome(home, () => runCmd({ task, checkout, 'brief-file': brief, keep: true }, {
      openRun: () => { opened += 1; return opened === 1 ? started : replacement },
      installRunFinalizers: (emitter) => { handed = emitter },
      awaitSeatsReady: () => {},
      seatIo: () => ({}),
      drive: () => ({ status: 'done', summary: '', artifacts: [], details: {} }),
      appendCompletion: () => {},
      writeTerminalLine: () => {},
    }))
    return { opened, started, replacement, handed }
  } finally {
    process.exitCode = previousExitCode
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
}


function runTeardownDrainFixture({ assignments = [], returned = [], taskStatus, members, closeSurface, sleep, now } = {}) {
  const parent = scratchDir('crew-teardown-drain-')
  const dir = join(parent, 'crew')
  const returnsDir = join(dir, 'returns')
  const taskDir = join(dir, 'task')
  mkdirSync(returnsDir, { recursive: true })
  mkdirSync(taskDir, { recursive: true })
  const lines = [JSON.stringify({ at: 't0', event: RUN_START_EVENT })]
  for (const assignment of assignments) {
    lines.push(JSON.stringify({ at: 't1', assign: assignment.id, role: assignment.role, brief: 'brief.md' }))
  }
  writeFileSync(join(dir, 'journal.jsonl'), `${lines.join('\n')}\n`)
  for (const assignment of returned) {
    writeFileSync(join(returnsDir, `${assignment.id}.${assignment.role}.json`), '{"status":"done"}')
  }
  if (taskStatus !== undefined) writeFileSync(join(returnsDir, 'task.json'), JSON.stringify({ status: taskStatus }))
  const journal = []
  const order = []
  let clock = 0
  const nowFn = now || (() => { clock += 1000; return clock })
  const sleepFn = sleep || (() => {})
  const crewMembers = members || { builder: { surface_id: 'surface-builder', transport: 'pane' } }
  let record
  try {
    record = teardownCore({ dir, returnsDir, taskDir }, { workspace_id: null, members: crewMembers }, {
      closeSurface: (id) => {
        order.push(`close:${id}`)
        return closeSurface ? closeSurface(id, { returnsDir, order }) : true
      },
      closeWorkspace: () => {},
      probe: () => false,
      sleep: (ms) => {
        order.push(`sleep:${ms}`)
        sleepFn(ms, { returnsDir, order })
      },
      now: nowFn,
      settleSeatRoots: () => null,
      reclaimDescendants: () => null,
      recordTreeFingerprint: () => ({ recorded: false, path: null }),
      io: { log: (row) => journal.push(row), emit: () => true },
    })
  } finally { rmSync(parent, { recursive: true, force: true }) }
  return { record, journal, order, rows: journal.filter((row) => row.event === 'teardown-drain') }
}


const seatedBuildReviewer = roster.tiers.build.reviewer

const seatedJudgeTechLeadFallback = roster.tiers.judge['tech-lead'].fallback

const rosterFixtures = () => {
  const v1 = structuredClone(roster)
  const v2 = {
    schema_version: 2,
    updated_at: roster.updated_at,
    assurances: Object.fromEntries(Object.entries(ASSURANCE_ALIAS_OF).map(([canonical, legacy]) => [canonical, structuredClone(roster.tiers[legacy])])),
    models: structuredClone(roster.models),
    policy: {},
  }
  return { v1, v2 }
}

const fixtureEntries = () => Object.entries(rosterFixtures())

const fixtureTierName = (version, legacy) => version === 'v1' ? legacy : ASSURANCE_ALIASES[legacy]

const fixtureWithCells = (fixture, version, legacy, cells) => {
  const out = structuredClone(fixture)
  const container = version === 'v1' ? 'tiers' : 'assurances'
  out[container][fixtureTierName(version, legacy)] = cells
  return out
}

const LOCAL_MEMBER = 'local/qwen3-coder-30b'

const localCatalog = { [LOCAL_MEMBER]: { cost_in_per_mtok: 0, cost_out_per_mtok: 0, context: 262144, tags: ['local'], source: 'local', last_verified: '2026-09-01' } }

const ladderWithLocalAt = (band) => {
  const clone = structuredClone(rosterLadder)
  clone.bands.find((entry) => entry.band === band).members.push(LOCAL_MEMBER)
  return loadLadder({ path: '/injected/b375-model-ladder.json', readFile: () => JSON.stringify(clone) })
}


test('parkSeats maps seated members, prefers surfaces, falls back for headless seats, and marks warm panes', () => {
  const seats = parkSeats(PARK_CREW)
  assert.deepEqual(seats, [
    { role: 'lead', sessionId: 'surface-lead', warm: true },
    { role: 'planner', sessionId: 'pane-planner', warm: false },
    { role: 'builder', sessionId: 'headless:builder', warm: false },
    { role: 'reviewer', sessionId: 'surface-reviewer', warm: true },
  ])
  assert.equal(new Set(seats.map((seat) => seat.sessionId)).size, seats.length)
})

test('parkOnOutcome escalation mints a parked/null park with the crew seats', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-park-mint-'))
  try {
    const result = parkOnOutcome({ status: 'escalation' }, { crew: PARK_CREW, runId: 'run-park', dir, reason: 'lane red' })
    assert.equal(typeof result.park_id, 'string')
    assert.ok(result.park_id.trim())
    assert.equal(result.error, null)
    const path = join(dir, 'parks', `${result.park_id}.json`)
    assert.equal(existsSync(path), true)
    const park = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(park.state, 'parked')
    assert.equal(park.launch_state, null)
    assert.equal(park.run_id, 'run-park')
    assert.deepEqual(park.seats, parkSeats(PARK_CREW))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('parkOnOutcome done mints nothing and does not create a store directory', () => {
  const parent = mkdtempSync(join(tmpdir(), 'crew-park-done-'))
  const dir = join(parent, 'reclaim')
  try {
    assert.deepEqual(parkOnOutcome({ status: 'done' }, { crew: PARK_CREW, runId: 'run-done', dir, reason: 'green' }), { park_id: null, error: null })
    assert.equal(existsSync(dir), false)
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

test('park recordAnswer and claim round trip succeeds against the minted park', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-park-roundtrip-'))
  try {
    const minted = parkOnOutcome({ status: 'escalation' }, { crew: PARK_CREW, runId: 'run-roundtrip', dir, reason: 'suite red' })
    assert.ok(minted.park_id)
    const store = reclaimStore({ dir, actor: 'test' })
    assert.equal(store.recordAnswer(minted.park_id, { decision_id: 'decision-1', actor: 'human', answer: 'resume' }).ok, true)
    const claimed = store.claim(minted.park_id, {
      decision_id: 'decision-1', successor_run_id: 'run-successor', enqueue: () => true, successorState: () => 'absent',
    })
    assert.equal(claimed.ok, true)
    assert.equal(claimed.park.state, 'claimed')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('parkOnOutcome reports mint failures without throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-park-failure-'))
  try {
    const failed = parkOnOutcome({ status: 'escalation' }, {
      crew: PARK_CREW, runId: 'run-failed', dir, reason: 'x',
      openStore: () => ({ mintPark: () => ({ ok: false, reason: 'unresolvable' }) }),
    })
    assert.equal(failed.park_id, null)
    assert.equal(typeof failed.error, 'string')
    assert.ok(failed.error.trim())
    const thrown = parkOnOutcome({ status: 'escalation' }, {
      crew: PARK_CREW, runId: 'run-thrown', dir, reason: 'x', openStore: () => { throw new Error('store is gone') },
    })
    assert.equal(thrown.park_id, null)
    assert.equal(typeof thrown.error, 'string')
    assert.ok(thrown.error.trim())
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('escalationAttention returns the canonical keys and preserves a null park_id', () => {
  const event = escalationAttention({ task: 'task', park_id: 'park-1', why: 'lane red', artifacts: ['/journal'] })
  assert.deepEqual(Object.keys(event).sort(), ['artifacts', 'kind', 'moment', 'park_id', 'task', 'why'])
  assert.equal(event.kind, 'attention')
  assert.equal(event.moment, 'escalation')
  assert.equal(event.park_id, 'park-1')
  const unminted = escalationAttention({ task: 'task', park_id: null, why: 'mint failed' })
  assert.equal(Object.hasOwn(unminted, 'park_id'), true)
  assert.equal(unminted.park_id, null)
})

test('single role composes a bare leaf, not a wrapped split', () => {
  const layout = composeLayout(['lead'], mk)
  assert.ok(layout.pane, 'one pane must be a bare leaf')
  assert.equal(layout.pane.surfaces[0].name, 'lead')
  assert.equal(layout.pane.surfaces[0].command, 'run-lead')
})

test('multi-role layout is strictly binary with every seat present once', () => {
  for (const roles of [DEFAULT_ROLES, [...DEFAULT_ROLES, 'tech-lead'], ['lead', 'builder']]) {
    const layout = composeLayout([...roles], mk)
    assert.equal(assertBinary(layout), roles.length)
  }
})

test('lead takes the left half; members stack vertically on the right', () => {
  const layout = composeLayout([...DEFAULT_ROLES], mk)
  assert.equal(layout.direction, 'horizontal')
  assert.equal(layout.children[0].pane.surfaces[0].name, 'lead')
  let right = layout.children[1]
  const names = []
  while (right.children) {
    assert.equal(right.direction, 'vertical')
    names.push(right.children[0].pane.surfaces[0].name)
    right = right.children[1]
  }
  names.push(right.pane.surfaces[0].name)
  assert.deepEqual(names, ['planner', 'builder', 'reviewer'])
})

test('resolveWorkerBin prefers an explicit existing path over the environment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-bin-'))
  const explicit = join(dir, 'explicit'); const env = join(dir, 'env')
  writeFileSync(explicit, ''); writeFileSync(env, '')
  const old = process.env.CREW_CLAUDE_BIN
  process.env.CREW_CLAUDE_BIN = env
  try { assert.equal(resolveWorkerBin({ 'claude-bin': explicit }), explicit) }
  finally { if (old === undefined) delete process.env.CREW_CLAUDE_BIN; else process.env.CREW_CLAUDE_BIN = old; rmSync(dir, { recursive: true, force: true }) }
})

test('the boot descendant refusal set is frozen and closed', () => {
  assert.equal(Object.isFrozen(BOOT_DESCENDANT_REFUSALS), true)
  assert.throws(() => refuseStaleDescendants('anything-else', { task: 't' }))
})

test('descendantRefusal applies alive before unknown before mismatch', () => {
  const row = (overrides) => ({ event: 'descendant-reclaim', ...overrides })
  const clean = { retryable: 0, record_failed: 0, snapshot_ok: true }
  assert.equal(descendantRefusal([row({ reason: 'evidence-mismatch', identity_refused: 1 }), row({ reason: 'probe-unknown', probe_unknown: 1 }), row({ reason: 'root-alive' })], clean), 'descendants-alive')
  assert.equal(descendantRefusal([row({ reason: 'evidence-mismatch', identity_refused: 1 }), row({ reason: 'probe-unknown', probe_unknown: 1 })], clean), 'descendants-unknown')
  assert.equal(descendantRefusal([row({ reason: 'evidence-mismatch', identity_refused: 1 })], clean), 'descendants-evidence-mismatch')
  assert.equal(descendantRefusal([], clean), null)
  assert.equal(descendantRefusal([], { ...clean, retryable: 1 }), 'descendants-unreclaimed')
  assert.equal(descendantRefusal([], { ...clean, snapshot_ok: false }), 'descendants-unreclaimed')
})

test('bootAllocation carries resolved transports alongside tier provenance', () => {
  assert.deepEqual(
    bootAllocation(['lead', 'builder'], {}, { lead: { model: 'roster' }, builder: { agent: 'roster' } }, { lead: 'headless-json', builder: 'headless-rpc' }),
    { lead: { model: 'roster', transport: 'headless-json' }, builder: { agent: 'roster', transport: 'headless-rpc' } },
  )
})

test('run configuration resolves every canonical and deprecated request through all entry points', () => {
  const resolveEverywhere = (request) => {
    const expected = resolveRunConfig(request)
    assert.deepEqual(resolveDaemonRunConfig(request), expected)
    assert.deepEqual(resolveFactoryRunConfig(request), expected)
    return expected
  }
  assert.equal(resolveEverywhere({}).execution.effective, DEFAULT_VARIANT)
  for (const profile of Object.keys(TASK_PROFILES)) {
    const resolved = resolveEverywhere({ profile })
    assert.equal(resolved.profile.effective, profile)
  }
  for (const name of VARIANT_NAMES) {
    assert.deepEqual(resolveEverywhere({ execution: name }).execution, {
      requested: name, effective: name, source: 'explicit', status: 'existing',
    })
    const alias = resolveEverywhere({ variant: name })
    assert.deepEqual(alias.execution, {
      requested: name, effective: name, source: 'alias', status: 'existing',
    })
  }
  for (const assurance of Object.keys(ASSURANCES)) {
    assert.equal(resolveEverywhere({ assurance }).assurance.effective, assurance)
  }
  for (const [tier, assurance] of Object.entries(ASSURANCE_ALIASES)) {
    assert.deepEqual(resolveEverywhere({ tier }).assurance, { requested: tier, effective: assurance, source: 'alias' })
  }
  assert.equal(resolveEverywhere({ profile: 'investigation' }).execution.effective, 'scout')
  assert.equal(resolveEverywhere({ profile: 'investigation' }).execution.source, 'profile_recommendation')
  assert.throws(() => resolveRunConfig({ profile: 'investigation', execution: 'full' }), /investigation.*full/)
})

test('run configuration refuses unknown, blank, and alias-conflicting requests at every entry point', () => {
  const invalid = [
    { profile: 'no-such-profile', token: 'no-such-profile' },
    { execution: 'no-such-shape', token: 'no-such-shape' },
    { assurance: 'no-such-assurance', token: 'no-such-assurance' },
    { execution: '', token: 'blank' },
    { variant: '', token: 'blank' },
    { assurance: '', token: 'blank' },
    { tier: '', token: 'blank' },
    { execution: 'full', variant: 'full', token: 'alias' },
    { execution: 'full', variant: 'scout', token: 'alias' },
    { assurance: 'standard', tier: 'build', token: 'alias' },
    { assurance: 'quick', tier: 'judge', token: 'alias' },
  ]
  for (const request of invalid) {
    assert.throws(() => resolveRunConfig(request), new RegExp(request.token))
    assert.throws(() => resolveFactoryRunConfig(request), new RegExp(request.token))
    assert.throws(() => resolveDaemonRunConfig(request), (err) => err.code === 'invalid-spec' && new RegExp(request.token).test(err.message))
  }
})

test('alias deprecation lines are one-per-alias, canonical-safe, and shared with factoryctl', async () => {
  const both = resolveRunConfig({ variant: 'full', tier: 'build' })
  const lines = aliasDeprecationLines(both)
  assert.equal(lines.length, 2)
  assert.match(lines[0], /--variant.*--execution/)
  assert.match(lines[1], /--tier.*--assurance/)
  assert.deepEqual(aliasDeprecationLines(resolveRunConfig({ execution: 'full', assurance: 'standard' })), [])
  assert.deepEqual(aliasDeprecationLines(resolveRunConfig({})), [])

  let stderr = ''
  await runVerb(parseFactoryArgs(['run', '--crew-dir', '/tmp/crew', '--brief', '/tmp/brief.md', '--variant', 'full']), {
    call: async () => ({ run_id: 'alias-warning-test' }), stdout: () => {}, stderr: (text) => { stderr += String(text) },
  })
  assert.equal(stderr, `${aliasDeprecationLines(resolveRunConfig({ variant: 'full' }))[0]}\n`)
})

test('review identity requires paired lowercase 40-or-64 hexadecimal SHAs and freezes the context value', () => {
  assert.equal(reviewIdentityFromArgs({}), null)
  const forty = 'a'.repeat(40)
  const sixtyFour = 'b'.repeat(64)
  const identity = reviewIdentityFromArgs({ 'review-base-sha': forty, 'review-head-sha': sixtyFour })
  assert.deepEqual(identity, { base_sha: forty, head_sha: sixtyFour })
  assert.equal(Object.isFrozen(identity), true)
  for (const args of [
    { 'review-base-sha': forty },
    { 'review-head-sha': sixtyFour },
    { 'review-base-sha': 'A'.repeat(40), 'review-head-sha': sixtyFour },
    { 'review-base-sha': 'a'.repeat(39), 'review-head-sha': sixtyFour },
    { 'review-base-sha': forty, 'review-head-sha': 'b'.repeat(63) },
  ]) {
    assert.throws(() => reviewIdentityFromArgs(args), (error) => error.reason === 'invalid-review-identity')
  }
})

test('persisted run configuration derives honest values from legacy crew records', () => {
  assert.deepEqual(persistedRunConfig({ tier: 'build' }), {
    profile: { requested: null, effective: null, source: 'legacy_missing' },
    assurance: { requested: 'build', effective: 'standard', source: 'alias' },
  })
  assert.deepEqual(persistedRunConfig({}), {
    profile: { requested: null, effective: null, source: 'legacy_missing' },
    assurance: { requested: null, effective: 'standard', source: 'migration_default' },
  })
})

test('child execution projection follows the resolved shape and refuses disagreement', () => {
  const resolved = { execution: { effective: 'full' } }
  assert.equal(specExecution({ run_configuration: resolved, variant: 'full' }), 'full')
  assert.throws(() => specExecution({ run_configuration: resolved, variant: 'scout' }), /scout.*full/)
  assert.equal(specExecution({ variant: 'scout' }), 'scout')
  assert.equal(specExecution({}), null)
})

test('run wires the compiled brief into the session row', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-proposal-run-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-proposal-run-home-'))
  const task = 'proposal-run'
  execSync('git init -q', { cwd: checkout })
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# proposal brief\n```proposal\n{"shape":"mechanical","strength":"workhorse"}\n```\n')
  const dbPath = join(home, 'ledger.db')
  const previousLedger = process.env.DEVTEAM_LEDGER_DB
  process.env.DEVTEAM_LEDGER_DB = dbPath
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      runCmd({ task, checkout, 'brief-file': brief, keep: true }, { drive: () => done })
    })
    if (!nodeMeetsLedgerFloor) return
    const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
    try {
      const row = ledger.dumpTable('sessions').find((candidate) => candidate.task_slug === task)
      assert.ok(row)
      assert.equal(row.proposed_shape, 'mechanical')
      assert.equal(row.proposed_strength, 'workhorse')
    } finally { ledger.close() }
  } finally {
    if (previousLedger === undefined) delete process.env.DEVTEAM_LEDGER_DB
    else process.env.DEVTEAM_LEDGER_DB = previousLedger
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('run leaves a malformed proposal unmeasured and completes the driver', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-proposal-malformed-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-proposal-malformed-home-'))
  const task = 'proposal-malformed'
  execSync('git init -q', { cwd: checkout })
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# malformed brief\n```proposal\n{ not json\n```\n')
  const dbPath = join(home, 'ledger.db')
  const previousLedger = process.env.DEVTEAM_LEDGER_DB
  process.env.DEVTEAM_LEDGER_DB = dbPath
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  const stderrSeen = []
  const previousStderrWrite = process.stderr.write
  let drove = 0
  let threw = null
  _resetNoticeGuardsForTest()
  try {
    process.stderr.write = (chunk) => { stderrSeen.push(String(chunk)); return true }
    try {
      await withHome(home, async () => {
        await bootCmd(
          { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
          { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
        )
        try {
          runCmd({ task, checkout, 'brief-file': brief, keep: true }, {
            drive: () => { drove += 1; return done },
          })
        } catch (err) { threw = err }
      })
    } finally { process.stderr.write = previousStderrWrite }
    assert.equal(threw, null)
    assert.equal(drove, 1)
    if (!nodeMeetsLedgerFloor) return
    const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
    try {
      const row = ledger.dumpTable('sessions').find((candidate) => candidate.task_slug === task)
      assert.ok(row)
      assert.equal(row.proposed_shape, null)
      assert.equal(row.proposed_strength, null)
    } finally { ledger.close() }
    assert.match(stderrSeen.join(''), /no readable compiler proposal/)
  } finally {
    process.stderr.write = previousStderrWrite
    if (previousLedger === undefined) delete process.env.DEVTEAM_LEDGER_DB
    else process.env.DEVTEAM_LEDGER_DB = previousLedger
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('run does not backfill historical session proposals', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-proposal-backfill-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-proposal-backfill-home-'))
  const task = 'proposal-backfill'
  const historical = 'historical-proposal-row'
  execSync('git init -q', { cwd: checkout })
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# proposal brief\n```proposal\n{"shape":"mechanical","strength":"workhorse"}\n```\n')
  const dbPath = join(home, 'ledger.db')
  const previousLedger = process.env.DEVTEAM_LEDGER_DB
  process.env.DEVTEAM_LEDGER_DB = dbPath
  const seeded = openLedger({ dbPath, stderr: { write: () => {} } })
  try {
    seeded.startSession({ adw_id: historical, repo_slug: 'r', task_slug: historical })
  } finally { seeded.close() }
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      runCmd({ task, checkout, 'brief-file': brief, keep: true }, { drive: () => done })
    })
    if (!nodeMeetsLedgerFloor) return
    const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
    try {
      const rows = ledger.dumpTable('sessions')
      const oldRow = rows.find((candidate) => candidate.adw_id === historical)
      const newRow = rows.find((candidate) => candidate.task_slug === task)
      assert.ok(oldRow)
      assert.ok(newRow)
      assert.equal(oldRow.proposed_shape, null)
      assert.equal(oldRow.proposed_strength, null)
      assert.equal(newRow.proposed_shape, 'mechanical')
      assert.equal(newRow.proposed_strength, 'workhorse')
      const proposedRows = rows.filter((row) => row.proposed_shape !== null || row.proposed_strength !== null)
      assert.equal(proposedRows.length, 1)
      assert.equal(proposedRows[0].adw_id, newRow.adw_id)
    } finally { ledger.close() }
  } finally {
    if (previousLedger === undefined) delete process.env.DEVTEAM_LEDGER_DB
    else process.env.DEVTEAM_LEDGER_DB = previousLedger
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('A1: an uncollected keepalive exits at its injected lifetime', { timeout: 10_000 }, async () => {
  const fixture = finalizerChildFixture()
  const env = { ...process.env, [KEEPALIVE_LIFETIME_ENV]: String(KEEPALIVE_LIFETIME_TEST_MS) }
  let child
  let closed = null
  let assertionsPassed = false
  try {
    const startedAt = Date.now()
    child = launchKeepaliveChild(fixture, env)
    await waitForKeepaliveReady(fixture, child)
    closed = await waitForKeepaliveClose(child, KEEPALIVE_EXIT_TIMEOUT_MS)
    assert.ok(closed, 'injected keepalive did not exit naturally before the deadline')
    assert.equal(closed.code, 0)
    assert.equal(closed.signal, null)
    assert.ok(Date.now() - startedAt < KEEPALIVE_EXIT_TIMEOUT_MS)
    assertionsPassed = true
  } finally {
    if (!assertionsPassed && keepaliveChildRunning(child)) {
      try { child.kill('SIGKILL') } catch {}
      await waitForKeepaliveClose(child, KEEPALIVE_CLEANUP_TIMEOUT_MS)
    }
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('B1: a keepalive exits after its parent dies without cleanup', { timeout: 12_000 }, async () => {
  const fixture = finalizerChildFixture()
  const parentFixture = disposableKeepaliveParentFixture(fixture)
  const env = { ...process.env, [KEEPALIVE_LIFETIME_ENV]: String(KEEPALIVE_LIFETIME_TEST_MS) }
  let parent
  let parentClosed = null
  let childPid = null
  let childGone = false
  let assertionsPassed = false
  try {
    parent = rememberKeepaliveError(spawn(process.execPath, [parentFixture.parentScript], {
      env, stdio: ['ignore', 'ignore', 'ignore'],
    }))
    parentClosed = await waitForKeepaliveClose(parent, KEEPALIVE_READY_TIMEOUT_MS + KEEPALIVE_EXIT_TIMEOUT_MS)
    assert.ok(parentClosed, 'disposable parent did not exit before the deadline')
    assert.equal(parent._keepaliveError, null)
    assert.equal(parentClosed.code, 0)
    assert.equal(parentClosed.signal, null)
    childPid = readKeepalivePid(parentFixture.pidPath)
    assert.ok(childPid, 'disposable parent left an empty or invalid child PID')
    childGone = await waitForKeepaliveProcessGone(childPid, KEEPALIVE_EXIT_TIMEOUT_MS)
    assert.equal(childGone, true, `recorded child PID ${childPid} remained live after its parent exited`)
    assertionsPassed = true
  } finally {
    if (!assertionsPassed) {
      if (keepaliveChildRunning(parent)) {
        try { parent.kill('SIGKILL') } catch {}
        await waitForKeepaliveClose(parent, KEEPALIVE_CLEANUP_TIMEOUT_MS)
      }
      if (childPid && probeKeepaliveProcess(childPid) !== false) {
        try { process.kill(childPid, 'SIGKILL') } catch {}
      }
    }
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('C1: the default lifetime outlasts normal fixture observation', { timeout: 10_000 }, async () => {
  const fixture = finalizerChildFixture()
  const env = { ...process.env }
  delete env[KEEPALIVE_LIFETIME_ENV]
  let child
  let assertionsPassed = false
  try {
    child = launchKeepaliveChild(fixture, env)
    await waitForKeepaliveReady(fixture, child)
    const deadline = Date.now() + KEEPALIVE_OBSERVATION_WINDOW_MS
    let observations = 0
    while (Date.now() < deadline) {
      assert.equal(child._keepaliveError, null)
      assert.equal(child.exitCode, null)
      assert.equal(child.signalCode, null)
      observations += 1
      await new Promise((resolve) => setTimeout(resolve, KEEPALIVE_POLL_MS))
    }
    assert.ok(observations > 0)
    assert.equal(child.kill('SIGTERM'), true)
    const closed = await waitForKeepaliveClose(child, KEEPALIVE_CLEANUP_TIMEOUT_MS)
    assert.ok(closed, 'ordinary SIGTERM cleanup did not close the child')
    assert.equal(closed.code, 143)
    assert.equal(closed.signal, null)
    assertionsPassed = true
  } finally {
    if (!assertionsPassed && keepaliveChildRunning(child)) {
      try { child.kill('SIGKILL') } catch {}
      await waitForKeepaliveClose(child, KEEPALIVE_CLEANUP_TIMEOUT_MS)
    }
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('D1: all five generated keepalive sites use the same self-exit bound', () => {
  const sources = [
    ['./crew.test.mjs', 3],
    ['./headless-rpc.test.mjs', 1],
    ['./daemon.test.mjs', 1],
  ]
  const defaultDeclaration = 'const KEEPALIVE_LIFETIME_DEFAULT_MS = 300_000'
  const envDeclaration = `const KEEPALIVE_LIFETIME_ENV = '${KEEPALIVE_LIFETIME_ENV}'`
  for (const [file, expectedCount] of sources) {
    const source = readKeepaliveSource(file).replaceAll(String.raw`\n`, '\n')
    const lines = source.split('\n').map((line) => line.trim())
    assert.equal(lines.filter((line) => line === defaultDeclaration).length, 1, `${file} must declare the shared default once`)
    assert.equal(lines.filter((line) => line === envDeclaration).length, 1, `${file} must declare the shared environment name once`)
    const intervalIndexes = lines.flatMap((line, index) => line.includes(KEEPALIVE_INTERVAL) ? [index] : [])
    assert.equal(intervalIndexes.length, expectedCount, `${file} must contain exactly its in-scope keepalive sites`)
    for (const index of intervalIndexes) {
      assert.ok(lines[index - 1]?.includes(KEEPALIVE_TIMER_STATEMENT), `${file}:${index + 1} must put the shared timer directly before its keepalive`)
    }
  }
})

test('E1: the existing parent finally cleanup still collects a live child', { timeout: 10_000 }, async () => {
  const fixture = finalizerChildFixture()
  const env = { ...process.env }
  delete env[KEEPALIVE_LIFETIME_ENV]
  const cleanup = { delivered: null, closed: null }
  let child
  let forcedError = null
  let assertionsPassed = false
  try {
    try {
      child = launchKeepaliveChild(fixture, env)
      await waitForKeepaliveReady(fixture, child)
      throw new Error('force parent finally cleanup')
    } catch (error) {
      forcedError = error
    } finally {
      if (child) {
        const cleanupDelivered = child.kill('SIGKILL')
        cleanup.delivered = cleanupDelivered
        cleanup.closed = await waitForKeepaliveClose(child, KEEPALIVE_CLEANUP_TIMEOUT_MS)
      }
    }
    assert.equal(forcedError?.message, 'force parent finally cleanup')
    assert.equal(cleanup.delivered, true)
    assert.ok(cleanup.closed, 'parent finally cleanup did not close the child before its deadline')
    assert.equal(cleanup.closed.signal, 'SIGKILL')
    assertionsPassed = true
  } finally {
    if (!assertionsPassed && keepaliveChildRunning(child)) {
      try { child.kill('SIGKILL') } catch {}
      await waitForKeepaliveClose(child, KEEPALIVE_CLEANUP_TIMEOUT_MS)
    }
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('ZFA1', async () => {
  const result = await runFinalizerChild()
  assert.equal(result.sessions.length, 1)
  assert.notEqual(result.sessions[0].status, 'running')
  assert.equal(result.endRows.length, 1)
})

test('ZFR1', async () => {
  const result = await runFinalizerChild()
  assert.equal(result.sessions.length, 1)
  assert.equal(result.sessions[0].terminal_reason, 'SIGTERM')
})

test('ZFA2', async () => {
  const result = await runFinalizerChild()
  assert.equal(result.ready.adw_id, result.sidecar.adw_id)
  assert.equal(result.sessions.length, 1)
  assert.equal(result.sessions[0].adw_id, result.sidecar.adw_id)
  assert.equal(result.sessions[0].terminal_actor, 'finalizer')
  const seam = await runCmdEmitterProbe()
  assert.equal(seam.opened, 1)
  assert.equal(seam.started.starts, 1)
  assert.strictEqual(seam.handed, seam.started)
})

test('ZFC1', async () => {
  const result = await runFinalizerChild()
  assert.equal(result.stdout, '{"status":"exited","signal":"SIGTERM"}\n')
})

test('ZFC2', async () => {
  const result = await runFinalizerChild()
  assert.equal(result.code, 143)
  assert.equal(result.signal, null)
})

test('ZFG1', async () => {
  const seam = await runCmdEmitterProbe()
  assert.equal(seam.opened, 1)
  assert.equal(seam.started.starts, 1)
  assert.strictEqual(seam.handed, seam.started)
})

test('A1 attended run arms its own ledger finalizer', async () => {
  const seam = await runCmdEmitterProbe()
  assert.equal(seam.opened, 1)
  assert.equal(seam.started.starts, 1)
  assert.strictEqual(seam.handed, seam.started)
  assert.equal(seam.handed.adwId, seam.started.adwId)
})

test('crew CLI reads the closed variant set from drive.mjs without quoted shape literals', () => {
  const source = readFileSync(new URL('./crew.mjs', import.meta.url), 'utf8')
  const code = source.replace(/\/\/[^\n]*/g, '')
  for (const name of VARIANT_NAMES) {
    assert.doesNotMatch(code, new RegExp("(['\"`])" + name + "\\1"))
  }
  assert.match(source, /import\s*\{[^}]*VARIANT_NAMES[^}]*DEFAULT_VARIANT[^}]*\}\s*from '\.\/drive\.mjs'/)
})

test('boot wiring places the definition band check before the breaker', () => {
  const source = readFileSync(new URL('./crew.mjs', import.meta.url), 'utf8')
  const seatFloors = source.indexOf('assertBandFloors(seats, tierName,')
  const breaker = source.indexOf('assertCellsClosed(breaker)')
  assert.ok(seatFloors >= 0)
  assert.ok(breaker > seatFloors)
  const sites = [...source.matchAll(/assertDefBandFloors\(/g)].map((match) => match.index)
  assert.equal(sites.filter((index) => index > seatFloors && index < breaker).length, 1)
})

test('source tripwire names crew/daemon.mjs paneSeat and its pane refusal', () => {
  const daemonSource = readFileSync(new URL('./daemon.mjs', import.meta.url), 'utf8')
  assert.match(daemonSource, /daemon run refuses pane transport/)
  assert.match(daemonSource, /function paneSeat/)
  const testSource = readFileSync(new URL('./crew.test.mjs', import.meta.url), 'utf8')
  assert.match(testSource, /daemon\.mjs/)
  assert.match(testSource, /paneSeat/)
})

test('teardownCore skips all cmux closes without a workspace and still closes a real workspace', () => {
  const parent = mkdtempSync(join(tmpdir(), 'crew-teardown-'))
  const closeSurface = callCounter(); const closeWorkspace = callCounter()
  try {
    const dir = join(parent, 'headless')
    mkdirSync(dir, { recursive: true })
    const paths = { dir }
    const { archived } = teardownCore(paths, { workspace_id: null, members: { builder: { surface_id: null } } }, { closeSurface, closeWorkspace })
    assert.equal(existsSync(archived), true)
    assert.equal(closeSurface.calls.length, 0)
    assert.equal(closeWorkspace.calls.length, 0)

    const paned = join(parent, 'paned')
    mkdirSync(paned, { recursive: true })
    const { archived: second } = teardownCore({ dir: paned }, { workspace_id: 'workspace-1', members: { lead: { surface_id: null } } }, { closeSurface, closeWorkspace })
    assert.equal(existsSync(second), true)
    assert.equal(closeWorkspace.calls.length, 1)
    assert.deepEqual(closeWorkspace.calls[0], ['workspace-1'])
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

test('teardownCore captures the in-flight set before the first close', () => {
  const result = runTeardownDrainFixture({
    assignments: [{ id: 'd1', role: 'builder' }],
    closeSurface: (_id, { returnsDir }) => writeFileSync(join(returnsDir, 'd1.builder.json'), '{"status":"done"}'),
  })
  assert.equal(result.rows.length, 1)
  assert.deepEqual(result.rows[0].abandoned, [{ id: 'd1', role: 'builder', return: 'returns/d1.builder.json' }])
})

test('the drain row names every assignment that never returned', () => {
  const result = runTeardownDrainFixture({
    assignments: [{ id: 'd1', role: 'planner' }, { id: 'd2', role: 'builder' }],
    returned: [{ id: 'd1', role: 'planner' }],
  })
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].inflight, 1)
  assert.equal(result.rows[0].drained, 0)
  assert.deepEqual(result.rows[0].abandoned, [{ id: 'd2', role: 'builder', return: 'returns/d2.builder.json' }])
})

test('an empty in-flight set gets no drain row', () => {
  const returned = runTeardownDrainFixture({
    assignments: [{ id: 'd1', role: 'planner' }, { id: 'd2', role: 'builder' }],
    returned: [{ id: 'd1', role: 'planner' }, { id: 'd2', role: 'builder' }],
  })
  assert.equal(returned.rows.length, 0)
  const empty = runTeardownDrainFixture()
  assert.equal(empty.rows.length, 0)
  const positive = runTeardownDrainFixture({ assignments: [{ id: 'd1', role: 'builder' }] })
  assert.equal(positive.rows.length, 1)
})

test('work that settles inside the bound is distinguishable from work that was abandoned', () => {
  const settled = runTeardownDrainFixture({
    assignments: [{ id: 'd1', role: 'builder' }],
    sleep: (_ms, { returnsDir }) => writeFileSync(join(returnsDir, 'd1.builder.json'), '{"status":"done"}'),
  })
  const abandoned = runTeardownDrainFixture({ assignments: [{ id: 'd1', role: 'builder' }] })
  assert.equal(settled.rows.length, 1)
  assert.equal(settled.rows[0].drained, 1)
  assert.deepEqual(settled.rows[0].abandoned, [])
  assert.equal(abandoned.rows.length, 1)
  assert.deepEqual(abandoned.rows[0].abandoned, [{ id: 'd1', role: 'builder', return: 'returns/d1.builder.json' }])
})

test('the normal path takes 60s and the error path 10s', () => {
  assert.equal(TEARDOWN_DRAIN_MS, 60_000)
  assert.equal(TEARDOWN_DRAIN_ERROR_MS, 10_000)
  const normal = runTeardownDrainFixture({ assignments: [{ id: 'd1', role: 'builder' }], taskStatus: 'done' })
  assert.equal(normal.rows.length, 1)
  assert.equal(normal.rows[0].budget_ms, 60_000)
  assert.equal(normal.rows[0].error_path, false)
  const error = runTeardownDrainFixture({ assignments: [{ id: 'd1', role: 'builder' }] })
  assert.equal(error.rows.length, 1)
  assert.equal(error.rows[0].budget_ms, 10_000)
  assert.equal(error.rows[0].error_path, true)
})

test('the drain is bounded in wall clock, not in polls', () => {
  let clock = 0
  const result = runTeardownDrainFixture({
    assignments: [{ id: 'd1', role: 'builder' }],
    now: () => { clock += 600_000; return clock },
  })
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].polls <= 2, true)
  assert.deepEqual(result.rows[0].abandoned, [{ id: 'd1', role: 'builder', return: 'returns/d1.builder.json' }])
})

test('a drain fault never escapes teardownCore', () => {
  const result = runTeardownDrainFixture({
    assignments: [{ id: 'd1', role: 'builder' }],
    now: () => { throw new Error('injected clock fault') },
  })
  assert.equal(typeof result.record.archived, 'string')
  assert.equal(result.record.seats.proven, 1)
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].error, 'injected clock fault')
})

test('teardown still archives, sweeps and reports absence with a drain row present', () => {
  const result = runTeardownDrainFixture({
    assignments: [{ id: 'd1', role: 'builder' }],
    members: { builder: { surface_id: null, transport: 'headless-rpc' } },
  })
  assert.equal(typeof result.record.archived, 'string')
  assert.equal(result.record.seats, null)
  assert.equal(result.record.seats_absent, TEARDOWN_ABSENT_CAUSES.headless)
  assert.equal(result.rows.length, 1)
})

test('assignmentsFromJournal restarts at run-start and answers null for an unreadable journal', () => {
  const parent = scratchDir('crew-assignments-journal-')
  const path = join(parent, 'journal.jsonl')
  try {
    writeFileSync(path, [
      JSON.stringify({ event: RUN_START_EVENT }),
      JSON.stringify({ assign: 'd-old', role: 'builder' }),
      JSON.stringify({ event: RUN_START_EVENT }),
      JSON.stringify({ assign: 'd2', role: 'builder' }),
      JSON.stringify({ assign: 'd3', role: 'planner' }),
    ].join('\n'))
    assert.deepEqual(assignmentsFromJournal(path), [
      { id: 'd2', role: 'builder' },
      { id: 'd3', role: 'planner' },
    ])
    assert.equal(assignmentsFromJournal(join(parent, 'missing.jsonl')), null)
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

test('paneTeardownRows maps only positive death evidence to proven', () => {
  const crew = { members: {
    planner: { surface_id: 's-planner', transport: 'pane' },
    builder: { surface_id: 's-builder', transport: 'pane' },
    reviewer: { surface_id: 's-reviewer', transport: 'pane' },
    lead: { surface_id: null, transport: 'headless-rpc' },
  } }
  const probes = { 's-planner': false, 's-builder': true, 's-reviewer': null }
  const rows = paneTeardownRows(crew, { probe: (id) => probes[id], sleep: () => {} })
  assert.deepEqual(rows, [
    { role: 'planner', transport: 'pane', outcome: 'proven', reason: 'probe-dead', forced: false },
    { role: 'builder', transport: 'pane', outcome: 'failed', reason: 'probe-alive', forced: false },
    { role: 'reviewer', transport: 'pane', outcome: 'unproven', reason: 'probe-unknown', forced: false },
  ])
  assert.equal(rows.some((row) => row.role === 'lead'), false)
})

test('paneTeardownRows probes through the real paneAlive by default', () => {
  const live = paneTeardownRows({ members: { builder: { surface_id: 's-builder', transport: 'pane' } } }, {
    tree: () => ({ windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: 's-builder' }] }] }] }] }),
    locate: (_tree, id) => id === 's-builder' ? { id } : null,
    sleep: () => {}, polls: 2, intervalMs: 0,
  })
  assert.deepEqual(live[0], { role: 'builder', transport: 'pane', outcome: 'failed', reason: 'probe-alive', forced: false })

  const blind = paneTeardownRows({ members: { builder: { surface_id: 's-builder', transport: 'pane' } } }, {
    tree: () => { throw new Error('cmux unavailable') }, sleep: () => {}, polls: 2, intervalMs: 0,
  })
  assert.deepEqual(blind[0], { role: 'builder', transport: 'pane', outcome: 'unproven', reason: 'probe-unknown', forced: false })

  const gone = paneTeardownRows({ members: { builder: { surface_id: 's-builder', transport: 'pane' } } }, {
    tree: () => ({ windows: [] }), locate: () => null, sleep: () => {}, polls: 2, intervalMs: 0,
  })
  assert.deepEqual(gone[0], { role: 'builder', transport: 'pane', outcome: 'proven', reason: 'probe-dead', forced: false })
})

test('paneTeardownRows re-probes a bounded window before calling a seat failed', () => {
  const sequence = [true, false]
  let calls = 0
  const waits = []
  const settled = paneTeardownRows({ members: { builder: { surface_id: 's-builder', transport: 'pane' } } }, {
    probe: () => { calls += 1; return sequence.shift() }, sleep: (ms) => waits.push(ms),
  })
  assert.equal(settled[0].outcome, 'proven')
  assert.equal(calls, 2)
  assert.deepEqual(waits, [PANE_SETTLE_MS])

  let stubborn = 0
  const stubbornWaits = []
  const alive = paneTeardownRows({ members: { builder: { surface_id: 's-builder', transport: 'pane' } } }, {
    probe: () => { stubborn += 1; return true }, sleep: (ms) => stubbornWaits.push(ms),
  })
  assert.equal(alive[0].outcome, 'failed')
  assert.equal(stubborn, PANE_SETTLE_POLLS)
  assert.deepEqual(stubbornWaits, Array(PANE_SETTLE_POLLS - 1).fill(PANE_SETTLE_MS))
})

test('teardownCore records one seat_teardowns row per pane seat it closed', () => {
  const parent = mkdtempSync(join(tmpdir(), 'crew-teardown-record-'))
  const dir = join(parent, 'crew')
  mkdirSync(dir, { recursive: true })
  const emitted = []
  const journal = []
  try {
    const record = teardownCore({ dir }, { members: {
      planner: { surface_id: 's-planner', transport: 'pane' },
      builder: { surface_id: 's-builder', transport: 'pane' },
    } }, {
      closeSurface: () => true, closeWorkspace: () => true, renameSync: () => {},
      probe: () => false, sleep: () => {},
      io: { log: (row) => journal.push(row), emit: (event) => { emitted.push(event); return true } },
    })
    assert.deepEqual({ seats: record.seats.seats, proven: record.seats.proven, recorded: record.seats.recorded, record_failed: record.seats.record_failed }, { seats: 2, proven: 2, recorded: 2, record_failed: 0 })
    assert.deepEqual(emitted.map((event) => event.kind), ['seat-teardown', 'seat-teardown'])
    assert.deepEqual(emitted.map((event) => event.role).sort(), ['builder', 'planner'])
    assert.equal(journal.filter((row) => row.event === 'seat-teardown').length, 2)
    assert.equal(journal.filter((row) => row.event === 'seat-teardown-sweep').length, 1)
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

test('teardownCore probes after every close and before the archive', () => {
  const order = []
  const record = teardownCore({ dir: join(tmpdir(), 'crew-teardown-order-unused') }, { members: {
    planner: { surface_id: 's-planner', transport: 'pane' },
    builder: { surface_id: 's-builder', transport: 'pane' },
  } }, {
    closeSurface: (id) => { order.push(`close:${id}`) }, closeWorkspace: () => {},
    probe: (id) => { order.push(`probe:${id}`); return false }, sleep: () => {},
    renameSync: () => { order.push('rename') }, io: { log: () => {}, emit: () => true },
  })
  assert.equal(typeof record.archived, 'string')
  const probes = order.map((entry, index) => [entry, index]).filter(([entry]) => entry.startsWith('probe:')).map(([, index]) => index)
  const closes = order.map((entry, index) => [entry, index]).filter(([entry]) => entry.startsWith('close:')).map(([, index]) => index)
  assert.equal(probes.length, 2)
  assert.equal(closes.length, 2)
  assert.ok(Math.max(...closes) < Math.min(...probes))
  assert.ok(order.indexOf('rename') > Math.max(...probes))
})

test('teardownCore reports no pane sweep for a crew with no pane seat', () => {
  const parent = mkdtempSync(join(tmpdir(), 'crew-teardown-headless-'))
  const dir = join(parent, 'crew')
  mkdirSync(dir, { recursive: true })
  const journal = []
  try {
    const record = teardownCore({ dir }, { members: {
      builder: { surface_id: null, transport: 'headless-rpc' },
    } }, {
      closeSurface: () => true, closeWorkspace: () => {}, renameSync: () => {},
      probe: () => { throw new Error('surface-less seat must not be probed') },
      io: { log: (row) => journal.push(row), emit: () => true },
    })
    assert.equal(record.seats, null)
    assert.equal(record.seats_absent, TEARDOWN_ABSENT_CAUSES.headless)
    const absent = journal.filter((row) => row.event === 'seat-teardown-absent')
    assert.equal(absent.length, 1)
    assert.equal(absent[0].cause, TEARDOWN_ABSENT_CAUSES.headless)
    assert.equal(journal.some((row) => row.event === 'seat-teardown-sweep'), false)
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

test('teardownAbsentCause discriminates the three absences', () => {
  const headless = teardownAbsentCause({ members: { builder: { surface_id: null, transport: 'headless-rpc' } } })
  const surfaceUnrecorded = teardownAbsentCause({ members: { builder: { surface_id: null, transport: 'pane' } } })
  const transportUnrecorded = teardownAbsentCause({ members: { builder: { surface_id: null } } })
  const noMembers = teardownAbsentCause({ members: {} })
  assert.equal(headless, TEARDOWN_ABSENT_CAUSES.headless)
  assert.equal(surfaceUnrecorded, TEARDOWN_ABSENT_CAUSES.surface_unrecorded)
  assert.equal(transportUnrecorded, TEARDOWN_ABSENT_CAUSES.surface_unrecorded)
  assert.equal(noMembers, TEARDOWN_ABSENT_CAUSES.no_members)
  assert.equal(new Set(Object.values(TEARDOWN_ABSENT_CAUSES)).size, 3)
})

test('teardownCmd exits TEARDOWN_EXIT_SEATLESS when it measured no seat', async () => {
  const home = scratchDir('crew-teardown-seatless-home-')
  const { root: checkoutRoot, checkout } = testCheckout('crew-teardown-seatless-checkout-')
  const task = 'teardown-seatless'
  const dir = testCrewDir(home, checkout, task)
  mkdirSync(join(dir, 'returns'), { recursive: true })
  mkdirSync(join(dir, 'task'), { recursive: true })
  writeFileSync(join(dir, 'crew.json'), JSON.stringify({
    schema_version: 3, task, checkout, workspace_id: null, roles: ['builder'],
    members: { builder: { surface_id: null, pane_id: null, transport: 'headless-rpc' } },
    task_return: join(dir, 'returns', 'task.json'),
  }, null, 2))
  const dbPath = join(home, 'ledger.db')
  const previousDb = process.env.DEVTEAM_LEDGER_DB
  const savedExit = process.exitCode
  const stdoutWrite = process.stdout.write
  let output = ''
  try {
    process.env.DEVTEAM_LEDGER_DB = dbPath
    process.exitCode = undefined
    process.stdout.write = (chunk) => { output += String(chunk); return true }
    let record
    await withHome(home, () => {
      record = teardownCmd({ task, checkout }, {
        closeSurface: () => true, closeWorkspace: () => true, probe: () => { throw new Error('surface-less seat must not be probed') }, sleep: () => {},
      })
    })
    const payload = JSON.parse(output.trim())
    assert.equal(record.seats, null)
    assert.equal(record.seats_absent, TEARDOWN_ABSENT_CAUSES.headless)
    assert.equal(payload.seats, null)
    assert.equal(typeof payload.seats_absent, 'string')
    assert.ok(payload.seats_absent.length > 0)
    assert.equal(process.exitCode, TEARDOWN_EXIT_SEATLESS)
  } finally {
    process.stdout.write = stdoutWrite
    process.exitCode = savedExit
    if (previousDb === undefined) delete process.env.DEVTEAM_LEDGER_DB; else process.env.DEVTEAM_LEDGER_DB = previousDb
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('teardownCmd records every pane seat in the ledger and exits 0', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-teardown-ledger-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-teardown-ledger-checkout-')
  const task = 'teardown-ledger'
  const dir = testCrewDir(home, checkout, task)
  mkdirSync(join(dir, 'returns'), { recursive: true })
  mkdirSync(join(dir, 'task'), { recursive: true })
  writeFileSync(join(dir, 'crew.json'), JSON.stringify({
    schema_version: 3, task, checkout, workspace_id: null, roles: ['planner', 'builder'],
    members: {
      planner: { surface_id: 's-planner', transport: 'pane' },
      builder: { surface_id: 's-builder', transport: 'pane' },
    }, task_return: join(dir, 'returns', 'task.json'),
  }, null, 2))
  const dbPath = join(home, 'ledger.db')
  const previousDb = process.env.DEVTEAM_LEDGER_DB
  const savedExit = process.exitCode
  const stdoutWrite = process.stdout.write
  let output = ''
  try {
    process.env.DEVTEAM_LEDGER_DB = dbPath
    process.exitCode = undefined
    process.stdout.write = (chunk) => { output += String(chunk); return true }
    let record
    await withHome(home, () => {
      record = teardownCmd({ task, checkout }, {
        closeSurface: () => true, closeWorkspace: () => true, probe: () => false, sleep: () => {},
      })
    })
    const payload = JSON.parse(output.trim())
    assert.deepEqual({ seats: record.seats.seats, proven: record.seats.proven, recorded: record.seats.recorded }, { seats: 2, proven: 2, recorded: 2 })
    assert.equal(record.seats_absent, null)
    assert.equal(payload.seats_absent, null)
    assert.equal(process.exitCode, undefined)
    assert.equal(existsSync(record.archived), true)
    const sidecar = JSON.parse(readFileSync(join(record.archived, 'ledger', 'run.json'), 'utf8'))
    if (nodeMeetsLedgerFloor) {
      const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
      let rows
      try { rows = ledger.dumpTable('seat_teardowns') } finally { ledger.close() }
      assert.equal(rows.length, 2)
      assert.ok(rows.every((row) => row.adw_id === sidecar.adw_id && row.outcome === 'proven' && row.transport === 'pane'))
    }
  } finally {
    process.stdout.write = stdoutWrite
    process.exitCode = savedExit
    if (previousDb === undefined) delete process.env.DEVTEAM_LEDGER_DB; else process.env.DEVTEAM_LEDGER_DB = previousDb
    rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('teardownCmd exits non-zero without proof of death or without a positive receipt', async () => {
  const branches = [
    { label: 'unproven', probe: () => null, key: 'unproven', expectedProven: 0, io: null },
    { label: 'failed', probe: () => true, key: 'failed', expectedProven: 0, io: null },
    { label: 'record-failed', probe: () => false, key: 'proven', expectedProven: 2, io: { log: () => {}, emit: () => false } },
  ]
  for (const branch of branches) {
    const home = mkdtempSync(join(tmpdir(), `crew-teardown-${branch.label}-home-`))
    const { root: checkoutRoot, checkout } = testCheckout(`crew-teardown-${branch.label}-checkout-`)
    const task = `teardown-${branch.label}`
    const dir = testCrewDir(home, checkout, task)
    mkdirSync(join(dir, 'returns'), { recursive: true })
    mkdirSync(join(dir, 'task'), { recursive: true })
    writeFileSync(join(dir, 'crew.json'), JSON.stringify({
      schema_version: 3, task, checkout, workspace_id: null, roles: ['planner', 'builder'],
      members: {
        planner: { surface_id: 's-planner', transport: 'pane' },
        builder: { surface_id: 's-builder', transport: 'pane' },
      }, task_return: join(dir, 'returns', 'task.json'),
    }, null, 2))
    const previousDb = process.env.DEVTEAM_LEDGER_DB
    const savedExit = process.exitCode
    try {
      process.env.DEVTEAM_LEDGER_DB = join(home, 'ledger.db')
      process.exitCode = 0
      let record
      await withHome(home, () => {
        const options = { closeSurface: () => true, closeWorkspace: () => true, probe: branch.probe, sleep: () => {} }
        if (branch.io) options.io = branch.io
        record = teardownCmd({ task, checkout }, options)
      })
      assert.equal(record.seats[branch.key], 2)
      assert.equal(record.seats.proven, branch.expectedProven)
      if (branch.io) {
        assert.equal(record.seats.recorded, 0)
        assert.equal(record.seats.record_failed, 2)
      } else assert.equal(record.seats.recorded, 2)
      assert.equal(process.exitCode, TEARDOWN_EXIT_UNPROVEN)
      assert.notEqual(process.exitCode, TEARDOWN_EXIT_SEATLESS)
    } finally {
      process.exitCode = savedExit
      if (previousDb === undefined) delete process.env.DEVTEAM_LEDGER_DB; else process.env.DEVTEAM_LEDGER_DB = previousDb
      rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true })
    }
  }
})

test('parkOnOutcome escalation parks a workspace-less crew with transport-role fallback keys', () => {
  const calls = []
  const crew = { roles: ['builder'], workspace_id: null, members: { builder: { pane_id: null, surface_id: null, transport: 'headless-rpc' } } }
  const result = parkOnOutcome({ status: 'escalation' }, {
    crew, runId: 'run-headless', dir: '/tmp/reclaim', reason: 'needs human',
    openStore: () => ({ mintPark: (spec) => { calls.push(spec); return { ok: true, park: { park_id: 'park-headless' } } } }),
  })
  assert.equal(result.park_id, 'park-headless')
  assert.equal(result.error, null)
  assert.deepEqual(calls[0].seats, [{ role: 'builder', sessionId: 'headless-rpc:builder', warm: false }])
})

test('the plan viewer mounts window-scoped and never steals focus', () => {
  const args = docOpenArgs({ path: '/tmp/t/plan.md', workspaceId: 'ws-1', windowId: 'win-1' })
  assert.deepEqual(args, ['open', '/tmp/t/plan.md', '--workspace', 'ws-1', '--window', 'win-1', '--direction', 'down', '--focus', 'false'])
})

test('resolveTier(mechanical) seats no lead and carries the builder cell verbatim', () => {
  const r = resolveTier(roster, 'mechanical', {})
  assert.deepEqual(r.roles, ['planner', 'builder', 'reviewer'])
  assert.equal(r.seats.lead, undefined)
  assert.deepEqual(r.seats.builder, { agent: 'pi', effort: 'max', provider: 'openai', id: 'gpt-5.6-luna', model: null })
})

test('resolveTier(judge) seats every role in canonical order, tech-lead last', () => {
  const r = resolveTier(roster, 'judge', {})
  assert.deepEqual(r.roles, ['lead', 'planner', 'builder', 'reviewer', 'tech-lead'])
})

test('fallback schema accepts inherited effort and refuses malformed chain entries', () => {
  const base = { provider: 'openai', id: 'gpt-5.6-sol', agent: 'pi', effort: 'xhigh' }
  assert.deepEqual(fallbackSchemaErrors({ ...base }), [])
  assert.deepEqual(fallbackSchemaErrors({ ...base, fallback: [{ provider: 'anthropic', id: 'claude-opus-5', agent: 'pi' }] }), [])
  assert.deepEqual(fallbackSchemaErrors({ ...base, fallback: [{ provider: 'anthropic', id: 'claude-opus-5', agent: 'pi', effort: 'xhigh' }] }), [])
  for (const omitted of ['provider', 'id', 'agent']) {
    const entry = { provider: 'anthropic', id: 'claude-opus-5', agent: 'pi', effort: 'xhigh' }
    delete entry[omitted]
    assert.notDeepEqual(fallbackSchemaErrors({ ...base, fallback: [entry] }), [])
  }
  assert.notDeepEqual(fallbackSchemaErrors({ ...base, fallback: [] }), [])
  assert.notDeepEqual(fallbackSchemaErrors({ ...base, fallback: [{ provider: 'anthropic', id: 'claude-opus-5', agent: 'pi', effort: 'turbo' }] }), [])
  assert.notDeepEqual(fallbackSchemaErrors({ ...base, fallback: [{ provider: 'anthropic', id: 'claude-opus-5', agent: 'pi', transport: 'headless-json' }] }), [])
})

test('resolveTier carries declared fallback chains and leaves absent keys absent', () => {
  const r = resolveTier(roster, 'judge', {})
  assert.deepEqual(r.seats['tech-lead'].fallback, [{ provider: 'anthropic', id: 'claude-opus-5', agent: 'pi', effort: 'xhigh' }])
  for (const role of ['lead', 'planner', 'builder', 'reviewer']) assert.equal(Object.hasOwn(r.seats[role], 'fallback'), false)
})

test('resolveTier refuses empty, self-referential and cross-agent fallback entries', () => {
  const seat = { provider: 'openai', id: 'gpt-5.6-sol', agent: 'pi', effort: 'xhigh' }
  const rosterFor = (fallback) => ({ tiers: { judge: { 'tech-lead': { ...seat, fallback } } } })
  assert.throws(() => resolveTier(rosterFor([]), 'judge', {}), (err) => err.reason === 'fallback-empty')
  assert.throws(() => resolveTier(rosterFor([{ provider: seat.provider, id: seat.id, agent: 'pi' }]), 'judge', {}), (err) => err.reason === 'fallback-self')
  assert.throws(() => resolveTier(rosterFor([{ provider: 'anthropic', id: 'claude-opus-5', agent: 'claude' }]), 'judge', {}), (err) => err.reason === 'fallback-agent-change')
  const overridden = resolveTier(rosterFor([{ provider: 'anthropic', id: 'claude-opus-5', agent: 'claude' }]), 'judge', { 'agent-tech-lead': 'claude' })
  assert.equal(overridden.seats['tech-lead'].agent, 'claude')
  assert.equal(overridden.seats['tech-lead'].fallback[0].agent, 'claude')
})

test('refuseFallback is a frozen closed set and preserves each declared reason', () => {
  assert.equal(Object.isFrozen(FALLBACK_REFUSALS), true)
  assert.throws(() => refuseFallback('not-real', 'why'), /unknown fallback refusal reason "not-real"/)
  for (const reason of FALLBACK_REFUSALS) {
    const err = refuseFallback(reason, 'why')
    assert.equal(err.reason, reason)
    assert.match(err.message, new RegExp(`\\[${reason}\\]$`))
  }
})

test('resolveTier: per-seat flags override the roster cell and stay distinguishable from roster values', () => {
  const r = resolveTier(roster, 'build', { 'model-builder': 'raw-id', 'agent-builder': 'claude', 'effort-builder': 'max' })
  assert.equal(r.seats.builder.model, 'raw-id')
  assert.equal(r.seats.builder.agent, 'claude')
  assert.equal(r.seats.builder.effort, 'max')
  assert.deepEqual(r.sources.builder, { agent: 'override', model: 'override', effort: 'override' })
  assert.equal(r.sources.planner.model, 'roster')
})

test('resolveTier: an unknown tier throws naming the bad tier and the valid ones', () => {
  assert.throws(
    () => resolveTier(roster, 'nope', {}),
    (err) => /nope/.test(err.message) && ['mechanical', 'build', 'judge'].every((t) => err.message.includes(t)),
  )
})

test('resolveTier: an override naming a role the tier does not seat throws, naming the flag and the tier', () => {
  assert.throws(
    () => resolveTier(roster, 'mechanical', { 'model-lead': 'x' }),
    (err) => /model-lead/.test(err.message) && /mechanical/.test(err.message),
  )
})

 test('roster v1 normalises to byte-equivalent seats and exposes both views', () => {
  const normalized = normalizeRoster(rosterFixtures().v1)
  for (const tier of Object.keys(roster.tiers)) {
    assert.equal(JSON.stringify(resolveTier(normalized, tier)), JSON.stringify(resolveTier(roster, tier)))
  }
  assert.deepEqual(Object.keys(normalized.tiers), Object.keys(roster.tiers))
  assert.deepEqual(Object.keys(normalized.assurances), Object.keys(ASSURANCE_ALIAS_OF))
})

test('canonical assurance spellings seat the legacy tiers', () => {
  const normalized = normalizeRoster(rosterFixtures().v1)
  for (const [canonical, legacy] of Object.entries(ASSURANCE_ALIAS_OF)) {
    assert.equal(JSON.stringify(resolveTier(normalized, canonical)), JSON.stringify(resolveTier(roster, legacy)))
  }
})

test('a v2 roster loads directly with both equivalent views', () => {
  const fixture = rosterFixtures().v2
  const normalized = normalizeRoster(fixture)
  assert.equal(normalized.schema_version, 2)
  for (const [canonical, legacy] of Object.entries(ASSURANCE_ALIAS_OF)) {
    assert.deepEqual(normalized.assurances[canonical], fixture.assurances[canonical])
    assert.deepEqual(normalized.tiers[legacy], fixture.assurances[canonical])
  }
  for (const [canonical, legacy] of Object.entries(ASSURANCE_ALIAS_OF)) {
    assert.equal(JSON.stringify(resolveTier(normalized, canonical)), JSON.stringify(resolveTier(roster, legacy)))
    assert.equal(JSON.stringify(resolveTier(normalized, legacy)), JSON.stringify(resolveTier(roster, legacy)))
  }
})

test('resolveTier reaches both raw roster shapes under both spellings', () => {
  for (const [version, fixture] of fixtureEntries()) {
    for (const [canonical, legacy] of Object.entries(ASSURANCE_ALIAS_OF)) {
      const want = JSON.stringify(resolveTier(roster, legacy))
      assert.equal(JSON.stringify(resolveTier(fixture, legacy)), want, `${version} legacy ${legacy}`)
      assert.equal(JSON.stringify(resolveTier(fixture, canonical)), want, `${version} canonical ${canonical}`)
    }
  }
  const { v1, v2 } = rosterFixtures()
  assert.doesNotThrow(() => resolveTier(v2, 'build'))
  assert.doesNotThrow(() => resolveTier(v1, 'quick'))
})

test('resolveTier compatibility cases hold for v1 and v2 fixtures', () => {
  for (const [version, fixture] of fixtureEntries()) {
    const tier = fixtureTierName(version, 'build')
    const seatedTier = version === 'v1' ? roster.tiers.build : rosterFixtures().v2.assurances.standard
    const overridden = resolveTier(fixture, tier, { 'model-builder': 'raw-id', 'agent-builder': 'claude', 'effort-builder': 'max' })
    assert.equal(overridden.seats.builder.model, 'raw-id')
    assert.equal(overridden.seats.builder.agent, 'claude')
    assert.equal(overridden.seats.builder.effort, 'max')
    assert.deepEqual(overridden.sources.builder, { agent: 'override', model: 'override', effort: 'override' })
    assert.deepEqual(Object.keys(seatedTier).filter((role) => role !== 'builder').sort(), Object.keys(resolveTier(fixture, tier).seats).filter((role) => role !== 'builder').sort())

    const unknownTier = 'nope'
    assert.throws(
      () => resolveTier(fixture, unknownTier, {}),
      (err) => Object.keys(rosterSeating(fixture)).every((name) => err.message.includes(name)),
    )
    const absentTier = fixtureTierName(version, 'mechanical')
    assert.throws(
      () => resolveTier(fixture, absentTier, { 'model-lead': 'x' }),
      (err) => /model-lead/.test(err.message) && err.message.includes(absentTier),
    )
  }
})

test('declared fallback chain survives both roster paths', () => {
  for (const [version, fixture] of fixtureEntries()) {
    const tier = fixtureTierName(version, 'judge')
    const resolved = resolveTier(fixture, tier)
    assert.deepEqual(resolved.seats['tech-lead'].fallback, seatedJudgeTechLeadFallback)
  }
  assert.ok(seatedBuildReviewer)
})

test('malformed fallback fixtures keep their shape refusals on both paths', () => {
  for (const [version, fixture] of fixtureEntries()) {
    const tier = fixtureTierName(version, 'judge')
    const malformed = (fallback) => fixtureWithCells(fixture, version, 'judge', { 'tech-lead': { ...seatedBuildReviewer, fallback } })
    assert.throws(() => resolveTier(malformed([]), tier), (err) => err.reason === 'fallback-empty')
    assert.throws(() => resolveTier(malformed([{ provider: seatedBuildReviewer.provider, id: seatedBuildReviewer.id, agent: seatedBuildReviewer.agent }]), tier), (err) => err.reason === 'fallback-self')
    assert.throws(() => resolveTier(malformed([{ provider: 'other-vendor', id: 'other-model', agent: 'claude' }]), tier), (err) => err.reason === 'fallback-agent-change')
    const overridden = resolveTier(malformed([{ provider: 'other-vendor', id: 'other-model', agent: 'claude' }]), tier, { 'agent-tech-lead': 'claude' })
    assert.equal(overridden.seats['tech-lead'].agent, 'claude')
    assert.equal(overridden.seats['tech-lead'].fallback[0].agent, 'claude')
  }
})

test('refuseRoster is frozen and closed at construction', () => {
  assert.equal(Object.isFrozen(ROSTER_REFUSALS), true)
  assert.deepEqual([...ROSTER_SCHEMA_VERSIONS], [1, 2])
  assert.throws(() => refuseRoster('not-real', 'why'), /unknown roster refusal reason "not-real"/)
  for (const reason of ROSTER_REFUSALS) {
    const err = refuseRoster(reason, 'why')
    assert.equal(err.reason, reason)
    assert.match(err.message, new RegExp(`\\[${reason}\\]$`))
  }
})

test('each roster refusal has its own malformed input', () => {
  const { v1, v2 } = rosterFixtures()
  const reasonOf = (document) => {
    try { normalizeRoster(document); return null } catch (err) { return err.reason }
  }
  const cases = [
    [{ ...v2, tiers: [] }, 'roster-seating-both'],
    [{ ...v1, assurances: null }, 'roster-seating-both'],
    [{ ...v1, tiers: [] }, 'roster-seating-invalid'],
    [{ ...v2, assurances: 'rigorous' }, 'roster-seating-invalid'],
    [{ ...v1, tiers: { mechanical: v1.tiers.mechanical, build: v1.tiers.build } }, 'roster-seating-incomplete'],
    [{ schema_version: 1, models: v1.models }, 'roster-seating-absent'],
  ]
  for (const [document, expected] of cases) assert.equal(reasonOf(document), expected)
  assert.equal(reasonOf({ ...v1, schema_version: 2 }), 'roster-version-mismatch')
  assert.equal(reasonOf({ ...v1, schema_version: 3 }), 'roster-version-unknown')
  assert.equal(reasonOf({ ...v1, tiers: v2.assurances }), 'roster-seating-unknown')
})

test('loadRoster normalises v1 and v2 files at the boundary', () => {
  const dir = scratchDir('crew-roster-load-')
  try {
    const v1Path = join(dir, 'v1.json')
    const v2Path = join(dir, 'v2.json')
    const badPath = join(dir, 'bad.json')
    writeFileSync(v1Path, JSON.stringify(rosterFixtures().v1, null, 2))
    writeFileSync(v2Path, JSON.stringify(rosterFixtures().v2, null, 2))
    writeFileSync(badPath, JSON.stringify({ ...roster, schema_version: 2 }, null, 2))
    const loadedV1 = loadRoster(v1Path)
    const loadedV2 = loadRoster(v2Path)
    assert.equal(loadedV1.schema_version, 1)
    assert.equal(loadedV2.schema_version, 2)
    assert.equal(JSON.stringify(resolveTier(loadedV1, 'quick')), JSON.stringify(resolveTier(roster, 'mechanical')))
    assert.equal(JSON.stringify(resolveTier(loadedV2, 'rigorous')), JSON.stringify(resolveTier(roster, 'judge')))
    assert.throws(() => loadRoster(badPath), (err) => err.reason === 'roster-version-mismatch')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('rosterSourcePath lets a supplied path win while preserving the runtime default', () => {
  assert.equal(rosterSourcePath({}, '/runtime/crew'), join('/runtime/crew', 'roster.json'))
  assert.equal(rosterSourcePath({ roster: '/dispatch/crew/roster.json' }, '/runtime/crew'), '/dispatch/crew/roster.json')
  assert.equal(rosterSourcePath({ roster: '   ' }, '/runtime/crew'), join('/runtime/crew', 'roster.json'))
})

test('loadRosterSource reads once and derives parsed roster and provenance from the same bytes', () => {
  const bytesA = Buffer.from(JSON.stringify(rosterFixtures().v1))
  const bytesB = Buffer.from(JSON.stringify({ ...rosterFixtures().v1, updated_at: 'decoy' }))
  let reads = 0
  const source = loadRosterSource('/dispatch/crew/roster.json', { roster: '/dispatch/crew/roster.json' }, {
    readFile: () => { reads += 1; return reads === 1 ? bytesA : bytesB },
  })
  assert.equal(reads, 1)
  assert.equal(source.roster.updated_at, roster.updated_at)
  assert.equal(source.record.origin, 'flag')
  assert.equal(source.record.path, '/dispatch/crew/roster.json')
  assert.equal(source.record.sha256, createHash('sha256').update(bytesA).digest('hex'))
  assert.equal(source.record.bytes.equals(bytesA), true)
})

test('writeRosterSnapshot copies the boot bytes into the state directory', () => {
  const dir = scratchDir('crew-roster-snapshot-')
  const bytes = Buffer.from('{"snapshot":true}')
  const path = writeRosterSnapshot({ dir }, { bytes })
  assert.equal(path, join(dir, 'roster.snapshot.json'))
  assert.equal(readFileSync(path).equals(bytes), true)
})

test('rosterSnapshotReader normalises v1 and v2 snapshots for reseating', () => {
  const dir = scratchDir('crew-roster-snapshot-reader-')
  const v1Path = join(dir, 'v1.json')
  const v2Path = join(dir, 'v2.json')
  writeFileSync(v1Path, JSON.stringify(rosterFixtures().v1))
  writeFileSync(v2Path, JSON.stringify(rosterFixtures().v2))
  for (const [path, expected] of [[v1Path, roster.tiers.judge.planner.id], [v2Path, rosterFixtures().v2.assurances.rigorous.planner.id]]) {
    const read = rosterSnapshotReader({ roster: { snapshot: path } })
    const loaded = read()
    assert.equal(loaded.tiers.judge.planner.id, expected)
    assert.ok(loaded.tiers.mechanical && loaded.tiers.build)
  }
})

test('shadowCandidates reads a raw v2 roster', () => {
  const { v1, v2 } = rosterFixtures()
  const fromV1 = shadowCandidates(v1, 'reviewer')
  const fromV2 = shadowCandidates(v2, 'reviewer')
  assert.ok(fromV2.length)
  const legacyView = (rows) => rows.map((row) => ({ ...row, tiers: row.tiers.map((tier) => ASSURANCE_ALIAS_OF[tier] || tier) }))
  assert.deepEqual(legacyView(fromV2), fromV1)
})

test('serializers round-trip seats, preserve policy, and emit a compatibility v1', () => {
  const v1 = rosterFixtures().v1
  const v2 = rosterFixtures().v2
  const roundTrip = normalizeRoster(JSON.parse(serializeRosterV2(v1)))
  for (const [canonical, legacy] of Object.entries(ASSURANCE_ALIAS_OF)) {
    assert.equal(JSON.stringify(resolveTier(roundTrip, canonical)), JSON.stringify(resolveTier(v1, legacy)))
  }
  const v1Document = JSON.parse(serializeRosterV1(v2))
  assert.equal(v1Document.schema_version, 1)
  assert.ok(v1Document.tiers)
  assert.equal(Object.hasOwn(v1Document, 'assurances'), false)
  assert.equal(Object.hasOwn(v1Document, 'policy'), false)
  const policy = { roster_probe: 'ratified-policy' }
  const preserved = JSON.parse(serializeRosterV2({ ...v2, policy }))
  assert.deepEqual(preserved.policy, policy)
  assert.deepEqual(JSON.parse(serializeRosterV2(v1)).policy, {})
})

test('v2 schema validates its root while the old root remains v1', () => {
  const v2 = rosterFixtures().v2
  assert.deepEqual(fallbackSchemaErrors(v2, null, 'roster.v2.schema.json'), [])
  const missingPreset = structuredClone(v2)
  delete missingPreset.assurances.rigorous
  assert.notDeepEqual(fallbackSchemaErrors(missingPreset, null, 'roster.v2.schema.json'), [])
  const missingPolicy = structuredClone(v2)
  delete missingPolicy.policy
  assert.notDeepEqual(fallbackSchemaErrors(missingPolicy, null, 'roster.v2.schema.json'), [])
  assert.deepEqual(fallbackSchemaErrors(roster, null, 'roster.schema.json'), [])
  assert.notDeepEqual(fallbackSchemaErrors({ ...roster, schema_version: 2 }, null, 'roster.schema.json'), [])
})

test('modelString: claude passes the id through; pi namespaces by provider and refuses an unmapped one', () => {
  assert.equal(claudeModelString({ provider: 'anthropic', id: 'claude-opus-5' }), 'claude-opus-5')
  assert.equal(piModelString({ provider: 'openai', id: 'gpt-5.6-luna' }), 'openai-codex/gpt-5.6-luna')
  assert.equal(piModelString({ provider: 'anthropic', id: 'claude-opus-5' }), 'anthropic/claude-opus-5')
  assert.throws(
    () => piModelString({ provider: 'google', id: 'gemini-3-pro' }),
    (err) => /pi/.test(err.message) && /google/.test(err.message),
  )
})

test('resolveSeatModels: a fake adapters map proves translation, raw passthrough, and the no-modelString fallback', () => {
  const seats = {
    a: { agent: 'claude', effort: 'low', provider: 'anthropic', id: 'claude-opus-5', model: null },
    b: { agent: 'claude', effort: 'low', provider: 'anthropic', id: 'raw-passthrough', model: 'already-set' },
    c: { agent: 'claude', effort: 'low', provider: 'anthropic', id: 'bare-fallback', model: null },
  }
  const adapters = {
    a: { name: 'claude', adapter: { modelString: () => 'translated' } },
    b: { name: 'claude', adapter: { modelString: () => { throw new Error('must not be called on an override') } } },
    c: { name: 'claude', adapter: {} }, // no modelString
  }
  const out = resolveSeatModels(seats, adapters)
  assert.equal(out.a.model, 'translated')
  assert.equal(out.a.provider, 'anthropic')
  assert.equal(out.a.id, 'claude-opus-5')
  assert.equal(out.b.model, 'already-set')
  assert.equal(out.b.provider, null)
  assert.equal(out.b.id, null)
  assert.equal(out.c.model, 'bare-fallback')
})

test('resolveSeatModels translates fallback entries with the role adapter and inherits effort', () => {
  const seats = {
    'tech-lead': {
      agent: 'pi', effort: 'high', provider: 'openai', id: 'gpt-5.6-sol', model: null,
      fallback: [{ provider: 'anthropic', id: 'claude-opus-5', agent: 'pi' }],
    },
  }
  const out = resolveSeatModels(seats, {
    'tech-lead': { adapter: { modelString: ({ provider, id }) => `${provider}/${id}` } },
  })
  assert.equal(out['tech-lead'].model, 'openai/gpt-5.6-sol')
  assert.deepEqual(out['tech-lead'].fallback, [{ provider: 'anthropic', id: 'claude-opus-5', agent: 'pi', effort: 'high', model: 'anthropic/claude-opus-5' }])
})

test('resolveSeatModels drops a declared chain behind a raw model override', () => {
  const resolved = resolveTier({ tiers: { judge: { 'tech-lead': {
    provider: 'openai', id: 'gpt-5.6-sol', agent: 'pi', effort: 'xhigh',
    fallback: [{ provider: 'anthropic', id: 'claude-opus-5', agent: 'pi' }],
  } } } }, 'judge', { 'model-tech-lead': 'operator-raw-id' })
  const out = resolveSeatModels(resolved.seats, { 'tech-lead': { adapter: { modelString: () => { throw new Error('must not translate an override') } } } })
  assert.equal(out['tech-lead'].model, 'operator-raw-id')
  assert.equal(Object.hasOwn(out['tech-lead'], 'fallback'), false)
  assert.equal(out['tech-lead'].provider, null)
  assert.equal(out['tech-lead'].id, null)
})

test('resolveSeatModels: a --model-<role> override clears the roster cell it replaced and never guesses a provider (#161)', async () => {
  const claudeMod = await import('./adapters/adapter-claude.mjs')
  const piMod = await import('./adapters/adapter-pi.mjs')
  const resolved = resolveTier(roster, 'build', { 'agent-reviewer': 'claude', 'model-reviewer': 'opus' })
  const adapters = {
    lead: { name: 'claude', adapter: claudeMod },
    planner: { name: 'claude', adapter: claudeMod },
    builder: { name: 'pi', adapter: piMod },
    reviewer: { name: 'claude', adapter: claudeMod },
  }
  const out = resolveSeatModels(resolved.seats, adapters)
  // Effort is read from the roster cell, not pinned as a literal: these tests
  // are about what an OVERRIDE does, and a roster effort change is a policy
  // decision that must not read as a broken override contract.
  assert.deepEqual(out.reviewer, { agent: 'claude', effort: roster.tiers.build.reviewer.effort, provider: null, id: null, model: 'opus' })
  assert.equal(resolved.sources.reviewer.model, 'override')
})

test('resolveSeatModels: an agent-only override keeps the roster cell and translates it (#161)', async () => {
  const claudeMod = await import('./adapters/adapter-claude.mjs')
  const piMod = await import('./adapters/adapter-pi.mjs')
  const resolved = resolveTier(roster, 'build', { 'agent-reviewer': 'claude' })
  const adapters = {
    lead: { name: 'claude', adapter: claudeMod },
    planner: { name: 'claude', adapter: claudeMod },
    builder: { name: 'pi', adapter: piMod },
    reviewer: { name: 'claude', adapter: claudeMod },
  }
  const out = resolveSeatModels(resolved.seats, adapters)
  assert.deepEqual(out.reviewer, {
    agent: 'claude',
    effort: roster.tiers.build.reviewer.effort,
    provider: 'openai',
    id: 'gpt-5.6-sol',
    model: 'gpt-5.6-sol',
  })
})

test('resolveSeatModels end to end through the REAL adapters, on the fixture roster', async () => {
  const claudeMod = await import('./adapters/adapter-claude.mjs')
  const piMod = await import('./adapters/adapter-pi.mjs')
  const { seats } = resolveTier(roster, 'mechanical', {})
  const adapters = {
    planner: { name: 'claude', adapter: claudeMod },
    builder: { name: 'pi', adapter: piMod },
    reviewer: { name: 'pi', adapter: piMod },
  }
  const out = resolveSeatModels(seats, adapters)
  assert.equal(out.builder.model, 'openai-codex/gpt-5.6-luna')
  assert.equal(out.reviewer.model, 'openai-codex/gpt-5.6-sol')
  assert.equal(out.planner.model, 'claude-opus-5')

  const judge = resolveTier(roster, 'judge', {})
  const judgeOut = resolveSeatModels(judge.seats, {
    lead: { name: 'claude', adapter: claudeMod },
    planner: { name: 'claude', adapter: claudeMod },
    builder: { name: 'pi', adapter: piMod },
    reviewer: { name: 'claude', adapter: claudeMod },
    'tech-lead': { name: 'pi', adapter: piMod },
  })
  assert.equal(judgeOut['tech-lead'].model, 'openai-codex/gpt-5.6-sol')
  assert.equal(judgeOut['tech-lead'].fallback[0].model, 'anthropic/claude-opus-5')
  assert.equal(judgeOut['tech-lead'].fallback[0].effort, 'xhigh')
})

test('grantedDefModels reads only pinned defs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-def-models-'))
  const pinned = join(dir, 'pinned.json')
  const bare = join(dir, 'bare.json')
  const bareString = join(dir, 'bare-string.json')
  try {
    writeFileSync(pinned, JSON.stringify({ name: 'pinner', prompt: 'p', model: { provider: 'anthropic', id: 'claude-opus-5' } }))
    writeFileSync(bare, JSON.stringify({ name: 'bare', prompt: 'p' }))
    writeFileSync(bareString, JSON.stringify({ name: 'bare-string', prompt: 'p', model: 'anthropic/claude-opus-5' }))
    const adapters = {
      planner: { adapter: { modelString: piModelString }, grants: { agents: [{ name: 'pinner', def: pinned }, { name: 'bare', def: bare }] } },
      builder: { grants: { agents: [] } },
    }
    assert.deepEqual(grantedDefModels(adapters, { localProviders: {} }), [{
      role: 'planner', agent: 'pinner', path: pinned, model: 'anthropic/claude-opus-5',
    }])
    const bareAdapters = {
      planner: { adapter: { modelString: piModelString }, grants: { agents: [{ name: 'bare-string', def: bareString }] } },
    }
    assert.throws(
      () => grantedDefModels(bareAdapters, { localProviders: {} }),
      (err) => err.reason === 'agent-def-invalid' && /found a bare string/.test(err.message) && /declare a cell/.test(err.message),
    )
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a below-floor model cell from grantedDefModels is refused by assertDefBandFloors', () => {
  const root = scratchDir('crew-def-floor-')
  const path = join(root, 'scout.json')
  writeFileSync(path, JSON.stringify({ name: 'scout', prompt: 'p', model: { provider: 'anthropic', id: 'claude-haiku-4-5' } }))
  const adapters = { planner: { name: 'pi', adapter: { modelString: piModelString }, grants: { agents: [{ name: 'scout', def: path }] } } }
  const defs = grantedDefModels(adapters, { localProviders: {} })
  const ladder = loadLadder()
  assert.throws(
    () => assertDefBandFloors(defs, 'build', ladder, { adapters, localProviders: {} }),
    (err) => err.reason === 'band-below-floor',
  )
})

test('assertDefBandFloors refuses below-floor and unknown pinned models', () => {
  const ladder = loadLadder()
  const adapters = { planner: { adapter: { modelString: piModelString } } }
  const defs = (model) => [{ role: 'planner', agent: 'scout', path: '/tmp/scout.json', model }]
  assert.throws(
    () => assertDefBandFloors(defs('anthropic/claude-haiku-4-5'), 'build', ladder, { adapters }),
    (err) => err.reason === 'band-below-floor' && BAND_FLOOR_REFUSALS.includes(err.reason),
  )
  assert.throws(
    () => assertDefBandFloors(defs('anthropic/no-such-model'), 'build', ladder, { adapters }),
    (err) => err.reason === 'band-unknown' && BAND_FLOOR_REFUSALS.includes(err.reason),
  )
  assert.doesNotThrow(() => assertDefBandFloors(defs('anthropic/claude-opus-5'), 'build', ladder, { adapters }))
  assert.doesNotThrow(() => assertDefBandFloors([], 'not-a-tier', ladder, { adapters }))
})

test('loadLadder reads the ratified bands and tier floors through the runtime seam', () => {
  // The title's claim, driven: the injected reader must SEE the injected path.
  // `ladder.path` alone is an identity round-trip of the destructuring default.
  const injectedPath = '/tmp/injected-model-ladder.json'
  let seenPath = null
  const injected = loadLadder({ path: injectedPath, readFile: (p) => { seenPath = p; return JSON.stringify(rosterLadder) } })
  assert.equal(seenPath, injectedPath)
  assert.equal(injected.path, injectedPath)
  const ladder = loadLadder()
  assert.equal(ladder.path, LADDER_PATH)
  assert.deepEqual(Object.fromEntries(ladder.ranks), { frontier: 3, workhorse: 2, utility: 1, basement: 0 })
  assert.deepEqual(ladder.floors, { mechanical: 'utility', build: 'utility', judge: 'utility' })
})

test('loadLadder refuses every malformed artifact shape as ladder-unreadable', () => {
  const fixture = (mutate) => {
    const value = structuredClone(rosterLadder)
    mutate(value)
    return { path: '/ignored/model-ladder.json', readFile: () => JSON.stringify(value) }
  }
  const cases = [
    ['missing path', { path: '/no/such/dir/model-ladder.json' }],
    ['unparseable JSON', { path: '/ignored', readFile: () => 'not json' }],
    ['non-object', { path: '/ignored', readFile: () => '[]' }],
    ['missing bands and floors', { path: '/ignored', readFile: () => '{"schema_version":1}' }],
    ['schema version', fixture((l) => { l.schema_version = 2 })],
    ['ratified_at', fixture((l) => { delete l.ratified_at })],
    ['blank ratified_by', fixture((l) => { l.ratified_by = '' })],
    ['empty bands', fixture((l) => { l.bands = [] })],
    ['missing rank', fixture((l) => { delete l.bands[0].rank })],
    ['missing floor reference', fixture((l) => { delete l.bands[1].floor_reference_score })],
    ['duplicate band', fixture((l) => { l.bands[1].band = l.bands[0].band })],
    ['null member', fixture((l) => { l.bands[0].members.push(null) })],
    ['object member', fixture((l) => { l.bands[0].members.push({ id: 'x' }) })],
    ['blank member', fixture((l) => { l.bands[0].members.push('') })],
    ['bare member', fixture((l) => { l.bands[0].members.push('claude-sonnet-5') })],
    ['duplicate member', fixture((l) => { l.bands[1].members.push(l.bands[0].members[0]) })],
    ['missing build floor', fixture((l) => { delete l.tier_floors.build })],
    ['unknown build floor', fixture((l) => { l.tier_floors.build = 'no-such-band' })],
    ['missing cost ceilings', fixture((l) => { delete l.cost_ceilings })],
    ['negative build ceiling', fixture((l) => { l.cost_ceilings.build = -1 })],
  ]
  for (const [name, options] of cases) {
    assert.throws(() => loadLadder(options), (err) => err.reason === 'ladder-unreadable', name)
  }
})

test('assertBandFloors distinguishes a violated floor from ladder-unreadable', () => {
  const ladder = loadLadder()
  assert.throws(
    () => assertBandFloors({ builder: { provider: 'anthropic', id: 'claude-haiku-4-5', model: 'claude-haiku-4-5' } }, 'build', ladder),
    (err) => err.reason === 'band-below-floor' && err.reason !== 'ladder-unreadable',
  )
})

test('a below-floor roster seat refuses with its band and tier floor in the message', () => {
  const ladder = loadLadder()
  assert.throws(
    () => assertBandFloors({ builder: { provider: 'anthropic', id: 'claude-haiku-4-5' } }, 'build', ladder),
    (err) => err.reason === 'band-below-floor'
      && ['builder', 'claude-haiku-4-5', 'basement', 'utility'].every((word) => err.message.includes(word)),
  )
})

test('every ratified roster tier still passes its ratified band floor', () => {
  const ladder = loadLadder()
  for (const tier of Object.keys(roster.tiers)) {
    const { seats } = resolveTier(roster, tier, {})
    assert.doesNotThrow(() => assertBandFloors(seats, tier, ladder), tier)
  }
})

test('raw overrides resolve through the pi adapter namespace and never by textual equality', () => {
  const ladder = loadLadder()
  const adapter = { modelString: piModelString }
  const ctx = { adapters: { builder: { adapter } } }
  const raw = (model) => ({ builder: { provider: null, id: null, model } })
  assert.equal(seatModelKey(raw('openai-codex/gpt-5.6-luna').builder), 'openai-codex/gpt-5.6-luna')
  assert.deepEqual(bandForMember(ladder, 'openai/gpt-5.6-luna'), { member: 'openai/gpt-5.6-luna', band: 'utility' })
  assert.deepEqual(bandForRaw(ladder, 'openai-codex/gpt-5.6-luna', adapter), { member: 'openai/gpt-5.6-luna', band: 'utility' })
  assert.deepEqual(seatBand(ladder, raw('openai-codex/gpt-5.6-luna').builder, { adapter }), { member: 'openai/gpt-5.6-luna', band: 'utility' })
  assert.doesNotThrow(() => assertBandFloors(raw('openai-codex/gpt-5.6-luna'), 'build', ladder, ctx))
  assert.throws(() => assertBandFloors(raw('anthropic/claude-haiku-4-5'), 'build', ladder, ctx), (err) => err.reason === 'band-below-floor' && err.message.includes('anthropic/claude-haiku-4-5'))
  assert.throws(() => assertBandFloors(raw('openai/gpt-5.6-luna'), 'build', ladder, ctx), (err) => err.reason === 'band-unknown')
})

test('raw overrides use the claude adapter namespace and unknown adapters prove nothing', () => {
  const ladder = loadLadder()
  const claude = { modelString: claudeModelString }
  const ctx = { adapters: { builder: { adapter: claude } } }
  const raw = (model) => ({ builder: { provider: null, id: null, model } })
  assert.throws(() => assertBandFloors(raw('claude-haiku-4-5'), 'build', ladder, ctx), (err) => err.reason === 'band-below-floor')
  assert.throws(() => assertBandFloors(raw('anthropic/claude-haiku-4-5'), 'build', ladder, ctx), (err) => err.reason === 'band-unknown')
  assert.throws(() => assertBandFloors(raw('opus'), 'build', ladder, ctx), (err) => err.reason === 'band-unknown')
  assert.throws(() => assertBandFloors(raw('claude-haiku-4-5'), 'build', ladder, { adapters: { builder: { adapter: {} } } }), (err) => err.reason === 'band-unknown')
})

test('an unresolvable roster cell is band-unknown and never passes', () => {
  const ladder = loadLadder()
  assert.throws(
    () => assertBandFloors({ builder: { provider: 'acme', id: 'no-such-model' } }, 'build', ladder),
    (err) => err.reason === 'band-unknown' && err.message.includes('acme/no-such-model'),
  )
})

test('shipped llama-swap models resolve through pi, remain basement-only, and stay unseated', () => {
  const shipped = shippedRoster()
  const register = loadCapabilities()
  const ladder = loadLadder()
  const basement = rosterLadder.bands.find((band) => band.band === 'basement')
  const localKeys = ['llama-swap/qwen3.8-27b', 'llama-swap/gpt-oss-20b', 'llama-swap/gemma4-31b']
  const basis = 'Basement placement for llama-swap models is an assertion because no reference score exists.'

  assert.equal(Object.keys(register.local_providers).length, 1)
  assert.equal(register.local_providers['llama-swap'].pi_provider, 'llama-swap')
  assert.equal(basement.membership_basis, basis)
  for (const key of localKeys) {
    const [provider, id] = key.split('/')
    assert.equal(piModelString({ provider, id, localProviders: register.local_providers }), key)
    assert.equal(shipped.models[key].source, 'local')
    for (const band of rosterLadder.bands) assert.equal(band.members.includes(key), band.band === 'basement')
    assert.throws(
      () => assertBandFloors({ builder: { provider, id, model: null } }, 'judge', ladder, { models: shipped.models }),
      (err) => err.reason === 'local-model-judge-seat' && err.message.includes(key),
    )
  }
  for (const seats of Object.values(shipped.tiers)) {
    for (const seat of Object.values(seats)) {
      if (seat) assert.equal(localKeys.includes(`${seat.provider}/${seat.id}`), false)
    }
  }
})

test('a source:"local" roster model is refused from every judge seat at every ratified band', () => {
  const bands = ['frontier', 'workhorse', 'utility', 'basement']
  const roles = ['lead', 'planner', 'builder', 'reviewer', 'tech-lead']
  for (const band of bands) {
    const ladder = ladderWithLocalAt(band)
    for (const role of roles) {
      const seats = { [role]: { provider: 'local', id: 'qwen3-coder-30b', model: null } }
      assert.throws(
        () => assertBandFloors(seats, 'judge', ladder, { models: localCatalog }),
        (err) => err.reason === 'local-model-judge-seat' && BAND_FLOOR_REFUSALS.includes(err.reason),
        `${band} ${role}`,
      )
    }
  }
})

test('a ratified judge roster fixture is admitted unchanged with its own model catalog in hand', () => {
  const { seats } = resolveTier(roster, 'judge', {})
  assert.equal(seatModelKey(seats.lead), 'anthropic/claude-opus-5')
  assert.equal(seatModelKey(seats.planner), 'anthropic/claude-opus-5')
  assert.equal(seatModelKey(seats.builder), 'openai/gpt-5.6-luna')
  assert.equal(seatModelKey(seats.reviewer), 'anthropic/claude-opus-5')
  assert.equal(seatModelKey(seats['tech-lead']), 'openai/gpt-5.6-sol')
  assert.doesNotThrow(() => assertBandFloors(seats, 'judge', loadLadder(), { models: roster.models }))
})

test('a source:"local" model in a mechanical or build seat is admitted at its band', () => {
  const ladder = ladderWithLocalAt('workhorse')
  for (const tier of ['mechanical', 'build']) {
    for (const role of ['planner', 'builder']) {
      const seats = { [role]: { provider: 'local', id: 'qwen3-coder-30b', model: null } }
      assert.doesNotThrow(
        () => assertBandFloors(seats, tier, ladder, { models: localCatalog }),
        `${tier} ${role}`,
      )
    }
  }
})

test('the local-model judge refusal names the seat, the model and its closed reason', () => {
  const ladder = ladderWithLocalAt('basement')
  assert.throws(
    () => assertBandFloors(
      { builder: { provider: 'local', id: 'qwen3-coder-30b', model: null } },
      'judge', ladder, { models: localCatalog },
    ),
    (err) => err.reason === 'local-model-judge-seat'
      && err.message.includes('builder')
      && err.message.includes(LOCAL_MEMBER)
      && err.message.includes('[local-model-judge-seat]'),
  )
})

test('a raw --model override resolving to a local ratified member is refused from a judge seat', () => {
  const adapter = { modelString: ({ provider, id }) => `${provider}-cli/${id}` }
  const seats = { reviewer: { provider: null, id: null, model: 'local-cli/qwen3-coder-30b' } }
  assert.throws(
    () => assertBandFloors(
      seats, 'judge', ladderWithLocalAt('frontier'),
      { models: localCatalog, adapters: { reviewer: { adapter } } },
    ),
    (err) => err.reason === 'local-model-judge-seat',
  )
})

test('boot passes the roster model catalog into the seat band floor check', () => {
  const source = readFileSync(new URL('./crew.mjs', import.meta.url), 'utf8')
  const match = source.match(/assertBandFloors\(seats, tierName,[^\n]*/)
  assert.ok(match)
  assert.ok(match[0].includes('models: roster?.models'))
})

test('a tier with no ratified floor refuses floor-unratified', () => {
  const ladder = { path: '/hand-built', ranks: new Map([['utility', 1]]), members: new Map(), floors: {} }
  assert.throws(() => assertBandFloors({}, 'build', ladder), (err) => err.reason === 'floor-unratified')
})

test('the band-floor refusal reason set is frozen and closed', () => {
  assert.equal(Object.isFrozen(BAND_FLOOR_REFUSALS), true)
  assert.throws(() => refuseBandFloor('anything-else', 'x'))
})

test('assertSeats: a lead-less crew passes; a seated-but-missing lead or missing reviewer throws', () => {
  assert.doesNotThrow(() => assertSeats({ roles: ['planner', 'builder', 'reviewer'], members: { planner: {}, builder: {}, reviewer: {} } }))
  assert.throws(() => assertSeats({ roles: ['lead', 'planner', 'builder', 'reviewer'], members: { planner: {}, builder: {}, reviewer: {} } }))
  assert.throws(() => assertSeats({ roles: ['planner', 'builder'], members: { planner: {}, builder: {} } }))
})

test('assertSeats reads declared envelope seats and keeps the lead rule', () => {
  const plannerOnlyCrew = { roles: ['lead', 'planner'], members: { lead: {}, planner: {} } }
  assert.doesNotThrow(() => assertSeats(plannerOnlyCrew, 'scout'))
  const reviewerOnlyCrew = { roles: ['reviewer'], members: { reviewer: {} } }
  assert.doesNotThrow(() => assertSeats(reviewerOnlyCrew, 'review_only'))
  assert.doesNotThrow(() => assertSeats(reviewerOnlyCrew, 'verify_only'))
  assert.doesNotThrow(() => assertSeats({ roles: ['reviewer', 'tech-lead'], members: { reviewer: {}, 'tech-lead': {} } }, 'review_only'))
  assert.throws(() => assertSeats({ roles: ['tech-lead'], members: { 'tech-lead': {} } }, 'review_only'), /requires a reviewer seat/)
  assert.throws(() => assertSeats({ roles: ['tech-lead'], members: { 'tech-lead': {} } }, 'verify_only'), /requires a reviewer seat/)
  assert.throws(() => assertSeats(plannerOnlyCrew, 'full'), /requires a builder seat/)
  assert.throws(() => assertSeats({ roles: ['lead', 'planner'], members: { planner: {} } }, 'scout'), /requires a lead seat/)
  assert.throws(() => assertSeats(plannerOnlyCrew), /requires a builder seat/)
})

test('a lead-less layout is still strictly binary, with the first seated role on the left', () => {
  const layout = composeLayout(['planner', 'builder', 'reviewer'], mk)
  assert.equal(assertBinary(layout), 3)
  assert.equal(layout.children[0].pane.surfaces[0].name, 'planner')
})
