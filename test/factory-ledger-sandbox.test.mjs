import { test } from 'node:test'

import assert from 'node:assert/strict'

import {
  rmSync, readFileSync, mkdirSync, writeFileSync, appendFileSync, existsSync, unlinkSync, readdirSync, statSync,
} from 'node:fs'

import { join } from 'node:path'

import { spawnSync, spawn } from 'node:child_process'

import { ROOT, scratchDir } from './helpers.mjs'

import {
  openLedger, replayJsonl, isoMs, TABLES, MIGRATIONS, applyMigrations, DRIVER_GONE_THRESHOLD_MS, DRIVER_STATES, RUN_OBSERVATION_SOURCES, RUN_OBSERVATION_COLUMNS, RUN_OBSERVATION_WRITE_VERB, SESSION_STATUSES, SESSION_OUTCOMES, SEAT_VALUE_SOURCES, TERMINAL_ACTORS, ESCALATION_CAUSE_UNCLASSIFIED, escalationCause, TERM_TO_KILL_MS, WRITERS, WRITER_MIRROR_TABLES, UPDATE_ONLY_WRITERS, DRIFT_REMEDY, DRIFT_COLLAPSE_REMEDY, LedgerUsageError, MODIFIER_KINDS, INTAKE_DISPATCH_OUTCOMES, SEAT_TEARDOWN_OUTCOMES, GATE_DISCRIMINATION_VERDICTS, MUTATION_ANCHOR_CORRECTIONS, MUTATION_ANCHOR_REFUSALS, CELL_FAILURE_ATTRIBUTIONS, RUN_VARIANTS, RUN_VARIANT_MARKERS, STAGE_MARKER_CHUNK, variantFromFirstMessage, REQUEST_MAX_CHARS, USAGE_ABSENT_CAUSES, usageAbsentCause, AGENT_SESSION_ABSENT_REASONS, AGENT_SESSION_ABSENT_REASON_KEYS, CELL_RATE_FLOOR, SCREENER_PROPOSAL_OUTCOMES, CELL_PRICE_UNITS, REVIEW_VERDICTS, PHASE_SLOT_WAIT_KINDS, PHASE_SLOT_WAIT_DEPTH_ABSENT, PHASE_SLOT_WAIT_ABSENT, NARRATION_OUTCOMES, EVAL_ENVELOPE_STATUSES, EVAL_ABSENT_REASONS, EVAL_PAYLOAD_KEYS, ingestJournal, ingestExternalFenceRegister, JOURNAL_FACT_KEYS, JOURNAL_FACT_EVENTS, PLANNER_SYMBOLS_ARMS, PLANNER_SYMBOLS_SAMPLE_FLOOR, bootstrapPercentile,
} from '../scripts/factory/ledger.mjs'

import { FAILURE_UPGRADE, MODIFIER_OUTCOMES, SENSITIVITY_FLOOR, VARIANT_NAMES, SUITE_SLOT_PHASE_NAMES, anchorAbsentWhy, MUTATION_CORRECTION_OUTCOMES, MUTATION_CORRECTION_REFUSALS } from '../crew/drive.mjs'

import { emitAdapter, SEAT_RETRY_EVENTS, SEAT_RETRY_KINDS } from '../crew/seat-io.mjs'

import { modelString as piModelString } from '../crew/adapters/adapter-pi.mjs'

import { _resetNoticeGuardsForTest, openRun, parseProposalBrief } from '../scripts/factory/emit.mjs'

import { loadDurableEscalationRecord, proposalFromResponse, proposalPrompt, triageEscalation } from '../scripts/factory/escalation-triage.mjs'

import { bootTieredRun } from './factory-ledger.test.mjs'

import { NONCE_PREFIX, SCRIPT, require, SQLITE_OK, SKIP, bootBriefRun, fixture, paneReviewRun, trackChild, nextDir, run, openTestLedger, openB499Ledger, seedCellUsage, makeUnenforcedSeatIndexDb, exerciseEveryWriter, seedTaskAgentSession, MARKER_ADW, seedAllWritersWithMarker, MARKER_PLAIN, MARKER_NONCE_ONLY, CALIBRATED_RENDEZVOUS_DELAY_MS, CALIBRATED_RENDEZVOUS_DELAYS_MS, resolveRendezvousDelayMs, runConcurrentEmitterTrial, RUNSET_SINCE, RUNSET_UNTIL, seedRun, seedConfigurationRun, seedConfigurationSeat, EXECUTION_AXIS_BOOT_CONFIGURATION, executionAxisState, writeExecutionAxisCrew, writeExecutionAxisJournal, executionAxisRuntime, executionAxisRow, readerFixture, ADVISOR_AB_EPOCH, advisorAbFixture, advisorAbEnvelope, advisorAbFinding, runAdvisorAb, advisorReasons, advisorNote, SANDBOX_LEDGER_URL, SANDBOX_DEFAULT_RESOLVER, runSandboxChild, B381_PROVIDER_FAILURE_LINE, B395_SLOT_WAIT_GATE_LINE, B395_SLOT_WAIT_WARM_LINE, B395_SLOT_WAIT_COLD_LINE, B395_OLD_CORPUS_LINES, B381_PLAN_SCOPE_LINE, B381_TIMEOUT_REASK_LINE, B381_RPC_EXIT_LINE, B381_PLAN_ADOPTION_LINE, B381_EXTERNAL_REGISTER, ingestJournalLine, journalFactsCli, measuredJournalFactsDb, assertMeasuredAndAbsent, writeTurnsCorpusJournal, turnsCorpusPayload, builderTurnRole, holdoutLedger, addHoldoutLane, holdoutRows, TRIAGE_MODEL, makeTriageFixture, triageLedger, triageResponse } from './factory-ledger.test.mjs'




test('kill refuses when required flags are missing', { skip: SKIP }, () => {
  const res = run(['kill', '--adw-id', 'a'])
  assert.equal(res.status, 2)
})
test('kill refuses for pid <= 1', { skip: SKIP }, () => {
  const res = run(['kill', '--adw-id', 'a', '--pid', '1', '--yes'])
  assert.equal(res.status, 2)
})
test('kill refuses when --pid equals the CLI subprocess\'s parent pid', { skip: SKIP }, () => {
  const res = run(['kill', '--adw-id', 'a', '--pid', String(process.pid), '--yes'])
  assert.equal(res.status, 2)
})
test('kill refuses when no processes row matches (adw_id, pid)', { skip: SKIP }, () => {
  const res = run(['kill', '--adw-id', 'no-such-adw', '--pid', '999999', '--yes'])
  assert.equal(res.status, 2)
})
test('S8: kill refuses when the recorded command does not match the live process (no signal sent)', { skip: SKIP, timeout: 10000 }, async () => {
  const dir = nextDir()
  const dbPath = join(dir, 'ledger.db')
  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  const child = trackChild(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }))
  await new Promise((resolve) => setTimeout(resolve, 200))
  ledger.startProcess({
    adw_id: 'mismatch-1', dispatch_id: 'd', pid: child.pid, command: 'totally-not-the-real-command --deliberately-wrong',
  })
  ledger.close()

  const res = run(['kill', '--adw-id', 'mismatch-1', '--pid', String(child.pid), '--yes'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(res.status, 2)
  assert.match(res.stderr, /command does not match/)
  // No signal was sent — the child must still be alive.
  let alive = true
  try {
    process.kill(child.pid, 0)
  } catch {
    alive = false
  }
  assert.ok(alive, 'the mismatched-command gate must refuse before sending any signal')
  // The gate refused to signal it, so this test owns the kill: no child outlives its test.
  // (The suite tracker asserts exactly that; it is not a garbage collector.)
  if (child.exitCode === null && child.signalCode === null) {
    const gone = new Promise((resolve) => child.on('exit', resolve))
    child.kill('SIGKILL')
    await gone
  }
})
test('TERM_TO_KILL_MS is exported and equals 5000', { skip: SKIP }, () => {
  assert.equal(TERM_TO_KILL_MS, 5000)
})
test('kill happy path terminates a test-spawned child whose recorded command matches the live ps output', { skip: SKIP, timeout: 15000 }, async () => {
  const dir = nextDir()
  const dbPath = join(dir, 'ledger.db')
  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  const child = trackChild(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }))
  await new Promise((resolve) => setTimeout(resolve, 200))
  const psRes = spawnSync('ps', ['-ww', '-p', String(child.pid), '-o', 'command='], { encoding: 'utf8' })
  const command = (psRes.stdout || '').trim()
  ledger.startProcess({ adw_id: 'kill-me', dispatch_id: 'd', pid: child.pid, command })
  ledger.close()

  const exited = new Promise((resolve) => child.on('exit', resolve))
  // spawn, not spawnSync: the kill CLI blocks its OWN process for up to
  // TERM_TO_KILL_MS waiting for the target to die (Atomics.wait, per the
  // module's kill-gate design). A spawnSync here would block THIS test
  // runner's event loop too — and since this test runner is `child`'s real
  // parent, that would prevent it from ever reaping `child`'s exit, which
  // leaves a zombie that a signal-0 liveness probe still reports as
  // "alive" for as long as the reap is stalled, racing the CLI's own wait.
  const killProc = trackChild(spawn(process.execPath, [SCRIPT, 'kill', '--adw-id', 'kill-me', '--pid', String(child.pid), '--yes'], {
    env: { ...process.env, DEVTEAM_LEDGER_DB: dbPath },
  }))
  let stdout = ''
  killProc.stdout.on('data', (d) => { stdout += d })
  const [status] = await Promise.all([
    new Promise((resolve) => killProc.on('exit', resolve)),
    exited,
  ])
  assert.equal(status, 0)
  assert.match(stdout, /"result":"terminated"/)
})
test('kill escalates to SIGKILL when the target traps and ignores SIGTERM', { skip: SKIP, timeout: 15000 }, async () => {
  const dir = nextDir()
  const dbPath = join(dir, 'ledger.db')
  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  const child = trackChild(spawn(process.execPath, [
    '-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)',
  ], { stdio: 'ignore' }))
  await new Promise((resolve) => setTimeout(resolve, 200))
  const psRes = spawnSync('ps', ['-ww', '-p', String(child.pid), '-o', 'command='], { encoding: 'utf8' })
  const command = (psRes.stdout || '').trim()
  ledger.startProcess({ adw_id: 'kill-trap', dispatch_id: 'd', pid: child.pid, command })
  ledger.close()

  const exited = new Promise((resolve) => child.on('exit', resolve))
  const killProc = trackChild(spawn(process.execPath, [SCRIPT, 'kill', '--adw-id', 'kill-trap', '--pid', String(child.pid), '--yes'], {
    env: { ...process.env, DEVTEAM_LEDGER_DB: dbPath, DEVTEAM_LEDGER_TERM_TO_KILL_MS: '200' },
  }))
  let stdout = ''
  killProc.stdout.on('data', (d) => { stdout += d })
  const [status] = await Promise.all([
    new Promise((resolve) => killProc.on('exit', resolve)),
    exited,
  ])
  assert.equal(status, 0)
  assert.match(stdout, /"result":"killed"/)
})
test('installFinalizer is idempotent: a second call installs nothing and returns the same handle', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  const before = process.listenerCount('SIGTERM')
  const h1 = ledger.installFinalizer({ adw_id: 'fin-1' })
  const afterFirst = process.listenerCount('SIGTERM')
  const h2 = ledger.installFinalizer({ adw_id: 'fin-1' })
  const afterSecond = process.listenerCount('SIGTERM')
  assert.equal(afterFirst - before, 1)
  assert.equal(afterSecond, afterFirst)
  assert.equal(h1, h2)
  h1.uninstall()
  assert.equal(process.listenerCount('SIGTERM'), before)
})
test('AC-11: on SIGTERM the finalizer lands the session as fail, closes running processes rows, and does not swallow the signal', { skip: SKIP, timeout: 15000 }, async () => {
  const dir = nextDir()
  const dbPath = join(dir, 'ledger.db')
  const readyPath = join(dir, 'finalizer-installed')
  const program = `
    const { openLedger, isoMs } = await import(${JSON.stringify(new URL('../scripts/factory/ledger.mjs', import.meta.url).href)});
    const { writeFileSync, renameSync } = await import('node:fs');
    const ledger = openLedger({ dbPath: ${JSON.stringify(dbPath)} });
    ledger.startSession({ adw_id: 'sig-1', repo_slug: 'r', task_slug: 't' });
    ledger.startProcess({ adw_id: 'sig-1', dispatch_id: 'd', pid: process.pid, command: 'child' });
    ledger.installFinalizer({ adw_id: 'sig-1' });
    // Published only AFTER the handler is installed, and atomically, so the
    // reader can never observe a half-written marker as readiness.
    writeFileSync(${JSON.stringify(readyPath)} + '.tmp', 'ok');
    renameSync(${JSON.stringify(readyPath)} + '.tmp', ${JSON.stringify(readyPath)});
    setInterval(() => {}, 1000);
  `
  const child = trackChild(spawn(process.execPath, ['--input-type=module', '-e', program], { stdio: 'ignore' }))
  // Gate on the FINALIZER being installed, not on the session row existing.
  //
  // The row is committed by startSession, two statements before
  // installFinalizer. Waiting on the row therefore only proves the child got
  // as far as startSession — so on a slow runner SIGTERM could still land in
  // the gap before the handler existed, the child would die on the DEFAULT
  // SIGTERM disposition (which still satisfies the `signal === 'SIGTERM'`
  // assertion below, so the failure surfaced two asserts later), and the
  // session would stay 'running'. That is the CI failure this closes:
  // 'running' !== 'fail'.
  //
  // An earlier fix replaced a fixed 400 ms sleep with a poll for the row; that
  // closed the case where NO row existed and getSession returned null, but it
  // moved the race one statement later rather than removing it. Gating on the
  // precondition the test actually needs — a handler that can answer the
  // signal — is what removes it. Verified by widening the
  // startSession→installFinalizer window, which reproduces the exact CI
  // failure before this change and cannot after it.
  //
  // ONE reader is opened and reused: reopening per poll starves the sibling
  // SIGTERM test of the database lock.
  {
    let committed = false
    try {
      const deadline = Date.now() + 10000
      while (Date.now() < deadline) {
        if (existsSync(readyPath)) { committed = true; break }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    } finally { /* the marker is a plain file; there is nothing to close */ }
    const probe = openLedger({ dbPath, stderr: { write: () => {} } })
    try {
      // The marker is written after startSession, so the row must be present
      // by now; assert it rather than assume it.
      committed = committed && (() => {
        try { return probe.getSession('sig-1') != null } catch { return false }
      })()
    } finally {
      try { probe.close?.() } catch { /* a probe that cannot close is not a test failure */ }
    }
    assert.equal(committed, true, 'the child must commit sig-1 before the finalizer is exercised')
  }
  const exitInfo = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  child.kill('SIGTERM')
  const { code, signal } = await exitInfo
  assert.ok(signal === 'SIGTERM' || code === 143, `expected the child to terminate on SIGTERM, got code=${code} signal=${signal}`)

  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  const session = ledger.getSession('sig-1')
  assert.equal(session.status, 'fail')
  assert.equal(session.outcome, 'failed')
  assert.equal(session.terminal_reason, 'SIGTERM')
  assert.equal(session.terminal_actor, 'finalizer')
  const runningProcs = ledger.dumpTable('processes').filter((p) => p.adw_id === 'sig-1' && p.state === 'running')
  assert.equal(runningProcs.length, 0)
})
test('endSession COALESCE: a later endSession({status}) call with no spend figures leaves previously-recorded spend intact', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  ledger.startSession({ adw_id: 'coalesce-1', repo_slug: 'r', task_slug: 't' })
  ledger.endSession({ adw_id: 'coalesce-1', status: 'ok', billed_input_tokens: 42, billed_cost_usd: 1.5 })
  ledger.endSession({ adw_id: 'coalesce-1', status: 'fail' })
  const session = ledger.getSession('coalesce-1')
  assert.equal(session.status, 'fail')
  assert.equal(session.billed_input_tokens, 42, 'a bare status-only endSession must not null out previously-recorded spend')
  assert.equal(session.billed_cost_usd, 1.5, 'a bare status-only endSession must not null out previously-recorded spend')
})
test('B1 finalizer preserves an already terminal session', { skip: SKIP, timeout: 15000 }, async () => {
  const dir = nextDir()
  const dbPath = join(dir, 'ledger.db')
  const program = `
    const { openLedger } = await import(${JSON.stringify(new URL('../scripts/factory/ledger.mjs', import.meta.url).href)});
    const ledger = openLedger({ dbPath: ${JSON.stringify(dbPath)} });
    ledger.startSession({ adw_id: 'sig-2', repo_slug: 'r', task_slug: 't' });
    ledger.endSession({ adw_id: 'sig-2', status: 'ok', outcome: 'success', terminal_reason: 'natural-completion', terminal_actor: 'driver', billed_input_tokens: 111, billed_cost_usd: 4.56 });
    ledger.installFinalizer({ adw_id: 'sig-2' });
    setInterval(() => {}, 1000);
  `
  const child = trackChild(spawn(process.execPath, ['--input-type=module', '-e', program], { stdio: 'ignore' }))
  // Wait for the child to have COMMITTED its work rather than sleeping a fixed
  // 400 ms and hoping. Under a loaded runner the child had not reached
  // startSession before the SIGTERM, so no row existed, getSession returned
  // null, and reading `.status` off it threw — a flake that surfaced only when
  // three PRs' CI ran concurrently, reproduced here by shortening the sleep.
  // ONE reader is opened and reused: reopening per poll starves the sibling
  // SIGTERM test of the database lock.
  {
    const probe = openLedger({ dbPath, stderr: { write: () => {} } })
    let committed = false
    try {
      const deadline = Date.now() + 10000
      while (Date.now() < deadline) {
        try { committed = probe.getSession('sig-2')?.status === 'ok' } catch { committed = false }
        if (committed) break
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    } finally {
      try { probe.close?.() } catch { /* a probe that cannot close is not a test failure */ }
    }
    assert.equal(committed, true, 'the child must commit sig-2 before the finalizer is exercised')
  }
  const exitInfo = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  child.kill('SIGTERM')
  await exitInfo

  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  const session = ledger.getSession('sig-2')
  assert.equal(session.status, 'ok', 'the finalizer must not overwrite an already-ok session as fail')
  assert.equal(session.outcome, 'success', 'the finalizer must not overwrite an already-recorded outcome')
  assert.equal(session.terminal_reason, 'natural-completion', 'the finalizer must not overwrite an already-recorded reason')
  assert.equal(session.terminal_actor, 'driver', 'the finalizer must not overwrite an already-recorded actor')
  assert.equal(session.billed_input_tokens, 111, 'the finalizer must not clobber already-recorded spend')
  assert.equal(session.billed_cost_usd, 4.56, 'the finalizer must not clobber already-recorded spend')
})
test('S11(c): two processes racing to open + migrate the same fresh db both complete their write without throwing or crashing', { skip: SKIP, timeout: 15000 }, async () => {
  const dir = nextDir()
  const dbPath = join(dir, 'ledger.db')
  const jsonlPath = join(dir, 'ledger.jsonl')
  function raceProgram(adwId) {
    return `
      const { openLedger } = await import(${JSON.stringify(new URL('../scripts/factory/ledger.mjs', import.meta.url).href)});
      const ledger = openLedger({ dbPath: ${JSON.stringify(dbPath)} });
      ledger.startSession({ adw_id: ${JSON.stringify(adwId)}, repo_slug: 'r', task_slug: 't' });
    `
  }
  const run1 = spawn(process.execPath, ['--input-type=module', '-e', raceProgram('race-a')], { stdio: 'ignore' })
  const run2 = spawn(process.execPath, ['--input-type=module', '-e', raceProgram('race-b')], { stdio: 'ignore' })
  trackChild(run1)
  trackChild(run2)
  const [exit1, exit2] = await Promise.all([
    new Promise((resolve) => run1.on('exit', (code) => resolve(code))),
    new Promise((resolve) => run2.on('exit', (code) => resolve(code))),
  ])
  // Deliberately NOT asserting on degraded state (that would be flaky —
  // whether either side actually observes the lock race depends on OS
  // scheduling). What must ALWAYS hold: neither child crashed, and the
  // shared JSONL raw record — the authority — has both lines intact.
  assert.equal(exit1, 0, 'first racing child crashed')
  assert.equal(exit2, 0, 'second racing child crashed')
  const jsonlLines = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean)
  const adwIds = jsonlLines.map((l) => JSON.parse(l).args.adw_id)
  assert.ok(adwIds.includes('race-a'), 'race-a JSONL line missing')
  assert.ok(adwIds.includes('race-b'), 'race-b JSONL line missing')
})
test('A1: two live emitters on one adw_id lose no record', { skip: SKIP, timeout: 30000 }, async () => {
  const trial = await runConcurrentEmitterTrial({ delayMs: resolveRendezvousDelayMs() })
  assert.deepEqual(trial.perTagCounts, { A: 25, B: 25 })
  assert.equal(trial.exits[0].code, 0, 'emitter A crashed')
  assert.equal(trial.exits[1].code, 0, 'emitter B crashed')
  assert.equal(trial.jsonlCount, 50)
  assert.equal(trial.sqliteCount, 50)
  assert.equal(trial.replayCount, 50)
})
test('B1: concurrent emitter trial measures JSONL and SQLite together', { skip: SKIP, timeout: 30000 }, async () => {
  const trial = await runConcurrentEmitterTrial({ delayMs: resolveRendezvousDelayMs() })
  assert.deepEqual({ jsonl: trial.jsonlCount, sqlite: trial.sqliteCount }, { jsonl: 50, sqlite: 50 })
  assert.equal(trial.sqliteMeasured, true)
})
test('C1: calibrated concurrent emitter window lands 50 of 50', { skip: SKIP, timeout: 90000 }, async () => {
  for (const delayMs of CALIBRATED_RENDEZVOUS_DELAYS_MS) {
    const trial = await runConcurrentEmitterTrial({ delayMs })
    assert.deepEqual({ jsonl: trial.jsonlCount, sqlite: trial.sqliteCount, replay: trial.replayCount }, {
      jsonl: 50, sqlite: 50, replay: 50,
    })
  }
})
test('D1: concurrent emitter contract remains two real processes with 25 records each', { skip: SKIP, timeout: 30000 }, async () => {
  const trial = await runConcurrentEmitterTrial({ delayMs: resolveRendezvousDelayMs() })
  const fixtureSource = readFileSync(trial.emitterPath, 'utf8')
  const helperSource = runConcurrentEmitterTrial.toString()
  assert.match(fixtureSource, /for \(let i = 0; i < 25; i \+= 1\)/)
  assert.match(helperSource, /childA\.send\('release'\)\s*childB\.send\('release'\)/)
  assert.doesNotMatch(helperSource, /\b(?:retry|tolerance|skip)\b/i)
  assert.notEqual(trial.childPids[0], process.pid)
  assert.notEqual(trial.childPids[1], process.pid)
  assert.notEqual(trial.childPids[0], trial.childPids[1])
  assert.deepEqual(trial.perTagCounts, { A: 25, B: 25 })
  assert.deepEqual({ jsonl: trial.jsonlCount, sqlite: trial.sqliteCount, replay: trial.replayCount }, {
    jsonl: 50, sqlite: 50, replay: 50,
  })
})
test('H1: calibrated ledger checks need no rendezvous environment variable', { skip: SKIP, timeout: 30000 }, async () => {
  const saved = process.env.CREW_LEDGER_RENDEZVOUS_DELAY_MS
  delete process.env.CREW_LEDGER_RENDEZVOUS_DELAY_MS
  try {
    const rendezvousDelayMs = resolveRendezvousDelayMs()
    assert.equal(rendezvousDelayMs, CALIBRATED_RENDEZVOUS_DELAY_MS)
    const trial = await runConcurrentEmitterTrial({ delayMs: rendezvousDelayMs })
    assert.deepEqual({ jsonl: trial.jsonlCount, sqlite: trial.sqliteCount, replay: trial.replayCount }, {
      jsonl: 50, sqlite: 50, replay: 50,
    })
  } finally {
    if (saved === undefined) delete process.env.CREW_LEDGER_RENDEZVOUS_DELAY_MS
    else process.env.CREW_LEDGER_RENDEZVOUS_DELAY_MS = saved
  }
})
test('E1: synchronized degraded handles expose the replay-collapse bound', { skip: SKIP, timeout: 30000 }, async () => {
  const dir = nextDir()
  const dbPath = join(dir, 'ledger.db')
  const jsonlPath = join(dir, 'ledger.jsonl')
  const emitter = join(dir, 'degraded-emitter.mjs')
  writeFileSync(emitter, `
    import { existsSync, writeFileSync } from 'node:fs'
    import { openLedger } from ${JSON.stringify(new URL('../scripts/factory/ledger.mjs', import.meta.url).href)}
    const [dbPath, jsonlPath, readyPath, releasePath, tag] = process.argv.slice(2)
    const waitCell = new Int32Array(new SharedArrayBuffer(4))
    const ledger = openLedger({
      dbPath,
      jsonlPath,
      nodeVersion: '20.0.0',
      _afterSequenceAllocatedForTest: ({ seq }) => {
        writeFileSync(readyPath, JSON.stringify({ tag, seq }))
        process.send?.({ type: 'allocated', tag, seq })
        while (!existsSync(releasePath)) Atomics.wait(waitCell, 0, 0, 5)
      },
    })
    ledger.recordEvent({ adw_id: '541-degraded-race', type: 'log', payload: { level: 'info', message: tag } })
    ledger.close()
    process.send?.({ type: 'done', tag })
    process.disconnect?.()
  `)
  const children = ['A', 'B'].map((tag) => {
    const readyPath = join(dir, `${tag}.ready`)
    const releasePath = join(dir, `${tag}.release`)
    const child = trackChild(spawn(process.execPath, [emitter, dbPath, jsonlPath, readyPath, releasePath, tag], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    }))
    return { tag, child, readyPath, releasePath }
  })
  function waitForAllocation({ child, tag }) {
    return new Promise((resolve, reject) => {
      const onMessage = (message) => {
        if (message?.type !== 'allocated' || message?.tag !== tag) {
          cleanup()
          reject(new Error(`degraded emitter ${tag} sent malformed allocation IPC`))
          return
        }
        cleanup()
        resolve(message)
      }
      const onExit = (code, signal) => {
        cleanup()
        reject(new Error(`degraded emitter ${tag} exited before allocation (${code ?? 'null'}, ${signal ?? 'none'})`))
      }
      const cleanup = () => { child.off('message', onMessage); child.off('exit', onExit) }
      child.on('message', onMessage)
      child.once('exit', onExit)
    })
  }
  const allocations = await Promise.all(children.map(waitForAllocation))
  assert.deepEqual(allocations.map(({ tag }) => tag).sort(), ['A', 'B'])
  assert.ok(children.every(({ readyPath }) => existsSync(readyPath)), 'each degraded writer must leave a ready marker')
  for (const { releasePath } of children) writeFileSync(releasePath, 'release')
  const exits = await Promise.all(children.map(({ child }) => new Promise((resolve) => {
    if (child.exitCode !== null) resolve({ code: child.exitCode, signal: child.signalCode })
    else child.once('exit', (code, signal) => resolve({ code, signal }))
  })))
  assert.deepEqual(exits.map(({ code }) => code), [0, 0])
  const authorityLines = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
    .filter((line) => line.kind === 'recordEvent' && line.args.adw_id === '541-degraded-race')
  assert.equal(authorityLines.length, 2)
  assert.equal(new Set(authorityLines.map((line) => `${line.args.adw_id}:${line.args.seq}`)).size, 1)
  const rebuilt = openLedger({ dbPath: join(nextDir(), 'rebuilt.db'), stderr: { write: () => {} } })
  let replayRows
  try {
    replayJsonl(jsonlPath, rebuilt)
    replayRows = rebuilt.dumpTable('events').filter((row) => row.adw_id === '541-degraded-race')
  } finally { rebuilt.close() }
  assert.equal(replayRows.length, 1)
  const collapseMeasurement = authorityLines.length - replayRows.length
  assert.equal(collapseMeasurement, 1)
})
test('G1: immediate reservation defeats a deterministic allocation competitor', { skip: SKIP, timeout: 30000 }, async () => {
  const dir = nextDir()
  const dbPath = join(dir, 'ledger.db')
  const jsonlPath = join(dir, 'ledger.jsonl')
  const resultPath = join(dir, 'competitor-results.json')
  const competitorSource = `
    const { DatabaseSync } = require('node:sqlite')
    const [dbPath, adwId, rawSeq] = process.argv.slice(1)
    let db = null
    try {
      db = new DatabaseSync(dbPath)
      db.exec('PRAGMA busy_timeout = 25')
      db.prepare('INSERT OR IGNORE INTO events (adw_id, seq, type, phase_id, parent_id, started_at, ended_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(adwId, Number(rawSeq), 'log', null, null, null, null, JSON.stringify({ level: 'info', message: 'competitor-payload' }))
      process.exitCode = 0
    } catch {
      process.exitCode = 1
    } finally {
      try { db?.close() } catch {}
    }
  `
  const writer = join(dir, 'g1-writer.mjs')
  writeFileSync(writer, `
    import { writeFileSync } from 'node:fs'
    import { spawnSync } from 'node:child_process'
    import { openLedger } from ${JSON.stringify(new URL('../scripts/factory/ledger.mjs', import.meta.url).href)}
    const [dbPath, resultPath] = process.argv.slice(2)
    const competitorSource = ${JSON.stringify(competitorSource)}
    const competitorResults = []
    const ledger = openLedger({
      dbPath,
      _afterSequenceAllocatedForTest: ({ adwId, seq }) => {
        const result = spawnSync(process.execPath, ['-e', competitorSource, dbPath, adwId, String(seq)], { encoding: 'utf8' })
        competitorResults.push({ status: result.status, error: result.error?.code ?? null })
      },
    })
    ledger.recordEvent({ adw_id: '541-g1', type: 'log', payload: { level: 'info', message: 'writer-payload' } })
    ledger.close()
    writeFileSync(resultPath, JSON.stringify(competitorResults))
  `)
  const child = trackChild(spawn(process.execPath, [writer, dbPath, resultPath], { stdio: ['ignore', 'ignore', 'pipe'] }))
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const exitInfo = await new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  assert.equal(exitInfo.code, 0, `writer process failed: ${stderr}`)
  assert.doesNotMatch(stderr, /COMMIT|ROLLBACK/i, 'writer must not fail in transaction bookkeeping')
  const competitorResults = JSON.parse(readFileSync(resultPath, 'utf8'))
  assert.ok(competitorResults.length >= 1)
  const authorityLines = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
    .filter((line) => line.kind === 'recordEvent' && line.args.adw_id === '541-g1')
  assert.equal(authorityLines.filter((line) => line.args.payload?.message === 'writer-payload').length, 1)
  const live = openLedger({ dbPath, stderr: { write: () => {} } })
  let liveWriterRows
  try {
    liveWriterRows = live.dumpTable('events').filter((row) => row.adw_id === '541-g1'
      && JSON.parse(row.payload_json).message === 'writer-payload')
  } finally { live.close() }
  assert.equal(liveWriterRows.length, 1)
  const rebuilt = openLedger({ dbPath: join(nextDir(), 'rebuilt.db'), stderr: { write: () => {} } })
  let replayWriterRows
  try {
    replayJsonl(jsonlPath, rebuilt)
    replayWriterRows = rebuilt.dumpTable('events').filter((row) => row.adw_id === '541-g1'
      && JSON.parse(row.payload_json).message === 'writer-payload')
  } finally { rebuilt.close() }
  assert.equal(replayWriterRows.length, 1)
})
test('RV1-1: failed live reservation re-allocates from the mirror before authority fallback', { skip: SKIP }, () => {
  const dir = nextDir()
  const dbPath = join(dir, 'ledger.db')
  const jsonlPath = join(dir, 'ledger.jsonl')
  let allocationCount = 0
  const first = openLedger({
    dbPath,
    jsonlPath,
    stderr: { write: () => {} },
    _afterSequenceAllocatedForTest: ({ conn }) => {
      allocationCount += 1
      if (allocationCount !== 3) return
      const exec = conn.exec.bind(conn)
      conn.exec = (sql) => {
        if (sql === 'BEGIN IMMEDIATE') {
          throw Object.assign(new Error('forced reservation refusal'), { code: 'SQLITE_BUSY' })
        }
        return exec(sql)
      }
    },
  })
  try {
    for (let i = 1; i <= 3; i += 1) {
      first.recordEvent({ adw_id: 'rv1-1-live-fallback', type: 'log', payload: { level: 'info', message: `first-${i}` } })
    }
    const sibling = openLedger({ dbPath, jsonlPath, stderr: { write: () => {} } })
    try {
      for (let i = 4; i <= 10; i += 1) {
        sibling.recordEvent({ adw_id: 'rv1-1-live-fallback', type: 'log', payload: { level: 'info', message: `sibling-${i}` } })
      }
    } finally { sibling.close() }
    const fallback = first.recordEvent({
      adw_id: 'rv1-1-live-fallback', type: 'log', payload: { level: 'info', message: 'fallback' },
    })
    assert.equal(fallback.seq, 11)
    const authority = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
      .filter((line) => line.kind === 'recordEvent' && line.args.adw_id === 'rv1-1-live-fallback')
    assert.equal(authority.length, 11)
    assert.equal(new Set(authority.map((line) => `${line.args.adw_id}:${line.args.seq}`)).size, 11)
    const rebuilt = openLedger({ dbPath: join(nextDir(), 'rebuilt.db'), stderr: { write: () => {} } })
    try {
      replayJsonl(jsonlPath, rebuilt)
      assert.equal(rebuilt.dumpTable('events').filter((row) => row.adw_id === 'rv1-1-live-fallback').length, 11)
    } finally { rebuilt.close() }
  } finally { first.close() }
})
test('RV2-1: refused attempt re-allocates before authority fallback', { skip: SKIP }, () => {
  const dir = nextDir()
  const dbPath = join(dir, 'ledger.db')
  const jsonlPath = join(dir, 'ledger.jsonl')
  let firstAttemptReleased = false
  let siblingCommitted = false
  const first = openLedger({
    dbPath,
    jsonlPath,
    stderr: { write: () => {} },
    _afterSequenceAllocatedForTest: ({ adwId, conn }) => {
      if (firstAttemptReleased) return
      firstAttemptReleased = true
      const exec = conn.exec.bind(conn)
      exec('ROLLBACK')
      const sibling = openLedger({ dbPath, jsonlPath, stderr: { write: () => {} } })
      try {
        sibling.recordEvent({ adw_id: adwId, type: 'log', payload: { level: 'info', message: 'sibling' } })
        siblingCommitted = true
      } finally { sibling.close() }
      conn.exec = (sql) => {
        if (sql === 'BEGIN IMMEDIATE') {
          throw Object.assign(new Error('forced second reservation refusal'), { code: 'SQLITE_BUSY' })
        }
        if (sql === 'ROLLBACK') return undefined
        return exec(sql)
      }
    },
  })
  try {
    const fallback = first.recordEvent({
      adw_id: 'rv2-1-live-fallback', type: 'log', payload: { level: 'info', message: 'first' },
    })
    assert.equal(firstAttemptReleased, true)
    assert.equal(siblingCommitted, true)
    assert.equal(fallback.seq, 2)
    const authority = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
      .filter((line) => line.kind === 'recordEvent' && line.args.adw_id === 'rv2-1-live-fallback')
    assert.deepEqual(authority.map((line) => line.args.seq), [1, 2])
    assert.equal(new Set(authority.map((line) => `${line.args.adw_id}:${line.args.seq}`)).size, 2)
    assert.equal(new Set(authority.map((line) => line.args.payload.message)).size, 2)
    const rebuilt = openLedger({ dbPath: join(nextDir(), 'rebuilt.db'), stderr: { write: () => {} } })
    try {
      replayJsonl(jsonlPath, rebuilt)
      assert.equal(rebuilt.dumpTable('events').filter((row) => row.adw_id === 'rv2-1-live-fallback').length, 2)
    } finally { rebuilt.close() }
  } finally { first.close() }
})
test('#541: degraded-then-healthy allocation preserves distinct authority seqs', { skip: SKIP }, () => {
  const dir = nextDir()
  const dbPath = join(dir, 'ledger.db')
  const jsonlPath = join(dir, 'ledger.jsonl')
  const degraded = openLedger({ dbPath, jsonlPath, nodeVersion: '20.0.0', stderr: { write: () => {} } })
  try {
    for (let i = 0; i < 5; i += 1) {
      degraded.recordEvent({ adw_id: '541-degraded', type: 'log', payload: { level: 'info', message: `degraded-${i}` } })
    }
  } finally { degraded.close() }
  const healthy = openLedger({ dbPath, jsonlPath, stderr: { write: () => {} } })
  try {
    for (let i = 0; i < 5; i += 1) {
      healthy.recordEvent({ adw_id: '541-degraded', type: 'log', payload: { level: 'info', message: `healthy-${i}` } })
    }
  } finally { healthy.close() }
  const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((line) => line.kind === 'recordEvent' && line.args.adw_id === '541-degraded')
  assert.equal(lines.length, 10)
  assert.equal(new Set(lines.map((line) => line.args.seq)).size, 10)
  const rebuilt = openLedger({ dbPath: join(nextDir(), 'rebuilt.db'), stderr: { write: () => {} } })
  try {
    replayJsonl(jsonlPath, rebuilt)
    assert.equal(rebuilt.dumpTable('events').filter((row) => row.adw_id === '541-degraded').length, 10)
  } finally { rebuilt.close() }
})
test('#541: explicit sequence advances the degraded allocator floor', { skip: SKIP }, () => {
  const dir = nextDir()
  const dbPath = join(dir, 'ledger.db')
  const jsonlPath = join(dir, 'ledger.jsonl')
  const ledger = openLedger({ dbPath, jsonlPath, nodeVersion: '20.0.0', stderr: { write: () => {} } })
  try {
    ledger.recordEvent({ adw_id: '541-explicit-floor', type: 'log', payload: { level: 'info', message: 'automatic-1' } })
    ledger.recordEvent({ adw_id: '541-explicit-floor', seq: 2, type: 'log', payload: { level: 'info', message: 'explicit-2' } })
    ledger.recordEvent({ adw_id: '541-explicit-floor', type: 'log', payload: { level: 'info', message: 'automatic-3' } })
  } finally { ledger.close() }
  const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((line) => line.kind === 'recordEvent' && line.args.adw_id === '541-explicit-floor')
  assert.deepEqual(lines.map((line) => line.args.seq), [1, 2, 3])
  const rebuilt = openLedger({ dbPath: join(nextDir(), 'rebuilt.db'), stderr: { write: () => {} } })
  try {
    replayJsonl(jsonlPath, rebuilt)
    assert.equal(rebuilt.dumpTable('events').filter((row) => row.adw_id === '541-explicit-floor').length, 3)
  } finally { rebuilt.close() }
})
test('#541: explicit sequence floor scans prior degraded authority', { skip: SKIP }, () => {
  const dir = nextDir()
  const dbPath = join(dir, 'ledger.db')
  const jsonlPath = join(dir, 'ledger.jsonl')
  const first = openLedger({ dbPath, jsonlPath, nodeVersion: '20.0.0', stderr: { write: () => {} } })
  try {
    first.recordEvent({ adw_id: '541-explicit-scan', seq: 2, type: 'log', payload: { level: 'info', message: 'explicit-2' } })
  } finally { first.close() }
  const second = openLedger({ dbPath, jsonlPath, nodeVersion: '20.0.0', stderr: { write: () => {} } })
  try {
    second.recordEvent({ adw_id: '541-explicit-scan', seq: 1, type: 'log', payload: { level: 'info', message: 'explicit-1' } })
    second.recordEvent({ adw_id: '541-explicit-scan', type: 'log', payload: { level: 'info', message: 'automatic-3' } })
  } finally { second.close() }
  const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((line) => line.kind === 'recordEvent' && line.args.adw_id === '541-explicit-scan')
  assert.deepEqual(lines.map((line) => line.args.seq), [2, 1, 3])
  const rebuilt = openLedger({ dbPath: join(nextDir(), 'rebuilt.db'), stderr: { write: () => {} } })
  try {
    replayJsonl(jsonlPath, rebuilt)
    assert.equal(rebuilt.dumpTable('events').filter((row) => row.adw_id === '541-explicit-scan').length, 3)
  } finally { rebuilt.close() }
})
test('#541: the detector reports a collapsed key', { skip: SKIP }, () => {
  const source = openTestLedger()
  source.recordEvent({ adw_id: '541-collapse', seq: 1, type: 'log', payload: { level: 'info', message: 'first' } })
  const { _dbPath: dbPath, _jsonlPath: jsonlPath } = source
  const first = JSON.parse(readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean)[0])
  source.close()
  appendFileSync(jsonlPath, `${JSON.stringify({ ...first, args: { ...first.args, payload: { level: 'info', message: 'second' } } })}\n`)
  const ledger = openLedger({ dbPath, jsonlPath, stderr: { write: () => {} } })
  try {
    const drift = ledger.jsonlDrift()
    assert.equal(drift.collapsed_lines_total, 1)
    assert.equal(drift.collapse_remedy, DRIFT_COLLAPSE_REMEDY)
    assert.equal(drift.writers.find((writer) => writer.writer === 'recordEvent').collapsed_keys, 1)
    assert.equal(drift.drift_total, 0)
  } finally { ledger.close() }
})
test('#541: the detector discriminates idempotent repeats from collapse', { skip: SKIP }, () => {
  const source = openTestLedger()
  try {
    for (let i = 0; i < 3; i += 1) {
      source.recordEvent({ adw_id: '541-identical', seq: 1, type: 'log', payload: { level: 'info', message: 'same' } })
    }
    let drift = source.jsonlDrift()
    assert.equal(drift.collapsed_lines_total, 0)
    assert.equal(drift.collapse_remedy, null)
    assert.equal(drift.drift_total, 0)
  } finally { source.close() }

  const sourceAgain = openTestLedger()
  sourceAgain.recordEvent({ adw_id: '541-replay', seq: 1, type: 'log', payload: { level: 'info', message: 'same' } })
  const sourcePath = sourceAgain._jsonlPath
  sourceAgain.close()
  const target = openTestLedger({ jsonlPath: sourcePath })
  try {
    replayJsonl(sourcePath, target)
    replayJsonl(sourcePath, target)
    const drift = target.jsonlDrift()
    assert.equal(drift.collapsed_lines_total, 0)
    assert.equal(drift.collapse_remedy, null)
    assert.equal(drift.drift_total, 0)
  } finally { target.close() }
})
test('#541: the collision is visible in stats()', { skip: SKIP }, () => {
  const ledger = openTestLedger()
  try {
    ledger.recordEvent({ adw_id: '541-stats', seq: 1, type: 'log', payload: { level: 'info', message: 'first' } })
    ledger.recordEvent({ adw_id: '541-stats', seq: 1, type: 'log', payload: { level: 'info', message: 'different' } })
    const collided = ledger.stats()
    assert.equal(collided.seq_collisions, 1)
    assert.equal(collided.mirror_errors, 1)
    ledger.recordEvent({ adw_id: '541-stats', seq: 1, type: 'log', payload: { level: 'info', message: 'first' } })
    const replayed = ledger.stats()
    assert.equal(replayed.seq_collisions, collided.seq_collisions)
    assert.equal(replayed.mirror_errors, collided.mirror_errors)
  } finally { ledger.close() }
})
test('#541: the doctor CLI names a key collapse', { skip: SKIP }, () => {
  const source = openTestLedger()
  source.recordEvent({ adw_id: '541-doctor', seq: 1, type: 'log', payload: { level: 'info', message: 'first' } })
  const { _dbPath: dbPath, _jsonlPath: jsonlPath } = source
  const first = JSON.parse(readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean)[0])
  source.close()
  appendFileSync(jsonlPath, `${JSON.stringify({ ...first, args: { ...first.args, payload: { level: 'info', message: 'second' } } })}\n`)
  const result = run(['doctor'], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /key collapse/)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.jsonl_drift.collapsed_lines_total, 1)
})
test('home-default resolution refuses from a process under node --test', () => {
  const home = scratchDir('factory-ledger-home-default-')
  const source = [
    `import { ${SANDBOX_DEFAULT_RESOLVER} } from ${JSON.stringify(SANDBOX_LEDGER_URL)}`,
    'let result',
    `try { ${SANDBOX_DEFAULT_RESOLVER}(); result = { threw: false } } catch (err) { result = { threw: true, name: err?.name, message: err?.message } }`,
    'process.stdout.write(JSON.stringify(result))',
    '',
  ].join('\n')
  const child = runSandboxChild(source, home)
  assert.equal(child.status, 0, child.stderr)
  const result = JSON.parse(child.stdout.trim())
  assert.equal(result.threw, true)
  assert.equal(result.name, 'LedgerUsageError')
  assert.match(result.message, /DEVTEAM_LEDGER_DB/)
  assert.match(result.message, /scripts\/factory\/ledger\.mjs/)
})
test('explicit database and directory paths still resolve under node --test', () => {
  const home = scratchDir('factory-ledger-explicit-')
  const explicitDb = join(home, 'x.db')
  const explicitDir = join(home, 'explicit-dir')
  const source = [
    `import { ${SANDBOX_DEFAULT_RESOLVER} } from ${JSON.stringify(SANDBOX_LEDGER_URL)}`,
    `const dbPath = ${SANDBOX_DEFAULT_RESOLVER}()`,
    'delete process.env.DEVTEAM_LEDGER_DB',
    `const dirPath = ${SANDBOX_DEFAULT_RESOLVER}()`,
    'process.stdout.write(JSON.stringify({ dbPath, dirPath }))',
    '',
  ].join('\n')
  const child = runSandboxChild(source, home, {
    DEVTEAM_LEDGER_DB: explicitDb,
    DEVTEAM_LEDGER_DIR: explicitDir,
  })
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout.trim()), { dbPath: explicitDb, dirPath: join(explicitDir, 'ledger.db') })
})
test('openLedger refuses the home default under node --test without creating state', () => {
  const home = scratchDir('factory-ledger-open-home-')
  const source = [
    "import { homedir } from 'node:os'",
    "import { join } from 'node:path'",
    `import { openLedger } from ${JSON.stringify(SANDBOX_LEDGER_URL)}`,
    "const dbPath = join(homedir(), '.dev-team', 'factory', 'ledger.db')",
    'let result',
    'try {',
    "  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })",
    '  ledger.close()',
    '  result = { threw: false }',
    '} catch (err) {',
    '  result = { threw: true, name: err?.name, message: err?.message }',
    '}',
    'process.stdout.write(JSON.stringify(result))',
    '',
  ].join('\n')
  const child = runSandboxChild(source, home)
  assert.equal(child.status, 0, child.stderr)
  const result = JSON.parse(child.stdout.trim())
  assert.equal(result.threw, true)
  assert.equal(result.name, 'LedgerUsageError')
  assert.equal(existsSync(join(home, '.dev-team')), false)
})
test('the crew home-default spawn shape is refused before any ledger state lands', () => {
  const home = scratchDir('factory-ledger-crew-shape-')
  const source = [
    "import { homedir } from 'node:os'",
    "import { join } from 'node:path'",
    `import { openLedger } from ${JSON.stringify(SANDBOX_LEDGER_URL)}`,
    'const dbPath = process.env.DEVTEAM_LEDGER_DB',
    "  || join(process.env.DEVTEAM_LEDGER_DIR || join(homedir(), '.dev-team', 'factory'), 'ledger.db')",
    'let result',
    'try {',
    "  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })",
    "  ledger.startSession({ adw_id: 'b350-test-spawn', repo_slug: 'test', task_slug: 'home-default' })",
    '  ledger.close()',
    '  result = { threw: false }',
    '} catch (err) {',
    '  result = { threw: true, name: err?.name, message: err?.message }',
    '}',
    'process.stdout.write(JSON.stringify(result))',
    '',
  ].join('\n')
  const child = runSandboxChild(source, home)
  assert.equal(child.status, 0, child.stderr)
  const result = JSON.parse(child.stdout.trim())
  assert.equal(result.threw, true)
  assert.equal(result.name, 'LedgerUsageError')
  assert.equal(existsSync(join(home, '.dev-team')), false)
})
test('outside a test process the home-default resolution and open remain unchanged', { skip: SKIP }, () => {
  const home = scratchDir('factory-ledger-production-')
  const source = [
    `import { ${SANDBOX_DEFAULT_RESOLVER}, openLedger } from ${JSON.stringify(SANDBOX_LEDGER_URL)}`,
    `const dbPath = ${SANDBOX_DEFAULT_RESOLVER}()`,
    "const ledger = openLedger({ dbPath, stderr: { write: () => {} } })",
    "ledger.startSession({ adw_id: 'b350-test-production', repo_slug: 'test', task_slug: 'production' })",
    'ledger.close()',
    'process.stdout.write(JSON.stringify({ dbPath }))',
    '',
  ].join('\n')
  const child = runSandboxChild(source, home, { NODE_TEST_CONTEXT: undefined })
  assert.equal(child.status, 0, child.stderr)
  const expected = join(home, '.dev-team', 'factory', 'ledger.db')
  assert.deepEqual(JSON.parse(child.stdout.trim()), { dbPath: expected })
  assert.equal(existsSync(expected), true)
})
