// scripts/task-cost-log.mjs — per-task cost ledger, exercised against
// fixture transcripts, a fake $HOME, and a fake ~/.claude/projects layout
// (no live model, no live cmux). Mirrors test/task-cost.test.mjs's fixture
// style without duplicating its coverage: this file's job is the
// subagent-inclusive walk, dedup, fail-soft, refusal and log-append
// behaviour that task-cost.mjs's own statusline tests don't exercise.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT } from './helpers.mjs'

const SCRIPT = join(ROOT, 'scripts', 'task-cost-log.mjs')

const fixture = mkdtempSync(join(tmpdir(), 'task-cost-log-'))
const fakeHome = join(fixture, 'home')
mkdirSync(join(fakeHome, '.claude', 'dev-team', 'task-cost'), { recursive: true })
mkdirSync(join(fakeHome, '.claude', 'projects'), { recursive: true })
process.on('exit', () => rmSync(fixture, { recursive: true, force: true }))

let n = 0
function nextSessionId() {
  n += 1
  return `11111111-1111-1111-1111-${String(n).padStart(12, '0')}`
}

// Sets up ~/.claude/projects/<projectDirName>/<sessionId>.jsonl plus, when
// `subagents` is given, .../<sessionId>/subagents/<name>.jsonl sidecars.
// Returns { sessionId, projectDir, sessionDir }.
function writeSession(sessionId, { projectDirName = 'proj', mainLines = [], subagents = null } = {}) {
  const projectDir = join(fakeHome, '.claude', 'projects', projectDirName)
  mkdirSync(projectDir, { recursive: true })
  const transcript = join(projectDir, `${sessionId}.jsonl`)
  writeFileSync(transcript, linesToJsonl(mainLines))
  const sessionDir = join(projectDir, sessionId)
  if (subagents) {
    const subagentsDir = join(sessionDir, 'subagents')
    mkdirSync(subagentsDir, { recursive: true })
    for (const [name, lines] of Object.entries(subagents)) {
      writeFileSync(join(subagentsDir, `${name}.jsonl`), linesToJsonl(lines))
    }
  }
  return { sessionId, projectDir, sessionDir }
}

function linesToJsonl(lines) {
  if (lines.length === 0) return ''
  return lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'
}

function writeSince(sessionId, since) {
  writeFileSync(join(fakeHome, '.claude', 'dev-team', 'task-cost', `${sessionId}.json`), JSON.stringify({ since }))
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: fakeHome, CLAUDE_CODE_SESSION_ID: '', ...env },
  })
}

function logPath() {
  return join(fakeHome, '.claude', 'dev-team', 'task-cost', 'log.jsonl')
}

function lastLogRecord() {
  const content = readFileSync(logPath(), 'utf8')
  const lines = content.split('\n').filter(Boolean)
  return JSON.parse(lines[lines.length - 1])
}

const assistantEntry = (overrides) => ({
  type: 'assistant',
  timestamp: '2026-07-11T12:00:00Z',
  message: { id: `msg-${Math.random()}`, model: 'claude-sonnet-5', usage: { input_tokens: 0, output_tokens: 0 } },
  ...overrides,
})

test('task-cost-log.mjs parses (node --check)', () => {
  const r = spawnSync(process.execPath, ['--check', SCRIPT], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
})

test('importing the module performs no I/O and consumes no stdin', async () => {
  await import(join(ROOT, 'scripts', 'task-cost-log.mjs'))
})

test('task-cost.mjs exports the shared library surface with no I/O on import', async () => {
  const mod = await import(join(ROOT, 'scripts', 'task-cost.mjs'))
  assert.equal(typeof mod.PRICING, 'object')
  assert.equal(typeof mod.priceFor, 'function')
  assert.equal(typeof mod.costSince, 'function')
  assert.equal(typeof mod.readStateSince, 'function')
})

test('DEDUP: a message split across three streamed lines is counted once, at its final usage', () => {
  const sessionId = nextSessionId()
  writeSession(sessionId, {
    mainLines: [
      assistantEntry({ message: { id: 'msg-stream', model: 'claude-sonnet-5', usage: { input_tokens: 0, output_tokens: 5 } } }),
      assistantEntry({ message: { id: 'msg-stream', model: 'claude-sonnet-5', usage: { input_tokens: 0, output_tokens: 5 } } }),
      assistantEntry({ message: { id: 'msg-stream', model: 'claude-sonnet-5', usage: { input_tokens: 0, output_tokens: 400 } } }),
    ],
  })
  const r = run([], { CLAUDE_CODE_SESSION_ID: sessionId })
  assert.equal(r.status, 0, r.stderr)
  const record = lastLogRecord()
  // intro sonnet-5 out price $10/MTok (fixture timestamp is before the
  // 2026-09-01 intro-window expiry): 400 * 10 / 1e6 = 0.004, NOT
  // (5+5+400) * 10 / 1e6 = 0.0042 (what a naive per-line sum would give).
  assert.equal(record.orchestrator_usd, 0.004)
})

test('SUBAGENT INCLUSION: orchestrator + two sidecar files sum correctly, split by source', () => {
  const sessionId = nextSessionId()
  writeSession(sessionId, {
    mainLines: [
      assistantEntry({ message: { id: 'orch-1', model: 'claude-sonnet-5', usage: { input_tokens: 1_000_000, output_tokens: 0 } } }),
    ],
    subagents: {
      'agent-a': [
        assistantEntry({ message: { id: 'sub-a-1', model: 'claude-opus-4-8', usage: { input_tokens: 0, output_tokens: 1_000_000 } } }),
      ],
      'agent-b': [
        assistantEntry({ message: { id: 'sub-b-1', model: 'claude-opus-4-8', usage: { input_tokens: 0, output_tokens: 1_000_000 } } }),
      ],
    },
  })
  const r = run([], { CLAUDE_CODE_SESSION_ID: sessionId })
  assert.equal(r.status, 0, r.stderr)
  const record = lastLogRecord()
  assert.equal(record.orchestrator_usd, 2) // 1M in @ $2/MTok (intro-window sonnet-5)
  assert.equal(record.subagent_usd, 50) // 2 * 1M out @ $25/MTok
  assert.equal(record.total_usd, 52)
  assert.equal(record.subagent_count, 2)
  assert.equal(record.subagent_cost_unavailable, false)
})

test('SIDECHAIN: isSidechain:true sidecar entries are still counted', () => {
  const sessionId = nextSessionId()
  writeSession(sessionId, {
    mainLines: [],
    subagents: {
      'agent-a': [
        assistantEntry({ isSidechain: true, message: { id: 'sub-sc-1', model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000, output_tokens: 0 } } }),
      ],
    },
  })
  const r = run([], { CLAUDE_CODE_SESSION_ID: sessionId })
  assert.equal(r.status, 0, r.stderr)
  const record = lastLogRecord()
  assert.ok(record.subagent_usd > 0)
})

test('SINCE MARKER: excludes entries before the marker in both main and sidecar transcripts, echoes since', () => {
  const sessionId = nextSessionId()
  writeSession(sessionId, {
    mainLines: [
      assistantEntry({ timestamp: '2026-07-11T11:00:00Z', message: { id: 'orch-before', model: 'claude-sonnet-5', usage: { input_tokens: 1_000_000, output_tokens: 0 } } }),
      assistantEntry({ timestamp: '2026-07-11T12:00:00Z', message: { id: 'orch-after', model: 'claude-sonnet-5', usage: { input_tokens: 1_000_000, output_tokens: 0 } } }),
    ],
    subagents: {
      'agent-a': [
        assistantEntry({ timestamp: '2026-07-11T11:00:00Z', message: { id: 'sub-before', model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000, output_tokens: 0 } } }),
      ],
    },
  })
  writeSince(sessionId, '2026-07-11T12:00:00Z')
  const r = run([], { CLAUDE_CODE_SESSION_ID: sessionId })
  assert.equal(r.status, 0, r.stderr)
  const record = lastLogRecord()
  assert.equal(record.since, '2026-07-11T12:00:00Z')
  assert.equal(record.orchestrator_usd, 2) // only the post-marker entry
  assert.equal(record.subagent_usd, 0) // the sidecar entry is before the marker
  assert.equal(record.subagent_count, 0)
})

test('no since marker -> whole transcript, since: null', () => {
  const sessionId = nextSessionId()
  writeSession(sessionId, {
    mainLines: [
      assistantEntry({ message: { id: 'orch-1', model: 'claude-sonnet-5', usage: { input_tokens: 1_000_000, output_tokens: 0 } } }),
    ],
  })
  const r = run([], { CLAUDE_CODE_SESSION_ID: sessionId })
  assert.equal(r.status, 0, r.stderr)
  const record = lastLogRecord()
  assert.equal(record.since, null)
})

test('FAIL SOFT: subagents dir absent -> unavailable true, orchestrator cost still correct, exit 0', () => {
  const sessionId = nextSessionId()
  writeSession(sessionId, {
    mainLines: [
      assistantEntry({ message: { id: 'orch-1', model: 'claude-sonnet-5', usage: { input_tokens: 1_000_000, output_tokens: 0 } } }),
    ],
  })
  const r = run([], { CLAUDE_CODE_SESSION_ID: sessionId })
  assert.equal(r.status, 0, r.stderr)
  const record = lastLogRecord()
  assert.equal(record.subagent_cost_unavailable, true)
  assert.equal(record.subagent_usd, 0)
  assert.equal(record.subagent_count, 0)
  assert.equal(record.orchestrator_usd, 2)
})

test('subagents dir present but empty -> unavailable false, count 0 (genuine zero)', () => {
  const sessionId = nextSessionId()
  const { sessionDir } = writeSession(sessionId, { mainLines: [] })
  mkdirSync(join(sessionDir, 'subagents'), { recursive: true })
  const r = run([], { CLAUDE_CODE_SESSION_ID: sessionId })
  assert.equal(r.status, 0, r.stderr)
  const record = lastLogRecord()
  assert.equal(record.subagent_cost_unavailable, false)
  assert.equal(record.subagent_count, 0)
})

test('REFUSAL: no session id anywhere -> exit 2, stderr names both --session-id and the env var', () => {
  const before = existsSync(logPath()) ? readFileSync(logPath(), 'utf8') : null
  const r = run([], { CLAUDE_CODE_SESSION_ID: '' })
  assert.equal(r.status, 2, r.stdout)
  assert.match(r.stderr, /--session-id/)
  assert.match(r.stderr, /CLAUDE_CODE_SESSION_ID/)
  assert.match(r.stderr, /session_id_unavailable/)
  const after = existsSync(logPath()) ? readFileSync(logPath(), 'utf8') : null
  assert.equal(after, before, 'nothing appended on refusal')
})

test('REFUSAL: unmatched session id -> exit 2, transcript_not_found, nothing appended', () => {
  const before = readFileSync(logPath(), 'utf8')
  const r = run(['--session-id', 'no-such-session'])
  assert.equal(r.status, 2, r.stdout)
  assert.match(r.stderr, /transcript_not_found/)
  assert.equal(readFileSync(logPath(), 'utf8'), before)
})

test('REFUSAL: ambiguous transcript across two project dirs -> exit 2, names both, nothing appended', () => {
  const sessionId = nextSessionId()
  writeSession(sessionId, { projectDirName: 'proj-one', mainLines: [] })
  writeSession(sessionId, { projectDirName: 'proj-two', mainLines: [] })
  const before = readFileSync(logPath(), 'utf8')
  const r = run(['--session-id', sessionId])
  assert.equal(r.status, 2, r.stdout)
  assert.match(r.stderr, /ambiguous_session_transcript/)
  assert.match(r.stderr, /proj-one/)
  assert.match(r.stderr, /proj-two/)
  assert.equal(readFileSync(logPath(), 'utf8'), before)
})

test('UNPRICED MODELS ARE VISIBLE: an unknown model contributes $0 but increments unpriced_messages', () => {
  const sessionId = nextSessionId()
  writeSession(sessionId, {
    mainLines: [
      assistantEntry({ message: { id: 'orch-known', model: 'claude-sonnet-5', usage: { input_tokens: 1_000_000, output_tokens: 0 } } }),
      assistantEntry({ message: { id: 'orch-unknown', model: 'claude-totally-made-up', usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } } }),
    ],
  })
  const r = run([], { CLAUDE_CODE_SESSION_ID: sessionId })
  assert.equal(r.status, 0, r.stderr)
  const record = lastLogRecord()
  assert.equal(record.unpriced_messages, 1)
  assert.equal(record.orchestrator_usd, 2)
})

test('LOG LINE: exact frozen key set, trailing newline, append-only across two runs', () => {
  const sessionId = nextSessionId()
  writeSession(sessionId, {
    mainLines: [
      assistantEntry({ message: { id: 'orch-1', model: 'claude-sonnet-5', usage: { input_tokens: 0, output_tokens: 0 } } }),
    ],
  })
  const before = readFileSync(logPath(), 'utf8')
  const beforeLines = before.split('\n').filter(Boolean).length

  const r1 = run(['--tier', '2', '--gate-depth', 'standard', '--task', '#99'], { CLAUDE_CODE_SESSION_ID: sessionId })
  assert.equal(r1.status, 0, r1.stderr)

  const afterOne = readFileSync(logPath(), 'utf8')
  assert.equal(afterOne.endsWith('\n'), true)
  assert.equal(afterOne.split('\n').filter(Boolean).length, beforeLines + 1)

  const record = lastLogRecord()
  assert.deepEqual(
    Object.keys(record).sort(),
    [
      'cwd', 'gate_depth', 'orchestrator_usd', 'schema', 'session_id', 'since',
      'subagent_cost_unavailable', 'subagent_count', 'subagent_usd', 'task',
      'tier', 'total_usd', 'ts', 'unpriced_messages', 'unverified',
    ].sort(),
  )
  assert.equal(record.task, '#99')
  assert.equal(record.tier, '2')
  assert.equal(record.gate_depth, 'standard')
  assert.deepEqual(record.unverified, ['task', 'tier', 'gate_depth'])

  const r2 = run(['--task', '#99'], { CLAUDE_CODE_SESSION_ID: sessionId })
  assert.equal(r2.status, 0, r2.stderr)
  const afterTwo = readFileSync(logPath(), 'utf8')
  assert.equal(afterTwo.split('\n').filter(Boolean).length, beforeLines + 2)
})

test('--session-id flag overrides the env default', () => {
  const sessionId = nextSessionId()
  writeSession(sessionId, {
    mainLines: [
      assistantEntry({ message: { id: 'orch-1', model: 'claude-sonnet-5', usage: { input_tokens: 0, output_tokens: 0 } } }),
    ],
  })
  const r = run(['--session-id', sessionId], { CLAUDE_CODE_SESSION_ID: 'wrong-session' })
  assert.equal(r.status, 0, r.stderr)
  const record = lastLogRecord()
  assert.equal(record.session_id, sessionId)
})
