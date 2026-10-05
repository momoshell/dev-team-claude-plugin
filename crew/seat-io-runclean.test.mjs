import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync as realSpawnSync } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  COLD_PATH_FALLBACK_ROOTS, COLD_PATH_MIN_SHARED, cellFailureKind, claudeRefusalFrames, claudeTranscriptPaths, coldGuardNames, coldPathCollision, coldPathRoots, coldRootCollision, DESCENDANT_STORE_DIRS, descendantCapture, emitAdapter, HEADLESS_RPC_TRANSPORT, HEADLESS_TRANSPORT, LIVENESS_MISSES_TO_DIE, LIVENESS_PROBE_MS, neutralColdPath, REASK_SETTLE_POLLS, REASK_TIMEOUT_S, SEAT_DIED_STAGE, SEAT_LIVENESS_EVENT, SUBSTRATE_GRACE_MS, paneRetryFrame, piRefusalFrames, piSessionDir, piTranscriptPaths,
  providerConditionDetail, paneUsageFrames, paneSeatPolicyRow, readEnvelopeFile, reaskDecision, recogniseProviderRetry, saveCrew, seatIo, seatRetryDecision, settleSeatTeardown, turnCeilingValues,
  SEAT_RETRY_EVENTS, SEAT_RETRY_KINDS, SEAT_RETRY_MAX,
  SEAT_REFUSAL_STAGE, SILENCE_REASK_MS, TRANSCRIPT_STALE_MS, WAIT_POLL_MS, waitForEnvelope, waitState, transcriptGrowth, silenceReaskDecision, paneTurnCensus,
} from './seat-io.mjs'
import { headlessIo, recogniseProviderCondition, PANE_NO_INTERCEPT, SEAT_REFUSALS, SEAT_SUITE_POLICY_EVENT, claudeCensus } from './headless.mjs'
import { JOURNAL_CHANNEL_NAMES, RESUME_CHECKPOINT_VERSION, resumeTask, resumeWorktreeSha256, settleRetriedCold } from './drive.mjs'
import { CTX, GATE_SUMMARY_PREFIX, closeoutIo, driveTask, fakeIo } from './drive-fixtures.mjs'
import { forAll, git, ROOT, scratchDir, startFileWriter } from '../test/helpers.mjs'
import { teardownCore } from './crew.mjs'
import { driveJournalSites, noncanonicalJournalSinks } from './drive-fixtures.mjs'
import { tokenizeJs, blankJsComments } from './js-tokens.mjs'

const PANE_CAPTURE = String.raw`{"parentUuid":"c828178b-a377-46d3-b09e-bb9bcb7fd718","isSidechain":false,"message":{"model":"claude-opus-5","id":"msg_011CerSPg8agTgq9MxjMHBVf","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01GSd211FY8ZKTrthuDHX1Er","name":"Bash","input":{"command":"sed -n '6060,6135p' crew/drive.mjs; echo \"=== GATE ===\"; cat /Users/momoshell/.crew/dt-b564-proofscope/b564-proofscope/task/gate.mjs | head -60","description":"Read post-green proof loop and gate checks"},"caller":{"type":"direct"}}],"stop_reason":"tool_use","stop_sequence":null,"stop_details":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":35997,"cache_read_input_tokens":0,"output_tokens":1008,"output_tokens_details":{"thinking_tokens":821},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":35997,"ephemeral_5m_input_tokens":0},"inference_geo":"not_available","iterations":[{"input_tokens":2,"output_tokens":1008,"cache_read_input_tokens":0,"cache_creation_input_tokens":35997,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":35997},"type":"message"}]},"diagnostics":null},"apiBlockIndex":1,"requestId":"req_011CerSPfVP8MYSnfLQABzQz","type":"assistant","uuid":"7d518552-0575-431b-aa4a-bc10eae84893","timestamp":"2026-09-08T18:23:16.916Z","effort":"high","userType":"external","entrypoint":"sdk-cli","cwd":"/Users/momoshell/Dev/dt-b564-proofscope","sessionId":"c8d9af08-1b11-408b-bf4f-58d63ca8a873","version":"2.1.263","gitBranch":"b564-proofscope"}
{"parentUuid":"7eb9c965-2cbc-4368-b584-d55b189d37f6","isSidechain":false,"message":{"model":"claude-opus-5","id":"msg_011CerSQkzoL21CsnWAyS3pq","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01BC9djpCppspgFjAo738imQ","name":"Bash","input":{"command":"cd /Users/momoshell/.crew/dt-b564-proofscope/b564-proofscope; node -p \"const e=require('./returns/d3.planner.json'); JSON.stringify({mut:(e.details.mutations||[]).map(m=>({check:m.check,file:m.file,find:(m.find||'').slice(0,60)})), files:e.details.files_in_scope},null,1)\"","description":"Inspect planner envelope mutations and scope"},"caller":{"type":"direct"}}],"stop_reason":"tool_use","stop_sequence":null,"stop_details":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":3732,"cache_read_input_tokens":35997,"output_tokens":787,"output_tokens_details":{"thinking_tokens":572},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":3732,"ephemeral_5m_input_tokens":0},"inference_geo":"not_available","iterations":[{"input_tokens":2,"output_tokens":787,"cache_read_input_tokens":0,"cache_creation_input_tokens":3732,"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":3732},"type":"message"}]},"diagnostics":null},"apiBlockIndex":1,"requestId":"req_011CerSQkBgmugDqLmrNtanB","type":"assistant","uuid":"82ac935a-e9de-4bb6-beb6-ef9ba41718c3","timestamp":"2026-09-08T18:23:29.284Z","effort":"high","userType":"external","entrypoint":"sdk-cli","cwd":"/Users/momoshell/Dev/dt-b564-proofscope","sessionId":"c8d9af08-1b11-408b-bf4f-58d63ca8a873","version":"2.1.263","gitBranch":"b564-proofscope"}`

test('CC3', () => {
  const root = scratchDir('pane-census-')
  const transcript = join(root, 'session.jsonl')
  const taskDir = join(root, 'task')
  mkdirSync(taskDir)
  const [firstFrame] = PANE_CAPTURE.split('\n')
  writeFileSync(transcript, `${firstFrame}\n`)
  const adapter = { paneUsageRecords: () => [{ session_id: 'session-1', transcript_path: transcript }] }
  const census = paneTurnCensus({ taskDir, role: 'builder', id: 'dispatch-1', model: 'claude-opus-5', adapter })
  const folded = claudeCensus(`${firstFrame}\n`)
  assert.deepEqual([census.role, census.dispatch_id, census.transport, census.model, census.session_id], ['builder', 'dispatch-1', 'pane', 'claude-opus-5', 'session-1'])
  assert.deepEqual([census.context_first_tokens, census.context_calls, census.turns, census.tool_calls], [35999, 1, 1, 1])
  assert.deepEqual([census.context_first_tokens, census.context_calls, census.turns, census.tool_calls], [folded.context_first_tokens, folded.context_calls, folded.turns, folded.tool_calls])
})

test('CC4', () => {
  const root = scratchDir('pane-census-cursor-')
  const transcript = join(root, 'session.jsonl')
  const taskDir = join(root, 'task')
  mkdirSync(taskDir)
  const [firstFrame, secondFrame] = PANE_CAPTURE.split('\n')
  writeFileSync(transcript, `${firstFrame}\n`)
  const adapter = { paneUsageRecords: () => [{ session_id: 'session-1', transcript_path: transcript }] }
  paneTurnCensus({ taskDir, role: 'builder', adapter })
  writeFileSync(transcript, `${firstFrame}\n${secondFrame}\n`)
  const next = paneTurnCensus({ taskDir, role: 'builder', adapter })
  const folded = claudeCensus(`${secondFrame}\n`)
  // Mutation: resetting the per-session start offset to zero recounts the first captured frame.
  assert.deepEqual([next.context_first_tokens, next.context_calls, next.turns, next.tool_calls], [39731, 1, 1, 1])
  assert.deepEqual([next.context_first_tokens, next.context_calls, next.turns, next.tool_calls], [folded.context_first_tokens, folded.context_calls, folded.turns, folded.tool_calls])
})

test('pane partial lines, Unicode bytes, and growing sessions are counted once', () => {
  const root = scratchDir('pane-census-growing-')
  const taskDir = join(root, 'task')
  const first = join(root, 'first.jsonl')
  const second = join(root, 'second.jsonl')
  mkdirSync(taskDir)
  const row = (context, id) => Buffer.from(JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: context }, content: [{ type: 'tool_use', id: `tool-${id}`, name: 'Read' }], extra: '☃' } }) + '\n')
  const partial = row(120, 'partial')
  writeFileSync(first, partial.subarray(0, partial.length - 1))
  writeFileSync(second, row(230, 'later'))
  const adapter = { paneUsageRecords: () => [{ session_id: 's1', transcript_path: first }, { session_id: 's2', transcript_path: second }] }
  const initial = paneTurnCensus({ taskDir, role: 'builder', adapter })
  assert.equal(initial.context_first_tokens, 230)
  assert.equal(initial.session_id, 's2')
  writeFileSync(first, partial)
  const next = paneTurnCensus({ taskDir, role: 'builder', adapter })
  assert.equal(next.context_first_tokens, 120)
  assert.equal(next.session_id, 's1')
  assert.equal(paneTurnCensus({ taskDir, role: 'builder', adapter }).context_absent_reason, 'census-absent')
})

test('pane census combines complete lines from every growing session in discovery order', () => {
  const root = scratchDir('pane-census-multiple-growing-')
  const taskDir = join(root, 'task')
  const first = join(root, 'first.jsonl')
  const second = join(root, 'second.jsonl')
  mkdirSync(taskDir)
  const row = (context, id) => JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: context }, content: [{ type: 'tool_use', id: `tool-${id}`, name: 'Read' }] } }) + '\n'
  writeFileSync(first, row(120, 'first'))
  writeFileSync(second, row(230, 'second'))
  const adapter = { paneUsageRecords: () => [{ session_id: 's1', transcript_path: first }, { session_id: 's2', transcript_path: second }] }
  const census = paneTurnCensus({ taskDir, role: 'builder', adapter })
  assert.equal(census.context_calls, 2)
  assert.equal(census.context_first_tokens, 120)
  assert.equal(census.session_id, 's2')
})

test('CC5', () => {
  const root = scratchDir('pane-census-absent-')
  const taskDir = join(root, 'task')
  const transcript = join(root, 'session.jsonl')
  mkdirSync(taskDir)
  const complete = `${JSON.stringify({ type: 'assistant', message: { id: 'valid', usage: { input_tokens: 88 } } })}\n`
  writeFileSync(transcript, complete)
  const records = [{ session_id: 's', transcript_path: transcript }]
  const adapter = { paneUsageRecords: () => records }
  const absent = paneTurnCensus({ taskDir, role: 'builder', agent: 'pi', adapter })
  assert.deepEqual([absent.context_first_tokens, absent.context_peak_tokens, absent.context_mean_tokens, absent.context_calls, absent.context_absent_reason], [null, null, null, null, 'census-absent'])
  assert.equal(paneTurnCensus({ taskDir, role: 'builder', adapter: { paneUsageRecords: () => [] } }).context_absent_reason, 'census-absent')
  assert.equal(paneTurnCensus({ taskDir, role: 'builder', adapter }).context_absent_reason, null)
  assert.equal(paneTurnCensus({ taskDir, role: 'builder', adapter }).context_absent_reason, 'census-absent')
  const usageDir = join(taskDir, 'usage')
  mkdirSync(usageDir, { recursive: true })
  const writeDeniedDir = join(taskDir, 'write-denied')
  mkdirSync(writeDeniedDir)
  const writeDenied = paneTurnCensus({ taskDir: writeDeniedDir, role: 'builder', adapter, deps: { writeFileSync: () => { const error = new Error('denied'); error.code = 'EPERM'; throw error } } })
  assert.equal(writeDenied.context_first_tokens, 88)
})

test('RV1-1 corrupt and EPERM cursor reads preserve durable state', () => {
  const root = scratchDir('pane-census-cursor-integrity-')
  const taskDir = join(root, 'task')
  const transcript = join(root, 'session.jsonl')
  mkdirSync(taskDir)
  writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { id: 'valid', usage: { input_tokens: 88 } } })}\n`)
  const adapter = { paneUsageRecords: () => [{ session_id: 's', transcript_path: transcript }] }
  mkdirSync(join(taskDir, 'usage'))
  const cursor = join(taskDir, 'usage', 'builder.census.json')
  writeFileSync(cursor, '{')
  // Mutation: accepting malformed durable state silently replays the transcript.
  assert.equal(paneTurnCensus({ taskDir, role: 'builder', adapter }).context_absent_reason, 'census-absent')
  assert.equal(readFileSync(cursor, 'utf8'), '{')
  writeFileSync(cursor, JSON.stringify({ s: 0 }))
  // Mutation: swallowing EPERM silently replays the transcript from byte zero.
  const denied = paneTurnCensus({ taskDir, role: 'builder', adapter, deps: { readFileSync: (path, ...args) => {
    if (path === cursor) { const error = new Error('denied'); error.code = 'EPERM'; throw error }
    return readFileSync(path, ...args)
  } } })
  assert.equal(denied.context_absent_reason, 'census-absent')
  assert.equal(readFileSync(cursor, 'utf8'), JSON.stringify({ s: 0 }))
})

const CONTENT = Object.freeze({
  committed: 'committed tracked content\n',
  dirty: 'dirty tracked content\n',
  target: 'target v1\n',
  victim: 'victim v1\n',
  untracked: 'untracked content\n',
  ignored: 'ignored secret content\n',
  node: 'node package content\n',
})

function makeRepo({ dirty = true, linked = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'crew-run-clean-'))
  const repoDir = join(root, 'repo')
  mkdirSync(repoDir)
  const paths = { dir: root, taskDir: join(root, 'task'), returnsDir: join(root, 'returns') }
  mkdirSync(paths.taskDir)
  mkdirSync(paths.returnsDir)

  git(repoDir, 'init')
  writeFileSync(join(repoDir, '.gitignore'), 'ignored/\nnode_modules/\n')
  writeFileSync(join(repoDir, 'tracked.txt'), CONTENT.committed)
  writeFileSync(join(repoDir, 'witness-target.txt'), CONTENT.target)
  writeFileSync(join(repoDir, 'witness-victim.txt'), CONTENT.victim)
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-m', 'initial')

  if (dirty) {
    writeFileSync(join(repoDir, 'tracked.txt'), CONTENT.dirty)
    writeFileSync(join(repoDir, 'untracked.txt'), CONTENT.untracked)
    mkdirSync(join(repoDir, 'ignored'))
    writeFileSync(join(repoDir, 'ignored', 'secret.txt'), CONTENT.ignored)
    mkdirSync(join(repoDir, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(repoDir, 'node_modules', 'pkg', 'index.js'), CONTENT.node)
  }

  const fixture = { root, repoDir, paths, checkout: repoDir }
  if (linked) fixture.checkout = addLane(fixture, 'linkedLane', CONTENT.dirty)
  return fixture
}

function addLane(fixture, name, tracked) {
  const dir = join(fixture.root, name)
  git(fixture.repoDir, 'worktree', 'add', '-q', '-b', name, dir)
  writeFileSync(join(dir, 'tracked.txt'), tracked)
  writeFileSync(join(dir, `${name}-untracked.txt`), `${name} untracked\n`)
  return dir
}

function makeIo({ repoDir, checkout, paths }, deps = {}) {
  return seatIo({ members: {} }, paths, checkout || repoDir, null, null, {}, deps)
}

function commitRepo(tag, files) {
  const root = scratchDir(`crew-commit-${tag}-`)
  git(root, 'init', '-q')
  // commit() shells out to plain `git`, which inherits no identity from the
  // test helper; configure the repo itself for a lane with an empty HOME.
  git(root, 'config', 'user.email', 'crew@example.invalid')
  git(root, 'config', 'user.name', 'Crew Test')
  for (const name of files) writeFileSync(join(root, name), `${name} initial\n`)
  git(root, 'add', '-A')
  git(root, 'commit', '-m', 'initial')
  const paths = { dir: root, taskDir: root, returnsDir: root }
  return { root, io: seatIo({ members: {} }, paths, root, null, null, {}, {}) }
}

// The seat-side inventory mirrors gate.mjs: event discriminators and payload
// keys are separate projections, and the three forwarding sinks are excluded.
const SEAT_SINK = /(?:io\?\.log\?\.\(|io\.log\(|(?<![.\w])log\?\.\(|logLine\(join\(paths\.dir, 'journal\.jsonl'\), )/g
const SEAT_PASS_THROUGH = new Set([
  'log: (obj) => io.log(obj),',
  "log: (obj) => logLine(join(paths.dir, 'journal.jsonl'), obj),",
  "log(obj) { logLine(join(paths.dir, 'journal.jsonl'), obj) },",
])
// BLIND SPOT: computed deps['logLine'], alternate import aliases, and sinks inside quoted strings are outside this identifier grammar.
// io.log(row(...)) is visible with wrapper null and is rejected by the inventory projection.
// lean: identifier-level journal grammar; use a parser when syntax exceeds this grammar.
function seatRefuseJournalSinks(text) {
  const lines = text.split('\n')
  const byLine = new Map()
  const hidden = []
  for (const { line } of noncanonicalJournalSinks(text)) byLine.set(line, (byLine.get(line) ?? 0) + 1)
  const tokens = tokenizeJs(text)
  const spans = [
    '{ taskDir, log, deps = {} }',
    '{ taskDir, log, emit, deps = {} }',
    'descendantCapture({ taskDir, log, deps })',
  ].flatMap((fragment) => [...text.matchAll(new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))]
    .map((match) => [match.index, match.index + match[0].length]))
  const significant = tokens.filter((token) => token.kind !== 'whitespace' && token.kind !== 'comment')
  const wrappedRow = (from, names) => {
    const nameAt = significant.findIndex((token, index) => index >= from && names.includes(token.text))
    if (nameAt < 0 || significant[nameAt + 1]?.text !== '(') return false
    let depth = 0, close = -1
    for (let at = nameAt + 1; at < significant.length; at++) {
      if (significant[at].kind === 'punctuator' && significant[at].text === '(') depth++
      else if (significant[at].kind === 'punctuator' && significant[at].text === ')' && --depth === 0) { close = at; break }
    }
    return close >= 0 && significant[close + 1]?.kind === 'punctuator' && significant[close + 1]?.text === ')'
  }
  for (let i = 0; i < significant.length; i++) {
    const token = significant[i]
    if (token.kind !== 'name' || !['log', 'logLine', 'defaultLogLine'].includes(token.text)) continue
    const previous = significant[i - 1], next = significant[i + 1]
    if (previous?.text === '.' || previous?.text === '?.' || (token.text === 'log' && next?.text === ':') || spans.some(([start, end]) => token.start >= start && token.start < end)) continue
    const rowLine = text.slice(0, token.start).split('\n').length
    const sourceLine = lines[rowLine - 1].trim()
    if (SEAT_PASS_THROUGH.has(sourceLine)
      || sourceLine === 'closeSurface as defaultCloseSurface, logLine as defaultLogLine, assignmentLine as defaultAssignmentLine,'
      || sourceLine === 'const logLine = deps.logLine || defaultLogLine'
      || (token.text === 'log' && ['log?.(operationalRow(', 'log?.(recordRow('].some((head) => text.startsWith(head, token.start)) && wrappedRow(i + 3, ['operationalRow', 'recordRow']))
      || (token.text === 'logLine' && ["logLine(join(paths.dir, 'journal.jsonl'), operationalRow(", "logLine(join(paths.dir, 'journal.jsonl'), recordRow("].some((head) => text.startsWith(head, token.start)) && wrappedRow(i + 1, ['recordRow', 'operationalRow']))) continue
    hidden.push(rowLine)
  }
  for (const [line, hitCount] of byLine) {
    const sourceLine = lines[line - 1]
    const exemptCount = sourceLine.trim() === 'log: (obj) => io.log(obj),' ? 1 : [...sourceLine.matchAll(/(?<![\w$])log:\s*io\.log(?=\s*(?:,|$))/g)].length
    if (hitCount > exemptCount) hidden.push(...Array(hitCount - exemptCount).fill(line))
  }
  for (let i = 0; i < significant.length; i++) {
    if (significant[i].text === 'io' && significant[i + 1]?.text === '.' && significant[i + 2]?.text === 'log' && significant[i + 3]?.text === '.' && significant[i + 4]?.text === 'call') hidden.push(text.slice(0, significant[i].start).split('\n').length)
  }
  if (hidden.length) throw new Error(`journal sink inventory: ${hidden.length} emit(s) hidden from SEAT_SINK at line(s) ${[...new Set(hidden)].join(', ')}`)
}
function seatPayloadElements(text, from) {
  let i = from
  while (i < text.length && text[i] !== '{') i += 1
  if (text[i] !== '{') return null
  i += 1
  const parts = []
  let buf = ''
  let depth = 0
  while (i < text.length) {
    const c = text[i]
    const two = text.slice(i, i + 2)
    if (two === '//') { while (i < text.length && text[i] !== '\n') i += 1; continue }
    if (two === '/*') { i = text.indexOf('*/', i); if (i < 0) return null; i += 2; continue }
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      let j = i + 1
      while (j < text.length) { if (text[j] === '\\') { j += 2; continue } if (text[j] === q) break; j += 1 }
      buf += text.slice(i, j + 1); i = j + 1; continue
    }
    if (c === '{' || c === '[' || c === '(') { depth += 1; buf += c; i += 1; continue }
    if (c === ']' || c === ')') { depth -= 1; buf += c; i += 1; continue }
    if (c === '}') { if (depth === 0) { parts.push(buf); break } depth -= 1; buf += c; i += 1; continue }
    if (c === ',' && depth === 0) { parts.push(buf); buf = ''; i += 1; continue }
    buf += c; i += 1
  }
  const collapse = (s) => s.trim().replace(/\s+/g, ' ')
  const events = []
  const keys = []
  for (const raw of parts.map(collapse).filter((s) => s.length > 0)) {
    let m = raw.match(/^event\s*:\s*'([^']*)'/); if (m) { events.push(`event='${m[1]}'`); continue }
    if (raw.startsWith('...')) { keys.push(`...${collapse(raw.slice(3))}`); continue }
    m = raw.match(/^([A-Za-z_$][\w$]*)\s*:/); if (m) { keys.push(m[1]); continue }
    m = raw.match(/^([A-Za-z_$][\w$]*)$/); if (m) { keys.push(m[1]); continue }
    m = raw.match(/^'([^']*)'\s*:/); if (m) { keys.push(m[1]); continue }
    keys.push(raw)
  }
  return { events: events.join(' '), keys: keys.join(' ') }
}
function seatJournalSites(rawText) {
  const tokens = tokenizeJs(rawText)
  const text = blankJsComments(rawText)
  seatRefuseJournalSinks(text);
  SEAT_SINK.lastIndex = 0
  const lines = text.split('\n')
  const out = []
  let hit
  while ((hit = SEAT_SINK.exec(text)) !== null) {
    if (!tokens.some((token) => token.start === hit.index && token.kind === 'name')) continue
    const line = text.slice(0, hit.index).split('\n').length
    if (SEAT_PASS_THROUGH.has(lines[line - 1].trim())) continue
    const after = text.slice(hit.index + hit[0].length)
    const payload = seatPayloadElements(text, hit.index + hit[0].length)
    out.push({
      line,
      wrapper: after.startsWith('recordRow(') ? 'recordRow' : after.startsWith('operationalRow(') ? 'operationalRow' : null,
      events: payload?.events ?? null,
      keys: payload?.keys ?? null,
    })
  }
  return out
}
const SEAT_JOURNAL_EXPECTED = Object.freeze([
  ['operationalRow', "event='descendant-capture'", 'at records captures discovery_failures'],
  ['operationalRow', "event='seat-root-settle'", 'at ...record ...result'],
  ['operationalRow', "event='seat-root-settle-sweep'", 'at ...summary'],
  ['operationalRow', "event='descendant-reclaim-sweep'", 'at ...empty'],
  ['operationalRow', "event='descendant-reclaim-sweep'", 'at ...summary'],
  ['operationalRow', "event='descendant-reclaim'", 'at ...row'],
  ['operationalRow', "event='descendant-reclaim-record-failed'", 'at ...row'],
  ['operationalRow', "event='descendant-reclaim-error'", 'at key reason'],
  ['operationalRow', "event='descendant-reclaim-sweep'", 'at ...summary'],
  ['operationalRow', "event='seat-teardown'", 'at ...seat'],
  ['operationalRow', "event='seat-teardown-record-failed'", 'at role outcome reason'],
  ['operationalRow', "event='seat-teardown-sweep'", 'at ...summary'],
  ['operationalRow', '', 'at event role transport growth probed_at_ms latest_ms source'],
  ['operationalRow', '', 'at event role transport growth probed_at_ms latest_ms source'],
  // #931: the root-death reading and the growth reading are taken on the same tick
  // and can disagree; the transcript wins and the disagreement is journaled.
  ['operationalRow', '', 'at event role transport root_pid root_pgid reason grew_at_ms probed_at_ms window_ms'],
  ['recordRow', "event='seat-refusal'", "role id member source message at outcome ...(frame.member === 'overflowed' ? { news: 'first-occurrence' } : {}) ...extra"],
  ['operationalRow', "event='seat-retrying'", 'at role id attempt of retry_in_s condition source'],
  ['operationalRow', "event='seat-retry-cleared'", 'at role id source'],
  ['operationalRow', "event='seat-substrate-down'", 'at role id misses grace_ms'],
  ['operationalRow', "event='seat-substrate-recovered'", 'at role id misses grace_ms'],
  ['operationalRow', "event='seat-stale-cleared'", 'at role id'],
  ['operationalRow', "event='wait-extended'", 'at role id idle_s extension_s'],
  ['operationalRow', "event='seat-stale'", 'at role id last_frame_at stale_ms threshold_ms'],
  ['recordRow', "event='seat-silence-reask'", 'at role id returnPath outcome why silent_ms ...extra'],
  ['recordRow', "event='envelope-reask'", 'at role id returnPath transport outcome ...extra'],
  ['recordRow', '', 'at event role id cause outcome spent_ms ceiling_s from_return_path to_return_path from_run_id to_run_id ...extra'],
  ['recordRow', '', 'at seat_turn_census'],
  ['operationalRow', "event='pane-usage'", 'role id session_id parent subagents subagent_files measured'],
  ['operationalRow', "event='tree-witness'", 'at checkout outcome refused modified removed added head_changed cause detail'],
  ['recordRow', "event='envelope-reask'", 'at role id returnPath transport outcome attempt why'],
  ['recordRow', "event='envelope-reask'", 'at role id returnPath transport outcome attempt why'],
  ['operationalRow', "event='host_suspended'", 'at ...record'],
  ['recordRow', '', ''],
  ['recordRow', '', 'at seat_died returnPath'],
  ['recordRow', '', 'at substrate_gone returnPath'],
  ['operationalRow', '', 'role id at run_id cell'],
  ['operationalRow', "event='teardown-transports'", 'at declared transports init_failed seats'],
  ['recordRow', '', 'at reseat'],
  ['operationalRow', "event='doc-viewer'", 'at path surface_id'],
])

// Mutation TK1: truncating tokens or misclassifying regex/templates must fail corpus reconstruction and generated classifications.
const corpusTokenPairs = []
test('TK1', () => {
  const paths = execFileSync('git', ['ls-files', '-z', '--', 'crew/', 'scripts/'], { cwd: ROOT }).toString().split('\0').filter((p) => p.endsWith('.mjs'))
  for (const path of paths) {
    const source = readFileSync(join(ROOT, path), 'utf8')
    const tokens = tokenizeJs(source)
    corpusTokenPairs.push([source, tokens])
    assert.equal(tokens.map((token) => token.text).join(''), source, path)
    let offset = 0
    for (const token of tokens) { assert.equal(token.start, offset, path); assert.ok(token.end > token.start); assert.ok(['comment', 'string', 'template', 'regex', 'name', 'number', 'punctuator', 'whitespace'].includes(token.kind)); offset = token.end }
    assert.equal(offset, source.length, path)
  }
  assert.deepEqual(tokenizeJs(''), [])
  assert.deepEqual(tokenizeJs('name'), [{ kind: 'name', text: 'name', start: 0, end: 4 }])
  for (const [source, kind, fragment] of [["'x'", 'string', "'x'"], ['/[//]/g', 'regex', '/[//]/g'], ['`a${x}`', 'template', '`a'], ['/*x*/', 'comment', '/*x*/'], ['name', 'name', 'name'], ['42', 'number', '42'], ['?.', 'punctuator', '?.'], [' ', 'whitespace', ' ']]) assert.ok(tokenizeJs(source).some((token) => token.kind === kind && token.text === fragment), source)
  for (const source of ['"unterminated', '/*unfinished', '`unfinished', '`x ${', '`a ${`b ${/x/}`}`']) assert.equal(tokenizeJs(source).map((token) => token.text).join(''), source)
  assert.equal(readFileSync(new URL('./js-tokens.mjs', import.meta.url), 'utf8').includes('import '), false)
  forAll((random) => {
    const productions = [[' ', 'whitespace'], ['//x', 'comment'], ["'x'", 'string'], ['`x`', 'template'], ['/[//]/g', 'regex'], ['name', 'name'], ['42', 'number'], ['?.', 'punctuator'], ['(', 'punctuator'], ['}', 'punctuator']]
    return productions[Math.floor(random() * productions.length)]
  }, ([source, expectedKind]) => {
    const tokens = tokenizeJs(source)
    assert.equal(tokens.map((token) => token.text).join(''), source)
    assert.equal(tokens[0]?.kind, expectedKind, source)
  }, { seed: 0x1729, runs: 200 })
})
// Mutation TK2: classifying every keyword as a statement head admits property-call sinks.
test('TK2', () => {
  for (const source of ['obj.if(log(row))', 'x.while(logLine(p, row))', 'obj?.if(log(row))', 'x /*a*/ . /*b*/ while(logLine(p, row))', 'x.return / log(row)']) assert.throws(() => seatJournalSites(source), /line\(s\) 1/)
  for (const source of ['// fixture\nconst v = obj.if(k1) / log(row)', '// fixture\nx.while(k1) / logLine(p, row)']) assert.throws(() => seatJournalSites(source), /line\(s\) 2/)
  for (const source of ['if (k) /re/.test(s)', 'x?.return /re/.test(s)', 'x /*a*/ . /*b*/ return /re/.test(s)']) assert.doesNotThrow(() => seatJournalSites(source))
})
// Mutation TK3: dropping literal opacity invents drive sinks from slash-containing literals.
test('TK3', () => {
  assert.deepEqual(noncanonicalJournalSinks("const u = 'http://x';"), [])
  assert.deepEqual(noncanonicalJournalSinks('const r = /https?:\\/\\/x/; io.log(row)'), [{ line: 1, form: 'io.log' }])
  assert.deepEqual(noncanonicalJournalSinks('const r = /https?:\\/\\/x/;'), [])
  assert.deepEqual(noncanonicalJournalSinks('`outer ${io.log(row)}`'), [{ line: 1, form: 'io.log' }])
  assert.deepEqual(noncanonicalJournalSinks('`outer ${`inner ${io.log(row)}`}`'), [{ line: 1, form: 'io.log' }])
  assert.deepEqual(noncanonicalJournalSinks('io.log(recordRow({ at: \'x\', sig: `${fn}(${args})` }))'), [])
})
// Mutation TK4: treating regex tokens as source code invents a sink.
test('TK4', () => {
  assert.deepEqual(noncanonicalJournalSinks('const r = /io.log/'), [])
  assert.deepEqual(noncanonicalJournalSinks("const s = 'io.log(row)'; const t = `io.log(row)`;"), [])
  assert.deepEqual(noncanonicalJournalSinks('f(io.log(recordRow({ s: `${a}(${b}` }), extra))'), [{ line: 1, form: 'io.log' }])
  assert.equal(seatJournalSites("const s = \"log?.(operationalRow({ at: 'ghost' }))\" ").length, 0)
  const drive = readFileSync(new URL('./drive-fixtures.mjs', import.meta.url), 'utf8')
  assert.match(drive, /if \(!tokens\.some\(\(token\) => token\.start === hit\.index && token\.kind === 'name'\)\) continue/)
  assert.throws(() => seatJournalSites('const s = "log: io.log, y"; log(row)'), /line\(s\) 1/)
})
// Mutation TK5: restoring either private lexer violates the shared-grammar contract.
test('TK5', () => {
  const drive = readFileSync(new URL('./drive-fixtures.mjs', import.meta.url), 'utf8')
  const seat = readFileSync(new URL('./seat-io-runclean.test.mjs', import.meta.url), 'utf8')
  assert.match(drive, /import \{ tokenizeJs, blankJsComments \} from '\.\/js-tokens\.mjs'/)
  assert.match(seat, /import \{ tokenizeJs, blankJsComments \} from '\.\/js-tokens\.mjs'/)
  assert.equal(drive.includes('function blank' + 'Comments('), false)
  assert.equal(seat.includes('function blank' + 'Comments('), false)
})
// Mutation TK6: suppressing injected disguises must be caught across the tracked corpus.
test('TK6', () => {
  const drive = readFileSync(new URL('./drive-fixtures.mjs', import.meta.url), 'utf8')
  for (const [source, corpusTokens] of corpusTokenPairs) for (const token of corpusTokens.filter((item) => item.kind === 'regex')) {
    const body = token.text.slice(1, token.text.lastIndexOf('/'))
    const flags = token.text.slice(token.text.lastIndexOf('/') + 1)
    assert.doesNotThrow(() => new RegExp(body, flags), token.text)
  }
  assert.deepEqual(noncanonicalJournalSinks("const u = 'http://x'; io.log(row)"), [{ line: 1, form: 'io.log' }])
  const seat = readFileSync(new URL('./seat-io.mjs', import.meta.url), 'utf8')
  const injected = seat.split('\n').map((line) => `log(row); ${line}`).join('\n')
  assert.throws(() => seatJournalSites(injected), /line\(s\)/)
  assert.deepEqual(noncanonicalJournalSinks("io?.['log'](x)"), [{ line: 1, form: 'io?.[' }])
})

// Mutation SL1: replacing the unique refusal push with a log-only guard admits bare log disguises.
test('SL1', () => {
  for (const emit of ['log(operationalRow({ at: 1 }))', 'log && log(operationalRow({ at: 1 }))', 'log?.call(null, operationalRow({ at: 1 }))', 'log ?.(operationalRow({ at: 1 }))', '{ sink: log }', 'const emit = log']) {
    assert.throws(() => seatJournalSites('// fixture\n' + emit), (error) => error.message.includes('line(s) 2'))
  }
  assert.throws(() => seatJournalSites('// fixture\nrecord("it\\"s", log)'), (error) => error.message.includes('line(s) 2'))
  for (const accepted of ['{ taskDir, log, deps = {} }', '{ taskDir, log, emit, deps = {} }', 'descendantCapture({ taskDir, log, deps })', 'log: io.log', "record('log', { level: 'info' })"]) assert.deepEqual(seatJournalSites(accepted), [])
  for (const accepted of ['log?.(operationalRow({ at: 1 }))', 'log?.(recordRow({ at: 1 }))']) assert.doesNotThrow(() => seatJournalSites(accepted))
  assert.throws(() => seatJournalSites('log?.(operationalRow({ at: 1 }), extra)'), /line\(s\) 1/)
  assert.throws(() => seatJournalSites('log?.(operationalRow({ at: 1 })'), /journal sink inventory/)
})
// Mutation SL2: replacing the unique refusal push with a bare-log-only guard admits logLine disguises.
test('SL2', () => {
  for (const emit of ['logLine(join(paths.dir, "journal.jsonl"), operationalRow({ at: 1 }))', "logLine(join(paths.dir,'journal.jsonl'),operationalRow({ at: 1 }))", "logLine(join(paths.dir, 'journal.jsonl'),operationalRow(", 'logLine(journalPath, operationalRow({ at: 1 }))', 'const w = logLine', 'logLine.call(null, p, row)', "defaultLogLine(join(paths.dir, 'journal.jsonl'), operationalRow({ at: 1 }))"]) {
    assert.throws(() => seatJournalSites('// fixture\n' + emit), (error) => error.message.includes('line(s) 2'))
  }
  for (const accepted of ["logLine(join(paths.dir, 'journal.jsonl'), operationalRow({ at: 1 }))", "logLine(join(paths.dir, 'journal.jsonl'), recordRow({ at: 1 }))", `logLine(join(paths.dir, 'journal.jsonl'), operationalRow({\n at: 1\n}))`]) assert.doesNotThrow(() => seatJournalSites(accepted))
  assert.throws(() => seatJournalSites("logLine(join(paths.dir, 'journal.jsonl'), operationalRow({ at: 1 }), extra)"), /line\(s\) 1/)
  assert.throws(() => seatJournalSites("logLine(join(paths.dir, 'journal.jsonl'), operationalRow({ at: 1 })"), /journal sink inventory/)
  for (const accepted of ['log: (obj) => io.log(obj),', "log: (obj) => logLine(join(paths.dir, 'journal.jsonl'), obj),", "log(obj) { logLine(join(paths.dir, 'journal.jsonl'), obj) },", 'closeSurface as defaultCloseSurface, logLine as defaultLogLine, assignmentLine as defaultAssignmentLine,', 'const logLine = deps.logLine || defaultLogLine']) assert.doesNotThrow(() => seatJournalSites(accepted), accepted)
})
// Mutation SL3: replacing the unique refusal push with a false guard leaves all eleven rewrites invisible.
test('SL3', () => {
  const source = readFileSync(new URL('./seat-io.mjs', import.meta.url), 'utf8')
  assert.doesNotThrow(() => seatJournalSites(source))
  const lines = source.split('\n')
  const bare = lines.flatMap((line, i) => /(?<![.\w])log\?\.\(/.test(line) ? [i] : [])
  const journal = lines.flatMap((line, i) => line.includes("logLine(join(paths.dir, 'journal.jsonl'), operationalRow(") ? [i] : [])
  assert.equal(bare.length, 9)
  assert.equal(journal.length, 2)
  for (const index of [...bare, ...journal]) {
    const copy = [...lines]
    copy[index] = bare.includes(index) ? copy[index].replace('log?.(', 'log(') : copy[index].replace("join(paths.dir, 'journal.jsonl')", 'journalPath')
    assert.throws(() => seatJournalSites(copy.join('\n')), (error) => error.message.includes(`line(s) ${index + 1}`))
  }
})
// Mutation SL4: retiring the nearby contract comment removes the stated grammar boundary.
test('SL4', () => {
  const source = readFileSync(new URL('./seat-io-runclean.test.mjs', import.meta.url), 'utf8')
  const needle = 'have no refusal' + ' in this lane'
  assert.equal(source.includes(needle), false)
  const lines = source.split('\n')
  const at = lines.findIndex((line) => line.startsWith('function seatRefuseJournalSinks'))
  assert.equal(lines.slice(Math.max(0, at - 10), at).some((line) => line === '// BLIND SPOT: computed deps[\'logLine\'], alternate import aliases, and sinks inside quoted strings are outside this identifier grammar.'), true)
})
// Mutation SL5: dropping the ${ interpolation push leaves a sink inside a template expression unscanned.
test('SL5', () => {
  for (const emit of ['const s = `${log(operationalRow({ at: 1 }))}`', 'const s = `a ${ { k: logLine(p, row) }.k } b`', 'const s = `${`${log(row)}`}`']) {
    assert.throws(() => seatJournalSites('// fixture\n' + emit), (error) => error.message.includes('line(s) 2'), emit)
  }
  for (const accepted of ['const s = `log(row) ${1 + 2} logLine`', 'const s = `${ { a: 1 }.a } log`']) assert.deepEqual(seatJournalSites(accepted), [], accepted)
})
// Mutation SL6: treating every / as division makes an ordinary regex literal naming log a hidden sink.
test('SL6', () => {
  for (const accepted of ['const r = /log/', 'const r = (/logLine\\(/).test(s)', 'if (/[/]log/.test(s)) x()', 'return /log/.test(s)']) assert.deepEqual(seatJournalSites(accepted), [], accepted)
  for (const emit of ['const half = a / log(row)', 'const r = x /log/ y']) assert.throws(() => seatJournalSites('// fixture\n' + emit), (error) => error.message.includes('line(s) 2'), emit)
})
// Mutation SL7: letting blankComments open a comment at a // inside a regex or string hides the sink after it.
test('SL7', () => {
  for (const emit of ['const s = `${ /[//]/.test(s) && log(row) }`', "const u = 'http://x'; log(row)", 'if (/a\\/\\//.test(s)) log(row)']) {
    assert.throws(() => seatJournalSites('// fixture\n' + emit), (error) => error.message.includes('line(s) 2'), emit)
  }
  for (const accepted of ['const u = "a // log(row)"', '// log(row) in a comment', '/* log(row) */ const x = 1']) assert.deepEqual(seatJournalSites(accepted), [], accepted)
})
// Mutation SL8: copying a template's ${...} without blanking its comments counts a commented-out emit as a live site.
test('SL8', () => {
  const live = 'const s = `${ log?.(operationalRow({ event: \'sl8\' })) }`'
  assert.equal(seatJournalSites(live).length, 1)
  assert.equal(seatJournalSites('const s = `${ (() => { if (true) /[//]/.test(\'/\') && log?.(operationalRow({ event: \'alive\' })) })() }`').length, 1)
  assert.deepEqual(seatJournalSites('if (ok) /log/.test(s)'), [])
  for (const commented of ['const s = `${ /* log?.(operationalRow({ event: \'sl8\' })) */ 1 }`', 'const s = `${ 1 // log?.(operationalRow({ event: \'sl8\' }))\n}`', 'const s = `a ${ `${ /* log?.(operationalRow({ event: \'sl8\' })) */ 2 }` } b`']) {
    assert.deepEqual(seatJournalSites(commented), [], commented)
  }
})

// Mutation SS1: disabling callHits accepts the seventh disguised form.
test('SS1', () => {
  for (const emit of [
    "io['log'](operationalRow({ at: 1 }))", 'io.log.call(io, operationalRow({ at: 1 }))',
    'io[k](operationalRow({ at: 1 }))', "io?.['log'](operationalRow({ at: 1 }))",
    'io.log?.({ at: 1 })', 'io.log(recordRow({ at: 1 }), extra)', 'io.log.call(io, row)',
  ]) {
    assert.throws(() => seatJournalSites(`\n${emit}\n`), (error) => error.message.includes('journal sink inventory') && error.message.includes('hidden from SEAT_SINK') && error.message.includes('line(s) 2'))
  }
})
// Mutation SS2: widening per-occurrence comparison to exempt the whole line admits the mixed fixture.
test('SS2', () => {
  const source = readFileSync(new URL('./seat-io.mjs', import.meta.url), 'utf8')
  assert.equal(source.split('log: (obj) => io.log(obj),').length - 1, 1)
  assert.equal(source.split('log: io.log,').length - 1, 2)
  for (const text of ['const f = io.log', '{ sink: io.log }', '{ log: io.log, sink: io.log }', '{ log: io.log }', 'catalog: io.log,']) {
    assert.throws(() => seatJournalSites(text), /journal sink inventory/)
  }
  for (const text of ['log: (obj) => io.log(obj),', '{ log: io.log, emit: io.emit, }', 'try { settleSeatRoots({ taskDir: paths.taskDir, log: io.log, deps: {} }) } catch {}']) {
    assert.deepEqual(seatJournalSites(text), [])
  }
})
// Mutation SS3: bypassing blankComments counts the canonical call inside the comment.
test('SS3', () => {
  const one = seatJournalSites('io.log(operationalRow({ at: 1 }))\n// io.log(operationalRow({ at: 2 }))')
  assert.equal(one.length, 1)
  assert.deepEqual(one.map(({ line, wrapper, keys }) => [line, wrapper, keys]), [[1, 'operationalRow', 'at']])
  assert.throws(() => seatJournalSites("/* io.log(operationalRow({ at: 2 })) */\nio['log'](operationalRow({ at: 1 }))"), (error) => error.message.includes('line(s) 2'))
  const commented = seatJournalSites('/* io[bad](row) */\nio.log(operationalRow({ at: 1 }))')
  assert.equal(commented.length, 1)
  assert.equal(commented[0].line, 2)
})
// Mutation SS5: removing the scanner refusal accepts the reverted operational emitter.
test('SS5', () => {
  const source = readFileSync(new URL('./seat-io.mjs', import.meta.url), 'utf8')
  const wrapped = "io?.log?.(operationalRow({ at: now(), event: 'host_suspended', ...record }))"
  const old = "io.log?.({ at: now(), event: 'host_suspended', ...record })"
  const reverted = source.replace(wrapped, old)
  const line = reverted.split('\n').findIndex((text) => text.includes('onSuspend:') && text.includes(old)) + 1
  assert.ok(line > 0)
  assert.throws(() => seatJournalSites(reverted), (error) => error.message.includes(`line(s) ${line}`))
})

test('SS4', () => {
  const text = readFileSync(new URL('./seat-io.mjs', import.meta.url), 'utf8')
  for (const sink of SEAT_PASS_THROUGH) assert.equal(text.split(sink).length - 1, 1, `pass-through changed or duplicated: ${sink}`)
  const sites = seatJournalSites(text)
  assert.equal(sites.length, 39)
  assert.deepEqual(sites.map(({ wrapper, events, keys }) => [wrapper, events, keys]), SEAT_JOURNAL_EXPECTED)
  assert.ok(sites.every(({ wrapper }) => wrapper === 'recordRow' || wrapper === 'operationalRow'))
  assert.equal(sites.filter(({ wrapper }) => wrapper === 'operationalRow').length, 28)
  assert.equal(sites.filter(({ wrapper }) => wrapper === 'recordRow').length, 11)
})

test('run shell spawns use the named output buffer while git plumbing stays unbounded', () => {
  const source = readFileSync(join(ROOT, 'crew/seat-io.mjs'), 'utf8')
  const gitSpawns = source.split('\n').filter((line) => line.includes("spawnSync('git'"))
  const shellSpawns = source.split('\n').filter((line) => line.includes("spawnSync('/bin/sh'"))
  assert.equal(gitSpawns.filter((line) => line.includes('maxBuffer')).length, 0)
  assert.equal(shellSpawns.length, 2)
  assert.equal(shellSpawns.filter((line) => line.includes('maxBuffer: RUN_MAX_BUFFER_BYTES')).length, 2)
})

test('the teardown family stamps the operational channel at the sink', () => {
  const root = scratchDir('journal-channel-capture-')
  const taskDir = join(root, 'task')
  const transportDir = join(taskDir, DESCENDANT_STORE_DIRS['headless-json'])
  mkdirSync(transportDir, { recursive: true })
  writeFileSync(join(transportDir, '.builder.active.json'), JSON.stringify({
    reservation_id: 'reservation-channel', key: 'builder', phase: 'running', role: 'builder', id: 'd-channel',
    dir: join('headless', 'd-channel'), pid: process.pid, owner: { pid: process.pid, startedAt: Date.now() },
  }))
  const snapshot = () => ({ ok: true, rows: new Map([[process.pid, { pid: process.pid, ppid: 1, pgid: process.pid, start: 'root' }]]) })
  const captured = []
  try {
    const result = descendantCapture({ taskDir, log: (row) => captured.push(row), deps: { snapshot } }).round()
    const row = captured.find((entry) => entry.event === 'descendant-capture')
    assert.equal(row.channel, 'operational')
    assert.equal(row.event, 'descendant-capture')
    assert.equal(row.records, result.records)
    assert.equal(row.captures, result.captures)
    assert.equal(row.discovery_failures, result.discovery_failures)
  } finally { rmSync(root, { recursive: true, force: true }) }

  const logged = []
  settleSeatTeardown({
    teardown: () => [{ role: 'builder', outcome: 'proven', reason: 'probe-dead' }],
    log: (row) => logged.push(row), emit: () => true,
  })
  for (const row of logged) {
    assert.ok(JOURNAL_CHANNEL_NAMES.includes(row.channel), `${JSON.stringify(row)} carries no channel`)
  }
})

test('descendant capture distinguishes valid, malformed and absent markers', () => {
  const snapshot = () => ({ ok: true, rows: new Map([[process.pid, { pid: process.pid, ppid: 1, pgid: process.pid, start: 'root' }]]) })
  const round = (content) => {
    const root = scratchDir('descendant-marker-')
    const taskDir = join(root, 'task')
    const transportDir = join(taskDir, DESCENDANT_STORE_DIRS['headless-json'])
    mkdirSync(transportDir, { recursive: true })
    if (content !== null) {
      writeFileSync(join(transportDir, '.builder.active.json'), content)
    }
    return descendantCapture({ taskDir, log: () => {}, deps: { snapshot } }).round()
  }
  const valid = round(JSON.stringify({
    reservation_id: 'reservation-1', key: 'builder', phase: 'running', role: 'builder', id: 'd1',
    dir: join('headless', 'd1'), pid: process.pid, owner: { pid: process.pid, startedAt: Date.now() },
  }))
  assert.equal(valid.records, 1)
  assert.equal(valid.captures, 1)
  assert.equal(valid.discovery_failures, 0)
  const malformed = round('{not json')
  assert.equal(malformed.discovery_failures, 1)
  const absent = round(null)
  assert.equal(absent.discovery_failures, 0)
  assert.equal(absent.records, 0)
  assert.equal(absent.captures, 0)
})

test('paneUsageFrames folds claude spend once, then emits deltas and zeroes without repeating totals', () => {
  withRepo({ dirty: false }, (fixture) => {
    const session = '11111111-1111-4111-8111-111111111111'
    const transcriptPath = join(fixture.paths.taskDir, `${session}.jsonl`)
    const usageDir = join(fixture.paths.taskDir, 'usage')
    mkdirSync(usageDir, { recursive: true })
    const line = (id, input, output, cacheWrite, cacheRead) => JSON.stringify({
      type: 'assistant', message: { id, usage: {
        input_tokens: input, output_tokens: output,
        cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead,
      } },
    })
    writeFileSync(transcriptPath, `${line('a1', 1, 100, 10, 1000)}\n`)
    writeFileSync(join(usageDir, 'planner.jsonl'), `${JSON.stringify({ session_id: session, transcript_path: transcriptPath })}\n`)

    const first = paneUsageFrames({ taskDir: fixture.paths.taskDir, role: 'planner', id: 'd1', model: 'claude-opus-5', sent: {} })
    assert.equal(first.frames.length, 1)
    assert.equal(first.frames[0].usage.billed_output_tokens, 100)
    writeFileSync(transcriptPath, `${line('a1', 1, 100, 10, 1000)}\n${line('a2', 2, 25, 5, 500)}\n`)
    const second = paneUsageFrames({ taskDir: fixture.paths.taskDir, role: 'planner', id: 'd2', model: 'claude-opus-5', sent: first.sent })
    assert.equal(second.frames.length, 1)
    assert.deepEqual(second.frames[0].usage, {
      billed_input_tokens: 2, billed_output_tokens: 25,
      billed_cache_write_tokens: 5, billed_cache_read_tokens: 500,
    })
    const third = paneUsageFrames({ taskDir: fixture.paths.taskDir, role: 'planner', id: 'd3', model: 'claude-opus-5', sent: second.sent })
    assert.deepEqual(third.frames[0].usage, {
      billed_input_tokens: 0, billed_output_tokens: 0,
      billed_cache_write_tokens: 0, billed_cache_read_tokens: 0,
    })

    const unmeasured = '22222222-2222-4222-8222-222222222222'
    const unmeasuredPath = join(fixture.paths.taskDir, `${unmeasured}.jsonl`)
    writeFileSync(unmeasuredPath, `${JSON.stringify({ type: 'assistant', message: { id: 'u1', usage: { output_tokens_v2: 99 } } })}\n`)
    writeFileSync(join(usageDir, 'reviewer.jsonl'), `${JSON.stringify({ session_id: unmeasured, transcript_path: unmeasuredPath })}\n`)
    const absent = paneUsageFrames({ taskDir: fixture.paths.taskDir, role: 'reviewer', id: 'd4', model: 'claude-opus-5', sent: {} })
    assert.equal(absent.frames.length, 1)
    assert.equal(absent.frames[0].usage, null)
    assert.equal(Object.hasOwn(absent.sent, unmeasured), false)

    const pi = paneUsageFrames({ taskDir: fixture.paths.taskDir, role: 'planner', agent: 'pi', sent: {} })
    assert.deepEqual(pi.frames, [])
  })
})

test('a pane wait emits usage and persists sent totals across a second seatIo instance, with exactly one census row', () => {
  withRepo({ dirty: false }, (fixture) => {
    const session = '33333333-3333-4333-8333-333333333333'
    const transcriptPath = join(fixture.paths.taskDir, `${session}.jsonl`)
    mkdirSync(join(fixture.paths.taskDir, 'usage'), { recursive: true })
    writeFileSync(transcriptPath, JSON.stringify({ type: 'assistant', message: { id: 'w1', usage: {
      input_tokens: 1, output_tokens: 77, cache_creation_input_tokens: 3, cache_read_input_tokens: 9,
    } } }))
    writeFileSync(join(fixture.paths.taskDir, 'usage', 'planner.jsonl'), JSON.stringify({ session_id: session, transcript_path: transcriptPath }))
    const make = () => {
      const events = []
      const journal = []
      const crew = { members: { planner: { surface_id: 'surface-planner', transport: 'pane', agent: 'claude', model: 'claude-opus-5' } } }
      const io = seatIo(crew, fixture.paths, fixture.repoDir, null, null, {}, {
        now: () => 0, sleep: () => {}, tree: () => ({ windows: [] }), locate: () => false,
        sendLine: () => {}, assignmentLine: () => 'assignment', logLine: (_path, row) => journal.push(row), cmux: () => ({ ok: false }),
      })
      io.emit = (event) => events.push(event)
      const assignment = io.assign({ role: 'planner', briefFile: join(fixture.paths.taskDir, 'brief.md') })
      assert.doesNotThrow(() => io.wait(assignment.returnPath, 0))
      return { events, journal, assignment }
    }
    const first = make()
    const usage1 = first.events.filter((event) => event.kind === 'usage')
    assert.equal(usage1.length, 1)
    assert.equal(usage1[0].usage.billed_output_tokens, 77)
    assert.equal(readFileSync(join(fixture.paths.taskDir, 'usage', 'planner.sent.json')).includes(session), true)
    const second = make()
    const usage2 = second.events.filter((event) => event.kind === 'usage')
    assert.equal(usage2.length, 1)
    assert.equal(usage2[0].usage.billed_output_tokens, 0)
    assert.equal(first.journal.filter((row) => row.event === 'pane-usage').length, 1)
    const censusRows = first.journal.filter((row) => row.seat_turn_census)
    assert.equal(censusRows.length, 1)
    assert.equal(Object.hasOwn(censusRows[0], 'headless_outcome'), false)
    assert.deepEqual([censusRows[0].seat_turn_census.dispatch_id, censusRows[0].seat_turn_census.transport], [first.assignment.id, 'pane'])
  })
})

function restored(fixture) {
  const { repoDir } = fixture
  assert.equal(readFileSync(join(repoDir, 'tracked.txt'), 'utf8'), CONTENT.dirty)
  assert.equal(readFileSync(join(repoDir, 'untracked.txt'), 'utf8'), CONTENT.untracked)
  assert.equal(readFileSync(join(repoDir, 'ignored', 'secret.txt'), 'utf8'), CONTENT.ignored)
  assert.equal(readFileSync(join(repoDir, 'node_modules', 'pkg', 'index.js'), 'utf8'), CONTENT.node)
  assert.equal(git(repoDir, 'stash', 'list').trim(), '')
}

function withRepo(options, fn) {
  const fixture = makeRepo(options)
  try {
    return fn(fixture)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
}

function interleavedRun() {
  return withRepo({}, (fixture) => {
    const laneB = addLane(fixture, 'laneB', 'LANE-B dirty tracked\n')
    const io = makeIo(fixture)
    const run = io.run.bind(io)
    io.run = (cmd) => {
      git(laneB, 'stash', 'push', '--include-untracked', '-q', '-m', 'sibling-lane-work')
      return run(cmd)
    }
    io.runClean('printf clean')
    return {
      tracked: readFileSync(join(fixture.repoDir, 'tracked.txt'), 'utf8'),
      untracked: existsSync(join(fixture.repoDir, 'untracked.txt'))
        ? readFileSync(join(fixture.repoDir, 'untracked.txt'), 'utf8') : null,
      foreignFile: existsSync(join(fixture.repoDir, 'laneB-untracked.txt')),
      subjects: git(fixture.repoDir, 'stash', 'list', '--format=%gs').split('\n').map((line) => line.trim()).filter(Boolean),
      laneBTracked: readFileSync(join(laneB, 'tracked.txt'), 'utf8'),
    }
  })
}

const treeCommand = [
  'git status --porcelain -uall',
  "printf 'TRACKED\\n'; cat tracked.txt",
  "printf 'UNTRACKED\\n'; if [ -e untracked.txt ]; then cat untracked.txt; else printf '<absent>\\n'; fi",
  "printf 'IGNORED\\n'; cat ignored/secret.txt",
  "printf 'NODE_MODULE\\n'; cat node_modules/pkg/index.js",
].join('; ')

test('runClean shows committed tracked work while ignored paths stay visible', () => {
  withRepo({}, (fixture) => {
    const io = makeIo(fixture)
    const result = io.runClean(treeCommand)
    assert.equal(result.ok, true)
    assert.match(result.output, /TRACKED\ncommitted tracked content\n/)
    assert.match(result.output, /UNTRACKED\n<absent>/)
    assert.match(result.output, /IGNORED\nignored secret content\n/)
    assert.match(result.output, /NODE_MODULE\nnode package content\n/)
    assert.doesNotMatch(result.output, /untracked content/)
  })
})

test('runClean restores tracked, untracked, ignored, and node_modules work with no stash left', () => {
  withRepo({}, (fixture) => {
    makeIo(fixture).runClean('printf clean')
    restored(fixture)
    assert.equal(existsSync(join(fixture.repoDir, 'untracked.txt')), true)
  })
})

test('runClean on a clean tree runs without creating a stash entry', () => {
  withRepo({ dirty: false }, (fixture) => {
    const io = makeIo(fixture)
    const result = io.runClean('printf clean-tree')
    assert.deepEqual(result, { ok: true, output: 'clean-tree', status: 0, stderr: '' })
    assert.equal(git(fixture.repoDir, 'stash', 'list').trim(), '')
  })
})

test('runClean refuses a tracked file modified during the window and names it', () => {
  withRepo({}, (fixture) => {
    let error
    assert.throws(() => makeIo(fixture).runClean("printf 'target v2\\n' > witness-target.txt; printf ok"), (err) => { error = err; return true })
    assert.equal(error.reason, 'tree-witness')
    assert.match(error.message, /tree-witness/)
    assert.match(error.message, /witness-target\.txt/)
  })
})

test('runClean refuses a tracked file removed during the window and names it', () => {
  withRepo({}, (fixture) => {
    let error
    assert.throws(() => makeIo(fixture).runClean('rm witness-victim.txt; printf ok'), (err) => { error = err; return true })
    assert.equal(error.reason, 'tree-witness')
    assert.match(error.message, /tree-witness/)
    assert.match(error.message, /witness-victim\.txt/)
  })
})

test('runClean reports an added path without refusing the window', () => {
  withRepo({}, (fixture) => {
    const journal = []
    const result = makeIo(fixture, { logLine: (_path, row) => journal.push(row) })
      .runClean("printf 'new\\n' > witness-added.txt; printf ok")
    assert.deepEqual(result, { ok: true, output: 'ok', status: 0, stderr: '' })
    const row = journal.find((entry) => entry.event === 'tree-witness')
    assert.ok(row)
    assert.equal(row.outcome, 'changed')
    assert.equal(row.refused, false)
    assert.deepEqual(row.added, ['witness-added.txt'])
  })
})

test('runClean refuses an unmeasurable witness on either side without reporting unchanged', () => {
  for (const [side, unmeasurableCall] of [['open', 1], ['close', 2]]) {
    withRepo({}, (fixture) => {
      let calls = 0
      const cause = `injected-${side}-unmeasurable`
      const journal = []
      const deps = {
        fingerprintTree: (checkout) => {
          calls += 1
          if (calls === unmeasurableCall) return { measured: false, checkout, at: 'injected', cause, detail: 'test injection' }
          return { measured: true, checkout, at: 'injected', head: 'HEADSHA', entries: {} }
        },
        logLine: (_path, row) => journal.push(row),
      }
      let error
      assert.throws(() => makeIo(fixture, deps).runClean('printf clean'), (err) => { error = err; return true })
      assert.match(error.message, new RegExp(cause))
      assert.equal(journal.length, 1)
      assert.notEqual(journal[0].outcome, 'unchanged')
    })
  }
})

test('runClean restores stashed work before refusing a witness violation', () => {
  withRepo({}, (fixture) => {
    let error
    assert.throws(() => makeIo(fixture).runClean("printf 'target v2\\n' > witness-target.txt; printf ok"), (err) => { error = err; return true })
    assert.equal(error.reason, 'tree-witness')
    restored(fixture)
    assert.equal(git(fixture.repoDir, 'stash', 'list').trim(), '')
  })
})

test('runClean carries the witness through the clean-tree arm', () => {
  withRepo({ dirty: false }, (fixture) => {
    const journal = []
    let error
    assert.throws(() => makeIo(fixture, { logLine: (_path, row) => journal.push(row) })
      .runClean("printf 'target v2\\n' > witness-target.txt; printf ok"), (err) => { error = err; return true })
    assert.equal(error.reason, 'tree-witness')
    assert.equal(readFileSync(join(fixture.repoDir, 'witness-target.txt'), 'utf8'), 'target v2\n')
    assert.equal(git(fixture.repoDir, 'stash', 'list').trim(), '')
    assert.equal(journal.find((entry) => entry.event === 'tree-witness')?.refused, true)
  })
})

test('runClean keeps a quiet window unchanged and unjournalled', () => {
  withRepo({}, (fixture) => {
    const journal = []
    const result = makeIo(fixture, { logLine: (_path, row) => journal.push(row) }).runClean('printf clean')
    assert.deepEqual(result, { ok: true, output: 'clean', status: 0, stderr: '' })
    restored(fixture)
    assert.equal(journal.some((entry) => entry.event === 'tree-witness'), false)
  })
})

test('runClean restores the tree when the command throws', () => {
  withRepo({}, (fixture) => {
    const io = makeIo(fixture)
    io.run = () => { throw new Error('command failed') }
    assert.throws(() => io.runClean('boom'), /command failed/)
    restored(fixture)
  })
})

test('runClean preserves a non-zero command result and still restores the tree', () => {
  withRepo({}, (fixture) => {
    const result = makeIo(fixture).runClean("printf 'command output'; exit 7")
    assert.equal(result.ok, false)
    assert.equal(result.output, 'command output')
    restored(fixture)
  })
})

test('runClean restores its own entry when a sibling lane stashes in between', () => {
  const result = interleavedRun()
  assert.equal(result.tracked, CONTENT.dirty)
  assert.equal(result.untracked, CONTENT.untracked)
  assert.equal(result.foreignFile, false)
})

test("runClean leaves the sibling lane's entry for its owner", () => {
  const result = interleavedRun()
  assert.equal(result.subjects.length, 1)
  assert.match(result.subjects[0], /sibling-lane-work/)
  assert.equal(result.laneBTracked, CONTENT.committed)
})

test('runClean refuses loudly when its own entry is gone', () => {
  withRepo({}, (fixture) => {
    const io = makeIo(fixture)
    const run = io.run.bind(io)
    const decoy = 'decoy tracked content\n'
    io.run = (cmd) => {
      const own = git(fixture.repoDir, 'stash', 'list', '--format=%H %gs').split('\n')
        .filter((line) => line.includes('crew:runClean'))
      assert.equal(own.length, 1)
      git(fixture.repoDir, 'stash', 'drop', 'stash@{0}')
      writeFileSync(join(fixture.repoDir, 'tracked.txt'), decoy)
      git(fixture.repoDir, 'stash', 'push', '-q', '-m', 'decoy-entry')
      return run(cmd)
    }
    let error = null
    try { io.runClean('printf clean') } catch (err) { error = err }
    assert.ok(error)
    assert.match(error.message, /refus/i)
    assert.notEqual(readFileSync(join(fixture.repoDir, 'tracked.txt'), 'utf8'), decoy)
    assert.ok(git(fixture.repoDir, 'stash', 'list', '--format=%gs').includes('decoy-entry'))
  })
})

test('runCold runs the command outside the lane checkout and returns its path', () => {
  withRepo({ dirty: false }, (fixture) => {
    const result = makeIo(fixture).runCold('pwd')
    const cwd = String(result.output || '').trim().split('\n').pop() || ''
    assert.equal(result.ok, true)
    assert.ok(cwd)
    assert.notEqual(cwd, fixture.checkout)
    assert.equal(result.kept, null)
  })
})

test('runCold gives the child a cold-local ledger directory over an inherited sentinel', () => {
  withRepo({ dirty: false }, (fixture) => {
    const sentinel = join(fixture.root, 'operator-ledger')
    const command = `${JSON.stringify(process.execPath)} -e "process.stdout.write(process.env.DEVTEAM_LEDGER_DIR || '')"`
    const result = makeIo(fixture, { env: { ...process.env, DEVTEAM_LEDGER_DIR: sentinel } }).runCold(command)
    const expected = join(result.path, '.dev-team', 'factory')
    assert.equal(result.ok, true)
    assert.equal(String(result.output || '').trim(), expected)
    assert.notEqual(String(result.output || '').trim(), sentinel)
  })
})

test('runCold cuts the checkout at the current HEAD', () => {
  withRepo({ dirty: false }, (fixture) => {
    writeFileSync(join(fixture.checkout, 'cold-marker.txt'), 'marker-ok\n')
    git(fixture.checkout, 'add', '-A')
    git(fixture.checkout, 'commit', '-q', '-m', 'the build')
    const result = makeIo(fixture).runCold('cat cold-marker.txt')
    assert.equal(result.ok, true)
    assert.match(result.output, /marker-ok/)
  })
})

test('runCold removes a green checkout and keeps a red checkout for inspection', () => {
  withRepo({ dirty: false }, (fixture) => {
    const green = makeIo(fixture).runCold('true')
    assert.equal(green.ok, true)
    assert.equal(existsSync(green.path), false)

    const red = makeIo(fixture).runCold("printf 'cold output'; exit 3")
    try {
      assert.equal(red.ok, false)
      assert.equal(red.kept, red.path)
      assert.equal(existsSync(red.kept), true)
      assert.match(red.output, /cold output/)
    } finally {
      if (red.kept) git(fixture.checkout, 'worktree', 'remove', '--force', red.kept)
    }
  })
})

test('removeCold removes a failed checkout and its Git registration', () => {
  withRepo({ dirty: false }, (fixture) => {
    const io = makeIo(fixture)
    const red = io.runCold("printf 'diagnostic'; exit 3")
    try {
      assert.equal(red.ok, false)
      assert.equal(existsSync(red.kept), true)
      io.removeCold(red.kept)
      assert.equal(existsSync(red.kept), false)
      assert.equal(git(fixture.checkout, 'worktree', 'list', '--porcelain').includes(red.kept), false)
    } finally {
      if (red.kept && existsSync(red.kept)) git(fixture.checkout, 'worktree', 'remove', '--force', red.kept)
    }
  })
})

test('removeCold failures retain the registered path and available diagnostics', () => {
  withRepo({ dirty: false }, (fixture) => {
    for (const result of [
      { status: 1, stderr: 'denied' },
      { status: null, error: Object.assign(new Error('permission denied'), { code: 'EPERM' }) },
      { status: null, signal: 'SIGTERM' },
      { status: 1, stdout: '', stderr: '' },
    ]) {
      const seen = []
      const io = makeIo(fixture, { spawnSync: (_bin, argv) => { seen.push(argv); return result } })
      const path = '/tmp/space ; $path'
      assert.throws(() => io.removeCold(path), (error) => (
        error.message.includes(path)
        && (!result.stderr || error.message.includes(result.stderr))
        && (!result.error || error.message.includes(result.error.message))
        && (!result.signal || error.message.includes(result.signal))
      ))
      assert.deepEqual(seen[0].slice(-2), ['--force', path])
    }
  })
})

// MUTATION RV1-1: reverse settleRetriedCold's no-kept guard and this test calls removeCold with no path.
test('retried cold cleanup stays best-effort across main and resumed verification', () => {
  const retried = { path: '/direct/first', kept: '/direct/kept', output: 'evidence' }
  const unchanged = { path: '/direct/none', kept: null, output: 'evidence' }
  assert.strictEqual(settleRetriedCold({ removeCold() { throw new Error('must not run') } }, unchanged), unchanged)
  assert.deepEqual(settleRetriedCold({}, retried), { ...retried, removed: false, remove_why: 'this io provides no removeCold' })
  const directCalls = []
  assert.deepEqual(
    settleRetriedCold({ removeCold(path) { directCalls.push(path) } }, retried),
    { path: '/direct/first', kept: null, removed: true, output: 'evidence' },
  )
  assert.deepEqual(directCalls, ['/direct/kept'])
  assert.deepEqual(
    settleRetriedCold({ removeCold() { throw new Error('cleanup unavailable') } }, retried),
    { ...retried, removed: false, remove_why: 'cleanup unavailable' },
  )
  assert.deepEqual(
    settleRetriedCold({ removeCold() { throw 'interrupted cleanup' } }, retried),
    { ...retried, removed: false, remove_why: 'interrupted cleanup' },
  )

  const runMain = (outcomes, remover = undefined) => {
    const io = closeoutIo()
    const removed = []
    const original = io.runCold
    let attempt = 0
    io.runCold = (cmd, names) => {
      original(cmd, names)
      const outcome = outcomes[attempt++]
      if (outcome instanceof Error) throw outcome
      return outcome
    }
    if (remover === null) delete io.removeCold
    else io.removeCold = (path) => {
      removed.push(path)
      if (typeof remover === 'function') return remover(path)
    }
    return { result: driveTask(CTX, io), removed }
  }

  const checkpointFile = { path: 'a.mjs', state: 'present', bytes: `file:-:${'a'.repeat(64)}` }
  const checkpoint = {
    version: RESUME_CHECKPOINT_VERSION, kind: 'suite', frozen_where: 'cold-suite', head_oid: 'abc1234',
    tree: { index_oid: 'tree1234', files: [checkpointFile], worktree_sha256: resumeWorktreeSha256([checkpointFile]) },
    accepted_scope: ['a.mjs'],
    returns: {
      planner: { status: 'done', role: 'planner', artifacts: [], details: {} },
      builder: { status: 'done', role: 'builder', artifacts: [], details: {} },
      reviewer: { status: 'done', role: 'reviewer', artifacts: [], details: {} },
    },
    decision: { accepted_via: 'review pass', verdict: 'pass', residuals: [], carried_findings: [], accept_findings: [], accept_decision: { where: 'review', outcome: 'accepted', residuals: [] }, panel_contributors: ['reviewer'] },
    commit: { oid: 'abc1234', pending: false, files: ['a.mjs'], message: 'feat: resume', subject: 'feat: resume' },
    proof: { gate_cmd: 'gate-cmd', gate_path: '/tmp/fake-task/gate.mjs', summary: { total: 1, failed: 0, errored: 0 }, discrimination: 'proven', generation: 1, repairs: 0 },
    suite: { cmd: 'custom-suite', warm: null, cold: null }, publish: { branch: null, base: null }, prior_stages: ['review:r1', 'commit'], chunk: null,
  }
  const runResume = (outcomes, remover = undefined) => {
    const io = fakeIo({
      runs: {
        'gate-cmd': { ok: true, output: `${GATE_SUMMARY_PREFIX} {"total":1,"failed":0,"errored":0}` },
        'custom-suite': { ok: true, output: '# pass 1\\n# fail 0\\n' },
      },
    })
    const removed = []
    let attempt = 0
    io.runCold = (cmd, names) => {
      io.calls.runCold.push({ cmd, names })
      const outcome = outcomes[attempt++]
      if (outcome instanceof Error) throw outcome
      return outcome
    }
    if (remover === null) delete io.removeCold
    else io.removeCold = (path) => {
      removed.push(path)
      if (typeof remover === 'function') return remover(path)
    }
    return {
      result: resumeTask({ ...CTX, task: 'resume-cold-retry', suite: 'ignored', files_in_scope: ['a.mjs'] }, io, checkpoint),
      removed,
    }
  }

  for (const [label, run, prefix] of [['main', runMain, '/main'], ['resume', runResume, '/resume']]) {
    const success = run([
      { ok: false, path: `${prefix}/first`, kept: `${prefix}/kept`, output: 'x'.repeat(2005) },
      { ok: true, path: `${prefix}/second`, kept: null, output: '' },
    ])
    assert.equal(success.result.status, 'done', label)
    assert.deepEqual(success.removed, [`${prefix}/kept`], label)
    assert.deepEqual(success.result.details.cold_suite.retried, { path: `${prefix}/first`, kept: null, removed: true, output: 'x'.repeat(2000) }, label)

    const missing = run([
      { ok: false, path: `${prefix}/missing`, kept: `${prefix}/missing-kept`, output: 'red' },
      { ok: true, path: `${prefix}/second`, kept: null, output: '' },
    ], null)
    assert.equal(missing.result.status, 'done', label)
    assert.deepEqual(missing.removed, [], label)
    assert.deepEqual(missing.result.details.cold_suite.retried, {
      path: `${prefix}/missing`, kept: `${prefix}/missing-kept`, output: 'red',
      removed: false, remove_why: 'this io provides no removeCold',
    }, label)

    const throwing = run([
      { ok: false, path: `${prefix}/throw`, kept: `${prefix}/throw-kept`, output: 'red' },
      { ok: true, path: `${prefix}/second`, kept: null, output: '' },
    ], () => { throw new Error('cleanup unavailable') })
    assert.equal(throwing.result.status, 'done', label)
    assert.deepEqual(throwing.removed, [`${prefix}/throw-kept`], label)
    assert.equal(throwing.result.details.cold_suite.retried.remove_why, 'cleanup unavailable', label)
    assert.equal(throwing.result.details.cold_suite.retried.kept, `${prefix}/throw-kept`, label)

    const redRed = run([
      { ok: false, path: `${prefix}/red-1`, kept: `${prefix}/red-kept-1`, output: 'red' },
      { ok: false, path: `${prefix}/red-2`, kept: `${prefix}/red-kept-2`, output: 'red' },
    ])
    assert.equal(redRed.result.status, 'escalation', label)
    assert.deepEqual(redRed.removed, [], label)

    const retryThrow = run([
      { ok: false, path: `${prefix}/retry-throw`, kept: `${prefix}/retry-throw-kept`, output: 'red' },
      new Error('retry interrupted'),
    ])
    assert.equal(retryThrow.result.details.cold_suite.verdict, 'unproven', label)
    assert.deepEqual(retryThrow.removed, [], label)

    const firstGreen = run([{ ok: true, path: `${prefix}/green`, kept: null, output: '' }])
    assert.equal(firstGreen.result.status, 'done', label)
    assert.deepEqual(firstGreen.removed, [], label)
  }
})

test('runCold throws when git worktree add fails', () => {
  withRepo({ dirty: false }, (fixture) => {
    const deps = {
      spawnSync: (bin, argv, opts) => (Array.isArray(argv) && argv.includes('worktree') && argv.includes('add')
        ? { status: 1, stdout: '', stderr: 'injected add failure\n' }
        : realSpawnSync(bin, argv, opts)),
    }
    assert.throws(() => makeIo(fixture, deps).runCold('true'), /worktree add failed/)
  })
})

test('runCold throws when green cleanup fails and names the registered path', () => {
  withRepo({ dirty: false }, (fixture) => {
    let path = null
    const deps = {
      spawnSync: (bin, argv, opts) => {
        if (Array.isArray(argv) && argv.includes('remove')) {
          path = argv.at(-1)
          return { status: 1, stdout: '', stderr: 'injected remove failure\n' }
        }
        return realSpawnSync(bin, argv, opts)
      },
    }
    try {
      assert.throws(() => makeIo(fixture, deps).runCold('true'), (error) => /still registered/.test(error.message) && error.message.includes(path))
    } finally {
      if (path) git(fixture.checkout, 'worktree', 'remove', '--force', path)
    }
  })
})

test('runCold throws when the suite cannot be spawned', () => {
  withRepo({ dirty: false }, (fixture) => {
    let path = null
    const deps = {
      spawnSync: (bin, argv, opts) => {
        if (String(bin) === '/bin/sh') {
          path = opts.cwd
          return { status: null, stdout: '', stderr: '', error: new Error('injected spawn failure') }
        }
        return realSpawnSync(bin, argv, opts)
      },
    }
    try {
      assert.throws(() => makeIo(fixture, deps).runCold('true'), /could not be spawned/)
    } finally {
      if (path) git(fixture.checkout, 'worktree', 'remove', '--force', path)
    }
  })
})

test('runCold refuses to cut an unguarded checkout when repository lookup fails', () => {
  withRepo({ dirty: false }, (fixture) => {
    const deps = { execSync: () => { throw new Error('injected rev-parse failure') } }
    assert.throws(() => makeIo(fixture, deps).runCold('true'), /repository-name guard/)
  })
})

test('runCold redraws paths carrying lane, repository, and checkout names', () => {
  withRepo({ dirty: false, linked: true }, (fixture) => {
    const root = scratchDir('zqneutral-')
    const draw = (first, names) => {
      const result = makeIo(fixture, { cold: { tmpRoot: root, rand: (i) => i === 0 ? first : 'f9f9f9', attempts: 8 } }).runCold('true', names)
      assert.equal(basename(result.path), 'f9f9f9')
    }
    draw('zqlane5x', ['zqlane5'])
    draw('repo9x', [])
    draw('linkedLanex', [])
  })
})

test('coldPathCollision reports shared case-insensitive windows only', () => {
  const hit = coldPathCollision('/zz/coldcheck-9budget9', ['b281-spawnBUDGET'])
  assert.equal(typeof hit, 'string')
  assert.equal(hit.length, COLD_PATH_MIN_SHARED)
  assert.ok('/zz/coldcheck-9budget9'.toLowerCase().includes(hit.toLowerCase()))
  assert.ok('b281-spawnBUDGET'.toLowerCase().includes(hit.toLowerCase()))
  assert.equal(coldPathCollision('/zz/9f9f9f', ['b281-spawnbudget']), '')
})

test('neutralColdPath accepts a temp root sharing only a window with a guarded name', () => {
  const names = ['b317-drivergone', 'dt-b317-drivergone', 'dev-team-claude-plugin']
  const path = neutralColdPath(names, { tmpRoots: ['/private/tmp'], realpath: (p) => p, rand: () => 'a1b2c3', attempts: 4 })
  assert.equal(path, '/private/tmp/a1b2c3')
  assert.equal(coldRootCollision('/private/tmp', names), '')
  assert.equal(coldPathCollision('/private/tmp', names), 'riv')
})

test('coldRootCollision reports only a WHOLE guarded name and ignores short names', () => {
  assert.equal(coldRootCollision('/zz/dt-b317-drivergone/T', ['b317-drivergone']), 'b317-drivergone')
  assert.equal(coldRootCollision('/zz/DT-B317-DriverGone/T', ['b317-drivergone']), 'b317-drivergone')
  assert.equal(coldRootCollision('/private/var/folders/zz/T', ['b304-coldverify']), '')
  assert.equal(coldRootCollision('/private/tmp', ['tm']), '')
})

test('neutralColdPath redraws a collision and throws on exhausted roots', () => {
  const path = neutralColdPath(['b304-coldverify'], {
    tmpRoots: ['/zz'], rand: (i) => ['b304ab', 'f9f9f9'][i], attempts: 4, realpath: (p) => p,
  })
  assert.equal(basename(path), 'f9f9f9')
  assert.throws(() => neutralColdPath(['spawnbudget'], {
    tmpRoots: ['/zz'], rand: () => 'budgetx', attempts: 3, realpath: (p) => p,
  }), /TMPDIR/)
})

test('coldGuardNames derives repository and drops short or dot names', () => {
  assert.deepEqual(coldGuardNames('/tmp/zqcheckout', '/tmp/zqrepo/.git'), ['zqcheckout', 'zqrepo'])
  assert.deepEqual(coldGuardNames('.', '/tmp/zqrepo/.git'), ['zqrepo'])
  assert.deepEqual(coldGuardNames('/tmp/ab', '/tmp/xy/.git'), [])
})

test('runCold leaves runClean and the stash stack alone on a dirty linked tree', () => {
  withRepo({ dirty: false, linked: true }, (fixture) => {
    const result = makeIo(fixture).runCold('git show -s --format=%s')
    assert.equal(result.ok, true)
    assert.match(result.output, /initial/)
    assert.equal(git(fixture.checkout, 'stash', 'list').trim(), '')
    assert.equal(readFileSync(join(fixture.checkout, 'tracked.txt'), 'utf8'), CONTENT.dirty)
  })
})

test('neutralColdPath rejects a root carrying a WHOLE guarded name and uses the next root', () => {
  let draws = 0
  const path = neutralColdPath(['b304-coldverify'], {
    tmpRoots: ['/zz/b304-coldverify/T', '/zz/neutral9'], rand: () => { draws += 1; return `n${draws}n` },
    attempts: 8, realpath: (p) => p,
  })
  assert.match(path, /^\/zz\/neutral9\//)
  assert.equal(draws, 1)
})

test('coldPathRoots preserves explicit order and does not silently fall back', () => {
  assert.deepEqual(coldPathRoots({}), [tmpdir(), ...COLD_PATH_FALLBACK_ROOTS])
  assert.deepEqual(coldPathRoots({ tmpRoot: '/zz/one' }), ['/zz/one'])
  assert.deepEqual(coldPathRoots({ tmpRoots: ['/zz/one', '/zz/two'] }), ['/zz/one', '/zz/two'])
})

test('neutralColdPath canonicalizes symlink roots before judging and building', () => {
  const root = scratchDir('zqsymlink-')
  const target = join(root, 'zqcoldverify9')
  const link = join(root, 'zqlink')
  mkdirSync(target)
  symlinkSync(target, link)
  assert.throws(() => neutralColdPath(['zqcoldverify9'], { tmpRoots: [link], rand: () => 'f9f9f9', attempts: 2 }), /every candidate root was rejected/)

  const neutral = join(root, 'zqneutral')
  const link2 = join(root, 'zqlink2')
  mkdirSync(neutral)
  symlinkSync(neutral, link2)
  const path = neutralColdPath(['nothingatall'], { tmpRoots: [link2], rand: () => 'f9f9f9', attempts: 2 })
  assert.match(path, new RegExp(`^${realpathSync(neutral)}/`))
})

test('the shipped default roots yield a neutral path for this lane and repository', () => {
  withRepo({ dirty: false, linked: true }, (fixture) => {
    const common = git(fixture.checkout, 'rev-parse', '--git-common-dir').trim()
    const resolved = common.startsWith('/') ? common : join(fixture.checkout, common)
    const repo = basename(dirname(resolved))
    const names = ['b304-coldverify', basename(fixture.checkout), repo]
    assert.ok(repo)
    assert.notEqual(repo, basename(fixture.checkout))
    const path = neutralColdPath(names)
    assert.equal(coldPathCollision(basename(path), names), '')
    assert.equal(coldRootCollision(dirname(path), names), '')
  })
})

test('seatIo teardown is a measured zero when no transport was instantiated', () => {
  withRepo({ dirty: false }, (fixture) => {
    assert.deepEqual(makeIo(fixture).teardown(), [])
  })
})

test('seatIo teardown rows every declared pane seat with a recorded surface', () => {
  withRepo({ dirty: false }, (fixture) => {
    const roles = ['lead', 'planner', 'builder', 'reviewer']
    const members = Object.fromEntries(roles.map((role) => [role, { transport: 'pane', surface_id: `s-${role}` }]))
    const journal = []
    const io = seatIo({ members }, fixture.paths, fixture.repoDir, null, null, {}, {
      tree: () => ({ windows: [{}] }),
      locate: (_tree, id) => ({ id }),
      logLine: (_path, row) => journal.push(row),
    })
    const rows = io.teardown()
    assert.deepEqual(rows.map((row) => row.role), roles)
    assert.ok(rows.every((row) => row.outcome === 'unproven' && row.reason === 'surface-open-not-closed-here' && row.record === false))
    const lines = journal.filter((row) => row.event === 'teardown-transports')
    assert.equal(lines.length, 1)
    assert.equal(lines[0].seats, 4)
  })
})

test('a live unclosed pane seat is never failed by the automatic sweep', () => {
  withRepo({ dirty: false }, (fixture) => {
    const members = {
      lead: { transport: 'pane', surface_id: 's-lead' },
      planner: { transport: 'pane', surface_id: 's-planner' },
      builder: { transport: 'pane', surface_id: 's-builder' },
      reviewer: { transport: 'pane', surface_id: 's-reviewer' },
    }
    const io = seatIo({ members }, fixture.paths, fixture.repoDir, null, null, {}, {
      tree: () => ({ windows: [{}] }), locate: () => ({ id: 'still-open' }),
    })
    const rows = io.teardown()
    assert.equal(rows.some((row) => row.outcome === 'failed'), false)
    assert.ok(rows.every((row) => row.outcome === 'unproven'))
  })
})

test('a vanished pane surface is proven and ledger-owned by the automatic sweep', () => {
  withRepo({ dirty: false }, (fixture) => {
    const members = {
      planner: { transport: 'pane', surface_id: 's-planner' },
      builder: { transport: 'pane', surface_id: 's-builder' },
    }
    const io = seatIo({ members }, fixture.paths, fixture.repoDir, null, null, {}, {
      tree: () => ({ windows: [] }), locate: () => null,
    })
    const rows = io.teardown()
    assert.ok(rows.every((row) => row.outcome === 'proven' && row.reason === 'probe-dead'))
    assert.ok(rows.every((row) => !Object.hasOwn(row, 'record')))
  })
})

test('an indeterminate pane probe is unproven and does not own the ledger row', () => {
  withRepo({ dirty: false }, (fixture) => {
    const members = { builder: { transport: 'pane', surface_id: 's-builder' } }
    const io = seatIo({ members }, fixture.paths, fixture.repoDir, null, null, {}, {
      tree: () => ({ windows: undefined }), locate: () => { throw new Error('locate must not run') },
    })
    const rows = io.teardown()
    assert.deepEqual(rows.map((row) => [row.outcome, row.reason, row.record]), [['unproven', 'probe-unknown', false]])
  })
})

test('a seatless crew remains a measured zero in the transport journal', () => {
  withRepo({ dirty: false }, (fixture) => {
    const journal = []
    const io = seatIo({ members: {} }, fixture.paths, fixture.repoDir, null, null, {}, {
      logLine: (_path, row) => journal.push(row),
    })
    assert.deepEqual(io.teardown(), [])
    const lines = journal.filter((row) => row.event === 'teardown-transports')
    assert.equal(lines.length, 1)
    assert.equal(lines[0].seats, 0)
    assert.deepEqual(Object.keys(lines[0]).sort(), ['at', 'channel', 'declared', 'event', 'init_failed', 'seats', 'transports'])
  })
})

test('persisted finite turn ceilings reach JSON and RPC factories while metadata and absence stay inert', () => {
  withRepo({ dirty: false }, (fixture) => {
    const seen = []
    const transport = (name) => ({
      assign: ({ role }) => ({ id: `d-${name}-${role}`, returnPath: join(fixture.paths.returnsDir, `${name}.${role}.json`) }),
      wait: () => ({ status: 'done' }),
    })
    const crew = {
      turn_ceilings: { planner: 7, reviewer: 9, source: { planner: 'flag' }, ignored: NaN },
      members: { planner: { transport: 'headless-json' }, reviewer: { transport: 'headless-rpc' } },
    }
    const io = seatIo(crew, fixture.paths, fixture.repoDir, null, null, {}, {
      resolveWorkerBin: () => '/worker/bin',
      headlessIo: (args) => { seen.push(['json', args.turnCeilings]); return transport('json') },
      headlessRpcIo: (args) => { seen.push(['rpc', args.turnCeilings]); return transport('rpc') },
    })
    io.assign({ role: 'planner', briefFile: '/brief.md' })
    io.assign({ role: 'reviewer', briefFile: '/brief.md' })
    assert.deepEqual(seen, [['json', { planner: 7, reviewer: 9 }], ['rpc', { planner: 7, reviewer: 9 }]])

    const absent = []
    const noRecord = seatIo({ members: { planner: { transport: 'headless-json' } } }, fixture.paths, fixture.repoDir, null, null, {}, {
      resolveWorkerBin: () => '/worker/bin', headlessIo: (args) => { absent.push(args.turnCeilings); return transport('absent') },
    })
    noRecord.assign({ role: 'planner', briefFile: '/brief.md' })
    assert.deepEqual(absent, [null])
  })
})

test('the headless-rpc construction guard stays separate from pane coverage', () => {
  withRepo({ dirty: false }, (fixture) => {
    const throwing = { headlessRpcIo: () => { throw new Error('fifo refused') } }
    const headless = seatIo({ members: {
      planner: { transport: 'headless-rpc' }, reviewer: { transport: 'headless-rpc' },
    } }, fixture.paths, fixture.repoDir, null, null, {}, throwing).teardown()
    assert.equal(headless.length, 2)
    assert.ok(headless.every((row) => row.outcome === 'unproven' && row.reason === 'teardown-threw' && row.transport === 'headless-rpc'))

    const mixed = seatIo({ members: {
      pane: { transport: 'pane', surface_id: 's-pane' }, rpc: { transport: 'headless-rpc' },
    } }, fixture.paths, fixture.repoDir, null, null, {}, {
      ...throwing,
      tree: () => ({ windows: [{}] }), locate: () => ({ id: 's-pane' }),
    }).teardown()
    assert.deepEqual(mixed.map((row) => row.role).sort(), ['pane', 'rpc'])
    assert.equal(new Set(mixed.map((row) => row.role)).size, mixed.length)
  })
})

test('automatic and teardownCore sweeps agree on surfaced pane seats', () => {
  withRepo({ dirty: false }, (fixture) => {
    const baseMembers = {
      planner: { transport: 'pane', surface_id: 's-planner' },
      builder: { transport: 'pane', surface_id: 's-builder' },
    }
    const automatic = (members) => seatIo({ members }, fixture.paths, fixture.repoDir, null, null, {}, {
      tree: () => ({ windows: [{}] }), locate: () => ({ id: 'open' }),
    }).teardown()
    const manual = (members) => teardownCore(fixture.paths, { members }, {
      closeSurface: () => {}, closeWorkspace: () => {}, renameSync: () => {},
      probe: () => false, sleep: () => {}, settleSeatRoots: () => null,
      reclaimDescendants: () => null, io: { log: () => {}, emit: () => true },
    })

    const firstAutomatic = automatic(baseMembers)
    const firstManual = manual(baseMembers)
    assert.equal(firstAutomatic.length, firstManual.seats.seats)
    assert.equal(firstManual.seats.seats, 2)

    const surfacedAndSurfaceless = { ...baseMembers, watcher: { transport: 'pane' } }
    const secondAutomatic = automatic(surfacedAndSurfaceless)
    const secondManual = manual(surfacedAndSurfaceless)
    assert.equal(secondAutomatic.length, secondManual.seats.seats)
    assert.equal(secondManual.seats.seats, 2)
    assert.equal(secondAutomatic.some((row) => row.role === 'watcher'), false)
  })
})

test('settleSeatTeardown tallies and journals unowned rows but never emits them', () => {
  const journal = []
  const emitted = []
  const summary = settleSeatTeardown({
    teardown: () => [
      { role: 'builder', transport: 'pane', outcome: 'unproven', reason: 'surface-open-not-closed-here', record: false },
      { role: 'planner', transport: 'pane', outcome: 'proven', reason: 'probe-dead' },
    ],
    log: (row) => journal.push(row), emit: (event) => { emitted.push(event); return true },
  })
  assert.deepEqual({ seats: summary.seats, proven: summary.proven, unproven: summary.unproven, record_failed: summary.record_failed }, {
    seats: 2, proven: 1, unproven: 1, record_failed: 0,
  })
  assert.equal(journal.filter((row) => row.event === 'seat-teardown').length, 2)
  assert.deepEqual(emitted.map((event) => event.role), ['planner'])
})

test('run keeps a nested node test summary parseable under FORCE_COLOR', () => {
  const saved = process.env.FORCE_COLOR
  process.env.FORCE_COLOR = '3'
  try {
    withRepo({ dirty: false }, (fixture) => {
      writeFileSync(join(fixture.repoDir, 'sample.test.mjs'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('sample', () => { assert.equal(1, 1) })\n")
      const io = makeIo(fixture)
      const result = io.run(`env -u NODE_TEST_CONTEXT ${process.execPath} --test sample.test.mjs`)
      assert.equal(result.output.includes('\x1b'), false)
      const match = /^\s*(?:ℹ|#)?\s*pass (\d+)/m.exec(result.output)
      assert.equal(match?.[1], '1')
      assert.equal(result.ok, true)
    })
  } finally {
    if (saved === undefined) delete process.env.FORCE_COLOR
    else process.env.FORCE_COLOR = saved
  }
})

test('piRefusalFrames reads typed refusal frames and preserves provider text', () => {
  const home = scratchDir('pi-refusal-home-')
  const checkout = '/Users/x/Development/dt-b183-seatrefusal'
  const dir = join(home, '.pi', 'agent', 'sessions', `-${checkout.replaceAll('/', '-')}--`)
  mkdirSync(dir, { recursive: true })
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }
  const frame = (stop, message, content, timestamp) => JSON.stringify({ timestamp, message: { stopReason: stop, errorMessage: message, content, usage } })
  writeFileSync(join(dir, 'session.jsonl'), [
    frame('error', 'WebSocket error', [{ type: 'thinking', thinking: '' }], '2026-08-23T21:31:42.796Z'),
    frame('error', 'prompt_cache_retention is not supported on this model', [], '2026-08-23T22:01:41.213Z'),
  ].join('\n') + '\n')
  const frames = piRefusalFrames({ checkout, deps: { home } })
  assert.deepEqual(frames.map((row) => [row.member, row.source]), [['transient', 'pi'], ['rejected', 'pi']])
  assert.equal(frames[0].message, 'WebSocket error')
  assert.deepEqual(piRefusalFrames({ checkout, since: Date.parse('2026-08-23T21:40:00.000Z'), deps: { home } }).map((row) => row.member), ['rejected'])
})

test('piRefusalFrames ignores non-refusal stops and degrades every store/read/parse failure to no evidence', () => {
  const home = scratchDir('pi-refusal-edge-')
  const checkout = '/tmp/pi-edge'
  const dir = join(home, '.pi', 'agent', 'sessions', `-${checkout.replaceAll('/', '-')}--`)
  mkdirSync(dir, { recursive: true })
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }
  writeFileSync(join(dir, 'session.jsonl'), [
    JSON.stringify({ timestamp: '2026-08-23T21:31:42.796Z', message: { stopReason: 'aborted', errorMessage: 'WebSocket error', content: [], usage } }),
    JSON.stringify({ timestamp: '2026-08-23T21:32:42.796Z', message: { stopReason: 'stop', content: [], usage } }),
    'not json', '',
  ].join('\n'))
  assert.deepEqual(piRefusalFrames({ checkout, deps: { home } }), [])
  assert.deepEqual(piRefusalFrames({ checkout: '/missing', deps: { home } }), [])
  assert.deepEqual(piRefusalFrames({ checkout, deps: { home, existsSync: () => true, readFileSync: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) } } }), [])
})

test('claudeRefusalFrames reads only API error transcript rows and tolerates absent usage', () => {
  const root = scratchDir('claude-refusal-')
  const transcript = join(root, 'transcript.jsonl')
  const taskDir = join(root, 'task')
  mkdirSync(join(taskDir, 'usage'), { recursive: true })
  writeFileSync(transcript, [
    JSON.stringify({ timestamp: '2026-08-23T09:10:00.000Z', message: { content: [{ text: 'working line 403' }] } }),
    JSON.stringify({ timestamp: '2026-08-23T09:17:40.719Z', isApiErrorMessage: true, message: { content: [{ text: "You've hit your session limit · resets 2pm (Europe/Belgrade)" }] } }),
  ].join('\n') + '\n')
  writeFileSync(join(taskDir, 'usage', 'builder.jsonl'), `${JSON.stringify({ session_id: '11111111-1111-4111-8111-111111111111', transcript_path: transcript })}\n`)
  const frames = claudeRefusalFrames({ taskDir, role: 'builder' })
  assert.deepEqual(frames.map((row) => [row.member, row.source]), [['quota', 'claude']])
  assert.deepEqual(claudeRefusalFrames({ taskDir: join(root, 'empty'), role: 'builder' }), [])
})

test('refusal detail is guarded and refusal failures stay in the ledger vocabulary', () => {
  assert.match(providerConditionDetail({ message: 'wait ended', seatRefusal: 'quota' }), /^\[refusal:quota\] /)
  for (const value of ['not-a-member', '__proto__']) assert.equal(providerConditionDetail({ message: 'wait ended', seatRefusal: value }), 'wait ended')
  assert.equal(cellFailureKind({ stage: SEAT_REFUSAL_STAGE }), 'transport-error')
})

test('seatIo reprompts a rejection once, ends on the second, and journals other members', () => {
  withRepo({ dirty: false }, (fixture) => {
    const text = 'prompt_cache_retention is not supported on this model'
    const queue = [
      [{ at: 30_000, member: 'rejected', message: text, source: 'pi' }],
      [],
      [{ at: 90_000, member: 'rejected', message: text, source: 'pi' }],
    ]
    const sends = []
    const journal = []
    let clock = 0
    const io = seatIo({ members: { builder: { agent: 'pi', model: 'sonnet', transport: 'pane', surface_id: 'surface-builder' } } }, fixture.paths, fixture.repoDir, null, null, {}, {
      now: () => clock, sleep: (ms) => { clock += ms }, sendLine: (surface, line) => sends.push({ surface, line }),
      refusalFrames: () => queue.shift() || [], logLine: (_path, row) => journal.push(row), existsSync: () => false,
      tree: () => ({ windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: 'surface-builder' }] }] }] }] }),
      locate: (_tree, id) => id === 'surface-builder',
    })
    const assignment = io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    let thrown
    try { io.wait(assignment.returnPath, 300) } catch (err) { thrown = err }
    assert.equal(sends.length, 2)
    assert.equal(sends[0].line, sends[1].line)
    assert.equal(thrown?.stage, SEAT_REFUSAL_STAGE)
    assert.match(thrown.message, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.equal(journal.filter((row) => row.event === 'seat-refusal').length, 2)
  })
})

test('seatIo policy matrix acts on every refusal member without parking quota', () => {
  const refusal = (member, message) => [{ at: LIVENESS_PROBE_MS, member, message, source: 'pi' }]
  const run = ({ member, message, surface = 'surface-builder', timeoutS = 35 }) => withRepo({ dirty: false }, (fixture) => {
    let clock = 0
    let reads = 0
    const sends = []
    const journal = []
    const crew = { members: { builder: { agent: 'pi', model: 'sonnet', transport: 'pane', ...(surface ? { surface_id: surface } : {}) } } }
    const io = seatIo(crew, fixture.paths, fixture.repoDir, null, null, {}, {
      now: () => clock,
      sleep: (ms) => { clock += ms },
      sendLine: (id, line) => sends.push({ id, line }),
      refusalFrames: () => {
        reads += 1
        return reads === 1 ? refusal(member, message) : []
      },
      logLine: (_path, row) => journal.push(row),
      existsSync: () => false,
      tree: () => ({ windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: 'surface-builder' }] }] }] }] }),
      locate: (_tree, id) => id === 'surface-builder',
    })
    const assignment = io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    let thrown = null
    let env = null
    try { env = io.wait(assignment.returnPath, timeoutS) } catch (err) { thrown = err }
    return { clock, env, thrown, sends, resends: sends.slice(1), journal }
  })

  const quotaText = "You've hit your session limit · resets 3pm (Europe/Belgrade)"
  const quota = run({ member: 'quota', message: quotaText, timeoutS: 300 })
  assert.equal(quota.resends.length, 0)
  assert.equal(quota.thrown?.stage, SEAT_REFUSAL_STAGE)
  assert.ok(quota.thrown.message.includes(quotaText))
  assert.equal(quota.clock, LIVENESS_PROBE_MS)
  assert.equal(quota.journal.some((row) => row.event === 'seat-refusal' && row.outcome === 'ended'), true)
  assert.equal(quota.journal.some((row) => row.event === 'attention' || Object.hasOwn(row, 'park_id')), false)

  const declined = run({ member: 'rejected', message: 'prompt_cache_retention is not supported on this model', surface: null })
  assert.equal(declined.resends.length, 0)
  assert.equal(declined.thrown, null)
  assert.equal(declined.env, null)
  assert.deepEqual(declined.journal.find((row) => row.event === 'seat-refusal'), {
    event: 'seat-refusal', role: 'builder', id: 'd1', member: 'rejected', source: 'pi',
    message: 'prompt_cache_retention is not supported on this model', at: LIVENESS_PROBE_MS,
    outcome: 'declined', why: 'no surface_id', channel: 'record',
  })

  for (const [member, message] of [
    ['transient', 'WebSocket error'],
    ['suspended', 'API Error: Your computer went to sleep mid-response.'],
  ]) {
    const journalOnly = run({ member, message })
    assert.equal(journalOnly.resends.length, 0)
    assert.equal(journalOnly.thrown, null)
    assert.equal(journalOnly.env, null)
    assert.equal(journalOnly.clock, 35_000)
    assert.equal(journalOnly.journal.some((row) => row.event === 'seat-refusal' && row.member === member && row.outcome === 'journalled'), true)
  }

  const overflowed = run({ member: 'overflowed', message: 'context_length_exceeded' })
  assert.equal(overflowed.resends.length, 0)
  assert.equal(overflowed.thrown, null)
  assert.equal(overflowed.journal.some((row) => row.event === 'seat-refusal' && row.member === 'overflowed' && row.news === 'first-occurrence'), true)
})

test('waitForEnvelope sampling cannot change liveness decisions', () => {
  const aliveRun = (sampleSeat) => {
    let clock = 0
    let probes = 0
    const outcomes = [true, null, false, true]
    const aliveAt = []
    const envelope = waitForEnvelope({
      returnPath: '/tmp/return.json', timeoutS: 600, role: 'builder',
      readEnvelope: () => (probes >= outcomes.length ? { status: 'done' } : null),
      probeSeat: () => outcomes[probes++], sampleSeat,
      onAlive: (at) => aliveAt.push(at), now: () => clock,
      sleep: (ms) => { clock += ms },
    })
    return { envelope, aliveAt }
  }
  const deadRun = (sampleSeat) => {
    let clock = 0
    let error
    try {
      waitForEnvelope({
        returnPath: '/tmp/return.json', timeoutS: 1200, role: 'builder',
        readEnvelope: () => null, probeSeat: () => false, sampleSeat,
        now: () => clock, sleep: (ms) => { clock += ms },
      })
    } catch (err) { error = err }
    return { stage: error?.stage, role: error?.role, message: error?.message }
  }
  const base = aliveRun(undefined)
  assert.deepEqual(aliveRun(() => 'overloaded'), base)
  assert.deepEqual(aliveRun(() => { throw new Error('sample failed') }), base)
  const deadBase = deadRun(undefined)
  assert.deepEqual(deadRun(() => 'overloaded'), deadBase)
  assert.deepEqual(deadRun(() => { throw new Error('sample failed') }), deadBase)
  assert.equal(LIVENESS_PROBE_MS, 30_000)
  assert.equal(LIVENESS_MISSES_TO_DIE, 2)
})

test('waitForEnvelope calls onAlive only for observed alive probes with their timestamps', () => {
  let clock = 0
  let probes = 0
  const outcomes = [true, null, false, true]
  const aliveAt = []
  const envelope = waitForEnvelope({
    returnPath: '/tmp/return.json', timeoutS: 600, role: 'builder',
    readEnvelope: () => (probes >= outcomes.length ? { status: 'done' } : null),
    probeSeat: () => outcomes[probes++],
    onAlive: (at) => aliveAt.push(at),
    now: () => clock,
    sleep: (ms) => { clock += ms },
  })
  assert.deepEqual(envelope, { status: 'done' })
  assert.deepEqual(aliveAt, [LIVENESS_PROBE_MS, LIVENESS_PROBE_MS * 4])
})

test('waitForEnvelope keeps seat-died accounting unchanged and never stamps missed probes', () => {
  let clock = 0
  const aliveAt = []
  let error
  try {
    waitForEnvelope({
      returnPath: '/tmp/return.json', timeoutS: 1200, role: 'builder',
      readEnvelope: () => null,
      probeSeat: () => false,
      onAlive: (at) => aliveAt.push(at),
      now: () => clock,
      sleep: (ms) => { clock += ms },
    })
  } catch (err) {
    error = err
  }
  assert.ok(error)
  assert.equal(error.stage, 'seat-died')
  assert.equal(error.role, 'builder')
  assert.equal(error.reclaim, undefined)
  assert.equal(error.message, `seat died: builder — its pane is gone (${LIVENESS_MISSES_TO_DIE} consecutive liveness probes) and no envelope arrived at /tmp/return.json`)
  assert.deepEqual(aliveAt, [])
})

test('waitForEnvelope never consults a root reading and still runs its full budget', () => {
  let clock = 0
  let rootProbes = 0
  const envelope = waitForEnvelope({
    returnPath: '/tmp/return.json', timeoutS: 1200, role: 'builder',
    readEnvelope: () => null,
    probeSeat: () => true,
    probeRoot: () => { rootProbes += 1 },
    now: () => clock,
    sleep: (ms) => { clock += ms },
  })
  assert.equal(envelope, null)
  assert.equal(clock, 1_200_000)
  assert.equal(rootProbes, 0)
})

test('emitAdapter maps only finite heartbeat timestamps to the session writer', () => {
  const calls = []
  const emitter = {
    adwId: 'adw-heartbeat',
    emit: (fn) => fn({ heartbeat: (row) => calls.push(row) }),
  }
  const adapter = emitAdapter(emitter)
  adapter({ kind: 'heartbeat', at: 12345 })
  for (const at of [undefined, null, '12345', Infinity, NaN]) adapter({ kind: 'heartbeat', at })
  assert.deepEqual(calls, [{ adw_id: 'adw-heartbeat', target: 'session', at: 12345 }])
})

test('emitAdapter keeps unmeasured seat-reclaim counters null', () => {
  const rows = []
  const emitter = {
    adwId: 'adw-reclaim-null',
    emit: (fn) => fn({ recordSeatReclaim: (row) => rows.push(row) }),
  }
  emitAdapter(emitter)({
    kind: 'seat-reclaim', transport: HEADLESS_TRANSPORT, seat_id: 'd1',
    reservation_id: 'res-1', sweep_id: 'sweep-1', outcome: 'reclaimed',
  })
  assert.equal(rows.length, 1)
  for (const key of ['captures', 'missed_snapshots', 'discovery_failures', 'captured', 'signalled', 'reclaimed', 'live', 'identity_refused', 'probe_unknown']) {
    assert.equal(rows[0][key], null)
  }
})

test('seatIo stamps a pane heartbeat from the probe timestamp before the envelope arrives', () => {
  withRepo({ dirty: false }, (fixture) => {
    let clock = 0
    let returnPath = null
    const envelope = { assignment_id: 'd1', role: 'builder', status: 'done' }
    const heartbeats = []
    const emitter = {
      adwId: 'adw-pane',
      emit: (fn) => fn({ heartbeat: (row) => heartbeats.push(row) }),
    }
    const io = seatIo({ members: { builder: { surface_id: 'surface-builder', transport: 'pane' } } }, fixture.paths, fixture.repoDir, emitter, null, {}, {
      now: () => clock,
      sleep: (ms) => { clock += ms },
      sendLine: () => {},
      tree: () => ({ windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: 'surface-builder' }] }] }] }] }),
      locate: (_tree, id) => id === 'surface-builder',
      existsSync: (path) => path === returnPath ? clock > LIVENESS_PROBE_MS : existsSync(path),
      readFileSync: (path, ...args) => path === returnPath ? JSON.stringify(envelope) : readFileSync(path, ...args),
    })
    const assignment = io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    returnPath = assignment.returnPath
    assert.deepEqual(io.wait(returnPath, 600), envelope)
    assert.deepEqual(heartbeats, [{ adw_id: 'adw-pane', target: 'session', at: LIVENESS_PROBE_MS }])
  })
})

test('a recognised provider condition lands in the cell-failure detail with role, transport and model', () => {
  withRepo({ dirty: false }, (fixture) => {
    const events = []
    const crew = {
      task: 'b70-provider', claude_bin: '/worker/bin',
      members: { builder: {
        agent: 'claude', provider: 'anthropic', id: 'model-id', model: 'sonnet', effort: 'high', transport: 'headless-json',
      } },
    }
    const failure = Object.assign(new Error('headless no-envelope: provider did not answer'), {
      stage: 'headless-no-envelope', providerCondition: 'overloaded',
    })
    const io = seatIo(crew, fixture.paths, fixture.repoDir, null, null, {}, {
      headlessIo: () => ({
        assign: () => ({ id: 'd1', returnPath: join(fixture.paths.returnsDir, 'd1.builder.json') }),
        wait: () => { throw failure },
      }),
    })
    io.emit = (event) => events.push(event)
    const assignment = io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    assert.throws(() => io.wait(assignment.returnPath, 1), (err) => {
      assert.equal(err.stage, 'headless-no-envelope')
      return true
    })
    const event = events.find((candidate) => candidate.kind === 'cell-failure')
    assert.ok(event)
    assert.equal(event.failure, 'no-envelope')
    assert.equal(event.stage, 'headless-no-envelope')
    assert.match(event.detail, /^\[provider:overloaded\] /)

    const rows = []
    const adapter = emitAdapter({
      adwId: 'adw-provider',
      emit: (fn) => fn({ recordCellFailure: (row) => rows.push(row) }),
    }, crew)
    adapter(event)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].role, 'builder')
    assert.equal(rows[0].transport, 'headless-json')
    assert.equal(rows[0].model, 'sonnet')
    assert.equal(rows[0].detail, event.detail)
  })
})

test('provider recognition branches no adjudication, escalation, reseat or retry', () => {
  withRepo({ dirty: false }, (fixture) => {
    const runFailure = (condition) => {
      const events = []
      const crew = {
        claude_bin: '/worker/bin',
        members: { builder: { model: 'sonnet', transport: 'headless-json' } },
      }
      const failure = Object.assign(new Error('same provider failure'), { stage: 'headless-no-envelope' })
      if (condition !== undefined) failure.providerCondition = condition
      const io = seatIo(crew, fixture.paths, fixture.repoDir, null, null, {}, {
        headlessIo: () => ({
          assign: () => ({ id: 'd1', returnPath: join(fixture.paths.returnsDir, 'd1.builder.json') }),
          wait: () => { throw failure },
        }),
      })
      io.emit = (event) => events.push(event)
      const assignment = io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
      let thrown
      try { io.wait(assignment.returnPath, 1) } catch (err) { thrown = err }
      return { event: events.find((event) => event.kind === 'cell-failure'), thrown }
    }

    const recognised = runFailure('overloaded')
    const plain = runFailure(undefined)
    assert.deepEqual(
      [recognised.event.failure, recognised.event.stage],
      [plain.event.failure, plain.event.stage],
    )
    assert.equal(recognised.thrown.stage, plain.thrown.stage)
    assert.equal(cellFailureKind(recognised.thrown), cellFailureKind(plain.thrown))

    for (const condition of ['not-a-condition', '__proto__']) {
      const forged = runFailure(condition)
      assert.equal(forged.event.detail, 'same provider failure')
    }

    const listed = execFileSync('git', [
      'grep', '-l', '-e', 'providerCondition', '-e', 'PROVIDER_CONDITIONS', '-e', 'recogniseProviderCondition', '--', 'crew/', 'scripts/', 'visualizer/',
    ], { cwd: ROOT, encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean).sort()
    assert.deepEqual(listed, [
      'crew/headless.mjs', 'crew/headless.test.mjs', 'crew/seat-io-runclean.test.mjs', 'crew/seat-io.mjs',
    ])
    const seatIoSource = readFileSync(join(ROOT, 'crew/seat-io.mjs'), 'utf8')
    const executable = seatIoSource.replace(/\/\/.*$/gm, '')
    for (const pattern of [/overloaded_error/, /rate_limit_error/, /authentication_error/, /\b529\b/, /\b429\b/]) {
      assert.doesNotMatch(executable, pattern)
    }
  })
})

test('seatIo waits through an absent or refusing heartbeat emitter', () => {
  for (const emitter of [null, {
    adwId: 'adw-refusing',
    emit: (fn) => fn({ heartbeat: () => { throw new Error('ledger down') } }),
  }]) {
    withRepo({ dirty: false }, (fixture) => {
      let clock = 0
      let returnPath = null
      const envelope = { assignment_id: 'd1', role: 'builder', status: 'done' }
      const io = seatIo({ members: { builder: { surface_id: 'surface-builder', transport: 'pane' } } }, fixture.paths, fixture.repoDir, emitter, null, {}, {
        now: () => clock,
        sleep: (ms) => { clock += ms },
        sendLine: () => {},
        tree: () => ({ windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: 'surface-builder' }] }] }] }] }),
        locate: (_tree, id) => id === 'surface-builder',
        existsSync: (path) => path === returnPath ? clock > LIVENESS_PROBE_MS : existsSync(path),
        readFileSync: (path, ...args) => path === returnPath ? JSON.stringify(envelope) : readFileSync(path, ...args),
      })
      const assignment = io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
      returnPath = assignment.returnPath
      assert.doesNotThrow(() => assert.deepEqual(io.wait(returnPath, 600), envelope))
    })
  }
})

test('readEnvelopeFile returns null for an absent return file and parses a present one', () => {
  const returnPath = '/tmp/pane-return.json'
  const envelope = { assignment_id: 'd1', role: 'builder', status: 'done' }
  assert.equal(readEnvelopeFile(returnPath, {
    existsSync: () => false,
    readFileSync: () => JSON.stringify(envelope),
  }), null)
  assert.deepEqual(readEnvelopeFile(returnPath, {
    existsSync: () => true,
    readFileSync: () => JSON.stringify(envelope),
  }), envelope)
})

test('readEnvelopeFile returns null when the read itself fails', () => {
  const error = Object.assign(new Error('permission denied'), { code: 'EACCES' })
  assert.equal(readEnvelopeFile('/tmp/pane-return.json', {
    existsSync: () => true,
    readFileSync: () => { throw error },
  }), null)
})

test("readEnvelopeFile throws a pane-parse-error naming the path, its existence and the parser's position", () => {
  const returnPath = '/tmp/pane-return.json'
  const malformed = '{"summary":"finished",}'
  let error
  try {
    readEnvelopeFile(returnPath, {
      existsSync: () => true,
      readFileSync: () => malformed,
    })
  } catch (err) {
    error = err
  }
  assert.ok(error)
  assert.equal(error.stage, 'pane-parse-error')
  assert.match(error.message, new RegExp(returnPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(error.message, /EXIST/i)
  assert.match(error.message, /position \d+/)
  assert.equal(cellFailureKind(error), 'unusable-envelope')
})

test('repairshared/A1 pane repair parses, journals beside crew.json, and preserves bytes', () => {
  const dir = scratchDir('pane-repair-')
  const returnsDir = join(dir, 'returns')
  mkdirSync(returnsDir, { recursive: true })
  writeFileSync(join(dir, 'crew.json'), '{}')
  const returnPath = join(returnsDir, 'd1.builder.json')
  const raw = '{"assignment_id":"d1","role":"builder","status":"done","summary":"finished\nthe build"}'
  writeFileSync(returnPath, raw)
  const before = readFileSync(returnPath)
  try {
    const value = readEnvelopeFile(returnPath, { role: 'builder', now: () => 1700000000000 })
    assert.equal(value.summary, 'finished\nthe build')
    assert.equal(readFileSync(returnPath).equals(before), true)
    const rows = readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    assert.equal(rows.length, 1)
    assert.deepEqual(rows[0], {
      at: 1700000000000, event: 'envelope-repair', outcome: 'repaired', role: 'builder',
      assignment_id: 'd1', return_path: returnPath, escaped_count: 1,
      escaped_offsets: [Buffer.byteLength(raw.slice(0, raw.indexOf('\n')), 'utf8')],
    })
    assert.equal(existsSync(join(returnsDir, 'journal.jsonl')), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('seatIo.wait surfaces a malformed return file immediately as an unusable-envelope cell failure', () => {
  withRepo({ dirty: false }, (fixture) => {
    let clock = 0
    let returnPath = null
    const events = []
    const malformed = '{"assignment_id":"d1","role":"builder","status":"done","summary":"finished\nthe build"}'
    const io = seatIo({ members: { builder: { surface_id: 'surface-builder', transport: 'pane' } } }, fixture.paths, fixture.repoDir, null, null, {}, {
      now: () => clock,
      sleep: (ms) => { clock += ms },
      sendLine: () => {},
      tree: () => ({ windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: 'surface-builder' }] }] }] }] }),
      // This pane is not steerable; the immediate-surface property is what the
      // no-re-ask path preserves.
      locate: () => false,
      existsSync: (path) => path === returnPath,
      readFileSync: (path) => path === returnPath ? malformed : readFileSync(path, 'utf8'),
    })
    io.emit = (event) => events.push(event)
    const assignment = io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    returnPath = assignment.returnPath
    let error
    try { io.wait(returnPath, 600) } catch (err) { error = err }
    assert.ok(error)
    assert.equal(error.stage, 'pane-parse-error')
    assert.ok(clock <= WAIT_POLL_MS)
    assert.match(error.message, /no re-ask/)
    const failures = events.filter((event) => event.kind === 'cell-failure')
    assert.equal(failures.length, 1)
    assert.equal(failures[0].failure, 'unusable-envelope')
    assert.match(failures[0].detail, new RegExp(returnPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })
})

function makeReaskHarness(fixture, { alive = true, onReask = null } = {}) {
  let clock = 0
  let returnPath = null
  const sends = []
  const events = []
  const io = seatIo({ members: { builder: { surface_id: 'surface-builder', transport: 'pane' } } }, fixture.paths, fixture.repoDir, null, null, {}, {
    now: () => clock,
    sleep: (ms) => { clock += ms },
    cmux: () => ({ ok: false, stdout: '' }),
    sendLine: (surface, line) => {
      sends.push({ surface, line })
      if (sends.length === 2 && onReask) onReask({ returnPath, line })
    },
    tree: () => ({ windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: 'surface-builder' }] }] }] }] }),
    locate: (_tree, id) => alive === true && id === 'surface-builder',
    existsSync: (path) => existsSync(path),
    readFileSync: (path, ...args) => readFileSync(path, ...args),
    writeFileSync: (path, content) => writeFileSync(path, content),
  })
  io.emit = (event) => events.push(event)
  const assignment = io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
  returnPath = assignment.returnPath
  return {
    io, sends, events, returnPath, clock: () => clock,
    seed: (content) => writeFileSync(returnPath, content),
  }
}

function makeRetryHarness({ transport = 'pane', screen = () => '529 Overloaded · Retrying in 6s · attempt 8/10', envelopeVisible = () => false, envelopeBody = () => JSON.stringify({ status: 'done' }), refusalFrames = null } = {}) {
  const root = scratchDir('seat-retry-transitions-')
  const paths = { dir: root, taskDir: join(root, 'task'), returnsDir: join(root, 'returns') }
  mkdirSync(paths.taskDir, { recursive: true }); mkdirSync(paths.returnsDir, { recursive: true })
  const logs = []; const events = []; const sends = []
  const box = { clock: 0, reads: 0, returnPath: null, envelope: false }
  const returnFile = join(paths.returnsDir, 'd1.lead.json')
  let workerBin = null
  let priorWorkerBin = null
  const member = transport === HEADLESS_TRANSPORT
    ? { transport, agent: 'claude' }
    : { surface_id: 'surface-lead', transport: 'pane', agent: 'claude' }
  const deps = {
    now: () => box.clock,
    sleep: (ms) => { box.clock += ms },
    sendLine: (surface, line) => sends.push({ surface, line }),
    assignmentLine: () => 'assignment',
    logLine: (_path, row) => logs.push(row),
    existsSync: (path) => path === box.returnPath ? envelopeVisible(box) : existsSync(path),
    readFileSync: (path, enc) => path === box.returnPath ? envelopeBody(box) : readFileSync(path, enc),
  }
  if (transport === 'pane') {
    deps.cmux = (verb) => {
      if (verb !== 'read-screen') return { ok: true, stdout: '' }
      box.reads += 1
      return { ok: true, stdout: screen(box) }
    }
    deps.tree = () => ({ windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: 'surface-lead' }] }] }] }] })
    deps.locate = (_tree, id) => id === 'surface-lead'
    if (refusalFrames) deps.refusalFrames = refusalFrames
  } else {
    // `io.assign` resolves the frozen worker binary BEFORE it consults
    // deps.headlessIo, so a machine without a claude install cannot reach the
    // injected seam at all — CI runners have none, and this test is about the
    // retry transition, not about binary resolution. Stub it the way
    // crew/crew.test.mjs:550 does, and restore in cleanup().
    workerBin = join(root, 'stub-claude')
    writeFileSync(workerBin, '')
    priorWorkerBin = process.env.CREW_CLAUDE_BIN
    process.env.CREW_CLAUDE_BIN = workerBin
    deps.headlessIo = () => ({
      assign: () => ({ id: 'd1', returnPath: returnFile }),
      wait: () => null,
    })
  }
  const io = seatIo({ members: { lead: member } }, paths, process.cwd(), null, null, {}, deps)
  io.emit = (event) => events.push(event)
  const assignment = io.assign({ role: 'lead', briefFile: '/tmp/brief.md' })
  box.returnPath = assignment.returnPath
  return { io, logs, events, sends, box, returnPath: box.returnPath, cleanup: () => {
    if (workerBin !== null) {
      if (priorWorkerBin === undefined) delete process.env.CREW_CLAUDE_BIN
      else process.env.CREW_CLAUDE_BIN = priorWorkerBin
    }
    rmSync(root, { recursive: true, force: true })
  } }
}

const MALFORMED_REASK = '{"assignment_id":"d1","role":"builder","status":"done","summary":"finished",}'
const MALFORMED_REASK_2 = '{"assignment_id":"d1","role":"builder","status":"done","summary":"second",}'
const VALID_REASK = JSON.stringify({ assignment_id: 'd1', role: 'builder', status: 'done', summary: 'finished the build', artifacts: [], details: {} })

function makeTransportReaskHarness({ transport = HEADLESS_TRANSPORT, role = 'builder', waits = [], assignFails = [], onWait = null, onLog = null, unmeasuredFirst = false, policy = undefined } = {}) {
  const root = scratchDir(`seat-transport-reask-${transport}-`)
  const paths = { dir: root, taskDir: join(root, 'task'), returnsDir: join(root, 'returns') }
  mkdirSync(paths.taskDir, { recursive: true }); mkdirSync(paths.returnsDir, { recursive: true })
  const workerBin = join(root, 'stub-claude')
  writeFileSync(workerBin, '')
  const logs = []; const events = []; const assigns = []; const waitCalls = []
  let clock = 0; let waitIndex = 0; let transportSleep = null
  const transportIo = {
    assign(spec) {
      assigns.push(spec)
      const failure = assignFails[assigns.length - 1]
      if (failure) throw failure
      const n = assigns.length
      const id = spec?.reask?.id || (unmeasuredFirst && n === 1 ? null : `d${n}`)
      const returnPath = spec?.reask?.returnPath || join(paths.returnsDir, `${id || 'unmeasured'}.${role}.json`)
      const transportDir = join(paths.taskDir, DESCENDANT_STORE_DIRS[transport])
      mkdirSync(transportDir, { recursive: true })
      writeFileSync(join(transportDir, `.${role}.active.json`), JSON.stringify({
        key: role, id: `run-${n}`, role, reservation_id: `res-${n}`, phase: 'running',
      }))
      return { id, returnPath }
    },
    wait(path, seconds) {
      waitCalls.push({ path, seconds })
      onWait?.({ path, seconds, deps, sleep: transportSleep })
      const step = waits[waitIndex++]
      if (typeof step !== 'function') throw new Error(`no scripted wait for ${path}`)
      return step(path, seconds)
    },
    teardown() { return [] },
  }
  const crew = {
    checkout: root,
    claude_bin: workerBin,
    members: { [role]: { model: 'sonnet', transport } },
  }
  const deps = {
    now: () => clock,
    sleep: (ms) => { clock += ms },
    logLine: (_path, row) => { onLog?.(row); logs.push(row) },
    ...(transport === HEADLESS_RPC_TRANSPORT
      ? { headlessRpcIo: ({ deps: transportDeps }) => { transportSleep = transportDeps.sleep; return transportIo } }
      : { headlessIo: ({ deps: transportDeps }) => { transportSleep = transportDeps.sleep; return transportIo } }),
  }
  const io = seatIo(crew, paths, root, null, null, {}, deps)
  io.emit = (event) => events.push(event)
  const first = io.assign({ role, briefFile: '/tmp/brief.md', ...(policy === undefined ? {} : { policy }) })
  const reaskPath = join(paths.returnsDir, `${first.id}.reask.${role}.json`)
  return { root, paths, crew, io, first, reaskPath, assigns, waitCalls, logs, events, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function parseReaskFailure(stage, raw = MALFORMED_REASK) {
  const error = new Error(`unusable envelope from ${stage}`)
  error.stage = stage; error.role = 'builder'; error.raw = raw
  return error
}
function stagedReaskFailure(stage, message = stage) {
  const error = new Error(message)
  error.stage = stage; error.role = 'builder'
  return error
}

test('both pane waits journal the retry transition and the wait exit retires it', () => {
  const ordinary = makeRetryHarness({
    envelopeVisible: (box) => box.envelope,
    screen: (box) => { if (box.reads === 1) box.envelope = true; return '529 Overloaded · Retrying in 6s · attempt 8/10' },
  })
  try {
    assert.deepEqual(ordinary.io.wait(ordinary.returnPath, 120), { status: 'done' })
    assert.equal(ordinary.box.reads, 1)
    assert.equal(ordinary.logs.filter((row) => row.event === 'seat-retrying').length, 1)
    assert.equal(ordinary.logs.filter((row) => row.event === 'seat-retry-cleared').length, 1)
  } finally { ordinary.cleanup() }

  const malformed = makeRetryHarness({ envelopeVisible: () => true, envelopeBody: () => '{', screen: () => '529 Overloaded · Retrying in 6s · attempt 8/10' })
  try {
    assert.throws(() => malformed.io.wait(malformed.returnPath, 40), /unparseable|unusable|envelope/i)
    assert.ok(malformed.box.reads >= 1)
    assert.equal(malformed.logs.filter((row) => row.event === 'envelope-reask').length >= 1, true)
    assert.equal(malformed.logs.filter((row) => row.event === 'seat-retrying').length, 1)
    assert.equal(malformed.logs.filter((row) => row.event === 'seat-retry-cleared').length, 1)
  } finally { malformed.cleanup() }

  const throwing = makeRetryHarness({
    refusalFrames: () => [{ at: 30_000, member: 'quota', message: 'session limit', source: 'claude' }],
  })
  try {
    assert.throws(() => throwing.io.wait(throwing.returnPath, 60), /seat refused/)
    assert.equal(throwing.logs.filter((row) => row.event === 'seat-retrying').length, 1)
    assert.equal(throwing.logs.filter((row) => row.event === 'seat-retry-cleared').length, 1)
  } finally { throwing.cleanup() }

  const headless = makeRetryHarness({ transport: HEADLESS_TRANSPORT })
  try {
    assert.equal(headless.io.wait(headless.returnPath, 60), null)
    assert.equal(headless.logs.some((row) => row.event === 'seat-retrying' || row.event === 'seat-retry-cleared'), false)
  } finally { headless.cleanup() }

  const climbing = makeRetryHarness({
    screen: (box) => `529 Overloaded · Retrying in 6s · attempt ${box.reads === 1 ? 8 : 10}/10`,
  })
  try {
    assert.equal(climbing.io.wait(climbing.returnPath, 61), null)
    assert.equal(climbing.logs.filter((row) => row.event === 'seat-retrying').length, 1)
    assert.equal(climbing.io.waitDiagnosis(climbing.returnPath).state, 'retrying')
    assert.ok(climbing.io.waitDiagnosis(climbing.returnPath).text.includes('attempt 10/10'))
  } finally { climbing.cleanup() }
})

test('a live steerable pane seat gets exactly one re-ask carrying the return path and the verbatim parse failure', () => {
  withRepo({ dirty: false }, (fixture) => {
    const harness = makeReaskHarness(fixture, { onReask: ({ returnPath }) => writeFileSync(returnPath, MALFORMED_REASK_2) })
    harness.seed(MALFORMED_REASK)
    assert.throws(() => harness.io.wait(harness.returnPath, 1), (error) => {
      assert.match(error.message, /re-ask attempted/)
      return true
    })
    assert.equal(harness.sends.length, 2)
    assert.equal(harness.sends[1].surface, 'surface-builder')
    assert.match(harness.sends[1].line, new RegExp(harness.returnPath.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&')))
    const briefPath = join(fixture.paths.taskDir, 'reask-d1.builder.md')
    assert.equal(existsSync(briefPath), true)
    assert.match(readFileSync(briefPath, 'utf8'), /verbatim parse failure:/)
    assert.match(readFileSync(briefPath, 'utf8'), /the file EXISTED \(\d+ bytes\) and is not JSON this driver can read/)
  })
})

test('a valid envelope on the re-ask continues the run as if the first envelope had been readable', () => {
  withRepo({ dirty: false }, (fixture) => {
    const harness = makeReaskHarness(fixture, { onReask: ({ returnPath }) => writeFileSync(returnPath, VALID_REASK) })
    harness.seed(MALFORMED_REASK)
    assert.deepEqual(harness.io.wait(harness.returnPath, 600), JSON.parse(VALID_REASK))
    assert.equal(harness.sends.length, 2)
    const failures = harness.events.filter((event) => event.kind === 'cell-failure')
    assert.equal(failures.length, 1)
    assert.equal(failures[0].failure, 'unusable-envelope')
  })
})

test('a second unparseable envelope escalates naming the attempted re-ask, and the bound sends nothing more', () => {
  withRepo({ dirty: false }, (fixture) => {
    const harness = makeReaskHarness(fixture, { onReask: ({ returnPath }) => writeFileSync(returnPath, MALFORMED_REASK_2) })
    harness.seed(MALFORMED_REASK)
    let first
    try { harness.io.wait(harness.returnPath, 600) } catch (error) { first = error }
    assert.ok(first)
    assert.match(first.message, /the file EXISTED \(\d+ bytes\) and is not JSON this driver can read/)
    assert.match(first.message, /re-ask attempted.*second envelope is still unparseable/s)
    assert.equal(harness.sends.length, 2)
    let second
    try { harness.io.wait(harness.returnPath, 600) } catch (error) { second = error }
    assert.ok(second)
    assert.match(second.message, /no re-ask/)
    assert.equal(harness.sends.length, 2)
  })
})

test('a non-steerable seat gets no re-ask and the escalation says so', () => {
  withRepo({ dirty: false }, (fixture) => {
    const harness = makeReaskHarness(fixture, { alive: false })
    harness.seed(MALFORMED_REASK)
    let error
    try { harness.io.wait(harness.returnPath, 600) } catch (err) { error = err }
    assert.ok(error)
    assert.match(error.message, /no re-ask/)
    assert.match(error.message, /probe-dead/)
    assert.equal(harness.sends.length, 1)
  })
})

test('a failed re-ask leaves the envelope file byte-identical', () => {
  withRepo({ dirty: false }, (fixture) => {
    const harness = makeReaskHarness(fixture)
    harness.seed(MALFORMED_REASK)
    const before = readFileSync(harness.returnPath, 'utf8')
    let error
    try { harness.io.wait(harness.returnPath, 1) } catch (err) { error = err }
    assert.ok(error)
    assert.equal(readFileSync(harness.returnPath, 'utf8'), before)
    assert.match(error.message, /re-ask attempted/)
    assert.equal(harness.sends.length, 2)
  })
})

test('reaskDecision refuses a settled, absent, indeterminate or non-pane seat and states why', () => {
  const refusals = [
    { kind: 'unusable-envelope', transport: 'pane', surfaceId: 'surface-builder', alive: true, asked: true },
    { kind: 'unusable-envelope', transport: 'pane', surfaceId: null, alive: true, asked: false },
    { kind: 'unusable-envelope', transport: 'pane', surfaceId: 'surface-builder', alive: null, asked: false },
    { kind: 'unusable-envelope', transport: HEADLESS_TRANSPORT, surfaceId: null, alive: null, asked: false }
  ]
  for (const args of refusals) {
    const result = reaskDecision(args)
    assert.equal(result.ask, false)
    assert.match(result.why, /\S/)
  }
  assert.equal(reaskDecision({ kind: 'unusable-envelope', transport: 'pane', surfaceId: 'surface-builder', alive: true, asked: false }).ask, true)
  for (const transport of [HEADLESS_TRANSPORT, HEADLESS_RPC_TRANSPORT]) {
    assert.equal(reaskDecision({ kind: 'unusable-envelope', transport, surfaceId: null, alive: null, asked: false, reassignable: true }).ask, true)
  }
})

test('seatRetryDecision keeps the lost-seat cause set and one-per-assignment bound closed', () => {
  for (const kind of ['no-envelope', 'unusable-envelope', 'transport-error', undefined]) {
    const result = seatRetryDecision({ kind, transport: HEADLESS_TRANSPORT, reassignable: true })
    assert.equal(result.retry, false)
    assert.match(result.why, new RegExp(String(kind)))
  }
  for (const kind of ['timeout', 'aborted', 'seat-died']) {
    const result = seatRetryDecision({ kind, transport: HEADLESS_TRANSPORT, reassignable: true })
    assert.equal(result.retry, true)
  }
  for (const option of [{ asked: true }, { graceSpent: true }]) {
    const result = seatRetryDecision({ kind: 'timeout', transport: HEADLESS_TRANSPORT, reassignable: true, ...option })
    assert.equal(result.retry, false)
    assert.match(result.why, /per assignment/)
  }
  const unavailable = seatRetryDecision({ kind: 'timeout', transport: 'future-transport', reassignable: false })
  assert.equal(unavailable.retry, false)
  assert.match(unavailable.why, /future-transport/)
  assert.deepEqual(SEAT_RETRY_KINDS, ['timeout', 'aborted', 'seat-died'])
  assert.equal(SEAT_RETRY_MAX, 1)
  assert.deepEqual(SEAT_RETRY_EVENTS, { timeout: 'seat-timeout-reask', aborted: 'seat-abort-reask', 'seat-died': 'seat-death-reask' })
})

test('R1 a proven-dead envelope-less headless-json reviewer is re-asked once', () => {
  const role = 'reviewer'
  const id = 'd1'
  const valid = { assignment_id: id, role, status: 'done', summary: 'recovered', artifacts: [], details: {} }
  const dead = () => { const error = stagedReaskFailure(SEAT_DIED_STAGE); error.role = role; error.reclaim = { root_liveness: 'dead' }; throw error }
  const harness = makeTransportReaskHarness({ role, transport: HEADLESS_TRANSPORT, waits: [dead, () => valid] })
  try {
    const envelope = harness.io.wait(harness.first.returnPath, 37)
    assert.deepEqual(envelope, valid)
    assert.equal(harness.assigns.length, 2)
    assert.equal(harness.assigns[1].reask.id, id)
    const retryRow = harness.logs.find((row) => row.event === 'seat-death-reask' && row.cause === 'seat-died' && row.outcome === 'recovered')
    assert.ok(retryRow)
    assert.equal(retryRow.from_run_id, 'run-1')
    assert.equal(retryRow.to_run_id, 'run-2')
    assert.notEqual(retryRow.from_run_id, retryRow.to_run_id)
    assert.equal(harness.logs.filter((row) => row.seat_died === role).length, 1)
  } finally { harness.cleanup() }
})

test('R2 a second dead reviewer worker propagates without a third assignment', () => {
  const dead = () => { const error = stagedReaskFailure(SEAT_DIED_STAGE); error.role = 'reviewer'; error.reclaim = { root_liveness: 'dead' }; throw error }
  const harness = makeTransportReaskHarness({ role: 'reviewer', waits: [dead, dead, () => ({ status: 'should not run' })] })
  try {
    assert.throws(() => harness.io.wait(harness.first.returnPath, 5), (error) => error.stage === SEAT_DIED_STAGE)
    assert.equal(harness.assigns.length, 2)
  } finally { harness.cleanup() }
})

test('a death re-ask that fails without a second death journals the first death once', () => {
  const dead = () => { const error = stagedReaskFailure(SEAT_DIED_STAGE); error.role = 'reviewer'; error.reclaim = { root_liveness: 'dead' }; throw error }
  const refused = Object.assign(new Error('assign refused'), { stage: 'transport-error' })
  const harness = makeTransportReaskHarness({ role: 'reviewer', waits: [dead], assignFails: [null, refused] })
  try {
    assert.throws(() => harness.io.wait(harness.first.returnPath, 5), (error) => error.stage === SEAT_DIED_STAGE)
    assert.equal(harness.assigns.length, 2)
    assert.equal(harness.logs.some((row) => row.event === 'seat-death-reask' && row.outcome === 'undelivered'), true)
    assert.equal(harness.logs.filter((row) => row.seat_died === 'reviewer').length, 1)
  } finally { harness.cleanup() }
})

test('a journal that refuses the first death row never blocks the death re-ask', () => {
  const role = 'reviewer'
  const valid = { assignment_id: 'd1', role, status: 'done', summary: 'recovered', artifacts: [], details: {} }
  const dead = () => { const error = stagedReaskFailure(SEAT_DIED_STAGE); error.role = role; error.reclaim = { root_liveness: 'dead' }; throw error }
  const onLog = (row) => { if (row?.seat_died != null) throw new Error('journal unavailable') }
  const harness = makeTransportReaskHarness({ role, waits: [dead, () => valid], onLog })
  try {
    assert.deepEqual(harness.io.wait(harness.first.returnPath, 37), valid)
    assert.equal(harness.assigns.length, 2)
  } finally { harness.cleanup() }
})

test('R3 return bytes prevent retry of a proven-dead worker', () => {
  const harness = makeTransportReaskHarness({ role: 'reviewer', waits: [(path) => {
    writeFileSync(path, '{partial}')
    const error = stagedReaskFailure(SEAT_DIED_STAGE); error.role = 'reviewer'; error.reclaim = { root_liveness: 'dead' }; throw error
  }] })
  try {
    assert.throws(() => harness.io.wait(harness.first.returnPath, 5), (error) => error.stage === SEAT_DIED_STAGE)
    assert.equal(harness.assigns.length, 1)
    assert.equal(harness.logs.some((row) => row.event === 'seat-death-reask'), false)
  } finally { harness.cleanup() }
})

test('R4 missing or unknown reclaim evidence prevents a death retry', () => {
  for (const reclaim of [undefined, { root_liveness: 'unknown' }]) {
    const harness = makeTransportReaskHarness({ role: 'reviewer', waits: [() => {
      const error = stagedReaskFailure(SEAT_DIED_STAGE); error.role = 'reviewer'; if (reclaim) error.reclaim = reclaim; throw error
    }] })
    try {
      assert.throws(() => harness.io.wait(harness.first.returnPath, 5), (error) => error.stage === SEAT_DIED_STAGE)
      assert.equal(harness.assigns.length, 1)
    } finally { harness.cleanup() }
  }
})

test('a lost headless seat is re-asked on a fresh path with its original id and measured row', () => {
  for (const [transport, stage, event] of [
    [HEADLESS_TRANSPORT, 'headless-timeout', 'seat-timeout-reask'],
    [HEADLESS_RPC_TRANSPORT, 'rpc-aborted', 'seat-abort-reask'],
  ]) {
    const harness = makeTransportReaskHarness({
      transport,
      waits: [
        () => { throw stagedReaskFailure(stage, `${stage}: first attempt lost`) },
        () => JSON.parse(VALID_REASK),
      ],
    })
    try {
      const envelope = harness.io.wait(harness.first.returnPath, 37)
      assert.deepEqual(envelope, JSON.parse(VALID_REASK))
      assert.equal(harness.assigns.length, 2)
      const retry = harness.assigns[1]
      assert.equal(retry.reask.id, harness.first.id)
      assert.equal(retry.reask.returnPath, join(harness.paths.returnsDir, `${harness.first.id}.retry.builder.json`))
      assert.notEqual(retry.reask.returnPath, harness.first.returnPath)
      assert.deepEqual(harness.waitCalls.map(({ path, seconds }) => ({ path, seconds })), [
        { path: harness.first.returnPath, seconds: 37 },
        { path: retry.reask.returnPath, seconds: 37 },
      ])
      const row = harness.logs.find((candidate) => candidate.event === event && candidate.outcome === 'recovered')
      assert.ok(row)
      assert.equal(row.cause, stage === 'rpc-aborted' ? 'aborted' : 'timeout')
      assert.equal(row.from_return_path, harness.first.returnPath)
      assert.equal(row.to_return_path, retry.reask.returnPath)
      assert.equal(row.from_run_id, 'run-1')
      assert.equal(row.to_run_id, 'run-2')
      assert.equal(row.ceiling_s, 37)
      assert.equal(Number.isFinite(row.spent_ms), true)
      const brief = readFileSync(join(harness.paths.taskDir, `retry-${harness.first.id}.builder.md`), 'utf8')
      assert.match(brief, /may be PARTIAL/)
      assert.match(brief, /half-applied/)
      assert.doesNotMatch(brief, /WORK is not in question/)
      assert.match(brief, new RegExp(`previous attempt was lost \\(${row.cause}\\)`))
      assert.match(brief, new RegExp(`Write your ReturnEnvelope as valid JSON to ${retry.reask.returnPath.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&')}`))
      assert.match(brief, new RegExp(`Then print exactly: CREW-DONE builder ${harness.first.id}`))
    } finally { harness.cleanup() }
  }
})

test('a lost-seat retry caps a ceiling above REASK_TIMEOUT_S without doubling it', () => {
  const ceilingS = REASK_TIMEOUT_S + 300
  const harness = makeTransportReaskHarness({
    waits: [
      () => { throw stagedReaskFailure('headless-timeout') },
      () => { throw stagedReaskFailure('headless-timeout') },
    ],
  })
  try {
    assert.throws(() => harness.io.wait(harness.first.returnPath, ceilingS))
    assert.equal(harness.waitCalls[1].seconds, REASK_TIMEOUT_S)
    assert.notEqual(harness.waitCalls[1].seconds, ceilingS * 2)
  } finally { harness.cleanup() }
})

test('a lost seat with no measured assignment id declines without naming a retry file', () => {
  const harness = makeTransportReaskHarness({
    unmeasuredFirst: true,
    waits: [() => { throw stagedReaskFailure('headless-timeout') }],
  })
  try {
    assert.throws(() => harness.io.wait(harness.first.returnPath, 5), (error) => {
      assert.match(error.message, /no recorded assignment id/)
      return true
    })
    assert.equal(harness.assigns.length, 1)
    const row = harness.logs.find((candidate) => candidate.event === 'seat-timeout-reask')
    assert.equal(row.id, null)
    assert.equal(row.to_return_path, null)
    assert.equal(readdirSync(harness.paths.taskDir).some((name) => /^retry-retry\..*\.md$/.test(name)), false)
  } finally { harness.cleanup() }
})

test('a seat death raised by the lost-seat re-ask is journalled and measured as a cell failure', () => {
  const harness = makeTransportReaskHarness({
    waits: [
      () => { throw stagedReaskFailure('headless-timeout') },
      () => { throw stagedReaskFailure(SEAT_DIED_STAGE) },
    ],
  })
  try {
    assert.throws(() => harness.io.wait(harness.first.returnPath, 5), (error) => {
      assert.equal(error.stage, SEAT_DIED_STAGE)
      return true
    })
    assert.ok(harness.logs.some((row) => row.seat_died === 'builder'))
    assert.ok(harness.events.some((event) => event.kind === 'cell-failure' && event.failure === 'seat-died'))
  } finally { harness.cleanup() }
})

test('a second lost-seat failure escalates without buying a third assignment', () => {
  for (const [first, second] of [
    ['headless-timeout', 'headless-timeout'],
    ['headless-timeout', 'headless-aborted'],
    ['rpc-aborted', 'rpc-timeout'],
  ]) {
    const transport = first.startsWith('rpc') || second.startsWith('rpc') ? HEADLESS_RPC_TRANSPORT : HEADLESS_TRANSPORT
    const harness = makeTransportReaskHarness({
      transport,
      waits: [
        () => { throw stagedReaskFailure(first) },
        () => { throw stagedReaskFailure(second) },
      ],
    })
    try {
      assert.throws(() => harness.io.wait(harness.first.returnPath, 5))
      assert.equal(harness.assigns.length, 2)
      const failed = harness.logs.find((row) => row.event === (first.startsWith('rpc') ? 'seat-abort-reask' : 'seat-timeout-reask') && row.outcome === 'failed')
      assert.equal(failed.failure, second.startsWith('rpc') ? 'timeout' : second.endsWith('aborted') ? 'aborted' : 'timeout')
    } finally { harness.cleanup() }
  }
})

test('the unusable-envelope and lost-seat paths share one grace in either order', () => {
  const parseFirst = makeTransportReaskHarness({
    waits: [
      () => { throw parseReaskFailure('headless-parse-error') },
      () => { throw stagedReaskFailure('headless-timeout') },
      () => JSON.parse(VALID_REASK),
    ],
  })
  try {
    assert.throws(() => parseFirst.io.wait(parseFirst.first.returnPath, 5))
    assert.equal(parseFirst.assigns.length, 2)
  } finally { parseFirst.cleanup() }

  const lostFirst = makeTransportReaskHarness({
    waits: [
      () => { throw stagedReaskFailure('headless-timeout') },
      () => { throw parseReaskFailure('headless-parse-error') },
    ],
  })
  try {
    assert.throws(() => lostFirst.io.wait(lostFirst.first.returnPath, 5))
    assert.equal(lostFirst.assigns.length, 2)
  } finally { lostFirst.cleanup() }
})

test('a spent budget grace and a clean no-envelope never buy a lost-seat retry', () => {
  const spent = stagedReaskFailure('headless-timeout')
  spent.graceSpent = true
  for (const [transport, stage, error] of [
    [HEADLESS_TRANSPORT, 'headless-timeout', spent],
    [HEADLESS_RPC_TRANSPORT, 'rpc-no-envelope', stagedReaskFailure('rpc-no-envelope')],
  ]) {
    const harness = makeTransportReaskHarness({ transport, waits: [() => { throw error }] })
    try {
      let thrown
      try { harness.io.wait(harness.first.returnPath, 5) } catch (error) { thrown = error }
      assert.ok(thrown)
      if (error.stage !== 'rpc-no-envelope') assert.match(thrown.message, /grace/)
      assert.equal(harness.assigns.length, 1)
      const retryRows = harness.logs.filter((row) => row.event === 'seat-timeout-reask' || row.event === 'seat-abort-reask')
      assert.equal(retryRows.length, error.stage === 'rpc-no-envelope' ? 0 : 1)
      if (retryRows.length) assert.equal(retryRows[0].outcome, 'declined')
      assert.equal(stage, error.stage)
    } finally { harness.cleanup() }
  }
})

test('a lost-seat retry that stays busy records each settle attempt and then undelivered', () => {
  const busy = stagedReaskFailure('headless-session-busy', 'seat remains live')
  const harness = makeTransportReaskHarness({
    waits: [() => { throw stagedReaskFailure('headless-timeout') }],
    assignFails: [null, ...Array.from({ length: 13 }, () => busy)],
  })
  try {
    assert.throws(() => harness.io.wait(harness.first.returnPath, 5))
    const rows = harness.logs.filter((row) => row.event === 'seat-timeout-reask')
    assert.equal(harness.assigns.length, 14)
    assert.equal(rows.filter((row) => row.outcome === 'busy').length, 12)
    assert.equal(rows.at(-1).outcome, 'undelivered')
    assert.equal(rows.at(-1).attempt, 13)
  } finally { harness.cleanup() }
})

test('a lost-seat retry keeps the heartbeat seam active', () => {
  let stream = null
  let waitNumber = 0
  const harness = makeTransportReaskHarness({
    waits: [
      ({ path }) => { throw stagedReaskFailure('headless-timeout', `first wait at ${path}`) },
      () => JSON.parse(VALID_REASK),
    ],
    onWait: ({ sleep }) => {
      waitNumber += 1
      if (!stream || typeof sleep !== 'function') return
      writeFileSync(stream, '{}\n')
      utimesSync(stream, waitNumber, waitNumber)
      sleep(1)
      if (waitNumber > 1) {
        writeFileSync(stream, '{}\n')
        utimesSync(stream, waitNumber + 1, waitNumber + 1)
        sleep(1)
      }
    },
  })
  try {
    stream = join(harness.paths.taskDir, 'headless', 'd1', 'stream.jsonl')
    mkdirSync(dirname(stream), { recursive: true })
    assert.deepEqual(harness.io.wait(harness.first.returnPath, 5), JSON.parse(VALID_REASK))
    const row = harness.logs.find((candidate) => candidate.event === SEAT_LIVENESS_EVENT && candidate.growth === true)
    assert.ok(row)
  } finally { harness.cleanup() }
})

test('a headless-json seat gets exactly one re-ask carrying the original assignment id, and a valid second envelope continues the run', () => {
  const harness = makeTransportReaskHarness({
    transport: HEADLESS_TRANSPORT,
    waits: [
      () => { throw parseReaskFailure('headless-parse-error') },
      () => JSON.parse(VALID_REASK),
    ],
  })
  try {
    assert.deepEqual(harness.io.wait(harness.first.returnPath, 600), JSON.parse(VALID_REASK))
    assert.equal(harness.assigns.length, 2)
    assert.equal(harness.assigns[1].reask.id, harness.first.id)
    assert.equal(harness.assigns[1].reask.returnPath, harness.reaskPath)
    assert.equal(harness.events.filter((event) => event.kind === 'cell-failure').length, 1)
  } finally { harness.cleanup() }
})

test("a headless-rpc seat's re-ask is delegated to its transport io", () => {
  const harness = makeTransportReaskHarness({
    transport: HEADLESS_RPC_TRANSPORT,
    waits: [
      () => { throw parseReaskFailure('rpc-parse-error') },
      () => JSON.parse(VALID_REASK),
    ],
  })
  try {
    assert.deepEqual(harness.io.wait(harness.first.returnPath, 600), JSON.parse(VALID_REASK))
    assert.equal(harness.assigns.length, 2)
    assert.equal(harness.assigns[1].reask.id, harness.first.id)
    assert.equal(harness.assigns[1].reask.returnPath, harness.reaskPath)
  } finally { harness.cleanup() }
})

test('the re-ask bound holds on every transport', () => {
  for (const transport of [HEADLESS_TRANSPORT, HEADLESS_RPC_TRANSPORT]) {
    const stage = transport === HEADLESS_RPC_TRANSPORT ? 'rpc-parse-error' : 'headless-parse-error'
    const harness = makeTransportReaskHarness({
      transport,
      waits: [
        () => { throw parseReaskFailure(stage) },
        () => { throw parseReaskFailure(stage, MALFORMED_REASK_2) },
      ],
    })
    try {
      let first
      try { harness.io.wait(harness.first.returnPath, 600) } catch (error) { first = error }
      assert.ok(first)
      assert.match(first.message, /re-ask attempted/)
      assert.match(first.message, /second envelope is still unparseable/)
      assert.equal(harness.assigns.length, 2)
      assert.throws(() => harness.io.wait(harness.first.returnPath, 600))
    } finally { harness.cleanup() }
  }
})

test('every delivery attempt is journalled with its ordinal', () => {
  const busy = stagedReaskFailure('headless-session-busy', 'seat is still busy')
  const harness = makeTransportReaskHarness({
    waits: [
      () => { throw parseReaskFailure('headless-parse-error') },
      () => JSON.parse(VALID_REASK),
    ],
    assignFails: [null, busy],
  })
  try {
    assert.deepEqual(harness.io.wait(harness.first.returnPath, 600), JSON.parse(VALID_REASK))
    const rows = harness.logs.filter((row) => row.event === 'envelope-reask')
    assert.deepEqual(rows.map((row) => [row.outcome, row.attempt]), [['busy', 1], ['sent', 2], ['recovered', undefined]])
    assert.ok(rows.every((row) => row.transport === HEADLESS_TRANSPORT))
  } finally { harness.cleanup() }
})

test('a seat that never settles fails the run after the named bound', () => {
  const busy = stagedReaskFailure('headless-session-busy', 'seat is still busy')
  const harness = makeTransportReaskHarness({
    waits: [() => { throw parseReaskFailure('headless-parse-error') }],
    assignFails: [null, ...Array.from({ length: REASK_SETTLE_POLLS + 1 }, () => busy)],
  })
  try {
    let error
    try { harness.io.wait(harness.first.returnPath, 600) } catch (err) { error = err }
    assert.ok(error)
    assert.equal(harness.assigns.length, REASK_SETTLE_POLLS + 2)
    const rows = harness.logs.filter((row) => row.event === 'envelope-reask')
    assert.equal(rows.filter((row) => row.outcome === 'busy').length, REASK_SETTLE_POLLS)
    const terminal = rows.at(-1)
    assert.deepEqual([terminal.outcome, terminal.attempt], ['undelivered', REASK_SETTLE_POLLS + 1])
    assert.equal(terminal.transport, HEADLESS_TRANSPORT)
  } finally { harness.cleanup() }
})

test('every envelope-reask row names its transport', () => {
  withRepo({ dirty: false }, (fixture) => {
    const logs = []; let sends = 0; let returnPath = null
    const io = seatIo({ members: { builder: { transport: 'pane', surface_id: 'surface-builder' } } }, fixture.paths, fixture.repoDir, null, null, {}, {
      logLine: (_path, row) => logs.push(row),
      sendLine: () => { sends += 1; if (sends === 2) writeFileSync(returnPath, VALID_REASK) },
      tree: () => ({ windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: 'surface-builder' }] }] }] }] }),
      locate: (_tree, id) => id === 'surface-builder',
    })
    const assignment = io.assign({ role: 'builder', briefFile: '/tmp/brief.md' }); returnPath = assignment.returnPath
    writeFileSync(returnPath, MALFORMED_REASK)
    assert.deepEqual(io.wait(returnPath, 600), JSON.parse(VALID_REASK))
    assert.equal(logs.filter((row) => row.event === 'envelope-reask').every((row) => row.transport === 'pane'), true)
  })

  for (const transport of [HEADLESS_TRANSPORT, HEADLESS_RPC_TRANSPORT]) {
    const stage = transport === HEADLESS_RPC_TRANSPORT ? 'rpc-parse-error' : 'headless-parse-error'
    const harness = makeTransportReaskHarness({ transport, waits: [() => { throw parseReaskFailure(stage) }, () => JSON.parse(VALID_REASK)] })
    try {
      harness.io.wait(harness.first.returnPath, 600)
      assert.equal(harness.logs.filter((row) => row.event === 'envelope-reask').every((row) => row.transport === transport), true)
    } finally { harness.cleanup() }
  }
})

test("a transport re-ask leaves the seat's own return file byte-identical", () => {
  for (const transport of [HEADLESS_TRANSPORT, HEADLESS_RPC_TRANSPORT]) {
    const stage = transport === HEADLESS_RPC_TRANSPORT ? 'rpc-parse-error' : 'headless-parse-error'
    const harness = makeTransportReaskHarness({ transport, waits: [() => { throw parseReaskFailure(stage) }, () => JSON.parse(VALID_REASK)] })
    try {
      writeFileSync(harness.first.returnPath, MALFORMED_REASK)
      const before = readFileSync(harness.first.returnPath, 'utf8')
      assert.deepEqual(harness.io.wait(harness.first.returnPath, 600), JSON.parse(VALID_REASK))
      assert.equal(readFileSync(harness.first.returnPath, 'utf8'), before)
      assert.notEqual(harness.assigns[1].reask.returnPath, harness.first.returnPath)
    } finally { harness.cleanup() }
  }
})

test('a second failure that is not a parse failure is journalled as failed', () => {
  const harness = makeTransportReaskHarness({ waits: [
    () => { throw parseReaskFailure('headless-parse-error') },
    () => { throw stagedReaskFailure('headless-timeout', 'headless timeout') },
  ] })
  try {
    let error
    try { harness.io.wait(harness.first.returnPath, 600) } catch (err) { error = err }
    assert.ok(error)
    const rows = harness.logs.filter((row) => row.event === 'envelope-reask')
    assert.equal(rows.some((row) => row.outcome === 'unparseable-again'), false)
    const failed = rows.find((row) => row.outcome === 'failed')
    assert.deepEqual({ failure: failed.failure, second: failed.second }, { failure: 'timeout', second: 'headless-timeout' })
    assert.match(error.message, /is not JSON this driver can read|unusable envelope/)
  } finally { harness.cleanup() }
})

test('a seat refusal on the re-ask writes its terminal row before it is rethrown', () => {
  const refusal = stagedReaskFailure(SEAT_REFUSAL_STAGE, 'provider refused')
  const harness = makeTransportReaskHarness({ waits: [
    () => { throw parseReaskFailure('headless-parse-error') },
    () => { throw refusal },
  ] })
  try {
    let error
    try { harness.io.wait(harness.first.returnPath, 600) } catch (err) { error = err }
    assert.equal(error, refusal)
    const rows = harness.logs.filter((row) => row.event === 'envelope-reask')
    assert.equal(rows.at(-1).outcome, 'failed')
    assert.equal(rows.at(-1).second, SEAT_REFUSAL_STAGE)
  } finally { harness.cleanup() }
})

test('a transport this build never enrolled is refused a re-ask', () => {
  const harness = makeTransportReaskHarness({ waits: [() => { throw parseReaskFailure('headless-parse-error') }] })
  try {
    harness.crew.members.builder.transport = 'some-future-transport'
    assert.throws(() => harness.io.wait(harness.first.returnPath, 600))
    assert.equal(harness.assigns.length, 1)
    const declined = harness.logs.find((row) => row.event === 'envelope-reask' && row.outcome === 'declined')
    assert.equal(declined.transport, 'some-future-transport')
  } finally { harness.cleanup() }
})

test('seatIo.wait keeps polling an absent return file to its deadline', () => {
  withRepo({ dirty: false }, (fixture) => {
    let clock = 0
    let returnPath = null
    const events = []
    const io = seatIo({ members: { builder: { surface_id: 'surface-builder', transport: 'pane' } } }, fixture.paths, fixture.repoDir, null, null, {}, {
      now: () => clock,
      sleep: (ms) => { clock += ms },
      sendLine: () => {},
      tree: () => ({ windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: 'surface-builder' }] }] }] }] }),
      locate: (_tree, id) => id === 'surface-builder',
      existsSync: (path) => path === returnPath ? false : existsSync(path),
      readFileSync: (path, ...args) => readFileSync(path, ...args),
    })
    io.emit = (event) => events.push(event)
    const assignment = io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    returnPath = assignment.returnPath
    assert.equal(io.wait(returnPath, 600), null)
    assert.ok(clock >= 600 * 1000)
    const failures = events.filter((event) => event.kind === 'cell-failure')
    assert.equal(failures.length, 1)
    assert.equal(failures[0].failure, 'timeout')
  })
})

const rosterFixture = () => ({
  schema_version: 1,
  updated_at: '2026-08-30',
  tiers: {
    mechanical: {
      lead: null,
      planner: { provider: 'anthropic', id: 'claude-opus-5', agent: 'claude', effort: 'medium' },
      builder: { provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'max' },
      reviewer: { provider: 'openai', id: 'gpt-5.6-sol', agent: 'pi', effort: 'medium' },
    },
    build: {
      lead: { provider: 'anthropic', id: 'claude-opus-5', agent: 'claude', effort: 'medium' },
      planner: { provider: 'anthropic', id: 'claude-opus-5', agent: 'claude', effort: 'medium' },
      builder: { provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'max' },
      reviewer: { provider: 'openai', id: 'gpt-5.6-sol', agent: 'pi', effort: 'high' },
    },
    judge: {
      lead: { provider: 'anthropic', id: 'claude-opus-5', agent: 'claude', effort: 'high' },
      planner: { provider: 'anthropic', id: 'claude-opus-5', agent: 'claude', effort: 'high' },
      builder: { provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'max' },
      reviewer: { provider: 'anthropic', id: 'claude-opus-5', agent: 'claude', effort: 'xhigh' },
      'tech-lead': { provider: 'openai', id: 'gpt-5.6-sol', agent: 'pi', effort: 'xhigh' },
    },
  },
  models: {
    'anthropic/claude-opus-5': { cost_out_per_mtok: 25 },
    'openai/gpt-5.6-luna': { cost_out_per_mtok: 1.2 },
    'openai/gpt-5.6-sol': { cost_out_per_mtok: 20 },
  },
})
const DURABILITY_ROSTER = rosterFixture()

function makeCrewJsonSeatFixture({ writeCrew = writeFileSync, logLine, extraDeps = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'crew-json-seat-'))
  const paths = { dir: root, taskDir: join(root, 'task'), returnsDir: join(root, 'returns') }
  mkdirSync(paths.taskDir); mkdirSync(paths.returnsDir)
  const source = DURABILITY_ROSTER.tiers.mechanical.reviewer
  const member = {
    transport: 'headless-json', agent: 'pi', model: source.id, effort: source.effort,
    provider: source.provider, id: source.id,
  }
  const crew = { members: { reviewer: member }, tier: 'mechanical', seats: { reviewer: { ...member } } }
  const logs = []
  const io = seatIo(crew, paths, root, null, { reviewer: { adapter: { modelString: ({ id }) => `model:${id}` } } }, {}, {
    readRoster: () => DURABILITY_ROSTER,
    logLine: logLine || ((_path, value) => logs.push(value)),
    writeFileSync: writeCrew,
    ...extraDeps,
  })
  return { root, paths, crew, io, logs, source, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('reseat uses locked RMW: another member survives and a stale transport persist keeps the new cell', async () => {
  const f = makeCrewJsonSeatFixture()
  const file = join(f.paths.dir, 'crew.json')
  const stale = JSON.parse(JSON.stringify(f.crew))
  const onDisk = {
    ...f.crew,
    members: { ...f.crew.members, builder: { role: 'builder', model: 'concurrent-member' } },
    seats: { ...f.crew.seats, builder: { model: 'concurrent-member' } },
  }
  writeFileSync(file, JSON.stringify(onDisk, null, 2))
  let writer = null
  try {
    // The second process publishes the concurrent member change through the
    // real harness; stop after its first atomic write so the RMW seam below is
    // deterministic while still exercising a process boundary.
    writer = await startFileWriter({ file, text: JSON.stringify({ ...onDisk, writer: '%N%' }), mode: 'atomic', maxMs: 1000 })
    const stopped = await writer.stop(); writer = null
    assert.ok(stopped.writes >= 1)
    rmSync(`${file}.stop`, { force: true })
    const result = f.io.reseat('reviewer', { reason: 'lane' })
    assert.equal(result.applied, true)
    const afterReseat = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(afterReseat.members.builder.model, 'concurrent-member')
    assert.equal(afterReseat.members.reviewer.id, result.to.id)
    const transport = headlessIo({
      crew: stale, paths: f.paths, taskDir: f.paths.taskDir, checkout: f.paths.dir,
      adapters: { reviewer: { headlessCommand: () => ({ bin: '/bin/worker', args: [] }) } }, bin: '/bin/worker',
      deps: { spawn: () => ({ pid: 8121, unref() {} }), uuid: () => 'stale-seat-session', now: () => 0, sleep: () => {}, pid: 8120, log() {} },
    })
    transport.assign({ role: 'reviewer', briefFile: join(f.paths.taskDir, 'brief.md') })
    const afterPersist = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(afterPersist.members.builder.model, 'concurrent-member')
    assert.equal(afterPersist.members.reviewer.id, result.to.id)
    assert.equal(afterPersist.members.reviewer.session_id, 'stale-seat-session')
  } finally {
    if (writer) await writer.stop()
    f.cleanup()
  }
})

test('a failed reseat persist records persisted:false and warns with crew.json', () => {
  const realWrite = writeFileSync
  const f = makeCrewJsonSeatFixture({
    writeCrew: (path, data, options) => {
      if (String(path).includes('crew.json.tmp.')) throw new Error('simulated crew.json write failure')
      return realWrite(path, data, options)
    },
  })
  const file = join(f.paths.dir, 'crew.json')
  writeFileSync(file, JSON.stringify(f.crew, null, 2))
  const errors = []; const original = process.stderr.write
  process.stderr.write = (chunk) => { errors.push(String(chunk)); return true }
  let result
  try { result = f.io.reseat('reviewer', { reason: 'lane' }) } finally {
    process.stderr.write = original
    f.cleanup()
  }
  assert.equal(result.applied, true)
  assert.equal(result.persisted, false)
  assert.match(result.why, /write-failed/)
  const record = f.logs.map((entry) => entry.reseat).find(Boolean)
  assert.equal(record.persisted, false)
  assert.match(record.persist_error, /write-failed/)
  assert.match(errors.join(''), /warning: reseat of .*crew\.json/)
})

test('saveCrew publishes a whole crew atomically for boot', () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-json-save-'))
  const paths = { dir: root }
  const file = join(root, 'crew.json')
  const crew = { boot: true, members: { builder: { model: 'boot-model' } } }
  try {
    writeFileSync(file, JSON.stringify({ old: true }))
    const before = statSync(file).ino
    saveCrew(paths, crew, { uuid: () => 'boot-save' })
    assert.notEqual(statSync(file).ino, before)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), crew)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('showDoc updates doc_viewer without clobbering a concurrent member change', async () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-json-doc-'))
  const paths = { dir: root, taskDir: join(root, 'task'), returnsDir: join(root, 'returns') }
  mkdirSync(paths.taskDir); mkdirSync(paths.returnsDir)
  const crew = { workspace_id: 'ws', window_id: 'win', members: { reviewer: { model: 'stale' } } }
  const file = join(root, 'crew.json')
  const onDisk = { members: { reviewer: { model: 'stale' }, builder: { model: 'concurrent-builder' } } }
  writeFileSync(file, JSON.stringify(onDisk, null, 2))
  const before = { windows: [] }
  const after = { windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: 'doc-surface' }] }] }] }] }
  let trees = 0; let writer = null
  try {
    writer = await startFileWriter({ file, text: JSON.stringify({ ...onDisk, writer: '%N%' }), mode: 'atomic', maxMs: 1000 })
    const stopped = await writer.stop(); writer = null
    assert.ok(stopped.writes >= 1)
    rmSync(`${file}.stop`, { force: true })
    const io = seatIo(crew, paths, root, null, null, {}, {
      tree: () => trees++ === 0 ? before : after,
      cmux: (verb) => { assert.equal(verb, 'markdown'); return { ok: true } },
      closeSurface: () => {},
      logLine: () => {},
    })
    io.showDoc('/plan.md')
    const disk = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(disk.members.builder.model, 'concurrent-builder')
    assert.deepEqual(disk.doc_viewer, { path: '/plan.md', surface_id: 'doc-surface' })
  } finally {
    if (writer) await writer.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test('recogniseProviderRetry reads the measured retry banner and nothing else', () => {
  const banner = `${String.fromCharCode(27)}[31m529 Overloaded${String.fromCharCode(27)}[39m · Retrying in 6s · attempt 8/10`
  assert.deepEqual(recogniseProviderRetry(banner), {
    retry_in_s: 6, attempt: 8, of: 10, condition: 'overloaded',
  })
  assert.equal(recogniseProviderRetry('Adjudicating (esc to interrupt · 142s)'), null)
  assert.equal(recogniseProviderRetry('529 Overloaded · attempt 8/10'), null)
  assert.equal(recogniseProviderRetry(null), null)
})

test('paneRetryFrame degrades to null for an absent surface, a failed read and a throw', () => {
  const banner = '529 Overloaded · Retrying in 6s · attempt 8/10'
  assert.deepEqual(paneRetryFrame('surface-builder', { cmux: () => ({ ok: true, stdout: banner }) }), {
    retry_in_s: 6, attempt: 8, of: 10, condition: 'overloaded',
  })
  assert.equal(paneRetryFrame(null, { cmux: () => ({ ok: true, stdout: banner }) }), null)
  assert.equal(paneRetryFrame('surface-builder', { cmux: () => ({ ok: false, stdout: banner }) }), null)
  assert.equal(paneRetryFrame('surface-builder', { cmux: () => { throw new Error('EPERM') } }), null)
  assert.equal(paneRetryFrame('surface-builder', { cmux: () => ({ ok: true, stdout: '' }) }), null)
})

test('waitState names a retrying seat above a stale one and leaves the other states alone', () => {
  const at = 2_000_000
  const retry = { retry_in_s: 6, attempt: 10, of: 10, condition: 'overloaded' }
  const verdict = waitState({ role: 'builder', latest: at - 1_000_000, refusal: null, at, timeoutS: 2400, retry })
  assert.equal(verdict.state, 'retrying')
  assert.match(verdict.text, /RETRYING/)
  assert.ok(verdict.text.includes('attempt 10/10'))
  assert.equal(waitState({ role: 'builder', latest: at - 1_000_000, refusal: null, at, timeoutS: 2400 }).state, 'stale')
  assert.equal(waitState({ role: 'builder', latest: at - 1000, refusal: { member: 'transient', message: 'WebSocket error' }, at, timeoutS: 2400 }).state, 'working')
  assert.equal(waitState({ role: 'builder', latest: at - 1000, refusal: null, at, timeoutS: 2400 }).state, 'working')
  assert.equal(waitState({ role: 'builder', latest: null, refusal: null, at, timeoutS: 2400, retry: null }), null)
})

test('a stale condition survives a timeout and is retired only by measured growth', () => {
  withTranscriptSeat({ timeoutS: 31, transcriptPaths: () => ['/x/builder.jsonl'], statSync: () => ({ mtimeMs: -1_000_000 }) }, ({ logs, env }) => {
    assert.equal(env, null)
    assert.equal(logs.filter((row) => row.event === 'seat-stale').length, 1)
    assert.equal(logs.filter((row) => row.event === 'seat-stale-cleared').length, 0)
  })

  withTranscriptSeat({
    timeoutS: 61, transcriptPaths: () => ['/x/builder.jsonl'],
    statSync: (_path, at) => ({ mtimeMs: at >= 45_000 ? at - 1000 : -1_000_000 }),
  }, ({ logs, env }) => {
    assert.equal(env, null)
    assert.equal(logs.filter((row) => row.event === 'seat-stale').length, 1)
    assert.equal(logs.filter((row) => row.event === 'seat-stale-cleared').length, 1)
  })

  withTranscriptSeat({
    timeoutS: 60, envelopeAt: 35_000, transcriptPaths: () => ['/x/builder.jsonl'],
    statSync: () => ({ mtimeMs: -1_000_000 }),
  }, ({ logs, env }) => {
    assert.deepEqual(env, { status: 'done' })
    assert.equal(logs.filter((row) => row.event === 'seat-stale').length, 1)
    assert.equal(logs.filter((row) => row.event === 'seat-stale-cleared').length, 1)
  })
})

test('waitState names stale, refused and working states and stays silent without growth', () => {
  const at = 2_000_000
  const stale = waitState({ role: 'builder', latest: at - 1_000_000, refusal: null, at, timeoutS: 2400 })
  assert.equal(stale.state, 'stale')
  assert.match(stale.text, /1000s ago/)
  assert.match(stale.text, /a spinner and an elapsed timer are not evidence of life/)
  const refused = waitState({ role: 'builder', latest: at - 1000, refusal: { member: 'suspended', message: 'computer went to sleep' }, at, timeoutS: 2400 })
  assert.equal(refused.state, 'refused')
  assert.match(refused.text, /computer went to sleep/)
  const working = waitState({ role: 'builder', latest: at - 500_000, refusal: null, at, timeoutS: 2400 })
  assert.equal(working.state, 'working')
  assert.match(working.text, /2400s budget/)
  assert.equal(waitState({ role: 'builder', latest: null, refusal: null, at, timeoutS: 2400 }), null)
  for (const row of SEAT_REFUSALS) {
    const verdict = waitState({ role: 'builder', latest: at - 1000, refusal: { member: row.member, message: 'named condition' }, at, timeoutS: 2400 })
    assert.equal(verdict.state, row.terminal ? 'refused' : 'working')
  }
})

test('waitState expires terminal refusal readings at the measured boundary', () => {
  const at = 2_000_000
  const verdict = (age, refusal = {}) => waitState({
    role: 'builder', latest: at - 1000,
    refusal: { member: 'suspended', message: 'computer went to sleep', ...refusal },
    at, timeoutS: 2400,
  })
  assert.equal(verdict(300_000, { at: at - 300_000 }).state, 'working')
  assert.equal(verdict(299_999, { at: at - 299_999 }).state, 'refused')
  assert.equal(verdict(null).state, 'refused')
})

test('waitState never names an unclassified refusal frame', () => {
  const at = 2_000_000
  for (const member of [null, 'overloaded', undefined]) {
    const refusal = { member, message: 'something the closed vocabulary does not match' }
    const fresh = waitState({ role: 'builder', latest: at - 1000, refusal, at, timeoutS: 2400 })
    assert.equal(fresh.state, 'working')
    assert.doesNotMatch(fresh.text, /refused|unclassified/i)
    assert.equal(waitState({ role: 'builder', latest: null, refusal, at, timeoutS: 2400 }), null)
  }
})

test('waitState uses the measured 900-second threshold at both arms', () => {
  assert.equal(TRANSCRIPT_STALE_MS, 900_000)
  const at = 2_000_000
  assert.equal(waitState({ role: 'builder', latest: at - 500_000, refusal: null, at, timeoutS: 2400 }).state, 'working')
  assert.equal(waitState({ role: 'builder', latest: at - 1_000_000, refusal: null, at, timeoutS: 2400 }).state, 'stale')
  assert.equal(waitState({ role: 'builder', latest: at - TRANSCRIPT_STALE_MS, refusal: null, at, timeoutS: 2400 }).state, 'stale')
})

test('transcriptGrowth chooses the newest readable mtime and refuses to guess', () => {
  const stat = (path) => ({ mtimeMs: path === '/x/a.jsonl' ? 1000 : 5000 })
  assert.equal(transcriptGrowth(['/x/a.jsonl', '/x/b.jsonl'], { statSync: stat }), 5000)
  assert.equal(transcriptGrowth(['/x/b.jsonl', '/x/a.jsonl'], { statSync: stat }), 5000)
  assert.equal(transcriptGrowth(['/x/a.jsonl'], { statSync: () => { throw new Error('EPERM') } }), null)
  assert.equal(transcriptGrowth('not-an-array', { statSync: stat }), null)
  assert.equal(transcriptGrowth(['/x/a.jsonl', '/x/b.jsonl'], { statSync: (path) => ({ mtimeMs: path === '/x/a.jsonl' ? Number.NaN : 5000 }) }), 5000)
})

test('E1 empty and unreadable transcript growth remains null', () => {
  assert.equal(transcriptGrowth([], { statSync: () => ({ size: 0, mtimeMs: 123 }) }), null)
  assert.equal(transcriptGrowth(['/empty.jsonl'], { statSync: () => ({ size: 0, mtimeMs: 987654321 }) }), null)
  for (const code of ['ENOENT', 'EACCES', 'EPERM']) {
    assert.equal(transcriptGrowth(['/unreadable.jsonl'], { statSync: () => { throw Object.assign(new Error(code), { code }) } }), null)
  }
  assert.equal(transcriptGrowth(['/throwing.jsonl'], { statSync: () => { throw new Error('interrupted stat') } }), null)
  assert.notEqual(transcriptGrowth(['/nonempty.jsonl'], { statSync: () => ({ size: 1, mtimeMs: 4242 }) }), 0)
})

test('waitForEnvelope samples transcript growth on each liveness tick without changing the wait', () => {
  const run = (growth) => {
    let clock = 0; let probes = 0; const seen = []; const aliveAt = []
    const options = {
      returnPath: '/tmp/return.json', timeoutS: 600, role: 'builder',
      readEnvelope: () => (probes >= 4 ? { status: 'done' } : null),
      probeSeat: () => { probes += 1; return true }, onAlive: (at) => aliveAt.push(at), now: () => clock,
      sleep: (ms) => { clock += ms },
    }
    if (growth) { options.sampleGrowth = () => 4242; options.onGrowth = (record) => seen.push(record) }
    const env = waitForEnvelope(options)
    return { env, aliveAt, probes, seen }
  }
  const plain = run(null)
  const measured = run(true)
  assert.deepEqual({ env: measured.env, aliveAt: measured.aliveAt, probes: measured.probes }, { env: plain.env, aliveAt: plain.aliveAt, probes: plain.probes })
  assert.deepEqual(measured.seen, [1, 2, 3, 4].map((n) => ({ at: n * LIVENESS_PROBE_MS, latest: 4242 })))

  let clock = 0; let probes = 0
  const env = waitForEnvelope({
    returnPath: '/tmp/return.json', timeoutS: 600, role: 'builder', readEnvelope: () => (probes >= 1 ? { status: 'done' } : null),
    probeSeat: () => { probes += 1; return true }, sampleGrowth: () => { throw new Error('interrupted stat') },
    onGrowth: () => { throw new Error('growth callback is not load-bearing') }, now: () => clock, sleep: (ms) => { clock += ms },
  })
  assert.deepEqual(env, { status: 'done' })
})

function withTranscriptSeat({ start = 0, timeoutS = 2000, transcriptPaths, statSync, refusalFrames, sendLine, envelopeAt, surfaceId = 'surface-builder', transportAt = null }, body) {
  const root = scratchDir('seat-transcript-growth-')
  const paths = { dir: root, taskDir: join(root, 'task'), returnsDir: join(root, 'returns') }
  mkdirSync(paths.taskDir, { recursive: true }); mkdirSync(paths.returnsDir, { recursive: true })
  let clock = start; let returnPath = null; let envelopeWritten = false
  const logs = []; const events = []
  const member = { ...(surfaceId ? { surface_id: surfaceId } : {}), transport: 'pane', agent: 'claude' }
  const crew = { members: { builder: member } }
  const envelopeReady = () => {
    if (typeof envelopeAt === 'function') {
      try { return envelopeAt(clock) === true } catch { return false }
    }
    return Number.isFinite(envelopeAt) && clock >= envelopeAt
  }
  const deps = {
    now: () => clock,
    sleep: (ms) => {
      clock += ms
      if (!envelopeWritten && returnPath && envelopeReady()) {
        writeFileSync(returnPath, JSON.stringify({ status: 'done' }))
        envelopeWritten = true
      }
    },
    sendLine: (surface, line) => { if (sendLine) sendLine(surface, line, clock) },
    logLine: (_path, row) => logs.push(row),
    tree: () => ({ windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: surfaceId }] }] }] }] }),
    locate: (_tree, id) => id === surfaceId,
    existsSync: (path) => path === returnPath ? envelopeWritten : (typeof path === 'string' && existsSync(path)),
  }
  if (transcriptPaths) deps.transcriptPaths = transcriptPaths
  if (statSync === true) deps.statSync = () => ({ mtimeMs: clock })
  else if (statSync) deps.statSync = (path) => statSync(path, clock)
  if (refusalFrames) deps.refusalFrames = (context) => {
    if (Number.isFinite(transportAt) && clock >= transportAt) member.transport = 'headless-json'
    return refusalFrames(context)
  }
  try {
    const io = seatIo(crew, paths, process.cwd(), null, null, {}, deps)
    io.emit = (event) => events.push(event)
    const assignment = io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    returnPath = assignment.returnPath
    const env = io.wait(returnPath, timeoutS)
    return body({ io, paths, logs, events, env, assignment, clock: () => clock })
  } finally { rmSync(root, { recursive: true, force: true }) }
}

function streamFile(taskDir, runId, mtimeMs) {
  const dir = join(taskDir, 'headless', runId)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'stream.jsonl')
  writeFileSync(path, '{"type":"assistant"}\n')
  const seconds = mtimeMs / 1000
  utimesSync(path, seconds, seconds)
  return path
}

function runHeadlessLiveness({ ticks = [], role = 'builder' } = {}) {
  const root = scratchDir('seat-headless-liveness-')
  const paths = { dir: root, taskDir: join(root, 'task'), returnsDir: join(root, 'returns') }
  mkdirSync(paths.taskDir, { recursive: true }); mkdirSync(paths.returnsDir, { recursive: true })
  const logs = []; const beats = []
  const envelope = { assignment_id: 'd1', role, status: 'done' }
  const transportFactory = ({ deps }) => ({
    assign(spec) {
      const id = spec.reask?.id || 'd1'
      const returnPath = spec.reask?.returnPath || join(paths.returnsDir, `${id}.${role}.json`)
      return { id, returnPath }
    },
    wait() {
      for (const tick of ticks) {
        tick({ paths, taskDir: paths.taskDir })
        deps.sleep(1)
      }
      return envelope
    },
  })
  const emitter = {
    adwId: 'seat-headless-liveness',
    emit: (fn) => fn({ heartbeat: (row) => { beats.push(row); return row }, recordEvent: () => ({}) }, () => 1),
    phaseTransition: () => ({ phase_id: null }),
  }
  const crew = { claude_bin: '/nonexistent/claude', members: { [role]: { transport: HEADLESS_TRANSPORT, agent: 'claude', model: 'test-model' } } }
  let clock = 1_600_000_000_000
  const io = seatIo(crew, paths, root, emitter, null, {}, {
    headlessIo: transportFactory,
    resolveWorkerBin: () => '/nonexistent/claude',
    now: () => { clock += 1_000; return clock },
    sleep: () => {},
    logLine: (_path, row) => logs.push(row),
  })
  const assignment = io.assign({ role, briefFile: join(paths.taskDir, 'brief.md') })
  const returned = io.wait(assignment.returnPath, 30)
  return { paths, logs, beats, returned, envelope, clock }
}

test('a headless seat whose stream exists but never grows records one no-growth observation and no heartbeat', () => {
  const base = 1_700_000_000_000
  const run = runHeadlessLiveness({ ticks: [
    ({ taskDir }) => streamFile(taskDir, 'd1', base),
    () => {},
    () => {},
  ] })
  assert.deepEqual(run.returned, run.envelope)
  const observations = run.logs.filter((row) => row.event === SEAT_LIVENESS_EVENT)
  assert.equal(observations.length, 1)
  assert.equal(observations[0].growth, false)
  assert.equal(Number.isFinite(observations[0].probed_at_ms), true)
  assert.equal(observations[0].latest_ms, base)
  assert.deepEqual(run.beats, [])
})

test('a headless seat with no readable stream records no liveness observation', () => {
  const run = runHeadlessLiveness({ ticks: [() => {}, () => {}, () => {}] })
  assert.deepEqual(run.returned, run.envelope)
  assert.deepEqual(run.logs.filter((row) => row.event === SEAT_LIVENESS_EVENT), [])
  assert.deepEqual(run.beats, [])
})

test('a growing headless seat records the mtime as growth and emits its heartbeat', () => {
  const base = 1_700_100_000_000
  const grown = base + 45_000
  let path = null
  const run = runHeadlessLiveness({ ticks: [
    ({ taskDir }) => { path = streamFile(taskDir, 'd1', base) },
    () => { const seconds = grown / 1000; utimesSync(path, seconds, seconds) },
  ] })
  assert.deepEqual(run.returned, run.envelope)
  const observations = run.logs.filter((row) => row.event === SEAT_LIVENESS_EVENT)
  assert.equal(observations.filter((row) => row.growth === true).length, 1)
  const growth = observations.find((row) => row.growth === true)
  assert.equal(growth.at, new Date(grown).toISOString())
  assert.equal(growth.latest_ms, grown)
  assert.equal(Number.isFinite(growth.probed_at_ms), true)
  assert.deepEqual(run.beats, [{ adw_id: 'seat-headless-liveness', target: 'session', at: grown }])
})

test("a pane seat records no seat-liveness observation", () => {
  withTranscriptSeat({ timeoutS: 30, envelopeAt: 30_000 }, ({ env, logs }) => {
    assert.deepEqual(env, { status: 'done' })
    assert.deepEqual(logs.filter((row) => row.event === SEAT_LIVENESS_EVENT), [])
  })
})

test('waitForEnvelope consumes an envelope written at the deadline and times out after it', () => {
  withTranscriptSeat({ timeoutS: 30, envelopeAt: 30_000 }, ({ env, events }) => {
    assert.deepEqual(env, { status: 'done' })
    assert.equal(events.some((event) => event.kind === 'cell-failure' && event.failure === 'timeout'), false)
  })

  withTranscriptSeat({ timeoutS: 30, envelopeAt: 35_000 }, ({ env, events, assignment }) => {
    assert.equal(env, null)
    assert.equal(events.some((event) => event.kind === 'cell-failure' && event.failure === 'timeout'), true)
    assert.equal(events.some((event) => event.detail?.includes(`no envelope at ${assignment.returnPath}`)), true)
  })
})

test('silenceReaskDecision gates one quiet re-send on measured transcript growth', () => {
  const frameAt = 1_000_000
  assert.equal(SILENCE_REASK_MS, 300_000)
  assert.ok(SILENCE_REASK_MS < TRANSCRIPT_STALE_MS)
  assert.equal(silenceReaskDecision({ frameAt, latest: frameAt, at: frameAt + SILENCE_REASK_MS - 1 }).act, 'wait')
  assert.equal(silenceReaskDecision({ frameAt, latest: frameAt, at: frameAt + SILENCE_REASK_MS }).act, 'reask')
  assert.equal(silenceReaskDecision({ frameAt, latest: frameAt + 1, at: frameAt + SILENCE_REASK_MS }).act, 'none')
  assert.equal(silenceReaskDecision({ frameAt: Number.NaN, latest: null, at: frameAt + SILENCE_REASK_MS }).act, 'none')
  assert.equal(silenceReaskDecision({ frameAt, latest: null, at: frameAt + 1 + SILENCE_REASK_MS, sentAt: frameAt + 1 }).act, 'still-silent')
  assert.equal(silenceReaskDecision({ frameAt, latest: frameAt + 2, at: frameAt + SILENCE_REASK_MS, sentAt: frameAt + 1 }).act, 'revived')
  assert.notEqual(silenceReaskDecision({ frameAt, latest: null, at: frameAt + SILENCE_REASK_MS * 10, sentAt: frameAt + 1 }).act, 'reask')
})

test('an unclassified refusal plus frozen transcript is re-sent exactly once at the quiet threshold', () => {
  let seen = false
  const sends = []
  withTranscriptSeat({
    timeoutS: 600, transcriptPaths: () => ['/x/builder.jsonl'], statSync: () => ({ mtimeMs: 0 }),
    sendLine: (surface, line, at) => sends.push({ surface, line, at }),
    refusalFrames: () => {
      if (seen) return []
      seen = true
      return [{ at: 30_000, member: null, message: 'API Error: Server error mid-response', source: 'claude' }]
    },
  }, ({ logs }) => {
    assert.equal(sends.length, 2)
    assert.equal(sends[1].line, sends[0].line)
    assert.equal(sends[1].at, 30_000 + SILENCE_REASK_MS)
    assert.equal(logs.filter((row) => row.event === 'seat-silence-reask' && row.outcome === 'sent').length, 1)
  })
})

test('a second silence after the bounded re-send is journalled without another re-send', () => {
  let seen = false
  const sends = []
  withTranscriptSeat({
    timeoutS: 700, transcriptPaths: () => ['/x/builder.jsonl'], statSync: () => ({ mtimeMs: 0 }),
    sendLine: (surface, line, at) => sends.push({ surface, line, at }),
    refusalFrames: () => {
      if (seen) return []
      seen = true
      return [{ at: 30_000, member: null, message: 'API Error: Server error mid-response', source: 'claude' }]
    },
  }, ({ logs }) => {
    assert.equal(sends.length, 2)
    assert.equal(logs.filter((row) => row.event === 'seat-silence-reask' && row.outcome === 'sent').length, 1)
    assert.equal(logs.filter((row) => row.event === 'seat-silence-reask' && row.outcome === 'still-silent').length, 1)
  })
})

test('a seat still producing transcript frames is never re-sent', () => {
  let seen = false
  const sends = []
  withTranscriptSeat({
    timeoutS: 600, transcriptPaths: () => ['/x/builder.jsonl'], statSync: true,
    sendLine: (surface, line, at) => sends.push({ surface, line, at }),
    refusalFrames: () => {
      if (seen) return []
      seen = true
      return [{ at: 30_000, member: null, message: 'API Error: Server error mid-response', source: 'claude' }]
    },
  }, ({ logs }) => {
    assert.equal(sends.length, 1)
    assert.equal(logs.filter((row) => row.event === 'seat-silence-reask' && row.outcome === 'growing').length, 1)
    assert.equal(logs.some((row) => row.event === 'seat-silence-reask' && row.outcome === 'sent'), false)
  })
})

test('a revived seat gets a fresh wait budget after the silence re-send', () => {
  let seen = false
  let resentAt = null
  const sends = []
  withTranscriptSeat({
    timeoutS: 2_000, envelopeAt: 2_100_000,
    transcriptPaths: () => ['/x/builder.jsonl'], statSync: (_path, at) => ({ mtimeMs: resentAt !== null && at > resentAt ? at : 0 }),
    sendLine: (surface, line, at) => {
      sends.push({ surface, line, at })
      if (sends.length === 2) resentAt = at
    },
    refusalFrames: () => {
      if (seen) return []
      seen = true
      return [{ at: 30_000, member: null, message: 'API Error: Server error mid-response', source: 'claude' }]
    },
  }, ({ logs, env }) => {
    assert.ok(2_100_000 > 2_000_000)
    assert.deepEqual(env, { status: 'done' })
    assert.equal(sends.length, 2)
    assert.equal(logs.filter((row) => row.event === 'seat-silence-reask' && row.outcome === 'revived').length, 1)
  })
})

test('classified refusal actions remain immediate or journal-only', () => {
  let transientSeen = false
  const transientSends = []
  withTranscriptSeat({
    timeoutS: 35, transcriptPaths: () => ['/x/builder.jsonl'], statSync: () => ({ mtimeMs: 0 }),
    sendLine: (surface, line, at) => transientSends.push({ surface, line, at }),
    refusalFrames: () => {
      if (transientSeen) return []
      transientSeen = true
      return [{ at: 30_000, member: 'transient', message: 'WebSocket error', source: 'claude' }]
    },
  }, ({ logs }) => {
    assert.equal(transientSends.length, 1)
    assert.equal(logs.some((row) => row.event === 'seat-silence-reask'), false)
  })

  let rejectedSeen = false
  const rejectedSends = []
  withTranscriptSeat({
    timeoutS: 35, transcriptPaths: () => ['/x/builder.jsonl'], statSync: () => ({ mtimeMs: 0 }),
    sendLine: (surface, line, at) => rejectedSends.push({ surface, line, at }),
    refusalFrames: () => {
      if (rejectedSeen) return []
      rejectedSeen = true
      return [{ at: 30_000, member: 'rejected', message: 'model not found', source: 'claude' }]
    },
  }, ({ logs }) => {
    assert.equal(rejectedSends.length, 2)
    assert.equal(rejectedSends[1].at, 30_000)
    assert.equal(logs.some((row) => row.event === 'seat-silence-reask'), false)
  })
})

test('silence re-send declines without a surface or on a non-pane transport', () => {
  let noSurfaceSeen = false
  const noSurfaceSends = []
  withTranscriptSeat({
    surfaceId: null, timeoutS: 400, transcriptPaths: () => ['/x/builder.jsonl'], statSync: () => ({ mtimeMs: 0 }),
    sendLine: (surface, line, at) => noSurfaceSends.push({ surface, line, at }),
    refusalFrames: () => {
      if (noSurfaceSeen) return []
      noSurfaceSeen = true
      return [{ at: 30_000, member: null, message: 'API Error: Server error mid-response', source: 'claude' }]
    },
  }, ({ logs }) => {
    assert.equal(noSurfaceSends.length, 1)
    const declined = logs.find((row) => row.event === 'seat-silence-reask' && row.outcome === 'declined')
    assert.equal(declined?.why, 'no surface_id')
  })

  let nonPaneSeen = false
  const nonPaneSends = []
  withTranscriptSeat({
    transportAt: 30_000, timeoutS: 400, transcriptPaths: () => ['/x/builder.jsonl'], statSync: () => ({ mtimeMs: 0 }),
    sendLine: (surface, line, at) => nonPaneSends.push({ surface, line, at }),
    refusalFrames: () => {
      if (nonPaneSeen) return []
      nonPaneSeen = true
      return [{ at: 30_000, member: null, message: 'API Error: Server error mid-response', source: 'claude' }]
    },
  }, ({ logs }) => {
    assert.equal(nonPaneSends.length, 1)
    const declined = logs.find((row) => row.event === 'seat-silence-reask' && row.outcome === 'declined')
    assert.equal(declined?.why, 'transport headless-json is not pane')
  })
})

test('seatIo names a stale pane at expiry and journals one warning', () => {
  withTranscriptSeat({ transcriptPaths: () => ['/x/builder.jsonl'], statSync: () => ({ mtimeMs: 0 }) }, ({ io, logs, events, env, assignment }) => {
    assert.equal(env, null)
    assert.equal(io.waitDiagnosis(assignment.returnPath).state, 'stale')
    assert.ok(events.find((event) => event.kind === 'cell-failure' && /the seat is STALE:/.test(event.detail)))
    assert.equal(logs.filter((row) => row.event === 'seat-stale' && row.role === 'builder').length, 1)
  })
})

test('seatIo names a producing seat working and leaves an unmeasurable seat unnamed', () => {
  withTranscriptSeat({ transcriptPaths: () => ['/x/builder.jsonl'], statSync: true }, ({ io, events, env, assignment }) => {
    assert.equal(env, null)
    assert.equal(io.waitDiagnosis(assignment.returnPath).state, 'working')
    assert.match(events.find((event) => event.kind === 'cell-failure').detail, /the seat is WORKING:/)
  })

  withTranscriptSeat({ transcriptPaths: () => [] }, ({ io, events, env, assignment }) => {
    assert.equal(env, null)
    assert.equal(io.waitDiagnosis(assignment.returnPath), null)
    assert.equal(events.find((event) => event.kind === 'cell-failure').detail, `no envelope at ${assignment.returnPath} within 2000s`)
  })
})

test('seatIo journals exactly one wait extension for a producing seat and none for a stale seat', () => {
  withTranscriptSeat({
    timeoutS: 100, transcriptPaths: () => ['/x/builder.jsonl'],
    statSync: (_path, at) => ({ mtimeMs: at <= 250_000 ? at - 30_000 : -1_000_000 }),
  }, ({ logs, env }) => {
    assert.equal(env, null)
    const rows = logs.filter((row) => row.event === 'wait-extended')
    assert.equal(rows.length, 1)
    assert.deepEqual({ role: rows[0].role, id: rows[0].id, idle_s: rows[0].idle_s, extension_s: rows[0].extension_s, channel: rows[0].channel }, {
      role: 'builder', id: 'd1', idle_s: 40, extension_s: 100, channel: 'operational',
    })
  })

  withTranscriptSeat({
    timeoutS: 100, transcriptPaths: () => ['/x/builder.jsonl'], statSync: () => ({ mtimeMs: -1_000_000 }),
  }, ({ logs, env }) => {
    assert.equal(env, null)
    assert.equal(logs.filter((row) => row.event === 'wait-extended').length, 0)
  })
})

test('seatIo appends the spent extension clause and preserves bare expiry text otherwise', () => {
  const clause = ' (budget extended once by 100s because the seat was working at the first expiry)'
  withTranscriptSeat({
    timeoutS: 100, transcriptPaths: () => ['/x/builder.jsonl'],
    statSync: (_path, at) => ({ mtimeMs: at <= 250_000 ? at - 30_000 : -1_000_000 }),
  }, ({ io, env, assignment }) => {
    assert.equal(env, null)
    const verdict = io.waitDiagnosis(assignment.returnPath)
    const bare = waitState({ role: 'builder', latest: 150_000, refusal: null, at: 200_000, timeoutS: 100, retry: null })
    assert.equal(verdict.text, `${bare.text}${clause}`)
    assert.ok(verdict.text.endsWith(clause))
  })

  withTranscriptSeat({
    timeoutS: 100, transcriptPaths: () => ['/x/builder.jsonl'], statSync: () => ({ mtimeMs: -1_000_000 }),
  }, ({ io, env, assignment }) => {
    assert.equal(env, null)
    const verdict = io.waitDiagnosis(assignment.returnPath)
    const bare = waitState({ role: 'builder', latest: -1_000_000, refusal: null, at: 100_000, timeoutS: 100, retry: null })
    assert.equal(verdict.text, bare.text)
  })
})

test('the shipped Claude transcript address chain measures a real aged transcript', () => {
  const root = scratchDir('seat-shipped-claude-')
  const taskDir = join(root, 'task'); const usageDir = join(taskDir, 'usage'); const transcript = join(root, 'session.jsonl')
  mkdirSync(usageDir, { recursive: true }); writeFileSync(transcript, '{}\n')
  const aged = (Date.now() - 1_000_000) / 1000; utimesSync(transcript, aged, aged)
  writeFileSync(join(usageDir, 'builder.jsonl'), `${JSON.stringify({ session_id: '11111111-1111-4111-8111-111111111111', transcript_path: transcript })}\n`)
  try {
    assert.deepEqual(claudeTranscriptPaths({ taskDir, role: 'builder' }), [transcript])
    assert.deepEqual(claudeTranscriptPaths({ taskDir, role: 'absent' }), [])
    writeFileSync(join(usageDir, 'bad.jsonl'), ['not json', JSON.stringify({ session_id: 'bad', transcript_path: transcript }), JSON.stringify({ session_id: '11111111-1111-4111-8111-111111111111', transcript_path: 'relative.jsonl' })].join('\n') + '\n')
    assert.deepEqual(claudeTranscriptPaths({ taskDir, role: 'bad' }), [])

    const start = Date.now(); const paths = { dir: root, taskDir, returnsDir: join(root, 'returns') }; mkdirSync(paths.returnsDir, { recursive: true })
    let clock = start; let returnPath = null; const events = []
    const io = seatIo({ members: { builder: { surface_id: 'surface-builder', transport: 'pane', agent: 'claude' } } }, paths, process.cwd(), null, null, {}, {
      now: () => clock, sleep: (ms) => { clock += ms }, sendLine: () => {},
      tree: () => ({ windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: 'surface-builder' }] }] }] }] }),
      locate: (_tree, id) => id === 'surface-builder',
      existsSync: (path) => path === returnPath ? false : (typeof path === 'string' && existsSync(path)),
    })
    io.emit = (event) => events.push(event)
    const assignment = io.assign({ role: 'builder', briefFile: '/tmp/brief.md' }); returnPath = assignment.returnPath
    assert.equal(io.wait(returnPath, 31), null)
    const verdict = io.waitDiagnosis(returnPath)
    assert.equal(verdict.state, 'stale'); assert.match(verdict.text, /10\d\ds ago/)
    assert.ok(events.some((event) => event.kind === 'cell-failure' && /the seat is STALE:/.test(event.detail)))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the shipped pi transcript address chain filters only jsonl files and degrades to empty', () => {
  const root = scratchDir('seat-shipped-pi-'); const home = join(root, 'home'); const checkout = '/tmp/pi-checkout'
  const sessions = piSessionDir(checkout, { home }); mkdirSync(sessions, { recursive: true })
  for (const name of ['session.jsonl', 'other.jsonl', 'sleep.log']) writeFileSync(join(sessions, name), '{}\n')
  try {
    const expected = readdirSync(sessions).filter((name) => name.endsWith('.jsonl')).map((name) => join(sessions, name))
    assert.deepEqual(piTranscriptPaths({ checkout, deps: { home } }), expected)
    assert.deepEqual(piTranscriptPaths({ checkout: '/tmp/missing-pi', deps: { home } }), [])
    assert.deepEqual(piTranscriptPaths({ checkout, deps: { home, existsSync: () => true, readdirSync: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) } } }), [])
    assert.deepEqual(piTranscriptPaths({ checkout, deps: { home, existsSync: () => true, readdirSync: () => 'interrupted' } }), [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a journalled transient refusal reaches expiry as evidence, not as the state', () => {
  let sent = false
  withTranscriptSeat({ start: 1_000_000_000_000, transcriptPaths: () => ['/x/builder.jsonl'], statSync: true, refusalFrames: () => {
    if (sent) return []
    sent = true
    return [{ at: 1_000_000_030_000, member: 'transient', message: 'Overloaded', source: 'claude' }]
  } }, ({ io, logs, events, env, assignment }) => {
    assert.equal(env, null)
    const verdict = io.waitDiagnosis(assignment.returnPath)
    assert.equal(verdict.state, 'working')
    assert.doesNotMatch(verdict.text, /REFUSED/)
    const timeout = events.find((event) => event.kind === 'cell-failure' && event.failure === 'timeout')
    assert.ok(timeout); assert.match(timeout.detail, /\[refusal:transient\]/); assert.match(timeout.detail, /the provider says: Overloaded/)
    assert.equal(logs.some((row) => row.event === 'seat-refusal' && row.outcome === 'journalled' && row.member === 'transient'), true)
  })
})

test('a recovered transient followed by a stale transcript remains stale', () => {
  let sent = false
  withTranscriptSeat({
    timeoutS: 61, transcriptPaths: () => ['/x/builder.jsonl'],
    statSync: (_path, at) => ({ mtimeMs: at < 45_000 ? at : at - TRANSCRIPT_STALE_MS }),
    refusalFrames: () => {
      if (sent) return []
      sent = true
      return [{ at: 30_000, member: 'transient', message: 'WebSocket error', source: 'claude' }]
    },
  }, ({ io, events, env, assignment }) => {
    assert.equal(env, null)
    const verdict = io.waitDiagnosis(assignment.returnPath)
    assert.equal(verdict.state, 'stale')
    assert.match(verdict.text, /the seat is STALE:/)
    assert.doesNotMatch(verdict.text, /the seat is WORKING:/)
    assert.equal(events.some((event) => event.kind === 'cell-failure' && /the seat is STALE:/.test(event.detail)), true)
  })
})

test('seatIo commit stages an ALREADY-STAGED deletion beside a modification', () => {
  const fixture = commitRepo('staged-del', ['gone.txt', 'mod.txt'])
  try {
    writeFileSync(join(fixture.root, 'mod.txt'), 'modified\n')
    git(fixture.root, 'rm', '-q', 'gone.txt')
    const sha = fixture.io.commit(['gone.txt', 'mod.txt'], 'retire gone.txt')
    assert.match(sha, /^[0-9a-f]{7,}$/)
    const recorded = git(fixture.root, 'show', '--name-status', '--format=', 'HEAD').trim().split('\n').filter(Boolean).map((line) => line.replace('\t', ' ')).sort()
    assert.deepEqual(recorded, ['D gone.txt', 'M mod.txt'])
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

test('seatIo commit records an UNSTAGED worktree deletion', () => {
  const fixture = commitRepo('unstaged-del', ['gone.txt'])
  try {
    rmSync(join(fixture.root, 'gone.txt'))
    const sha = fixture.io.commit(['gone.txt'], 'retire gone.txt')
    assert.match(sha, /^[0-9a-f]{7,}$/)
    assert.equal(git(fixture.root, 'ls-tree', '--name-only', 'HEAD', '--', 'gone.txt').trim(), '')
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

test('seatIo commit carries an add, a modify and both deletion shapes at once', () => {
  const fixture = commitRepo('mixed', ['mod.txt', 'staged-gone.txt', 'worktree-gone.txt'])
  try {
    writeFileSync(join(fixture.root, 'mod.txt'), 'modified\n')
    writeFileSync(join(fixture.root, 'added.txt'), 'added\n')
    git(fixture.root, 'rm', '-q', 'staged-gone.txt')
    rmSync(join(fixture.root, 'worktree-gone.txt'))
    const scope = ['added.txt', 'mod.txt', 'staged-gone.txt', 'worktree-gone.txt']
    const sha = fixture.io.commit(scope, 'a mixed lane')
    assert.match(sha, /^[0-9a-f]{7,}$/)
    const recorded = git(fixture.root, 'show', '--name-status', '--format=', 'HEAD').trim().split('\n').filter(Boolean).map((line) => line.replace('\t', ' ')).sort()
    assert.deepEqual(recorded, ['A added.txt', 'D staged-gone.txt', 'D worktree-gone.txt', 'M mod.txt'])
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

test('seatIo commit stages nothing outside the lane\'s scope', () => {
  const fixture = commitRepo('fence', ['mod.txt', 'gone.txt', 'oos-dirty.txt', 'oos-gone.txt'])
  try {
    writeFileSync(join(fixture.root, 'mod.txt'), 'modified\n')
    git(fixture.root, 'rm', '-q', 'gone.txt')
    writeFileSync(join(fixture.root, 'oos-dirty.txt'), 'dirtied out of scope\n')
    rmSync(join(fixture.root, 'oos-gone.txt'))
    const sha = fixture.io.commit(['mod.txt', 'gone.txt'], 'the b264 shape')
    assert.match(sha, /^[0-9a-f]{7,}$/)
    const recorded = git(fixture.root, 'show', '--name-status', '--format=', 'HEAD').trim().split('\n').filter(Boolean).map((line) => line.replace('\t', ' ')).sort()
    assert.deepEqual(recorded, ['D gone.txt', 'M mod.txt'])
    const after = git(fixture.root, 'status', '--porcelain', '-uall').split('\n').filter(Boolean).sort()
    assert.deepEqual(after, [' D oos-gone.txt', ' M oos-dirty.txt'])
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

test('seatIo commit still refuses an empty scope with its verbatim message', () => {
  const fixture = commitRepo('empty', ['a.txt'])
  try {
    writeFileSync(join(fixture.root, 'untouched-by-scope.txt'), 'x\n')
    const before = git(fixture.root, 'status', '--porcelain')
    assert.throws(() => fixture.io.commit(['a.txt'], 'nothing here'), (error) => {
      assert.match(error.message, /^commit: nothing in scope actually changed — refusing an empty commit$/)
      return true
    })
    assert.equal(git(fixture.root, 'status', '--porcelain'), before)
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

test('seatIo commit treats a scope of ONLY an already-staged deletion as a real change', () => {
  const fixture = commitRepo('only-del', ['gone.txt', 'other.txt'])
  try {
    git(fixture.root, 'rm', '-q', 'gone.txt')
    const sha = fixture.io.commit(['gone.txt'], 'only a deletion')
    assert.match(sha, /^[0-9a-f]{7,}$/)
    const recorded = git(fixture.root, 'show', '--name-status', '--format=', 'HEAD').trim().split('\n').filter(Boolean).map((line) => line.replace('\t', ' '))
    assert.deepEqual(recorded, ['D gone.txt'])
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

test('seatIo commit skips a planned-but-never-created path', () => {
  const fixture = commitRepo('never-created', ['mod.txt'])
  try {
    writeFileSync(join(fixture.root, 'mod.txt'), 'modified\n')
    const sha = fixture.io.commit(['mod.txt', 'planned/never-created.mjs'], 'a plan that named a file nobody wrote')
    assert.match(sha, /^[0-9a-f]{7,}$/)
    const recorded = git(fixture.root, 'show', '--name-status', '--format=', 'HEAD').trim().split('\n').filter(Boolean).map((line) => line.replace('\t', ' '))
    assert.deepEqual(recorded, ['M mod.txt'])
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

test('a seat waiting through a substrate outage is journalled and recovers', () => {
  const root = scratchDir('substrate-journal-')
  const paths = { dir: root, taskDir: join(root, 'task'), returnsDir: join(root, 'returns') }
  mkdirSync(paths.taskDir, { recursive: true }); mkdirSync(paths.returnsDir, { recursive: true })
  const crew = { members: { builder: { surface_id: 'surface-builder', transport: 'pane' } } }
  let clock = 0
  let returnPath = null
  const journal = []
  const priorBin = process.env.CREW_CLAUDE_BIN
  const restoreBin = () => {
    if (priorBin === undefined) delete process.env.CREW_CLAUDE_BIN
    else process.env.CREW_CLAUDE_BIN = priorBin
  }
  try {
    const io = seatIo(crew, paths, process.cwd(), null, null, {}, {
      now: () => clock,
      sleep: (ms) => { clock += ms },
      tree: () => {
        const probe = Math.round(clock / LIVENESS_PROBE_MS)
        if (probe >= 1 && probe <= 4) throw new Error('pane manager unavailable')
        return { windows: [] }
      },
      locate: () => ({ id: 'surface-builder' }),
      sendLine: () => {},
      assignmentLine: () => 'assignment',
      cmux: () => ({ ok: false, stdout: '' }),
      logLine: (_path, row) => journal.push(row),
      existsSync: (path) => path === returnPath
        ? clock >= 6 * LIVENESS_PROBE_MS
        : existsSync(path),
      readFileSync: (path, ...args) => path === returnPath && clock >= 6 * LIVENESS_PROBE_MS
        ? JSON.stringify({ status: 'done' })
        : readFileSync(path, ...args),
    })
    process.env.CREW_CLAUDE_BIN = process.execPath
    let assignment
    try { assignment = io.assign({ role: 'builder', briefFile: join(root, 'brief.md') }) }
    finally { restoreBin() }
    returnPath = assignment.returnPath
    assert.deepEqual(io.wait(returnPath, 1200), { status: 'done' })
    const down = journal.filter((row) => row?.event === 'seat-substrate-down')
    const recovered = journal.filter((row) => row?.event === 'seat-substrate-recovered')
    assert.equal(down.length, 1)
    assert.equal(down[0].role, 'builder')
    assert.equal(down[0].grace_ms, SUBSTRATE_GRACE_MS)
    assert.equal(recovered.length, 1)
    assert.equal(recovered[0].misses, 4)
    assert.equal(recovered[0].grace_ms, SUBSTRATE_GRACE_MS)
  } finally {
    restoreBin()
    rmSync(root, { recursive: true, force: true })
  }
})

test('pane wait exception still emits exactly one unmeasured suite-policy row', () => {
  withRepo({ dirty: false }, (fixture) => {
    let returnPath = null
    const rows = []
    const malformed = '{"assignment_id":"d1","role":"builder","status":"done","summary":"finished\nthe build"}'
    const io = seatIo({ members: { builder: { surface_id: 'surface-builder', transport: 'pane' } } }, fixture.paths, fixture.repoDir, null, null, {}, {
      sendLine: () => {},
      tree: () => ({ windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: 'surface-builder' }] }] }] }] }),
      locate: () => false,
      existsSync: (path) => path === returnPath,
      readFileSync: (path) => path === returnPath ? malformed : readFileSync(path, 'utf8'),
      logLine: (_path, row) => rows.push(row),
      now: () => 0,
      sleep: () => {},
    })
    const assigned = io.assign({ role: 'builder', briefFile: '/tmp/b416-pane-throw.md' })
    returnPath = assigned.returnPath
    assert.throws(() => io.wait(returnPath, 60), (error) => {
      assert.equal(error.stage, 'pane-parse-error')
      return true
    })
    const policyRows = rows.filter((row) => row.event === SEAT_SUITE_POLICY_EVENT)
    assert.equal(policyRows.length, 1)
    assert.equal(policyRows[0].suite_policy, null)
    assert.equal(policyRows[0].suite_policy_absent, PANE_NO_INTERCEPT)
    assert.equal(policyRows[0].dispatch_id, 'd1')
    assert.equal(Number.isFinite(policyRows[0].at), true)
    assert.equal(policyRows[0].at, 0)
  })
})

test('seatIo changedFiles keeps both sides of a rename', () => {
  const fixture = commitRepo('rename', ['old.txt', 'kept.txt'])
  try {
    git(fixture.root, 'mv', 'old.txt', 'new.txt')
    writeFileSync(join(fixture.root, 'kept.txt'), 'modified\n')
    const changed = fixture.io.changedFiles()
    assert.ok(changed.includes('new.txt'))
    assert.ok(changed.includes('old.txt'))
    assert.ok(changed.includes('kept.txt'))
    assert.equal(changed.length, 3)
    assert.equal(changed.indexOf('old.txt'), changed.indexOf('new.txt') + 1)
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

test('b416 F2 seat-io keeps suite policy on every headless timeout/abort re-ask', () => {
  const policy = { suiteCommand: 'npm test', gatePath: '/tmp/b416/gate.mjs', fence: ['crew/headless.mjs'] }
  for (const [transport, stage] of [[HEADLESS_TRANSPORT, 'headless-timeout'], [HEADLESS_RPC_TRANSPORT, 'rpc-aborted']]) {
    const harness = makeTransportReaskHarness({
      transport, policy,
      waits: [() => { throw stagedReaskFailure(stage, 'first transport lost') }, () => JSON.parse(VALID_REASK)],
    })
    try {
      assert.deepEqual(harness.io.wait(harness.first.returnPath, 37), JSON.parse(VALID_REASK))
      assert.equal(harness.assigns.length, 2)
      assert.deepEqual(harness.assigns[0].policy, policy)
      assert.deepEqual(harness.assigns[1].policy, policy)
      assert.equal(harness.assigns[1].reask.id, harness.first.id)
    } finally { harness.cleanup() }
  }
})

test('b416 D1 pane policy reports a strict unmeasured shape exactly once on an ordinary pane dispatch', () => {
  const pure = paneSeatPolicyRow({ role: 'builder', id: 'd1' })
  assert.equal(pure.event, SEAT_SUITE_POLICY_EVENT)
  assert.equal(pure.id, 'd1')
  assert.equal(pure.dispatch_id, 'd1')
  assert.equal(Number.isFinite(pure.at), true)
  assert.equal(pure.suite_policy, null)
  assert.equal(pure.suite_policy_absent, PANE_NO_INTERCEPT)

  withRepo({ dirty: false }, (fixture) => {
    const rows = []; let returnPath = null
    const envelope = { assignment_id: 'd1', role: 'builder', status: 'done', artifacts: [], details: {} }
    const io = seatIo({ members: { builder: { transport: 'pane', surface_id: 'surface-builder' } } }, fixture.paths, fixture.repoDir, null, null, {}, {
      sendLine: () => {}, tree: () => ({ windows: [] }), locate: () => ({ id: 'surface-builder' }),
      existsSync: (path) => path === returnPath || existsSync(path),
      readFileSync: (path, ...args) => path === returnPath ? JSON.stringify(envelope) : readFileSync(path, ...args),
      logLine: (_path, row) => rows.push(row), now: () => 0, sleep: () => {},
    })
    const assigned = io.assign({ role: 'builder', briefFile: '/tmp/b416-pane.md' })
    returnPath = assigned.returnPath
    assert.deepEqual(io.wait(returnPath, 60), envelope)
    const policyRows = rows.filter((row) => row.event === SEAT_SUITE_POLICY_EVENT)
    assert.equal(policyRows.length, 1)
    assert.equal(policyRows[0].suite_policy, null)
    assert.equal(policyRows[0].suite_policy_absent, PANE_NO_INTERCEPT)
  })
})

// Hardened guards for the b1124 review findings, one named test per must-fix.
// Mutation RV1-1: js-tokens.mjs treating a name after `.`/`?.` as a keyword hides the
// issue 1729 sink behind a property call.
test('RV1-1 a property named like a keyword never opens a regex', () => {
  assert.throws(() => seatJournalSites('const v = obj.if(k1) / log(row)'), /line\(s\) 1/)
  assert.throws(() => seatJournalSites('const v = obj?.while(k1) / logLine(p, row)'), /line\(s\) 1/)
  // A keyword-named property with no call (property flag) and a keyword-named method call (paren-head
  // guard), each followed by a closing slash so a misread regex would actually terminate.
  assert.throws(() => seatJournalSites('const v = x.return / log(row) / 2'), /line\(s\) 1/)
  assert.throws(() => seatJournalSites('const v = obj.if(k1) / log(row) / 2'), /line\(s\) 1/)
})
// Mutation RV1-2: counting a string-held `io.log` name as an exemption hides the real sink.
test('RV1-2 a sink name inside a string never discounts a real seat sink', () => {
  assert.throws(() => seatJournalSites('const s = "log: io.log, y"; log(row)'), /line\(s\) 1/)
})
// Mutation RV1-3: counting template-text parens in the depth walk loses the call nesting.
test('RV1-3 template text parentheses never shift the drive sink depth walk', () => {
  assert.deepEqual(noncanonicalJournalSinks('f(io.log(recordRow({ s: `${a}(${b}` }), extra))'), [{ line: 1, form: 'io.log' }])
  assert.deepEqual(noncanonicalJournalSinks('io.log(recordRow({ sig: `${fn}(${args})` }))'), [])
})
// Mutation RV1-4: matching sink text that is not an executable name token inventories a ghost emit.
test('RV1-4 a sink spelled inside a string literal is never an inventoried emit', () => {
  assert.deepEqual(driveJournalSites("const s = \"io.log(recordRow({ at: 'ghost' }))\""), [])
  assert.deepEqual(noncanonicalJournalSinks("const s = \"io.log(recordRow({ at: 'ghost' }))\""), [])
})
