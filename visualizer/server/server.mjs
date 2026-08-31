#!/usr/bin/env node
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve, join, dirname, basename } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createFeed } from './feed.mjs'
import { createReturnsSource } from './returns-source.mjs'
import { createJournalSource } from './journal-source.mjs'
import { createRosterSource } from './roster-source.mjs'
import { proposeEdit } from './roster-edit.mjs'
import { readLadder, readReference, ladderView, stageMoves, composeMoves, applyMoves } from './roster-ladder.mjs'
import { createArtificialAnalysisCatalog } from './model-catalog.mjs'
import { saveArtificialAnalysisKey } from './local-env.mjs'
import { breakerPolicy } from '../../crew/breaker.mjs'
import { openLedger } from '../../scripts/factory/ledger.mjs'
import { defaultCellWindow, defaultRunSetWindow, defaultIntakeWindow, defaultTeardownWindow, RUN_SET_WINDOW_MS, shapeCellHealth, shapeRunSet, shapeIntake, shapeSeatTeardowns, shapeCellAttribution } from './shape.mjs'

// Mirrored from the intake loop's contract without importing that module: this
// server must not acquire the loop's process-spawning dependency graph.
export const STOP_SWITCH_PATH = '.factory/STOP'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT_ROOT = resolve(ROOT, '..')
const DIST = resolve(ROOT, 'web', 'dist')
const schema = 1
const DEFAULT_PORT = 4488

function defaults() {
  const dir = process.env.DEVTEAM_LEDGER_DIR || join(homedir(), '.dev-team', 'factory')
  return { port: portFromEnv(), host: '127.0.0.1', ledgerDb: process.env.DEVTEAM_LEDGER_DB || join(dir, 'ledger.db'), triageDb: undefined, crewRoot: process.env.DEVTEAM_CREW_ROOT || join(homedir(), '.crew'), checkout: resolve(process.env.DEVTEAM_INTAKE_CHECKOUT || process.cwd()), rosterPath: process.env.DEVTEAM_ROSTER_PATH || undefined, ladderPath: process.env.DEVTEAM_LADDER_PATH || undefined, referencePath: process.env.DEVTEAM_MODEL_REFERENCE || join(dir, 'model-reference.json') }
}
// A refusal cause, tagged so the CLI guard can map it to exit 2 without
// conflating it with an unexpected internal throw (mapped to 1). Exit codes
// match the scripts/factory convention (make-brief.mjs:9-12): 0 ok,
// 1 unexpected internal error, 2 usage/refusal.
export class ServerUsageError extends Error {
  constructor(message) { super(`viz-serve: ${message}`); this.name = 'ServerUsageError'; this.usage = true }
}

// One port contract, whichever door supplies it (#474). `Number(x) || 4488`
// cannot express "an absent value defaults" without also swallowing 0 — the one
// port a spawned descendant can ask for (#466) — and it let the env door bypass
// the refusal table the flag door has carried since #467.
export function parsePort(label, value) {
  const text = value == null ? '' : String(value)
  if (!/^\d+$/.test(text) || Number(text) > 65535) throw new ServerUsageError(`${label} must be an integer between 0 and 65535, found ${text}`)
  return Number(text)
}
export function portFromEnv(env = process.env, fallback = DEFAULT_PORT) {
  const raw = env?.DEVTEAM_VIZ_PORT
  if (raw == null || raw === '') return fallback
  return parsePort('DEVTEAM_VIZ_PORT', raw)
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

// The query parameters each route reads, mapped from its pathname. One place
// decides whether a route knows a parameter: a misspelling is a refusal that
// NAMES it, not a silently ignored default — the contract CLI_FLAGS has given
// the flag door since #443, on the door a human actually types into (h5 F6).
const ROUTE_PARAMS = Object.freeze({
  '/api/sessions': ['mode', 'status', 'since', 'until'],
  '/api/events': ['adw_id', 'after', 'limit', 'type', 'role', 'phase_id'],
  '/api/returns': ['repo_slug', 'task_slug', 'adw_id'],
  '/api/journal': ['repo_slug', 'task_slug', 'adw_id'],
  '/api/roster': [],
  '/api/cell-health': ['since', 'until'],
  '/api/run-set': ['since', 'until'],
  '/api/intake': ['since', 'until'],
  '/api/seat-teardowns': ['since', 'until'],
  '/api/cell-attribution': ['since', 'until'],
  '/api/intake/brake': [],
  '/api/roster/propose': [],
  '/api/roster/ladder': [],
  '/api/roster/ladder/stage': [],
  '/api/roster/ladder/compose': [],
  '/api/roster/ladder/apply': [],
  '/api/model-catalog': [],
  '/api/model-catalog/key': [],
  '/api/health': [],
  '/api/triage': [],
})

function refuseUnknownParams(url) {
  const allowed = ROUTE_PARAMS[url.pathname]
  if (!allowed) return null
  for (const name of url.searchParams.keys()) {
    if (!allowed.includes(name)) return `unknown query parameter ${name} — ${url.pathname} accepts ${allowed.length ? allowed.join(', ') : 'no query parameters'}`
  }
  return null
}

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
      out.port = parsePort(arg, value)
    } else {
      if (value === '') throw new ServerUsageError(`${arg} requires a non-empty value`)
      out[key] = value
    }
  }
  return out
}
function json(res, status, value, headers = {}) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), ...headers })
  res.end(body)
}

// #543: a state-writing route must not be reachable as a CORS SIMPLE request.
// Requiring application/json alone forces a preflight the browser will fail;
// the Origin compare is the second lock, for any client that sends one. This is
// NOT authentication and does not cover a local process — see the residuals.
const WRITE_CONTENT_TYPE = 'application/json'
function sameOrigin(origin, host) {
  if (typeof host !== 'string' || host === '') return false
  let parsed
  try { parsed = new URL(origin) } catch { return false }
  return parsed.host.toLowerCase() === host.toLowerCase()
}
export function writeGuard(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
  if (type !== WRITE_CONTENT_TYPE) return { status: 415, error: 'state-writing requests require content-type: application/json' }
  const origin = req.headers.origin
  if (origin != null && origin !== '' && !sameOrigin(origin, req.headers.host)) return { status: 403, error: 'cross-origin request refused' }
  return null
}

export function writeRosterAtomically({ path, beforeText, afterText } = {}) {
  const target = resolve(path || '')
  if (!target || typeof beforeText !== 'string' || typeof afterText !== 'string') return { ok:false, changed:false, conflict:false, error:'roster write needs a path and before/after text' }
  let temporary = null
  try {
    const current = readFileSync(target, 'utf8')
    if (current !== beforeText) return { ok:false, changed:false, conflict:true, error:`${target} changed after the draft was validated; reload the roster and try again` }
    if (current === afterText) return { ok:true, changed:false, conflict:false, error:null }
    const mode = statSync(target).mode & 0o777
    temporary = join(dirname(target), `.${basename(target)}.visualizer-${process.pid}-${randomUUID()}.tmp`)
    writeFileSync(temporary, afterText, { flag:'wx', mode })
    renameSync(temporary, target)
    temporary = null
    if (readFileSync(target, 'utf8') !== afterText) return { ok:false, changed:false, conflict:false, error:`${target} did not match the requested roster after write` }
    return { ok:true, changed:true, conflict:false, error:null }
  } catch (err) {
    return { ok:false, changed:false, conflict:false, error:`${target}: ${err?.message || String(err)}` }
  } finally {
    if (temporary) try { rmSync(temporary, { force:true }) } catch {}
  }
}
function integer(value, fallback) {
  if (value == null || value === '') return fallback
  if (!/^\d+$/.test(value)) return null
  const number = Number(value)
  // Number('999…') is a non-integral double: sqlite refuses to bind it to LIMIT
  // (raw driver text reached the client as a 500) and accepts it for `id > ?`,
  // so the route handed back a cursor it would refuse next request (h5 F10).
  return Number.isSafeInteger(number) ? number : null
}

// The 400 has always said ISO-8601 is the contract; Date.parse never enforced
// it — "2026" and "March 3 2026" both validated and then string-compared
// against stored ISO timestamps, silently excluding everything (h5 F4). An
// accepted bound is canonicalised with toISOString so the value the feed
// compares is in the domain it claims to be.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/
const ISO_COMPONENTS = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.(?<fraction>\d{1,3}))?(?:Z|[+-]\d{2}:\d{2})$/
function windowBound(label, value) {
  const text = value == null ? '' : String(value)
  const parsed = new Date(text)
  if (!ISO_INSTANT.test(text) || Number.isNaN(parsed.getTime())) return { value: null, error: `${label} must be an ISO-8601 timestamp such as 2026-01-01T00:00:00.000Z, found ${text}` }
  // Date normalises impossible calendar dates (for example 2025-02-29) into a
  // different instant. The strict shape above admits that spelling, so compare
  // the date components before allowing the normalised value through.
  const parts = text.match(ISO_COMPONENTS)
  if (parts) {
    const year = Number(parts.groups.year), month = Number(parts.groups.month), day = Number(parts.groups.day)
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) return { value: null, error: `${label} must be an ISO-8601 timestamp such as 2026-01-01T00:00:00.000Z, found ${text}` }
  }
  return { value: parsed.toISOString(), error: null }
}

function readWindow(url, fallback) {
  let since = fallback.since, until = fallback.until
  for (const label of ['since', 'until']) {
    if (!url.searchParams.has(label)) continue
    const bound = windowBound(label, url.searchParams.get(label))
    if (bound.error) return { since: null, until: null, error: bound.error }
    if (label === 'since') since = bound.value; else until = bound.value
  }
  if (until != null && Date.parse(until) <= Date.parse(since)) return { since: null, until: null, error: 'until must be later than since' }
  return { since, until, error: null }
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
  // resolve() is lexical and never follows a symlink, so a link planted in the
  // build output served content from outside the fence (h5 F12). realpath both
  // sides — DIST itself may sit behind a symlinked path component.
  const realDist = realpathOr(DIST)
  const realTarget = realpathOr(target)
  if (realTarget !== realDist && !realTarget.startsWith(`${realDist}/`)) { res.writeHead(404); res.end('Not found'); return }
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
  config.envFile = resolve(config.envFile || join(PROJECT_ROOT, '.env.local'))
  const env = config.env ?? process.env
  const feed = config.feed || createFeed({ kind: config.kind || 'ledger', ledgerDb: config.ledgerDb, triageDb: config.triageDb })
  const returns = config.returns || createReturnsSource({ crewRoot: config.crewRoot })
  const journal = config.journal || createJournalSource({ crewRoot: config.crewRoot })
  const roster = config.roster || createRosterSource({ rosterPath: config.rosterPath })
  const modelCatalog = config.modelCatalog || createArtificialAnalysisCatalog({ apiKey: env.ARTIFICIAL_ANALYSIS_API_KEY, fetchImpl: config.fetchImpl })
  const server = createServer(async (req, res) => {
    // #544: the request target and the Host header are both attacker-chosen, and
    // an unparseable one threw ABOVE this handler's try — an unhandled rejection
    // that exits the process and drops every in-flight keep-alive client.
    let url
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    } catch {
      return json(res, 400, { schema, error: 'invalid request target or Host header' })
    }
    try {
      // RFC 9110 requires HEAD wherever GET is implemented; the static route already
      // does it and every API route answered 405, so a proxy or health-checker that
      // probes with HEAD read a live board as broken (h5 F13). The Allow VALUES do
      // not change: visualizer-trajectory.test.mjs:196 pins `allow: 'GET'` on
      // /api/journal verbatim and sits outside this lane's fence.
      const method = req.method === 'HEAD' ? 'GET' : req.method
      const unknown = refuseUnknownParams(url)
      if (unknown) return json(res, 400, { schema, error: unknown })
      if (url.pathname === '/api/sessions') {
        if (method !== 'GET') return json(res, 405, { schema, error: 'method not allowed' }, { allow: 'GET' })
        const filters = { mode: url.searchParams.get('mode') || '', status: url.searchParams.get('status') || '', since: '', until: '' }
        for (const label of ['since', 'until']) {
          // An empty string is ABSENT, not malformed: api.js:7 sends all four names on
          // every load and App.svelte:26 initialises them to ''.
          const raw = url.searchParams.get(label)
          if (raw == null || raw === '') continue
          const bound = windowBound(label, raw)
          if (bound.error) return json(res, 400, { schema, error: bound.error })
          filters[label] = bound.value
        }
        if (filters.since && filters.until && Date.parse(filters.until) <= Date.parse(filters.since)) return json(res, 400, { schema, error: 'until must be later than since' })
        const result = feed.listRuns(filters)
        return json(res, 200, { schema, ...result })
      }
      if (url.pathname === '/api/events') {
        if (method !== 'GET') return json(res, 405, { schema, error: 'method not allowed' }, { allow: 'GET' })
        const after = integer(url.searchParams.get('after'), 0), limit = integer(url.searchParams.get('limit'), 200)
        const phase_id = url.searchParams.has('phase_id') ? integer(url.searchParams.get('phase_id'), null) : undefined
        if (after === null || limit === null || limit < 1 || phase_id === null) return json(res, 400, { schema, error: 'after, limit and phase_id must be integers' })
        const filters = {}
        for (const key of ['type', 'role']) if (url.searchParams.get(key)) filters[key] = url.searchParams.get(key)
        if (phase_id !== undefined) filters.phase_id = phase_id
        const result = feed.listEvents({ adw_id: url.searchParams.get('adw_id') || '', after, limit, ...filters })
        // Read AFTER the query it reports on, like /api/run-set: the feed's db open is
        // lazy. listEvents answers { events: [], cursor } for an unopenable ledger,
        // byte-identical to a genuinely empty page — the one reader on this surface
        // that stated an absence as a measured zero (h5 F7; #678 / #687 / #699).
        const eventsHealth = typeof feed.health === 'function' ? feed.health() : null
        const eventsReason = typeof feed._reason === 'function' ? feed._reason() : null
        // feed.health() also includes the triage sidecar, so its aggregate
        // degraded flag cannot by itself turn a successful event read into a
        // ledger absence (review RV1-2). A private reason or an explicit feed
        // verdict ties the typed absence to this ledger query.
        const eventsDegraded = result?.degraded === true || (eventsHealth?.degraded === true && typeof eventsReason === 'string' && eventsReason.length > 0)
        const eventsAbsent = eventsDegraded ? ((typeof result?.absent === 'string' && result.absent.length > 0 ? result.absent : null) || eventsReason || 'the ledger could not be opened') : null
        return json(res, 200, { schema, ...result, degraded: eventsDegraded, absent: eventsAbsent })
      }
      if (url.pathname === '/api/returns') {
        if (method !== 'GET') return json(res, 405, { schema, error: 'method not allowed' }, { allow: 'GET' })
        const repo_slug = url.searchParams.get('repo_slug'), task_slug = url.searchParams.get('task_slug')
        if (!repo_slug || !task_slug) return json(res, 400, { schema, error: 'repo_slug and task_slug are required' })
        const result = returns.listEnvelopes({ repo_slug, task_slug, adw_id: url.searchParams.get('adw_id') || '' })
        return json(res, 200, { schema, ...result })
      }
      if (url.pathname === '/api/journal') {
        if (method !== 'GET') return json(res, 405, { schema, error: 'method not allowed' }, { allow: 'GET' })
        const journalRepo = url.searchParams.get('repo_slug'), journalTask = url.searchParams.get('task_slug')
        if (!journalRepo || !journalTask) return json(res, 400, { schema, error: 'repo_slug and task_slug are required' })
        const result = journal.readJournal({ repo_slug: journalRepo, task_slug: journalTask, adw_id: url.searchParams.get('adw_id') || '' })
        return json(res, 200, { schema, ...result })
      }
      if (url.pathname === '/api/roster') {
        if (method !== 'GET') return json(res, 405, { schema, error: 'method not allowed' }, { allow: 'GET' })
        return json(res, 200, { schema, ...roster.readRoster() })
      }
      if (url.pathname === '/api/cell-health') {
        if (method !== 'GET') return json(res, 405, { schema, error: 'method not allowed' }, { allow: 'GET' })
        const defaults = defaultCellWindow()
        const bounds = readWindow(url, defaults)
        if (bounds.error) return json(res, 400, { schema, error: bounds.error })
        const { since, until } = bounds
        const result = feed.cellFailures({ since, until })
        return json(res, 200, { schema, ...shapeCellHealth({ ...result, roster: roster.readRoster(), since, until, label: defaults.label }) })
      }
      if (url.pathname === '/api/run-set') {
        if (method !== 'GET') return json(res, 405, { schema, error: 'method not allowed' }, { allow: 'GET' })
        const defaults = defaultRunSetWindow()
        const bounds = readWindow(url, defaults)
        if (bounds.error) return json(res, 400, { schema, error: bounds.error })
        const { since, until } = bounds
        const result = feed.runSet({ since, until })
        // Read AFTER the query it reports on: the feed's db open is lazy, so a
        // handle that has answered nothing yet reports degraded false even for
        // a database that cannot be opened.
        const feedHealth = typeof feed.health === 'function' ? feed.health() : null
        // The feed's reason LATCHES for the life of the process (#475):
        // probeColumns() records a momentary fault and nothing ever clears it,
        // so it can only ever answer "has anything ever gone wrong", never
        // "did this read work". It stays a fallback and never the gate.
        const latchedReason = typeof feed._reason === 'function' ? feed._reason() : null
        // This read's own verdict. The feed states an absence per call, so a
        // read that answered rows is healthy however bad the process history is.
        const readReason = typeof result?.absent === 'string' && result.absent.length > 0 ? result.absent : null
        // A read that answered no rows stays unanswerable even if it named no
        // reason — never a measured zero (#451) — and borrows the latched reason
        // only to describe it.
        const runSetReason = readReason ?? (result?.rows == null
          ? (latchedReason || 'the ledger read that answered this window failed without naming a reason')
          : null)
        const runSetHealth = { ...(feedHealth || {}), degraded: typeof runSetReason === 'string' && runSetReason.length > 0 }
        const burn = typeof feed.budgetWindow === 'function'
          ? feed.budgetWindow({ since, until })
          : { measured: false, total: null, sessions: null, absent: 'budget burn is unavailable from this feed' }
        return json(res, 200, { schema, ...shapeRunSet({ ...result, degraded: runSetHealth?.degraded === true, degraded_reason: runSetReason, since, until, label: defaults.label, ceiling: budgetCeiling(env), burn }) })
      }
      if (url.pathname === '/api/intake') {
        if (method !== 'GET') return json(res, 405, { schema, error: 'method not allowed' }, { allow: 'GET' })
        const defaults = defaultIntakeWindow()
        const bounds = readWindow(url, defaults)
        if (bounds.error) return json(res, 400, { schema, error: bounds.error })
        const { since, until } = bounds
        const result = typeof feed.intake === 'function'
          ? feed.intake({ since, until })
          : { sweeps: null, refusals: null, picks: null, ever: null, absent: 'intake is unavailable from this feed' }
        return json(res, 200, { schema, ...shapeIntake({ ...result, since, until, label: defaults.label }) })
      }
      if (url.pathname === '/api/seat-teardowns') {
        if (method !== 'GET') return json(res, 405, { schema, error: 'method not allowed' }, { allow: 'GET' })
        const defaults = defaultTeardownWindow()
        const bounds = readWindow(url, defaults)
        if (bounds.error) return json(res, 400, { schema, error: bounds.error })
        const { since, until } = bounds
        const result = typeof feed.seatTeardowns === 'function'
          ? feed.seatTeardowns({ since, until })
          : { runs: null, rows: null, absent: 'seat teardowns are unavailable from this feed' }
        return json(res, 200, { schema, ...shapeSeatTeardowns({ ...result, since, until, label: defaults.label }) })
      }
      if (url.pathname === '/api/cell-attribution') {
        if (method !== 'GET') return json(res, 405, { schema, error: 'method not allowed' }, { allow: 'GET' })
        const defaults = defaultCellWindow()
        const bounds = readWindow(url, defaults)
        if (bounds.error) return json(res, 400, { schema, error: bounds.error })
        const { since, until } = bounds
        const result = typeof feed.cellAttribution === 'function'
          ? feed.cellAttribution({ since, until })
          : { runs: null, rows: null, unattributable: null, absent: 'cell attribution is unavailable from this feed' }
        return json(res, 200, { schema, ...shapeCellAttribution({ ...result, since, until, label: defaults.label }) })
      }
      if (url.pathname === '/api/intake/brake') {
        if (method === 'GET') return json(res, 200, readBrake(config))
        if (method !== 'POST') return json(res, 405, { schema, error: 'method not allowed' }, { allow: 'GET, POST' })
        const refusal = writeGuard(req)
        if (refusal) return json(res, refusal.status, { schema, error: refusal.error })
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
        if (method !== 'POST') return json(res, 405, { schema, error: 'method not allowed' }, { allow: 'POST' })
        const refusal = writeGuard(req)
        if (refusal) return json(res, refusal.status, { schema, error: refusal.error })
        let input
        try { input = await body(req) } catch (err) { return json(res, 400, { schema, error: err.message || 'invalid json' }) }
        if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.tier !== 'string' || typeof input.role !== 'string') return json(res, 400, { schema, error: 'tier and role are required' })
        if (input.cell !== null && (typeof input.cell !== 'object' || Array.isArray(input.cell))) return json(res, 400, { schema, error: 'cell must be an object or null' })
        const raw = roster.readRaw()
        const result = await proposeEdit({ rosterText: raw.text, rosterPath: raw.path, readError: raw.error, tier: input.tier, role: input.role, cell: input.cell })
        return json(res, 200, { schema, roster_path: raw.path, applyable_with: 'git apply / patch -p1', ...result })
      }
      if (url.pathname === '/api/roster/ladder') {
        if (method !== 'GET') return json(res, 405, { schema, error: 'method not allowed' }, { allow: 'GET' })
        const window = defaultCellWindow()
        const ladder = readLadder({ ladderPath: config.ladderPath })
        const reference = readReference({ referencePath: config.referencePath })
        const failures = feed.cellFailures(window)
        const view = ladderView({ roster: roster.readRoster(), ladder, reference, cells: { ...failures, measured_window: window } })
        return json(res, 200, { schema, ...view })
      }
      if (url.pathname === '/api/model-catalog') {
        if (method !== 'GET') return json(res, 405, { schema, error: 'method not allowed' }, { allow: 'GET' })
        return json(res, 200, { schema, ...await modelCatalog.get() })
      }
      if (url.pathname === '/api/model-catalog/key') {
        if (method !== 'POST') return json(res, 405, { schema, error: 'method not allowed' }, { allow: 'POST' })
        const refusal = writeGuard(req)
        if (refusal) return json(res, refusal.status, { schema, error: refusal.error })
        let input
        try { input = await body(req) } catch (err) { return json(res, 400, { schema, error: err.message || 'invalid json' }) }
        if (!input || typeof input !== 'object' || Array.isArray(input)) return json(res, 400, { schema, error: 'request body must be an object' })
        try {
          if (input.api_key === null) { modelCatalog.clearApiKey(); return json(res, 200, { schema, ...await modelCatalog.get(), persisted:false }) }
          if (input.persist !== undefined && typeof input.persist !== 'boolean') return json(res, 400, { schema, error:'persist must be a boolean' })
          if (input.persist === true) {
            saveArtificialAnalysisKey(config.envFile, input.api_key)
            modelCatalog.setPersistentApiKey(input.api_key)
          } else modelCatalog.setApiKey(input.api_key)
        } catch (err) { return json(res, 400, { schema, error: err.message || 'invalid api_key' }) }
        return json(res, 200, { schema, ...await modelCatalog.get(), persisted:input.persist === true })
      }
      if (url.pathname === '/api/roster/ladder/stage') {
        if (method !== 'POST') return json(res, 405, { schema, error: 'method not allowed' }, { allow: 'POST' })
        const refusal = writeGuard(req)
        if (refusal) return json(res, refusal.status, { schema, error: refusal.error })
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
        if (method !== 'POST') return json(res, 405, { schema, error: 'method not allowed' }, { allow: 'POST' })
        const refusal = writeGuard(req)
        if (refusal) return json(res, refusal.status, { schema, error: refusal.error })
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
      if (url.pathname === '/api/roster/ladder/apply') {
        if (method !== 'POST') return json(res, 405, { schema, error: 'method not allowed' }, { allow: 'POST' })
        const refusal = writeGuard(req)
        if (refusal) return json(res, refusal.status, { schema, error: refusal.error })
        let input
        try { input = await body(req) } catch (err) { return json(res, 400, { schema, error: err.message || 'invalid json' }) }
        if (!input || typeof input !== 'object' || Array.isArray(input) || !Array.isArray(input.moves) || input.moves.length === 0) return json(res, 400, { schema, error: 'moves must be a non-empty array' })
        if (input.allow_warnings !== undefined && typeof input.allow_warnings !== 'boolean') return json(res, 400, { schema, error: 'allow_warnings must be a boolean' })
        for (let index = 0; index < input.moves.length; index += 1) {
          const move = input.moves[index]
          if (!move || typeof move !== 'object' || Array.isArray(move) || typeof move.tier !== 'string' || typeof move.role !== 'string') return json(res, 400, { schema, error: `moves[${index}].tier and moves[${index}].role are required` })
          if (move.cell !== null && (typeof move.cell !== 'object' || Array.isArray(move.cell))) return json(res, 400, { schema, error: `moves[${index}].cell must be an object or null` })
        }
        const raw = roster.readRaw()
        const ladder = readLadder({ ladderPath: config.ladderPath })
        const result = await applyMoves({
          rosterText: raw.text,
          rosterPath: raw.path,
          readError: raw.error,
          moves: input.moves,
          ladder,
          breaker: { policy: breakerPolicy(env), dbPath: config.ledgerDb },
          allowWarnings:input.allow_warnings === true,
          writeRoster: ({ beforeText, afterText }) => writeRosterAtomically({ path:raw.path, beforeText, afterText }),
        })
        return json(res, 200, {
          schema,
          roster_path: raw.path,
          applied_at:result.applied ? new Date().toISOString() : null,
          takes_effect:result.applied ? 'next_new_task' : null,
          ...result,
        })
      }
      if (url.pathname === '/api/health') {
        if (method !== 'GET') return json(res, 405, { schema, error: 'method not allowed' }, { allow: 'GET' })
        return json(res, 200, { schema, ...feed.health(), ...returns.health(), returns_readonly: true })
      }
      if (url.pathname === '/api/triage') {
        if (method !== 'POST') return json(res, 405, { schema, error: 'method not allowed' }, { allow: 'POST' })
        const refusal = writeGuard(req) // #543: /api/triage is a state writer too
        if (refusal) return json(res, refusal.status, { schema, error: refusal.error })
        let input
        try { input = await body(req) } catch (err) { return json(res, 400, { schema, error: err.message || 'invalid json' }) }
        if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.adw_id !== 'string' || typeof input.reviewed !== 'boolean') return json(res, 400, { schema, error: 'adw_id and reviewed are required' })
        const result = feed.setTriage(input)
        return json(res, 200, { schema, ...result })
      }
      if (url.pathname.startsWith('/api/')) return method === 'GET' ? json(res, 404, { schema, error: 'not found' }) : json(res, 405, { schema, error: 'not found' }, { allow: 'GET' })
      if (method !== 'GET' && method !== 'HEAD') return res.writeHead(405, { allow: 'GET, HEAD' }).end()
      return staticResponse(req, res)
    } catch (err) { return json(res, 500, { schema, error: err.message || 'internal error' }) }
  })
  // server.close() alone lets one in-flight request hold the process open with no
  // timeout: the port frees while an orphan keeps ledger.db and the triage
  // sidecar's WAL open, and only a second SIGTERM kills it — by process death,
  // never through feed.close() (h5 F11). This closes THIS server's own sockets
  // and signals no other process.
  const close = () => { server.close(() => feed.close()); server.closeIdleConnections(); server.closeAllConnections() }
  process.once('SIGTERM', close); process.once('SIGINT', close)
  server.listen(config.port, config.host, () => {
    const address = server.address()
    process.stdout.write(`${JSON.stringify({ listening: true, port: address.port, ledger_db: config.ledgerDb, triage_db: config.triageDb || join(dirname(config.ledgerDb), 'visualizer.db'), crew_root: config.crewRoot, returns_readonly: true, readonly: false, ledger_feed_readonly: true, triage_sidecar_writable: true, writes: ['triage sidecar (may create visualizer.db and its WAL/SHM)', 'stop-switch', 'intake brake ledger rows (may create the ledger directory, ledger.jsonl, ledger.db, WAL and SHM)', 'configured roster file when Apply for next task is explicitly requested', 'Artificial Analysis key in the project .env.local when explicitly requested'] })}\n`)
  })
  return { server, feed }
}

// realpath both sides: the ESM loader realpaths import.meta.url while argv[1]
// stays literal, so under a symlinked path component a literal compare is
// silently false and this CLI would no-op (h5 F3).
function realpathOr(path) {
  try { return realpathSync(path) } catch { return path }
}
const invokedDirectly = process.argv[1] && realpathOr(process.argv[1]) === realpathOr(fileURLToPath(import.meta.url))
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
