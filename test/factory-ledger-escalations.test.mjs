import { test } from 'node:test'

import assert from 'node:assert/strict'

import {
  rmSync, readFileSync, mkdirSync, writeFileSync,
} from 'node:fs'

import { join } from 'node:path'

import { spawnSync } from 'node:child_process'

import { ROOT, scratchDir } from './helpers.mjs'

import {
  ESCALATION_CAUSES, ESCALATION_CAUSE_UNCLASSIFIED, ESCALATION_CAUSE_RULE_GAP,
  ESCALATION_CAUSE_UNMEASURED, ESCALATION_MEASUREMENT_REASONS,
  escalationCause, openLedger, TABLES,
} from '../scripts/factory/ledger.mjs'

import { SUBMIT_BLIND_SPOT } from '../crew/driver.mjs'

import { headlessIo } from '../crew/headless.mjs'

import { run, fixture } from './factory-ledger.test.mjs'



test('escalationCause maps the archived envelopes and never guesses an unknown pair', () => {
  const cases = [
    // b309-dispatchprep — /Users/momoshell/.crew/dt-b309-dispatchprep/b309-dispatchprep.archive-2026-08-29T08-11-33-004Z/returns/task.json
    { where: 'planner', why: 'planner: no valid envelope at /Users/momoshell/.crew/dt-b309-dispatchprep/b309-dispatchprep/returns/d1.planner.json within 1800s — the seat is WORKING: planner produced a transcript frame 30s ago and simply exceeded its ', cause: 'seat-timeout', actor: 'driver' }, // Previously ratified the budget misclassification (#854 (1)).
    // b317-drivergone — /Users/momoshell/.crew/dt-b317-drivergone/b317-drivergone.archive-2026-08-29T14-24-05-878Z/returns/task.json
    { where: 'cold-suite', why: 'the cold verification produced no verdict (unproven): neutralColdPath: no neutral cold checkout path for ["b317-drivergone","dt-b317-drivergone","dev-team-claude-plugin"] — every candidate root was rejected [/private/var', cause: 'infrastructure', actor: 'driver' },
  // #899: these three fixtures cite a message crew/driver.mjs can still emit.
    // b321-driverpublish — /Users/momoshell/.crew/dt-b321-driverpublish/b321-driverpublish.archive-2026-08-29T16-35-01-212Z/returns/task.json
    { where: 'driver', why: `sendLine: echo not verified exactly once over baseline (before 0, last 0) — candidates ASSIGNMENT d1 — the cmux event stream recorded no send — blind spot: ${SUBMIT_BLIND_SPOT} — last 40 screen lines: b321`, cause: 'transport', actor: 'driver' },
    // b322-closeout#1 — /Users/momoshell/.crew/dt-b322-closeout/b322-closeout.archive-2026-08-29T15-14-14-427Z/returns/task.json
    { where: 'driver', why: 'sendLine: echo not verified exactly once over baseline (before 0, last 0)', cause: 'transport', actor: 'driver' },
    // b322-closeout#2 — /Users/momoshell/.crew/dt-b322-closeout/b322-closeout.archive-2026-08-29T15-18-22-532Z/returns/task.json
    { where: 'driver', why: 'sendLine: echo not verified exactly once over baseline (before 0, last 0)', cause: 'transport', actor: 'driver' },
    // b324-closeoutscript — /Users/momoshell/.crew/dt-b324-closeoutscript/b324-closeoutscript.archive-2026-08-29T17-05-09-432Z/returns/task.json
    { where: 'driver', why: `sendLine: echo not verified exactly once over baseline (before 0, last 0) — candidates ASSIGNMENT d1 — the cmux event stream recorded no send — blind spot: ${SUBMIT_BLIND_SPOT} — last 40 screen lines: b324`, cause: 'transport', actor: 'driver' },
    // b325-driverpublish#1 — /Users/momoshell/.crew/dt-b325-driverpublish/b325-driverpublish.archive-2026-08-29T17-01-58-919Z/returns/task.json
    { where: 'driver', why: `sendLine: echo not verified exactly once over baseline (before 0, last 0) — candidates ASSIGNMENT d1 — the cmux event stream recorded no send — blind spot: ${SUBMIT_BLIND_SPOT} — last 40 screen lines: b325`, cause: 'transport', actor: 'driver' },
    // b325-driverpublish#final — /Users/momoshell/.crew/dt-b325-driverpublish/b325-driverpublish/returns/task.json
    { where: 'gate', why: 'roof is clean (32/32 red, 0 errored) and 31 of 32 per-check mutations killed. The sole failure is A3b, whose outcome is anchor-absent: the plan declared find text "const rebased = baseSha !== mergeBase" for crew/drive.mjs, but the builder wrote `let rebased = false` at crew/drive', cause: 'plan-build-disagreement', actor: 'driver' },
    // b329-closeoutscript — /Users/momoshell/.crew/dt-b329-closeoutscript/b329-closeoutscript.archive-2026-08-30T15-32-26-023Z/returns/task.json
    { where: 'plan', why: "allowlisted read-only recipe' test reddens the moment package.json gains factory:closeout. The compiled brief therefore demands (acceptance h + 'Full suite green') something its own fence forbids — a contradiction inside an artifact compiled outside this workspace. A bounce is wo", cause: 'brief-contradiction', actor: 'operator' },
    { where: 'review', why: 'the lead could not settle finding 2 within its rounds', cause: 'review-unresolved', actor: 'lead' },
    { where: 'gate', why: 'the gate check C3 survived its declared mutation and the repair did not fix it', cause: 'gate-defect', actor: 'lead' },
    // b357-slotdriver — the headless seat-death shape (crew/seat-io.mjs:2185), measured 2026-09-01
    { where: 'seat-died', why: 'seat died: planner — its worker root 47302 (pgid 47302) is gone (probe-dead) and no envelope arrived at /Users/momoshell/.crew/dt-b357-slotdriver/b357-slotdriver/returns/d1.planner.json', cause: 'seat-lost', actor: 'driver' },
    // the pane seat-death shape (crew/seat-io.mjs:1847) must classify identically
    { where: 'seat-died', why: 'seat died: planner — its pane is gone (2 consecutive liveness probes) and no envelope arrived at /tmp/returns/d1.planner.json', cause: 'seat-lost', actor: 'driver' },
    // b337-fallback — /Users/momoshell/.crew/dt-b337-fallback/b337-fallback/returns/d6.builder.json
    { where: 'rpc-timeout', why: 'rpc timeout: seat builder did not produce an envelope at /Users/momoshell/.crew/dt-b337-fallback/b337-fallback/returns/d6.builder.json', cause: 'seat-timeout', actor: 'driver' },
    // b358-planadopt — /Users/momoshell/.crew/dt-b358-planadopt/b358-planadopt/returns/d4.reviewer.json
    { where: 'rpc-timeout', why: 'rpc timeout: seat reviewer did not produce an envelope at /Users/momoshell/.crew/dt-b358-planadopt/b358-planadopt/returns/d4.reviewer.json', cause: 'seat-timeout', actor: 'driver' },
    // b342-prbody — the prose matches the budget rule, but its timeout `where` outranks it
    { where: 'headless-timeout', why: 'headless timeout: seat planner produced no valid envelope at /Users/momoshell/.crew/dt-b342-prbody/b342-prbody/returns/d1.planner.json', cause: 'seat-timeout', actor: 'driver' },
    // b360-planadopt — /Users/momoshell/.crew/dt-b360-planadopt/b360-planadopt/returns/d3.reviewer.json
    { where: 'rpc-aborted', why: 'rpc aborted: seat reviewer did not produce an envelope at /Users/momoshell/.crew/dt-b360-planadopt/b360-planadopt/returns/d3.reviewer.json', cause: 'seat-aborted', actor: 'driver' },
    // b354-slotdriver — /Users/momoshell/.crew/dt-b354-slotdriver/b354-slotdriver/returns/task.json
    { where: 'plan', why: 'no accepted plan within 2 rounds', cause: 'plan-rounds-exhausted', actor: 'lead' },
  ]
  for (const { where, why, cause, actor } of cases) {
    const mapped = escalationCause({ where, why })
    assert.deepEqual(mapped, { cause, actor }, `${where}: ${why}`)
    assert.equal(Object.isFrozen(mapped), true)
  }
  for (const input of [
    {}, { where: 42, why: 17 }, { where: null, why: false }, null, 'not-an-envelope',
    undefined,
  ]) {
    assert.deepEqual(escalationCause(input), { cause: 'unmeasured', actor: null })
    assert.equal(Object.isFrozen(escalationCause(input)), true)
  }
  for (const input of [
    { where: 'plan-check', why: 'The one remaining High is a crash path, not a blemish: an unbounded reviewer id is interpolated into a patch artifact filename and written through an unguarded `io.writeFile`, aborting the run before the auto-fix is either applied or journalled as refused. I therefore cannot type it `cosmetic` without laundering a correctness gap, and `correctness-unverified` is refused into escalation by rule — so no honest accept exists here. Closing it requires two new gate checks with new labels and two new mutation entries, and the plan\'s `details.mutations` is a contract no seat may amend after acceptance, which puts the fix above my station. The divergence evidence (combined 91718 vs 44567, ratio 2.06) says another unfunded planning round is unlikely to produce a smaller shape, and I declined the second-opinion valve because both offered seats\' relevant knowledge is already on the page: the tech-lead authored this verdict and the reviewer has no diff to read at plan stage.' },
  ]) {
    assert.deepEqual(escalationCause(input), { cause: 'rule-gap', actor: null })
  }
  assert.deepEqual(escalationCause({ where: 'driver', why: 'anchor-absent in an unapplied change' }), { cause: 'plan-build-disagreement', actor: 'driver' })
  assert.deepEqual(escalationCause({ where: 'scope', why: 'exceeded its 1800s budget' }), { cause: 'plan-build-disagreement', actor: 'driver' })
  // Matched on `where` alone: prose is never what carries a seat death.
  assert.deepEqual(escalationCause({ where: 'seat-died', why: '' }), { cause: 'seat-lost', actor: 'driver' })
  assert.deepEqual(escalationCause({ where: 'transport', why: 'a location no producer emits' }), { cause: 'rule-gap', actor: null })
  assert.ok(ESCALATION_CAUSES.includes('seat-lost'))
  for (const cause of ['seat-timeout', 'seat-aborted', 'plan-rounds-exhausted']) {
    assert.ok(ESCALATION_CAUSES.includes(cause))
  }
  assert.deepEqual([...ESCALATION_CAUSES].slice(-3), [
    'envelope-unusable', 'envelope-absent', 'build-rounds-exhausted',
  ])
  assert.deepEqual([...ESCALATION_CAUSES].slice(0, 8), [
    'transport', 'budget', 'plan-build-disagreement', 'brief-contradiction',
    'gate-defect', 'review-unresolved', 'infrastructure', 'seat-lost',
  ])
})

test('escalationCause matches a seat failure on its stage, not on its prose', () => {
  assert.deepEqual(escalationCause({ where: 'rpc-timeout', why: '' }), { cause: 'seat-timeout', actor: 'driver' })
  assert.deepEqual(escalationCause({ where: 'headless-timeout', why: 'planner: no valid envelope at /x within 1800s' }), { cause: 'seat-timeout', actor: 'driver' })
  assert.deepEqual(escalationCause({ where: 'headless-timeout', why: 'exceeded its 1800s budget' }), { cause: 'seat-timeout', actor: 'driver' })
  assert.deepEqual(escalationCause({ where: 'rpc-aborted', why: '' }), { cause: 'seat-aborted', actor: 'driver' })
  assert.deepEqual(escalationCause({ where: 'headless-aborted', why: '' }), { cause: 'seat-aborted', actor: 'driver' })
  assert.deepEqual(escalationCause({ where: 'builder', why: 'rpc timeout: seat builder did not produce an envelope at /x' }), { cause: 'seat-timeout', actor: 'driver' })
  assert.deepEqual(escalationCause({ where: 'planner', why: 'headless timeout: seat planner produced no valid envelope at /x' }), { cause: 'seat-timeout', actor: 'driver' })
  assert.deepEqual(escalationCause({ where: 'builder', why: 'headless aborted: seat builder produced no valid envelope at /x' }), { cause: 'seat-aborted', actor: 'driver' })
  assert.deepEqual(escalationCause({ where: 'reviewer', why: 'rpc aborted: seat reviewer produced no envelope at /x' }), { cause: 'seat-aborted', actor: 'driver' })
  assert.deepEqual(escalationCause({ where: 'headless-budget-refused', why: 'headless budget-refused: seat planner produced no valid envelope at /x' }), { cause: 'budget', actor: 'driver' })
  assert.deepEqual(escalationCause({ where: 'headless-no-envelope', why: 'headless no-envelope: seat planner produced no valid envelope at /Users/momoshell/.crew/dt-b377-escalcause/b377-escalcause/returns/d1.planner.json' }), { cause: 'envelope-absent', actor: 'driver' })
  assert.deepEqual(escalationCause({ where: 'rpc-no-envelope', why: 'rpc no-envelope: seat planner produced no envelope at /Users/momoshell/.crew/dt-b377-escalcause/b377-escalcause/returns/d1.planner.json' }), { cause: 'envelope-absent', actor: 'driver' })
  assert.deepEqual(escalationCause({ where: 'headless-malformed', why: 'headless malformed: seat builder produced no valid envelope at /Users/momoshell/.crew/dt-b377-escalcause/b377-escalcause/returns/d2.builder.json' }), { cause: 'envelope-unusable', actor: 'driver' })
  assert.deepEqual(escalationCause({ where: 'rpc-malformed', why: 'rpc malformed: seat builder produced no envelope at /Users/momoshell/.crew/dt-b377-escalcause/b377-escalcause/returns/d2.builder.json' }), { cause: 'envelope-unusable', actor: 'driver' })
  assert.deepEqual(escalationCause({ where: 'rpc-parse-error', why: 'rpc parse failed: malformed input' }), { cause: 'envelope-unusable', actor: 'driver' })
})

test('the plan round cap is bounded to its own sentence', () => {
  assert.deepEqual(escalationCause({ where: 'plan', why: 'no accepted plan within 7 rounds' }), { cause: 'plan-rounds-exhausted', actor: 'lead' })
  assert.deepEqual(escalationCause({ where: 'plan', why: 'no accepted plan within 12 rounds' }), { cause: 'plan-rounds-exhausted', actor: 'lead' })
  assert.deepEqual(escalationCause({ where: 'plan', why: 'no accepted plan within rounds' }), { cause: 'rule-gap', actor: null })
  assert.deepEqual(escalationCause({ where: 'plan', why: 'planner envelope carries no files_in_scope — the scope gate cannot run without it' }), { cause: 'rule-gap', actor: null })
  assert.deepEqual(escalationCause({ where: 'plan', why: "allowlisted read-only recipe' test reddens the moment package.json gains factory:closeout. The compiled brief therefore demands (acceptance h + 'Full suite green') something its own fence forbids — a contradiction inside an artifact compiled outside this workspace. A bounce is wo" }), { cause: 'brief-contradiction', actor: 'operator' })
})

test('review-unresolved producer stage maps to the named cause', () => {
  assert.deepEqual(escalationCause({
    where: 'review-unresolved',
    why: 'the lead could not settle the ask-user finding and no review round remains',
  }), { cause: 'review-unresolved', actor: 'lead' })
})

test('build round cap is anchored to its own generated sentence', () => {
  assert.deepEqual(escalationCause({ where: 'build', why: 'no accepted build within 6 rounds' }), { cause: 'build-rounds-exhausted', actor: 'lead' })
  assert.deepEqual(escalationCause({ where: 'build', why: 'no accepted build within rounds' }), { cause: 'rule-gap', actor: null })
})

test('plan-scope-widened producer stage maps to a plan-build disagreement', () => {
  assert.deepEqual(escalationCause({
    where: 'plan-scope-widened',
    why: 'the plan widens the dispatched write surface with crew/drive.mjs — a lane may narrow the surface it was dispatched with, never widen it; on the final plan round there is no revision left to bounce it to',
  }), { cause: 'plan-build-disagreement', actor: 'driver' })
})

test('substrate-gone producer stage maps to transport', () => {
  assert.deepEqual(escalationCause({
    where: 'substrate-gone',
    why: 'substrate gone: planner — the pane manager stopped answering (3 consecutive substrate probes over 180s), so every pane it owned is unreachable and no envelope arrived at /Users/momoshell/.crew/dt-b377-escalcause/b377-escalcause/returns/d1.planner.json',
  }), { cause: 'transport', actor: 'driver' })
})

test('seat-refused producer stage maps to transport', () => {
  assert.deepEqual(escalationCause({
    where: 'seat-refused',
    why: 'seat refused: builder — the provider says: usage limit reached (rate-limit, from the claude transcript at 2026-09-01T10:00:00.000Z); no envelope arrived at /Users/momoshell/.crew/dt-b377-escalcause/b377-escalcause/returns/d2.builder.json',
  }), { cause: 'transport', actor: 'driver' })
})

test('variant-wrapped seat death maps to seat-lost', () => {
  assert.deepEqual(escalationCause({
    where: 'scout',
    why: 'the planner seat failed: seat died: planner — its pane is gone (2 consecutive liveness probes) and no envelope arrived at /Users/momoshell/.crew/dt-b377-escalcause/b377-escalcause/returns/d1.planner.json',
  }), { cause: 'seat-lost', actor: 'driver' })
})

test('a budget-refused headless outcome composes the ledger budget escalation cause', () => {
  const dir = scratchDir('factory-ledger-budget-refused-')
  const taskDir = join(dir, 'task'); const returnsDir = join(dir, 'returns')
  mkdirSync(taskDir); mkdirSync(returnsDir)
  const crew = { checkout: dir, members: { builder: { model: 'claude-fable-5', transport: 'headless-json' } } }
  const logs = []
  try {
    const io = headlessIo({
      crew, paths: { dir, taskDir, returnsDir }, taskDir, checkout: dir,
      adapters: { builder: { headlessCommand: () => ({ bin: '/bin/worker', args: [], env: {} }) } },
      bin: '/bin/worker',
      deps: {
        uuid: () => 'budget-refused-session', log: (row) => logs.push(row), kill: () => {},
        spawn: () => {
          const runDir = join(taskDir, 'headless', 'd1')
          writeFileSync(join(runDir, 'stream.jsonl'), `${JSON.stringify({ type: 'assistant', message: { model: '<synthetic>' } })}\n${JSON.stringify({ type: 'result', terminal_reason: 'api_error' })}\n`)
          writeFileSync(join(runDir, 'exit'), '1')
          return { pid: 7001, unref() {} }
        },
      },
    })
    const run = io.assign({ role: 'builder', briefFile: join(taskDir, 'brief.md') })
    let error
    try { io.wait(run.returnPath, 1) } catch (err) { error = err }
    assert.equal(error?.stage, 'headless-budget-refused')
    assert.ok(logs.some((row) => row.headless_outcome === 'budget-refused'))
    assert.deepEqual(escalationCause({ where: 'builder', why: error.message }), { cause: 'budget', actor: 'driver' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('ledger query docs pin typed outcomes, run seats, closed vocabularies, and their recipes', () => {
  const docs = readFileSync(join(ROOT, 'docs', 'ledger-queries.md'), 'utf8')
  for (const field of ['sessions.outcome', 'sessions.terminal_reason', 'sessions.terminal_actor']) {
    assert.ok(docs.includes(`\`${field}\``), `docs missing ${field}`)
  }
  for (const cause of [...ESCALATION_CAUSES, 'unclassified']) {
    assert.equal((docs.match(new RegExp('`' + cause + '`', 'g')) || []).length, 1, `${cause} must appear as a backticked vocabulary member exactly once`)
  }
  assert.match(docs, /ledger\.mjs escalations --since <iso>/)
  assert.ok(docs.includes('`run_seats`'))
  for (const source of ['roster', 'profile_recommendation', 'operator_override', 'reseat']) {
    assert.ok(docs.includes(`\`${source}\``), `docs missing ${source}`)
  }
  assert.match(docs, new RegExp(`\\*\\*${Object.keys(TABLES).length} tables\\*\\*`))
  assert.ok(docs.includes('`phase_slot_waits`'))
  assert.ok(docs.includes('Recipe M'))
  assert.match(docs, /FROM\s+run_seats/i)
})

// A1–E1: the closed measurement split — rule-gap vs unmeasured — and its CLI surface.
const ESCALATIONS_SCRIPT = join(ROOT, 'scripts', 'factory', 'ledger.mjs')
const UNMEASURED_DEFINITION = 'unmeasured means no readable task envelope survives; it may have been reaped or archived, and this view cannot tell those apart'

function writeTaskReturn(crewDir, escalation) {
  const returnsDir = join(crewDir, 'returns')
  mkdirSync(returnsDir, { recursive: true })
  writeFileSync(join(returnsDir, 'task.json'), `${JSON.stringify({ details: { escalation } })}\n`)
}

function seedEscalationWindow() {
  const root = scratchDir('factory-ledger-escsplit-')
  const dbPath = join(root, 'ledger.db')
  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  try {
    const seed = (adwId, i, terminal, actor, crewDir) => {
      ledger.startSession({
        adw_id: adwId, repo_slug: 'r', task_slug: adwId, started_at: '2026-09-15T00:00:00.000Z',
      })
      ledger.endSession({
        adw_id: adwId, status: 'aborted', outcome: 'escalated',
        terminal_reason: terminal, terminal_actor: actor, ended_at: `2026-09-16T00:00:0${i}.000Z`,
      })
      if (crewDir != null) ledger.linkRun({ run_id: `run-${adwId}`, adw_id: adwId, crew_dir: crewDir })
    }
    // Covered escalations keep their cause/actor with no envelope read.
    seed('esc-covered-transport', 0, 'transport', 'driver', null)
    // Uncovered locations re-read from the durable return.
    const liveHardenA = join(root, 'crew-harden-a')
    writeTaskReturn(liveHardenA, { where: 'harden', why: 'an uncovered harden failure with no blame rule' })
    seed('esc-harden-a', 1, ESCALATION_CAUSE_UNCLASSIFIED, null, liveHardenA)
    const liveHardenB = join(root, 'crew-harden-b')
    writeTaskReturn(liveHardenB, { where: 'harden', why: 'a second uncovered harden failure with no blame rule' })
    seed('esc-harden-b', 2, ESCALATION_CAUSE_UNCLASSIFIED, null, liveHardenB)
    // Archive sibling: the live dir survives with no return; the envelope reads from the archive.
    const livePlanCheck = join(root, 'crew-plan-check')
    mkdirSync(livePlanCheck, { recursive: true })
    writeTaskReturn(`${livePlanCheck}.archive-2026-09-16T00-00-00-000Z`, { where: 'plan-check', why: 'an uncovered plan-check failure with no blame rule' })
    seed('esc-plan-check', 3, ESCALATION_CAUSE_UNCLASSIFIED, null, livePlanCheck)
    // Legacy unclassified row with a readable covered envelope reroutes to the unchanged covered cause.
    const liveReroute = join(root, 'crew-reroute')
    writeTaskReturn(liveReroute, { where: 'review', why: 'the lead could not settle finding 2 within its rounds' })
    seed('esc-reroute', 4, ESCALATION_CAUSE_UNCLASSIFIED, null, liveReroute)
    // No surviving envelope (reaped crew dir): honest unmeasured.
    seed('esc-gone', 5, ESCALATION_CAUSE_UNCLASSIFIED, null, join(root, 'crew-reaped'))
    // NULL typed cause (child-driven run): re-read from the durable return like a legacy row.
    const liveNullCovered = join(root, 'crew-null-covered')
    writeTaskReturn(liveNullCovered, { where: 'review', why: 'the lead could not settle finding 3 within its rounds' })
    seed('esc-null-covered', 6, null, null, liveNullCovered)
  } finally {
    ledger.close()
  }
  return { root, dbPath }
}

function runEscalationsCli(dbPath) {
  const result = spawnSync(process.execPath, [
    ESCALATIONS_SCRIPT, 'escalations', '--since', '2026-09-15T00:00:00.000Z', '--until', '2026-09-17T00:00:00.000Z',
  ], { encoding: 'utf8', env: { ...process.env, DEVTEAM_LEDGER_DB: dbPath } })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('A1', () => {
  const gap = escalationCause({ where: 'harden', why: 'an uncovered harden failure with no blame rule' })
  assert.deepEqual(gap, { cause: 'rule-gap', actor: null })
  assert.equal(Object.isFrozen(gap), true)
  const missing = escalationCause({})
  assert.deepEqual(missing, { cause: 'unmeasured', actor: null })
  assert.equal(Object.isFrozen(missing), true)
  assert.notEqual(gap.cause, missing.cause)
})

test('B1', () => {
  assert.ok(!ESCALATION_CAUSES.includes(ESCALATION_CAUSE_UNMEASURED))
  assert.ok(!ESCALATION_CAUSES.includes(ESCALATION_CAUSE_RULE_GAP))
  assert.deepEqual([...ESCALATION_MEASUREMENT_REASONS], ['rule-gap', 'unmeasured'])
  for (const input of [{}, { where: 42, why: 17 }, null, 'not-an-envelope', { where: '', why: 'x' }]) {
    const mapped = escalationCause(input)
    assert.deepEqual(mapped, { cause: 'unmeasured', actor: null })
    assert.ok(!ESCALATION_CAUSES.includes(mapped.cause))
  }
})

test('C1', () => {
  const { root, dbPath } = seedEscalationWindow()
  try {
    const payload = runEscalationsCli(dbPath)
    assert.equal(payload.measured, true)
    assert.equal(payload.escalated, 7)
    assert.equal(payload.runs_ended, 7)
    assert.deepEqual(payload.rows.map(({ cause, actor, count }) => ({ cause, actor, count })), [
      { cause: 'review-unresolved', actor: 'lead', count: 2 },
      { cause: 'rule-gap', actor: null, count: 3 },
      { cause: 'transport', actor: 'driver', count: 1 },
      { cause: 'unmeasured', actor: null, count: 1 },
    ])
    for (const row of payload.rows) {
      assert.equal(typeof row.cause, 'string')
      assert.notEqual(row.cause, null)
    }
    assert.equal(payload.rows.filter((row) => row.cause == null).length, 0)
    assert.equal(payload.rows.reduce((n, row) => n + Number(row.count ?? 0), 0), 7)
    assert.deepEqual(payload.uncovered_where, [
      { where: 'harden', count: 2 },
      { where: 'plan-check', count: 1 },
    ])
    assert.deepEqual(payload.measurement_reasons, ['rule-gap', 'unmeasured'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('D1', () => {
  assert.deepEqual(
    escalationCause({ where: 'review', why: 'the lead could not settle finding 2 within its rounds' }),
    { cause: 'review-unresolved', actor: 'lead' },
  )
  assert.deepEqual(
    escalationCause({ where: 'driver', why: 'sendLine: echo not verified exactly once over baseline (before 0, last 0)' }),
    { cause: 'transport', actor: 'driver' },
  )
  const root = scratchDir('factory-ledger-escsplit-d1-')
  const dbPath = join(root, 'ledger.db')
  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  try {
    const crewDir = join(root, 'crew-reroute')
    writeTaskReturn(crewDir, { where: 'review', why: 'the lead could not settle finding 2 within its rounds' })
    ledger.startSession({
      adw_id: 'esc-legacy-covered', repo_slug: 'r', task_slug: 'esc-legacy-covered', started_at: '2026-09-15T00:00:00.000Z',
    })
    ledger.endSession({
      adw_id: 'esc-legacy-covered', status: 'aborted', outcome: 'escalated',
      terminal_reason: ESCALATION_CAUSE_UNCLASSIFIED, terminal_actor: null, ended_at: '2026-09-16T00:00:00.000Z',
    })
    ledger.linkRun({ run_id: 'run-esc-legacy-covered', adw_id: 'esc-legacy-covered', crew_dir: crewDir })
  } finally {
    ledger.close()
  }
  try {
    const payload = runEscalationsCli(dbPath)
    assert.deepEqual(payload.rows.map(({ cause, actor, count }) => ({ cause, actor, count })), [
      { cause: 'review-unresolved', actor: 'lead', count: 1 },
    ])
    assert.deepEqual(payload.uncovered_where, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('E1', () => {
  const root = scratchDir('factory-ledger-escsplit-e1-')
  const dbPath = join(root, 'ledger.db')
  const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
  try {
    ledger.startSession({
      adw_id: 'esc-gone', repo_slug: 'r', task_slug: 'esc-gone', started_at: '2026-09-15T00:00:00.000Z',
    })
    ledger.endSession({
      adw_id: 'esc-gone', status: 'aborted', outcome: 'escalated',
      terminal_reason: ESCALATION_CAUSE_UNCLASSIFIED, terminal_actor: null, ended_at: '2026-09-16T00:00:00.000Z',
    })
  } finally {
    ledger.close()
  }
  try {
    const payload = runEscalationsCli(dbPath)
    assert.equal(payload.definition.unmeasured, UNMEASURED_DEFINITION)
    assert.match(payload.definition.unmeasured, /reaped or archived/)
    assert.match(payload.definition.unmeasured, /cannot tell those apart/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
