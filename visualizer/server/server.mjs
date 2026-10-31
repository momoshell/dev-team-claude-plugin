#!/usr/bin/env node
import { createServer } from 'node:http'
import { isIP } from 'node:net'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { resolve, join, dirname, sep, relative } from 'node:path'
import { homedir, networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createJournalSource } from './journal-source.mjs'
import { createLeanSource } from './lean-source.mjs'
import { createAgentsSource } from './agents-source.mjs'
import { proposeAgentEdit } from './agents-edit.mjs'
import { AGENT_ROLES } from '../../crew/protocols.mjs'
import { createAgentLibrary } from './agent-library.mjs'
import { createSkillLibrary } from './skill-library.mjs'
import { createArtificialAnalysisCatalog } from './model-catalog.mjs'
import { createOpenRouterCatalog } from './openrouter-catalog.mjs'
import { mergeModelDirectory } from './model-directory.mjs'
import { saveArtificialAnalysisKey } from './local-env.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT_ROOT = resolve(ROOT, '..')
const DIST = resolve(ROOT, 'web', 'dist')
const schema = 2
const DEFAULT_PORT = 4488

function defaults() {
  return { port: portFromEnv(), host: '127.0.0.1', crewRoot: process.env.DEVTEAM_CREW_ROOT || join(homedir(), '.crew'), checkout: resolve(process.env.DEVTEAM_INTAKE_CHECKOUT || process.cwd()) }
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
  '--crew-root': 'crewRoot',
  '--checkout': 'checkout',
})

// The query parameters each route reads, mapped from its pathname. One place
// decides whether a route knows a parameter: a misspelling is a refusal that
// NAMES it, not a silently ignored default — the contract CLI_FLAGS has given
// the flag door since #443, on the door a human actually types into (h5 F6).
export const ROUTE_PARAMS = Object.freeze({
  '/api/sessions': ['mode', 'status', 'since', 'until'],
  '/api/events': ['adw_id', 'after', 'limit', 'type', 'role', 'phase_id'],
  '/api/journal': ['repo_slug', 'task_slug', 'adw_id'],
  '/api/seat-sessions': ['repo_slug', 'task_slug', 'adw_id', 'role'],
  '/api/plugin-write-mode': [],
  '/api/agent-library': [],
  '/api/agent-library/save': [],
  '/api/harness-settings': [],
  '/api/skill-library': [],
  '/api/skill-library/save': [],
  '/api/skill-rules': [],
  '/api/agents': [],
  '/api/agents/propose': [],
  '/api/skills/propose': [],
  '/api/prompts/propose': [],
  '/api/model-catalog': [],
  '/api/model-catalog/key': [],
  '/api/health': [],
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
const WRITE_HOSTNAMES = new Set(['127.0.0.1','localhost','::1'])
export function sameOrigin(origin, host) {
  if (typeof host !== 'string' || host === '') return false
  let parsed
  try { parsed = new URL(origin) } catch { return false }
  return parsed.host.toLowerCase() === host.toLowerCase()
}
export function hostGuard(req, label, addressSource = networkInterfaces) {
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return { status: 403, error: `${label} host refused: ${host}` }
  let parsed
  try { parsed = new URL('http://' + host) } catch { return { status: 403, error: `${label} host refused: ${host}` } }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const port = parsed.port === '' ? 80 : Number(parsed.port)
  const authority = /^(?:\[([^\]]+)\]|([^:]+))(?::\d+)?$/.exec(host)
  const literal = authority?.[1] ?? authority?.[2] ?? ''
  let localAddress = false
  if (label === 'read' && isIP(literal)) {
    try {
      localAddress = Object.values(addressSource()).flatMap(entries => entries ?? []).some(({ address }) => {
        const ip = isIP(address)
        if (!ip) return false
        const normalized = new URL('http://' + (ip === 6 ? '[' + address + ']' : address)).hostname.toLowerCase().replace(/^\[|\]$/g, '')
        return normalized === hostname
      })
    } catch {
      // Interface lookup/normalization failure must not widen access.
    }
  }
  if ((!WRITE_HOSTNAMES.has(hostname) && !localAddress) || port !== req.socket?.localPort) return { status: 403, error: `${label} host refused: ${host}` }
  return null
}
function isLoopbackPeer(remoteAddress) { if (typeof remoteAddress !== 'string' || !remoteAddress) return false; let address = remoteAddress.toLowerCase(); if (address === '::1') return true; if (address.startsWith('::ffff:')) address = address.slice('::ffff:'.length); const parts = address.split('.'); return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255) && Number(parts[0]) === 127 }
export function writeGuard(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
  if (type !== WRITE_CONTENT_TYPE) return { status: 415, error: 'state-writing requests require content-type: application/json' }
  const refusal = hostGuard(req, 'write')
  if (refusal) return refusal
  if (!isLoopbackPeer(req.socket?.remoteAddress)) return { status: 403, error: `write peer refused: ${typeof req.socket?.remoteAddress === 'string' && req.socket.remoteAddress ? req.socket.remoteAddress : 'missing remote address'}` }
  const origin = req.headers.origin
  if (origin != null && origin !== '' && !sameOrigin(origin, req.headers.host)) return { status: 403, error: 'cross-origin request refused' }
  return null
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

const BODY_TOO_LARGE = 'body_too_large'
async function body(req, limit = 4096) {
  let text = ''
  for await (const chunk of req) {
    text += chunk
    if (Buffer.byteLength(text) > limit) {
      const error = new Error(`body too large (max ${limit} bytes)`)
      error.code = BODY_TOO_LARGE
      throw error
    }
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

function pathIsUnder(path, dir) {
  if (path === dir) return true
  const prefix = dir.endsWith(sep) ? dir : dir + sep
  return path.startsWith(prefix)
}
function linkMarkerScan({ cacheDir, exists, readFile, realpath, readdir } = {}) {
  const targets = []
  let malformed = false
  const list = (dir) => {
    try {
      const names = readdir(dir)
      return [...names].sort()
    } catch {
      return null
    }
  }
  const top = list(cacheDir)
  if (top === null) return { targets, malformed: false }
  for (const a of top) {
    const second = list(join(cacheDir, a))
    if (second === null) continue
    for (const b of second) {
      const third = list(join(cacheDir, a, b))
      if (third === null) continue
      for (const c of third) {
        const marker = join(cacheDir, a, b, c, '.claude-plugin-link')
        let present = true
        try { present = exists(marker) } catch { present = true }
        if (!present) continue
        try {
          const raw = readFile(marker, 'utf8')
          const parsed = JSON.parse(raw)
          const target = parsed?.target
          if (typeof target !== 'string' || !target.trim()) throw new Error('bad link target')
          targets.push(realpath(resolve(target)))
        } catch {
          malformed = true
        }
      }
    }
  }
  return { targets, malformed }
}
function resolveTargetPath(target, realpath) {
  const lexical = resolve(target)
  let ancestor = lexical
  while (true) {
    try {
      const realAncestor = realpath(ancestor)
      return ancestor === lexical ? realAncestor : join(realAncestor, relative(ancestor, lexical))
    } catch {}
    const parent = dirname(ancestor)
    if (parent === ancestor) return lexical
    ancestor = parent
  }
}
export function pluginWriteMode({ pluginRoot = PROJECT_ROOT, home = homedir(), existsSync: exists = existsSync, realpathSync: realpath = realpathSync, readdirSync: readdir = readdirSync, readFileSync: readFile = readFileSync } = {}) {
  let plugin_root = resolve(pluginRoot)
  const readonly = (basis) => ({ writable:false, reason:'installed-plugin-read-only', basis, plugin_root })
  try { plugin_root = realpath(plugin_root) } catch { return readonly('plugin-root-unresolvable') }
  let realHome
  try { realHome = realpath(resolve(home)) } catch { realHome = resolve(home) }
  const plugins = join(realHome, '.claude', 'plugins')
  let realPlugins = plugins
  try { realPlugins = realpath(plugins) } catch {}
  // A symlinked plugins dir puts the resolved root outside the lexical path, so either spelling refuses.
  if ([plugins, realPlugins].some((dir) => plugin_root === dir || plugin_root.startsWith(dir + sep))) return readonly('under-claude-plugins-dir')
  const linkScan = linkMarkerScan({cacheDir: join(realPlugins, 'cache'), exists, readFile, realpath, readdir})
  if (linkScan.malformed) return readonly('link-mode-marker-unreadable')
  if (linkScan.targets.some((target) => pathIsUnder(plugin_root, target))) return readonly('link-mode-install-target')
  if (!exists(join(plugin_root, '.git'))) return readonly('no-git-work-tree')
  return { writable:true, reason:null, basis:null, plugin_root }
}
export function pluginWriteTargetMode({ target, home = homedir(), existsSync: exists = existsSync, realpathSync: realpath = realpathSync, readdirSync: readdir = readdirSync, readFileSync: readFile = readFileSync } = {}) {
  const lexicalTarget = resolve(target)
  const resolvedTarget = resolveTargetPath(target, realpath)
  const targetReadonly = (basis) => ({ writable:false, reason:'installed-plugin-read-only', basis, plugin_root: resolvedTarget })
  let realHome
  try { realHome = realpath(resolve(home)) } catch { realHome = resolve(home) }
  const plugins = join(realHome, '.claude', 'plugins')
  let realPlugins = plugins
  try { realPlugins = realpath(plugins) } catch {}
  const targetPlugins = [plugins, realPlugins]
  const targetScan = linkMarkerScan({cacheDir: join(realPlugins, 'cache'), exists, readFile, realpath, readdir})
  if (targetScan.malformed) return targetReadonly('link-mode-marker-unreadable')
  if ([lexicalTarget, resolvedTarget].some((candidate) => targetPlugins.some((dir) => pathIsUnder(candidate, dir)))) return targetReadonly('under-claude-plugins-dir')
  if (targetScan.targets.some((targetRoot) => pathIsUnder(lexicalTarget, targetRoot) || pathIsUnder(resolvedTarget, targetRoot))) return targetReadonly('link-mode-install-target')
  return { writable:true, reason:null, basis:null, plugin_root: resolvedTarget }
}

export function startServer(options = {}) {
  const config = { ...defaults(), ...options }
  config.checkout = resolve(config.checkout || process.cwd())
  const writeMode = pluginWriteMode({ pluginRoot:config.pluginRoot ?? PROJECT_ROOT, home:config.home ?? homedir() })
  const PLUGIN_WRITE_NOTICE = 'This plugin runs from an installed, version-pinned copy whose edits the next plugin update would overwrite.'
  const pluginWriteRefusal = { schema, error:PLUGIN_WRITE_NOTICE, reason:writeMode.reason, basis:writeMode.basis, plugin_root:writeMode.plugin_root }
  config.envFile = resolve(config.envFile || join(PROJECT_ROOT, '.env.local'))
  const env = config.env ?? process.env
  const lean = config.lean || createLeanSource({ crewRoot: config.crewRoot, archiveRoot: config.leanArchiveRoot })
  const journal = config.journal || createJournalSource({ crewRoot: config.crewRoot, lean })
  const modelCatalog = config.modelCatalog || createArtificialAnalysisCatalog({ apiKey: env.ARTIFICIAL_ANALYSIS_API_KEY, fetchImpl: config.fetchImpl })
  const agents = config.agents || config.agentsSource || createAgentsSource({ checkout: config.checkout, pluginRoot: PROJECT_ROOT, crewRoot: config.crewRoot })
  const agentLibrary = createAgentLibrary({ capabilitiesPath:config.capabilitiesPath ?? join(PROJECT_ROOT,'crew/capabilities.json'), checkout:config.checkout, home:config.home ?? homedir(), env, writable:writeMode.writable && pluginWriteTargetMode({target:join(config.checkout,'agents'),home:config.home ?? homedir()}).writable })
  const skillRoot = config.skillRoot ?? config.pluginRoot ?? PROJECT_ROOT
  const skillLibrary = createSkillLibrary({root:skillRoot,writable:writeMode.writable && pluginWriteTargetMode({target:join(skillRoot,'skills'),home:config.home ?? homedir()}).writable})
  const openRouterCatalog = config.openRouterCatalog || createOpenRouterCatalog({ fetchImpl: config.fetchImpl })
  const readModelCatalog = async () => {
    const [openRouter, artificialAnalysis] = await Promise.all([openRouterCatalog.get(), modelCatalog.get()])
    return mergeModelDirectory({ openRouter, artificialAnalysis })
  }
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
      if (url.pathname.startsWith('/api/')) {
        const refusal = hostGuard(req, 'read')
        if (refusal) return json(res, refusal.status, { schema, error: refusal.error })
      }
      const method = req.method === 'HEAD' ? 'GET' : req.method
      const unknown = refuseUnknownParams(url)
      if (unknown) {
        return json(res, 400, { schema, error: unknown })
      }
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
        // Lean lanes are journals on disk; a lane only the ledger knew is not listed. A lean read that throws is
        // unreadable, not "no lean lanes": its run count is null with the reason, never a zero.
        let runs = []
        let leanSource = { readable: true, absent: null }
        try { runs = lean.listRuns(filters) } catch (err) { leanSource = { readable: false, absent: err?.message || String(err) } }
        const sources = { lean: { ...leanSource, runs: leanSource.readable ? runs.length : null } }
        return json(res, 200, { schema, runs, sources, degraded: !leanSource.readable })
      }
      if (url.pathname === '/api/events') {
        if (method !== 'GET') return json(res, 405, { schema, error: 'method not allowed' }, { allow: 'GET' })
        const after = integer(url.searchParams.get('after'), 0), limit = integer(url.searchParams.get('limit'), 200)
        const phase_id = url.searchParams.has('phase_id') ? integer(url.searchParams.get('phase_id'), null) : undefined
        if (after === null || limit === null || limit < 1 || phase_id === null) return json(res, 400, { schema, error: 'after, limit and phase_id must be integers' })
        const filters = {}
        for (const key of ['type', 'role']) if (url.searchParams.get(key)) filters[key] = url.searchParams.get(key)
        if (phase_id !== undefined) filters.phase_id = phase_id
        const adwId = url.searchParams.get('adw_id') || ''
        if (adwId.startsWith('lean:')) {
          if (phase_id !== undefined) return json(res, 400, { schema, error: 'phase_id is not supported for lean lanes: lean journal rows carry no phase_id' })
          // Lean lanes are journals on disk: answer from the journal.
          const found = lean.resolveLane(adwId.slice('lean:'.length))
          if (!found) return json(res, 200, { schema, events: [], cursor: after, degraded: false, absent: `no lean lane ${adwId.slice('lean:'.length)}` })
          const read = lean.readJournalRows(found)
          if (read.error) return json(res, 200, { schema, events: [], cursor: after, degraded: true, absent: read.error })
          const matching = read.rows.filter((row) => (!filters.type || row.event === filters.type) && (!filters.role || row.role === filters.role)).map((row) => {
            const timestamp = Number.isFinite(row.at) && !Number.isNaN(new Date(row.at).getTime()) ? new Date(row.at).toISOString() : null
            return { ...row, id: row.index + 1, adw_id: adwId, type: row.event ?? null, timestamp, timestamp_reason: timestamp ? null : 'lean journal row carries no timestamp' }
          })
          const events = matching.filter((event) => event.id > after).slice(0, limit)
          return json(res, 200, { schema, events, cursor: events.length ? events.at(-1).id : after, degraded: false, absent: null })
        }
        // The ledger event source is gone: a non-lean lane answers null-with-reason, never a measured zero.
        return json(res, 200, { schema, events: [], cursor: after, degraded: true, absent: 'ledger event source removed: only lean lanes (adw_id lean:<id>) have events' })
      }
      if (url.pathname === '/api/journal') {
        if (method !== 'GET') return json(res, 405, { schema, error: 'method not allowed' }, { allow: 'GET' })
        const journalRepo = url.searchParams.get('repo_slug'), journalTask = url.searchParams.get('task_slug')
        if (!journalRepo || !journalTask) return json(res, 400, { schema, error: 'repo_slug and task_slug are required' })
        const result = journal.readJournal({ repo_slug: journalRepo, task_slug: journalTask, adw_id: url.searchParams.get('adw_id') || '' })
        return json(res, 200, { schema, ...result })
      }
      if (url.pathname === '/api/seat-sessions') {
        if (method !== 'GET') return json(res, 405, { schema, error: 'method not allowed' }, { allow: 'GET' })
        const repo_slug = url.searchParams.get('repo_slug'), task_slug = url.searchParams.get('task_slug')
        if (!repo_slug || !task_slug) return json(res, 400, { schema, error: 'repo_slug and task_slug are required' })
        const identity = lean.identify({ repo_slug, task_slug, adw_id: url.searchParams.get('adw_id') || '' })
        if (!identity.lean) return json(res, 404, { schema, error: 'not a lean lane', sessions: [] })
        if (identity.error) return json(res, 404, { schema, error: identity.error, sessions: [] })
        const { status, ...body } = lean.readSeatSessions(identity.lane, url.searchParams.get('role'))
        return json(res, status, { schema, ...body, ...(status === 200 ? {} : { sessions: [] }) })
      }
      if (url.pathname === '/api/plugin-write-mode') {
        if (method !== 'GET') return json(res, 405, { schema, error:'method not allowed' }, { allow:'GET' })
        return json(res, 200, { schema, ...writeMode, notice: writeMode.writable ? null : PLUGIN_WRITE_NOTICE })
      }
      if (url.pathname === '/api/skill-library') {
        if(method!=='GET') return json(res,405,{schema,error:'method not allowed'},{allow:'GET'})
        return json(res,200,{schema,...skillLibrary.read()})
      }
      if (url.pathname === '/api/skill-library/save' || url.pathname === '/api/skill-rules') {
        if(method!=='POST') return json(res,405,{schema,error:'method not allowed'},{allow:'POST'})
        const refusal=writeGuard(req)
        if(refusal) return json(res,refusal.status,{schema,error:refusal.error})
        if(!writeMode.writable || !pluginWriteTargetMode({target:join(skillRoot,'skills'),home:config.home ?? homedir()}).writable) return json(res,409,pluginWriteRefusal)
        let input
        try { input=await body(req,1572864) } catch(error) { return json(res,400,{schema,error:error.message}) }
        if(!input || typeof input!=='object' || Array.isArray(input)) return json(res,400,{schema,error:'request body must be an object'})
        const isRules=url.pathname==='/api/skill-rules'
        const fields=isRules ? ['map','expected_revision'] : ['name','text','expected_revision']
        const unknown=Object.keys(input).find(key=>!fields.includes(key))
        if(unknown) return json(res,400,{schema,error:`unknown field ${unknown}`})
        const {status,...result}=isRules ? skillLibrary.saveRules(input) : skillLibrary.save(input)
        return json(res,status || 200,{schema,...result})
      }
      if (url.pathname === '/api/agent-library') {
        if (method !== 'GET') return json(res,405,{schema,error:'method not allowed'},{allow:'GET'})
        return json(res,200,{schema,...agentLibrary.read()})
      }
      if (url.pathname === '/api/harness-settings') {
        if(method!=='POST') return json(res,405,{schema,error:'method not allowed'},{allow:'POST'})
        const refusal=writeGuard(req)
        if(refusal) return json(res,refusal.status,{schema,error:refusal.error})
        if(!writeMode.writable) return json(res,409,pluginWriteRefusal)
        if(!pluginWriteTargetMode({target:config.capabilitiesPath ?? join(PROJECT_ROOT,'crew/capabilities.json'),home:config.home ?? homedir()}).writable) return json(res,409,pluginWriteRefusal)
        let input
        try { input=await body(req) } catch(err) { return json(res,400,{schema,error:err.message}) }
        if(!input || typeof input!=='object' || Array.isArray(input)) return json(res,400,{schema,error:'request body must be an object'})
        const unknown=Object.keys(input).find(key=>!['name','default_transport','expected_revision'].includes(key))
        if(unknown) return json(res,400,{schema,error:`unknown field ${unknown}`})
        const {status,...result}=agentLibrary.saveHarness(input)
        return json(res,status || 200,{schema,...result})
      }
      if (url.pathname === '/api/agent-library/save') {
        if (method !== 'POST') return json(res,405,{schema,error:'method not allowed'},{allow:'POST'})
        const refusal=writeGuard(req)
        if(refusal) return json(res,refusal.status,{schema,error:refusal.error})
        if(!writeMode.writable) return json(res,409,pluginWriteRefusal)
        const targetMode=pluginWriteTargetMode({target:join(config.checkout,'agents'),home:config.home ?? homedir()})
        if(!targetMode.writable) return json(res,409,{schema,error:PLUGIN_WRITE_NOTICE})
        let input
        try { input=await body(req, 1572864) } catch(err) { return json(res,400,{schema,error:err.message || 'invalid json'}) }
        if(!input || typeof input!=='object' || Array.isArray(input)) return json(res,400,{schema,error:'request body must be an object'})
        const unknown=Object.keys(input).find(key=>!['filename','text','expected_revision'].includes(key))
        if(unknown) return json(res,400,{schema,error:`unknown field ${unknown}`})
        const {status,...result}=agentLibrary.save(input)
        return json(res,status || 200,{schema,...result})
      }
      if (url.pathname === '/api/agents') {
        if (method !== 'GET') return json(res, 405, { schema, error: 'method not allowed' }, { allow: 'GET' })
        const result = typeof agents.read === 'function' ? await agents.read() : { degraded: true, reasons: ['agents source is unavailable'], agents: [], skills: [], roles: [], prompts: [] }
        return json(res, 200, { schema, ...result })
      }
      if (url.pathname === '/api/agents/propose' || url.pathname === '/api/skills/propose') {
        if (method !== 'POST') return json(res, 405, { schema, error: 'method not allowed' }, { allow: 'POST' })
        const refusal = writeGuard(req)
        if (refusal) return json(res, refusal.status, { schema, error: refusal.error })
        let input
        try { input = await body(req) } catch (err) { return json(res, 400, { schema, error: err.message || 'invalid json' }) }
        if (!input || typeof input !== 'object' || Array.isArray(input)) return json(res, 400, { schema, error: 'request body must be an object' })
        const route = url.pathname === '/api/agents/propose' ? 'agents' : 'skills'
        // One endpoint, two proposals: {role, tier, field, value} edits a crew/agents/<role>.md frontmatter
        // field; {name, entry} proposes a coding_agents register entry. A body with `field` is the first.
        if (route === 'agents' && Object.hasOwn(input, 'field')) {
          const unknownEdit = Object.keys(input).find((key) => !['role', 'tier', 'field', 'value'].includes(key))
          if (unknownEdit) return json(res, 400, { schema, error: `unknown field ${unknownEdit}` })
          if (typeof input.role !== 'string' || typeof input.field !== 'string') return json(res, 400, { schema, error: 'role and field are required strings' })
          if (!Object.hasOwn(input, 'value')) return json(res, 400, { schema, error: 'value is required: only an explicit null clears a tier override' })
          const tier = input.tier ?? null, value = input.value ?? null
          if (tier !== null && typeof tier !== 'string') return json(res, 400, { schema, error: 'tier must be a string or null' })
          if (value !== null && typeof value !== 'string') return json(res, 400, { schema, error: 'value must be a string or null' })
          let agentText = null, readError = null
          const agentPath = join(config.checkout, 'crew/agents', `${input.role}.md`)
          if (AGENT_ROLES.includes(input.role)) {
            try { agentText = readFileSync(agentPath, 'utf8') } catch (err) { readError = `unable to read agent definition: ${err.code || err.message || 'unknown read error'}, at ${agentPath}` }
          }
          const edit = proposeAgentEdit({ agentText, agentPath, readError, role: input.role, tier, field: input.field, value })
          const { afterText, ...editResponse } = edit
          return json(res, 200, { schema, proposal: 'agent-edit', agent_path: `crew/agents/${input.role}.md`, applyable_with: 'git apply / patch -p1', ...editResponse })
        }
        const fields = route === 'agents' ? ['name', 'entry'] : ['role', 'skills']
        const unknownFields = Object.keys(input).filter((field) => !fields.includes(field))
        if (unknownFields.length) return json(res, 400, { schema, error: `unknown field ${unknownFields[0]}` })
        if (route === 'agents' && (typeof input.name !== 'string' || !input.name.trim() || !input.entry || typeof input.entry !== 'object' || Array.isArray(input.entry))) return json(res, 400, { schema, error: 'name and entry object are required' })
        if (route === 'skills' && (typeof input.role !== 'string' || !Array.isArray(input.skills))) return json(res, 400, { schema, error: 'role and skills array are required' })
        let result
        if (route === 'agents') result = await agents.proposeAgent(input)
        else result = await agents.proposeSkills(input)
        const { target_path, after_text, ...response } = result || { ok: false, diff: null, refusals: [{ code: 'source-unavailable', message: 'agents source returned no proposal' }] }
        if (route === 'agents') {
          return json(res, 200, { schema, proposal: 'agents', ...response })
        }
        return json(res, 200, { schema, proposal: 'skills', ...response })
      }
      if (url.pathname === '/api/model-catalog') {
        if (method !== 'GET') return json(res, 405, { schema, error: 'method not allowed' }, { allow: 'GET' })
        return json(res, 200, { schema, ...await readModelCatalog() })
      }
      if (url.pathname === '/api/model-catalog/key') {
        if (method !== 'POST') return json(res, 405, { schema, error: 'method not allowed' }, { allow: 'POST' })
        const refusal = writeGuard(req)
        if (refusal) return json(res, refusal.status, { schema, error: refusal.error })
        let input
        try { input = await body(req) } catch (err) { return json(res, 400, { schema, error: err.message || 'invalid json' }) }
        if (!input || typeof input !== 'object' || Array.isArray(input)) return json(res, 400, { schema, error: 'request body must be an object' })
        try {
          if (input.api_key === null) { modelCatalog.clearApiKey(); return json(res, 200, { schema, ...await readModelCatalog(), persisted:false }) }
          if (input.persist !== undefined && typeof input.persist !== 'boolean') return json(res, 400, { schema, error:'persist must be a boolean' })
          if (input.persist === true && !writeMode.writable) return json(res, 409, pluginWriteRefusal)
          if (input.persist === true) {
            const targetMode = pluginWriteTargetMode({target: config.envFile, home: config.home ?? homedir()})
            if (!targetMode.writable) return json(res, 409, {schema, error: PLUGIN_WRITE_NOTICE, reason: targetMode.reason, basis: targetMode.basis, plugin_root: targetMode.plugin_root})
            saveArtificialAnalysisKey(config.envFile, input.api_key)
            modelCatalog.setPersistentApiKey(input.api_key)
          } else modelCatalog.setApiKey(input.api_key)
        } catch (err) { return json(res, 400, { schema, error: err.message || 'invalid api_key' }) }
        return json(res, 200, { schema, ...await readModelCatalog(), persisted:input.persist === true })
      }
      if (url.pathname === '/api/health') {
        if (method !== 'GET') return json(res, 405, { schema, error: 'method not allowed' }, { allow: 'GET' })
        return json(res, 200, { schema, ...journal.health(), ledger: { readable: false, absent: 'ledger source removed: the visualizer no longer reads the ledger' } })
      }
      if (url.pathname.startsWith('/api/')) return method === 'GET' ? json(res, 404, { schema, error: 'not found' }) : json(res, 405, { schema, error: 'not found' }, { allow: 'GET' })
      if (method !== 'GET' && method !== 'HEAD') return res.writeHead(405, { allow: 'GET, HEAD' }).end()
      return staticResponse(req, res)
    } catch (err) { return json(res, 500, { schema, error: err.message || 'internal error' }) }
  })
  // server.close() alone lets one in-flight request hold the process open with no
  // timeout (h5 F11). This closes THIS server's own sockets and signals no other process.
  const close = () => { server.close(); server.closeIdleConnections(); server.closeAllConnections() }
  process.once('SIGTERM', close); process.once('SIGINT', close)
  server.listen(config.port, config.host, () => {
    const address = server.address()
    process.stdout.write(`${JSON.stringify({ listening: true, port: address.port, crew_root: config.crewRoot, readonly: false, writes: ['project agent definition files when Save agent is explicitly requested', 'harness execution preferences when Save harness settings is explicitly requested', 'skill definitions and selection rules when explicitly saved', 'Artificial Analysis key in the project .env.local when explicitly requested'] })}\n`)
  })
  return { server, agents }
}

// For the dist fence above: a path that cannot be realpathed is compared as written.
function realpathOr(path) {
  try { return realpathSync(path) } catch { return path }
}
const invokedDirectly = import.meta.main
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
