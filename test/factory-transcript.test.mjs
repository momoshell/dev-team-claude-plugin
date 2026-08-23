// test/factory-transcript.test.mjs — the deep-review-class suite for
// scripts/factory/transcript.mjs (be-41-02, issue #41/SF-2, epic #39).
// Model: test/cmux-browser-evidence.test.mjs's both-direction firewall
// guard — this is the THIRD import-firewalled reducer in this repo (after
// triage.mjs / browser-evidence.mjs, conventions.md 2026-08-07).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = join(fileURLToPath(import.meta.url), '..')
const ROOT = join(HERE, '..')
const CREW_DIR = join(ROOT, 'crew')
const FACTORY_DIR = join(ROOT, 'scripts', 'factory')
const MODULE_PATH = join(FACTORY_DIR, 'transcript.mjs')

const {
  resolveTranscript, readUsage, readSessionUsage, readToolCalls, KNOWN_TOOL_NAMES,
} = await import(MODULE_PATH)

const fixture = mkdtempSync(join(tmpdir(), 'factory-transcript-'))
process.on('exit', () => { try { rmSync(fixture, { recursive: true, force: true }) } catch { /* best effort */ } })

let n = 0
function nextDir() {
  n += 1
  const dir = join(fixture, `t${n}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeTranscript(lines) {
  const dir = nextDir()
  const path = join(dir, 'transcript.jsonl')
  writeFileSync(path, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'))
  return path
}

// A real-shape assistant message: extra fields (uuid, sessionId, cwd,
// version, isSidechain) alongside the ones this reducer actually reads —
// modeled on scripts/task-cost-log.mjs's documented entry shape
// ({type, message:{id, model, usage}, timestamp}), per conventions.md
// 2026-08-08's "real-shape fixtures" rule (a captured shape, not a bare
// field list).
function assistantLine({ id, usage, timestamp, content }) {
  return {
    type: 'assistant',
    uuid: `uuid-${id}-${timestamp}`,
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd: '/Users/x/Development/dev-team-claude-plugin',
    sessionId: 'session-fixture',
    version: '2.1.225',
    timestamp,
    message: {
      id,
      role: 'assistant',
      model: 'claude-fixture-model',
      content: content || [{ type: 'text', text: 'hello' }],
      usage,
    },
  }
}

function userToolResultLine({ toolUseId, isError, timestamp, body }) {
  return {
    type: 'user',
    uuid: `uuid-result-${toolUseId}`,
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd: '/Users/x/Development/dev-team-claude-plugin',
    sessionId: 'session-fixture',
    version: '2.1.225',
    timestamp,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: body ?? 'ok', is_error: !!isError }],
    },
  }
}

// ---------------------------------------------------------------------------
// DEDUPE PINNED ON THE REAL CAPTURE (issue #56's forbidden overcount).
// ---------------------------------------------------------------------------

test('DEDUPE: the live 5 -> 5 -> 400 triple (one message.id, evolving output_tokens) sums to 400, not 410', () => {
  const id = 'msg_dedupe_01'
  const path = writeTranscript([
    assistantLine({ id, timestamp: '2026-08-09T00:00:00.000Z', usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }),
    assistantLine({ id, timestamp: '2026-08-09T00:00:00.100Z', usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }),
    assistantLine({ id, timestamp: '2026-08-09T00:00:00.200Z', usage: { input_tokens: 10, output_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }),
  ])
  const usage = readUsage({ transcriptPath: path })
  assert.equal(usage.billed_output_tokens, 400, 'must dedupe by message.id (last wins), not sum every line to 410')
  assert.notEqual(usage.billed_output_tokens, 410, 'the #56 over-count must not reproduce')
  assert.equal(usage.message_count, 1)
})

test('S1 DEDUPE: LAST wins even when it is strictly LOWER on every usage field (rules out a Math.max-per-field implementation)', () => {
  const id = 'msg_dedupe_lastwins'
  const path = writeTranscript([
    assistantLine({ id, timestamp: '2026-08-09T00:01:00.000Z', usage: { input_tokens: 500, output_tokens: 500, cache_creation_input_tokens: 500, cache_read_input_tokens: 500 } }),
    assistantLine({ id, timestamp: '2026-08-09T00:01:00.100Z', usage: { input_tokens: 3, output_tokens: 3, cache_creation_input_tokens: 3, cache_read_input_tokens: 3 } }),
  ])
  const usage = readUsage({ transcriptPath: path })
  // A Math.max-per-field implementation would report 500 on every field;
  // last-occurrence-wins must report the strictly lower, later values.
  assert.equal(usage.billed_input_tokens, 3, 'must take the LAST occurrence (3), not the max (500)')
  assert.equal(usage.billed_output_tokens, 3, 'must take the LAST occurrence (3), not the max (500)')
  assert.equal(usage.billed_cache_write_tokens, 3, 'must take the LAST occurrence (3), not the max (500)')
  assert.equal(usage.billed_cache_read_tokens, 3, 'must take the LAST occurrence (3), not the max (500)')
  assert.equal(usage.message_count, 1)
})

test('S1 DEDUPE: context_tokens is computed from the file\'s true last line, not Map-insertion-order (Array.from(map.values()).at(-1) would silently return the WRONG message here)', () => {
  const idA = 'msg_interleave_a'
  const idB = 'msg_interleave_b'
  const path = writeTranscript([
    // File order: A, B, A — idA's LAST line is also the file's LAST line,
    // but idB was inserted into the Map BEFORE idA's second occurrence, and
    // Map.set on an existing key never moves it to the end of iteration
    // order. So Map iteration order after this loop is [A, B] — meaning
    // Array.from(messages.values()).at(-1) would wrongly return idB's
    // (only) usage, not idA's true-last-line usage. Only tracking the
    // file-order `lastId` separately gets this right.
    assistantLine({ id: idA, timestamp: '2026-08-09T00:02:00.000Z', usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }),
    assistantLine({ id: idB, timestamp: '2026-08-09T00:02:01.000Z', usage: { input_tokens: 20, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }),
    assistantLine({ id: idA, timestamp: '2026-08-09T00:02:02.000Z', usage: { input_tokens: 70, output_tokens: 3, cache_creation_input_tokens: 5, cache_read_input_tokens: 10 } }),
  ])
  const usage = readUsage({ transcriptPath: path })
  assert.equal(usage.message_count, 2)
  // context_tokens must reflect idA's LAST occurrence (70 + 10 + 5 = 85,
  // the file's true last line), never idB's (only) occurrence (20 + 0 + 0
  // = 20, the Map-insertion-order-last value a .at(-1) bug would return).
  assert.equal(usage.context_tokens, 85, "context_tokens must come from the file's true last surviving line (idA's second occurrence), not an insertion-order artifact (idB)")
})

// ---------------------------------------------------------------------------
// C2 DERIVATIONS EXACT — asserted separately against a multi-message fixture.
// ---------------------------------------------------------------------------

test('C2: each derivation is asserted separately against a multi-message fixture', () => {
  const path = writeTranscript([
    assistantLine({
      id: 'msg_a',
      timestamp: '2026-08-09T00:00:01.000Z',
      usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 50 },
    }),
    assistantLine({
      id: 'msg_b',
      timestamp: '2026-08-09T00:00:02.000Z',
      usage: { input_tokens: 30, output_tokens: 7, cache_creation_input_tokens: 2, cache_read_input_tokens: 10 },
    }),
  ])
  const usage = readUsage({ transcriptPath: path })
  assert.equal(usage.billed_input_tokens, 130, 'billed_input_tokens = sum(input_tokens)')
  assert.equal(usage.billed_output_tokens, 27, 'billed_output_tokens = sum(output_tokens)')
  assert.equal(usage.billed_cache_write_tokens, 7, 'billed_cache_write_tokens = sum(cache_creation_input_tokens)')
  assert.equal(usage.billed_cache_read_tokens, 60, 'billed_cache_read_tokens = sum(cache_read_input_tokens)')
  assert.equal(usage.raw_read_tokens, 137, 'raw_read_tokens = sum(input_tokens + cache_creation_input_tokens), cache_read EXCLUDED')
  assert.equal(usage.raw_written_tokens, 27, 'raw_written_tokens = sum(output_tokens)')
  // last surviving message is msg_b: input(30) + cache_read(10) + cache_creation(2) = 42
  assert.equal(usage.context_tokens, 42, "context_tokens = the LAST surviving message's input + cache_read + cache_creation")
  assert.equal(usage.context_window, null, 'context_window is explicit null (U-4)')
})

test('C2 CLAMP: numOr0 never lets a negative or fractional usage field survive into the billed totals', () => {
  const path = writeTranscript([
    assistantLine({
      id: 'msg_clamp',
      timestamp: '2026-08-09T00:00:00.500Z',
      usage: { input_tokens: -999999, output_tokens: 1.7, cache_creation_input_tokens: -3.4, cache_read_input_tokens: 2.9 },
    }),
  ])
  const usage = readUsage({ transcriptPath: path })
  assert.equal(usage.billed_input_tokens, 0, 'a negative input_tokens must clamp to 0, never surface as negative')
  assert.equal(usage.billed_output_tokens, 1, 'a fractional output_tokens must truncate to an integer (1.7 -> 1)')
  assert.equal(usage.billed_cache_write_tokens, 0, 'a negative-and-fractional cache_creation_input_tokens must clamp to 0')
  assert.equal(usage.billed_cache_read_tokens, 2, 'a fractional cache_read_input_tokens must truncate to an integer (2.9 -> 2)')
})

test('readSessionUsage folds parent and subagent files, preserving split totals and per-file dedupe', () => {
  const transcriptPath = writeTranscript([
    assistantLine({ id: 'parent-dup', timestamp: '2026-08-09T00:03:00.000Z', usage: { input_tokens: 2, output_tokens: 5, cache_creation_input_tokens: 3, cache_read_input_tokens: 7 } }),
    assistantLine({ id: 'parent-dup', timestamp: '2026-08-09T00:03:00.100Z', usage: { input_tokens: 2, output_tokens: 400, cache_creation_input_tokens: 3, cache_read_input_tokens: 7 } }),
  ])
  const subagentsDir = join(dirname(transcriptPath), basename(transcriptPath, '.jsonl'), 'subagents')
  mkdirSync(subagentsDir, { recursive: true })
  writeFileSync(join(subagentsDir, 'agent-b.jsonl'), [
    JSON.stringify(assistantLine({ id: 'sub-dup', timestamp: '2026-08-09T00:04:00.000Z', usage: { input_tokens: 11, output_tokens: 7, cache_creation_input_tokens: 13, cache_read_input_tokens: 17 } })),
    JSON.stringify(assistantLine({ id: 'sub-dup', timestamp: '2026-08-09T00:04:00.100Z', usage: { input_tokens: 11, output_tokens: 60, cache_creation_input_tokens: 13, cache_read_input_tokens: 17 } })),
  ].join('\n'))
  writeFileSync(join(subagentsDir, 'agent-a.jsonl'), JSON.stringify(assistantLine({ id: 'sub-a', timestamp: '2026-08-09T00:05:00.000Z', usage: { input_tokens: 19, output_tokens: 9, cache_creation_input_tokens: 23, cache_read_input_tokens: 29 } })))
  writeFileSync(join(subagentsDir, 'not-an-agent.txt'), 'ignored')

  const usage = readSessionUsage({ transcriptPath })
  assert.equal(usage.billed_output_tokens, 469, 'parent 400 + subagent 60 + subagent 9')
  assert.equal(usage.billed_input_tokens, 32)
  assert.equal(usage.billed_cache_write_tokens, 39)
  assert.equal(usage.billed_cache_read_tokens, 53)
  assert.equal(usage.message_count, 3)
  assert.equal(usage.subagent_files, 2)
  assert.equal(usage.measured, true)
  assert.deepEqual(usage.parent_usage, {
    billed_input_tokens: 2, billed_output_tokens: 400,
    billed_cache_write_tokens: 3, billed_cache_read_tokens: 7,
  })
  assert.deepEqual(usage.subagent_usage, {
    billed_input_tokens: 30, billed_output_tokens: 69,
    billed_cache_write_tokens: 36, billed_cache_read_tokens: 46,
  })
  assert.equal(usage.context_tokens, 12, 'context belongs to the parent last message only')
})

test('readSessionUsage reports measured false for renamed fields and empty input, and tolerates absent or non-directory subagents', () => {
  const renamed = writeTranscript([
    assistantLine({ id: 'renamed', timestamp: '2026-08-09T00:06:00.000Z', usage: {
      input_tokens_v2: 1, output_tokens_v2: 2, cache_creation_input_tokens_v2: 3, cache_read_input_tokens_v2: 4,
    } }),
  ])
  const renamedUsage = readSessionUsage({ transcriptPath: renamed })
  assert.equal(renamedUsage.message_count, 1)
  assert.equal(renamedUsage.measured, false)

  const empty = writeTranscript([])
  const emptyUsage = readSessionUsage({ transcriptPath: empty })
  assert.equal(emptyUsage.measured, false)
  assert.equal(emptyUsage.subagent_files, 0)

  const noSubagents = writeTranscript([assistantLine({ id: 'plain', timestamp: '2026-08-09T00:07:00.000Z', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } })])
  assert.equal(readSessionUsage({ transcriptPath: noSubagents }).subagent_files, 0)
  const subagentsPath = join(dirname(noSubagents), basename(noSubagents, '.jsonl'), 'subagents')
  mkdirSync(dirname(subagentsPath), { recursive: true })
  writeFileSync(subagentsPath, 'not a directory')
  assert.doesNotThrow(() => readSessionUsage({ transcriptPath: noSubagents }))
  assert.equal(readSessionUsage({ transcriptPath: noSubagents }).subagent_files, 0)
})

// ---------------------------------------------------------------------------
// RESOLUTION REFUSES BOTH WAYS AND COUNTS THEM DISTINCTLY.
// ---------------------------------------------------------------------------

// Real-shaped dispatch_ids (the retired dispatch-record schema's
// `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`) — S4
// requires resolveTranscript to shape-guard the id to this pattern before
// ever using it in a filename scan, so fixtures below use valid UUIDs
// rather than the arbitrary strings a pre-S4 version tolerated.
const NO_SUCH_ID = '00000000-0000-4000-8000-000000000001'
const AMBIGUOUS_ID = '00000000-0000-4000-8000-000000000002'
const UNIQUE_ID = '00000000-0000-4000-8000-000000000003'

test('RESOLUTION: 0 matches -> null, stats.resolution_missing incremented, no log line', () => {
  const projectsDir = nextDir()
  mkdirSync(join(projectsDir, 'proj-a'), { recursive: true })
  const stats = {}
  const originalWrite = process.stderr.write
  let wrote = false
  process.stderr.write = (...args) => { wrote = true; return originalWrite.apply(process.stderr, args) }
  try {
    const result = resolveTranscript({ record: { dispatch_id: NO_SUCH_ID }, projectsDir, stats })
    assert.equal(result, null)
    assert.equal(stats.resolution_missing, 1)
    assert.equal(stats.resolution_ambiguous || 0, 0)
    assert.equal(wrote, false, 'the expected 0-match case must not log per call')
  } finally {
    process.stderr.write = originalWrite
  }
})

test('RESOLUTION: 2+ matches (same id under two project dirs) -> null, stats.resolution_ambiguous incremented, exactly ONE log line that never carries the raw id, never a guess', () => {
  const projectsDir = nextDir()
  const id = AMBIGUOUS_ID
  mkdirSync(join(projectsDir, 'proj-a'), { recursive: true })
  mkdirSync(join(projectsDir, 'proj-b'), { recursive: true })
  writeFileSync(join(projectsDir, 'proj-a', `${id}.jsonl`), '')
  writeFileSync(join(projectsDir, 'proj-b', `${id}.jsonl`), '')
  const stats = {}
  const originalWrite = process.stderr.write
  let writeCount = 0
  let captured = ''
  process.stderr.write = (chunk, ...rest) => { writeCount += 1; captured += String(chunk); return originalWrite.call(process.stderr, chunk, ...rest) }
  try {
    const result = resolveTranscript({ record: { dispatch_id: id }, projectsDir, stats })
    assert.equal(result, null)
    assert.equal(stats.resolution_ambiguous, 1)
    assert.equal(writeCount, 1, 'ambiguity must log exactly one line')
    assert.doesNotMatch(captured, new RegExp(id), 'the ambiguous-case log line must never carry the raw dispatch id — count/fact only')
  } finally {
    process.stderr.write = originalWrite
  }
})

test('RESOLUTION: exactly 1 match -> {claude_session_id, transcript_path}', () => {
  const projectsDir = nextDir()
  const id = UNIQUE_ID
  mkdirSync(join(projectsDir, 'proj-only'), { recursive: true })
  const expectedPath = join(projectsDir, 'proj-only', `${id}.jsonl`)
  writeFileSync(expectedPath, '')
  const stats = {}
  const result = resolveTranscript({ record: { dispatch_id: id }, projectsDir, stats })
  assert.deepEqual(result, { claude_session_id: id, transcript_path: expectedPath })
  assert.equal(stats.resolution_missing || 0, 0)
  assert.equal(stats.resolution_ambiguous || 0, 0)
})

test('RESOLUTION S4: a non-UUID-shaped dispatch_id is treated as missing, never scanned for (a REAL file planted where path traversal would land proves the guard fires, not coincidence)', () => {
  const projectsDir = nextDir()
  mkdirSync(join(projectsDir, 'proj-a'), { recursive: true })
  // Plant a REAL .jsonl file exactly where join(projectsDir, 'proj-a',
  // `${hostileId}.jsonl`) would lexically resolve to if the shape-guard
  // were absent (proj-a/.. cancels one '..', tN/.. cancels the other,
  // landing at fixture/loot.jsonl). Without the guard, the unguarded scan
  // would find this file and return a non-null match — so this test
  // actually fails if the guard is removed, unlike a hostile id with no
  // real file behind it (which returns null either way, by coincidence).
  const plantedPath = join(projectsDir, '..', 'loot.jsonl')
  writeFileSync(plantedPath, '')
  const hostileId = '../../loot'
  const stats = {}
  const result = resolveTranscript({ record: { dispatch_id: hostileId }, projectsDir, stats })
  assert.equal(result, null, 'the shape-guard must reject the hostile id before it is ever used to scan — a null result here is not from "no file found"')
  assert.equal(stats.resolution_missing, 1)
  assert.equal(stats.resolution_ambiguous || 0, 0)
})

test('RESOLUTION M2: a file deleted between the existence check and the stat (TOCTOU) degrades to no-match, never throws', () => {
  // resolveTranscript's contract is "never throw, return null on any
  // refusal." A single throwIfNoEntry:false statSync call (rather than a
  // separate existsSync + statSync pair) means there is no longer a window
  // in which a deleted file can be observed as existing and then throw on
  // stat — verified here for the general "file never exists" case, since
  // deterministically hitting the exact microsecond race window between two
  // syscalls isn't practical from a single-threaded test without stubbing
  // node:fs (which this module deliberately imports directly, unmockable
  // without a loader hook). Production code uses the race-proof single-call
  // form regardless.
  const projectsDir = nextDir()
  mkdirSync(join(projectsDir, 'proj-a'), { recursive: true })
  const goneId = '00000000-0000-4000-8000-0000000000ff'
  const stats = {}
  assert.doesNotThrow(() => resolveTranscript({ record: { dispatch_id: goneId }, projectsDir, stats }))
  const result = resolveTranscript({ record: { dispatch_id: goneId }, projectsDir, stats })
  assert.equal(result, null)
})

test('RESOLUTION: the dash-encoding is never derived (source-text needle: no code path constructs a project-dir name from a cwd)', () => {
  const src = readFileSync(MODULE_PATH, 'utf8')
  // Fragment-built needles so this scan cannot trip on its own prose.
  const dashDeriveNeedles = [
    ['rep', 'lace', "(/\\//g"].join(''),
    ['cwd', '.rep', 'lace'].join(''),
  ]
  for (const needle of dashDeriveNeedles) {
    assert.ok(!src.includes(needle), `transcript.mjs unexpectedly appears to derive a dash-encoding: ${needle}`)
  }
  assert.doesNotMatch(src, /process\.cwd\(\)/, 'resolution must never read process.cwd() to build a project-dir name')
})

// ---------------------------------------------------------------------------
// NO-SUBAGENTS ASSUMPTION SHIPS AS A DRIFT-GUARD TEST.
// ---------------------------------------------------------------------------

test('DRIFT GUARD (crew era): the builder seat — whose transcripts this reducer counts — never carries the subagent tool', () => {
  // The legacy contract.mjs is retired; the no-subagents assumption now
  // guards against the crew's own seat table.
  const crewSrc = readFileSync(join(CREW_DIR, 'crew.mjs'), 'utf8')
  const m = crewSrc.match(/builder:\s*\{[^}]*tools:\s*'([^']*)'/)
  assert.ok(m, 'builder seat tools literal not found in crew/crew.mjs')
  assert.doesNotMatch(m[1], /Task|Agent/, 'the builder seat must never carry the subagent tool — this reducer would silently under-count usage')
})

// ---------------------------------------------------------------------------
// IMPORT FIREWALL, BOTH DIRECTIONS.
// ---------------------------------------------------------------------------

const transcriptSrc = readFileSync(MODULE_PATH, 'utf8')

test('IMPORT FIREWALL (direction 1): transcript.mjs contains no repo import at all', () => {
  const lines = transcriptSrc.split('\n')
  for (const line of lines) {
    if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue
    if (/^import /.test(line)) {
      assert.match(line, /^import .* from 'node:/, `non-node import found: ${line}`)
    }
  }
  assert.doesNotMatch(transcriptSrc, /require\(/)
  assert.doesNotMatch(transcriptSrc, /\bimport\(/, 'no dynamic import() either')
  assert.doesNotMatch(transcriptSrc, /\bfrom ['"]\.\.?\//, 'no relative-path import/re-export either')
  assert.doesNotMatch(transcriptSrc, /^export \* from /m, 'no re-export either')
})

test('IMPORT FIREWALL (positive production half): seat-io.mjs is the reducer caller', () => {
  const seatSrc = readFileSync(join(CREW_DIR, 'seat-io.mjs'), 'utf8')
  assert.match(seatSrc, /from ['"]\.\.\/scripts\/factory\/transcript\.mjs['"]/, 'crew/seat-io.mjs must import the reducer as the pane producer')
})

test('IMPORT FIREWALL (direction 2): no crew decision module (drive.mjs, crew.mjs) imports transcript.mjs', () => {
  // The legacy decision modules (ladder/triage/contract) are retired; the
  // firewall now guards the crew's decision plane instead.
  for (const f of ['drive.mjs', 'crew.mjs']) {
    const src = readFileSync(join(CREW_DIR, f), 'utf8')
    assert.doesNotMatch(src, /factory\/transcript/, `crew/${f} must never import scripts/factory/transcript.mjs`)
  }
})

// ---------------------------------------------------------------------------
// SEEDED-MARKER MUTATION TEST: no task-controlled byte survives the
// reduction into returned JSON, stderr, or any file under stateDir/taskDir.
// ---------------------------------------------------------------------------

test('SEEDED MARKER: a hostile transcript\'s marker text appears in no returned object, no stderr, and no file under stateDir/taskDir', () => {
  const MARKER = 'DEVTEAM-SEEDED-MARKER-7f3c9a'
  const stateDir = nextDir()
  const taskDir = nextDir()

  const path = writeTranscript([
    assistantLine({
      id: 'msg_hostile',
      timestamp: '2026-08-09T00:00:03.000Z',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      content: [
        { type: 'text', text: `assistant prose carrying the marker: ${MARKER}` },
        { type: 'tool_use', id: 'toolu_hostile', name: `Weird${MARKER}Tool`, input: { arg: MARKER } },
      ],
    }),
    userToolResultLine({ toolUseId: 'toolu_hostile', isError: false, timestamp: '2026-08-09T00:00:04.000Z', body: `tool result body carrying the marker: ${MARKER}` }),
  ])

  const originalWrite = process.stderr.write
  let capturedStderr = ''
  process.stderr.write = (chunk, ...rest) => { capturedStderr += String(chunk); return originalWrite.call(process.stderr, chunk, ...rest) }

  let usage
  let toolCalls
  try {
    usage = readUsage({ transcriptPath: path })
    toolCalls = readToolCalls({ transcriptPath: path })
  } finally {
    process.stderr.write = originalWrite
  }

  assert.doesNotMatch(JSON.stringify(usage), new RegExp(MARKER), 'AgentUsage must never carry the marker')
  assert.doesNotMatch(JSON.stringify(toolCalls), new RegExp(MARKER), 'ToolCallTuple[] must never carry the marker')
  assert.doesNotMatch(capturedStderr, new RegExp(MARKER), 'stderr must never carry the marker')
  assert.equal(toolCalls[0].tool, 'other', 'a marker-laden tool name must not match the closed KNOWN_TOOL_NAMES set')

  function scanForMarker(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (scanForMarker(p)) return true
      } else if (statSync(p).isFile() && readFileSync(p, 'utf8').includes(MARKER)) {
        return true
      }
    }
    return false
  }
  assert.equal(scanForMarker(stateDir), false, 'no file under stateDir may carry the marker')
  assert.equal(scanForMarker(taskDir), false, 'no file under taskDir may carry the marker')
})

// ---------------------------------------------------------------------------
// TOOL NAMES ARE SHAPE-GUARDED TO A CLOSED SET.
// ---------------------------------------------------------------------------

test('TOOL SHAPE GUARD: an ANSI-escape/newline/5000-char tool name maps to the literal "other"', () => {
  const hostileName = `[31mBash[0m\ninjected\n${'x'.repeat(5000)}`
  const path = writeTranscript([
    assistantLine({
      id: 'msg_toolname',
      timestamp: '2026-08-09T00:00:05.000Z',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      content: [{ type: 'tool_use', id: 'toolu_x', name: hostileName, input: {} }],
    }),
    userToolResultLine({ toolUseId: 'toolu_x', isError: false, timestamp: '2026-08-09T00:00:06.000Z' }),
  ])
  const calls = readToolCalls({ transcriptPath: path })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].tool, 'other')
  assert.doesNotMatch(JSON.stringify(calls), /\x1b/, 'no ANSI escape byte survives into the returned tuple')
})

test('S5 CLOSED ALLOWLIST: KNOWN_TOOL_NAMES includes Task and Agent, so a DISALLOWED_TOOLS drift failure would surface here too, not just in the drift-guard test', () => {
  assert.ok(KNOWN_TOOL_NAMES.includes('Task'), 'Task must be a named member — never laundered into "other" if a role ever gains it')
  assert.ok(KNOWN_TOOL_NAMES.includes('Agent'), 'Agent must be a named member — never laundered into "other" if a role ever gains it')
})

test('S2 SINGLE-MODULE CALL SITES: readRawLines (module-private, unexported) is called from exactly the two documented sites in transcript.mjs', () => {
  const sites = []
  const lines = transcriptSrc.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/**')) continue
    if (/function readRawLines\(/.test(line)) continue // its own definition
    if (/readRawLines\(/.test(line)) sites.push(trimmed)
  }
  assert.equal(sites.length, 2, `expected exactly 2 call sites (readUsage, readToolCalls), found: ${JSON.stringify(sites)}`)
})

test('TOOL SHAPE GUARD: a member of KNOWN_TOOL_NAMES is forwarded verbatim', () => {
  const path = writeTranscript([
    assistantLine({
      id: 'msg_knowntool',
      timestamp: '2026-08-09T00:00:07.000Z',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      content: [{ type: 'tool_use', id: 'toolu_y', name: 'Bash', input: {} }],
    }),
    userToolResultLine({ toolUseId: 'toolu_y', isError: false, timestamp: '2026-08-09T00:00:08.000Z' }),
  ])
  const calls = readToolCalls({ transcriptPath: path })
  assert.equal(calls[0].tool, 'Bash')
  assert.ok(KNOWN_TOOL_NAMES.includes('Bash'))
})

// ---------------------------------------------------------------------------
// MALFORMED INPUT NEVER THROWS AND NEVER GUESSES.
// ---------------------------------------------------------------------------

test('MALFORMED: a truncated final line is dropped, never thrown, never counted toward billed totals', () => {
  const id = 'msg_trunc'
  const dir = nextDir()
  const path = join(dir, 'transcript.jsonl')
  const goodLine = JSON.stringify(assistantLine({ id, timestamp: '2026-08-09T00:00:09.000Z', usage: { input_tokens: 5, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }))
  const truncated = '{"type":"assistant","message":{"id":"msg_trunc2","usage":{"input_то'
  writeFileSync(path, `${goodLine}\n${truncated}`)
  assert.doesNotThrow(() => readUsage({ transcriptPath: path }))
  const usage = readUsage({ transcriptPath: path })
  assert.equal(usage.billed_input_tokens, 5)
  assert.equal(usage.dropped_lines, 1)
})

test('MALFORMED: a non-JSON line is dropped and counted, never thrown', () => {
  const dir = nextDir()
  const path = join(dir, 'transcript.jsonl')
  writeFileSync(path, 'this is not json at all\nneither is this {')
  assert.doesNotThrow(() => readUsage({ transcriptPath: path }))
  const usage = readUsage({ transcriptPath: path })
  assert.equal(usage.message_count, 0)
  assert.equal(usage.dropped_lines, 2)
  assert.equal(usage.billed_input_tokens, 0)
})

test('MALFORMED: an assistant line whose message lacks usage is dropped and counted, never thrown', () => {
  const path = writeTranscript([
    { type: 'assistant', timestamp: '2026-08-09T00:00:10.000Z', message: { id: 'msg_no_usage', role: 'assistant', content: [] } },
  ])
  assert.doesNotThrow(() => readUsage({ transcriptPath: path }))
  const usage = readUsage({ transcriptPath: path })
  assert.equal(usage.message_count, 0)
  assert.equal(usage.dropped_lines, 1)
})

test('MALFORMED: an empty file produces a well-formed zeroed result, never a throw', () => {
  const dir = nextDir()
  const path = join(dir, 'transcript.jsonl')
  writeFileSync(path, '')
  assert.doesNotThrow(() => readUsage({ transcriptPath: path }))
  const usage = readUsage({ transcriptPath: path })
  assert.deepEqual(usage, {
    billed_input_tokens: 0,
    billed_output_tokens: 0,
    billed_cache_write_tokens: 0,
    billed_cache_read_tokens: 0,
    raw_read_tokens: 0,
    raw_written_tokens: 0,
    context_tokens: 0,
    context_window: null,
    message_count: 0,
    dropped_lines: 0,
    measured: false,
  })
  assert.deepEqual(readToolCalls({ transcriptPath: path }), [])
})

test('MALFORMED: a missing file produces a well-formed zeroed result, never a throw', () => {
  const missingPath = join(fixture, 'does-not-exist', 'no.jsonl')
  assert.doesNotThrow(() => readUsage({ transcriptPath: missingPath }))
  const usage = readUsage({ transcriptPath: missingPath })
  assert.equal(usage.message_count, 0)
  assert.equal(usage.billed_input_tokens, 0)
  assert.equal(usage.context_tokens, 0)
  assert.deepEqual(readToolCalls({ transcriptPath: missingPath }), [])
})

// ---------------------------------------------------------------------------
// TOOL_CALL BACK-FILL CARRIES HISTORICAL TIMESTAMPS.
// ---------------------------------------------------------------------------

test('TOOL_CALL BACK-FILL: each tuple carries the transcript\'s own historical started_at/ended_at', () => {
  const path = writeTranscript([
    assistantLine({
      id: 'msg_tool1',
      timestamp: '2026-08-09T01:00:00.000Z',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }],
    }),
    userToolResultLine({ toolUseId: 'toolu_1', isError: false, timestamp: '2026-08-09T01:00:03.000Z' }),
  ])
  const calls = readToolCalls({ transcriptPath: path })
  assert.deepEqual(calls, [{ tool: 'Read', ok: true, started_at: '2026-08-09T01:00:00.000Z', ended_at: '2026-08-09T01:00:03.000Z' }])
})

test('TOOL_CALL BACK-FILL: a denied/failed call (is_error:true) is ok:false — U-3, both reduce to the same shape', () => {
  const path = writeTranscript([
    assistantLine({
      id: 'msg_tool2',
      timestamp: '2026-08-09T01:00:10.000Z',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: {} }],
    }),
    userToolResultLine({ toolUseId: 'toolu_2', isError: true, timestamp: '2026-08-09T01:00:11.000Z' }),
  ])
  const calls = readToolCalls({ transcriptPath: path })
  assert.equal(calls[0].ok, false)
})

test('TOOL_CALL BACK-FILL: a tool_use with no matching tool_result fails toward not-ok, never a success guess', () => {
  const path = writeTranscript([
    assistantLine({
      id: 'msg_tool3',
      timestamp: '2026-08-09T01:00:20.000Z',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      content: [{ type: 'tool_use', id: 'toolu_3', name: 'Grep', input: {} }],
    }),
  ])
  const calls = readToolCalls({ transcriptPath: path })
  assert.deepEqual(calls, [{ tool: 'Grep', ok: false, started_at: '2026-08-09T01:00:20.000Z', ended_at: null }])
})

// ---------------------------------------------------------------------------
// M1: entry.timestamp IS SHAPE-GUARDED TO THE ISO-MS PATTERN ledger.mjs's
// isoMs() ACCEPTS — a raw worker-controlled string must never escape as
// started_at/ended_at.
// ---------------------------------------------------------------------------

test('M1 SEEDED MARKER: a marker string seeded into entry.timestamp never appears in the returned tuple (maps to null)', () => {
  const MARKER = 'DEVTEAM-SEEDED-MARKER-timestamp-1a2b3c'
  const path = writeTranscript([
    {
      type: 'assistant',
      timestamp: MARKER,
      message: { id: 'msg_ts_marker', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_ts_marker', name: 'Read', input: {} }] },
    },
    {
      type: 'user',
      timestamp: MARKER,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ts_marker', content: 'ok', is_error: false }] },
    },
  ])
  const calls = readToolCalls({ transcriptPath: path })
  assert.equal(calls.length, 1)
  assert.doesNotMatch(JSON.stringify(calls), new RegExp(MARKER), 'no seeded marker byte may survive into started_at/ended_at')
  assert.equal(calls[0].started_at, null, 'a non-ISO-ms timestamp must map to null, never pass through raw')
  assert.equal(calls[0].ended_at, null, 'a non-ISO-ms timestamp must map to null, never pass through raw')
})

test('M1 MALFORMED TIMESTAMP: a well-formed-looking but non-ISO-ms timestamp maps to null, never throws', () => {
  const malformed = ['not-a-timestamp', '2026-08-09', '2026-08-09T00:00:00Z', '2026-08-09T00:00:00.000+00:00', '2026-08-09 00:00:00.000Z']
  for (const ts of malformed) {
    const path = writeTranscript([
      {
        type: 'assistant',
        timestamp: ts,
        message: { id: `msg_${ts.replace(/\W/g, '_')}`, role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_m', name: 'Read', input: {} }] },
      },
      {
        type: 'user',
        timestamp: ts,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_m', content: 'ok', is_error: false }] },
      },
    ])
    assert.doesNotThrow(() => readToolCalls({ transcriptPath: path }))
    const calls = readToolCalls({ transcriptPath: path })
    assert.equal(calls[0].started_at, null, `malformed timestamp ${JSON.stringify(ts)} must map to null, not pass through`)
    assert.equal(calls[0].ended_at, null, `malformed timestamp ${JSON.stringify(ts)} must map to null, not pass through`)
  }
})

test('M1 VALID: a well-formed ISO-ms timestamp still passes through unchanged', () => {
  const path = writeTranscript([
    {
      type: 'assistant',
      timestamp: '2026-08-09T00:00:00.000Z',
      message: { id: 'msg_ts_valid', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_v', name: 'Read', input: {} }] },
    },
    {
      type: 'user',
      timestamp: '2026-08-09T00:00:01.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_v', content: 'ok', is_error: false }] },
    },
  ])
  const calls = readToolCalls({ transcriptPath: path })
  assert.equal(calls[0].started_at, '2026-08-09T00:00:00.000Z')
  assert.equal(calls[0].ended_at, '2026-08-09T00:00:01.000Z')
})

// ---------------------------------------------------------------------------
// THIS MODULE NEVER WRITES ANYTHING.
// ---------------------------------------------------------------------------

test('S3 NO WRITES: the module\'s node:fs import specifiers are a subset of an explicit read-only allowlist', () => {
  // A 4-name regex (writeFileSync|appendFileSync|mkdirSync|createWriteStream)
  // misses writeFile, writeSync, openSync, renameSync, rmSync,
  // copyFileSync, and any node:fs/promises import entirely. Instead, pin
  // the actual set of names this module imports from node:fs and assert
  // every one of them is read-only.
  const READ_ONLY_ALLOWLIST = new Set(['readFileSync', 'readdirSync', 'statSync'])
  // matchAll + /gm (not .match with a bare /m) — a SECOND `import { ... }
  // from 'node:fs'` statement would be invisible to a single .match() call,
  // letting an added-and-actually-used import (e.g. unlinkSync) slip past
  // undetected. Union every matched specifier list before checking the
  // allowlist.
  const importMatches = [...transcriptSrc.matchAll(/^import \{([^}]*)\} from 'node:fs'$/gm)]
  assert.ok(importMatches.length > 0, "transcript.mjs must import from 'node:fs' via at least one named-import statement")
  const imported = importMatches
    .flatMap((m) => m[1].split(',').map((s) => s.trim()))
    .filter(Boolean)
  assert.ok(imported.length > 0, 'the node:fs import(s) must name at least one function')
  for (const name of imported) {
    assert.ok(READ_ONLY_ALLOWLIST.has(name), `${name} is not on the read-only allowlist — transcript.mjs must never write`)
  }
  assert.doesNotMatch(transcriptSrc, /from ['"]node:fs\/promises['"]/, 'transcript.mjs must never import node:fs/promises')
  assert.doesNotMatch(transcriptSrc, /writeFileSync|appendFileSync|mkdirSync|createWriteStream|writeFile\(|writeSync|openSync|renameSync|rmSync|copyFileSync/, 'transcript.mjs must never write — it only reads and returns plain objects')
})

// ---------------------------------------------------------------------------
// THE SEAT'S DENY HALF SHIPS AS A DRIFT-GUARD TEST TOO.
// ---------------------------------------------------------------------------
// The guard above reads the builder's `tools` literal and is proven to redden
// when it drifts; it never reads `deny`, so the seat's ENFORCED no-fan-out
// boundary could be deleted with a green suite (#476 sweep, V4). These guards
// read the seat table's real values instead of its source text.
// Covers: which FANOUT_TOOLS names each seat in SEAT_DEFAULTS actually        // LITERAL "Covers:"
// withholds through its `deny` string, and that every seat in the table
// declares a boundary here — so a NEW seat, or a silently emptied deny set,
// reddens.
// Does not cover: the non-fan-out deny names (Edit, NotebookEdit), the seats'  // LITERAL "Does not cover:"
// models, prompts, agents or `requires`, the `tools` allowlist (guarded
// above), and runtime register grants from crew/capabilities.json.
//
// MUTATION (deny half): change `deny: NO_FANOUT` to `deny: ''` on the builder  // LITERAL "MUTATION (deny half)"
// seat line in crew/crew.mjs and WITHHELD_FANOUT reddens; the tools guard
// above stays green, which is exactly the blind half this pins.
//
// A legitimate, intentional change to a seat's fan-out boundary is a one-line
// edit to this table.
const { SEAT_DEFAULTS, FANOUT_TOOLS, deniedFanout } = await import(join(CREW_DIR, 'crew.mjs'))

const WITHHELD_FANOUT = Object.freeze({
  lead: ['Task', 'Agent', 'Workflow'],
  planner: [],
  builder: ['Task', 'Agent', 'Workflow'],
  reviewer: [],
  'tech-lead': ['Task', 'Agent', 'Workflow'],
})

test('DRIFT GUARD (deny half): every seat withholds exactly the fan-out tools this table declares', () => {
  for (const [role, expected] of Object.entries(WITHHELD_FANOUT)) {
    assert.deepEqual(deniedFanout(role), expected, `seat ${role}'s fan-out deny boundary drifted from the one declared here`)  // LITERAL "deniedFanout(role), expected"
  }
})

test('DRIFT GUARD (deny half, roster completeness): every seat in SEAT_DEFAULTS declares its fan-out boundary here', () => {
  for (const role of Object.keys(SEAT_DEFAULTS)) {
    assert.ok(role in WITHHELD_FANOUT, `seat ${role} is in SEAT_DEFAULTS but declares no fan-out boundary in this guard`)  // LITERAL "role in WITHHELD_FANOUT,"
  }
})

test('DRIFT GUARD (deny half): the fan-out tool roster itself has not drifted', () => {
  assert.deepEqual([...FANOUT_TOOLS], ['Task', 'Agent', 'Workflow'])
})
