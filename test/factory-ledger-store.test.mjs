import { test } from 'node:test'

import assert from 'node:assert/strict'

import {
  readFileSync, writeFileSync, existsSync,
} from 'node:fs'

import { join } from 'node:path'

import { scratchDir } from './helpers.mjs'

import {
  openLedger, replayJsonl, mkdirpBounded, TABLES, WRITERS, WRITER_MIRROR_TABLES, UPDATE_ONLY_WRITERS, ingestJournal,
} from '../scripts/factory/ledger.mjs'

import { nextDir, run, fixture } from './factory-ledger.test.mjs'



test('mkdirpBounded creates a deep path, and refuses promptly under a regular file rather than looping', () => {
  const dir = nextDir()
  mkdirpBounded(join(dir, 'a', 'b', 'c'), 0o700)
  assert.ok(existsSync(join(dir, 'a', 'b', 'c')))
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'not a directory')
  assert.throws(() => mkdirpBounded(blocker, 0o700), (err) => err.code === 'EEXIST')
  assert.equal(readFileSync(blocker, 'utf8'), 'not a directory')
  assert.throws(() => mkdirpBounded(join(blocker, 'nested'), 0o700), (err) => err.code === 'ENOTDIR')
})

test('WRITER_MIRROR_TABLES and UPDATE_ONLY_WRITERS classify every WRITERS name exactly once, and every mapped table declares a unique key', () => {
  const mapped = Object.keys(WRITER_MIRROR_TABLES)
  const updateOnly = [...UPDATE_ONLY_WRITERS]
  assert.equal(new Set(mapped).size, mapped.length)
  assert.equal(new Set(updateOnly).size, updateOnly.length)
  assert.deepEqual(mapped.filter((writer) => updateOnly.includes(writer)), [])
  assert.deepEqual([...new Set([...mapped, ...updateOnly])].sort(), [...WRITERS].sort())
  for (const table of Object.values(WRITER_MIRROR_TABLES)) {
    assert.ok(TABLES[table])
    assert.ok(Array.isArray(TABLES[table].unique) && TABLES[table].unique.length > 0)
  }
})

test('RV1-2 turns corpus preserves ledger exclusions beside corpus exclusions', () => {
  const crewRoot = scratchDir('turns-corpus-rv1-2-')
  const dbPath = join(nextDir(), 'rv1-2.db')
  const ledger = openLedger({ dbPath, jsonlPath: join(nextDir(), 'rv1-2.jsonl') })
  try {
    ledger.recordSeatTurnCensus({ adw_id: 'rv1-2', role: 'builder', dispatch_id: 'd1', transport: 'headless-rpc', turns: null, absent_reason: 'no observable turns', at_ms: Date.parse('2030-01-01T00:00:00.000Z'), created_at: '2030-01-01T00:00:00.000Z' })
  } finally { ledger.close() }
  const result = run(['turns', '--crew-root', crewRoot], { DEVTEAM_LEDGER_DB: dbPath })
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.deepEqual(payload.excluded, {
    rows: 1,
    reason: 'a dispatch whose seat journalled no observable turn count is excluded from both terms of every rate',
  })
  assert.deepEqual(payload.corpus.excluded, [])
  assert.equal(payload.corpus.excluded_rows, 0)
})

test('shadow-pick JSONL replay preserves the exact mirrored values', () => {
  const sourceDir = scratchDir('shadow-pick-source-')
  const targetDir = scratchDir('shadow-pick-replay-')
  const source = openLedger({ dbPath: join(sourceDir, 'ledger.db') })
  const target = openLedger({ dbPath: join(targetDir, 'ledger.db') })
  const args = { adw_id: 'shadow-replay', role: 'builder', tier: 'build', schema_version: 1, outcome: 'not-consulted', seated: { provider: 'openai' }, picked: null, changes_seat: false, why: 'fixture', empty_reason: null, not_consulted_reason: 'policy-disabled', decides: false, exclusions: [{ provider: 'anthropic', id: 'c1', agent: 'claude', effort: 'high', reason: 'breaker-open', detail: 'open' }] }
  try {
    source.recordShadowPick(args)
    const expected = source.dumpTable('shadow_picks')
    assert.equal(replayJsonl(source._jsonlPath, target).failed, 0)
    assert.deepEqual(target.dumpTable('shadow_picks'), expected)
    assert.equal(target.dumpTable('shadow_picks')[0].not_consulted_reason, 'policy-disabled')
    assert.equal(target.dumpTable('shadow_picks')[0].decides, 0)
  } finally { source.close(); target.close() }
})

test('boot shadow picks ingest roles, exclusions, picker errors, no-shadow and duplicate journals', () => {
  const cell = { provider: 'openai', id: 'gpt-a', agent: 'pi', effort: 'medium' }
  const pick = (outcome, excluded = false) => ({ outcome, seated: cell, picked: outcome === 'picked' ? cell : null, changes_seat: false, why: 'fixture', empty_reason: null, not_consulted_reason: null, candidates: excluded ? [{ ...cell, excluded_by: { reason: 'breaker-open', detail: 'fixture' } }] : [] })
  const base = (shadow_pick) => ({ event: 'boot', at: '2026-09-01T00:00:00.000Z', roles: ['planner', 'builder'], seats: { planner: { ...cell, model: cell.id }, builder: { ...cell, model: cell.id } }, transports: { planner: 'headless-json', builder: 'headless-json' }, ...(shadow_pick === undefined ? {} : { shadow_pick }) })
  const ingest = (tag, record) => {
    const dir = scratchDir(`shadow-ingest-${tag}-`)
    const path = join(dir, 'journal.jsonl')
    writeFileSync(path, `${JSON.stringify(record)}\n`)
    const ledger = openLedger({ dbPath: join(dir, 'ledger.db') })
    return { dir, path, ledger, result: ingestJournal(path, ledger, { adw_id: tag }) }
  }
  const normal = ingest('normal', base({ schema_version: 1, tier: 'build', decides: false, seats: { planner: pick('stands'), builder: pick('picked', true) } }))
  const errored = ingest('errored', base({ schema_version: 1, error: 'picker exploded' }))
  const absent = ingest('absent', base(undefined))
  try {
    assert.equal(normal.result.failed, 0)
    const rows = normal.ledger.dumpTable('shadow_picks')
    assert.equal(rows.length, 2)
    assert.ok(JSON.parse(rows.find((row) => row.role === 'builder').exclusions_json).some((item) => item.reason === 'breaker-open' && item.detail === 'fixture'))
    assert.equal(errored.result.failed, 0)
    assert.equal(errored.ledger.dumpTable('shadow_picks').length, 2)
    assert.ok(errored.ledger.dumpTable('shadow_picks').every((row) => row.outcome === null && row.absent_reason === 'shadow-pick-error' && row.error === 'picker exploded' && row.tier === null))
    assert.equal(absent.result.failed, 0)
    assert.equal(absent.ledger.dumpTable('shadow_picks').length, 0)
    assert.equal(absent.ledger.dumpTable('run_seats').length, 2)
    const before = readFileSync(normal.ledger._jsonlPath, 'utf8').split('\n').filter((line) => line.includes('"kind":"recordShadowPick"')).length
    assert.equal(ingestJournal(normal.path, normal.ledger, { adw_id: 'normal' }).failed, 0)
    const after = readFileSync(normal.ledger._jsonlPath, 'utf8').split('\n').filter((line) => line.includes('"kind":"recordShadowPick"')).length
    assert.equal(rows.length, 2)
    assert.equal(before, 2)
    assert.equal(after, 2)
  } finally { normal.ledger.close(); errored.ledger.close(); absent.ledger.close() }
})

test('malformed shadow boot timestamp counts a line failure and later journal facts still ingest', () => {
  const dir = scratchDir('shadow-bad-boot-')
  const journalPath = join(dir, 'journal.jsonl')
  const cell = { provider: 'openai', id: 'gpt-a', agent: 'pi', effort: 'medium', model: 'gpt-a' }
  const rows = [
    { event: 'boot', at: 'garbage', roles: ['builder'], seats: { builder: cell }, transports: { builder: 'headless-json' }, shadow_pick: { schema_version: 1, tier: 'build', seats: { builder: { outcome: 'picked', seated: cell, picked: cell, candidates: [] } } } },
    { at: '2026-09-02T00:00:00.000Z', role: 'builder', id: 'd1', provider_failure: { kind: 'rate_limit', status: 429 } },
  ]
  writeFileSync(journalPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
  const ledger = openLedger({ dbPath: join(dir, 'ledger.db') })
  try {
    const result = ingestJournal(journalPath, ledger, { adw_id: 'bad-shadow-time' })
    assert.ok(result.failed >= 1)
    assert.equal(ledger.dumpTable('shadow_picks').length, 0)
    assert.equal(ledger.dumpTable('provider_failures').length, 1)
  } finally { ledger.close() }
})

test('ACP RV1-5 seat turn, tool-call, and null-id permission writers replay idempotently', () => {
  const sourceDir = scratchDir('seat-facts-source-'); const targetDir = scratchDir('seat-facts-target-')
  const source = openLedger({ dbPath: join(sourceDir, 'source.db') }); const target = openLedger({ dbPath: join(targetDir, 'target.db') })
  try {
    source.recordSeatTurn({ adw_id: 'lane', role: 'builder', assignment_id: 'd1', transport: 'acp', stop_reason: null, stop_reason_absent: 'response-unread', usage_reason: 'usage-unavailable', at: '2026-09-26T00:00:00.000Z' })
    source.recordSeatToolCall({ adw_id: 'lane', role: 'builder', assignment_id: 'd1', tool_call_id: 'tool-1', kind: 'edit', status: 'done', locations: ['a.mjs'], has_diff: true, at: '2026-09-26T00:00:01.000Z' })
    source.recordSeatPermission({ adw_id: 'lane', role: 'builder', tool_call_id: null, option_kind: 'reject_once', option_id: 'r', policy: 'no-lead', at: '2026-09-26T00:00:02.000Z' })
    assert.equal(replayJsonl(source._jsonlPath, target).failed, 0); assert.equal(replayJsonl(source._jsonlPath, target).failed, 0)
    for (const table of ['seat_turns', 'seat_tool_calls', 'seat_permissions']) assert.equal(target.dumpTable(table).length, 1)
  } finally { source.close(); target.close() }
})

test('G1 screener journal ingest failure never throws into its caller', () => {
  const dir = nextDir()
  const journalPath = join(dir, 'journal.jsonl')
  writeFileSync(journalPath, `${JSON.stringify({
    at: '2024-01-01T00:00:00.000Z',
    screener_proposal: { round: 1, proposal_id: 'g1', axis: 'scope', model: 'model-g', outcome: 'adopted' },
  })}\n`)
  const ledger = { recordScreenerProposal: () => { throw new Error('injected failure') } }
  let result
  assert.doesNotThrow(() => { result = ingestJournal(journalPath, ledger, { adw_id: 'screener-g1' }) })
  assert.deepEqual(result, {
    applied: 0, skipped: 0, ignored: 0, failed: 1, unstamped: 0, complete: false,
    first_failure: { line: 1, reason: 'Error' },
  })
})
