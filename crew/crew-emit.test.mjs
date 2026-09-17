// " gate-mask boundary sentinel
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EVENT_TYPES, PAYLOAD_KEYS, openLedger } from '../scripts/factory/ledger.mjs'
import { openRun } from '../scripts/factory/emit.mjs'
import { phaseForStage, emitAdapter } from './crew.mjs'
import { driveTask, VARIANTS, VARIANT_NAMES, DEFAULT_VARIANT } from './drive.mjs'
import { VARIANT_STAGE_PHASES } from './seat-io.mjs'
import { nodeMeetsLedgerFloor } from './crew-test-helpers.mjs'

// Keep lexical import reach visible before byte-pinned regex test bodies.
void [test, assert, mkdtempSync, writeFileSync, rmSync, tmpdir, join, EVENT_TYPES, PAYLOAD_KEYS, openLedger, openRun, phaseForStage, emitAdapter, driveTask, VARIANTS, VARIANT_NAMES, DEFAULT_VARIANT, VARIANT_STAGE_PHASES, nodeMeetsLedgerFloor]

function adapterEvents() {
  return [
    { kind: 'stage', label: 'plan:r1' },
    { kind: 'assign', id: 'd1', role: 'planner', brief: '/tmp/brief' },
    { kind: 'envelope', id: 'd1', role: 'planner', status: 'done' },
    { kind: 'decision', decided: 'accept', why: 'green' },
    { kind: 'dissent', from: 'reviewer', recommendation: 'escalate', lead_decision: 'accept' },
    { kind: 'gate', name: 'gate:r1', attempt: 1, ok: false, cmd: 'gate-cmd', summary: { total: 3, failed: 3, errored: 0 } },
    { kind: 'attention', moment: 'gate', park_id: null, task: 'task', why: 'exhausted', artifacts: [] },
  ]
}


test('phaseForStage maps every driver stage and defaults unknown labels to build', () => {
  const table = {
    'plan:r1': 'planning', 'check:r1': 'planning', 'scout:r1': 'planning', 'review_only:r1': 'planning', 'review_panel:r1': 'planning', 'verify_only:r1': 'planning', 'repair:r1': 'planning', 'envelope-accept': 'finish',
    'gate-baseline': 'build', 'gate-repair:1': 'build',
    'gate-reverify:1': 'build', 'scope-gate:r1': 'build', 'lane:r1': 'build', 'gate:r1': 'build',
    'review:pass': 'review', suite: 'finish', commit: 'finish', rebase: 'finish', publish: 'publish', done: 'done', 'escalate:lane': 'escalation',
    'future:stage': 'build',
  }
  for (const [label, phase] of Object.entries(table)) assert.equal(phaseForStage(label), phase, label)
})

test('variant stage phase map stays aligned with the closed driver enum', () => {
  assert.equal(Object.isFrozen(VARIANT_STAGE_PHASES), true)
  const declaredHeads = new Set(Object.values(VARIANTS).flatMap((shape) => shape.stages))
  for (const key of Object.keys(VARIANT_STAGE_PHASES)) {
    assert.equal(VARIANT_NAMES.includes(key) || declaredHeads.has(key), true, key)
  }
  for (const name of VARIANT_NAMES) {
    if (name !== DEFAULT_VARIANT) assert.equal(typeof VARIANT_STAGE_PHASES[name], 'string', name)
  }
  assert.equal(phaseForStage('toString:r1'), 'build')
})

test('emitAdapter maps drive events to closed ledger vocabulary with explicit sequence', () => {
  let seq = 100
  const calls = { phases: [], events: [], gates: [] }
  const emitter = {
    adwId: 'adw-test',
    phaseTransition: (phase) => calls.phases.push(phase),
    emit: (fn) => fn({
      recordEvent: (event) => calls.events.push(event),
      recordGateResult: (event) => calls.gates.push(event),
    }, () => ++seq),
  }
  const adapter = emitAdapter(emitter)
  for (const event of adapterEvents()) adapter(event)
  adapter(null)
  adapter({ kind: 'unknown' })
  assert.ok(calls.phases.length >= 1)
  assert.ok(calls.events.length >= 5)
  for (const event of calls.events) {
    assert.ok(EVENT_TYPES.includes(event.type))
    assert.ok(Object.keys(event.payload).every((key) => PAYLOAD_KEYS[event.type].includes(key)))
    assert.equal(event.adw_id, 'adw-test')
    assert.equal(typeof event.seq, 'number')
  }
  assert.equal(calls.gates.length, 1)
  assert.deepEqual(calls.gates[0], {
    adw_id: 'adw-test', phase_id: null, gate_name: 'gate:r1', attempt: 1, ok: false,
    checks: [{ total: 3, failed: 3, errored: 0 }], violations: [], gate_generation: null, pristine: false,
    gate_run_ms: undefined, gate_run_ms_absent_reason: undefined,
  })
  assert.equal(calls.events.filter((event) => event.type === 'log').length, 2)
  assert.ok(calls.events.some((event) => event.type === 'log' && event.payload.level === 'warn'))
})

test('emitAdapter maps cell-failure events to the booted crew cell, with a null-cell fallback', () => {
  const calls = []
  const emitter = {
    adwId: 'adw-cell',
    phaseTransition: () => ({ phase_id: 9 }),
    emit: (fn) => fn({ recordEvent() {}, recordCellFailure: (row) => calls.push(row) }, () => 1),
  }
  const crew = {
    task: 'measure',
    members: { builder: { agent: 'claude', provider: 'anthropic', id: 'sonnet-id', model: 'sonnet', effort: 'high', transport: 'pane' } },
  }
  const adapter = emitAdapter(emitter, crew)
  adapter({ kind: 'stage', label: 'build:r1' })
  adapter({ kind: 'cell-failure', role: 'builder', id: 'd4', failure: 'seat-died', stage: 'seat-died', detail: 'pane gone' })
  assert.deepEqual(calls[0], {
    adw_id: 'adw-cell', task_slug: 'measure', phase_id: 9, dispatch_id: 'd4', role: 'builder',
    agent: 'claude', provider: 'anthropic', model_id: 'sonnet-id', model: 'sonnet', effort: 'high', transport: 'pane',
    kind: 'seat-died', stage: 'seat-died', detail: 'pane gone', attribution: null,
  })

  emitAdapter(emitter)({ kind: 'cell-failure', role: 'reviewer', failure: 'timeout' })
  assert.deepEqual(calls[1], {
    adw_id: 'adw-cell', task_slug: null, phase_id: null, dispatch_id: null, role: 'reviewer',
    agent: null, provider: null, model_id: null, model: null, effort: null, transport: null,
    kind: 'timeout', stage: null, detail: null, attribution: null,
  })

  emitAdapter(emitter)({ kind: 'cell-failure', role: 'builder', id: 'd5', failure: 'timeout', attribution: 'host' })
  assert.equal(calls[2].attribution, 'host')

  adapter({ kind: 'cell-failure', role: 'builder', id: 'd6', failure: 'transport-error', stage: 'substrate-gone', detail: 'pane manager gone', attribution: 'host' })
  assert.deepEqual(calls[3], {
    adw_id: 'adw-cell', task_slug: 'measure', phase_id: 9, dispatch_id: 'd6', role: 'builder',
    agent: 'claude', provider: 'anthropic', model_id: 'sonnet-id', model: 'sonnet', effort: 'high', transport: 'pane',
    kind: 'transport-error', stage: 'substrate-gone', detail: 'pane manager gone', attribution: 'host',
  })
})

test('emitAdapter maps modifier attempts with transport and from/to cells, including null crew', () => {
  const calls = []
  const emitter = {
    adwId: 'adw-modifier',
    phaseTransition: () => ({ phase_id: 12 }),
    emit: (fn) => fn({ recordEvent() {}, recordModifierAttempt: (row) => calls.push(row) }, () => 1),
  }
  const crew = {
    task: 'modifier-task',
    members: { builder: { agent: 'pi', provider: 'openai', id: 'luna', model: 'gpt-luna', effort: 'max', transport: 'headless-rpc' } },
  }
  const adapter = emitAdapter(emitter, crew)
  adapter({ kind: 'stage', label: 'build:r1' })
  adapter({
    kind: 'modifier', modifier: 'failure-upgrade', bounce: 'lane', role: 'builder', outcome: 'applied',
    why: null, rung: 'mechanical→build', from: { provider: 'anthropic', id: 'old', model: 'sonnet', agent: 'claude', effort: 'high' },
    to: { provider: 'openai', id: 'new', model: 'gpt-new', agent: 'pi', effort: 'max' },
  })
  assert.deepEqual(calls[0], {
    adw_id: 'adw-modifier', task_slug: 'modifier-task', phase_id: 12, role: 'builder', modifier: 'failure-upgrade',
    bounce: 'lane', outcome: 'applied', why: null, rung: 'mechanical→build', transport: 'headless-rpc',
    from_provider: 'anthropic', from_model_id: 'old', from_model: 'sonnet', from_agent: 'claude', from_effort: 'high',
    to_provider: 'openai', to_model_id: 'new', to_model: 'gpt-new', to_agent: 'pi', to_effort: 'max',
  })
  assert.doesNotThrow(() => emitAdapter(emitter)({
    kind: 'modifier', modifier: 'failure-upgrade', bounce: 'gate', role: 'reviewer', outcome: 'transport',
  }))
  assert.deepEqual(calls[1], {
    adw_id: 'adw-modifier', task_slug: null, phase_id: null, role: 'reviewer', modifier: 'failure-upgrade',
    bounce: 'gate', outcome: 'transport', why: null, rung: null, transport: null,
    from_provider: null, from_model_id: null, from_model: null, from_agent: null, from_effort: null,
    to_provider: null, to_model_id: null, to_model: null, to_agent: null, to_effort: null,
  })
})

test('emitAdapter routes discrimination triples, review outcomes, and typed accept decisions', () => {
  const calls = { gates: [], discriminations: [], reviews: [], accepts: [], events: [] }
  const emitter = {
    adwId: 'adw-outcomes',
    phaseTransition: () => ({ phase_id: 9 }),
    emit: (fn) => fn({
      recordEvent: (event) => calls.events.push(event),
      recordGateResult: (event) => calls.gates.push(event),
      recordGateDiscrimination: (event) => calls.discriminations.push(event),
      recordReviewOutcome: (event) => calls.reviews.push(event),
      recordAcceptDecision: (event) => calls.accepts.push(event),
    }, () => 1),
  }
  const adapter = emitAdapter(emitter)
  adapter({ kind: 'stage', label: 'build:r1' })
  adapter({ kind: 'gate', name: 'gate:r1', attempt: 1, ok: true, generation: 2, pristine: true, gate_run_ms: 7, gate_run_ms_absent_reason: null, summary: { total: 5, failed: 0, errored: 0 } })
  adapter({ kind: 'discrimination', generation: 2, verdict: 'proven', summary: { total: 5, failed: 5, errored: 0 }, note: 'proof' })
  adapter({ kind: 'envelope', id: 'reviewer1', role: 'reviewer', status: 'done', review: { verdict: 'changes-needed', must_fix: 2, should_fix: 1, consider: 0 } })
  adapter({ kind: 'envelope', id: 'builder1', role: 'builder', status: 'done' })
  adapter({
    kind: 'accept-decision', where: 'review-exhausted', outcome: 'escalated', findings_total: 2,
    residuals: [{ id: 'RV1-2', type: 'cosmetic', severity: 'should-fix' }],
    refuted: [{ id: 'RV1-1' }], unverified: [], errors: [{ id: 'RV1-1', why: 'bad decision' }],
  })

  assert.deepEqual(calls.gates[0], {
    adw_id: 'adw-outcomes', phase_id: 9, gate_name: 'gate:r1', attempt: 1, ok: true,
    checks: [{ total: 5, failed: 0, errored: 0 }], violations: [], gate_generation: 2, pristine: true,
    gate_run_ms: 7, gate_run_ms_absent_reason: null,
  })
  assert.deepEqual(calls.discriminations[0], {
    adw_id: 'adw-outcomes', phase_id: 9, gate_generation: 2, verdict: 'proven',
    checks_total: 5, checks_failed: 5, checks_errored: 0, note: 'proof',
  })
  assert.deepEqual(calls.reviews, [{
    adw_id: 'adw-outcomes', phase_id: 9, dispatch_id: 'reviewer1', role: 'reviewer',
    verdict: 'changes-needed', must_fix: 2, should_fix: 1, consider: 0,
  }])
  assert.deepEqual(calls.accepts, [{
    adw_id: 'adw-outcomes', phase_id: 9, where: 'review-exhausted', outcome: 'escalated',
    findings_total: 2, residual_count: 1, refuted_count: 1, cosmetic_count: 1,
    unverified_count: 0, invalid_reasons: 'RV1-1: bad decision',
  }])
})

test('emitAdapter carries the phase cursor onto events and fails malformed cursors closed', () => {
  let seq = 0
  const events = []
  const emitter = {
    adwId: 'adw-phase-test',
    phaseTransition: () => ({ phase_id: 7 }),
    emit: (fn) => fn({ recordEvent: (event) => events.push(event) }, () => ++seq),
  }
  const adapter = emitAdapter(emitter)
  adapter({ kind: 'assign', id: 'before', role: 'planner' })
  adapter({ kind: 'stage', label: 'plan:r1' })
  adapter({ kind: 'assign', id: 'after', role: 'planner' })
  assert.equal(events[0].phase_id, null)
  assert.equal(events[1].phase_id, 7)

  const malformed = {
    adwId: 'adw-malformed-phase',
    phaseTransition: () => 42,
    emit: (fn) => fn({ recordEvent: (event) => events.push(event) }, () => ++seq),
  }
  assert.doesNotThrow(() => emitAdapter(malformed)({ kind: 'stage', label: 'build:r1' }))
  assert.equal(events.at(-1).phase_id, null)
})

test('real ledger agent events reference their distinct planning and build phases', { skip: !nodeMeetsLedgerFloor }, () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-phase-state-'))
  const dbPath = join(stateDir, 'ledger.db')
  try {
    const emitter = openRun({ stateDir, repoSlug: 'repo', taskSlug: 'phase-task', dbPath })
    emitter.startRun()
    const adapter = emitAdapter(emitter)
    for (const event of [
      { kind: 'stage', label: 'plan:r1' },
      { kind: 'assign', id: 'p1', role: 'planner' },
      { kind: 'envelope', id: 'p1', role: 'planner', status: 'done' },
      { kind: 'stage', label: 'build:r1' },
      { kind: 'assign', id: 'b1', role: 'builder' },
      { kind: 'envelope', id: 'b1', role: 'builder', status: 'done' },
    ]) adapter(event)
    emitter.endRun({ status: 'ok' })
    const ledger = openLedger({ dbPath })
    const rows = ledger.listEvents({ adw_id: emitter.adwId, limit: 100 })
    const phaseIds = new Set(ledger.dumpTable('phases').filter((row) => row.adw_id === emitter.adwId).map((row) => row.id))
    const agents = rows.filter((row) => row.type === 'agent_start' || row.type === 'agent_end')
    assert.equal(agents.length, 4)
    assert.ok(agents.every((row) => row.phase_id !== null && phaseIds.has(row.phase_id)))
    const planner = agents.find((row) => JSON.parse(row.payload_json).role === 'planner')
    const builder = agents.find((row) => JSON.parse(row.payload_json).role === 'builder')
    assert.notEqual(planner.phase_id, builder.phase_id)
    assert.equal(emitter.stats().dropped, 0)
    ledger.close()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a real ledger round trip mirrors the complete drive event set', { skip: !nodeMeetsLedgerFloor }, () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-emit-state-'))
  const dbPath = join(stateDir, 'ledger.db')
  try {
    const emitter = openRun({ stateDir, repoSlug: 'repo', taskSlug: 'task', dbPath })
    emitter.startRun()
    const adapter = emitAdapter(emitter)
    for (const event of adapterEvents()) adapter(event)
    emitter.endRun({ status: 'ok' })
    const ledger = openLedger({ dbPath })
    const rows = ledger.listEvents({ adw_id: emitter.adwId, limit: 100 })
    assert.ok(rows.length >= 4)
    assert.ok(ledger.dumpTable('phases').length >= 1)
    assert.equal(ledger.getSession(emitter.adwId).status, 'ok')
    assert.equal(emitter.stats().dropped, 0)
    ledger.close()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a real ledger round trip mirrors drive gate verdicts into distinct gate_results rows', { skip: !nodeMeetsLedgerFloor }, () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'crew-gate-state-'))
  const dbPath = join(stateDir, 'ledger.db')
  try {
    const emitter = openRun({ stateDir, repoSlug: 'repo', taskSlug: 'gate-task', dbPath })
    emitter.startRun()
    const adapter = emitAdapter(emitter)
    const counts = {}
    let gateClock = 0
    const envelopes = {
      'planner:1': {
        status: 'done', role: 'planner', details: {
          plan_path: '/tmp/gate-task/plan.md', files_in_scope: ['a.mjs'],
          validation_lane: 'lane-cmd', gate_cmd: 'gate-cmd',
        },
      },
      'builder:1': { status: 'done', role: 'builder', details: { files_changed: ['a.mjs'], commit_message: 'feat: gate' } },
      'builder:2': { status: 'done', role: 'builder', details: { files_changed: ['a.mjs'], commit_message: 'feat: gate' } },
      'reviewer:1': { status: 'done', role: 'reviewer', details: { verdict: 'pass' } },
    }
    const io = {
      emit: adapter,
      assign({ role }) {
        counts[role] = (counts[role] || 0) + 1
        return { id: `${role}:${counts[role]}`, returnPath: `${role}:${counts[role]}` }
      },
      wait(path) { return envelopes[path] || null },
      writeFile() {}, readFile() { return null },
      run(cmd) {
        counts[cmd] = (counts[cmd] || 0) + 1
        if (cmd === 'gate-cmd') {
          const result = counts[cmd] === 1
            ? { ok: false, output: 'baseline\nGATE-SUMMARY {"total":3,"failed":3,"errored":0}' }
            : counts[cmd] === 2 ? { ok: false, output: 'red' } : { ok: true, output: 'green' }
          gateClock += 7
          return result
        }
        // a hand-built io has no `.calls`, so the census valve reads it as production
        if (String(cmd).includes('census-exhibits.mjs')) {
          return { ok: true, output: '{"action":"none","verdict":"green","selected":[],"failures":[],"defects":[],"detail":null,"reason":null,"denominator":{"suites":0,"tests":0}}\n' }
        }
        return { ok: true, output: '' }
      },
      // The driver cold-verifies before done and FAILS CLOSED (crew/drive.mjs).
      runCold() { return { ok: true, output: '', path: '/zz/aa11bb', kept: null } },
      changedFiles() { return ['a.mjs'] },
      commit() { return 'abc1234' },
      log() {}, status() {}, now() { return 0 }, gateNow() { return gateClock },
    }
    const ctx = {
      task: 'gate-task', briefFile: '/tmp/brief.md', taskDir: '/tmp/gate-task', checkout: '/tmp/repo',
      roles: ['lead', 'planner', 'builder', 'reviewer'], lane: null, suite: 'suite-cmd',
    }
    const result = driveTask({ ...ctx, limits: { gate_fails_to_triage: 3 } }, io)
    assert.equal(result.status, 'done')
    emitter.endRun({ status: 'ok' })
    const ledger = openLedger({ dbPath })
    const rows = ledger.dumpTable('gate_results').filter((row) => row.adw_id === emitter.adwId)
    assert.equal(rows.length, 3)
    assert.equal(new Set(rows.map((row) => `${row.gate_name}:${row.attempt}`)).size, 3)
    assert.ok(rows.every((row) => row.gate_run_ms === 7 && row.gate_run_ms_absent_reason === null))
    assert.equal(emitter.stats().dropped, 0)
    ledger.close()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a degraded emitter is inert for the adapter and drive', () => {
  const parent = mkdtempSync(join(tmpdir(), 'crew-emit-degraded-'))
  const stateFile = join(parent, 'not-a-dir')
  writeFileSync(stateFile, 'file')
  try {
    const emitter = openRun({ stateDir: stateFile, repoSlug: 'repo', taskSlug: 'task', dbPath: join(stateFile, 'ledger.db') })
    const adapter = emitAdapter(emitter)
    assert.doesNotThrow(() => adapterEvents().forEach((event) => adapter(event)))
    assert.ok(emitter.stats().dropped > 0, 'a degraded emitter must COUNT the adapter events it swallowed')

    const ctx = {
      task: 'degraded', briefFile: '/tmp/brief.md', taskDir: '/tmp/degraded-task', checkout: '/tmp/repo',
      roles: ['lead', 'planner', 'builder', 'reviewer'], lane: null, suite: 'suite-cmd',
    }
    const envelopes = {
      'planner:1': { status: 'done', role: 'planner', details: { plan_path: '/tmp/degraded-task/plan.md', files_in_scope: ['a.mjs', 'a.test.mjs'] } },
      'builder:1': { status: 'done', role: 'builder', details: { files_changed: ['a.mjs', 'a.test.mjs'], commit_message: 'feat: degraded' } },
      'reviewer:1': { status: 'done', role: 'reviewer', details: { verdict: 'pass' } },
    }
    const makeIo = (emit) => {
      const counts = {}
      const io = {
        assign({ role }) {
          counts[role] = (counts[role] || 0) + 1
          return { id: `${role}${counts[role]}`, returnPath: `${role}:${counts[role]}` }
        },
        wait(path) { return envelopes[path] || null },
        writeFile() {}, readFile() { return null },
        run() { return { ok: true, output: '' } },
        changedFiles() { return ['a.mjs', 'a.test.mjs'] },
        commit() { return 'abc1234' },
        log() {}, now() { return 0 },
      }
      if (emit) io.emit = emit
      return io
    }
    const plain = driveTask(ctx, makeIo())
    const degraded = driveTask(ctx, makeIo(adapter))
    assert.deepEqual(degraded, plain)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})
