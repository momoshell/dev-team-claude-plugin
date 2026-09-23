import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, renameSync, chmodSync, symlinkSync, cpSync, realpathSync } from 'node:fs'
import { execSync, spawn, spawnSync } from 'node:child_process'
import { tmpdir, homedir } from 'node:os'
import { join, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openLedger, USAGE_ABSENT_CAUSES } from '../scripts/factory/ledger.mjs'
import { TURN_CEILING_FLAGS } from './drive.mjs'
import { openRun, _resetNoticeGuardsForTest } from '../scripts/factory/emit.mjs'
import { SEAT_DEFAULTS, FANOUT_TOOLS, ROLE_ORDER, resolveAdapters, resolveTier, loadLadder, shadowCandidates, shadowExclusion, shadowPick, shadowPickBoot, SHADOW_EXCLUSIONS, SHADOW_OUTCOMES, SHADOW_ABSENT, loadRoutingPolicy, materialiseRoutingChoice, replayRoutingChoice, ROUTING_EXCLUSION_REASONS, ROUTING_PRECEDENCE, bootCmd, runCmd, runExitCode, runOutcome, RUN_EXIT_CODES, RUN_EXIT_UNEXPECTED, RUN_START_EVENT, readHead, readBranch, teardownDecision, stagesFromJournal, resolveValidationLane, awaitSeatsReady, teardownCore, installExitMarker, installRunFinalizers, writeTerminalLine, terminalLineSeen, runScopedPaths, returnsInheritanceRecord, RETURNS_INHERITANCE_REASONS, resolveTaskReturn, archivedReturn, UsageError, KNOWN_FLAGS, ROLE_FLAG_PREFIXES, REQUIRED_FLAGS, BOOT_ONLY_FLAGS, assertUsage, parseArgs, FLAG_VALUE_REFUSAL, FLAG_VALUE_CONTRACT, BOOLEAN_FLAGS, resolveTimeoutS, TIMEOUT_S_REFUSAL, TIMEOUT_S_DEFAULT, MEMORY_ROLES, CHARTER_CEILINGS, CAPABILITY_REFUSALS, loadCapabilities, grantsFor, assertGrantsBacked, assertFanoutCoherent, deniedFanout, EMPTY_GRANTS, probeLocalEndpoint, effectiveTools, persistedAdapters, GRANT_SNAPSHOT_REFUSAL, ADVISOR_CONFIG_VERSION, ADVISOR_BOOT_REFUSALS, SAFE_MODEL, classifyAdvisorCell, advisorBootRecord, advisorJournalRecord, advisorEndpointOrigin, assertAdvisorCellLive, advisorManifest, assertAdvisorManifest, packageSuite, SUITE_OWNER_PATH, SUITE_REFUSAL, PANE_TURN_CEILING_UNMEASURED, paneTurnCeilingRefusals, resumeCmd, validateResumeState, RESUME_REFUSALS, RESUME_REFUSAL_NAMES, refuseResume, chunkCtxFromArgs } from './crew.mjs'
import { runCmdFixture } from './drive-fixtures.mjs'
import { composeRolePrompt } from './crew.mjs'
import { runChild, packageSuite as childPackageSuite, SUITE_OWNER_PATH as CHILD_SUITE_OWNER_PATH } from './child.mjs'
import { driveTask, resumeWorktreeSha256 } from './drive.mjs'
import { seatCommand, skillsPluginDir, writeSeatSkills } from './adapters/adapter-claude.mjs'
import { seatCommand as piSeatCommand, translateDeny, PI_BUILTIN_TOOLS } from './adapters/adapter-pi.mjs'
import { rpcCommand } from './headless-rpc.mjs'
import { seatIo, DEFAULT_TRANSPORT, HEADLESS_TRANSPORT } from './seat-io.mjs'
import { testCheckout } from '../test/fixtures.mjs'
import { ROOT, scratchDir } from '../test/helpers.mjs'
import { FINGERPRINT_FILE, FINGERPRINT_OUTCOMES, FINGERPRINT_WITHHELD, checkRecordedTree } from './tree-fingerprint.mjs'
import { WORKFLOW_REFUSALS, SEAT_BEARING_STAGES, loadWorkflow, validateWorkflow } from './workflows.mjs'
import { shippedRoster, roster, nodeMeetsLedgerFloor, withHome, testCrewDir, callCounter, capabilityRegister, capabilityFixtureRoot } from './crew-test-helpers.mjs'

// Keep tests hermetic against the operator's router switch; adapter commands inherit process.env.
delete process.env.CREW_ROUTER_ATTEMPT_URL

// Keep lexical import reach visible before byte-pinned regex test bodies.
void [test, after, assert, createHash, readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, renameSync, chmodSync, symlinkSync, cpSync, realpathSync, execSync, spawn, spawnSync, tmpdir, homedir, join, basename, dirname, fileURLToPath, openLedger, USAGE_ABSENT_CAUSES, TURN_CEILING_FLAGS, openRun, _resetNoticeGuardsForTest, SEAT_DEFAULTS, FANOUT_TOOLS, ROLE_ORDER, resolveAdapters, resolveTier, loadLadder, shadowCandidates, shadowExclusion, shadowPick, shadowPickBoot, SHADOW_EXCLUSIONS, SHADOW_OUTCOMES, SHADOW_ABSENT, loadRoutingPolicy, materialiseRoutingChoice, replayRoutingChoice, ROUTING_EXCLUSION_REASONS, ROUTING_PRECEDENCE, bootCmd, runCmd, runExitCode, runOutcome, RUN_EXIT_CODES, RUN_EXIT_UNEXPECTED, RUN_START_EVENT, readHead, readBranch, teardownDecision, stagesFromJournal, resolveValidationLane, awaitSeatsReady, teardownCore, installExitMarker, installRunFinalizers, writeTerminalLine, terminalLineSeen, runScopedPaths, returnsInheritanceRecord, RETURNS_INHERITANCE_REASONS, resolveTaskReturn, archivedReturn, UsageError, KNOWN_FLAGS, ROLE_FLAG_PREFIXES, REQUIRED_FLAGS, BOOT_ONLY_FLAGS, assertUsage, parseArgs, FLAG_VALUE_REFUSAL, FLAG_VALUE_CONTRACT, BOOLEAN_FLAGS, resolveTimeoutS, TIMEOUT_S_REFUSAL, TIMEOUT_S_DEFAULT, MEMORY_ROLES, CHARTER_CEILINGS, CAPABILITY_REFUSALS, loadCapabilities, grantsFor, assertGrantsBacked, assertFanoutCoherent, deniedFanout, EMPTY_GRANTS, probeLocalEndpoint, effectiveTools, persistedAdapters, GRANT_SNAPSHOT_REFUSAL, ADVISOR_CONFIG_VERSION, ADVISOR_BOOT_REFUSALS, SAFE_MODEL, classifyAdvisorCell, advisorBootRecord, advisorJournalRecord, advisorEndpointOrigin, assertAdvisorCellLive, advisorManifest, assertAdvisorManifest, packageSuite, SUITE_OWNER_PATH, SUITE_REFUSAL, PANE_TURN_CEILING_UNMEASURED, paneTurnCeilingRefusals, resumeCmd, validateResumeState, RESUME_REFUSALS, RESUME_REFUSAL_NAMES, refuseResume, runChild, childPackageSuite, CHILD_SUITE_OWNER_PATH, driveTask, resumeWorktreeSha256, seatCommand, skillsPluginDir, writeSeatSkills, piSeatCommand, translateDeny, PI_BUILTIN_TOOLS, rpcCommand, seatIo, DEFAULT_TRANSPORT, HEADLESS_TRANSPORT, testCheckout, ROOT, scratchDir, FINGERPRINT_FILE, FINGERPRINT_OUTCOMES, FINGERPRINT_WITHHELD, checkRecordedTree, WORKFLOW_REFUSALS, SEAT_BEARING_STAGES, loadWorkflow, validateWorkflow, shippedRoster, roster, nodeMeetsLedgerFloor, withHome, testCrewDir, callCounter, capabilityRegister, capabilityFixtureRoot, composeRolePrompt, globalThis.appendFileSync]

const KEEPALIVE_LIFETIME_DEFAULT_MS = 300 * 1000
const CLAUDE_USAGE_SETTINGS = fileURLToPath(new URL('./adapters/claude-usage.settings.json', import.meta.url))

const CLI_REPO_ROOT = ROOT

const CREW_REPO_ROOT = CLI_REPO_ROOT

const CLI_PROBE_TASK = 'b120-usage-probe'

const CLI_PROBE_BRIEF = join(tmpdir(), 'b120-usage-probe-brief.md')

const CLI_ENV = { ...process.env, NO_COLOR: '1' }
delete CLI_ENV.FORCE_COLOR
delete CLI_ENV.CLICOLOR_FORCE

const ANSI_CODES = /\u001b\[[0-9;]*m/g

const cliEntry = (...argv) => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./crew.mjs', import.meta.url)), ...argv], {
    cwd: CLI_REPO_ROOT, encoding: 'utf8', env: CLI_ENV,
  })
  return { ...result, output: `${result.stdout || ''}${result.stderr || ''}`.replace(ANSI_CODES, '') }
}


const PIN_SEAT = Object.freeze({
  role: 'planner', promptFile: '/tmp/crew-task/role-planner.md',
  tools: SEAT_DEFAULTS.planner.tools, deny: SEAT_DEFAULTS.planner.deny, taskDir: '/tmp/crew-task',
  bootBrief: 'Crew for task demo. Task dir /tmp/crew-task. Read your role in the system prompt, reply exactly ready: your-role, then wait.',
})

const PIN_ROOT = { root: '/repo', exists: () => true, readFile: () => JSON.stringify({ name: 'scout', prompt: 'pinned stub' }) }

const pinnedGrants = (register, agent) =>
  assertGrantsBacked('planner', grantsFor(register, 'planner', { ...PIN_ROOT, agent }), register, { agent })


async function withCompletionEnv(home, log, fn) {
  const keys = ['DEVTEAM_LEDGER_DB', 'DEVTEAM_LEDGER_DIR', 'CREW_COMPLETION_LOG']
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  process.env.DEVTEAM_LEDGER_DIR = join(home, 'ledger')
  process.env.DEVTEAM_LEDGER_DB = join(home, 'ledger', 'ledger.db')
  process.env.CREW_COMPLETION_LOG = log
  try { return await withHome(home, fn) }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  }
}


async function runCompletionFixture({ task, result, keep = true, append = null } = {}) {
  const home = scratchDir(`crew-completion-${task}-home-`)
  const { root: checkoutRoot, checkout } = testCheckout(`crew-completion-${task}-checkout-`)
  const brief = join(home, 'brief.md')
  const log = join(home, 'completions.jsonl')
  writeFileSync(brief, '# completion brief\n')
  execSync('git init -q', { cwd: checkout })
  const previousExitCode = process.exitCode
  const previousStdoutWrite = process.stdout.write
  const previousStderrWrite = process.stderr.write
  let output = ''
  let errorOutput = ''
  try {
    await withCompletionEnv(home, log, async () => {
      process.stdout.write = () => true
      try {
        await bootCmd(
          { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
          { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
        )
      } finally { process.stdout.write = previousStdoutWrite }
      process.stdout.write = (chunk) => { output += String(chunk); return true }
      process.stderr.write = (chunk) => { errorOutput += String(chunk); return true }
      try {
        runCmd(
          { task, checkout, 'brief-file': brief, keep },
          {
            drive: () => result,
            ...(append ? { appendCompletion: append } : {}),
            writeTerminalLine: (text) => { output += String(text) },
          },
        )
      } finally {
        process.stdout.write = previousStdoutWrite
        process.stderr.write = previousStderrWrite
      }
    })
    const exitCode = process.exitCode
    const terminal = output.split('\n').map((line) => line.trim()).filter(Boolean)
      .map((line) => { try { return JSON.parse(line) } catch { return null } }).find(Boolean)
    return { home, checkout, crewDir: join(home, '.crew', 'checkout', task), log, terminal, exitCode, stderr: errorOutput }
  } finally {
    process.exitCode = previousExitCode
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
}


async function withoutMemoryEnv(fn) {
  const previous = Object.fromEntries(['CREW_MEMORY_DIR', 'CREW_MEMORY_BACKEND', 'CREW_MEMORY_BUDGET_BYTES']
    .map((key) => [key, process.env[key]]))
  for (const key of Object.keys(previous)) delete process.env[key]
  try { return await fn() }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  }
}


async function withBreakerEnv(values, fn) {
  const keys = ['CREW_BREAKER_THRESHOLD', 'CREW_BREAKER_WINDOW_MS', 'CREW_LOAD_THRESHOLD', ...Object.keys(values)]
  const previous = Object.fromEntries([...new Set(keys)].map((key) => [key, process.env[key]]))
  for (const key of Object.keys(previous)) {
    if (Object.hasOwn(values, key)) {
      if (values[key] === undefined) delete process.env[key]; else process.env[key] = String(values[key])
    } else delete process.env[key]
  }
  try { return await fn() }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  }
}


function memoryFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'crew-boot-memory-'))
  writeFileSync(join(dir, 'MEMORY.md'), '- [Alpha](alpha.md) — first hook\n- [Beta](beta.md) — second hook\n')
  writeFileSync(join(dir, 'alpha.md'), `---\nname: alpha\n---\n\n${'A'.repeat(80)}\n`)
  writeFileSync(join(dir, 'beta.md'), `---\nname: beta\n---\n\n${'B'.repeat(80)}\n`)
  return dir
}


function bootRecord(dir) {
  return readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line)).find((event) => event.event === 'boot')
}


async function bootSeatRows({ task = 'seat-writer', tier = 'build', args = {}, openLedger: openLedgerDep = null, openRun: openRunDep = null, existsSync: existsSyncDep = null, beforeBoot = null, afterBoot = null, rosterValue = roster, workflowDir = null, readWorkflowFile = null, register = null } = {}) {
  const home = scratchDir(`crew-seat-writer-${task}-home-`)
  const { root: checkoutRoot, checkout } = testCheckout(`crew-seat-writer-${task}-checkout-`)
  const rosterPath = join(home, 'roster.json')
  const dbPath = join(home, 'ledger.db')
  const brief = join(home, 'brief.md')
  writeFileSync(rosterPath, JSON.stringify(rosterValue, null, 2))
  writeFileSync(brief, '# seat writer brief\n')
  execSync('git init -q && git -c user.email=seat-writer@example.test -c user.name=seat-writer commit --allow-empty -q -m seed', { cwd: checkout })
  const envKeys = ['DEVTEAM_LEDGER_DB', 'DEVTEAM_LEDGER_DIR']
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  process.env.DEVTEAM_LEDGER_DB = dbPath
  process.env.DEVTEAM_LEDGER_DIR = join(home, 'ledger')
  const bootArgs = {
    task, checkout, ...(tier === null ? {} : { tier }), roster: rosterPath,
    'headless-all': true, 'claude-bin': process.execPath, ...args,
  }
  const deps = {
    cmux: callCounter(), tree: callCounter(), renameTab: callCounter(),
    ...(openLedgerDep ? { openLedger: openLedgerDep } : {}),
    ...(openRunDep ? { openRun: openRunDep } : {}),
    ...(existsSyncDep ? { existsSync: existsSyncDep } : {}),
    ...(register ? { register } : {}),
    ...(workflowDir ? { workflowDir } : {}),
    ...(readWorkflowFile ? { readWorkflowFile } : {}),
  }
  const previousStdoutWrite = process.stdout.write
  let before = null
  try {
    process.stdout.write = () => true
    if (beforeBoot) await beforeBoot({ home, checkout, dbPath, brief })
    await withHome(home, () => bootCmd(bootArgs, deps))
    const dir = testCrewDir(home, checkout, task)
    const crew = JSON.parse(readFileSync(join(dir, 'crew.json'), 'utf8'))
    const boot = bootRecord(dir)
    const readRows = () => {
      const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
      try {
        return { seats: ledger.dumpTable('run_seats'), configurations: ledger.dumpTable('run_configurations') }
      } finally { ledger.close() }
    }
    before = readRows()
    if (afterBoot) await afterBoot({ home, checkout, dir, dbPath, brief, crew, boot })
    const after = readRows()
    const rows = after.seats
    Object.defineProperties(rows, {
      crew: { value: crew },
      boot: { value: boot },
      configurations: { value: after.configurations },
      configurationsBefore: { value: before.configurations },
      home: { value: home },
      checkout: { value: checkout },
      dbPath: { value: dbPath },
    })
    return rows
  } finally {
    process.stdout.write = previousStdoutWrite
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
}


async function bootProposalSession(task) {
  const done = { status: 'done', summary: '', artifacts: [], details: {} }
  let session = null
  const rows = await bootSeatRows({
    task,
    afterBoot: async ({ home, checkout, brief, dbPath }) => {
      writeFileSync(brief, '# proposal brief\n```proposal\n{"shape":"mechanical","strength":"workhorse"}\n```\n')
      const previousExitCode = process.exitCode
      const previousStdoutWrite = process.stdout.write
      try {
        await withHome(home, () => {
          process.stdout.write = () => true
          runCmd(
            { task, checkout, 'brief-file': brief, keep: true },
            { drive: () => done, awaitSeatsReady: () => {}, writeTerminalLine: () => {} },
          )
        })
      } finally {
        process.stdout.write = previousStdoutWrite
        process.exitCode = previousExitCode
      }
      const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
      try {
        session = ledger.dumpTable('sessions').find((candidate) => candidate.task_slug === task)
      } finally { ledger.close() }
    },
  })
  return { rows, session }
}


function writeDescendantRecord(taskDir, overrides = {}) {
  const dir = join(taskDir, 'descendants')
  mkdirSync(dir, { recursive: true })
  const key = overrides.key || 'headless__d1__seat-1'
  const record = {
    reservation_id: overrides.reservation_id || 'record-seat-1', key, phase: 'running',
    owner: { pid: process.pid, startedAt: Date.now() }, transport: 'headless-json', role: 'builder',
    seat_id: 'd1', seat_reservation_id: 'seat-1', marker_owner_pid: process.pid,
    captures: 3, missed_snapshots: 0, discovery_failures: 0,
    root_pid: 999999, root_pgid: 999999, root_start: 'old-root', groups: [],
    root_settled: null, swept_at: null, sweep_id: null, ...overrides,
  }
  const path = join(dir, `.${key}.active.json`)
  writeFileSync(path, JSON.stringify(record))
  return path
}


function breakerRow(over = {}) {
  return {
    provider: 'meta', model_id: 'muse-spark-1.3-contributor', agent: 'pi', effort: 'medium', role: 'builder', kind: 'timeout',
    failures: 1, first_at: '2026-08-16T00:00:00.000Z', last_at: '2026-08-16T01:00:00.000Z', run_less: 0, ...over,
  }
}


function breakerAttempt(over = {}) {
  return {
    provider: 'meta', model_id: 'muse-spark-1.3-contributor', agent: 'pi', effort: 'medium', role: 'builder',
    attempts: 12, first_at: '2026-08-16T00:00:00.000Z', last_at: '2026-08-16T01:00:00.000Z', ...over,
  }
}


function fakeBreakerLedger(rows, { attemptRows = [breakerAttempt()], degraded = false } = {}) {
  const calls = []
  const open = (options) => {
    calls.push(options)
    return {
      get degraded() { return degraded },
      cellFailures: () => rows,
      cellAttempts: () => attemptRows,
      stats: () => ({ mirror_errors: 0 }),
      close() {},
    }
  }
  open.calls = calls
  return open
}

// #419: boot's own-task descendant sweep — closed-set refusals and the record it leaves.

const PROLOGUE_SIGNAL_WINDOW_MS = 500

const PROLOGUE_POLL_MS = 20

const PROLOGUE_READY_TIMEOUT_MS = 5000

const prologueSignalDelay = () => new Promise((resolve) => setTimeout(resolve, PROLOGUE_POLL_MS))


function prologueSignalFixture() {
  const root = scratchDir('crew-run-prologue-signal-')
  const home = join(root, 'home')
  const checkout = join(root, 'checkout')
  const task = 'run-prologue-signal'
  const crewDir = join(home, '.crew', basename(checkout), task)
  const brief = join(root, 'brief.md')
  const readyPath = join(root, 'prologue-ready')
  const cmuxPath = join(root, 'cmux')
  mkdirSync(join(crewDir, 'returns'), { recursive: true })
  mkdirSync(join(crewDir, 'task'), { recursive: true })
  mkdirSync(checkout, { recursive: true })
  execSync('git init -q && git -c user.email=prologue@example.test -c user.name=prologue commit --allow-empty -q -m seed', { cwd: checkout })
  writeFileSync(brief, '# prologue brief\n')
  writeFileSync(join(crewDir, 'journal.jsonl'), '')
  writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({
    schema_version: 3, task, checkout, tier: 'build',
    roles: ['planner', 'builder', 'reviewer'],
    members: Object.fromEntries(['planner', 'builder', 'reviewer'].map((role) => [role, {
      surface_id: `${role}-surface`, pane_id: null, transport: 'pane', model: 'sonnet', agent: 'claude',
    }])),
    task_return: join(crewDir, 'returns', 'task.json'),
  }))
  writeFileSync(cmuxPath, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
if (process.argv[2] === 'read-screen') appendFileSync(process.env.CREW_PROLOGUE_READY, 'ready\\n')
process.exit(0)
`)
  chmodSync(cmuxPath, 0o755)
  return { root, home, checkout, task, brief, readyPath, cmuxPath }
}


async function waitForPrologueReady(fixture, child, state) {
  const deadline = Date.now() + PROLOGUE_READY_TIMEOUT_MS
  while (!existsSync(fixture.readyPath)) {
    if (state.error) throw state.error
    if (state.closed) throw new Error(`run prologue child closed before readiness: ${JSON.stringify(state.closed)}`)
    if (Date.now() >= deadline) throw new Error('run prologue child never reached awaitSeatsReady')
    await prologueSignalDelay()
  }
}


async function assertPrologueSurvivesSigterm(child, state) {
  const deadline = Date.now() + PROLOGUE_SIGNAL_WINDOW_MS
  while (Date.now() < deadline) {
    assert.equal(state.error, null, 'run prologue child emitted an error after SIGTERM')
    assert.equal(state.closed, null, 'run prologue child closed during the SIGTERM survival window')
    assert.equal(child.exitCode, null, 'run prologue child exited during the SIGTERM survival window')
    assert.equal(child.signalCode, null, 'run prologue child received the default SIGTERM disposition')
    await prologueSignalDelay()
  }
  assert.equal(state.closed, null, 'run prologue child closed during the SIGTERM survival window')
  assert.equal(child.exitCode, null, 'run prologue child exited during the SIGTERM survival window')
  assert.equal(child.signalCode, null, 'run prologue child received the default SIGTERM disposition')
}


function waitForPrologueChildClose(child, state) {
  if (state.closed) return Promise.resolve(state.closed)
  return new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })))
}


const RUN_OUTCOME_CASES = [
  [{ status: 'escalation', details: { escalation: { where: 'driver', why: 'sendLine: pane did not respond' } } }, { status: 'aborted', outcome: 'escalated', terminal_reason: 'transport', terminal_actor: 'driver' }],
  [{ status: 'escalation', details: { escalation: { where: 'planner', why: 'no valid envelope after exceeded its 1800s budget' } } }, { status: 'aborted', outcome: 'escalated', terminal_reason: 'budget', terminal_actor: 'driver' }],
  [{ status: 'escalation', details: { escalation: { where: 'scope', why: 'anchor-absent in the compiled plan' } } }, { status: 'aborted', outcome: 'escalated', terminal_reason: 'plan-build-disagreement', terminal_actor: 'driver' }],
  [{ status: 'escalation', details: { escalation: { where: 'plan', why: 'a contradiction in the brief' } } }, { status: 'aborted', outcome: 'escalated', terminal_reason: 'brief-contradiction', terminal_actor: 'operator' }],
  [{ status: 'escalation', details: { escalation: { where: 'gate', why: 'a gate defect remained' } } }, { status: 'aborted', outcome: 'escalated', terminal_reason: 'gate-defect', terminal_actor: 'lead' }],
  [{ status: 'escalation', details: { escalation: { where: 'review', why: 'the review remained unresolved' } } }, { status: 'aborted', outcome: 'escalated', terminal_reason: 'review-unresolved', terminal_actor: 'lead' }],
  [{ status: 'escalation', details: { escalation: { where: 'cold-suite', why: 'the cold suite had no checkout' } } }, { status: 'aborted', outcome: 'escalated', terminal_reason: 'infrastructure', terminal_actor: 'driver' }],
  [{ status: 'escalation', details: { escalation: { where: 'weather', why: 'it rained' } } }, { status: 'aborted', outcome: 'escalated', terminal_reason: 'rule-gap', terminal_actor: null }],
]


function stopRunFixture({ task, cooperative = false } = {}) {
  const root = scratchDir(`crew-stop-${task || 'run'}-`)
  const home = join(root, 'home')
  const checkoutRoot = join(root, 'checkout')
  const dbPath = join(root, 'ledger.db')
  const brief = join(root, 'brief.md')
  const cmuxPath = join(root, 'cmux')
  const workerBin = join(root, 'claude')
  const readyPath = join(root, 'ready')
  mkdirSync(checkoutRoot, { recursive: true })
  const checkout = realpathSync(checkoutRoot)
  const entry = join(checkout, 'crew', 'crew.mjs')
  const crewDir = join(home, '.crew', basename(checkout), task)
  mkdirSync(join(crewDir, 'returns'), { recursive: true })
  mkdirSync(join(crewDir, 'task'), { recursive: true })
  writeFileSync(brief, '# stop brief\n')
  const roles = ['planner', 'builder', 'reviewer']
  writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({
    schema_version: 3, task, checkout, tier: 'build', roles,
    members: Object.fromEntries(roles.map((role) => [role, {
      surface_id: `${role}-surface`, pane_id: null, transport: 'pane', model: 'sonnet', agent: 'claude',
    }])),
    task_return: join(crewDir, 'returns', 'task.json'),
  }))
  writeFileSync(join(crewDir, 'journal.jsonl'), '')
  writeFileSync(workerBin, '#!/bin/sh\nexit 0\n')
  chmodSync(workerBin, 0o755)
  if (cooperative) {
    mkdirSync(join(checkout, 'crew'), { recursive: true })
    const ledgerUrl = new URL('../scripts/factory/ledger.mjs', import.meta.url).href
    writeFileSync(entry, `import { openLedger } from ${JSON.stringify(ledgerUrl)}
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const dbPath = ${JSON.stringify(dbPath)}
const task = ${JSON.stringify(task)}
const checkout = ${JSON.stringify(checkout)}
const crewDir = ${JSON.stringify(crewDir)}
const readyPath = ${JSON.stringify(readyPath)}
const adwId = 'stop-cooperative-run'
const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
ledger.startSession({ adw_id: adwId, repo_slug: 'checkout', task_slug: task })
// A REAL attended run arms the ledger finalizer, so a serviced SIGTERM lands
// fail/failed/SIGTERM/finalizer on the way out. Closing the ledger instead concealed the
// collision between that row and the terminal row the operator writes: the review must-fix.
ledger.installFinalizer({ adw_id: adwId })
mkdirSync(join(crewDir, 'ledger'), { recursive: true })
writeFileSync(join(crewDir, 'ledger', 'run.json'), JSON.stringify({ adw_id: adwId, db_path: dbPath }))
process.on('SIGTERM', () => process.exit(0))   // cooperative: the finalizer runs first
writeFileSync(readyPath, 'ready\\n')
setTimeout(() => process.exit(0), Number(process.env.CREW_TEST_KEEPALIVE_LIFETIME_MS || ${KEEPALIVE_LIFETIME_DEFAULT_MS}))
setInterval(() => {}, 1000)
`)
  } else {
    cpSync(join(CLI_REPO_ROOT, 'crew'), join(checkout, 'crew'), { recursive: true })
    symlinkSync(join(CLI_REPO_ROOT, 'scripts'), join(checkout, 'scripts'), 'dir')
    symlinkSync(join(CLI_REPO_ROOT, 'package.json'), join(checkout, 'package.json'))
    writeFileSync(cmuxPath, `#!/usr/bin/env node
const argv = process.argv.slice(2)
if (argv[0] === 'read-screen') {
  const surface = argv[argv.indexOf('--surface') + 1] || ''
  process.stdout.write('ready: ' + surface.replace(/-surface$/, '') + '\\n')
}
`)
    chmodSync(cmuxPath, 0o755)
  }
  execSync('git init -q && git config user.email stop@example.test && git config user.name stop && git add . && git commit -qm seed', { cwd: checkout })
  return { root, home, checkout, task, crewDir, dbPath, brief, cmuxPath, workerBin, entry, readyPath, sidecar: join(crewDir, 'ledger', 'run.json') }
}


function childClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
}


async function waitForStopFixtureFile(fixture, child, path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`stop fixture exited before ${path}: stdout=${child._stopStdout || ''} stderr=${child._stopStderr || ''} code=${child.exitCode} signal=${child.signalCode}`)
    if (Date.now() >= deadline) throw new Error(`stop fixture never wrote ${path}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}


async function invokeStop(fixture, pid) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./crew.mjs', import.meta.url)), 'stop', '--task', fixture.task, '--pid', String(pid), '--checkout', fixture.checkout], {
    cwd: CLI_REPO_ROOT,
    env: { ...CLI_ENV, HOME: fixture.home, DEVTEAM_LEDGER_DB: fixture.dbPath, CREW_CLAUDE_BIN: fixture.workerBin },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const result = await childClose(child)
  return { ...result, stdout, stderr }
}


async function invokeRun(fixture) {
  const child = spawn(process.execPath, [fixture.entry, 'run', '--task', fixture.task, '--checkout', fixture.checkout, '--brief-file', fixture.brief, '--keep'], {
    cwd: fixture.checkout,
    env: { ...CLI_ENV, HOME: fixture.home, CMUX_BIN: fixture.cmuxPath, DEVTEAM_LEDGER_DB: fixture.dbPath, CREW_CLAUDE_BIN: fixture.workerBin },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child._stopStdout = ''
  child.stdout.on('data', (chunk) => { child._stopStdout += String(chunk) })
  child._stopStderr = ''
  child.stderr.on('data', (chunk) => { child._stopStderr += String(chunk) })
  await waitForStopFixtureFile(fixture, child, fixture.sidecar)
  return child
}

// `invokeRun` waits for the SIDECAR FILE, which the child writes before it has
// necessarily landed its ledger session row. Reading once therefore races that
// write: under load the row is absent and the caller gets null. Measured on
// 2026-09-11 — this test passed warm and failed once cold, at 1451ms, with
// three other lanes competing for the machine, and the cold checkout replayed
// GREEN afterwards. The wait is bounded and the assertions are unchanged; a row
// that never arrives still returns null and still fails the caller.

async function readStopSession(fixture, { until = (session) => session != null, timeoutMs = 10_000 } = {}) {
  const sidecar = JSON.parse(readFileSync(fixture.sidecar, 'utf8'))
  const deadline = Date.now() + timeoutMs
  let session = null
  for (;;) {
    const ledger = openLedger({ dbPath: sidecar.db_path, stderr: { write: () => {} } })
    try { session = ledger.getSession(sidecar.adw_id) } finally { ledger.close() }
    if (until(session) || Date.now() >= deadline) return session
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}


const PI_SAMPLE = {
  role: 'builder', model: 'google/gemini-3-pro', promptFile: '/tmp/crew-task/role-builder.md',
  tools: 'Read,Edit,Write,Glob,Grep,Bash', deny: 'Task,Agent', taskDir: '/tmp/crew-task',
  bootBrief: 'Crew for task demo. Task dir /tmp/crew-task. Read your role in the system prompt, reply exactly ready: your-role, then wait.',
}

// assertCapabilities gates seat boot on these exact keys — a lie here silently unlocks seats the adapter cannot actually enforce.

function capabilityRegisterForBoot() {
  const base = capabilityRegister()
  return capabilityRegister({ roles: {
    planner: { ...base.roles.planner, tools: ['Task'] },
  } })
}


test('the default claude planner pane command is pinned byte for byte across the granted and ungranted paths', () => {
  const register = loadCapabilities()
  // The task dir is a scratch dir, not a fixed /tmp path: writeSeatSkills
  // refuses to materialise into a task dir that does not exist yet, and a fixed
  // path would let a concurrent lane delete this lane's materialisation between
  // write and compose. The pin stays byte-exact by interpolating the dir.
  const taskDir = scratchDir('crew-claude-planner-pin-')
  const seat = {
    role: 'planner', promptFile: join(taskDir, 'role-planner.md'),
    tools: SEAT_DEFAULTS.planner.tools, deny: SEAT_DEFAULTS.planner.deny, taskDir,
    bootBrief: `Crew for task demo. Task dir ${taskDir}. Read your role in the system prompt, reply exactly ready: your-role, then wait.`,
  }
  try {
  // GRANTED: the register's role-level `tools: ["Task"]` reaches --allowedTools
  // through adapter-claude's allowedTools() merge, and the claude overlay's
  // lean-build skill reaches its session plugin dir. Byte-for-byte, no exceptions.
  // seatCommand refuses an unmaterialised skill grant, so the granted skill is
  // materialised into the scratch task dir first (resolved from the real checkout
  // root; the materialised file name is root-independent, so the PIN_ROOT
  // command below finds it).
  const grantedReal = grantsFor(register, 'planner', { agent: 'claude' })
  assert.doesNotThrow(() => assertGrantsBacked('planner', grantedReal, register, { agent: 'claude' }))
  writeSeatSkills({ taskDir, role: 'planner', grants: grantedReal })
    assert.equal(
      seatCommand({ ...seat, model: 'opus', grants: pinnedGrants(register, 'claude') }),
      `env DEVTEAM_WORKER=1 CREW_ROLE=planner CREW_TASK_DIR="${taskDir}" CREW_FFF=0 CREW_FFF_NODE="" CREW_FFF_HOOK="" claude --model opus --permission-mode bypassPermissions --strict-mcp-config --mcp-config "${taskDir}/mcp/planner.json" --settings "${CLAUDE_USAGE_SETTINGS}" --plugin-dir "${skillsPluginDir({ taskDir, role: 'planner' })}" --allowedTools "Read,Glob,Grep,Bash,Write,Task" --disallowedTools "Edit,NotebookEdit,mcp__*" --append-system-prompt-file "${taskDir}/role-planner.md" "${seat.bootBrief}"`,
    )
    // UNGRANTED: the same seat with no grants at all composes a DIFFERENT command
    // (no Task, no plugin dir), so the granted assertion above is not vacuous.
    assert.equal(
      seatCommand({ ...seat, model: 'opus', grants: EMPTY_GRANTS }),
      `env DEVTEAM_WORKER=1 CREW_ROLE=planner CREW_TASK_DIR="${taskDir}" CREW_FFF=0 CREW_FFF_NODE="" CREW_FFF_HOOK="" claude --model opus --permission-mode bypassPermissions --strict-mcp-config --mcp-config "${taskDir}/mcp/planner.json" --settings "${CLAUDE_USAGE_SETTINGS}" --allowedTools "Read,Glob,Grep,Bash,Write" --disallowedTools "Edit,NotebookEdit,mcp__*" --append-system-prompt-file "${taskDir}/role-planner.md" "${seat.bootBrief}"`,
    )
    // The by_agent overlay now carries the claude planner's lean-build skill, so
    // stripping it removes exactly the session plugin dir and nothing else: the
    // stripped command is the pre-grant pin byte for byte.
    const stripped = JSON.parse(JSON.stringify(register))
    delete stripped.roles.planner.by_agent
    const strippedGrants = pinnedGrants(loadCapabilities({ register: stripped }), 'claude')
    assert.deepEqual(strippedGrants.skills, [])
    assert.equal(
      seatCommand({ ...seat, model: 'opus', grants: strippedGrants }),
      `env DEVTEAM_WORKER=1 CREW_ROLE=planner CREW_TASK_DIR="${taskDir}" CREW_FFF=0 CREW_FFF_NODE="" CREW_FFF_HOOK="" claude --model opus --permission-mode bypassPermissions --strict-mcp-config --mcp-config "${taskDir}/mcp/planner.json" --settings "${CLAUDE_USAGE_SETTINGS}" --allowedTools "Read,Glob,Grep,Bash,Write,Task" --disallowedTools "Edit,NotebookEdit,mcp__*" --append-system-prompt-file "${taskDir}/role-planner.md" "${seat.bootBrief}"`,
    )
  } finally {
    rmSync(taskDir, { recursive: true, force: true })
  }
})

test('the granted pi planner pane command is pinned byte for byte so by_agent delivery reaches argv', () => {
  const register = loadCapabilities()
  // The by_agent overlay's extension and agent grant must reach ARGV: -e, the
  // CREW_PI_AGENTS allowlist, and the `agent` activator in --tools.
  assert.equal(
    piSeatCommand({ ...PIN_SEAT, model: 'openai-codex/gpt-5.6', grants: pinnedGrants(register, 'pi') }),
    'env DEVTEAM_WORKER=1 CREW_ROLE=planner CREW_TASK_DIR="/tmp/crew-task" CREW_PI_AGENTS=\'[{"name":"scout","def":"/repo/crew/pi/agents/scout.json"}]\' pi --model openai-codex/gpt-5.6 --tools "read,bash,edit,write,grep,find,ls,Task,agent,lab" --exclude-tools "edit" --no-extensions -e "/repo/crew/pi/extensions/subagent.ts" -e "/repo/crew/pi/extensions/lab.ts" -e "/repo/crew/pi/extensions/readgate.ts" --skill "/repo/skills/lean-build/SKILL.md" --append-system-prompt "/tmp/crew-task/role-planner.md" "Crew for task demo. Task dir /tmp/crew-task. Read your role in the system prompt, reply exactly ready: your-role, then wait."',
  )
  // Ungranted: the same pi seat with no grants loses exactly the delivery.
  assert.equal(
    piSeatCommand({ ...PIN_SEAT, model: 'openai-codex/gpt-5.6', grants: EMPTY_GRANTS }),
    'env DEVTEAM_WORKER=1 CREW_ROLE=planner CREW_TASK_DIR="/tmp/crew-task" pi --model openai-codex/gpt-5.6 --tools "read,bash,edit,write,grep,find,ls" --exclude-tools "edit" --no-extensions --no-skills --append-system-prompt "/tmp/crew-task/role-planner.md" "Crew for task demo. Task dir /tmp/crew-task. Read your role in the system prompt, reply exactly ready: your-role, then wait."',
  )
})

test('the shipped planner pi RPC command pins the complete extension-derived tool list', () => {
  const register = loadCapabilities()
  const planner = rpcCommand({
    bin: '/repo/pi', model: 'openai-codex/gpt-5.6', effort: 'medium', sessionDir: '/tmp/crew-task/sessions', sessionId: 'planner',
    promptFile: '/tmp/crew-task/role-planner.md', deny: SEAT_DEFAULTS.planner.deny,
    env: { CREW_ROLE: 'planner', CREW_TASK_DIR: '/tmp/crew-task' }, grants: pinnedGrants(register, 'pi'),
  })
  assert.deepEqual(planner.args, [
    '--mode', 'rpc', '--model', 'openai-codex/gpt-5.6', '--thinking', 'medium', '--session-dir', '/tmp/crew-task/sessions',
    '--session-id', 'planner', '--append-system-prompt', '/tmp/crew-task/role-planner.md',
    '--tools', 'read,bash,edit,write,grep,find,ls,Task,agent,lab', '--exclude-tools', 'edit',
    '--no-context-files', '--no-extensions', '-e', '/repo/crew/pi/extensions/subagent.ts', '-e', '/repo/crew/pi/extensions/lab.ts',
    '-e', '/repo/crew/pi/extensions/readgate.ts', '--skill', '/repo/skills/lean-build/SKILL.md',
  ])
})

test('C1P/C1R subagent-only grants preserve the pre-change argv', () => {
  const grants = {
    tools: [], extensions: ['/repo/crew/pi/extensions/subagent.ts'],
    agents: [{ name: 'scout', def: '/repo/crew/pi/agents/scout.json' }], skills: [], advisor: false,
  }
  assert.equal(
    piSeatCommand({ ...PIN_SEAT, model: 'openai-codex/gpt-5.6', grants }),
    'env DEVTEAM_WORKER=1 CREW_ROLE=planner CREW_TASK_DIR="/tmp/crew-task" CREW_PI_AGENTS=\'[{"name":"scout","def":"/repo/crew/pi/agents/scout.json"}]\' pi --model openai-codex/gpt-5.6 --tools "read,bash,edit,write,grep,find,ls,agent" --exclude-tools "edit" --no-extensions -e "/repo/crew/pi/extensions/subagent.ts" --no-skills --append-system-prompt "/tmp/crew-task/role-planner.md" "Crew for task demo. Task dir /tmp/crew-task. Read your role in the system prompt, reply exactly ready: your-role, then wait."',
  )
  const rpc = rpcCommand({
    bin: '/repo/pi', model: 'openai-codex/gpt-5.6', sessionDir: '/tmp/crew-task/sessions', sessionId: 'planner',
    promptFile: '/tmp/crew-task/role-planner.md', deny: SEAT_DEFAULTS.planner.deny,
    env: { CREW_ROLE: 'planner', CREW_TASK_DIR: '/tmp/crew-task' }, grants,
  })
  assert.deepEqual(rpc.args, [
    '--mode', 'rpc', '--model', 'openai-codex/gpt-5.6', '--session-dir', '/tmp/crew-task/sessions', '--session-id', 'planner',
    '--append-system-prompt', '/tmp/crew-task/role-planner.md', '--tools', 'read,bash,edit,write,grep,find,ls,agent',
    '--exclude-tools', 'edit', '--no-context-files', '--no-extensions', '-e', '/repo/crew/pi/extensions/subagent.ts', '--no-skills',
  ])
})

test('BG1', () => {
  const register = loadCapabilities()
  const builderGrants = grantsFor(register, 'builder', { ...PIN_ROOT, agent: 'pi' })
  assert.doesNotThrow(() => assertGrantsBacked('builder', builderGrants, register, { agent: 'pi' }))
  const builder = {
    role: 'builder', model: 'openai-codex/gpt-5.6', promptFile: '/tmp/role-builder.md',
    tools: SEAT_DEFAULTS.builder.tools, deny: SEAT_DEFAULTS.builder.deny, taskDir: '/tmp/crew-task',
    bootBrief: PIN_SEAT.bootBrief, grants: builderGrants,
  }
  assert.deepEqual(
    piSeatCommand(builder),
    'env DEVTEAM_WORKER=1 CREW_ROLE=builder CREW_TASK_DIR="/tmp/crew-task" pi --model openai-codex/gpt-5.6 --tools "read,bash,edit,write,grep,find,ls,retrieve,fff_grep,fff_find,fff_multi_grep" --no-extensions -e "/repo/crew/pi/extensions/builderloop.ts" -e "/repo/crew/pi/extensions/readgate.ts" -e "/repo/crew/pi/extensions/skeletonread.ts" -e "/repo/crew/pi/extensions/fff.ts" --skill \"/repo/skills/lean-build/SKILL.md\" --append-system-prompt "/tmp/role-builder.md" "Crew for task demo. Task dir /tmp/crew-task. Read your role in the system prompt, reply exactly ready: your-role, then wait."',
  )
  const builderCommand = piSeatCommand(builder)
  assert.equal(builderCommand.split(' -e ').length - 1, 4)
  assert.equal(builderCommand.includes('--skill "/repo/skills/lean-build/SKILL.md"'), true)
  assert.equal(builderCommand.includes('--no-skills'), false)
  assert.ok(builderCommand.includes('-e "/repo/crew/pi/extensions/fff.ts"'))
  assert.ok(builderCommand.includes('-e "/repo/crew/pi/extensions/builderloop.ts"'))
  assert.ok(piSeatCommand(builder).includes('-e "/repo/crew/pi/extensions/readgate.ts"'))
  const claudeTaskDir = scratchDir('crew-claude-bg1-')
  try {
  const claudeBuilder = grantsFor(register, 'builder', { ...PIN_ROOT, agent: 'claude' })
  assert.deepEqual(claudeBuilder.extensions, [])
  // The lean-build skill is granted under both overlays; the claude builder
  // materialises it into its session plugin dir before composing its command.
  assert.deepEqual(claudeBuilder.skills, ['/repo/skills/lean-build/SKILL.md'])
  writeSeatSkills({ taskDir: claudeTaskDir, role: 'builder', grants: grantsFor(register, 'builder', { agent: 'claude' }) })
  assert.doesNotThrow(() => seatCommand({ ...builder, taskDir: claudeTaskDir, grants: claudeBuilder }))
  assert.equal(seatCommand({ ...builder, taskDir: claudeTaskDir, grants: claudeBuilder }).includes(`--plugin-dir "${skillsPluginDir({ taskDir: claudeTaskDir, role: 'builder' })}"`), true)
  for (const role of ROLE_ORDER.filter((name) => name !== 'builder')) {
    const grants = grantsFor(register, role, { ...PIN_ROOT, agent: 'pi' })
    assert.doesNotThrow(() => assertGrantsBacked(role, grants, register, { agent: 'pi' }))
    const command = piSeatCommand({
      ...builder, role, model: 'openai-codex/gpt-5.6', promptFile: `/tmp/role-${role}.md`,
      tools: SEAT_DEFAULTS[role].tools, deny: SEAT_DEFAULTS[role].deny, grants,
    })
    assert.equal(command.includes('/repo/crew/pi/extensions/builderloop.ts'), false)
    assert.equal(command.split('--skill "/repo/skills/lean-build/SKILL.md"').length - 1, 1)
    assert.equal(command.includes('--no-skills'), false)
    assert.equal(command.includes('/repo/crew/pi/extensions/readgate.ts'), role === 'planner' || role === 'tech-lead')
  }
  for (const role of ROLE_ORDER.filter((name) => name !== 'builder')) {
    const grants = grantsFor(register, role, { ...PIN_ROOT, agent: 'claude' })
    writeSeatSkills({ taskDir: claudeTaskDir, role, grants: grantsFor(register, role, { agent: 'claude' }) })
    const command = seatCommand({
      ...builder, taskDir: claudeTaskDir, role, model: 'opus', promptFile: `/tmp/role-${role}.md`,
      tools: SEAT_DEFAULTS[role].tools, deny: SEAT_DEFAULTS[role].deny, grants,
    })
    assert.equal(command.includes('/repo/crew/pi/extensions/readgate.ts'), false)
    assert.equal(command.includes(`--plugin-dir "${skillsPluginDir({ taskDir: claudeTaskDir, role })}"`), true)
  }
  } finally {
    rmSync(claudeTaskDir, { recursive: true, force: true })
  }
})

test('BG2', () => {
  const register = loadCapabilities()
  const builderGrants = grantsFor(register, 'builder', { ...PIN_ROOT, agent: 'pi' })
  assert.doesNotThrow(() => assertGrantsBacked('builder', builderGrants, register, { agent: 'pi' }))
  const builder = rpcCommand({
    bin: '/repo/pi', model: 'openai-codex/gpt-5.6', effort: 'max', sessionDir: '/tmp/crew-task/sessions', sessionId: 'builder',
    promptFile: '/tmp/role-builder.md', deny: SEAT_DEFAULTS.builder.deny,
    env: { CREW_ROLE: 'builder', CREW_TASK_DIR: '/tmp/crew-task' }, grants: builderGrants,
  })
  assert.deepEqual(builder, {
    bin: '/repo/pi',
    args: [
      '--mode', 'rpc', '--model', 'openai-codex/gpt-5.6', '--thinking', 'max', '--session-dir', '/tmp/crew-task/sessions',
      '--session-id', 'builder', '--append-system-prompt', '/tmp/role-builder.md',
      '--tools', 'read,bash,edit,write,grep,find,ls,retrieve,fff_grep,fff_find,fff_multi_grep', '--no-context-files', '--no-extensions',
      '-e', '/repo/crew/pi/extensions/builderloop.ts', '-e', '/repo/crew/pi/extensions/readgate.ts',
      '-e', '/repo/crew/pi/extensions/skeletonread.ts', '-e', '/repo/crew/pi/extensions/fff.ts', '--skill', '/repo/skills/lean-build/SKILL.md',
    ],
    env: { CREW_ROLE: 'builder', CREW_TASK_DIR: '/tmp/crew-task' },
  })
  assert.equal(builder.args.filter((value) => value === '-e').length, 4)
  assert.equal(builder.args.includes('/repo/crew/pi/extensions/builderloop.ts'), true)
  assert.equal(builder.args.includes('/repo/crew/pi/extensions/readgate.ts'), true)
  assert.equal(builder.args.includes('/repo/crew/pi/extensions/skeletonread.ts'), true)
  assert.equal(builder.args.filter((value) => value === '--skill').length, 1)
  assert.equal(builder.args.includes('/repo/skills/lean-build/SKILL.md'), true)
  assert.equal(builder.args.includes('--no-skills'), false)
  assert.equal(builder.args.includes('/repo/crew/pi/extensions/fff.ts'), true)
  for (const role of ROLE_ORDER.filter((name) => name !== 'builder')) {
    const grants = grantsFor(register, role, { ...PIN_ROOT, agent: 'pi' })
    assert.doesNotThrow(() => assertGrantsBacked(role, grants, register, { agent: 'pi' }))
    const command = rpcCommand({
      bin: '/repo/pi', model: 'openai-codex/gpt-5.6', effort: 'max', sessionDir: '/tmp/crew-task/sessions', sessionId: role,
      promptFile: `/tmp/role-${role}.md`, deny: SEAT_DEFAULTS[role].deny,
      env: { CREW_ROLE: role, CREW_TASK_DIR: '/tmp/crew-task' }, grants,
    })
    assert.equal(command.args.includes('/repo/crew/pi/extensions/builderloop.ts'), false)
    assert.equal(command.args.filter((value) => value === '--skill').length, 1)
    assert.equal(command.args.filter((value) => value === '/repo/skills/lean-build/SKILL.md').length, 1)
    assert.equal(command.args.includes('--no-skills'), false)
    assert.equal(command.args.includes('/repo/crew/pi/extensions/readgate.ts'), role === 'planner' || role === 'tech-lead')
  }
})

test('D1', async () => {
  const home = scratchDir('crew-mcp-d1-home-')
  const { root: checkoutRoot, checkout } = testCheckout('crew-mcp-d1-checkout-')
  const task = 'mcp-boot-record'
  const server = { name: 'search', command: { bin: '/opt/mcp-search', args: ['--stdio'] }, url: null }
  const base = capabilityRegister()
  const register = capabilityRegister({ roles: {
    builder: { ...base.roles.builder, mcp_servers: [server] },
  } })
  try {
    await withBreakerEnv({ DEVTEAM_LEDGER_DB: undefined }, () => withHome(home, () => bootCmd(
      { task, checkout, roles: 'lead,builder', 'headless-all': true, 'claude-bin': process.execPath },
      { register, awaitSeatsReady: async () => {} },
    )))
    const dir = testCrewDir(home, checkout, task)
    const crew = JSON.parse(readFileSync(join(dir, 'crew.json'), 'utf8'))
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'task', 'mcp', 'builder.json'), 'utf8')), {
      mcpServers: { search: { command: '/opt/mcp-search', args: ['--stdio'] } },
    })
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'task', 'mcp', 'lead.json'), 'utf8')), { mcpServers: {} })
    assert.deepEqual(crew.members.builder.mcp_servers, [server])
    assert.deepEqual(crew.members.lead.mcp_servers, [])
    const boot = bootRecord(dir)
    assert.deepEqual(boot.mcp_servers, { lead: [], builder: [server] })
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('A1 boot writes one run seat per effective role', async () => {
  const rows = await bootSeatRows({ task: 'seat-writer-a1' })
  assert.equal(rows.length, rows.crew.roles.length)
  assert.deepEqual(rows.map((row) => row.role).sort(), [...rows.crew.roles].sort())
})

test('B1 boot records resolved seat fields', async () => {
  const rows = await bootSeatRows({ task: 'seat-writer-b1' })
  for (const row of rows) {
    const seat = rows.crew.seats[row.role]
    const member = rows.crew.members[row.role]
    const allocation = rows.boot.allocation?.[row.role] || {}
    const warnings = (member.vendor_withheld || [])
      .map((entry) => entry?.reason)
      .filter((reason) => typeof reason === 'string' && reason.trim() !== '')
    assert.deepEqual({
      provider: row.provider,
      agent: row.agent,
      model_id: row.model_id,
      model: row.model,
      effort: row.effort,
      transport: row.transport,
      source: row.source,
      policy_state: row.policy_state,
      warnings: JSON.parse(row.warnings_json),
    }, {
      provider: seat.provider,
      agent: seat.agent,
      model_id: seat.id,
      model: seat.model,
      effort: seat.effort,
      transport: member.transport,
      source: Object.values(allocation).some((value) => value === 'override') ? 'operator_override' : 'roster',
      policy_state: warnings.length ? 'warned' : 'passed',
      warnings,
    })
  }
})

test('C1 boot seat recording remains non load bearing', async () => {
  const stderr = []
  let received = null
  let realEmitter = null
  _resetNoticeGuardsForTest()
  const wrappedOpenRun = (options) => {
    realEmitter = openRun({ ...options, stderr: { write: (chunk) => { stderr.push(String(chunk)); return true } } })
    return {
      startRun: (...args) => realEmitter.startRun(...args),
      recordSeats: (seats) => {
        received = seats
        const [firstGood, ...remainingGood] = seats
        const malformedSource = { ...firstGood, source: 'malformed-source' }
        realEmitter.recordSeats([firstGood, malformedSource, ...remainingGood])
      },
    }
  }
  let rows
  await assert.doesNotReject(async () => {
    rows = await bootSeatRows({ task: 'seat-writer-c1', openRun: wrappedOpenRun })
  })
  assert.ok(received?.length > 1)
  assert.equal(rows.length, received.length)
  assert.ok(rows.some((row) => row.role === received[0].role))
  assert.ok(rows.some((row) => row.role === received.at(-1).role))
  assert.ok(realEmitter.stats().dropped > 0)
  assert.match(stderr.join(''), /recordSeats/)
})

test('D1 raw model override records operator provenance', async () => {
  const rows = await bootSeatRows({
    task: 'seat-writer-d1',
    args: { 'model-builder': 'openai-codex/gpt-6-luna' },
  })
  const row = rows.find((candidate) => candidate.role === 'builder')
  assert.ok(row)
  assert.equal(row.provider, null)
  assert.equal(row.model_id, null)
  assert.equal(row.model, 'openai-codex/gpt-6-luna')
  assert.equal(row.source, 'operator_override')
})

test('E1 run seat assertion is fed by boot', async () => {
  const rows = await bootSeatRows({ task: 'seat-writer-real-path' })
  assert.ok(rows.length > 0)
  assert.equal(rows.length, rows.crew.roles.length)
  assert.deepEqual(rows.map((row) => row.role).sort(), [...rows.crew.roles].sort())
})

test('F1 untiered boot writes no run seats', async () => {
  const rows = await bootSeatRows({ task: 'seat-writer-f1', tier: null, args: { roles: 'builder' }, register: capabilityRegisterForBoot() })
  assert.equal(rows.length, 0)
})

test('G1 boot still records one run configuration', async () => {
  const done = { status: 'done', summary: '', artifacts: [], details: {} }
  const rows = await bootSeatRows({
    task: 'seat-writer-g1',
    afterBoot: async ({ home, checkout, brief }) => {
      const previousExitCode = process.exitCode
      const previousStdoutWrite = process.stdout.write
      try {
        await withHome(home, () => {
          process.stdout.write = () => true
          runCmd(
            { task: 'seat-writer-g1', checkout, 'brief-file': brief, keep: true },
            { drive: () => done, awaitSeatsReady: () => {}, writeTerminalLine: () => {} },
          )
        })
      } finally {
        process.stdout.write = previousStdoutWrite
        process.exitCode = previousExitCode
      }
    },
  })
  assert.equal(rows.configurationsBefore.length, 0)
  assert.equal(rows.configurations.length, 1)
})

test('RV2-1 boot defers run configuration projection to runCmd', async () => {
  const done = { status: 'done', summary: '', artifacts: [], details: {} }
  const rows = await bootSeatRows({
    task: 'seat-writer-rv2-1',
    afterBoot: async ({ home, checkout, brief, dir }) => {
      const crewPath = join(dir, 'crew.json')
      const crew = JSON.parse(readFileSync(crewPath, 'utf8'))
      crew.run_configuration.assurance.effective = 'DISTINCT-RUN-VALUE'
      writeFileSync(crewPath, JSON.stringify(crew, null, 2))
      const previousExitCode = process.exitCode
      const previousStdoutWrite = process.stdout.write
      try {
        await withHome(home, () => {
          process.stdout.write = () => true
          runCmd(
            { task: 'seat-writer-rv2-1', checkout, 'brief-file': brief, keep: true },
            { drive: () => done, awaitSeatsReady: () => {}, writeTerminalLine: () => {} },
          )
        })
      } finally {
        process.stdout.write = previousStdoutWrite
        process.exitCode = previousExitCode
      }
    },
  })
  assert.equal(rows.configurationsBefore.length, 0)
  assert.equal(rows.configurations.length, 1)
  assert.equal(rows.configurations[0].effective_assurance, 'DISTINCT-RUN-VALUE')
})

test('RV1-1 boot recordSeats leaves runCmd to start the proposal session', async () => {
  const { rows, session } = await bootProposalSession('seat-writer-rv1-1')
  assert.equal(rows.length, rows.crew.roles.length)
  assert.ok(session)
  assert.equal(session.proposed_shape, 'mechanical')
  assert.equal(session.proposed_strength, 'workhorse')
})

test('RV1-2 proposal tests retain the production boot emitter lifecycle', async () => {
  const source = readFileSync(new URL('./crew.test.mjs', import.meta.url), 'utf8')
  const deferredStart = ['defer', 'Boot', 'Run', 'Start'].join('')
  assert.doesNotMatch(source, new RegExp(`\\b${deferredStart}\\b`))
  for (const title of [
    'run wires the compiled brief into the session row',
    'run leaves a malformed proposal unmeasured and completes the driver',
    'run does not backfill historical session proposals',
  ]) {
    const start = source.indexOf(`test('${title}'`)
    const end = source.indexOf('\ntest(', start + 1)
    assert.ok(start >= 0)
    assert.doesNotMatch(source.slice(start, end === -1 ? source.length : end), /\bopenRun\s*:/)
  }
  const { session } = await bootProposalSession('seat-writer-rv1-2')
  assert.ok(session)
  assert.equal(session.proposed_shape, 'mechanical')
  assert.equal(session.proposed_strength, 'workhorse')
})

test('boot reclaims this task\'s provably dead descendants and proceeds', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-boot-descendant-dead-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-boot-descendant-dead-checkout-')
  const task = 'descendant-dead'
  const recordPath = writeDescendantRecord(join(testCrewDir(home, checkout, task), 'task'), {
    groups: [{ pgid: 42, anchors: [{ pid: 43, pgid: 42, start: 'child' }] }],
  })
  const kill = (pid) => {
    if (pid === -42) {
      const error = new Error('ESRCH')
      error.code = 'ESRCH'
      throw error
    }
    return true
  }
  try {
    await withBreakerEnv({ DEVTEAM_LEDGER_DB: undefined }, () => withHome(home, () => bootCmd(
      { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), descendantDeps: { kill, snapshot: () => ({ ok: true, rows: new Map() }), sleep: () => {} } },
    )))
    assert.equal(existsSync(join(testCrewDir(home, checkout, task), 'crew.json')), true)
    assert.ok(JSON.parse(readFileSync(recordPath, 'utf8')).swept_at)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('boot records a withheld optional vendor grant in crew.json and the journal', async () => {
  const home = scratchDir('crew-boot-optional-grant-home-')
  const { root: checkoutRoot, checkout } = testCheckout('crew-boot-optional-grant-checkout-')
  const vendorless = scratchDir('crew-boot-optional-grant-vendor-')
  const task = 'optional-vendor-record'
  const packageName = '@crew-fixture/pi-thing'
  const tools = ['ffgrep', 'fffind']
  const base = capabilityRegister()
  const register = capabilityRegister({ roles: {
    builder: {
      ...base.roles.builder,
      by_agent: { pi: { vendor_extensions: [{ package: packageName, tools, optional: true }] } },
    },
  } })
  try {
    await withBreakerEnv({ DEVTEAM_LEDGER_DB: undefined, CREW_PI_VENDOR_ROOT: vendorless }, () => withHome(home, () => bootCmd(
      { task, checkout, roles: 'lead,builder,reviewer', 'agent-builder': 'pi', 'headless-all': true, 'claude-bin': process.execPath },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), register },
    )))
    const dir = testCrewDir(home, checkout, task)
    const crew = JSON.parse(readFileSync(join(dir, 'crew.json'), 'utf8'))
    const boot = bootRecord(dir)
    const row = crew.members.builder.vendor_withheld?.[0]
    assert.equal(row?.package, packageName)
    assert.deepEqual(row?.tools, tools)
    assert.equal(row?.reason, 'vendor-extension-missing')
    assert.match(row?.detail || '', new RegExp(packageName.replace('/', '\\/')))
    assert.deepEqual(crew.members.lead.vendor_withheld, [])
    assert.deepEqual(crew.members.reviewer.vendor_withheld, [])
    assert.deepEqual(boot.vendor_withheld.builder, [row])
    assert.deepEqual(boot.vendor_withheld.lead, [])
    assert.deepEqual(boot.vendor_withheld.reviewer, [])
    assert.equal(boot.vendor_withheld.builder[0].reason, 'vendor-extension-missing')
    assert.equal(crew.members.builder.tools.includes('ffgrep'), false)
    assert.equal(crew.members.builder.tools.includes('fffind'), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(vendorless, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('boot refuses when a reclaimed descendant lacks a durable stamp', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-boot-descendant-stamp-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-boot-descendant-stamp-checkout-')
  const task = 'descendant-stamp'
  const recordPath = writeDescendantRecord(join(testCrewDir(home, checkout, task), 'task'), {
    groups: [{ pgid: 42, anchors: [{ pid: 43, pgid: 42, start: 'child' }] }],
  })
  const reclaimDescendants = () => ({
    records: 1, swept: 1, skipped: 0, retryable: 0, reclaimed: 1, live: 0,
    probe_unknown: 0, identity_refused: 0, record_failed: 0, snapshot_ok: true,
  })
  let error
  try {
    await withBreakerEnv({ DEVTEAM_LEDGER_DB: undefined }, () => withHome(home, () => assert.rejects(
      () => bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), reclaimDescendants },
      ),
      (candidate) => { error = candidate; return candidate.reason === 'descendants-unreclaimed' },
    )))
    assert.equal(error.code, 'stale-descendants')
    assert.equal(existsSync(join(testCrewDir(home, checkout, task), 'crew.json')), false)
    assert.equal(JSON.parse(readFileSync(recordPath, 'utf8')).swept_at, null)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('boot refuses when this task\'s records show a live descendant', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-boot-descendant-live-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-boot-descendant-live-checkout-')
  const task = 'descendant-live'
  const recordPath = writeDescendantRecord(join(testCrewDir(home, checkout, task), 'task'), {
    root_pid: 5000, root_pgid: 5000, root_start: 'live-root',
  })
  const liveSnapshot = () => ({ ok: true, rows: new Map([[5000, { pid: 5000, pgid: 5000, start: 'live-root', stat: 'Ss' }]]) })
  let error
  try {
    await withBreakerEnv({ DEVTEAM_LEDGER_DB: undefined }, () => withHome(home, () => assert.rejects(
      () => bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), descendantDeps: { kill: () => true, snapshot: liveSnapshot, sleep: () => {} } },
      ),
      (candidate) => { error = candidate; return candidate.reason === 'descendants-alive' },
    )))
    assert.equal(error.code, 'stale-descendants')
    assert.match(error.message, /crew:reap/)
    assert.equal(JSON.parse(readFileSync(recordPath, 'utf8')).swept_at, null)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('boot refuses an unmeasurable descendant probe', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-boot-descendant-unknown-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-boot-descendant-unknown-checkout-')
  const task = 'descendant-unknown'
  writeDescendantRecord(join(testCrewDir(home, checkout, task), 'task'))
  try {
    await withBreakerEnv({ DEVTEAM_LEDGER_DB: undefined }, () => withHome(home, () => assert.rejects(
      () => bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), descendantDeps: { kill: () => true, snapshot: () => ({ ok: false, rows: null }), sleep: () => {} } },
      ),
      (candidate) => candidate.reason === 'descendants-unknown',
    )))
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('a refused boot creates no seat, no workspace and no crew.json', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-boot-descendant-no-state-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-boot-descendant-no-state-checkout-')
  const task = 'descendant-no-state'
  const dir = testCrewDir(home, checkout, task)
  writeDescendantRecord(join(dir, 'task'), { root_pid: 5000, root_pgid: 5000, root_start: 'live-root' })
  const cmux = callCounter(); const tree = callCounter()
  try {
    await withBreakerEnv({ DEVTEAM_LEDGER_DB: undefined }, () => withHome(home, () => assert.rejects(
      () => bootCmd(
        { task, checkout, roles: 'lead,planner,builder,reviewer' },
        { cmux, tree, renameTab: callCounter(), register: capabilityRegisterForBoot(), descendantDeps: { kill: () => true, snapshot: () => ({ ok: true, rows: new Map([[5000, { pid: 5000, pgid: 5000, start: 'live-root', stat: 'Ss' }]]) }), sleep: () => {} } },
      ),
      (error) => error.reason === 'descendants-alive',
    )))
    assert.equal(cmux.calls.length, 0)
    assert.equal(tree.calls.length, 0)
    assert.equal(existsSync(join(dir, 'crew.json')), false)
    assert.equal(existsSync(join(dir, 'task', 'role-lead.md')), false)
    assert.equal(existsSync(join(dir, 'returns')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('the boot sweep touches only the booting task\'s own records', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-boot-descendant-own-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-boot-descendant-own-checkout-')
  const first = 'descendant-own-a'; const second = 'descendant-own-b'
  const firstPath = writeDescendantRecord(join(testCrewDir(home, checkout, first), 'task'), {
    groups: [{ pgid: 42, anchors: [{ pid: 43, pgid: 42, start: 'child' }] }],
  })
  const secondPath = writeDescendantRecord(join(testCrewDir(home, checkout, second), 'task'), {
    key: 'headless__d1__seat-2', reservation_id: 'record-seat-2',
    groups: [{ pgid: 42, anchors: [{ pid: 43, pgid: 42, start: 'child' }] }],
  })
  const beforeSecond = readFileSync(secondPath, 'utf8')
  const kill = (pid) => {
    if (pid === -42) {
      const error = new Error('ESRCH')
      error.code = 'ESRCH'
      throw error
    }
    return true
  }
  try {
    await withBreakerEnv({ DEVTEAM_LEDGER_DB: undefined }, () => withHome(home, () => bootCmd(
      { task: first, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), descendantDeps: { kill, snapshot: () => ({ ok: true, rows: new Map() }), sleep: () => {} } },
    )))
    assert.ok(JSON.parse(readFileSync(firstPath, 'utf8')).swept_at)
    assert.equal(readFileSync(secondPath, 'utf8'), beforeSecond)
    assert.equal(JSON.parse(readFileSync(secondPath, 'utf8')).swept_at, null)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('a boot with no records is silent, proceeds, and still records the check', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-boot-descendant-empty-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-boot-descendant-empty-checkout-')
  const task = 'descendant-empty'
  try {
    await withBreakerEnv({ DEVTEAM_LEDGER_DB: undefined }, () => withHome(home, () => bootCmd(
      { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
    )))
    const rows = readFileSync(join(testCrewDir(home, checkout, task), 'journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    const sweeps = rows.filter((row) => row.event === 'boot-descendant-sweep')
    assert.equal(sweeps.length, 1)
    assert.equal(sweeps[0].records, 0)
    assert.equal(sweeps[0].refusal, null)
    assert.equal(existsSync(join(testCrewDir(home, checkout, task), 'crew.json')), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('a second boot over swept records reports nothing rather than erroring', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-boot-descendant-second-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-boot-descendant-second-checkout-')
  const task = 'descendant-second'
  const recordPath = writeDescendantRecord(join(testCrewDir(home, checkout, task), 'task'), {
    groups: [{ pgid: 42, anchors: [{ pid: 43, pgid: 42, start: 'child' }] }],
  })
  const kill = (pid) => {
    if (pid === -42) {
      const error = new Error('ESRCH')
      error.code = 'ESRCH'
      throw error
    }
    return true
  }
  const deps = { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), descendantDeps: { kill, snapshot: () => ({ ok: true, rows: new Map() }), sleep: () => {} } }
  try {
    const args = { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath }
    await withBreakerEnv({ DEVTEAM_LEDGER_DB: undefined }, () => withHome(home, async () => {
      await bootCmd(args, deps)
      await bootCmd(args, deps)
    }))
    assert.ok(JSON.parse(readFileSync(recordPath, 'utf8')).swept_at)
    const rows = readFileSync(join(testCrewDir(home, checkout, task), 'journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      .filter((row) => row.event === 'boot-descendant-sweep')
    assert.equal(rows.length, 2)
    assert.equal(rows[1].records, 0)
    assert.equal(rows[1].skipped, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('the sweep runs before any seat state exists', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-boot-descendant-order-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-boot-descendant-order-checkout-')
  const task = 'descendant-order'
  const dir = testCrewDir(home, checkout, task)
  const calls = []
  const reclaimDescendants = (options) => {
    calls.push(options)
    assert.equal(existsSync(join(dir, 'task')), false)
    assert.equal(existsSync(join(dir, 'crew.json')), false)
    return { records: 0, swept: 0, skipped: 0, retryable: 0, reclaimed: 0, live: 0, probe_unknown: 0, identity_refused: 0, snapshot_ok: true }
  }
  try {
    await withBreakerEnv({ DEVTEAM_LEDGER_DB: undefined }, () => withHome(home, () => bootCmd(
      { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), reclaimDescendants },
    )))
    assert.equal(calls.length, 1)
    assert.equal(calls[0].taskDir, join(dir, 'task'))
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('a sweep that throws refuses rather than booting', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-boot-descendant-error-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-boot-descendant-error-checkout-')
  const task = 'descendant-error'
  const dir = testCrewDir(home, checkout, task)
  try {
    await withBreakerEnv({ DEVTEAM_LEDGER_DB: undefined }, () => withHome(home, () => assert.rejects(
      () => bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), reclaimDescendants: () => { throw new Error('ps exploded') } },
      ),
      (error) => error.reason === 'descendants-sweep-failed',
    )))
    assert.equal(existsSync(join(dir, 'crew.json')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('boot refusal records a run-less boot-refusal row naming the rejected cell', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-boot-refusal-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-boot-refusal-checkout-')
  const dbPath = join(home, 'ledger.db')
  const previous = process.env.DEVTEAM_LEDGER_DB
  process.env.DEVTEAM_LEDGER_DB = dbPath
  try {
    await withHome(home, () => assert.rejects(
      () => bootCmd({ task: 'boot-refusal', checkout, roles: 'lead,planner,builder,reviewer', 'agent-reviewer': 'no-such-agent' }, {
        cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), register: capabilityRegisterForBoot(),
      }),
      /unknown agent adapter/,
    ))
    const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
    const row = ledger.dumpTable('cell_failures').find((candidate) => candidate.kind === 'boot-refusal')
    ledger.close()
    if (!nodeMeetsLedgerFloor) {
      // Below the floor the emitter records JSONL only and writes no database.
      // The refusal itself (asserted above) is the behaviour that must hold on
      // every runtime; a recorded row is a capability of Node >= NODE_FLOOR.
      assert.equal(row, undefined)
      return
    }
    assert.ok(row)
    assert.equal(row.role, 'reviewer')
    assert.equal(row.adw_id, null)
    assert.equal(row.task_slug, 'boot-refusal')
  } finally {
    if (previous === undefined) delete process.env.DEVTEAM_LEDGER_DB; else process.env.DEVTEAM_LEDGER_DB = previous
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('run configuration flags are admitted only on their owning crew verbs', () => {
  assert.deepEqual(FLAG_VALUE_CONTRACT.profile, 'value')
  assert.deepEqual(FLAG_VALUE_CONTRACT.execution, 'value')
  assert.deepEqual(FLAG_VALUE_CONTRACT.assurance, 'value')
  assert.doesNotThrow(() => assertUsage('boot', { task: 'task', profile: 'investigation', assurance: 'standard' }))
  assert.doesNotThrow(() => assertUsage('run', { task: 'task', 'brief-file': 'brief.md', execution: 'scout' }))
  assert.throws(() => assertUsage('boot', { task: 'task', execution: 'scout' }), /--execution/)
  assert.throws(() => assertUsage('run', { task: 'task', 'brief-file': 'brief.md', assurance: 'standard' }), /--assurance/)
})

test('B1 boot crew record remains profile and assurance only', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-run-config-checkout-')
  const home = scratchDir('crew-run-config-home-')
  const task = 'run-config'
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# run configuration\n')
  execSync('git init -q', { cwd: checkout })
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  let seen = null
  try {
    await withHome(home, async () => {
      await bootCmd({ task, checkout, profile: 'investigation', assurance: 'rigorous', 'headless-all': true, 'claude-bin': process.execPath }, {
        cmux: callCounter(), tree: callCounter(), renameTab: callCounter(),
      })
      const dir = testCrewDir(home, checkout, task)
      const crew = JSON.parse(readFileSync(join(dir, 'crew.json'), 'utf8'))
      assert.equal(crew.tier, 'judge')
      assert.deepEqual(crew.run_configuration, {
        profile: { requested: 'investigation', effective: 'investigation', source: 'explicit' },
        assurance: { requested: 'rigorous', effective: 'rigorous', source: 'explicit' },
      })
      const bootConfiguration = bootRecord(dir).run_configuration
      assert.deepEqual(bootConfiguration, {
        profile: crew.run_configuration.profile,
        assurance: crew.run_configuration.assurance,
      })
      assert.equal(Object.hasOwn(bootConfiguration, 'execution'), false)
      assert.deepEqual(bootConfiguration, crew.run_configuration)
      runCmd({ task, checkout, 'brief-file': brief, execution: 'scout', keep: true }, {
        drive: (ctx) => { seen = ctx; return done }, awaitSeatsReady: () => {}, writeTerminalLine: () => {},
      })
      const rows = readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      const runConfig = rows.find((row) => row.event === 'run-configuration')?.run_configuration
      assert.deepEqual(runConfig, {
        profile: crew.run_configuration.profile,
        execution: { requested: 'scout', effective: 'scout', source: 'explicit', status: 'existing' },
        assurance: crew.run_configuration.assurance,
      })
    })
    assert.equal(seen?.variant, 'scout')
    assert.equal(Object.hasOwn(seen || {}, 'run_configuration'), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('run appends one completion record per finishing run without rewriting earlier bytes', async () => {
  const home = scratchDir('crew-completion-append-home-')
  const { root: checkoutRoot, checkout } = testCheckout('crew-completion-append-checkout-')
  const task = 'completion-append'
  const brief = join(home, 'brief.md')
  const log = join(home, 'completions.jsonl')
  writeFileSync(brief, '# completion append brief\n')
  execSync('git init -q', { cwd: checkout })
  const firstResult = { status: 'done', summary: '', artifacts: [], details: { commit: 'first-commit', stages: [] } }
  const secondResult = { status: 'done', summary: '', artifacts: [], details: { commit: 'second-commit', stages: [] } }
  const previousExitCode = process.exitCode
  try {
    await withCompletionEnv(home, log, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      runCmd({ task, checkout, 'brief-file': brief, keep: true }, { drive: () => firstResult })
      const first = readFileSync(log)
      runCmd({ task, checkout, 'brief-file': brief, keep: true }, { drive: () => secondResult })
      const after = readFileSync(log)
      assert.equal(after.subarray(0, first.length).equals(first), true)
      const rows = after.toString('utf8').trim().split('\n').map((line) => JSON.parse(line))
      assert.equal(rows.length, 2)
      assert.deepEqual(rows.map((row) => row.commit), ['first-commit', 'second-commit'])
      assert.deepEqual(rows.map((row) => row.outcome), ['done', 'done'])
    })
  } finally {
    process.exitCode = previousExitCode
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('a failed completion append never changes the run terminal result or exit code', async () => {
  const result = { status: 'done', summary: '', artifacts: [], details: { commit: 'control-commit', stages: [] } }
  const control = await runCompletionFixture({ task: 'completion-control', result })
  let calls = 0
  const broken = await runCompletionFixture({
    task: 'completion-broken', result,
    append: () => { calls += 1; throw new Error('append denied') },
  })
  assert.equal(calls, 1)
  assert.equal(broken.terminal.status, control.terminal.status)
  assert.equal(broken.terminal.commit, control.terminal.commit)
  assert.equal(broken.exitCode, control.exitCode)
  assert.match(broken.stderr, /completion record not appended/)
})

test('completion records preserve both terminal outcomes and run-owned paths', async () => {
  const cases = [
    ['completion-done', { status: 'done', summary: '', artifacts: [], details: { commit: 'done-commit', stages: [] } }],
    ['completion-escalation', { status: 'escalation', summary: 'needs review', artifacts: [], details: { commit: 'escalation-commit', stages: [], escalation: { why: 'review' } } }],
  ]
  for (const [task, result] of cases) {
    const run = await runCompletionFixture({ task, result })
    const record = JSON.parse(readFileSync(run.log, 'utf8').trim())
    assert.equal(record.lane, task)
    assert.equal(record.outcome, run.terminal.status)
    assert.equal(record.commit, run.terminal.commit)
    assert.equal(record.checkout, run.checkout)
    assert.equal(record.crew_dir, run.crewDir)
    assert.equal(record.archived, run.terminal.archived)
    assert.equal(record.task_return, run.terminal.task_return)
    assert.equal(Number.isNaN(Date.parse(record.at)), false)
  }
})

test('runCmd ends a run with the typed outcome mapping', async () => {
  const result = await runCompletionFixture({
    task: 'completion-typed-outcome',
    result: {
      status: 'escalation', summary: 'needs transport help', artifacts: [],
      details: { commit: null, stages: [], escalation: { where: 'driver', why: 'sendLine: no pane echo' } },
    },
  })
  if (!nodeMeetsLedgerFloor) return
  const ledger = openLedger({ dbPath: join(result.home, 'ledger', 'ledger.db'), stderr: { write: () => {} } })
  try {
    const row = ledger.listSessions().find((session) => session.task_slug === 'completion-typed-outcome')
    assert.ok(row)
    assert.deepEqual({ status: row.status, outcome: row.outcome, terminal_reason: row.terminal_reason, terminal_actor: row.terminal_actor }, {
      status: 'aborted', outcome: 'escalated', terminal_reason: 'transport', terminal_actor: 'driver',
    })
  } finally { ledger.close() }
})

test('CLI refuses run fences before reading crew state', () => {
  const result = cliEntry('run', '--task', CLI_PROBE_TASK, '--brief-file', CLI_PROBE_BRIEF, '--fences', 'F')
  assert.equal(result.status, 2)
  assert.match(result.output, /--fences/)
  assert.match(result.output, /crew\.mjs boot/)
})

test('CLI explains that paired fences suppresses the requested run lane', () => {
  const result = cliEntry('run', '--task', CLI_PROBE_TASK, '--brief-file', CLI_PROBE_BRIEF, '--lane', 'L', '--fences', 'F')
  assert.equal(result.status, 2)
  assert.match(result.output, /--fences/)
  assert.match(result.output, /crew\.mjs boot/)
  assert.match(result.output, /--lane/)
  assert.match(result.output, /SUPPRESSING the --lane you asked for/)
})

test('run accepts bare lane and validation-lane flags and reaches crew state', () => {
  const bareLane = cliEntry('run', '--task', CLI_PROBE_TASK, '--brief-file', CLI_PROBE_BRIEF, '--lane', 'npm test')
  assert.notEqual(bareLane.status, 2)
  assert.match(bareLane.output, /no crew booted/)
  const validationLane = cliEntry('run', '--task', CLI_PROBE_TASK, '--brief-file', CLI_PROBE_BRIEF, '--validation-lane', 'npm test')
  assert.notEqual(validationLane.status, 2)
  assert.match(validationLane.output, /no crew booted/)
  assert.deepEqual(resolveValidationLane({ lane: 'npm test' }), { lane: 'npm test', source: 'lane' })
  assert.doesNotThrow(() => assertUsage('run', { task: 't', 'brief-file': 'brief.md', lane: 'npm test' }))
})

test('CLI reports missing task as usage for every task-bearing verb', () => {
  for (const argv of [
    ['boot'],
    ['run', '--brief-file', CLI_PROBE_BRIEF],
    ['handoff', '--brief-file', CLI_PROBE_BRIEF],
    ['teardown'],
  ]) {
    const result = cliEntry(...argv)
    assert.equal(result.status, 2, argv.join(' '))
    assert.match(result.output, /--task/, argv.join(' '))
  }
})

test('CLI reports missing run brief as usage', () => {
  const result = cliEntry('run', '--task', CLI_PROBE_TASK)
  assert.equal(result.status, 2)
  assert.match(result.output, /--brief-file/)
})

test('CLI refuses unknown flags and preserves unexpected-error exit 1', () => {
  const unknown = cliEntry('status', '--task', CLI_PROBE_TASK, '--bogus-flag')
  assert.equal(unknown.status, 2)
  assert.match(unknown.output, /--bogus-flag/)
  const internal = cliEntry('status', '--task', CLI_PROBE_TASK)
  assert.equal(internal.status, 1)
  assert.match(internal.output, /no crew booted/)
})

test('CLI process pins retain direct spawnSync entrypoint coverage', () => {
  const entry = fileURLToPath(new URL('./crew.mjs', import.meta.url))
  const options = { cwd: CLI_REPO_ROOT, encoding: 'utf8', env: CLI_ENV }
  const missingTask = spawnSync(process.execPath, [entry, 'boot'], options)
  const unexpected = spawnSync(process.execPath, [entry, 'status', '--task', CLI_PROBE_TASK], options)
  assert.equal(missingTask.status, 2)
  assert.equal(unexpected.status, 1)
})

test('CLI refusal probes do not create crew state', () => {
  const probeDir = join(homedir(), '.crew', basename(CLI_REPO_ROOT), CLI_PROBE_TASK)
  assert.equal(existsSync(probeDir), false)
})

test('flag contracts accept known flags, role prefixes, and reject malformed usage', () => {
  const valueFor = (flag) => BOOLEAN_FLAGS.includes(flag) ? true : flag === 'task' ? 't' : flag === 'brief-file' ? 'brief.md' : 'value'
  for (const [verb, flags] of Object.entries(KNOWN_FLAGS)) {
    const args = { _: [] }
    for (const flag of flags) args[flag] = valueFor(flag)
    assert.doesNotThrow(() => assertUsage(verb, args), `${verb} known flags`)
  }
  for (const prefix of ROLE_FLAG_PREFIXES) {
    assert.doesNotThrow(() => assertUsage('boot', { task: 't', [`${prefix}planner`]: 'value' }), prefix)
  }
  assert.doesNotThrow(() => assertUsage('boot', { task: 't', 'allow-shortfall-nosuchrole': 'value' }))
  assert.doesNotThrow(() => assertUsage('boot', { task: 't', fences: 'register.json' }))
  assert.throws(
    () => assertUsage('run', { task: 't', 'brief-file': 'brief.md', fences: 'register.json' }),
    (err) => err instanceof UsageError && err.usage === true && /crew\.mjs boot/.test(err.message),
  )
  assert.throws(
    () => assertUsage('status', { task: 't', lane: 'L' }),
    (err) => err instanceof UsageError && err.usage === true && /BOOT-time/.test(err.message) && /crew\.mjs boot/.test(err.message),
  )
  for (const [verb, flags] of Object.entries(REQUIRED_FLAGS)) {
    for (const flag of flags) {
      const valid = { task: 't' }
      if (flags.includes('brief-file')) valid['brief-file'] = 'brief.md'
      valid[flag] = true
      assert.throws(() => assertUsage(verb, valid), `${verb} valueless ${flag}`)
      valid[flag] = '   '
      assert.throws(() => assertUsage(verb, valid), `${verb} empty ${flag}`)
    }
  }
  assert.deepEqual(BOOT_ONLY_FLAGS, ['fences', 'lane', ...TURN_CEILING_FLAGS])
})

test('argv value contracts cover every known flag and every hostile shape', () => {
  const union = new Set()
  for (const flags of Object.values(KNOWN_FLAGS)) for (const flag of flags) union.add(flag)
  assert.deepEqual([...Object.keys(FLAG_VALUE_CONTRACT)].sort(), [...union].sort())
  assert.ok(Object.values(FLAG_VALUE_CONTRACT).every((contract) => contract === 'value' || contract === 'boolean'))
  assert.deepEqual(BOOLEAN_FLAGS, ['chunked', 'headless-all', 'keep', 'panel-distinct-agents'])

  const requiredPrefix = (verb) => {
    const prefix = ['--task', 't']
    if (verb === 'run' || verb === 'handoff') prefix.push('--brief-file', 'brief.md')
    return prefix
  }
  const nextFlag = (flag) => flag === 'task' ? ['--checkout', 'checkout'] : ['--task', 't']
  const forms = {
    valueless: (flag) => [`--${flag}`],
    'empty-string': (flag) => [`--${flag}`, ''],
    whitespace: (flag) => [`--${flag}`, '   '],
    'flag-as-next-token': (flag) => [`--${flag}`, ...nextFlag(flag)],
  }
  for (const [verb, flags] of Object.entries(KNOWN_FLAGS)) {
    for (const flag of flags) {
      const contract = FLAG_VALUE_CONTRACT[flag]
      for (const [label, makeForm] of Object.entries(forms)) {
        const args = parseArgs([...requiredPrefix(verb), ...makeForm(flag)])
        if (contract === 'value' || (label !== 'valueless' && label !== 'flag-as-next-token')) {
          assert.throws(() => assertUsage(verb, args), (err) => (
            err.usage === true && err.reason === FLAG_VALUE_REFUSAL && err.message.includes(`--${flag}`)
          ), `${verb} --${flag} ${label}`)
        } else {
          assert.doesNotThrow(() => assertUsage(verb, args), `${verb} --${flag} ${label}`)
        }
      }
    }
  }
})

test('CLI refuses valueless suite forms before a run can reach the suite stage', () => {
  for (const suffix of [['--suite'], ['--suite', ''], ['--suite', '   '], ['--suite', '--checkout', CLI_REPO_ROOT]]) {
    const result = cliEntry('run', '--task', CLI_PROBE_TASK, '--brief-file', CLI_PROBE_BRIEF, ...suffix)
    assert.equal(result.status, 2, suffix.join(' '))
    assert.match(result.output, /--suite/, suffix.join(' '))
  }
  const good = cliEntry('run', '--task', CLI_PROBE_TASK, '--brief-file', CLI_PROBE_BRIEF, '--suite', 'npm test')
  assert.notEqual(good.status, 2)
  assert.match(good.output, /no crew booted/)
})

test('resolveTimeoutS refuses coercive values and accepts the closed numeric range', () => {
  const hostile = ['abc', '8080abc', '0x10', '1e3', 'Infinity', 'NaN', '-1', '0', '1.5', true, '', '   ', '21601']
  for (const raw of hostile) {
    assert.throws(() => resolveTimeoutS(raw), (err) => err.reason === TIMEOUT_S_REFUSAL, JSON.stringify(raw))
  }
  for (const raw of [undefined, null]) assert.equal(resolveTimeoutS(raw), TIMEOUT_S_DEFAULT)
  for (const [raw, expected] of [['1', 1], [5, 5], ['3600', 3600], ['21600', 21600]]) {
    assert.equal(resolveTimeoutS(raw), expected)
  }

  const home = mkdtempSync(join(tmpdir(), 'crew-timeout-cli-home-'))
  const task = 'timeout-cli'
  const repoSlug = basename(CLI_REPO_ROOT).toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const returns = join(home, '.crew', repoSlug, task, 'returns')
  mkdirSync(returns, { recursive: true })
  writeFileSync(join(returns, 'task.json'), JSON.stringify({ status: 'done', summary: 'settled', artifacts: [], details: {} }))
  const entry = fileURLToPath(new URL('./crew.mjs', import.meta.url))
  const options = { cwd: CLI_REPO_ROOT, encoding: 'utf8', env: { ...CLI_ENV, HOME: home } }
  try {
    const settled = spawnSync(process.execPath, [entry, 'wait', '--task', task, '--checkout', CLI_REPO_ROOT, '--timeout-s', '5'], options)
    assert.equal(settled.status, 0, settled.stderr)
    assert.match(settled.stdout, /"status":"done"/)
    const invalid = spawnSync(process.execPath, [entry, 'wait', '--task', task, '--checkout', CLI_REPO_ROOT, '--timeout-s', 'abc'], options)
    assert.notEqual(invalid.status, 0)
    assert.match(`${invalid.stdout}${invalid.stderr}`, /invalid-timeout-s/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('run exit constants preserve done, escalation, and unexpected meanings', () => {
  assert.deepEqual(RUN_EXIT_CODES, { done: 0, escalation: 3 })
  assert.equal(RUN_EXIT_UNEXPECTED, 1)
  assert.equal(runExitCode({ status: 'anything-else' }), RUN_EXIT_UNEXPECTED)
})

test('run exits 3 on an escalation, 0 on done, and 1 on anything else', () => {
  for (const [result, expected] of [
    [{ status: 'done' }, 0], [{ status: 'escalation' }, 3], [{ status: 'blocked' }, 1],
    [{ status: 'converge' }, 1], [{}, 1], [null, 1],
  ]) assert.equal(runExitCode(result), expected)
})

test('runOutcome preserves legacy status and maps every typed terminal outcome', () => {
  assert.deepEqual(runOutcome({ status: 'done' }), {
    status: 'ok', outcome: 'success', terminal_reason: null, terminal_actor: null,
  })
  for (const [result, expected] of RUN_OUTCOME_CASES) assert.deepEqual(runOutcome(result), expected)
  for (const result of [{ status: 'converge' }, { status: 'unknown' }, {}, null]) {
    assert.deepEqual(runOutcome(result), {
      status: 'aborted', outcome: 'aborted', terminal_reason: typeof result?.status === 'string' ? result.status : null, terminal_actor: 'driver',
    })
  }
})

test('child ledger rows match the shared runOutcome table', () => {
  if (!nodeMeetsLedgerFloor) return
  const root = scratchDir('crew-child-outcome-agreement-')
  const dbPath = join(root, 'ledger', 'ledger.db')
  const cases = [
    ['done', { status: 'done' }],
    ...RUN_OUTCOME_CASES.slice(0, 2).map(([envelope], index) => [`escalation-${index + 1}`, envelope]),
  ]
  const runs = []
  try {
    for (const [key, envelope] of cases) {
      const stateDir = scratchDir(`crew-child-outcome-${key}-`)
      const crewDir = join(stateDir, 'crew')
      const returnsDir = join(crewDir, 'returns')
      const task = `child-outcome-${key}`
      const taskReturn = join(returnsDir, 'task.json')
      const roles = ['planner', 'builder', 'reviewer']
      const members = Object.fromEntries(roles.map((role) => [role, { model: 'x', transport: 'headless-json' }]))
      mkdirSync(join(crewDir, 'task'), { recursive: true })
      mkdirSync(returnsDir, { recursive: true })
      writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({ task, checkout: stateDir, roles, members, task_return: taskReturn }))
      writeFileSync(join(crewDir, 'journal.jsonl'), '')
      const result = runChild({ crew_dir: crewDir, task, checkout: stateDir, task_return: taskReturn, ledger_db: dbPath }, {
        preflight: false,
        driveTask: () => envelope,
        seatIo: () => ({}),
      })
      assert.deepEqual(result, envelope)
      runs.push({ task, envelope })
    }
    const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
    try {
      const rows = ledger.dumpTable('sessions')
      for (const { task, envelope } of runs) {
        const row = rows.find((candidate) => candidate.task_slug === task)
        assert.ok(row, `missing child session row for ${task}`)
        assert.deepEqual(
          { status: row.status, outcome: row.outcome, terminal_reason: row.terminal_reason, terminal_actor: row.terminal_actor },
          runOutcome(envelope),
          task,
        )
      }
    } finally { ledger.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('installExitMarker writes one terminal line for normal, signal and uncaught exits', () => {
  const handlers = {}
  const events = []
  const exits = []
  const install = () => installExitMarker({
    on: (event, handler) => { handlers[event] = handler },
    write: (text) => events.push(['write', text]),
    stderr: (text) => events.push(['stderr', text]),
    exit: (code) => exits.push(code),
  })

  install()
  handlers.exit(0)
  assert.deepEqual(events, [['write', '{"status":"exited","code":0}\n']])
  assert.equal(terminalLineSeen(), true)

  events.length = 0
  install()
  writeTerminalLine({ status: 'done' }, (text) => events.push(['write', text]))
  handlers.exit(0)
  assert.deepEqual(events, [['write', '{"status":"done"}\n']])

  events.length = 0
  install()
  handlers.SIGTERM()
  assert.deepEqual(events, [['write', '{"status":"exited","signal":"SIGTERM"}\n']])
  assert.equal(exits.at(-1), 143)

  events.length = 0
  install()
  handlers.SIGINT()
  assert.deepEqual(events, [['write', '{"status":"exited","signal":"SIGINT"}\n']])
  assert.equal(exits.at(-1), 130)

  events.length = 0
  install()
  handlers.uncaughtException(new Error('marker boom'))
  assert.equal(events[0][0], 'stderr')
  assert.match(events[0][1], /Error: marker boom/)
  assert.deepEqual(events[1], ['write', '{"status":"exited","code":1}\n'])
  assert.equal(exits.at(-1), 1)
})

test('a real SIGTERM leaves exactly one exit marker on a child stdout', async () => {
  const root = scratchDir('crew-exit-marker-')
  const script = join(root, 'marker-child.mjs')
  writeFileSync(script, `import { installExitMarker } from ${JSON.stringify(new URL('./crew.mjs', import.meta.url).href)}\ninstallExitMarker()\nprocess.stderr.write('ready\\n')\nsetTimeout(() => process.exit(0), Number(process.env.CREW_TEST_KEEPALIVE_LIFETIME_MS || ${KEEPALIVE_LIFETIME_DEFAULT_MS}))\nsetInterval(() => {}, 1000)\n`)
  let child
  let output = ''
  try {
    const result = await new Promise((resolve, reject) => {
      child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] })
      const timeout = setTimeout(() => {
        try { child.kill('SIGKILL') } catch {}
        reject(new Error('exit marker child timed out'))
      }, 5000)
      child.stdout.on('data', (chunk) => { output += String(chunk) })
      let stderr = ''
      let signalled = false
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk)
        if (!signalled && stderr.includes('ready\n')) {
          signalled = true
          try { child.kill('SIGTERM') } catch {}
        }
      })
      child.once('error', reject)
      child.once('close', (code, signal) => { clearTimeout(timeout); resolve({ code, signal }) })
    })
    const lines = output.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.deepEqual(lines, [{ status: 'exited', signal: 'SIGTERM' }])
    assert.equal(result.code, 143)
    assert.equal(result.signal, null)
  } finally {
    if (child && child.exitCode == null && child.signalCode == null) {
      try { child.kill('SIGKILL') } catch {}
    }
    rmSync(root, { recursive: true, force: true })
  }
})

test('ZFD1', () => {
  const calls = []
  const emitter = { installFinalizer() { calls.push('finalizer'); throw new Error('instrumentation failed') } }
  assert.doesNotThrow(() => installRunFinalizers(emitter, { installExitMarkerFn: () => calls.push('marker') }))
  assert.deepEqual(calls, ['finalizer', 'marker'])
})

test('ZFF1', () => {
  const home = scratchDir('crew-run-finalizer-fail-home-')
  const entry = fileURLToPath(new URL('./crew.mjs', import.meta.url))
  const env = { ...CLI_ENV, HOME: home }
  try {
    for (const verb of ['boot', 'handoff', 'wait', 'status', 'teardown']) {
      const child = spawnSync(process.execPath, [entry, verb, '--bogus'], { cwd: CLI_REPO_ROOT, encoding: 'utf8', env })
      const output = `${child.stdout || ''}${child.stderr || ''}`
      assert.equal(child.status, 2, verb)
      assert.doesNotMatch(output, /\{"status":"exited"/, verb)
    }
    const run = spawnSync(process.execPath, [entry, 'run', '--task', 'run-finalizer-failure', '--brief-file', join(home, 'missing.md'), '--bogus'], {
      cwd: CLI_REPO_ROOT, encoding: 'utf8', env,
    })
    const output = `${run.stdout || ''}${run.stderr || ''}`
    assert.equal(run.status, 2)
    assert.equal((output.match(/\{"status":"exited"/g) || []).length, 1)
    assert.match(output, /\{"status":"exited","code":2\}\n/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('C1 operator stop settles a real attended run blocked synchronously', { skip: !nodeMeetsLedgerFloor, timeout: 30_000 }, async () => {
  const fixture = stopRunFixture({ task: 'stop-blocked-sync' })
  let run
  try {
    run = await invokeRun(fixture)
    const before = await readStopSession(fixture)
    assert.equal(before.status, 'running')
    const stopped = await invokeStop(fixture, run.pid)
    assert.equal(stopped.code, 0, stopped.stderr)
    const result = JSON.parse(stopped.stdout)
    assert.equal(result.sigkill_required, true, JSON.stringify({ stopped, result }))
    assert.equal(result.status, 'aborted')
    assert.equal(run.exitCode === null && run.signalCode === null, false)
    const closed = await childClose(run)
    assert.equal(closed.signal, 'SIGKILL')
    const session = await readStopSession(fixture, { until: (row) => row != null && row.status !== 'running' })
    assert.equal(session.status, 'aborted')
    assert.equal(session.outcome, 'aborted')
    assert.equal(session.terminal_reason, 'operator-stop')
    assert.equal(session.terminal_actor, 'operator')
  } finally {
    if (run && run.exitCode === null && run.signalCode === null) { try { run.kill('SIGKILL') } catch {} }
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('D1 operator stop records the closed operator outcome', { skip: !nodeMeetsLedgerFloor, timeout: 15_000 }, async () => {
  const fixture = stopRunFixture({ task: 'stop-cooperative', cooperative: true })
  let run
  try {
    run = spawn(process.execPath, [fixture.entry, 'run', '--task', fixture.task, '--checkout', fixture.checkout], {
      cwd: fixture.checkout,
      env: { ...CLI_ENV, HOME: fixture.home, DEVTEAM_LEDGER_DB: fixture.dbPath, CREW_CLAUDE_BIN: fixture.workerBin },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    run.stdout.on('data', () => {})
    run.stderr.on('data', () => {})
    await waitForStopFixtureFile(fixture, run, fixture.readyPath)
    const stopped = await invokeStop(fixture, run.pid)
    assert.equal(stopped.code, 0, stopped.stderr)
    const result = JSON.parse(stopped.stdout)
    assert.deepEqual({ status: result.status, outcome: result.outcome, terminal_reason: result.terminal_reason, terminal_actor: result.terminal_actor }, {
      status: 'aborted', outcome: 'aborted', terminal_reason: 'operator-stop', terminal_actor: 'operator',
    })
    await childClose(run)
    const session = await readStopSession(fixture, { until: (row) => row != null && row.status !== 'running' })
    assert.equal(session.status, 'aborted')
    assert.equal(session.outcome, 'aborted')
    assert.equal(session.terminal_reason, 'operator-stop')
    assert.equal(session.terminal_actor, 'operator')
  } finally {
    if (run && run.exitCode === null && run.signalCode === null) { try { run.kill('SIGKILL') } catch {} }
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('RV1-1 run survives SIGTERM while awaitSeatsReady holds the prologue', async () => {
  const fixture = prologueSignalFixture()
  let child
  const state = { closed: null, error: null }
  try {
    child = spawn(process.execPath, [fileURLToPath(new URL('./crew.mjs', import.meta.url)), 'run', '--task', fixture.task, '--checkout', fixture.checkout, '--brief-file', fixture.brief, '--keep'], {
      cwd: CLI_REPO_ROOT,
      env: { ...CLI_ENV, HOME: fixture.home, CMUX_BIN: fixture.cmuxPath, CREW_PROLOGUE_READY: fixture.readyPath, DEVTEAM_LEDGER_DB: join(fixture.root, 'ledger.db') },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', () => {})
    child.stderr.on('data', () => {})
    child.once('error', (err) => { state.error = err })
    child.once('close', (code, signal) => { state.closed = { code, signal } })
    await waitForPrologueReady(fixture, child, state)
    assert.equal(child.kill('SIGTERM'), true)
    await assertPrologueSurvivesSigterm(child, state)
  } finally {
    if (child?.pid) {
      const closed = waitForPrologueChildClose(child, state)
      if (child.exitCode == null && child.signalCode == null) {
        try { child.kill('SIGKILL') } catch {}
      }
      await closed
    }
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('crew CLI usage documents all per-run round budget flags', () => {
  const source = readFileSync(new URL('./crew.mjs', import.meta.url), 'utf8')
  assert.match(source, /--plan-rounds/)
  assert.match(source, /--build-rounds/)
  assert.match(source, /--review-rounds/)
  assert.match(source, /--validation-lane/)
})

test('tier boot with no breaker policy reads no ledger and omits breaker journal data', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-breaker-plain-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-breaker-plain-checkout-')
  const dbPath = join(home, 'ledger.db')
  const openLedger = callCounter()
  try {
    await withBreakerEnv({ DEVTEAM_LEDGER_DB: dbPath }, () => withHome(home, () => bootCmd(
      { task: 'breaker-plain', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), openLedger },
    )))
    const dir = testCrewDir(home, checkout, 'breaker-plain')
    assert.equal(existsSync(join(dir, 'crew.json')), true)
    assert.equal(openLedger.calls.length, 0)
    assert.equal(Object.hasOwn(bootRecord(dir), 'breaker'), false)
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }) }
})

test('a configured boot can pin a nonexistent ledger and skip an injected opener', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-breaker-missing-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-breaker-missing-checkout-')
  const dbPath = join(home, 'missing-ledger.db')
  const openLedger = fakeBreakerLedger([breakerRow({ failures: 1 })])
  try {
    await withBreakerEnv({ CREW_BREAKER_THRESHOLD: '0.2', DEVTEAM_LEDGER_DB: dbPath }, () => withHome(home, () => bootCmd(
      { task: 'breaker-missing', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), openLedger, existsSync: () => false },
    )))
    const breaker = bootRecord(testCrewDir(home, checkout, 'breaker-missing')).breaker
    assert.equal(breaker.verdict, 'unmeasured')
    assert.equal(breaker.cells[0].denominator, 0)
    assert.equal(openLedger.calls.length, 0)
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }) }
})

test('an injected opener without existsSync reads rows and refuses before state or cmux seats exist', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-breaker-open-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-breaker-open-checkout-')
  const dbPath = join(home, 'ledger.db')
  writeFileSync(dbPath, 'fake ledger')
  const openLedger = fakeBreakerLedger([breakerRow({ failures: 3 })])
  const cmux = callCounter(); const tree = callCounter(); const renameTab = callCounter()
  try {
    const dir = testCrewDir(home, checkout, 'breaker-open')
    await withBreakerEnv({ CREW_BREAKER_THRESHOLD: '0.2', DEVTEAM_LEDGER_DB: dbPath }, () => withHome(home, () => assert.rejects(
      () => bootCmd(
        { task: 'breaker-open', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux, tree, renameTab, openLedger },
      ),
      (error) => {
        assert.equal(error.code, 'breaker-open')
        for (const value of ['muse-spark-1.3-contributor', '--model-', '--agent-', '--tier']) assert.ok(error.message.includes(value), `missing ${value}`)
        return true
      },
    )))
    assert.equal(existsSync(dir), false)
    assert.equal(cmux.calls.length, 0)
    assert.equal(tree.calls.length, 0)
    assert.equal(renameTab.calls.length, 0)
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }) }
})

test('an unreadable ledger still refuses boot', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-breaker-degraded-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-breaker-degraded-checkout-')
  const dbPath = join(home, 'ledger.db')
  writeFileSync(dbPath, 'fake ledger')
  const openLedger = fakeBreakerLedger([], { degraded: true })
  const cmux = callCounter(); const tree = callCounter(); const renameTab = callCounter()
  try {
    let error
    await withBreakerEnv({ CREW_BREAKER_THRESHOLD: '0.2', DEVTEAM_LEDGER_DB: dbPath }, () => withHome(home, () => assert.rejects(
      () => bootCmd(
        { task: 'breaker-degraded', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux, tree, renameTab, openLedger },
      ),
      (candidate) => { error = candidate; return candidate.code === 'breaker-unmeasurable' },
    )))
    assert.equal(error.code, 'breaker-unmeasurable')
    assert.doesNotMatch(error.message, /breaker-open/)
    assert.equal(existsSync(testCrewDir(home, checkout, 'breaker-degraded')), false)
    assert.equal(cmux.calls.length, 0)
    assert.equal(tree.calls.length, 0)
    assert.equal(renameTab.calls.length, 0)
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }) }
})

test('a below-threshold breaker verdict is journaled alongside allocation', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-breaker-healthy-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-breaker-healthy-checkout-')
  const dbPath = join(home, 'ledger.db')
  writeFileSync(dbPath, 'fake ledger')
  const openLedger = fakeBreakerLedger([breakerRow({ failures: 1 })], { attemptRows: [
    breakerAttempt(),
    breakerAttempt({ provider: 'anthropic', model_id: 'claude-opus-5-5', agent: 'claude', effort: 'high', role: 'lead' }),
    breakerAttempt({ provider: 'openai', model_id: 'gpt-6-sol', agent: 'pi', effort: 'medium', role: 'planner' }),
    breakerAttempt({ provider: 'anthropic', model_id: 'claude-opus-5-5', agent: 'claude', effort: 'high', role: 'reviewer' }),
  ] })
  try {
    await withBreakerEnv({ CREW_BREAKER_THRESHOLD: '0.2', CREW_BREAKER_WINDOW_MS: '3600000', DEVTEAM_LEDGER_DB: dbPath }, () => withHome(home, () => bootCmd(
      { task: 'breaker-healthy', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), openLedger },
    )))
    const breaker = bootRecord(testCrewDir(home, checkout, 'breaker-healthy')).breaker
    assert.equal(breaker.verdict, 'closed')
    assert.equal(breaker.threshold_rate, 0.2)
    assert.equal(breaker.window_ms, 3600000)
    const breakerCell = breaker.cells.find((cell) => cell.provider === 'meta' && cell.model_id === 'muse-spark-1.3-contributor' && cell.agent === 'pi' && cell.effort === 'medium')
    assert.ok(breakerCell)
    assert.equal(breakerCell.numerator, 1)
    assert.equal(breakerCell.denominator, 12)
    assert.equal(breakerCell.measured, true)
    assert.ok(breaker.since)
    assert.ok(bootRecord(testCrewDir(home, checkout, 'breaker-healthy')).allocation)
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }) }
})

test('a breaker refusal records no cell failure of its own', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-breaker-self-feed-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-breaker-self-feed-checkout-')
  const dbPath = join(home, 'ledger.db')
  const seeded = openLedger({ dbPath, stderr: { write: () => {} } })
  seeded.cellFailures({ since: null })
  seeded.close()
  const fake = fakeBreakerLedger([breakerRow({ failures: 3 })])
  try {
    await withBreakerEnv({ CREW_BREAKER_THRESHOLD: '0.2', DEVTEAM_LEDGER_DB: dbPath }, () => withHome(home, () => assert.rejects(
      () => bootCmd(
        { task: 'breaker-self-feed', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), openLedger: fake },
      ),
      (error) => error.code === 'breaker-open',
    )))
    if (!nodeMeetsLedgerFloor) return
    const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
    assert.deepEqual(ledger.dumpTable('cell_failures'), [])
    ledger.close()
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }) }
})

test('a mixed boot refuses with mixed-transport before any workspace or state dir exists', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-mixed-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-mixed-checkout-')
  const task = 'mixed'
  const cmux = callCounter()
  const paneRoles = ['lead', 'planner', 'reviewer']
  let treeCalls = 0
  const tree = (...args) => {
    tree.calls.push(args)
    treeCalls += 1
    if (treeCalls === 1) return { windows: [] }
    return { windows: [{ id: 'window-1', workspaces: [{ id: 'workspace-1', name: `crew-${task}`, panes: paneRoles.map((role) => ({ id: `pane-${role}`, surfaces: [{ id: `surface-${role}`, name: role }] })) }] }] }
  }
  tree.calls = []
  const renameTab = callCounter()
  try {
    await withHome(home, () => assert.rejects(
      () => bootCmd(
        { task, checkout, roles: 'lead,planner,builder,reviewer', headless: 'builder', 'claude-bin': process.execPath },
        { cmux, tree, renameTab, register: capabilityRegisterForBoot() },
      ),
      (err) => {
        assert.equal(err.code, 'mixed-transport')
        assert.match(err.message, /builder/)
        assert.match(err.message, /headless-json/)
        assert.match(err.message, /--headless-all/)
        assert.match(err.message, /\bpanes?\b/)
        return true
      },
    ))
    assert.equal(cmux.calls.length, 0)
    assert.equal(tree.calls.length, 0)
    assert.equal(existsSync(testCrewDir(home, checkout, task)), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('C1 boot records each seat\'s charter costs within an independent tail budget', async () => {
  const roles = ['lead', 'planner', 'builder', 'reviewer', 'tech-lead']
  const home = scratchDir('crew-charter-boot-home-')
  const { root: checkoutRoot, checkout } = testCheckout('crew-charter-boot-checkout-')
  const task = 'charter-boot'
  const controlTask = 'charter-boot-control'
  execSync('git init -q', { cwd: checkout })
  let output = ''
  const previousWrite = process.stdout.write
  try {
    process.stdout.write = (chunk) => { output += String(chunk); return true }
    try {
      await withoutMemoryEnv(() => withHome(home, async () => {
        await bootCmd(
          { task: controlTask, checkout, roles: roles.join(','), 'headless-all': true, 'claude-bin': process.execPath },
          { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), register: capabilityRegisterForBoot() },
        )
        await bootCmd(
          { task, checkout, roles: roles.join(','), 'headless-all': true, 'claude-bin': process.execPath, 'charter-arm': 'terse-tail' },
          { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), register: capabilityRegisterForBoot() },
        )
      }))
    } finally { process.stdout.write = previousWrite }
    const control = bootRecord(testCrewDir(home, checkout, controlTask))
    const dir = testCrewDir(home, checkout, task)
    const boot = bootRecord(dir)
    const crew = JSON.parse(readFileSync(join(dir, 'crew.json'), 'utf8'))
    const result = JSON.parse(output.trim().split('\n').at(-1))
    assert.equal(crew.charter_arm, 'terse-tail')
    assert.equal(boot.charter_arm, crew.charter_arm)
    assert.equal(result.charter_arm, crew.charter_arm)
    assert.deepEqual(result.charter_bytes, boot.charter_bytes)
    for (const role of roles) {
      const expected = Buffer.byteLength(readFileSync(join(dir, 'task', `role-${role}.md`), 'utf8'), 'utf8')
      assert.equal(boot.charter_bytes[role], expected)
      assert.equal(boot.charter_memory_bytes[role], 0)
      assert.equal(control.charter_base_bytes[role], CHARTER_CEILINGS[role])
      const sharedPrompt = readFileSync(new URL('./roles/_shared.md', import.meta.url), 'utf8')
      const cardPrompt = readFileSync(new URL(`./roles/${role}.md`, import.meta.url), 'utf8')
      const controlPrompt = composeRolePrompt(sharedPrompt, cardPrompt, '', 'control')
      const tersePrompt = composeRolePrompt(sharedPrompt, cardPrompt, '', 'terse-tail')
      const controlBytes = Buffer.byteLength(controlPrompt, 'utf8')
      const terseBytes = Buffer.byteLength(tersePrompt, 'utf8')
      const delta = terseBytes - controlBytes
      // The terse tail appends to the control prompt: the treatment differs by exactly the tail.
      assert.equal(controlBytes, CHARTER_CEILINGS[role])
      assert.equal(tersePrompt, controlPrompt + '\n\nBe terse: state the result in the fewest words that carry it, and do not restate context the reader already has.\n')
      assert.ok(delta > 0)
      assert.equal(boot.charter_base_bytes[role], terseBytes)
    }
  } finally {
    process.stdout.write = previousWrite
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('unconfigured boot keeps every merged prompt byte-identical and omits memory journal data', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-memory-plain-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-memory-plain-checkout-')
  try {
    await withoutMemoryEnv(() => withHome(home, () => bootCmd(
      { task: 'memory-plain', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
    )))
    const dir = testCrewDir(home, checkout, 'memory-plain')
    const shared = readFileSync(new URL('./roles/_shared.md', import.meta.url), 'utf8')
    for (const role of ['lead', 'planner', 'builder', 'reviewer']) {
      const card = readFileSync(new URL(`./roles/${role}.md`, import.meta.url), 'utf8')
      assert.equal(readFileSync(join(dir, 'task', `role-${role}.md`), 'utf8'), composeRolePrompt(shared, card))
    }
    assert.equal(Object.hasOwn(bootRecord(dir), 'memory'), false)
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }) }
})

test('configured boot injects memory into lead and planner while builder and reviewer stay lean', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-memory-configured-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-memory-configured-checkout-')
  const fixture = memoryFixture()
  try {
    await withoutMemoryEnv(() => withHome(home, async () => {
      const base = { checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath }
      await bootCmd({ ...base, task: 'memory-plain' }, { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() })
      await bootCmd({ ...base, task: 'memory-armed', 'memory-dir': fixture }, { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() })
    }))
    const plain = testCrewDir(home, checkout, 'memory-plain')
    const armed = testCrewDir(home, checkout, 'memory-armed')
    for (const role of ['lead', 'planner']) {
      const prompt = readFileSync(join(armed, 'task', `role-${role}.md`), 'utf8')
      assert.match(prompt, /## Team memory/)
      assert.match(prompt, /first hook/)
    }
    for (const role of ['builder', 'reviewer']) {
      assert.equal(
        readFileSync(join(armed, 'task', `role-${role}.md`), 'utf8'),
        readFileSync(join(plain, 'task', `role-${role}.md`), 'utf8'),
      )
    }
    assert.deepEqual([...MEMORY_ROLES], ['lead', 'planner'])
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }); rmSync(fixture, { recursive: true, force: true }) }
})

test('configured boot with a missing memory directory succeeds and records no-dir', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-memory-missing-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-memory-missing-checkout-')
  const missing = join(home, 'not-present')
  try {
    await withoutMemoryEnv(() => withHome(home, () => bootCmd(
      { task: 'memory-missing', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath, 'memory-dir': missing },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
    )))
    const dir = testCrewDir(home, checkout, 'memory-missing')
    const shared = readFileSync(new URL('./roles/_shared.md', import.meta.url), 'utf8')
    for (const role of ['lead', 'planner', 'builder', 'reviewer']) {
      const card = readFileSync(new URL(`./roles/${role}.md`, import.meta.url), 'utf8')
      assert.equal(readFileSync(join(dir, 'task', `role-${role}.md`), 'utf8'), composeRolePrompt(shared, card))
    }
    assert.equal(bootRecord(dir).memory.reason, 'no-dir')
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }) }
})

test('unknown memory backend cannot fail boot and records its error', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-memory-backend-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-memory-backend-checkout-')
  const fixture = memoryFixture()
  try {
    await withoutMemoryEnv(() => withHome(home, () => bootCmd(
      { task: 'memory-backend', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath, 'memory-dir': fixture, 'memory-backend': 'no-such-backend' },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
    )))
    const dir = testCrewDir(home, checkout, 'memory-backend')
    const shared = readFileSync(new URL('./roles/_shared.md', import.meta.url), 'utf8')
    for (const role of ['lead', 'planner']) {
      const card = readFileSync(new URL(`./roles/${role}.md`, import.meta.url), 'utf8')
      assert.equal(readFileSync(join(dir, 'task', `role-${role}.md`), 'utf8'), composeRolePrompt(shared, card))
    }
    assert.match(bootRecord(dir).memory.error, /no-such-backend/)
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }); rmSync(fixture, { recursive: true, force: true }) }
})

test('configured boot journal records memory byte and inclusion/drop counts', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-memory-record-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-memory-record-checkout-')
  const fixture = memoryFixture()
  try {
    await withoutMemoryEnv(() => withHome(home, () => bootCmd(
      { task: 'memory-record', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath, 'memory-dir': fixture },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
    )))
    const record = bootRecord(testCrewDir(home, checkout, 'memory-record')).memory
    assert.equal(typeof record.bytes, 'number')
    assert.ok(record.bytes > 0)
    assert.equal(typeof record.included, 'number')
    assert.equal(typeof record.dropped, 'number')
    assert.deepEqual(record.injected, ['lead', 'planner'])
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }); rmSync(fixture, { recursive: true, force: true }) }
})

test('a tiny memory budget records dropped extracts even when no section is injected', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-memory-budget-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-memory-budget-checkout-')
  const fixture = memoryFixture()
  try {
    await withoutMemoryEnv(() => withHome(home, () => bootCmd(
      { task: 'memory-budget', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath, 'memory-dir': fixture, 'memory-budget-bytes': '1' },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
    )))
    const record = bootRecord(testCrewDir(home, checkout, 'memory-budget')).memory
    assert.deepEqual(record.injected, [])
    assert.equal(record.bytes, 0)
    assert.ok(record.dropped > 0)
    assert.equal(record.reason, null)
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }); rmSync(fixture, { recursive: true, force: true }) }
})

test('bootCmd and runCmd pass explicit fresh and warm readiness modes', async () => {
  const home = scratchDir('crew-ready-mode-home-')
  const { root: checkoutRoot, checkout } = testCheckout('crew-ready-mode-checkout-')
  const brief = join(home, 'brief.md')
  const completionLog = join(home, 'completions.jsonl')
  writeFileSync(brief, '# brief\\n')
  execSync('git init -q', { cwd: checkout })
  const bootModes = []; const runModes = []
  const previousStdoutWrite = process.stdout.write
  const previousExitCode = process.exitCode
  try {
    await withCompletionEnv(home, completionLog, async () => {
      process.stdout.write = () => true
      await bootCmd(
        { task: 'ready-modes', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), awaitSeatsReady: (_crew, mode) => bootModes.push(mode) },
      )
      runCmd(
        { task: 'ready-modes', checkout, 'brief-file': brief, keep: true },
        {
          drive: () => ({ status: 'done', summary: '', artifacts: [], details: { commit: null } }),
          awaitSeatsReady: (_crew, mode) => runModes.push(mode),
        },
      )
    })
    assert.deepEqual(bootModes, ['fresh'])
    assert.deepEqual(runModes, ['warm'])
  } finally {
    process.stdout.write = previousStdoutWrite
    process.exitCode = previousExitCode
    rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('effort maps to claude --effort and pi --thinking; absent effort leaves both commands untouched', () => {
  const withEffort = seatCommand({ ...PI_SAMPLE, effort: 'xhigh' })
  assert.match(withEffort, /--effort "xhigh"/)
  assert.doesNotMatch(seatCommand(PI_SAMPLE), /--effort/)

  const piWith = piSeatCommand({ ...PI_SAMPLE, effort: 'high' })
  assert.match(piWith, /--thinking high/)
  assert.match(piWith, /--model google\/gemini-3-pro(\s|$)/, 'model id must stay untouched by effort')
  assert.doesNotMatch(piSeatCommand(PI_SAMPLE), /--thinking/)
})

test('adapter-pi.seatCommand carries every crew-supplied field and neither interactive-killing flag', () => {
  const cmd = piSeatCommand(PI_SAMPLE)
  assert.match(cmd, /DEVTEAM_WORKER=1/)
  assert.match(cmd, /CREW_ROLE=builder/)
  assert.match(cmd, /CREW_TASK_DIR="\/tmp\/crew-task"/)
  // deny "Task,Agent" translates to an empty pi tool list — pi has no
  // subagent tool at all, so the flag is omitted rather than sent empty.
  assert.doesNotMatch(cmd, /--exclude-tools/)
  assert.match(cmd, /--append-system-prompt "\/tmp\/crew-task\/role-builder\.md"/)
  // Pins the binary itself — nothing else in this suite fails if a copy-paste swaps 'pi' for another executable.
  assert.match(cmd, /(^|\s)pi(\s|$)/)
  // Anchored to the end and requires the closing quote: an unquoted or repositioned brief still needs to fail this.
  assert.match(cmd, /"Crew for task demo\..*wait\."$/)
  // Word-boundary regexes are mandatory here — a naive includes('-p ') matches --append-system-prompt and would fail a correct adapter.
  assert.doesNotMatch(cmd, /(^|\s)--print(\s|$)/)
  assert.doesNotMatch(cmd, /(^|\s)-p(\s|$)/)
  assert.doesNotMatch(cmd, /(^|\s)--no-session(\s|$)/)
})

test('adapter-pi.seatCommand translates a claude deny list into pi tool names', () => {
  const cmd = piSeatCommand({ ...PI_SAMPLE, role: 'planner', deny: 'Edit,NotebookEdit' })
  assert.match(cmd, /--exclude-tools "edit"/)
})

test('a provider-qualified model is passed through whole; a bare id is never narrowed to a provider', () => {
  const qualified = piSeatCommand({ ...PI_SAMPLE, model: 'google/gemini-3-pro' })
  assert.match(qualified, /--model google\/gemini-3-pro(\s|$)/)
  assert.doesNotMatch(qualified, /(^|\s)--provider(\s|$)/)

  const bare = piSeatCommand({ ...PI_SAMPLE, model: 'sonnet' })
  assert.doesNotMatch(bare, /(^|\s)--provider(\s|$)/)
  assert.match(bare, /--model sonnet(\s|$)/)
})

test('the --roster boot flag requires a value and is accepted when supplied', () => {
  assert.doesNotThrow(() => assertUsage('boot', { task: 'roster-flag', roster: '/dispatch/roster.json' }))
  assert.throws(() => assertUsage('boot', { task: 'roster-flag', roster: true }), /--roster/)
})

test('bootCmd refuses a below-floor raw override before state or driver side effects', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-band-floor-refusal-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-band-floor-refusal-checkout-')
  const task = 'band-floor-refusal'
  const cmux = callCounter(); const tree = callCounter(); const renameTab = callCounter()
  try {
    await withBreakerEnv({}, () => withHome(home, () => assert.rejects(
      () => bootCmd({ task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath, 'model-builder': 'anthropic/claude-haiku-4-5' }, { cmux, tree, renameTab }),
      (err) => {
        assert.equal(err.reason, 'band-below-floor')
        assert.match(err.message, /builder/)
        return true
      },
    )))
    assert.equal(cmux.calls.length, 0)
    assert.equal(tree.calls.length, 0)
    assert.equal(renameTab.calls.length, 0)
    assert.equal(existsSync(testCrewDir(home, checkout, task)), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('bootCmd accepts an at-floor raw override and preserves its untranslated record', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-band-floor-accept-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-band-floor-accept-checkout-')
  const task = 'band-floor-accepted'
  try {
    await withBreakerEnv({}, () => withHome(home, () => bootCmd(
      { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath, 'model-builder': 'openai-codex/gpt-6-luna' },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
    )))
    const record = JSON.parse(readFileSync(join(testCrewDir(home, checkout, task), 'crew.json'), 'utf8'))
    assert.equal(record.members.builder.provider, null)
    assert.equal(record.members.builder.id, null)
    assert.equal(record.members.builder.model, 'openai-codex/gpt-6-luna')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('every suite surface derives from package.json, the one owner', () => {
  const packagePath = new URL('../package.json', import.meta.url)
  const packageFile = fileURLToPath(packagePath)
  const crewPath = new URL('./crew.mjs', import.meta.url)
  const childPath = new URL('./child.mjs', import.meta.url)
  const workflowPath = new URL('../.github/workflows/test.yml', import.meta.url)
  const packageLane = JSON.parse(readFileSync(packagePath, 'utf8')).scripts?.test
  const OWNER_PROBE = 'node --test --test-timeout=30000 "**/b214-owner-probe.test.mjs"'
  const ownerDir = scratchDir('crew-suite-owner-')
  const probePath = join(ownerDir, 'package.json')
  const refusalPath = join(ownerDir, 'refusal.json')
  const absentPath = join(ownerDir, 'absent.json')
  const resolvers = [packageSuite, childPackageSuite]
  const assertRefusal = (resolver, path) => {
    assert.throws(() => resolver({ path }), (err) => {
      assert.equal(err.reason, SUITE_REFUSAL)
      assert.match(err.message, /\[suite-unreadable\]/)
      return true
    })
  }
  try {
    writeFileSync(probePath, `  ${JSON.stringify({ scripts: { test: OWNER_PROBE } })}  `)
    for (const resolver of resolvers) {
      assert.equal(resolver(), packageLane)
      assert.equal(resolver({ path: probePath }), OWNER_PROBE)
    }

    for (const value of [
      {}, { scripts: {} }, { scripts: { test: '   ' } }, { scripts: { test: 7 } }, '{not json',
    ]) {
      writeFileSync(refusalPath, typeof value === 'string' ? value : JSON.stringify(value))
      for (const resolver of resolvers) assertRefusal(resolver, refusalPath)
    }
    for (const resolver of resolvers) assertRefusal(resolver, absentPath)
  } finally { rmSync(ownerDir, { recursive: true, force: true }) }

  assert.equal(SUITE_OWNER_PATH, packageFile)
  assert.equal(CHILD_SUITE_OWNER_PATH, packageFile)

  for (const [name, path] of [['crew.mjs', crewPath], ['child.mjs', childPath]]) {
    const matchingLines = readFileSync(path, 'utf8').split('\n').flatMap((line, index) => /node\s+--test/.test(line) ? [`${index + 1}:${line}`] : [])
    assert.deepEqual(matchingLines, [], `${name} still carries suite-command literals at ${matchingLines.join(', ')}`)
  }
  const crewSource = readFileSync(crewPath, 'utf8')
  const childSource = readFileSync(childPath, 'utf8')
  assert.match(crewSource, /suite:\s*args\.suite\s*\|\|\s*packageSuite\(\)/)
  assert.match(childSource, /ctx\.suite\s*=\s*spec\.suite\s*\|\|\s*packageSuite\(\)/)

  const workflowRuns = [...readFileSync(workflowPath, 'utf8').matchAll(/^\s*-\s*run:\s*(.+?)\s*$/gm)].map((match) => match[1])
  assert.ok(workflowRuns.some((run) => /^npm (run )?test$/.test(run)), `expected npm test in ${workflowPath}`)
  assert.ok(!workflowRuns.some((run) => /^node\s+--test\b/.test(run)), `CI must not invoke raw node --test in ${workflowPath}`)

  const timeout = packageLane?.match(/--test-timeout=(\d+)/)
  assert.ok(timeout, `expected --test-timeout in package.json scripts.test at ${packagePath}`)
  assert.ok(Number(timeout[1]) >= 30000, `expected package.json scripts.test timeout >= 30000ms at ${packagePath}`)
})
test('register-backed grants flow into one emitted pi command', () => {
  const root = capabilityFixtureRoot()
  try {
    const register = capabilityRegister({ roles: {
      builder: { ...capabilityRegister().roles.builder,
        tools: ['task'], extensions: ['crew/pi/extensions/builderloop.ts'], skills: ['crew/pi/skills/scout.md'],
      },
    } })
    const grants = grantsFor(register, 'builder', { root })
    const command = piSeatCommand({ ...PI_SAMPLE, grants })
    assert.match(command, /--tools "[^"]*,task"/)
    assert.ok(command.includes(`-e "${join(root, 'crew/pi/extensions/builderloop.ts')}"`))
    assert.ok(command.includes(`--skill "${join(root, 'crew/pi/skills/scout.md')}"`))
    assert.doesNotMatch(command, /--no-skills/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('probeLocalEndpoint never throws and rejects only failures and 5xx responses', async () => {
  assert.equal(await probeLocalEndpoint('http://injected/ok', { fetchFn: async () => ({ status: 200 }) }), true)
  assert.equal(await probeLocalEndpoint('http://injected/client-error', { fetchFn: async () => ({ status: 404 }) }), true)
  assert.equal(await probeLocalEndpoint('http://injected/server-error', { fetchFn: async () => ({ status: 503 }) }), false)
  assert.equal(await probeLocalEndpoint('http://injected/throw', { fetchFn: async () => { throw new Error('offline') } }), false)
})

test('the shipped register is where the fan-out grant lives', async () => {
  const register = loadCapabilities()
  assert.deepEqual(Object.keys(register.roles), ROLE_ORDER)
  for (const role of ROLE_ORDER) {
    assert.deepEqual(register.roles[role].requires, SEAT_DEFAULTS[role].requires)
    assert.deepEqual(register.roles[role].tools, ['planner', 'reviewer'].includes(role) ? ['Task'] : [])
    assert.deepEqual(register.roles[role].extensions, [])
    assert.deepEqual(register.roles[role].agents, [])
    assert.deepEqual(register.roles[role].skills, [])
    assert.deepEqual(register.roles[role].by_agent?.pi?.skills ?? [], ['skills/lean-build/SKILL.md'])
    assert.deepEqual(register.roles[role].by_agent?.claude?.skills ?? [], ['skills/lean-build/SKILL.md'])
    assert.equal(register.roles[role].advisor, false)
  }
  for (const tier of Object.keys(roster.tiers)) {
    const { roles, seats } = resolveTier(roster, tier, {})
    await assert.doesNotReject(() => resolveAdapters(roles, {}, seats), `tier ${tier} must boot with shipped capabilities`)
  }
})

test('SEAT_DEFAULTS leaves fan-out grants to the register while preserving denials and requirements', () => {
  assert.doesNotMatch(SEAT_DEFAULTS.planner.tools, /Task/)
  assert.doesNotMatch(SEAT_DEFAULTS.reviewer.tools, /Task/)
  for (const role of ['lead', 'builder', 'tech-lead']) {
    for (const tool of FANOUT_TOOLS) assert.match(SEAT_DEFAULTS[role].deny, new RegExp(tool))
  }
  assert.deepEqual(SEAT_DEFAULTS.planner.requires, ['subagents'])
  for (const role of ['lead', 'builder', 'reviewer', 'tech-lead']) assert.deepEqual(SEAT_DEFAULTS[role].requires, [])
})

test('withheld register grants refuse planners with the closed capability-shortfall reason', async () => {
  const root = capabilityFixtureRoot()
  try {
    const base = capabilityRegister()
    const agentsOnly = capabilityRegister({ roles: {
      planner: { ...base.roles.planner, agents: [{ name: 'Explore', def: 'crew/pi/explore.json' }] },
    } })
    const assertWithheld = async (args, register) => assert.rejects(
      () => resolveAdapters(['planner'], args, null, { register, root }),
      (err) => {
        assert.equal(err.reason, 'capability-shortfall')
        assert.equal(err.role, 'planner')
        assert.match(err.message, /planner/)
        assert.match(err.message, /subagents/)
        assert.match(err.message, /crew\/capabilities\.json/)
        assert.doesNotMatch(err.message, /agent adapter/)
        return true
      },
    )
    await assertWithheld({}, base)
    await assertWithheld({}, agentsOnly)
    await assertWithheld({ 'agent-planner': 'pi' }, agentsOnly)
    assert.deepEqual([...CAPABILITY_REFUSALS], ['register-invalid', 'capability-shortfall', 'unknown-grant', 'grant-unsupported', 'extension-missing', 'unknown-skill', 'agent-def-invalid', 'local-settings-missing', 'local-provider-undeclared', 'local-endpoint-dead', 'grant-contradicts-deny', 'vendor-extension-missing', 'agent-unresolved', 'agent-provider-unsupported', 'agent-unavailable', 'local-provider-reserved'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a register granting fan-out to a seat whose defaults withhold it refuses at boot', async () => {
  const root = capabilityFixtureRoot()
  try {
    const base = capabilityRegister()
    const bundle = { tools: [], extensions: ['crew/pi/extensions/builderloop.ts'], agents: [{ name: 'Explore', def: 'crew/pi/explore.json' }], skills: [], advisor: false, requires: [] }
    // The contradiction is register-vs-charter, so it refuses on EVERY adapter.
    for (const role of ['lead', 'builder', 'tech-lead']) {
      assert.deepEqual(deniedFanout(role), [...FANOUT_TOOLS])
      const register = capabilityRegister({ roles: { [role]: { ...base.roles[role], ...bundle } } })
      for (const args of [{}, { [`agent-${role}`]: 'pi' }]) {
        await assert.rejects(
          () => resolveAdapters([role], args, null, { register, root }),
          (err) => {
            assert.equal(err.reason, 'grant-contradicts-deny')
            assert.ok(CAPABILITY_REFUSALS.includes(err.reason))
            assert.equal(err.role, role)
            assert.match(err.message, new RegExp(role))
            assert.match(err.message, /Task,Agent,Workflow/)
            assert.match(err.message, /Explore/)
            return true
          },
        )
      }
    }
    // The other direction: a role that legitimately fans out is untouched.
    assert.deepEqual(deniedFanout('planner'), [])
    assert.deepEqual(deniedFanout('reviewer'), [])
    const planner = capabilityRegister({ roles: { planner: { ...base.roles.planner, ...bundle, requires: ['subagents'] } } })
    const resolved = await resolveAdapters(['planner'], { 'agent-planner': 'pi' }, null, { register: planner, root })
    assert.equal(resolved.planner.grants.agents.length, 1)
    assert.deepEqual(assertFanoutCoherent('planner', resolved.planner.grants), resolved.planner.grants)
    // An agents-free grant to a denying seat is no contradiction.
    assert.deepEqual(assertFanoutCoherent('builder', EMPTY_GRANTS), EMPTY_GRANTS)
    // The refusal is wired into the boot seam, not merely exported.
    assert.match(readFileSync(new URL('./crew.mjs', import.meta.url), 'utf8'), /assertFanoutCoherent\(role, grants\)/)
    // translateDeny is UNCHANGED: it still drops every name it cannot map, which
    // is why the boundary has to live at boot.
    assert.deepEqual(translateDeny(SEAT_DEFAULTS.builder.deny), [])
    assert.deepEqual(translateDeny(SEAT_DEFAULTS.lead.deny), ['edit'])
    assert.deepEqual(translateDeny('Edit,NoSuchTool,Task'), ['edit'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a granted register boots and a shortfall waiver still boots degraded', async () => {
  const base = capabilityRegister()
  const granted = capabilityRegister({ roles: {
    planner: { ...base.roles.planner, tools: ['Task'] },
  } })
  const resolved = await resolveAdapters(['planner'], {}, null, { register: granted })
  assert.deepEqual(resolved.planner.grants.tools, ['Task'])
  const degraded = await resolveAdapters(['planner'], { 'allow-shortfall-planner': 'subagents' }, null, { register: base })
  assert.deepEqual(degraded.planner.grants.tools, [])
})

test('effectiveTools and the composed planner command preserve the effective allowlist', () => {
  const register = loadCapabilities()
  const grants = grantsFor(register, 'planner')
  assert.equal(effectiveTools('planner', grants), 'Read,Glob,Grep,Bash,Write,Task')
  const command = seatCommand({
    role: 'planner', model: 'opus', promptFile: '/tmp/role-planner.md', tools: SEAT_DEFAULTS.planner.tools,
    deny: SEAT_DEFAULTS.planner.deny, taskDir: '/tmp', bootBrief: 'boot', grants,
  })
  assert.match(command, /--allowedTools "Read,Glob,Grep,Bash,Write,Task"/)
})

test('headless boot records effective planner and reviewer allowlists', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-effective-tools-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-effective-tools-checkout-')
  try {
    await withBreakerEnv({}, () => withHome(home, () => bootCmd(
      { task: 'effective-tools', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
    )))
    const members = JSON.parse(readFileSync(join(testCrewDir(home, checkout, 'effective-tools'), 'crew.json'), 'utf8')).members
    assert.match(members.planner.tools, /(^|,)Task(,|$)/)
    assert.match(members.reviewer.tools, /(^|,)Task(,|$)/)
    assert.doesNotMatch(members.builder.tools, /(^|,)Task(,|$)/)
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }) }
})

test('a pi review seat keeps its built-in activator and deny boundary with register tools', () => {
  const base = capabilityRegister()
  const register = capabilityRegister({ roles: {
    reviewer: { ...base.roles.reviewer, tools: ['Task'] },
  } })
  const grants = grantsFor(register, 'reviewer')
  const command = piSeatCommand({
    ...PI_SAMPLE, role: 'reviewer', tools: SEAT_DEFAULTS.reviewer.tools, deny: SEAT_DEFAULTS.reviewer.deny, grants,
  })
  for (const name of PI_BUILTIN_TOOLS) assert.ok(command.includes(name), `missing pi built-in tool ${name}`)
  assert.match(command, /--tools "read,bash,edit,write,grep,find,ls,Task"/)
  assert.match(command, /--exclude-tools "edit"/)
  assert.doesNotMatch(command, /--exclude-tools "[^"]*Task/)
})

test('saturated boot refuses before state, workspace, or seat creation for tier and roles', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-load-order-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-load-order-checkout-')
  try {
    await withBreakerEnv({ CREW_LOAD_THRESHOLD: '1' }, () => withHome(home, async () => {
      for (const [task, extra] of [['load-tier', { tier: 'build', 'headless-all': true }], ['load-roles', { roles: 'lead,builder' }]]) {
        const cmux = callCounter(); const tree = callCounter(); const renameTab = callCounter()
        await assert.rejects(
          () => bootCmd({ task, checkout, ...extra, 'claude-bin': process.execPath }, { cmux, tree, renameTab, loadavg: () => [999, 0, 0], cpus: () => new Array(4).fill({}) }),
          (err) => err.code === 'host-load-open',
        )
        assert.equal(existsSync(testCrewDir(home, checkout, task)), false)
        assert.equal(cmux.calls.length, 0)
        assert.equal(tree.calls.length, 0)
        assert.equal(renameTab.calls.length, 0)
      }
    }))
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }) }
})

test('a host-load refusal records no cell failure of its own', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-load-self-feed-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-load-self-feed-checkout-')
  const dbPath = join(home, 'ledger.db')
  const seeded = openLedger({ dbPath, stderr: { write: () => {} } })
  seeded.cellFailures({ since: null })
  seeded.close()
  try {
    await withBreakerEnv({ CREW_LOAD_THRESHOLD: '2', DEVTEAM_LEDGER_DB: dbPath }, () => withHome(home, () => assert.rejects(
      () => bootCmd(
        { task: 'load-self-feed', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), loadavg: () => [999, 0, 0], cpus: () => new Array(4).fill({}) },
      ),
      (err) => err.code === 'host-load-open',
    )))
    if (!nodeMeetsLedgerFloor) return
    const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
    assert.deepEqual(ledger.dumpTable('cell_failures'), [])
    ledger.close()
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }) }
})

test('quiet host boots and journals measured load while unconfigured boot omits it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-load-journal-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-load-journal-checkout-')
  try {
    let quietLoadCalls = 0; let quietCpuCalls = 0
    await withBreakerEnv({ CREW_LOAD_THRESHOLD: '2' }, () => withHome(home, () => bootCmd(
      { task: 'load-quiet', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
      {
        cmux: callCounter(), tree: callCounter(), renameTab: callCounter(),
        loadavg: () => { quietLoadCalls += 1; return [4, 0, 0] },
        cpus: () => { quietCpuCalls += 1; return new Array(8).fill({}) },
      },
    )))
    const measured = bootRecord(testCrewDir(home, checkout, 'load-quiet')).load
    assert.equal(measured.verdict, 'quiet')
    assert.equal(measured.threshold, 2)
    assert.equal(measured.basis, 'os.loadavg()[0] / os.cpus().length')
    assert.equal(measured.load_1m, 4)
    assert.equal(measured.cores, 8)
    assert.equal(quietLoadCalls, 1)
    assert.equal(quietCpuCalls, 1)

    let plainLoadCalls = 0; let plainCpuCalls = 0
    await withBreakerEnv({}, () => withHome(home, () => bootCmd(
      { task: 'load-plain', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
      {
        cmux: callCounter(), tree: callCounter(), renameTab: callCounter(),
        loadavg: () => { plainLoadCalls += 1; return [0, 0, 0] },
        cpus: () => { plainCpuCalls += 1; return [{}] },
      },
    )))
    assert.equal(Object.hasOwn(bootRecord(testCrewDir(home, checkout, 'load-plain')), 'load'), false)
    assert.equal(plainLoadCalls, 0)
    assert.equal(plainCpuCalls, 0)
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }) }
})

test('advisor boot and manifest contracts stay closed and fail closed', () => {
  assert.equal(ADVISOR_CONFIG_VERSION, 1)
  assert.ok(Object.isFrozen(ADVISOR_BOOT_REFUSALS))
  assert.ok(ADVISOR_BOOT_REFUSALS.includes('adapter-unsupported'))
  assert.equal(String(SAFE_MODEL), '/^[A-Za-z0-9][A-Za-z0-9._:\\\/-]{0,127}$/')
  assert.deepEqual(classifyAdvisorCell({ endpoint: 'http://127.0.0.1/v1', model: 'qwen3-coder' }), { endpoint: 'http://127.0.0.1/v1', model: 'qwen3-coder' })
  const brief = 'tripwire tests:\n- crew/crew.mjs · bootCmd\nbroad keys (not used):\n'
  const manifest = advisorManifest({ briefText: brief, task: 'b69', runStartedAt: 1 })
  assert.deepEqual(manifest.tripwires, ['crew/crew.mjs'])
  assert.throws(() => assertAdvisorManifest({ granted: ['builder'], manifest: null, written: false }), /manifest/)
  assert.doesNotThrow(() => assertAdvisorManifest({ granted: [], manifest: null, written: false }))
})

test('#809 a LAN advisor endpoint is admitted and only http(s), userinfo and unsafe ids are refused', () => {
  assert.deepEqual(classifyAdvisorCell({ endpoint: 'http://192.168.1.42:8080/v1', model: 'qwen3-coder' }),
    { endpoint: 'http://192.168.1.42:8080/v1', model: 'qwen3-coder' })
  assert.deepEqual(classifyAdvisorCell({ endpoint: 'https://desktop2.lan/v1', model: 'qwen3-coder' }),
    { endpoint: 'https://desktop2.lan/v1', model: 'qwen3-coder' })
  assert.deepEqual(classifyAdvisorCell({ endpoint: 'ftp://192.168.1.42/v1', model: 'qwen3-coder' }), { reason: 'endpoint-not-local' })
  assert.deepEqual(classifyAdvisorCell({ endpoint: 'http:///v1', model: 'qwen3-coder' }), { reason: 'endpoint-not-local' })
  assert.deepEqual(classifyAdvisorCell({ endpoint: 'http://u:p@192.168.1.42/v1', model: 'qwen3-coder' }), { reason: 'endpoint-credentials' })
  assert.deepEqual(classifyAdvisorCell({ endpoint: 'http://192.168.1.42/v1', model: 'not safe' }), { reason: 'model-unsafe' })
})

test('#809 the advisor boot record carries host and port and the journal projection carries nothing else', () => {
  const record = advisorBootRecord({
    adapters: { builder: { grants: { advisor: true } } },
    env: { CREW_ADVISOR_ENDPOINT: 'http://user:sekrit@192.168.1.42:8080/v1', CREW_ADVISOR_MODEL: 'qwen3-coder' },
  })
  assert.equal(record.endpoint_host, '192.168.1.42')
  assert.equal(record.endpoint_port, 8080)
  assert.deepEqual(advisorEndpointOrigin('http://desktop2.lan/v1'), { host: 'desktop2.lan', port: 80 })
  assert.deepEqual(advisorEndpointOrigin('https://desktop2.lan/v1'), { host: 'desktop2.lan', port: 443 })
  assert.equal(advisorEndpointOrigin('not a url'), null)
  assert.equal(advisorEndpointOrigin('http:///v1'), null)
  const unset = advisorBootRecord({ adapters: { builder: { grants: { advisor: true } } }, env: {} })
  assert.equal(unset.endpoint_host, null)
  assert.equal(unset.endpoint_port, null)
  const row = advisorJournalRecord(record)
  assert.equal(Object.hasOwn(row, 'endpoint'), false)
  assert.doesNotMatch(JSON.stringify(row), /sekrit|\/v1/)
  assert.deepEqual(row, { granted: ['builder'], endpoint_host: '192.168.1.42', endpoint_port: 8080, model: 'qwen3-coder', config_version: ADVISOR_CONFIG_VERSION })
  // The boot journal is the redacted projection; crew.json keeps the full record
  // because paneCommand's advisorCell is built from it in the same process.
  const source = readFileSync(new URL('./crew.mjs', import.meta.url), 'utf8')
  assert.equal(source.split('advisor: advisorJournalRecord(advisorRecord)').length - 1, 1)
  assert.equal(source.split('advisor: advisorRecord }').length - 1, 1)
})

test('#809 an authority-less advisor endpoint refuses before a probe on the boot path', async () => {
  const adapters = { builder: { name: 'pi', transport: DEFAULT_TRANSPORT, grants: { advisor: true } } }
  const record = advisorBootRecord({ adapters: { builder: { grants: { advisor: true } } },
    env: { CREW_ADVISOR_ENDPOINT: 'http:///v1', CREW_ADVISOR_MODEL: 'qwen3-coder' } })
  assert.equal(record.endpoint_host, null)
  assert.equal(record.endpoint_port, null)
  let probes = 0
  let notes = 0
  await assert.rejects(
    () => assertAdvisorCellLive({ record, adapters, taskSlug: 't',
      probeEndpoint: async () => { probes += 1; return true }, note: () => { notes += 1 } }),
    (err) => {
      assert.equal(err.reason, 'endpoint-not-local')
      assert.doesNotMatch(err.message, /\/v1/)
      return true
    })
  assert.equal(probes, 0)
  assert.equal(notes, 0)
})

test('#809 a dead LAN advisor endpoint refuses the boot naming host and port, never a path or a credential', async () => {
  const adapters = { builder: { name: 'pi', transport: DEFAULT_TRANSPORT, grants: { advisor: true } } }
  const record = advisorBootRecord({ adapters: { builder: { grants: { advisor: true } } },
    env: { CREW_ADVISOR_ENDPOINT: 'http://192.168.1.42:8080/v1', CREW_ADVISOR_MODEL: 'qwen3-coder' } })
  const notes = []
  let probes = 0
  await assert.rejects(
    () => assertAdvisorCellLive({ record, adapters, taskSlug: 't',
      probeEndpoint: async () => { probes += 1; return false }, note: (row) => notes.push(row) }),
    (err) => {
      assert.equal(err.reason, 'endpoint-dead')
      assert.equal(err.stage, 'advisor-preflight')
      assert.match(err.message, /192\.168\.1\.42:8080/)
      assert.doesNotMatch(err.message, /loopback|\/v1/)
      return true
    })
  assert.equal(probes, 1)
  assert.equal(notes.length, 1)
  assert.equal(notes[0].member.transport, 'local-http')
  assert.equal(notes[0].cell.model, 'local/qwen3-coder')
  // A live LAN endpoint boots where loopback did, with one probe and no fallback.
  let liveProbes = 0
  await assertAdvisorCellLive({ record, adapters, taskSlug: 't',
    probeEndpoint: async () => { liveProbes += 1; return true }, note: () => { throw new Error('no cell failure is recorded on the accepting path') } })
  assert.equal(liveProbes, 1)
})

test('H1 planner advisor grant is admitted at boot', async () => {
  const endpoint = 'http://127.0.0.1:11434/v1'
  const env = { CREW_ADVISOR_ENDPOINT: endpoint, CREW_ADVISOR_MODEL: 'qwen3-coder' }
  const record = advisorBootRecord({
    adapters: { planner: { grants: { advisor: true } } }, env,
  })
  const adapters = { planner: { name: 'pi', transport: DEFAULT_TRANSPORT, grants: { advisor: true } } }
  let probes = 0
  await assertAdvisorCellLive({ record, adapters,
    probeEndpoint: async (url) => { probes += 1; assert.equal(url, endpoint); return true },
    note: () => { throw new Error('no refusal note belongs on the accepting path') },
  })
  assert.equal(probes, 1)
})

test('J1 boot retains adapter and transport refusals', async () => {
  const env = { CREW_ADVISOR_ENDPOINT: 'http://127.0.0.1:11434/v1', CREW_ADVISOR_MODEL: 'qwen3-coder' }
  const record = advisorBootRecord({
    adapters: { planner: { grants: { advisor: true } } }, env,
  })
  let probes = 0
  await assert.rejects(
    () => assertAdvisorCellLive({ record,
      adapters: { planner: { name: 'claude', transport: DEFAULT_TRANSPORT, grants: { advisor: true } } },
      probeEndpoint: async () => { probes += 1; return true },
    }),
    (err) => { assert.equal(err.reason, 'adapter-unsupported'); return true },
  )
  assert.equal(probes, 0)
  await assert.rejects(
    () => assertAdvisorCellLive({ record,
      adapters: { planner: { name: 'pi', transport: HEADLESS_TRANSPORT, grants: { advisor: true } } },
      probeEndpoint: async () => { probes += 1; return true },
    }),
    (err) => { assert.equal(err.reason, 'transport-unsupported'); return true },
  )
  assert.equal(probes, 0)
})

test('RV1-1 advisor vacuity pin stays synchronized', () => {
  // The entrypoint presence site (typeof advisor.default) was a flagged vacuity candidate and is
  // removed; only the import-firewall absence pin remains audited.
  const advisorTest = join(ROOT, 'crew', 'pi', 'extensions', 'advisor.test.mjs')
  const vacuityTest = join(ROOT, 'test', 'vacuity.test.mjs')
  const source = readFileSync(advisorTest, 'utf8')
  const vacuity = readFileSync(vacuityTest, 'utf8')
  const digest = createHash('sha256').update(source).digest('hex')
  const sourceAbsenceIdentity = `assert.does${'Not'}Match(source, /registerTool/)`
  const sourceLines = source.split('\n')
  const sourceAbsenceLine = sourceLines.findIndex((line) => line.trim() === sourceAbsenceIdentity) + 1
  assert.ok(sourceAbsenceLine > 0)
  assert.ok(vacuity.includes(`'crew/pi/extensions/advisor.test.mjs': '${digest}'`))
  assert.ok(vacuity.includes(`crew/pi/extensions/advisor.test.mjs:${sourceAbsenceLine}`))
})

test('RV2-1 emitTier0 remains journal-only', () => {
  const source = readFileSync(join(ROOT, 'crew', 'pi', 'extensions', 'advisor.ts'), 'utf8')
  const start = source.indexOf('  function emitTier0(')
  const end = source.indexOf('\n  function queue(', start)
  assert.ok(start >= 0 && end > start)
  const tierZero = source.slice(start, end)
  assert.match(tierZero, /notes\.push\(payload\)\n    return true/)
  assert.doesNotMatch(tierZero, /\bsend(?:\?\.|\s*\()/)
})

test('shadowCandidates deduplicates roster cells and retains their tiers', () => {
  const candidate = { provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'max' }
  const found = shadowCandidates({ tiers: {
    mechanical: { builder: candidate, lead: null },
    build: { builder: { ...candidate } },
    judge: { builder: { provider: 'openai', id: 'gpt-5.6-sol', agent: 'pi', effort: 'xhigh' } },
  } }, 'builder')
  assert.deepEqual(found, [
    { ...candidate, tiers: ['mechanical', 'build'] },
    { provider: 'openai', id: 'gpt-5.6-sol', agent: 'pi', effort: 'xhigh', tiers: ['judge'] },
  ])
  assert.deepEqual(shadowCandidates(null, 'builder'), [])
})

test('shadow exclusion and outcome vocabularies are frozen and closed', () => {
  assert.ok(Object.isFrozen(SHADOW_EXCLUSIONS))
  assert.ok(Object.isFrozen(SHADOW_OUTCOMES))
  assert.throws(() => shadowExclusion('invented'))
  assert.deepEqual(shadowExclusion('band-unknown', 'detail'), { reason: 'band-unknown', detail: 'detail' })
})

test('shadowPick ranks measured non-thin rates and leaves thin samples behind', () => {
  const localRoster = { schema_version: 1, tiers: {
    build: {
      planner: { provider: 'anthropic', id: 'claude-opus-5-5', agent: 'claude', effort: 'medium' },
      reviewer: { provider: 'openai', id: 'gpt-6-luna', agent: 'pi', effort: 'max' },
    },
    judge: { reviewer: { provider: 'openai', id: 'gpt-5.6-terra', agent: 'pi', effort: 'max' } },
  } }
  const record = shadowPick({
    roster: localRoster, tier: 'build', seats: { planner: localRoster.tiers.build.planner, reviewer: localRoster.tiers.build.reviewer },
    sources: { planner: { model: 'roster' }, reviewer: { model: 'roster' } }, ladder: loadLadder(), breaker: null,
    reviewRows: [
      { provider: 'openai', model_id: 'gpt-6-luna', agent: 'pi', effort: 'max', role: 'reviewer', reviews: 20, first_round_reviews: 20, first_round_passes: 4 },
      { provider: 'openai', model_id: 'gpt-5.6-terra', agent: 'pi', effort: 'max', role: 'reviewer', reviews: 3, first_round_reviews: 3, first_round_passes: 3 },
    ],
  })
  const reviewer = record.seats.reviewer
  const terra = reviewer.candidates.find((candidate) => candidate.id === 'gpt-5.6-terra')
  assert.equal(terra.thin, true)
  assert.deepEqual(reviewer.picked, { provider: 'openai', id: 'gpt-6-luna', agent: 'pi', effort: 'max' })
})

test('shadowPick stands without evidence and abstains when the seated cell is ineligible', () => {
  const localRoster = { tiers: {
    build: {
      builder: { provider: 'openai', id: 'gpt-6-luna', agent: 'pi', effort: 'max' },
    },
    judge: {
      builder: { provider: 'openai', id: 'gpt-6-sol', agent: 'pi', effort: 'xhigh' },
    },
  } }
  const base = {
    roster: localRoster, tier: 'build', seats: { builder: localRoster.tiers.build.builder },
    sources: { builder: { model: 'roster' } }, ladder: loadLadder(), breaker: null, reviewRows: [],
  }
  assert.equal(shadowPick(base).seats.builder.outcome, 'stands')
  const abstained = shadowPick({ ...base, capabilityFit: (_role, candidate) => ({ ok: candidate.id !== 'gpt-6-luna' }) })
  assert.equal(abstained.seats.builder.outcome, 'abstained')
  assert.equal(abstained.seats.builder.picked, null)
})

test('shadowPick records a floor-empty no-candidate result without a fallback', () => {
  const localRoster = { tiers: {
    build: { reviewer: { provider: 'openai', id: 'gpt-6-luna', agent: 'pi', effort: 'max' } },
  } }
  const baseLadder = loadLadder()
  const ladder = { ...baseLadder, floors: { ...baseLadder.floors, build: 'frontier' } }
  const entry = shadowPick({
    roster: localRoster, tier: 'build', seats: localRoster.tiers.build, sources: { reviewer: { model: 'roster' } },
    ladder, breaker: null,
  }).seats.reviewer
  assert.equal(entry.outcome, 'no-candidate')
  assert.equal(entry.picked, null)
  assert.match(entry.empty_reason, /band-below-floor/)
})

test('shadowPick admits a same-vendor reviewer candidate', () => {
  const ladder = loadLadder()
  for (const tier of ['build', 'judge']) {
    const resolved = resolveTier(roster, tier, {})
    const entry = shadowPick({ roster, tier, seats: resolved.seats, sources: resolved.sources, ladder, breaker: null }).seats.reviewer
    const partner = resolved.seats['tech-lead'] ?? resolved.seats.planner
    // The vendor-collision exclusion was retired: candidate eligibility now
    // follows band, capability, breaker and rate, even when a provider matches.
    const sameVendor = entry.candidates.find((candidate) => candidate.provider === partner.provider)
    assert.ok(sameVendor)
    assert.equal(sameVendor.excluded_by, null)
    assert.equal(sameVendor.eligible, true)
    const otherVendor = entry.candidates.find((candidate) => candidate.provider !== partner.provider)
    assert.ok(otherVendor)
    assert.equal(otherVendor.eligible, true)
  }
})

test('shadowPick excludes open breaker cells and marks absent breaker health as unmeasured', () => {
  const localRoster = { tiers: {
    build: { builder: { provider: 'openai', id: 'gpt-6-luna', agent: 'pi', effort: 'max' } },
  } }
  const args = {
    roster: localRoster, tier: 'build', seats: localRoster.tiers.build, sources: { builder: { model: 'roster' } },
    ladder: loadLadder(), reviewRows: [],
  }
  const open = shadowPick({ ...args, breaker: { cells: [{ provider: 'openai', model_id: 'gpt-6-luna', agent: 'pi', effort: 'max', verdict: 'open' }] } })
  assert.equal(open.seats.builder.candidates[0].excluded_by.reason, 'breaker-open')
  const absent = shadowPick({ ...args, breaker: null })
  assert.equal(absent.absent.breaker, SHADOW_ABSENT.breaker)
  assert.equal(absent.seats.builder.candidates[0].excluded_by, null)
})

test('shadowPick keeps the ledger-owned pane absence beside null cost', () => {
  const localRoster = { tiers: {
    build: { builder: { provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'max' } },
  } }
  const record = shadowPick({
    roster: localRoster, tier: 'build', seats: localRoster.tiers.build, sources: { builder: { model: 'roster' } },
    ladder: loadLadder(), breaker: null,
  })
  const candidate = record.seats.builder.candidates[0]
  assert.equal(record.absent.cost, USAGE_ABSENT_CAUSES.pane)
  assert.equal(candidate.cost_usd, null)
  assert.equal(candidate.absent.cost_usd, USAGE_ABSENT_CAUSES.pane)
})

test('shadowPick does not consult ladder or facts for an explicit model override', () => {
  let consulted = 0
  const record = shadowPick({
    roster: {}, tier: 'build', seats: { builder: { provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'max' } },
    sources: { builder: { model: 'override' } }, ladder: null,
    capabilityFit: () => { consulted += 1; throw new Error('capability consulted') }, breaker: null,
  })
  assert.equal(consulted, 0)
  assert.equal(record.seats.builder.outcome, 'not-consulted')
  assert.deepEqual(record.seats.builder.seated, { provider: null, id: null, agent: 'pi', effort: 'max' })
})

test('shadowPickBoot reports picker errors and unreadable reviews without throwing', async () => {
  const localRoster = { tiers: {
    build: { builder: { provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'max' } },
  } }
  const seats = localRoster.tiers.build
  const sources = { builder: { model: 'roster' } }
  const error = await shadowPickBoot({ roster: localRoster, tier: 'build', seats, sources, adapters: { builder: { transport: 'headless-json' } }, registry: loadCapabilities(), ladder: loadLadder(), env: {}, dbPath: join(tmpdir(), 'shadow-no-ledger.db'), existsSync: () => false, pick: () => { throw new Error('forced picker error') } })
  assert.equal(error.schema_version, 1)
  assert.match(error.error, /forced picker error/)

  const dbPath = join(mkdtempSync(join(tmpdir(), 'shadow-unreadable-')), 'ledger.db')
  writeFileSync(dbPath, 'present')
  try {
    const unreadable = await shadowPickBoot({ roster: localRoster, tier: 'build', seats, sources, adapters: { builder: { transport: 'headless-json' } }, registry: loadCapabilities(), ladder: loadLadder(), env: {}, dbPath, openLedger: () => { throw new Error('unreadable') } })
    assert.equal(unreadable.absent.reviews, SHADOW_ABSENT.reviews)
  } finally { rmSync(dirname(dbPath), { recursive: true, force: true }) }
})

test('shadowPickBoot never creates a missing ledger database', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'shadow-no-create-'))
  const dbPath = join(parent, 'ledger.db')
  const localRoster = { tiers: {
    build: { builder: { provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'max' } },
  } }
  try {
    await shadowPickBoot({
      roster: localRoster, tier: 'build', seats: localRoster.tiers.build, sources: { builder: { model: 'roster' } },
      adapters: { builder: { transport: 'headless-json' } }, registry: loadCapabilities(), ladder: loadLadder(),
      env: { CREW_BREAKER_THRESHOLD: '0.5' }, dbPath,
    })
    assert.equal(existsSync(dbPath), false)
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

test('tier headless boot journals an inert shadow pick beside roster seats', async () => {
  const home = mkdtempSync(join(tmpdir(), 'shadow-e2e-home-'))
  const checkoutFixture = testCheckout('shadow-e2e-checkout-')
  try {
    await withHome(home, () => bootCmd(
      { task: 'shadow-e2e', checkout: checkoutFixture.checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
    ))
    const boot = bootRecord(testCrewDir(home, checkoutFixture.checkout, 'shadow-e2e'))
    assert.equal(boot.shadow_pick.decides, false)
    assert.equal(boot.shadow_pick.error, undefined)
    for (const role of Object.keys(roster.tiers.build)) assert.ok(boot.shadow_pick.seats[role])
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutFixture.root, { recursive: true, force: true })
  }
})

test('readHead returns HEAD, answers null when git cannot answer, and honors the exec seam', () => {
  const missing = join(tmpdir(), 'resume-head-does-not-exist')
  const expected = execSync('git rev-parse HEAD', { cwd: CREW_REPO_ROOT, encoding: 'utf8' }).trim()
  assert.equal(readHead(CREW_REPO_ROOT), expected)
  assert.equal(readHead(join(missing, 'missing')), null)
  let seen = null
  assert.equal(readHead('/ignored', { execSync: (command, options) => { seen = { command, options }; return 'injected-head\n' } }), 'injected-head')
  assert.deepEqual(seen, { command: 'git rev-parse HEAD', options: { cwd: '/ignored', encoding: 'utf8' } })
})

test('readBranch returns a branch, null for detached or blank output, and null when git throws', () => {
  const root = scratchDir('crew-read-branch-')
  try {
    execSync('git init -q', { cwd: root })
    execSync('git config user.email crew-tests@example.invalid', { cwd: root })
    execSync('git config user.name crew-tests', { cwd: root })
    execSync('git commit -q --allow-empty -m init', { cwd: root })
    const branch = execSync('git symbolic-ref --quiet --short HEAD', { cwd: root, encoding: 'utf8' }).trim()
    assert.ok(branch)
    assert.equal(readBranch(root), branch)
    execSync('git checkout -q --detach HEAD', { cwd: root })
    assert.equal(readBranch(root), null)
    assert.equal(readBranch('/ignored', { execSync: () => '' }), null)
    assert.equal(readBranch('/ignored', { execSync: () => { throw new Error('git unavailable') } }), null)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('teardownDecision covers publication, retention, envelope, unknown, and escalation outcomes', () => {
  const cases = [
    [{ status: 'escalation', variant: 'full', published: false, keep: false }, 'escalation'],
    [{ status: 'done', variant: 'full', published: false, keep: false }, 'unpublished'],
    [{ status: 'done', variant: 'full', published: true, keep: true }, 'keep'],
    [{ status: 'done', variant: 'full', published: true, keep: false }, 'teardown'],
    [{ status: 'done', variant: 'scout', published: false, keep: false }, 'teardown'],
    [{ status: 'done', variant: 'unknown', published: false, keep: false }, 'teardown'],
  ]
  for (const [input, expected] of cases) assert.equal(teardownDecision(input), expected, JSON.stringify(input))
})

test('stagesFromJournal bounds stages at the last run-start and handles unreadable journals', () => {
  const dir = join(tmpdir(), `resume-journal-${process.pid}-${Date.now()}`)
  mkdirSync(dir)
  try {
    const path = join(dir, 'journal.jsonl')
    writeFileSync(path, [
      { event: RUN_START_EVENT, head: 'aaa' }, { stage: 'plan:r1' }, { stage_done: 'plan:r1' },
      { event: RUN_START_EVENT, head: 'bbb' }, { stage: 'plan:r1' }, { stage: 'build:r1' },
      'not json', { event: 'noise' },
    ].map((row) => typeof row === 'string' ? row : JSON.stringify(row)).join('\n'))
    assert.deepEqual(stagesFromJournal(path), ['plan:r1', 'build:r1'])
    writeFileSync(path, JSON.stringify({ event: RUN_START_EVENT, head: 'ccc' }) + '\n')
    assert.deepEqual(stagesFromJournal(path), [])
    assert.equal(stagesFromJournal(join(dir, 'missing.jsonl')), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// --- tree fingerprint at teardown (#621) ------------------------------------
// A fingerprint is a BASELINE and is only worth taking once every writer was
// proved dead. These build REAL git checkouts (test/fixtures.mjs's testCheckout
// makes a plain directory, so it can never be measured) and assert what was
// WRITTEN, never that a function was called. scratchDir only: crew.test.mjs's
// raw-temp count is frozen at 84 in test/factory-env.test.mjs:725.
const FP_CLEAN_ROOTS = { records: 0, settled: 0, already_dead: 0, unidentified: 0, failed: 0, unproven: 0 }
const FP_CLEAN_DESCENDANTS = {
  sweep_id: 'fp', records: 0, swept: 0, skipped: 0, retryable: 0, snapshot_ok: true,
  groups: 0, reclaimed: 0, live: 0, identity_refused: 0, probe_unknown: 0,
  signalled: 0, recorded: 0, record_failed: 0, incomplete: 0, coverage_outcome: 'unproven',
}

function fpCheckout(prefix) {
  const root = scratchDir(prefix)
  const checkout = join(root, 'checkout')
  mkdirSync(checkout)
  execSync('git init -q && git add -A', { cwd: checkout })
  writeFileSync(join(checkout, 'keep.txt'), 'keep\n')
  writeFileSync(join(checkout, 'edit.txt'), 'before\n')
  execSync('git add -A && git -c user.email=t@t -c user.name=t commit -qm seed', { cwd: checkout })
  return checkout
}

function fpTeardown({ checkout, members, probe = () => false, roots = FP_CLEAN_ROOTS, descendants = FP_CLEAN_DESCENDANTS, realRename = false }) {
  const dir = join(scratchDir('crew-fingerprint-'), 'crew')
  mkdirSync(join(dir, 'task'), { recursive: true })
  const record = teardownCore({ dir, taskDir: join(dir, 'task') }, { task: 'fp', checkout, workspace_id: null, members }, {
    closeSurface: () => true, closeWorkspace: () => true,
    ...(realRename ? {} : { renameSync: () => {} }),
    settleSeatRoots: () => (roots === null ? null : { ...roots }),
    reclaimDescendants: () => (descendants === null ? null : { ...descendants }),
    probe, sleep: () => {}, io: { log: () => {}, emit: () => true },
  })
  return { dir, record }
}

test('teardownCore records a fingerprint once every writer was proved dead', () => {
  const checkout = fpCheckout('crew-fp-proven-')
  const { dir, record } = fpTeardown({ checkout, members: {
    planner: { surface_id: 's-planner', transport: 'pane' },
    builder: { surface_id: 's-builder', transport: 'pane' },
  } })
  assert.equal(record.seats.proven, record.seats.seats)
  assert.equal(record.fingerprint.recorded, true)
  const written = JSON.parse(readFileSync(join(dir, FINGERPRINT_FILE), 'utf8'))
  assert.equal(written.checkout, checkout)
  assert.ok(Object.hasOwn(written.fingerprint.entries, 'keep.txt'))
  assert.equal(typeof written.fingerprint.at, 'string')
  assert.deepEqual(written.roots, FP_CLEAN_ROOTS)
  assert.deepEqual(written.descendants, FP_CLEAN_DESCENDANTS)
})

test('a teardown that measured no seat records no fingerprint and says why', () => {
  const checkout = fpCheckout('crew-fp-absent-')
  const { dir, record } = fpTeardown({
    checkout,
    members: { builder: { surface_id: null, transport: 'headless-rpc' } },
    probe: () => { throw new Error('a surface-less seat must never be probed') },
  })
  assert.equal(record.seats, null)
  assert.equal(existsSync(join(dir, FINGERPRINT_FILE)), false)
  assert.equal(record.fingerprint.withheld, FINGERPRINT_WITHHELD.unmeasured)
})

test('a seat measured alive records no fingerprint and says why', () => {
  const checkout = fpCheckout('crew-fp-alive-')
  const { dir, record } = fpTeardown({ checkout, members: { builder: { surface_id: 's-builder', transport: 'pane' } }, probe: () => true })
  assert.notEqual(record.seats.proven, record.seats.seats)
  assert.equal(existsSync(join(dir, FINGERPRINT_FILE)), false)
  assert.equal(record.fingerprint.withheld, FINGERPRINT_WITHHELD.seats_unproven)
})

test('proven panes over an unproven seat ROOT record no fingerprint', () => {
  const checkout = fpCheckout('crew-fp-root-')
  const { dir, record } = fpTeardown({
    checkout,
    members: { builder: { surface_id: 's-builder', transport: 'pane' } },
    roots: { ...FP_CLEAN_ROOTS, records: 1, unproven: 1 },
  })
  assert.equal(record.seats.proven, record.seats.seats)
  assert.equal(existsSync(join(dir, FINGERPRINT_FILE)), false)
  assert.equal(record.fingerprint.withheld, FINGERPRINT_WITHHELD.writer_unproven)
})

test('proven panes over a live or retryable descendant record no fingerprint', () => {
  const checkout = fpCheckout('crew-fp-desc-')
  for (const descendants of [
    { ...FP_CLEAN_DESCENDANTS, records: 1, groups: 1, live: 1, retryable: 1, incomplete: 1 },
    { ...FP_CLEAN_DESCENDANTS, records: 2, retryable: 2, record_failed: 1 },
    null,
  ]) {
    const { dir, record } = fpTeardown({ checkout, members: { builder: { surface_id: 's-builder', transport: 'pane' } }, descendants })
    assert.equal(record.seats.proven, record.seats.seats)
    assert.equal(existsSync(join(dir, FINGERPRINT_FILE)), false, `descendants ${JSON.stringify(descendants)} must write no record`)
    assert.equal(record.fingerprint.withheld, FINGERPRINT_WITHHELD.writer_unproven)
  }
})

test('the reported fingerprint path survives the archive rename', () => {
  const checkout = fpCheckout('crew-fp-archive-')
  const { record } = fpTeardown({ checkout, members: { builder: { surface_id: 's-builder', transport: 'pane' } }, realRename: true })
  assert.equal(record.fingerprint.recorded, true)
  assert.equal(record.fingerprint.file, FINGERPRINT_FILE)
  assert.equal(record.fingerprint.path, join(record.archived, FINGERPRINT_FILE))
  assert.equal(existsSync(record.fingerprint.path), true)
  assert.equal(checkRecordedTree(record.archived).outcome, FINGERPRINT_OUTCOMES.unchanged)
})

test('the b175 shape: a change after teardown is a stated fact, not a discovery', () => {
  const checkout = fpCheckout('crew-fp-b175-')
  const { dir, record } = fpTeardown({ checkout, members: { builder: { surface_id: 's-builder', transport: 'pane' } } })
  assert.equal(record.fingerprint.recorded, true)
  writeFileSync(join(checkout, 'edit.txt'), 'a gate kill-mutation applied after teardown\n')
  writeFileSync(join(checkout, 'late.txt'), 'late\n')
  const found = checkRecordedTree(dir)
  assert.equal(found.outcome, FINGERPRINT_OUTCOMES.changed)
  assert.deepEqual(found.modified, ['edit.txt'])
  assert.deepEqual(found.added, ['late.txt'])
  assert.equal(found.record_path, join(dir, FINGERPRINT_FILE))
  assert.equal(typeof found.recorded_at, 'string')
})

// C1 (round 3): the summary a LIVE zero-group root produces when its receipt
// also failed is byte-identical to the summary a DEAD zero-group root produces
// when only its receipt failed — `live` counts groups (crew/seat-io.mjs:756),
// the root-alive branch only sets a reason (:758-759), `incomplete` needs a
// captured group (:844), and :837 with :841-843 increment both counters for the
// one row. The aggregate cannot tell them apart, so neither may mint a baseline.
test('proven panes over a retryable row a receipt failure cannot explain away record nothing', () => {
  const checkout = fpCheckout('crew-fp-ambiguous-')
  const { dir, record } = fpTeardown({
    checkout,
    members: { builder: { surface_id: 's-builder', transport: 'pane' } },
    descendants: { ...FP_CLEAN_DESCENDANTS, records: 1, retryable: 1, record_failed: 1 },
  })
  assert.equal(record.seats.proven, record.seats.seats)
  assert.equal(existsSync(join(dir, FINGERPRINT_FILE)), false)
  assert.equal(record.fingerprint.withheld, FINGERPRINT_WITHHELD.writer_unproven)
})

test('turn-ceiling flags refuse unenforceable panes and persist only when explicitly configured', async () => {
  assert.deepEqual(paneTurnCeilingRefusals(['builder', 'reviewer'], { builder: 40, reviewer: null }), [
    { role: 'builder', budget: 40, transport: 'pane' },
  ])
  assert.deepEqual(paneTurnCeilingRefusals(['builder'], {}), [])
  assert.doesNotThrow(() => assertUsage('boot', { task: 'ceiling-cli', 'max-turns-builder': '40' }))
  assert.throws(
    () => assertUsage('run', { task: 'ceiling-cli', 'brief-file': '/tmp/brief.md', 'max-turns-builder': '40' }),
    /BOOT-time/,
  )
  assert.throws(
    () => assertUsage('boot', { task: 'ceiling-cli', 'max-turns-builder': true }),
    (error) => error.reason === FLAG_VALUE_REFUSAL,
  )

  const home = scratchDir('crew-ceiling-home-')
  const { root: checkoutRoot, checkout } = testCheckout('crew-ceiling-checkout-')
  const bin = process.execPath
  writeFileSync(join(checkout, 'seed.txt'), 'seed\n')
  execSync('git init -q && git add -A && git -c user.email=ceiling@fixture -c user.name=ceiling commit -q -m seed', { cwd: checkout })
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# ceiling test\n')
  const previousBin = process.env.CREW_CLAUDE_BIN
  process.env.CREW_CLAUDE_BIN = bin
  try {
    await withHome(home, async () => {
      const paneCalls = { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() }
      await assert.rejects(
        () => bootCmd(
          { task: 'ceiling-pane', checkout, tier: 'build', 'max-turns-builder': '40' },
          paneCalls,
        ),
        (error) => error.code === PANE_TURN_CEILING_UNMEASURED
          && /emits no seat_turn_census/.test(error.message)
          && !/end the dispatch/.test(error.message),
      )
      assert.equal(paneCalls.cmux.calls.length, 0)
      assert.equal(paneCalls.tree.calls.length, 0)
      assert.equal(paneCalls.renameTab.calls.length, 0)
      assert.equal(existsSync(testCrewDir(home, checkout, 'ceiling-pane')), false)

      await bootCmd(
        { task: 'ceiling-headless', checkout, tier: 'build', 'headless-all': true, 'claude-bin': bin, 'max-turns-builder': '40', 'max-turns-planner': '12', 'max-turns-lead': '48' },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      const dir = testCrewDir(home, checkout, 'ceiling-headless')
      const crew = JSON.parse(readFileSync(join(dir, 'crew.json'), 'utf8'))
      assert.deepEqual(crew.turn_ceilings, {
        planner: 12, 'tech-lead': null, builder: 40, reviewer: 48, lead: 48,
        source: { planner: 'flag', 'tech-lead': 'absent', builder: 'flag', reviewer: 'default', lead: 'flag' },
      })
      assert.deepEqual(bootRecord(dir).turn_ceilings, crew.turn_ceilings)
      let seen = null
      const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
      runCmd({ task: 'ceiling-headless', checkout, 'brief-file': brief, keep: true }, { drive: (ctx) => { seen = ctx; return done } })
      assert.deepEqual(seen.turnCeilings, crew.turn_ceilings)
      const configs = readFileSync(seen.journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((row) => row.event === 'run-configuration')
      assert.deepEqual(configs[0].turn_ceilings, crew.turn_ceilings)

      await bootCmd(
        { task: 'ceiling-plain', checkout, tier: 'build', 'headless-all': true, 'claude-bin': bin },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      const plainDir = testCrewDir(home, checkout, 'ceiling-plain')
      const plainCrew = JSON.parse(readFileSync(join(plainDir, 'crew.json'), 'utf8'))
      const plainBoot = bootRecord(plainDir)
      const defaultCeilings = {
        planner: 64, 'tech-lead': null, builder: 200, reviewer: 48, lead: 32,
        source: { planner: 'default', 'tech-lead': 'absent', builder: 'default', reviewer: 'default', lead: 'default' },
      }
      assert.deepEqual(plainCrew.turn_ceilings, defaultCeilings)
      assert.deepEqual(plainBoot.turn_ceilings, defaultCeilings)
      let plainSeen = null
      runCmd({ task: 'ceiling-plain', checkout, 'brief-file': brief, keep: true }, { drive: (ctx) => { plainSeen = ctx; return done } })
      assert.deepEqual(plainSeen.turnCeilings, defaultCeilings)
      const plainConfigs = readFileSync(plainSeen.journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((row) => row.event === 'run-configuration')
      assert.deepEqual(plainConfigs[0].turn_ceilings, defaultCeilings)
    })
  } finally {
    if (previousBin === undefined) delete process.env.CREW_CLAUDE_BIN
    else process.env.CREW_CLAUDE_BIN = previousBin
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

function resumeValidationFixture(prefix = 'crew-resume-validation-') {
  const root = scratchDir(prefix)
  const checkout = join(root, 'checkout')
  const taskDir = join(root, 'task')
  mkdirSync(checkout, { recursive: true })
  mkdirSync(taskDir, { recursive: true })
  for (const args of [['init', '-q'], ['config', 'user.email', 'crew@example.invalid'], ['config', 'user.name', 'crew tests']]) execSync('git ' + args.join(' '), { cwd: checkout })
  const source = 'resume-control\n'
  writeFileSync(join(checkout, 'a.mjs'), source)
  execSync('git add a.mjs && git commit -qm base', { cwd: checkout })
  const head = execSync('git rev-parse HEAD', { cwd: checkout, encoding: 'utf8' }).trim()
  const index = execSync('git write-tree', { cwd: checkout, encoding: 'utf8' }).trim()
  const file = { path: 'a.mjs', state: 'present', bytes: `file:-:${createHash('sha256').update(source).digest('hex')}` }
  const gatePath = join(taskDir, 'gate.mjs')
  const planPath = join(taskDir, 'plan.md')
  const reviewPath = join(taskDir, 'review.md')
  for (const path of [gatePath, planPath, reviewPath]) writeFileSync(path, `${basename(path)}\n`)
  const returns = {
    planner: { status: 'done', role: 'planner', summary: 'plan', artifacts: [planPath], details: { plan_path: planPath } },
    builder: { status: 'done', role: 'builder', summary: 'build', artifacts: [], details: {} },
    reviewer: { status: 'done', role: 'reviewer', summary: 'review', artifacts: [reviewPath], details: { review_path: reviewPath } },
  }
  const checkpoint = {
    version: 2, kind: 'suite', frozen_where: 'suite', head_oid: head, chunk: null,
    tree: { index_oid: index, files: [file], worktree_sha256: resumeWorktreeSha256([file]) },
    accepted_scope: ['a.mjs'], returns,
    decision: { accepted_via: 'review pass', verdict: 'pass', residuals: [], carried_findings: [], accept_findings: [], accept_decision: { where: 'review', outcome: 'accepted', residuals: [] }, panel_contributors: ['reviewer'] },
    commit: { oid: head, pending: false, files: ['a.mjs'], message: 'feat: resume', subject: 'feat: resume' },
    proof: { gate_cmd: 'node gate.mjs', gate_path: gatePath, summary: { total: 1, failed: 0, errored: 0 }, discrimination: 'proven', generation: 1, repairs: 0 },
    suite: { cmd: 'npm test', warm: null, cold: null }, publish: { branch: null, base: null }, prior_stages: ['review:r1', 'gate'],
  }
  return { root, checkout, taskDir, head, checkpoint, envelope: { status: 'escalation', details: { escalation: { where: 'suite' }, resume_checkpoint: checkpoint } } }
}

test('B1 resume refuses a moved worktree without side effects', () => {
  const fixture = resumeValidationFixture('crew-resume-b1-')
  try {
    const admitted = { ...fixture.checkpoint, head_oid: fixture.head.slice(0, 8) }
    assert.equal(validateResumeState({ args: {}, checkout: fixture.checkout, taskDir: fixture.taskDir, envelope: { ...fixture.envelope, details: { ...fixture.envelope.details, resume_checkpoint: admitted } } }), admitted)
    execSync('git commit --allow-empty -qm moved', { cwd: fixture.checkout })
    assert.throws(() => validateResumeState({ args: {}, checkout: fixture.checkout, taskDir: fixture.taskDir, envelope: fixture.envelope }), (error) => error.reason === RESUME_REFUSALS.worktreeMoved)
    execSync(`git reset --hard ${fixture.head}`, { cwd: fixture.checkout, stdio: 'ignore' })
    writeFileSync(join(fixture.checkout, 'a.mjs'), 'same HEAD, different bytes\n')
    assert.throws(() => validateResumeState({ args: {}, checkout: fixture.checkout, taskDir: fixture.taskDir, envelope: fixture.envelope }), (error) => error.reason === RESUME_REFUSALS.fingerprintMismatch)
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

test('C1 resume refuses a missing gate artifact by closed name', () => {
  const fixture = resumeValidationFixture('crew-resume-c1-')
  try {
    rmSync(fixture.checkpoint.proof.gate_path)
    assert.throws(() => validateResumeState({ args: {}, checkout: fixture.checkout, taskDir: fixture.taskDir, envelope: fixture.envelope }), (error) => error.reason === RESUME_REFUSALS.artifactMissing)
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

test('RVR1-1 resume admits accepted multi-file tracked and untracked pre-commit worktree', () => {
  const entry = (path, bytes) => ({ path, state: 'present', bytes: `file:-:${createHash('sha256').update(bytes).digest('hex')}` })
  const envelopeFor = (checkpoint) => ({ status: 'escalation', details: { escalation: { where: 'gate' }, resume_checkpoint: checkpoint } })
  const tracked = resumeValidationFixture('crew-resume-rvr1-1-tracked-')
  try {
    writeFileSync(join(tracked.checkout, 'b.mjs'), 'baseline b\n')
    execSync('git add b.mjs && git commit -qm second-base', { cwd: tracked.checkout })
    const head = execSync('git rev-parse HEAD', { cwd: tracked.checkout, encoding: 'utf8' }).trim()
    const index = execSync('git write-tree', { cwd: tracked.checkout, encoding: 'utf8' }).trim()
    const changed = { 'a.mjs': 'tracked a\n', 'b.mjs': 'tracked b\n' }
    for (const [path, bytes] of Object.entries(changed)) writeFileSync(join(tracked.checkout, path), bytes)
    const files = Object.entries(changed).map(([path, bytes]) => entry(path, bytes))
    Object.assign(tracked.checkpoint, {
      kind: 'gate', frozen_where: 'gate', head_oid: head, accepted_scope: Object.keys(changed),
      tree: { index_oid: index, files, worktree_sha256: resumeWorktreeSha256(files) },
      commit: { oid: null, pending: true, files: Object.keys(changed), message: 'feat: precommit', subject: 'feat: precommit' },
      prior_stages: ['review:r1', 'gate'],
    })
    assert.equal(validateResumeState({ args: {}, checkout: tracked.checkout, taskDir: tracked.taskDir, envelope: envelopeFor(tracked.checkpoint) }), tracked.checkpoint)
  } finally { rmSync(tracked.root, { recursive: true, force: true }) }

  const untracked = resumeValidationFixture('crew-resume-rvr1-1-untracked-')
  try {
    const path = 'new.mjs'; const bytes = 'untracked accepted file\n'; const file = entry(path, bytes)
    writeFileSync(join(untracked.checkout, path), bytes)
    Object.assign(untracked.checkpoint, {
      kind: 'gate', frozen_where: 'gate', accepted_scope: [path],
      tree: { index_oid: execSync('git write-tree', { cwd: untracked.checkout, encoding: 'utf8' }).trim(), files: [file], worktree_sha256: resumeWorktreeSha256([file]) },
      commit: { oid: null, pending: true, files: [path], message: 'feat: precommit', subject: 'feat: precommit' },
      prior_stages: ['review:r1', 'gate'],
    })
    assert.equal(validateResumeState({ args: {}, checkout: untracked.checkout, taskDir: untracked.taskDir, envelope: envelopeFor(untracked.checkpoint) }), untracked.checkpoint)
  } finally { rmSync(untracked.root, { recursive: true, force: true }) }
})

test('F1 resume refusal vocabulary is frozen and rejects free form reasons', () => {
  assert.equal(Object.isFrozen(RESUME_REFUSALS), true)
  assert.equal(Object.isFrozen(RESUME_REFUSAL_NAMES), true)
  assert.equal(RESUME_REFUSAL_NAMES.length, 12)
  assert.deepEqual(RESUME_REFUSAL_NAMES, ['envelope-missing', 'envelope-unreadable', 'not-escalation', 'state-missing', 'unsupported-checkpoint', 'oid-unresolved', 'worktree-moved', 'fingerprint-mismatch', 'artifact-missing', 'artifact-unreadable', 'suite-mismatch', 'unexpected-dirty'])
  assert.throws(() => refuseResume('free-form'), /unknown resume refusal: free-form/)
})

function resumeCommandFixture(prefix = 'crew-resume-command-') {
  const root = scratchDir(prefix)
  const home = join(root, 'home')
  const checkout = join(root, 'checkout')
  const task = 'resume-refusal'
  const dir = join(home, '.crew', basename(checkout), task)
  const taskDir = join(dir, 'task')
  const returnsDir = join(dir, 'returns')
  mkdirSync(checkout, { recursive: true }); mkdirSync(taskDir, { recursive: true }); mkdirSync(returnsDir, { recursive: true })
  execSync('git init -q && git config user.email crew@example.invalid && git config user.name crew', { cwd: checkout })
  const source = 'checkpoint source\n'
  writeFileSync(join(checkout, 'a.mjs'), source)
  execSync('git add a.mjs && git commit -qm base', { cwd: checkout })
  const head = execSync('git rev-parse HEAD', { cwd: checkout, encoding: 'utf8' }).trim()
  const index = execSync('git write-tree', { cwd: checkout, encoding: 'utf8' }).trim()
  const gatePath = join(taskDir, 'gate.mjs'); const planPath = join(taskDir, 'plan.md'); const reviewPath = join(taskDir, 'review.md')
  for (const path of [gatePath, planPath, reviewPath]) writeFileSync(path, `${basename(path)}\n`)
  const file = { path: 'a.mjs', state: 'present', bytes: `file:-:${createHash('sha256').update(source).digest('hex')}` }
  const checkpoint = {
    version: 2, kind: 'suite', frozen_where: 'suite', head_oid: head, chunk: null,
    tree: { index_oid: index, files: [file], worktree_sha256: resumeWorktreeSha256([file]) }, accepted_scope: ['a.mjs'],
    returns: {
      planner: { status: 'done', role: 'planner', summary: 'plan', artifacts: [planPath], details: { plan_path: planPath } },
      builder: { status: 'done', role: 'builder', summary: 'build', artifacts: [], details: {} },
      reviewer: { status: 'done', role: 'reviewer', summary: 'review', artifacts: [reviewPath], details: { review_path: reviewPath } },
    },
    decision: { accepted_via: 'review pass', verdict: 'pass', residuals: [], carried_findings: [], accept_findings: [], accept_decision: { where: 'review', outcome: 'accepted', residuals: [] }, panel_contributors: ['reviewer'] },
    commit: { oid: head, pending: false, files: ['a.mjs'], message: 'feat: resume', subject: 'feat: resume' },
    proof: { gate_cmd: 'node gate.mjs', gate_path: gatePath, summary: { total: 1, failed: 0, errored: 0 }, discrimination: 'proven', generation: 1, repairs: 0 },
    suite: { cmd: 'node --test custom-suite.mjs', warm: null, cold: null }, publish: { branch: null, base: null }, prior_stages: ['review:r1', 'commit'],
  }
  const taskReturn = join(returnsDir, 'task.json'); const journal = join(dir, 'journal.jsonl')
  writeFileSync(join(dir, 'crew.json'), JSON.stringify({ task, checkout, roles: [], members: {}, task_return: taskReturn }))
  writeFileSync(journal, '{"event":"prior"}\n')
  const setEnvelope = (value) => writeFileSync(taskReturn, typeof value === 'string' ? value : JSON.stringify(value))
  const envelope = () => ({ status: 'escalation', summary: 'paused', artifacts: [], details: { escalation: { where: 'suite' }, resume_checkpoint: checkpoint } })
  setEnvelope(envelope())
  return { root, home, checkout, task, dir, taskDir, taskReturn, journal, checkpoint, gatePath, setEnvelope, envelope }
}

function assertResumeRefusal(fixture, reason, args = {}) {
  const beforeEnvelope = existsSync(fixture.taskReturn) ? readFileSync(fixture.taskReturn, 'utf8') : null
  const beforeJournal = readFileSync(fixture.journal, 'utf8')
  const previousHome = process.env.HOME
  let effects = 0
  process.env.HOME = fixture.home
  try {
    assert.throws(() => resumeCmd({ task: fixture.task, checkout: fixture.checkout, keep: true, ...args }, {
      openRun: () => { effects += 1; return { startRun() {}, endRun() {} } },
      seatIo: () => { effects += 1; return {} },
      resume: () => { effects += 1; return { status: 'done', details: {} } },
      writeTerminalLine: () => { effects += 1 },
    }), (error) => error.reason === reason)
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome
  }
  assert.equal(effects, 0, reason)
  assert.equal(readFileSync(fixture.journal, 'utf8'), beforeJournal, reason)
  if (beforeEnvelope === null) assert.equal(existsSync(fixture.taskReturn), false, reason)
  else assert.equal(readFileSync(fixture.taskReturn, 'utf8'), beforeEnvelope, reason)
}

test('resume refusal matrix is closed and fails before any side effect', () => {
  const cases = [
    [RESUME_REFUSALS.envelopeMissing, (f) => rmSync(f.taskReturn)],
    [RESUME_REFUSALS.envelopeUnreadable, (f) => f.setEnvelope('{')],
    [RESUME_REFUSALS.notEscalation, (f) => f.setEnvelope({ status: 'done' })],
    [RESUME_REFUSALS.stateMissing, (f) => f.setEnvelope({ status: 'escalation', details: { escalation: { where: 'suite' } } })],
    [RESUME_REFUSALS.unsupportedCheckpoint, (f) => { f.checkpoint.version = 1; f.setEnvelope(f.envelope()) }],
    [RESUME_REFUSALS.oidUnresolved, (f) => { f.checkpoint.head_oid = 'deadbeef'; f.setEnvelope(f.envelope()) }],
    [RESUME_REFUSALS.worktreeMoved, (f) => execSync('git commit --allow-empty -qm moved', { cwd: f.checkout })],
    [RESUME_REFUSALS.fingerprintMismatch, (f) => writeFileSync(join(f.checkout, 'a.mjs'), 'changed bytes\n')],
    [RESUME_REFUSALS.artifactMissing, (f) => rmSync(f.gatePath)],
    [RESUME_REFUSALS.artifactUnreadable, (f) => writeFileSync(f.gatePath, '')],
    [RESUME_REFUSALS.suiteMismatch, () => {}, { suite: 'node --test a-different-suite.mjs' }],
    [RESUME_REFUSALS.unexpectedDirty, (f) => writeFileSync(join(f.checkout, 'unexpected.mjs'), 'untracked\n')],
  ]
  for (const [reason, prepare, args] of cases) {
    const fixture = resumeCommandFixture(`crew-resume-${reason}-`)
    try { prepare(fixture); assertResumeRefusal(fixture, reason, args) }
    finally { rmSync(fixture.root, { recursive: true, force: true }) }
  }
})

test('resume admits the persisted custom suite and refuses only a byte-different override', () => {
  const fixture = resumeCommandFixture('crew-resume-custom-suite-')
  try {
    assert.equal(validateResumeState({ args: {}, checkout: fixture.checkout, taskDir: fixture.taskDir, envelope: fixture.envelope() }).suite.cmd, 'node --test custom-suite.mjs')
    assert.throws(() => validateResumeState({ args: { suite: 'node --test other.mjs' }, checkout: fixture.checkout, taskDir: fixture.taskDir, envelope: fixture.envelope() }), (error) => error.reason === RESUME_REFUSALS.suiteMismatch)
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

test('resume lifecycle carries an authoritative committed file outside the original context', () => {
  const fixture = resumeCommandFixture('crew-resume-context-record-')
  const previousHome = process.env.HOME
  try {
    const source = 'resume context record\n'
    writeFileSync(join(fixture.checkout, 'outside-context.mjs'), source)
    execSync('git add outside-context.mjs && git commit -qm context-record', { cwd: fixture.checkout })
    const head = execSync('git rev-parse HEAD', { cwd: fixture.checkout, encoding: 'utf8' }).trim()
    const index = execSync('git write-tree', { cwd: fixture.checkout, encoding: 'utf8' }).trim()
    const outside = { path: 'outside-context.mjs', state: 'present', bytes: `file:-:${createHash('sha256').update(source).digest('hex')}` }
    const files = [...fixture.checkpoint.tree.files, outside].sort((left, right) => left.path.localeCompare(right.path))
    Object.assign(fixture.checkpoint, {
      head_oid: head,
      accepted_scope: files.map(({ path }) => path),
      tree: { index_oid: index, files, worktree_sha256: resumeWorktreeSha256(files) },
      commit: { ...fixture.checkpoint.commit, oid: head, pending: false, files: files.map(({ path }) => path) },
    })
    fixture.setEnvelope(fixture.envelope())
    const seen = []
    process.env.HOME = fixture.home
    const result = resumeCmd({ task: fixture.task, checkout: fixture.checkout, keep: true }, {
      openRun: () => ({ startRun() {}, endRun() {} }),
      seatIo: () => ({}),
      resume: (ctx, io, checkpoint) => {
        seen.push({ scope: ctx.files_in_scope, committed: checkpoint.commit.files })
        return { status: 'done', summary: 'resumed', artifacts: [], details: { commit: checkpoint.commit.oid, files_committed: checkpoint.commit.files } }
      },
      writeTerminalLine: () => {},
    })
    assert.equal(result.status, 'done')
    assert.deepEqual(seen, [{ scope: ['a.mjs', 'outside-context.mjs'], committed: ['a.mjs', 'outside-context.mjs'] }])
    writeFileSync(join(fixture.checkout, 'outside-context.mjs'), 'tampered context record\n')
    assert.throws(() => validateResumeState({ args: {}, checkout: fixture.checkout, taskDir: fixture.taskDir, envelope: fixture.envelope() }), (error) => error.reason === RESUME_REFUSALS.fingerprintMismatch)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('D1 direct CLI run still starts at planning rather than resuming', () => {
  const root = scratchDir('crew-resume-d1-')
  const home = join(root, 'home')
  const checkout = join(root, 'checkout')
  const task = 'resume-d1'
  mkdirSync(checkout, { recursive: true }); mkdirSync(home, { recursive: true })
  execSync('git init -q && git config user.email crew@example.invalid && git config user.name crew && git commit --allow-empty -qm base', { cwd: checkout })
  const dir = join(home, '.crew', basename(checkout), task)
  mkdirSync(join(dir, 'returns'), { recursive: true })
  const taskReturn = join(dir, 'returns', 'task.json')
  writeFileSync(join(dir, 'crew.json'), JSON.stringify({ task, checkout, roles: ['planner', 'builder', 'reviewer'], members: { planner: { transport: 'unsupported-test-transport' }, builder: { transport: 'headless-json' }, reviewer: { transport: 'headless-json' } }, task_return: taskReturn }))
  writeFileSync(taskReturn, JSON.stringify({ status: 'escalation', details: {} }))
  const brief = join(root, 'brief.md')
  writeFileSync(brief, '# direct run witness\n')
  const entry = fileURLToPath(new URL('./crew.mjs', import.meta.url))
  const child = spawnSync(process.execPath, [entry, 'run', '--task', task, '--checkout', checkout, '--brief-file', brief], { cwd: ROOT, encoding: 'utf8', env: { ...CLI_ENV, HOME: home } })
  const output = `${child.stdout || ''}${child.stderr || ''}`
  try {
    assert.notEqual(child.status, 0)
    const rows = readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(rows.some((row) => row.stage === 'plan:r1'), true)
    assert.equal(rows.some((row) => row.event === 'resume-start'), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('unflagged pane boot remains admitted and record-free under headless turn-ceiling defaults', async () => {
  const home = scratchDir('crew-ceiling-pane-plain-home-')
  const { root: checkoutRoot, checkout } = testCheckout('crew-ceiling-pane-plain-checkout-')
  const task = 'ceiling-pane-plain'
  const paneRoles = ['lead', 'planner', 'builder', 'reviewer']
  const brief = join(home, 'brief.md')
  const cmux = callCounter()
  const renameTab = callCounter()
  let treeCalls = 0
  const tree = (...args) => {
    tree.calls.push(args)
    treeCalls += 1
    if (treeCalls === 1) return { windows: [] }
    return { windows: [{ id: 'window-1', workspaces: [{
      id: 'workspace-1', name: `crew-${task}`,
      panes: paneRoles.map((role) => ({ id: `pane-${role}`, surfaces: [{ id: `surface-${role}`, name: role }] })),
    }] }] }
  }
  tree.calls = []
  writeFileSync(join(checkout, 'seed.txt'), 'seed\n')
  execSync('git init -q && git add -A && git -c user.email=ceiling@fixture -c user.name=ceiling commit -q -m seed', { cwd: checkout })
  writeFileSync(brief, '# ceiling pane plain test\n')
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'claude-bin': process.execPath },
        { cmux, tree, renameTab, awaitSeatsReady: () => {} },
      )
      const dir = testCrewDir(home, checkout, task)
      const crew = JSON.parse(readFileSync(join(dir, 'crew.json'), 'utf8'))
      assert.equal(cmux.calls.length, 1)
      assert.equal(tree.calls.length, 2)
      assert.equal(renameTab.calls.length, paneRoles.length)
      assert.equal(crew.workspace_id, 'workspace-1')
      assert.equal(Object.hasOwn(crew, 'turn_ceilings'), false)
      assert.equal(Object.hasOwn(bootRecord(dir), 'turn_ceilings'), false)

      let seen = null
      const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
      runCmd({ task, checkout, 'brief-file': brief, keep: true }, {
        awaitSeatsReady: () => {}, seatIo: () => ({ emit: () => {} }),
        drive: (ctx) => { seen = ctx; return done }, writeTerminalLine: () => {},
      })
      assert.equal(Object.hasOwn(seen, 'turnCeilings'), false)
      const runConfig = readFileSync(seen.journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
        .find((row) => row.event === 'run-configuration')
      assert.equal(Object.hasOwn(runConfig, 'turn_ceilings'), false)
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

async function scopedReturnFixture() {
  const home = scratchDir('crew-return-scope-home-')
  const { root: checkoutRoot, checkout } = testCheckout('crew-return-scope-checkout-')
  const task = 'return-scope'
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# return scope brief\\n')
  execSync('git init -q', { cwd: checkout })
  const previousExitCode = process.exitCode
  const previousWrite = process.stdout.write
  const paths = []
  const ids = ['run-a', 'run-b']
  let output = ''
  try {
    process.stdout.write = (chunk) => { output += String(chunk); return true }
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
      const run = () => runCmd({ task, checkout, 'brief-file': brief, keep: true }, {
        randomUUID: () => ids.shift(), awaitSeatsReady: () => {}, writeTerminalLine: () => {}, appendCompletion: () => {},
        seatIo: (_crew, scoped) => { paths.push(scoped); return { emit: () => {}, log: () => {} } },
        drive: () => done,
      })
      run(); run()
    })
    const dir = testCrewDir(home, checkout, task)
    const rows = readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    return { home, checkoutRoot, dir, paths, rows }
  } finally {
    process.stdout.write = previousWrite
    process.exitCode = previousExitCode
  }
}

test('A1 redispatch isolates same-id late returns by run token', async () => {
  const fixture = await scopedReturnFixture()
  try {
    assert.equal(fixture.paths.length, 2)
    assert.notEqual(fixture.paths[0].returnsDir, fixture.paths[1].returnsDir)
    const late = join(fixture.paths[0].returnsDir, 'd1.builder.json')
    const current = join(fixture.paths[1].returnsDir, 'd1.builder.json')
    mkdirSync(fixture.paths[0].returnsDir, { recursive: true })
    mkdirSync(fixture.paths[1].returnsDir, { recursive: true })
    writeFileSync(late, JSON.stringify({ assignment_id: 'd1', role: 'builder', status: 'done' }))
    assert.equal(existsSync(current), false)
    assert.ok(fixture.rows.filter((row) => row.event === RUN_START_EVENT).every((row) => row.run_id))
  } finally { rmSync(fixture.home, { recursive: true, force: true }); rmSync(fixture.checkoutRoot, { recursive: true, force: true }) }
})

test('B1 previous returns remain recoverable at the journalled path', () => {
  const paths = { dir: '/tmp/crew-return-b1', taskDir: '/tmp/crew-return-b1/task', returnsDir: '/tmp/crew-return-b1/returns' }
  const row = returnsInheritanceRecord(paths, 'run-new', { readdirSync: () => ['run-old'] })
  assert.equal(row.previous_path, paths.returnsDir)
  assert.equal(row.run_path, join(paths.returnsDir, 'run-new'))
})

test('E1 clean first run has no inheritance side effect', () => {
  const paths = { dir: '/tmp/crew-return-e1', taskDir: '/tmp/crew-return-e1/task', returnsDir: '/tmp/crew-return-e1/returns' }
  assert.equal(returnsInheritanceRecord(paths, 'run-clean', { readdirSync: () => [] }), null)
  assert.deepEqual(runScopedPaths(paths, 'run-clean').returnsDir, join(paths.returnsDir, 'run-clean'))
})

test('F1 inherited returns are journalled once with a closed reason', async () => {
  const fixture = await scopedReturnFixture()
  try {
    const rows = fixture.rows.filter((row) => row.event === 'returns-inheritance')
    assert.equal(rows.length, 1)
    assert.ok(RETURNS_INHERITANCE_REASONS.includes(rows[0].reason))
    assert.equal(rows[0].outcome, 'preserved')
  } finally { rmSync(fixture.home, { recursive: true, force: true }); rmSync(fixture.checkoutRoot, { recursive: true, force: true }) }
})

test('F2 inheritance reason uses the closed vocabulary', () => {
  const paths = { dir: '/tmp/crew-return-f2', taskDir: '/tmp/crew-return-f2/task', returnsDir: '/tmp/crew-return-f2/returns' }
  const preserved = returnsInheritanceRecord(paths, 'run-f2', { readdirSync: () => ['old-run'] })
  const unreadable = returnsInheritanceRecord(paths, 'run-f2', { readdirSync: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) } })
  assert.ok(RETURNS_INHERITANCE_REASONS.includes(preserved.reason))
  assert.ok(RETURNS_INHERITANCE_REASONS.includes(unreadable.reason))
})

test('boundary resolver makes the latest scoped path exclusive in live and archive views', () => {
  const dir = '/tmp/crew-return-boundary'
  const paths = { dir, taskDir: join(dir, 'task'), returnsDir: join(dir, 'returns') }
  const journal = join(dir, 'journal.jsonl')
  let journalText = `${JSON.stringify({ event: RUN_START_EVENT, run_id: 'run-one', task_return: 'returns/run-one/task.json' })}\n${JSON.stringify({ event: RUN_START_EVENT, run_id: 'run-two', task_return: 'returns/run-two/task.a2.json' })}\n`
  const read = (path) => {
    if (path === journal) return journalText
    throw Object.assign(new Error('missing'), { code: 'ENOENT' })
  }
  assert.equal(resolveTaskReturn(paths, { readFileSync: read }), join(paths.returnsDir, 'run-two', 'task.a2.json'))
  journalText = `${JSON.stringify({ event: RUN_START_EVENT, run_id: 'run-two', task_return: 'returns/task.json' })}\n`
  assert.equal(resolveTaskReturn(paths, { readFileSync: read }), null)
  journalText = `${JSON.stringify({ event: RUN_START_EVENT, task_return: 'returns/task.json' })}\n`
  assert.equal(resolveTaskReturn(paths, { readFileSync: read }), join(paths.returnsDir, 'task.json'))

  const parent = dirname(dir)
  const oldDir = join(parent, 'crew-return-boundary.archive-001')
  const newestDir = join(parent, 'crew-return-boundary.archive-999')
  const oldTask = join(oldDir, 'returns', 'task.json')
  const newestTask = join(newestDir, 'returns', 'run-new', 'task.json')
  const archiveJournals = {
    [join(oldDir, 'journal.jsonl')]: `${JSON.stringify({ event: RUN_START_EVENT, task_return: 'returns/task.json' })}\n`,
    [join(newestDir, 'journal.jsonl')]: `${JSON.stringify({ event: RUN_START_EVENT, run_id: 'run-new', task_return: 'returns/run-new/task.json' })}\n`,
  }
  const present = new Set([parent, oldTask])
  const archiveDeps = {
    existsSync: (path) => present.has(path),
    readdirSync: () => ['crew-return-boundary.archive-001', 'crew-return-boundary.archive-999'],
    readFileSync: (path) => archiveJournals[path],
  }
  assert.equal(archivedReturn(paths, archiveDeps), null)
  present.add(newestTask)
  assert.equal(archivedReturn(paths, archiveDeps), newestTask)
})

test('E1 attended CLI ledger keeps declared execution axis', async () => {
  if (!nodeMeetsLedgerFloor) return
  const home = scratchDir('crew-run-config-e1-home-')
  const { root: checkoutRoot, checkout } = testCheckout('crew-run-config-e1-checkout-')
  const task = 'run-config-e1'
  const brief = join(home, 'brief.md')
  const dbPath = join(home, 'ledger', 'ledger.db')
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  writeFileSync(brief, '# run configuration e1\n')
  execSync('git init -q', { cwd: checkout })
  try {
    await withCompletionEnv(home, join(home, 'completions.jsonl'), async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), awaitSeatsReady: async () => {} },
      )
      runCmd(
        { task, checkout, 'brief-file': brief, execution: 'scout', keep: true },
        { drive: () => done, awaitSeatsReady: () => {}, writeTerminalLine: () => {} },
      )
    })
    const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
    try {
      const rows = ledger.dumpTable('run_configurations')
      assert.equal(rows.length, 1)
      assert.deepEqual({
        requested_execution: rows[0].requested_execution,
        effective_execution: rows[0].effective_execution,
        execution_source: rows[0].execution_source,
      }, { requested_execution: 'scout', effective_execution: 'scout', execution_source: 'explicit' })
    } finally { ledger.close() }
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

function grantRuntimeRpcCommand(member, grants, role = 'planner') {
  return rpcCommand({
    bin: '/repo/pi', model: member.model, effort: member.effort,
    sessionDir: '/tmp/crew-task/sessions', sessionId: role, resume: false,
    promptFile: `/tmp/crew-task/role-${role}.md`, deny: member.deny,
    env: { CREW_ROLE: role, CREW_TASK_DIR: '/tmp/crew-task' }, grants,
  })
}

function rpcExtensionOperands(args) {
  const out = []
  for (let i = 0; i < (args || []).length; i += 1) if (args[i] === '-e') out.push(args[i + 1])
  return out
}

function paneExtensionOperands(command) {
  const out = []
  const pattern = /(?:^|\s)-e\s+(?:"([^"]+)"|'([^']+)'|(\S+))/g
  for (const match of String(command || '').matchAll(pattern)) out.push(match[1] || match[2] || match[3])
  return out
}

async function withQuietStdout(fn) {
  const previous = process.stdout.write
  process.stdout.write = () => true
  try { return await fn() } finally { process.stdout.write = previous }
}

test('A1 granted extensions reach the runtime-composed RPC command', async () => {
  let captured = null
  const rows = await bootSeatRows({
    task: 'grant-runtime-a1', args: { 'agent-planner': 'pi' },
    afterBoot: async ({ home, checkout, brief }) => {
      await withHome(home, () => runCmd(
        { task: 'grant-runtime-a1', checkout, 'brief-file': brief, keep: true },
        {
          openRun: () => ({ startRun() {}, endRun() {} }), awaitSeatsReady: () => {},
          seatIo: (...args) => { captured = args; return {} },
          drive: () => ({ status: 'done', summary: '', artifacts: [], details: {} }),
          writeTerminalLine: () => {},
        },
      ))
    },
  })
  const member = rows.crew.members.planner
  const expected = member.grant_snapshot.grants.extensions
  assert.deepEqual(rpcExtensionOperands(grantRuntimeRpcCommand(member, captured[4].planner.grants).args), expected)
  assert.equal(Object.hasOwn(captured[4].planner, 'configDir'), false)
})

test('A2 resumed runtime seats replay persisted grants', () => {
  const fixture = resumeCommandFixture('crew-grant-runtime-a2-')
  const previousExitCode = process.exitCode
  const previousHome = process.env.HOME
  try {
    const grants = pinnedGrants(loadCapabilities(), 'pi')
    const crew = JSON.parse(readFileSync(join(fixture.dir, 'crew.json'), 'utf8'))
    crew.roles = ['planner']
    crew.members = {
      planner: {
        pane_id: null, surface_id: null, transport: 'headless-rpc',
        model: 'openai-codex/gpt-5.6-sol', effort: 'medium', agent: 'pi',
        deny: SEAT_DEFAULTS.planner.deny,
        grant_snapshot: { schema_version: 1, role: 'planner', agent: 'pi', grants },
      },
    }
    writeFileSync(join(fixture.dir, 'crew.json'), JSON.stringify(crew, null, 2))
    process.env.HOME = fixture.home
    process.exitCode = undefined
    let captured = null
    resumeCmd({ task: fixture.task, checkout: fixture.checkout, keep: true }, {
      openRun: () => ({ startRun() {}, endRun() {} }),
      seatIo: (...args) => { captured = args; return {} },
      resume: () => ({ status: 'done', summary: '', artifacts: [], details: {} }),
      writeTerminalLine: () => {},
    })
    assert.deepEqual(rpcExtensionOperands(grantRuntimeRpcCommand(crew.members.planner, captured[4].planner.grants).args), grants.extensions)
  } finally {
    process.exitCode = previousExitCode
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('B1 explicit extensions retain disabled discovery', () => {
  const grants = pinnedGrants(loadCapabilities(), 'pi')
  const command = grantRuntimeRpcCommand({ model: 'openai-codex/gpt-5.6', effort: 'medium', deny: SEAT_DEFAULTS.planner.deny }, grants)
  assert.equal(command.args.includes('--no-extensions'), true)
  assert.deepEqual(rpcExtensionOperands(command.args), grants.extensions)
})

test('C1 an extensionless seat retains closed discovery without operands', () => {
  const command = grantRuntimeRpcCommand({ model: 'openai-codex/gpt-5.6', effort: 'medium', deny: SEAT_DEFAULTS.builder.deny }, EMPTY_GRANTS)
  assert.equal(command.args.includes('--no-extensions'), true)
  assert.deepEqual(rpcExtensionOperands(command.args), [])
  const tools = command.args[command.args.indexOf('--tools') + 1].split(',')
  assert.equal(tools.includes('agent'), false)
  assert.equal(tools.includes('lab'), false)
})

test('D1 pane and RPC transports receive the same granted extensions', async () => {
  const home = scratchDir('crew-grant-pane-d1-home-')
  const { root: checkoutRoot, checkout } = testCheckout('crew-grant-pane-d1-checkout-')
  const task = 'grant-pane-d1'
  const roles = ['lead', 'planner']
  const cmux = callCounter()
  let treeCalls = 0
  const tree = () => {
    treeCalls += 1
    if (treeCalls === 1) return { windows: [] }
    return { windows: [{ id: 'window-1', workspaces: [{
      id: 'workspace-1', name: `crew-${task}`,
      panes: roles.map((role) => ({ id: `pane-${role}`, surfaces: [{ id: `surface-${role}`, name: role }] })),
    }] }] }
  }
  try {
    await withHome(home, () => withQuietStdout(() => bootCmd(
      { task, checkout, roles: 'planner', 'agent-planner': 'pi' },
      { cmux, tree, renameTab: () => {}, awaitSeatsReady: () => {} },
    )))
    const dir = testCrewDir(home, checkout, task)
    const crew = JSON.parse(readFileSync(join(dir, 'crew.json'), 'utf8'))
    const layoutArgs = cmux.calls[0][1]
    const layout = JSON.parse(layoutArgs[layoutArgs.indexOf('--layout') + 1])
    const leaves = []
    const walk = (node) => {
      if (node?.pane?.surfaces?.[0]?.command) leaves.push(node.pane.surfaces[0].command)
      for (const child of node?.children || []) walk(child)
    }
    walk(layout)
    const pane = leaves.find((command) => command.includes(' CREW_ROLE=planner '))
    assert.ok(pane)
    const rpc = grantRuntimeRpcCommand(crew.members.planner, persistedAdapters(crew).planner.grants)
    assert.deepEqual(paneExtensionOperands(pane), rpcExtensionOperands(rpc.args))
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('E1 runtime RPC tools activate every granted extension tool', () => {
  const grants = pinnedGrants(loadCapabilities(), 'pi')
  const command = grantRuntimeRpcCommand({ model: 'openai-codex/gpt-5.6', effort: 'medium', deny: SEAT_DEFAULTS.planner.deny }, grants)
  const tools = command.args[command.args.indexOf('--tools') + 1].split(',')
  assert.deepEqual(tools.filter((tool) => ['agent', 'lab', 'retrieve'].includes(tool)), ['agent', 'lab'])
  assert.equal(tools.includes('retrieve'), false)
})

test('F1 durable seat state records its resolved extensions', async () => {
  const rows = await bootSeatRows({ task: 'grant-snapshot-f1', args: { 'agent-planner': 'pi' } })
  const member = rows.crew.members.planner
  assert.deepEqual(member.grant_snapshot, {
    schema_version: 1, role: 'planner', agent: 'pi',
    grants: member.grant_snapshot.grants,
  })
  assert.deepEqual(member.grant_snapshot.grants.extensions, [
    join(ROOT, 'crew/pi/extensions/subagent.ts'),
    join(ROOT, 'crew/pi/extensions/lab.ts'),
    join(ROOT, 'crew/pi/extensions/readgate.ts'),
  ])
  assert.equal(Object.hasOwn(member, 'config_dir'), false)
})

test('G1 legacy extensionless seat commands remain byte-identical', async () => {
  let captured = null
  const rows = await bootSeatRows({
    task: 'grant-legacy-g1', args: { 'agent-planner': 'pi' },
    afterBoot: async ({ home, checkout, brief, dir }) => {
      const crew = JSON.parse(readFileSync(join(dir, 'crew.json'), 'utf8'))
      delete crew.members.planner.grant_snapshot
      writeFileSync(join(dir, 'crew.json'), JSON.stringify(crew, null, 2))
      await withHome(home, () => runCmd(
        { task: 'grant-legacy-g1', checkout, 'brief-file': brief, keep: true },
        {
          openRun: () => ({ startRun() {}, endRun() {} }), awaitSeatsReady: () => {},
          seatIo: (...args) => { captured = args; return {} },
          drive: () => ({ status: 'done', summary: '', artifacts: [], details: {} }),
          writeTerminalLine: () => {},
        },
      ))
    },
  })
  const member = rows.crew.members.planner
  const actual = grantRuntimeRpcCommand(member, captured[4].planner.grants)
  const expected = grantRuntimeRpcCommand(member, EMPTY_GRANTS)
  assert.deepEqual(actual, expected)
})

test('H1 malformed grant snapshots refuse before seat IO', async () => {
  let seatIoCalls = 0
  await bootSeatRows({
    task: 'grant-malformed-h1', args: { 'agent-planner': 'pi' },
    afterBoot: async ({ home, checkout, brief, dir }) => {
      const path = join(dir, 'crew.json')
      const crew = JSON.parse(readFileSync(path, 'utf8'))
      crew.members.planner.grant_snapshot.grants.tools = ['   ']
      writeFileSync(path, JSON.stringify(crew, null, 2))
      await withHome(home, () => assert.throws(
        () => runCmd(
          { task: 'grant-malformed-h1', checkout, 'brief-file': brief, keep: true },
          {
            openRun: () => ({ startRun() {}, endRun() {} }), awaitSeatsReady: () => {},
            seatIo: () => { seatIoCalls += 1; return {} }, drive: () => { throw new Error('driver reached') },
          },
        ),
        (error) => error.reason === GRANT_SNAPSHOT_REFUSAL && /malformed resolved grants/.test(error.message),
      ))
    },
  })
  assert.equal(seatIoCalls, 0)
})

test('I1 grant snapshots cannot replay across roles', async () => {
  let seatIoCalls = 0
  await bootSeatRows({
    task: 'grant-binding-i1', args: { 'agent-planner': 'pi' },
    afterBoot: async ({ home, checkout, brief, dir }) => {
      const path = join(dir, 'crew.json')
      const crew = JSON.parse(readFileSync(path, 'utf8'))
      crew.members.builder.grant_snapshot = JSON.parse(JSON.stringify(crew.members.planner.grant_snapshot))
      writeFileSync(path, JSON.stringify(crew, null, 2))
      await withHome(home, () => assert.throws(
        () => runCmd(
          { task: 'grant-binding-i1', checkout, 'brief-file': brief, keep: true },
          {
            openRun: () => ({ startRun() {}, endRun() {} }), awaitSeatsReady: () => {},
            seatIo: () => { seatIoCalls += 1; return {} }, drive: () => { throw new Error('driver reached') },
          },
        ),
        (error) => error.reason === GRANT_SNAPSHOT_REFUSAL && /role\/agent binding mismatch/.test(error.message),
      ))
    },
  })
  assert.equal(seatIoCalls, 0)
})

const workflowPath = fileURLToPath(new URL('./workflows/full.json', import.meta.url))
const workflowSourcePath = fileURLToPath(new URL('./workflows.mjs', import.meta.url))
const workflowMap = () => JSON.parse(readFileSync(workflowPath, 'utf8'))
const workflowRoles = ['lead', 'planner', 'builder', 'reviewer']
const workflowOptions = (overrides = {}) => ({
  register: loadCapabilities(), ladder: loadLadder(), tier: 'build', roles: workflowRoles,
  path: '<workflow>', ...overrides,
})
const cloneWorkflow = () => workflowMap()
const workflowReason = (fn, reason) => {
  assert.throws(fn, (error) => error?.reason === reason)
}

// D1 validates the shipped declaration against runtime capabilities and the
// ratified ladder, then projects only the role-keyed, frozen seat contract.
test('D1-valid shipped workflow validates', () => {
  const resolved = validateWorkflow(loadWorkflow('full'), workflowOptions())
  assert.equal(resolved.shape, 'full')
  assert.deepEqual(Object.keys(resolved.seats), ['planner', 'builder', 'lead', 'reviewer'])
  assert.equal(Object.isFrozen(resolved), true)
  assert.equal(Object.isFrozen(resolved.seats), true)
  for (const role of workflowRoles) {
    const seat = resolved.seats[role]
    assert.deepEqual(Object.keys(seat), ['agent', 'provider', 'id', 'effort', 'skills', 'extensions', 'availability'])
    assert.equal(seat.availability, 'unmeasured')
    assert.equal(Object.isFrozen(seat), true)
  }
  assert.equal(resolved.seats.planner.id, 'gpt-6-sol')
  assert.equal(resolved.seats.lead.id, 'claude-opus-5-5')
  assert.equal(resolved.seats.reviewer.id, 'claude-opus-5-5')
  assert.equal(resolved.seats.builder.id, 'muse-spark-1.3-contributor')
})

test('D1-codes workflow refusal set is frozen and every validator code is reachable', () => {
  assert.deepEqual(WORKFLOW_REFUSALS, [
    'workflow-name-invalid', 'workflow-unreadable', 'workflow-schema', 'workflow-shape-unsupported',
    'workflow-stage-extra', 'workflow-stage-not-seated', 'workflow-stage-missing', 'workflow-stage-role',
    'workflow-role-unseated', 'workflow-role-divergent', 'workflow-agent-unknown', 'workflow-model-unknown',
    'workflow-model-below-floor', 'workflow-grant-undeliverable', 'workflow-needs-tier', 'workflow-seat-mismatch',
  ])
  assert.equal(Object.isFrozen(WORKFLOW_REFUSALS), true)
  const dir = scratchDir('crew-workflow-codes-')
  try {
    writeFileSync(join(dir, 'broken.json'), '{')
    workflowReason(() => loadWorkflow('Bad', { dir }), 'workflow-name-invalid')
    workflowReason(() => loadWorkflow('missing', { dir }), 'workflow-unreadable')
    workflowReason(() => loadWorkflow('broken', { dir }), 'workflow-unreadable')
  } finally { rmSync(dir, { recursive: true, force: true }) }

  const cases = [
    ['workflow-schema', () => ({ ...cloneWorkflow(), extra: true })],
    ['workflow-shape-unsupported', () => ({ shape: 'scout', seats: {} })],
    ['workflow-stage-extra', () => {
      const map = cloneWorkflow(); map.seats.extra = { ...map.seats.plan }; return map
    }],
    ['workflow-stage-not-seated', () => {
      const map = cloneWorkflow(); map.seats['scope-gate'] = { ...map.seats.plan }; return map
    }],
    ['workflow-stage-missing', () => {
      const map = cloneWorkflow(); delete map.seats.plan; return map
    }],
    ['workflow-stage-role', () => {
      const map = cloneWorkflow(); map.seats.plan.role = 'builder'; return map
    }],
    ['workflow-role-unseated', () => {
      const map = cloneWorkflow()
      map.seats.check = { ...map.seats.plan, role: 'tech-lead', extensions: [] }
      return map
    }],
    ['workflow-agent-unknown', () => {
      const map = cloneWorkflow(); map.seats.plan.agent = 'unknown-agent'; return map
    }],
    ['workflow-model-unknown', () => {
      const map = cloneWorkflow(); map.seats.plan.id = 'unknown-model'; return map
    }],
    ['workflow-model-below-floor', () => {
      const map = cloneWorkflow()
      map.seats.plan.agent = 'claude'; map.seats.plan.provider = 'anthropic'; map.seats.plan.id = 'claude-haiku-4-5'; map.seats.plan.extensions = []
      return map
    }],
    ['workflow-grant-undeliverable', () => {
      const map = cloneWorkflow(); map.seats.plan.skills = ['crew/skills/not-granted.md']; return map
    }],
    ['workflow-role-divergent', () => {
      const map = cloneWorkflow(); map.seats.review.role = 'builder'
      const inventory = { ...SEAT_BEARING_STAGES, full: { ...SEAT_BEARING_STAGES.full, review: 'builder' } }
      return { map, options: { seatBearingStages: inventory } }
    }],
  ]
  for (const [reason, make] of cases) {
    const candidate = make()
    const map = candidate.map || candidate
    const options = candidate.options || {}
    workflowReason(() => validateWorkflow(map, workflowOptions(options)), reason)
  }
})

test('D1-skill ungranted workflow skill refuses', () => {
  const map = cloneWorkflow(); map.seats.plan.skills = ['crew/skills/not-granted.md']
  workflowReason(() => validateWorkflow(map, workflowOptions()), 'workflow-grant-undeliverable')
})

test('D1-extension ungranted workflow extension refuses', () => {
  const map = cloneWorkflow(); map.seats.plan.extensions = ['crew/pi/extensions/not-granted.ts']
  workflowReason(() => validateWorkflow(map, workflowOptions()), 'workflow-grant-undeliverable')
})

test('D1-basement basement workflow model below utility refuses', () => {
  const map = cloneWorkflow()
  map.seats.plan.agent = 'claude'; map.seats.plan.provider = 'anthropic'; map.seats.plan.id = 'claude-haiku-4-5'; map.seats.plan.extensions = []
  workflowReason(() => validateWorkflow(map, workflowOptions()), 'workflow-model-below-floor')
})

test('D1-agent unknown workflow agent refuses', () => {
  const map = cloneWorkflow(); map.seats.plan.agent = 'unknown-agent'
  workflowReason(() => validateWorkflow(map, workflowOptions()), 'workflow-agent-unknown')
})

test('D1-extra stage absent from workflow shape refuses', () => {
  const map = cloneWorkflow(); map.seats.extra = { ...map.seats.plan }
  workflowReason(() => validateWorkflow(map, workflowOptions()), 'workflow-stage-extra')
})

test('D1-not-seated code-only shape stage refuses', () => {
  const map = cloneWorkflow(); map.seats['scope-gate'] = { ...map.seats.plan }
  workflowReason(() => validateWorkflow(map, workflowOptions()), 'workflow-stage-not-seated')
})

test('D1-missing required seated workflow stage refuses', () => {
  const map = cloneWorkflow(); delete map.seats.plan
  workflowReason(() => validateWorkflow(map, workflowOptions()), 'workflow-stage-missing')
})

test('D1-role wrong workflow stage role refuses', () => {
  const map = cloneWorkflow(); map.seats.plan.role = 'builder'
  workflowReason(() => validateWorkflow(map, workflowOptions()), 'workflow-stage-role')
})

test('D1-unseated stage for an unseated workflow role refuses', () => {
  const map = cloneWorkflow(); map.seats.check = { ...map.seats.plan, role: 'tech-lead', extensions: [] }
  workflowReason(() => validateWorkflow(map, workflowOptions()), 'workflow-role-unseated')
})

test('D1-divergent same-role workflow cells refuse', () => {
  const map = cloneWorkflow(); map.seats.review.role = 'builder'
  const seatBearingStages = { ...SEAT_BEARING_STAGES, full: { ...SEAT_BEARING_STAGES.full, review: 'builder' } }
  workflowReason(() => validateWorkflow(map, workflowOptions({ seatBearingStages })), 'workflow-role-divergent')
})

test('D1-leaf workflow validator imports neither crew nor drive', () => {
  const source = readFileSync(workflowSourcePath, 'utf8')
  assert.doesNotMatch(source, /from ['"]\.\/(?:crew|drive)\.mjs['"]/)
  assert.doesNotMatch(source, /import ['"]\.\/(?:crew|drive)\.mjs['"]/)
})

test('E1-mismatch named workflow seat drift refuses before side effects', async () => {
  const home = scratchDir('crew-workflow-mismatch-home-')
  const { root: checkoutRoot, checkout } = testCheckout('crew-workflow-mismatch-checkout-')
  const task = 'workflow-mismatch'
  const rosterPath = join(home, 'roster.json')
  const dbPath = join(home, 'ledger.db')
  writeFileSync(rosterPath, JSON.stringify(shippedRoster(), null, 2))
  execSync('git init -q && git -c user.email=workflow@example.test -c user.name=workflow commit --allow-empty -q -m seed', { cwd: checkout })
  const cmux = callCounter(); const tree = callCounter()
  const args = {
    task, checkout, tier: 'build', roster: rosterPath, workflow: 'full',
    'headless-all': true, 'claude-bin': process.execPath, 'effort-builder': 'max',
  }
  try {
    await withHome(home, () => assert.rejects(
      () => bootCmd(args, { cmux, tree, workflowDir: join(ROOT, 'crew/workflows') }),
      (error) => error?.reason === 'workflow-seat-mismatch'
        && error.role === 'builder'
        && error.expected?.agent === 'pi'
        && error.expected?.effort === 'medium'
        && error.actual?.agent === 'pi'
        && error.actual?.effort === 'max'
        && error.message.includes('builder')
        && error.message.includes('workflow-seat-mismatch'),
    ))
    assert.equal(cmux.calls.length, 0)
    assert.equal(tree.calls.length, 0)
    assert.equal(existsSync(testCrewDir(home, checkout, task)), false)
  } finally {
    rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('E1-unnamed boot member record stays deep-equal', async () => {
  const unnamed = await bootSeatRows({ task: 'workflow-unnamed-before', rosterValue: shippedRoster() })
  const named = await bootSeatRows({
    task: 'workflow-unnamed-after', rosterValue: shippedRoster(), args: { workflow: 'full' },
    workflowDir: join(ROOT, 'crew/workflows'),
  })
  const withoutWorkflowSeat = (members) => Object.fromEntries(Object.entries(members).map(([role, member]) => {
    const copy = JSON.parse(JSON.stringify(member)); delete copy.workflow_seat; return [role, copy]
  }))
  const crewContract = (crew) => {
    const copy = JSON.parse(JSON.stringify(crew))
    for (const key of ['created_at', 'checkout', 'workspace_id', 'window_id', 'task', 'task_return', 'roster', 'workflow']) delete copy[key]
    copy.members = withoutWorkflowSeat(copy.members)
    return copy
  }
  assert.deepEqual(withoutWorkflowSeat(named.crew.members), unnamed.crew.members)
  assert.deepEqual(crewContract(named.crew), crewContract(unnamed.crew))
})

test('E1-record named workflow persists map and unmeasured seat availability', async () => {
  const rows = await bootSeatRows({
    task: 'workflow-record', rosterValue: shippedRoster(), args: { workflow: 'full' },
    workflowDir: join(ROOT, 'crew/workflows'),
  })
  const validated = validateWorkflow(loadWorkflow('full'), workflowOptions())
  assert.equal(rows.crew.workflow, 'full')
  for (const role of workflowRoles) {
    assert.deepEqual(rows.crew.members[role].workflow_seat, validated.seats[role])
    assert.equal(rows.crew.members[role].workflow_seat.availability, 'unmeasured')
  }
})

test('E1-tier workflow boot without tier or assurance refuses before side effects', async () => {
  const home = scratchDir('crew-workflow-tier-home-')
  const { root: checkoutRoot, checkout } = testCheckout('crew-workflow-tier-checkout-')
  const task = 'workflow-tier-required'
  const cmux = callCounter(); const tree = callCounter()
  try {
    await withHome(home, () => assert.rejects(
      () => bootCmd({ task, checkout, workflow: 'full', roles: 'builder', 'headless-all': true, 'claude-bin': process.execPath }, { cmux, tree }),
      (error) => error?.reason === 'workflow-needs-tier' && error.message.includes('workflow-needs-tier'),
    ))
    assert.equal(cmux.calls.length, 0)
    assert.equal(tree.calls.length, 0)
    assert.equal(existsSync(testCrewDir(home, checkout, task)), false)
  } finally {
    rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

function routingTestPolicy() {
  const loaded = loadRoutingPolicy()
  const policy = JSON.parse(JSON.stringify(loaded.policy))
  policy.routes.build.builder.candidates = [
    { provider: 'fixture', id: 'alpha', agent: 'claude', effort: 'medium' },
    { provider: 'fixture', id: 'beta', agent: 'pi', effort: 'medium' },
  ]
  return { policy, policyHash: loaded.policyHash }
}

function routingMeasurement(cell, numerator, denominator, cost_usd) {
  return {
    cell,
    rate: { numerator, denominator, value: numerator / denominator },
    cost_usd,
  }
}

test('routing A1 validates the checkout-pinned schema and returns exactly one chosen cell or abstention', () => {
  const loaded = loadRoutingPolicy()
  assert.equal(loaded.policy.schema_version, 1)
  assert.equal(loaded.policy.precedence, ROUTING_PRECEDENCE)
  const schema = JSON.parse(readFileSync(new URL('./routing-policy.schema.json', import.meta.url), 'utf8'))
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema')
  const { policy, policyHash } = routingTestPolicy()
  const result = materialiseRoutingChoice({
    policy, policyHash, tier: 'build', role: 'builder', entryPoint: 'boot',
    measurements: [
      routingMeasurement(policy.routes.build.builder.candidates[0], 9, 12, 3),
      routingMeasurement(policy.routes.build.builder.candidates[1], 8, 12, 1),
    ],
  })
  assert.equal(result.outcome, 'chosen')
  assert.deepEqual(result.chosen_cell, policy.routes.build.builder.candidates[0])
  assert.equal(Object.hasOwn(result, 'chosen_cells'), false)
  assert.equal(Array.isArray(result.chosen_cell), false)
  const shippedPolicyText = JSON.stringify(loaded.policy)
  // Each route's candidates, exactly: main's routes with only the three ids renamed.
  const opus = 'anthropic/claude-opus-5-5', luna = 'openai/gpt-6-luna', sol = 'openai/gpt-6-sol'
  const routeCandidates = {}
  for (const [tier, roles] of Object.entries(loaded.policy.routes)) {
    for (const [role, route] of Object.entries(roles)) routeCandidates[`${tier}.${role}`] = route.candidates.map((cell) => `${cell.provider}/${cell.id}`)
  }
  assert.deepEqual(routeCandidates, {
    'mechanical.planner': [opus], 'mechanical.builder': [luna], 'mechanical.reviewer': [sol],
    'build.lead': [opus], 'build.planner': [opus], 'build.builder': [luna], 'build.reviewer': [sol],
    'judge.lead': [opus], 'judge.planner': [opus], 'judge.builder': [luna], 'judge.reviewer': [opus], 'judge.tech-lead': [sol],
  })
  for (const predecessor of ['gpt-5.6-sol', 'gpt-5.6-luna']) {
    assert.equal(shippedPolicyText.includes(predecessor), false, `shipped routing policy must not seat ${predecessor}`)
  }
  assert.deepEqual(shippedPolicyText.split(/[^A-Za-z0-9._-]+/).filter((token) => token === 'claude-opus-5'), [])
})

test('routing B1 keeps every exclusion paired with a closed reason', () => {
  const { policy, policyHash } = routingTestPolicy()
  const [capability, breaker] = policy.routes.build.builder.candidates
  const absent = { provider: 'fixture', id: 'gamma', agent: 'pi', effort: 'medium' }
  const undeclared = { provider: 'fixture', id: 'outside-policy', agent: 'pi', effort: 'medium' }
  policy.routes.build.builder.candidates.push(absent)
  const result = materialiseRoutingChoice({
    policy, policyHash, tier: 'build', role: 'builder', entryPoint: 'boot',
    measurements: [
      { cell: capability, capability: { ok: false } },
      { cell: breaker, breaker: { verdict: 'open' } },
      { cell: absent, rate: null, cost_usd: null },
      { cell: undeclared, rate: null, cost_usd: null },
    ],
  })
  assert.equal(result.outcome, 'abstained')
  for (const reason of ['capability-shortfall', 'breaker-open', 'rate-absent', 'undeclared-candidate']) {
    assert.ok(result.exclusions.some((entry) => entry.reason === reason), reason)
  }
  assert.ok(result.exclusions.every((entry) => ROUTING_EXCLUSION_REASONS.includes(entry.reason)))
})

test('routing C1 reversed measurement order is byte-equivalent and replayable', () => {
  const { policy, policyHash } = routingTestPolicy()
  const [alpha, beta] = policy.routes.build.builder.candidates
  const measurements = [routingMeasurement(alpha, 9, 12, 3), routingMeasurement(beta, 9, 12, 1)]
  const forward = materialiseRoutingChoice({ policy, policyHash, tier: 'build', role: 'builder', entryPoint: 'bench', measurements })
  const reversed = materialiseRoutingChoice({ policy, policyHash, tier: 'build', role: 'builder', entryPoint: 'bench', measurements: [...measurements].reverse() })
  assert.deepEqual(forward, reversed)
  assert.deepEqual(replayRoutingChoice(forward), forward)
  assert.deepEqual(forward.chosen_cell, beta)
  assert.equal(forward.reason, 'cost_usd_asc')
})

test('routing D1 preserves null rate and cost with honest denominators and reasons', () => {
  const { policy, policyHash } = routingTestPolicy()
  const result = materialiseRoutingChoice({
    policy, policyHash, tier: 'build', role: 'builder', entryPoint: 'boot', measurements: [],
  })
  assert.equal(result.outcome, 'abstained')
  assert.equal(result.chosen_cell, null)
  assert.equal(result.abstention_reason, 'no-eligible-candidate')
  for (const row of result.normalized_measurements) {
    assert.equal(row.rate.value, null)
    assert.equal(row.rate.numerator, null)
    assert.equal(row.rate.denominator, null)
    assert.equal(row.rate.reason, 'rate-absent')
    assert.equal(row.cost_usd.value, null)
    assert.equal(row.cost_usd.reason, 'cost-absent')
  }
})

test('routing E1 keeps shadowPick decisive false and never applies advisory routing to roster models', async () => {
  const source = readFileSync(new URL('./crew.mjs', import.meta.url), 'utf8')
  assert.equal((source.match(/decides:\s*false/g) || []).length, 1)
  const rows = await bootSeatRows({ task: 'routing-e1-roster-authority' })
  assert.deepEqual(Object.keys(rows.boot.routing_choice.decisions).sort(), [...rows.crew.roles].sort())
  assert.deepEqual(replayRoutingChoice(rows.boot.routing_choice), rows.boot.routing_choice)
  assert.equal(rows.boot.shadow_pick.decides, false)
  for (const row of rows) {
    assert.equal(rows.crew.members[row.role].model, row.model)
    assert.equal(rows.crew.seats[row.role].model, row.model)
  }
})

test('routing RV1-1 uses ledger first-round measurements before boot without changing seats', async () => {
  const rows = await bootSeatRows({
    task: 'routing-rv1-1-ledger-evidence',
    beforeBoot: ({ dbPath }) => {
      const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
      try {
        const created_at = new Date().toISOString()
        for (let index = 0; index < 50; index += 1) {
          const adw_id = `routing-rv1-1-review-${index}`
          ledger.startSession({ adw_id, repo_slug: 'routing', task_slug: adw_id, tier: 'build' })
          ledger.recordReviewOutcome({
            adw_id, dispatch_id: `routing-rv1-1-dispatch-${index}`, role: 'builder',
            verdict: index < 45 ? 'pass' : 'changes-needed',
            provider: 'openai', model_id: 'gpt-6-luna', model: 'gpt-6-luna', agent: 'pi', effort: 'max',
            created_at,
          })
        }
      } finally { ledger.close() }
    },
  })
  const decision = rows.boot.routing_choice.decisions.builder
  assert.equal(decision.outcome, 'abstained')
  assert.equal(decision.chosen_cell, null)
  assert.equal(decision.abstention_reason, 'no-eligible-candidate')
  assert.ok(decision.exclusions.some((entry) => entry.reason === 'cost-absent'))
  assert.equal(decision.exclusions.some((entry) => entry.reason === 'rate-absent'), false)
  const measurement = decision.normalized_measurements.find((row) => row.cell.id === 'gpt-6-luna')
  assert.notEqual(measurement.rate.value, null)
  assert.equal(measurement.rate.value, measurement.rate.numerator / measurement.rate.denominator)
  assert.deepEqual(measurement.rate, { numerator: 45, denominator: 50, value: 0.9, reason: null })
  assert.deepEqual(measurement.cost_usd, { value: null, reason: 'cost-absent' })
  for (const row of rows) {
    assert.equal(rows.crew.members[row.role].model, row.model)
    assert.equal(rows.crew.seats[row.role].model, row.model)
  }
})

test('routing RV2-1 leaves boot cost absent and applies the declared lookback', async () => {
  let cellReviewCalls = 0
  let reviewOptions = null
  const beganAt = Date.now()
  const rows = await bootSeatRows({
    task: 'routing-rv2-1-cost-absence',
    existsSync: () => true,
    openLedger: () => ({
      degraded: false,
      cellReviews(options) {
        cellReviewCalls += 1
        reviewOptions = options
        return [{
          provider: 'openai', model_id: 'gpt-6-luna', agent: 'pi', effort: 'max', role: 'builder',
          reviews: 50, first_round_reviews: 50, first_round_passes: 45,
        }]
      },
      stats: () => ({ mirror_errors: 0 }),
      close() {},
    }),
  })
  const finishedAt = Date.now()
  assert.equal(cellReviewCalls, 1)
  assert.deepEqual(Object.keys(reviewOptions), ['since'])
  const since = Date.parse(reviewOptions.since)
  const windowMs = 30 * 24 * 60 * 60 * 1000
  assert.ok(Number.isFinite(since))
  assert.ok(since >= beganAt - windowMs)
  assert.ok(since <= finishedAt - windowMs)
  const decision = rows.boot.routing_choice.decisions.builder
  assert.equal(decision.outcome, 'abstained')
  assert.ok(decision.exclusions.some((entry) => entry.reason === 'cost-absent'))
  assert.equal(decision.exclusions.some((entry) => entry.reason === 'rate-absent'), false)
  const measurement = decision.normalized_measurements.find((row) => row.cell.id === 'gpt-6-luna')
  assert.deepEqual(measurement.cost_usd, { value: null, reason: 'cost-absent' })
})

test('routing RV1-1 abstains honestly when boot review evidence is absent or degraded', async () => {
  const cases = [
    {
      name: 'absent',
      existsSync: () => false,
      openLedger: () => { throw new Error('an absent ledger must not be opened') },
    },
    {
      name: 'degraded',
      existsSync: () => true,
      openLedger: () => ({
        degraded: true,
        cellReviews: () => [{
          provider: 'openai', model_id: 'gpt-6-luna', agent: 'pi', effort: 'max', role: 'builder',
          reviews: 50, first_round_reviews: 50, first_round_passes: 45,
        }],
        stats: () => ({ mirror_errors: 0 }),
        close() {},
      }),
    },
    {
      name: 'mirror-errors',
      existsSync: () => true,
      openLedger: () => ({
        degraded: false,
        cellReviews: () => [{
          provider: 'openai', model_id: 'gpt-6-luna', agent: 'pi', effort: 'max', role: 'builder',
          reviews: 50, first_round_reviews: 50, first_round_passes: 45,
        }],
        stats: () => ({ mirror_errors: 1 }),
        close() {},
      }),
    },
  ]
  for (const fixture of cases) {
    const rows = await bootSeatRows({ task: `routing-rv1-1-${fixture.name}`, ...fixture })
    const decision = rows.boot.routing_choice.decisions.builder
    assert.equal(decision.outcome, 'abstained')
    assert.ok(decision.exclusions.some((entry) => entry.reason === 'rate-absent'))
    const measurement = decision.normalized_measurements.find((row) => row.cell.id === 'gpt-6-luna')
    assert.deepEqual(measurement.rate, { numerator: null, denominator: null, value: null, reason: 'rate-absent' })
  }
})

test('routing RV1-1 keeps a below-floor boot review rate absent with its denominator', async () => {
  const rows = await bootSeatRows({
    task: 'routing-rv1-1-thin-rate',
    existsSync: () => true,
    openLedger: () => ({
      degraded: false,
      cellReviews: () => [{
        provider: 'openai', model_id: 'gpt-6-luna', agent: 'pi', effort: 'max', role: 'builder',
        reviews: 11, first_round_reviews: 11, first_round_passes: 10,
      }],
      stats: () => ({ mirror_errors: 0 }),
      close() {},
    }),
  })
  const decision = rows.boot.routing_choice.decisions.builder
  assert.equal(decision.outcome, 'abstained')
  assert.ok(decision.exclusions.some((entry) => entry.reason === 'rate-absent'))
  const measurement = decision.normalized_measurements.find((row) => row.cell.id === 'gpt-6-luna')
  assert.deepEqual(measurement.rate, { numerator: 10, denominator: 11, value: null, reason: 'rate-absent' })
})

test('chunk flags travel from argv to the driver ctx and refuse a lone --chunk', () => {
  const parsed = parseArgs(['--task', 't', '--brief-file', 'b', '--chunked', '--chunk', 'c1'])
  assert.equal(parsed.chunked, true)
  assert.equal(parsed.chunk, 'c1')
  assert.doesNotThrow(() => assertUsage('run', parsed))
  assert.deepEqual(chunkCtxFromArgs(parsed), { chunked: true, chunk: 'c1' })
  assert.deepEqual(chunkCtxFromArgs(parseArgs(['--task', 't', '--brief-file', 'b'])), {})
  assert.deepEqual(chunkCtxFromArgs({}), {})
  assert.throws(() => chunkCtxFromArgs({ chunk: 'c1' }), (err) => err instanceof UsageError && /without --chunked/.test(err.message))
  assert.throws(() => chunkCtxFromArgs({ chunked: true }), (err) => err instanceof UsageError && /needs --chunk/.test(err.message))
  assert.throws(() => chunkCtxFromArgs({ chunked: true, chunk: '   ' }), (err) => err instanceof UsageError)
  assert.throws(() => runCmdFixture({ chunk: 'c1' }), /without --chunked/)
  const chunked = runCmdFixture({ chunked: true, chunk: 'c1' })
  assert.equal(chunked.ctx.chunked, true)
  assert.equal(chunked.ctx.chunk, 'c1')
  const ordinary = runCmdFixture({})
  assert.equal(ordinary.ctx.chunked, undefined)
  assert.equal(ordinary.ctx.chunk, undefined)
})
