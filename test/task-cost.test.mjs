// scripts/task-cost.mjs — per-task cost readout for a custom statusLine,
// exercised against fixture transcripts and a fake $HOME (no live model).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT } from './helpers.mjs'

const SCRIPT = join(ROOT, 'scripts', 'task-cost.mjs')

const fixture = mkdtempSync(join(tmpdir(), 'task-cost-'))
const fakeHome = join(fixture, 'home')
mkdirSync(join(fakeHome, '.claude', 'dev-team', 'task-cost'), { recursive: true })
process.on('exit', () => rmSync(fixture, { recursive: true, force: true }))

let n = 0
function writeTranscript(lines) {
  const p = join(fixture, `transcript-${n++}.jsonl`)
  writeFileSync(p, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n')
  return p
}

function writeSince(sessionId, since) {
  writeFileSync(join(fakeHome, '.claude', 'dev-team', 'task-cost', `${sessionId}.json`), JSON.stringify({ since }))
}

function run(payload, env = {}) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    input: JSON.stringify(payload),
    env: { ...process.env, HOME: fakeHome, ...env },
  })
}

const assistantEntry = (overrides) => ({
  type: 'assistant',
  isSidechain: false,
  timestamp: '2026-07-11T12:00:00Z',
  message: { model: 'claude-sonnet-5', usage: { input_tokens: 0, output_tokens: 0 } },
  ...overrides,
})

test('task-cost.mjs parses (node --check)', () => {
  const r = spawnSync(process.execPath, ['--check', SCRIPT], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
})

test('sums only entries at/after the since marker, in $', () => {
  const transcript = writeTranscript([
    assistantEntry({ timestamp: '2026-07-11T11:00:00Z', message: { model: 'claude-sonnet-5', usage: { input_tokens: 1_000_000, output_tokens: 0 } } }), // before since — excluded
    assistantEntry({ timestamp: '2026-07-11T12:00:00Z', message: { model: 'claude-sonnet-5', usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } } }), // at since — included
  ])
  const sessionId = `sess-${n}`
  writeSince(sessionId, '2026-07-11T12:00:00Z')
  const r = run({ session_id: sessionId, transcript_path: transcript })
  assert.equal(r.status, 0, r.stderr)
  // intro Sonnet 5 pricing on this date: $2/MTok in + $10/MTok out = $12.00
  assert.equal(r.stdout, '$12.00')
})

test('no since marker falls back to the whole transcript', () => {
  const transcript = writeTranscript([
    assistantEntry({ timestamp: '2026-07-11T09:00:00Z', message: { model: 'claude-sonnet-5', usage: { input_tokens: 1_000_000, output_tokens: 0 } } }),
    assistantEntry({ timestamp: '2026-07-11T10:00:00Z', message: { model: 'claude-sonnet-5', usage: { input_tokens: 1_000_000, output_tokens: 0 } } }),
  ])
  const r = run({ session_id: `sess-${n}`, transcript_path: transcript })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, '$4.00') // two $2/MTok(intro) input-only entries
})

test('sidechain (subagent) entries are excluded, matching the built-in $ figure scope', () => {
  const transcript = writeTranscript([
    assistantEntry({ isSidechain: true, message: { model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } } }),
  ])
  const r = run({ session_id: `sess-${n}`, transcript_path: transcript })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, '$0.00')
})

test('cache write/read tokens are priced with the documented multipliers', () => {
  const transcript = writeTranscript([
    assistantEntry({
      message: {
        model: 'claude-opus-4-8',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
          cache_read_input_tokens: 1_000_000,
        },
      },
    }),
  ])
  const r = run({ session_id: `sess-${n}`, transcript_path: transcript })
  assert.equal(r.status, 0, r.stderr)
  // opus 4.8 input $5/MTok: 5m write = 1M*5*1.25=6.25, 1h write = 1M*5*2=10.00, read = 1M*5*0.1=0.50 -> 16.75
  assert.equal(r.stdout, '$16.75')
})

test('malformed lines and non-assistant entries are skipped without error', () => {
  const transcript = writeTranscript([
    'not valid json',
    { type: 'user', isSidechain: false, timestamp: '2026-07-11T12:00:00Z' },
    assistantEntry({ message: { model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 1_000_000, output_tokens: 0 } } }),
  ])
  const r = run({ session_id: `sess-${n}`, transcript_path: transcript })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, '$1.00')
})

test('unknown model is skipped rather than crashing', () => {
  const transcript = writeTranscript([
    assistantEntry({ message: { model: 'claude-totally-made-up', usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } } }),
  ])
  const r = run({ session_id: `sess-${n}`, transcript_path: transcript })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, '$0.00')
})

test('missing transcript_path/session_id exits 0 with no output', () => {
  const r = run({ session_id: 'sess-x' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, '')
})

test('nonexistent transcript file exits 0 with no output', () => {
  const r = run({ session_id: 'sess-y', transcript_path: join(fixture, 'does-not-exist.jsonl') })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, '')
})

test('garbage stdin exits 0 with no output', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', input: 'not json', env: { ...process.env, HOME: fakeHome } })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, '')
})

test('post-intro-window Sonnet 5 pricing uses the standard rate', () => {
  const transcript = writeTranscript([
    assistantEntry({ timestamp: '2026-09-02T00:00:00Z', message: { model: 'claude-sonnet-5', usage: { input_tokens: 1_000_000, output_tokens: 0 } } }),
  ])
  const r = run({ session_id: `sess-${n}`, transcript_path: transcript })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, '$3.00') // standard $3/MTok, not the $2 intro rate
})
