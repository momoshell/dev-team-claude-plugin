#!/usr/bin/env node
// Per-task cost readout for a custom Claude Code statusLine.
//
// Claude Code's own $ figure (cost.total_cost_usd, and the bottom-bar $
// shown by default) is scoped to the whole terminal session — it does not
// reset on /clear, only on relaunch (see README § Per-task cost). This
// script computes cost since the *last* /clear instead, by summing the main
// transcript's own token usage (not subagents — same scope as the built-in
// figure) from the timestamp a companion SessionStart(matcher:"clear") hook
// records, to now.
//
// Wire-up: this is not auto-installed — add it to your own `statusLine`
// command in settings.json. See README § Per-task cost for the hook entry
// and an example statusLine script.
//
// usage: node task-cost.mjs   (reads the statusline JSON payload on stdin,
//                              per https://code.claude.com/docs/en/statusline)
// Prints a bare "$X.XX" to stdout. Prints nothing and exits 0 on any
// missing/unreadable input — a broken cost readout should never blank a
// user's statusline.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// $/MTok. Multipliers for cache write (5m = 1.25x, 1h = 2x) and cache read
// (0.1x) are applied to the base input price, per shared/prompt-caching.md.
const PRICING = {
  'claude-opus-4-8': { in: 5.00, out: 25.00 },
  'claude-opus-4-7': { in: 5.00, out: 25.00 },
  'claude-opus-4-6': { in: 5.00, out: 25.00 },
  'claude-sonnet-5': { in: 3.00, out: 15.00, introUntil: '2026-09-01T00:00:00Z', introIn: 2.00, introOut: 10.00 },
  'claude-sonnet-4-6': { in: 3.00, out: 15.00 },
  'claude-haiku-4-5': { in: 1.00, out: 5.00 },
  'claude-haiku-4-5-20251001': { in: 1.00, out: 5.00 },
  'claude-fable-5': { in: 10.00, out: 50.00 },
  'claude-mythos-5': { in: 10.00, out: 50.00 },
}

function priceFor(model, atISO) {
  const p = PRICING[model]
  if (!p) return null
  if (p.introUntil && atISO < p.introUntil) return { in: p.introIn, out: p.introOut }
  return { in: p.in, out: p.out }
}

function readStateSince(sessionId) {
  const stateFile = join(homedir(), '.claude', 'dev-team', 'task-cost', `${sessionId}.json`)
  if (!existsSync(stateFile)) return null
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    return typeof state.since === 'string' ? state.since : null
  } catch {
    return null
  }
}

function costSince(transcriptPath, sinceISO) {
  if (!existsSync(transcriptPath)) return null
  let total = 0
  const lines = readFileSync(transcriptPath, 'utf8').split('\n')
  for (const line of lines) {
    if (!line) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.type !== 'assistant' || entry.isSidechain !== false) continue
    if (sinceISO && (typeof entry.timestamp !== 'string' || entry.timestamp < sinceISO)) continue
    const usage = entry.message?.usage
    const model = entry.message?.model
    if (!usage || !model) continue
    const price = priceFor(model, entry.timestamp || '')
    if (!price) continue
    const cacheCreation = usage.cache_creation || {}
    const write5m = cacheCreation.ephemeral_5m_input_tokens ?? usage.cache_creation_input_tokens ?? 0
    const write1h = cacheCreation.ephemeral_1h_input_tokens ?? 0
    const read = usage.cache_read_input_tokens ?? 0
    const cost =
      (usage.input_tokens ?? 0) * price.in +
      (usage.output_tokens ?? 0) * price.out +
      write5m * price.in * 1.25 +
      write1h * price.in * 2 +
      read * price.in * 0.1
    total += cost / 1_000_000
  }
  return total
}

let raw = ''
try {
  raw = readFileSync(0, 'utf8')
} catch {
  process.exit(0)
}

let payload
try {
  payload = JSON.parse(raw)
} catch {
  process.exit(0)
}

const sessionId = payload.session_id
const transcriptPath = payload.transcript_path
if (!sessionId || !transcriptPath) process.exit(0)

const since = readStateSince(sessionId)
const total = costSince(transcriptPath, since)
if (total === null) process.exit(0)

process.stdout.write(`$${total.toFixed(2)}`)
