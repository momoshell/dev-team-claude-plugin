#!/usr/bin/env node
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createFeed } from './feed.mjs'
import { createReturnsSource } from './returns-source.mjs'
import { createRosterSource } from './roster-source.mjs'
import { proposeEdit } from './roster-edit.mjs'
import { readLadder, readReference, ladderView, stageMoves, composeMoves } from './roster-ladder.mjs'
import { breakerPolicy } from '../../crew/breaker.mjs'
import { openLedger } from '../../scripts/factory/ledger.mjs'
import { defaultCellWindow, defaultRunSetWindow, defaultIntakeWindow, defaultTeardownWindow, RUN_SET_WINDOW_MS, shapeCellHealth, shapeRunSet, shapeIntake, shapeSeatTeardowns } from './shape.mjs'

// Mirrored from the intake loop's contract without importing that module: this
// server must not acquire the loop's process-spawning dependency graph.
export const STOP_SWITCH_PATH = '.factory/STOP'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = resolve(ROOT, 'web', 'dist')
const schema = 1

function defaults() {
  const dir = process.env.DEVTEAM_LEDGER_DIR || join(homedir(), '.dev-team', 'factory')
  return { port: Number(process.env.DEVTEAM_VIZ_PORT) || 4488, host: '127.0.0.1', ledgerDb: process.env.DEVTEAM_LEDGER_DB || join(dir, 'ledger.db'), triageDb: undefined, crewRoot: process.env.DEVTEAM_CREW_ROOT || join(homedir(), '.crew'), checkout: resolve(process.env.DEVTEAM_INTAKE_CHECKOUT || process.cwd()), rosterPath: process.env.DEVTEAM_ROSTER_PATH || undefined, ladderPath: process.env.DEVTEAM_LADDER_PATH || undefined, referencePath: process.env.DEVTEAM_MODEL_REFERENCE || join(dir, 'model-reference.json') }
}
// A refusal cause, tagged so the CLI guard can map it to exit 2 without
// conflating it with an unexpected internal throw (mapped to 1). Exit codes
// match the scripts/factory convention (make-brief.mjs:9-12): 0 ok,
// 1 unexpected internal error, 2 usage/refusal.
export class ServerUsageError extends Error {
  constructor(message) { super(`viz-serve: ${message}`); this.name = 'ServerUsageError'; this.usage = true }
}

// The flags this CLI reads, mapped to their config keys. This is the one place
// that decides whether the CLI knows a flag: a misspelled flag is a usage
// refusal (exit 2), not a silently ignored default (#443).
const CLI_FLAGS = Object.freeze({
  '--port': 'port',
  '--host': 'host',
  '--ledger-db': 'ledgerDb',
  '--triage-db': 'triageDb',
  '--crew-root': 'crewRoot',
  '--checkout': 'checkout',
  '--roster': 'rosterPath',
  '--ladder': 'ladderPath',
  '--model-reference': 'referencePath',
})

export function parseCliArgs(argv) {
  const out = defaults()
  const vocabulary = Object.keys(CLI_FLAGS).join(', ')
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new ServerUsageError(`unexpected argument ${arg} — this CLI reads flags only: ${vocabulary}`)
    const key = CLI_FLAGS[arg]
    if (!key) throw new ServerUsageError(`unknown flag ${arg} — it accepts ${vocabulary}`)
    const value = argv[i + 1]
    i += 1
    if (value === undefined || value.startsWith('--')) throw new ServerUsageError(`${arg} requires a value`)
    if (arg === '--port') {
      if (!/^\d+$/.test(value) || Number(value) > 65535) throw new ServerUsageError(`${arg} must be an integer between 0 and 65535, found ${value}`)
      out.port = Number(value)
    } else {
      if (value === '') throw new ServerUsageError(`${arg} requires a non-empty value`)
      out[key] = value
    }
  }
  return out
}
function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}
function integer(value, fallback) {
  if (value == null || value === '') return fallback
  if (!/^\d+$/.test(value)) return null
  return Number(value)
}

function readBrake(config) {
  const path = join(config.checkout, STOP_SWITCH_PATH)
  try {
    const engaged = existsSync(path)
    return { schema, state: engaged ? 'engaged' : 'clear', measured: true, path, checkout: config.checkout, read_error: null, readonly: false }
  } catch (err) {
    const message = `${path}: ${err?.message || String(err)}`
    return { schema, state: null, measured: false, path, checkout: config.checkout, read_error: message, readonly: false }
  }
}

function recordBrake(config, args) {
  let ledger = null
  try {
    ledger = openLedger({ dbPath: config.ledgerDb })
    ledger.recordIntakeBrake(args)
    return { recorded: true, record_error: null }
  } catch (err) {
    return { recorded: false, record_error: err?.message || String(err) }
  } finally {
    try { ledger?.close() } catch {}
  }
}

export function budgetCeiling(env = process.env) {
  const source = 'DEVTEAM_BUDGET_MAX_TOKENS'
  const values = env ?? process.env
  const rawMax = values?.DEVTEAM_BUDGET_MAX_TOKENS
  if (rawMax == null || rawMax === '') return null
  const parsePositiveInteger = (value) => {
    const text = typeof value === 'number' ? String(value) : String(value)
    if (!/^\d+$/.test(text)) return null
    const number = Number(text)
    return Number.isSafeInteger(number) && number >= 1 ? number : null
  }
  const refuse = (message) => ({ max_tokens: null, window_ms: null, source, error: message })
  const max_tokens = parsePositiveInteger(rawMax)
  if (max_tokens == null) return refuse('DEVTEAM_BUDGET_MAX_TOKENS must be an integer >= 1')
  const rawWindow = values?.DEVTEAM_BUDGET_WINDOW_MS
  const window_ms = rawWindow == null || rawWindow === '' ? RUN_SET_WINDOW_MS : parsePositiveInteger(rawWindow)
  if (window_ms == null) return refuse('DEVTEAM_BUDGET_WINDOW_MS must be an integer >= 1')
  return { max_tokens, window_ms, source, error: null }
}

async function body(req) {
  let text = ''
  for await (const chunk of req) {
    text += chunk
    if (Buffer.byteLength(text) > 4096) throw new Error('body too large')
  }
  return JSON.parse(text || '{}')
}
function staticResponse(req, res) {
  if (!existsSync(DIST)) {
    const text = '<!doctype html><meta charset="utf-8"><title>Visualizer</title><p>The app has not been built. Run <code>npm run viz:build</code>.</p>'
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(text); return
  }
  let pathname
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname) } catch { res.writeHead(400); res.end('Bad request'); return }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const candidate = resolve(DIST, relative)
  if (candidate !== DIST && !candidate.startsWith(`${DIST}/`)) { res.writeHead(404); res.end('Not found'); return }
  let target = candidate
  try { if (!statSync(target).isFile()) throw new Error('not file') } catch { target = resolve(DIST, 'index.html') }
  try {
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }
    const ext = target.slice(target.lastIndexOf('.'))
    const data = readFileSync(target)
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'content-length': data.length }); res.end(data)
  } catch { res.writeHead(404); res.end('Not found') }
}

export function startServer(options = {}) {
  const config = { ...defaults(), ...options }
  config.checkout = resolve(config.checkout || process.cwd())
  const env = config.env ?? process.env
  const feed = config.feed || createFeed({ kind: config.kind || 'ledger', ledgerDb: config.ledgerDb, triageDb: config.triageDb })
  const returns = config.returns || createReturnsSource({ crewRoot: config.crewRoot })
  const roster = config.roster || createRosterSource({ rosterPath: config.rosterPath })
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    try {
      if (url.pathname === '/api/sessions') {
        if (req.method !== 'GET') return json(res, 405, { schema, error: 'method not allowed' })
        const result = feed.listRuns({ mode: url.searchParams.get('mode') || '', status: url.searchParams.get('status') || '', since: url.searchParams.get('since') || '', until: url.searchParams.get('until') || '' })
        return json(res, 200, { schema, ...result })
      }
      if (url.pathname === '/api/events') {
        if (req.method !== 'GET') return json(res, 405, { schema, error: 'method not allowed' })
        const after = integer(url.searchParams.get('after'), 0), limit = integer(url.searchParams.get('limit'), 200)
        const phase_id = url.searchParams.has('phase_id') ? integer(url.searchParams.get('phase_id'), null) : undefined
        if (after === null || limit === null || limit < 1 || phase_id === null) return json(res, 400, { schema, error: 'after, limit and phase_id must be integers' })
        const filters = {}
        for (const key of ['type', 'role']) if (url.searchParams.get(key)) filters[key] = url.searchParams.get(key)
        if (phase_id !== undefined) filters.phase_id = phase_id
        const result = feed.listEvents({ adw_id: url.searchParams.get('adw_id') || '', after, limit, ...filters })
        return json(res, 200, { schema, ...result })
      }
      if (url.pathname === '/api/returns') {
        if (req.method !== 'GET') return json(res, 405, { schema, error: 'method not allowed' })
        const repo_slug = url.searchParams.get('repo_slug'), task_slug = url.searchParams.get('task_slug')
        if (!repo_slug || !task_slug) return json(res, 400, { schema, error: 'repo_slug and task_slug are required' })
        const result = returns.listEnvelopes({ repo_slug, task_slug, adw_id: url.searchParams.get('adw_id') || '' })
        return json(res, 200, { schema, ...result })
      }
      if (url.pathname === '/api/roster') {
        if (req.method !== 'GET') return json(res, 405, { schema, error: 'method not allowed' })
        return json(res, 200, { schema, ...roster.readRoster() })
      }
      if (url.pathname === '/api/cell-health') {
        if (req.method !== 'GET') return json(res, 405, { schema, error: 'method not allowed' })
        const defaults = defaultCellWindow()
        const since = url.searchParams.has('since') ? url.searchParams.get('since') : defaults.since
        const until = url.searchParams.has('until') ? url.searchParams.get('until') : defaults.until
        const sinceMs = Date.parse(since)
        const untilMs = until == null ? null : Date.parse(until)
        if (Number.isNaN(sinceMs) || (until != null && Number.isNaN(untilMs))) return json(res, 400, { schema, error: 'since and until must be ISO timestamps' })
        if (untilMs != null && untilMs <= sinceMs) return json(res, 400, { schema, error: 'until must be later than since' })
        const result = feed.cellFailures({ since, until })
        return json(res, 200, { schema, ...shapeCellHealth({ ...result, roster: roster.readRoster(), since, until, label: defaults.label }) })
      }
      if (url.pathname === '/api/run-set') {
        if (req.method !== 'GET') return json(res, 405, { schema, error: 'method not allowed' })
        const defaults = defaultRunSetWindow()
        const since = url.searchParams.has('since') ? url.searchParams.get('since') : defaults.since
        const until = url.searchParams.has('until') ? url.searchParams.get('until') : defaults.until
        const sinceMs = Date.parse(since)
        const untilMs = until == null ? null : Date.parse(until)
        if (Number.isNaN(sinceMs) || (until != null && Number.isNaN(untilMs))) return json(res, 400, { schema, error: 'since and until must be ISO timestamps' })
        if (untilMs != null && untilMs <= sinceMs) return json(res, 400, { schema, error: 'until must be later than since' })
        const result = feed.runSet({ since, until })
        // Read AFTER the query it reports on: the feed's db open is lazy, so a
        // handle that has answered nothing yet reports degraded false even for
        // a database that cannot be opened.
        const feedHealth = typeof feed.health === 'function' ? feed.health() : null
        const runSetReason = typeof feed._reason === 'function' ? feed._reason() : null
        // feed.health() also includes the independent triage sidecar. The
        // ledger reason is the read-specific degradation signal for this view.
        const runSetHealth = typeof feed._reason === 'function'
          ? { ...(feedHealth || {}), degraded: typeof runSetReason === 'string' && runSetReason.length > 0 }
          : feedHealth
        const burn = typeof feed.budgetWindow === 'function'
          ? feed.budgetWindow({ since, until })
          : { measured: false, total: null, sessions: null, absent: 'budget burn is unavailable from this feed' }
        return json(res, 200, { schema, ...shapeRunSet({ ...result, degraded: runSetHealth?.degraded === true, degraded_reason: runSetReason, since, until, label: defaults.label, ceiling: budgetCeiling(env), burn }) })
      }
      if (url.pathname === '/api/intake') {
        if (req.method !== 'GET') return json(res, 405, { schema, error: 'method not allowed' })
        const defaults = defaultIntakeWindow()
        const since = url.searchParams.has('since') ? url.searchParams.get('since') : defaults.since
        const until = url.searchParams.has('until') ? url.searchParams.get('until') : defaults.until
        const sinceMs = Date.parse(since)
        const untilMs = until == null ? null : Date.parse(until)
        if (Number.isNaN(sinceMs) || (until != null && Number.isNaN(untilMs))) return json(res, 400, { schema, error: 'since and until must be ISO timestamps' })
        if (untilMs != null && untilMs <= sinceMs) return json(res, 400, { schema, error: 'until must be later than since' })
        const result = typeof feed.intake === 'function'
          ? feed.intake({ since, until })
          : { sweeps: null, refusals: null, picks: null, ever: null, absent: 'intake is unavailable from this feed' }
        return json(res, 200, { schema, ...shapeIntake({ ...result, since, until, label: defaults.label }) })
      }
      if (url.pathname === '/api/seat-teardowns') {
        if (req.method !== 'GET') return json(res, 405, { schema, error: 'method not allowed' })
        const defaults = defaultTeardownWindow()
        const since = url.searchParams.has('since') ? url.searchParams.get('since') : defaults.since
        const until = url.searchParams.has('until') ? url.searchParams.get('until') : defaults.until
        const sinceMs = Date.parse(since)
        const untilMs = until == null ? null : Date.parse(until)
        if (Number.isNaN(sinceMs) || (until != null && Number.isNaN(untilMs))) return json(res, 400, { schema, error: 'since and until must be ISO timestamps' })
        if (untilMs != null && untilMs <= sinceMs) return json(res, 400, { schema, error: 'until must be later than since' })
        const result = typeof feed.seatTeardowns === 'function'
          ? feed.seatTeardowns({ since, until })
          : { runs: null, rows: null, absent: 'seat teardowns are unavailable from this feed' }
        return json(res, 200, { schema, ...shapeSeatTeardowns({ ...result, since, until, label: defaults.label }) })
      }
      if (url.pathname === '/api/intake/brake') {
        if (req.method === 'GET') return json(res, 200, readBrake(config))
        if (req.method !== 'POST') return json(res, 405, { schema, error: 'method not allowed' })
        let input
        try { input = await body(req) } catch (err) { return json(res, 400, { schema, error: err.message || 'invalid json' }) }
        if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.engaged !== 'boolean' || typeof input.actor !== 'string') {
          return json(res, 400, { schema, error: 'engaged must be a boolean and actor must be a non-empty string of at most 120 characters' })
        }
        const actor = input.actor.trim()
        if (!actor || actor.length > 120) {
          return json(res, 400, { schema, error: 'engaged must be a boolean and actor must be a non-empty string of at most 120 characters' })
        }
        const path = join(config.checkout, STOP_SWITCH_PATH)
        const transition = input.engaged ? 'engaged' : 'cleared'
        const at = new Date().toISOString()
        let wrote = false
        let writeError = null
        try {
          if (input.engaged) {
            mkdirSync(dirname(path), { recursive: true })
            writeFileSync(path, `${JSON.stringify({ actor, at })}\n`)
          } else {
            rmSync(path, { force: true })
          }
          wrote = true
        } catch (err) {
          writeError = `${path}: ${err?.message || String(err)}`
        }
        const readback = readBrake(config)
        const expected = input.engaged ? 'engaged' : 'clear'
        const transitionError = writeError || (readback.measured !== true
          ? readback.read_error || `${path}: switch state could not be read after ${transition}`
          : readback.state !== expected ? `${path}: switch state did not become ${expected}` : null)
        const ok = transitionError == null && wrote
        const recorded = recordBrake(config, {
          checkout: config.checkout,
          path,
          transition,
          actor,
          outcome: ok ? 'ok' : 'failed',
          detail: ok ? `stop switch ${transition}` : transitionError,
          created_at: at,
        })
        return json(res, 200, {
          schema, ok, ...readback, actor, at, transition, wrote,
          ...recorded,
          ...(transitionError ? { error: transitionError } : {}),
        })
      }
      if (url.pathname === '/api/roster/propose') {
        if (req.method !== 'POST') return json(res, 405, { schema, error: 'method not allowed' })
        let input
        try { input = await body(req) } catch (err) { return json(res, 400, { schema, error: err.message || 'invalid json' }) }
        if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.tier !== 'string' || typeof input.role !== 'string') return json(res, 400, { schema, error: 'tier and role are required' })
        if (input.cell !== null && (typeof input.cell !== 'object' || Array.isArray(input.cell))) return json(res, 400, { schema, error: 'cell must be an object or null' })
        const raw = roster.readRaw()
        const result = await proposeEdit({ rosterText: raw.text, rosterPath: raw.path, readError: raw.error, tier: input.tier, role: input.role, cell: input.cell })
        return json(res, 200, { schema, roster_path: raw.path, applyable_with: 'git apply / patch -p1', ...result })
      }
      if (url.pathname === '/api/roster/ladder') {
        if (req.method !== 'GET') return json(res, 405, { schema, error: 'method not allowed' })
        const window = defaultCellWindow()
        const ladder = readLadder({ ladderPath: config.ladderPath })
        const reference = readReference({ referencePath: config.referencePath })
        const failures = feed.cellFailures(window)
        const view = ladderView({ roster: roster.readRoster(), ladder, reference, cells: { ...failures, measured_window: window } })
        return json(res, 200, { schema, ...view })
      }
      if (url.pathname === '/api/roster/ladder/stage') {
        if (req.method !== 'POST') return json(res, 405, { schema, error: 'method not allowed' })
        let input
        try { input = await body(req) } catch (err) { return json(res, 400, { schema, error: err.message || 'invalid json' }) }
        if (!input || typeof input !== 'object' || Array.isArray(input) || !Array.isArray(input.moves)) return json(res, 400, { schema, error: 'moves must be an array' })
        for (let index = 0; index < input.moves.length; index += 1) {
          const move = input.moves[index]
          if (!move || typeof move !== 'object' || Array.isArray(move) || typeof move.tier !== 'string' || typeof move.role !== 'string') return json(res, 400, { schema, error: `moves[${index}].tier and moves[${index}].role are required` })
          if (move.cell !== null && (typeof move.cell !== 'object' || Array.isArray(move.cell))) return json(res, 400, { schema, error: `moves[${index}].cell must be an object or null` })
        }
        const raw = roster.readRaw()
        const ladder = readLadder({ ladderPath: config.ladderPath })
        const result = await stageMoves({ rosterText: raw.text, rosterPath: raw.path, readError: raw.error, moves: input.moves, ladder, breaker: { policy: breakerPolicy(env), dbPath: config.ledgerDb } })
        return json(res, 200, { schema, roster_path: raw.path, ...result })
      }
      if (url.pathname === '/api/roster/ladder/compose') {
        if (req.method !== 'POST') return json(res, 405, { schema, error: 'method not allowed' })
        let input
        try { input = await body(req) } catch (err) { return json(res, 400, { schema, error: err.message || 'invalid json' }) }
        if (!input || typeof input !== 'object' || Array.isArray(input) || !Array.isArray(input.moves)) return json(res, 400, { schema, error: 'moves must be an array' })
        for (let index = 0; index < input.moves.length; index += 1) {
          const move = input.moves[index]
          if (!move || typeof move !== 'object' || Array.isArray(move) || typeof move.tier !== 'string' || typeof move.role !== 'string') return json(res, 400, { schema, error: `moves[${index}].tier and moves[${index}].role are required` })
          if (move.cell !== null && (typeof move.cell !== 'object' || Array.isArray(move.cell))) return json(res, 400, { schema, error: `moves[${index}].cell must be an object or null` })
        }
        const raw = roster.readRaw()
        const ladder = readLadder({ ladderPath: config.ladderPath })
        const result = await composeMoves({ rosterText: raw.text, rosterPath: raw.path, readError: raw.error, moves: input.moves, ladder, breaker: { policy: breakerPolicy(env), dbPath: config.ledgerDb } })
        return json(res, 200, { schema, roster_path: raw.path, applyable_with: 'git apply / patch -p1', ...result })
      }
      if (url.pathname === '/api/health') {
        if (req.method !== 'GET') return json(res, 405, { schema, error: 'method not allowed' })
        return json(res, 200, { schema, ...feed.health(), ...returns.health(), returns_readonly: true })
      }
      if (url.pathname === '/api/triage') {
        if (req.method !== 'POST') return json(res, 405, { schema, error: 'method not allowed' })
        let input
        try { input = await body(req) } catch (err) { return json(res, 400, { schema, error: err.message || 'invalid json' }) }
        if (typeof input.adw_id !== 'string' || typeof input.reviewed !== 'boolean') return json(res, 400, { schema, error: 'adw_id and reviewed are required' })
        const result = feed.setTriage(input)
        return json(res, 200, { schema, ...result })
      }
      if (url.pathname.startsWith('/api/')) return json(res, req.method === 'GET' ? 404 : 405, { schema, error: 'not found' })
      if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end()
      return staticResponse(req, res)
    } catch (err) { return json(res, 500, { schema, error: err.message || 'internal error' }) }
  })
  const close = () => { server.close(() => feed.close()) }
  process.once('SIGTERM', close); process.once('SIGINT', close)
  server.listen(config.port, config.host, () => {
    const address = server.address()
    process.stdout.write(`${JSON.stringify({ listening: true, port: address.port, ledger_db: config.ledgerDb, triage_db: config.triageDb || join(dirname(config.ledgerDb), 'visualizer.db'), crew_root: config.crewRoot, returns_readonly: true, readonly: false, readonly_reads: true, writes: ['stop-switch', 'intake brake ledger rows'] })}\n`)
  })
  return { server, feed }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  // process.exitCode, not process.exit: the refusal happens BEFORE
  // startServer, so nothing is bound, no ledger is opened and no state is
  // written on this path. A non-usage throw keeps exit 1, and an async
  // failure (EADDRINUSE) still surfaces as the uncaught-error exit 1 it is
  // today — exit 1 stays the code for a genuine internal error.
  let options
  try {
    options = parseCliArgs(process.argv.slice(2))
  } catch (err) {
    if (err instanceof ServerUsageError) {
      process.stderr.write(`${err.message}\n`)
      process.exitCode = 2
    } else {
      process.stderr.write(`${err && err.stack}\n`)
      process.exitCode = 1
    }
  }
  if (options) startServer(options)
}
