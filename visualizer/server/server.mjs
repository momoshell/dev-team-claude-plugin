#!/usr/bin/env node
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createFeed } from './feed.mjs'
import { createReturnsSource } from './returns-source.mjs'
import { createRosterSource } from './roster-source.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = resolve(ROOT, 'web', 'dist')
const schema = 1

function defaults() {
  const dir = process.env.DEVTEAM_LEDGER_DIR || join(homedir(), '.dev-team', 'factory')
  return { port: Number(process.env.DEVTEAM_VIZ_PORT) || 4488, host: '127.0.0.1', ledgerDb: process.env.DEVTEAM_LEDGER_DB || join(dir, 'ledger.db'), triageDb: undefined, crewRoot: process.env.DEVTEAM_CREW_ROOT || join(homedir(), '.crew'), rosterPath: process.env.DEVTEAM_ROSTER_PATH || undefined }
}
function args(argv) {
  const out = defaults()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--port') out.port = Number(argv[++i])
    else if (arg === '--host') out.host = argv[++i]
    else if (arg === '--ledger-db') out.ledgerDb = argv[++i]
    else if (arg === '--triage-db') out.triageDb = argv[++i]
    else if (arg === '--crew-root') out.crewRoot = argv[++i]
    else if (arg === '--roster') out.rosterPath = argv[++i]
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
    process.stdout.write(`${JSON.stringify({ listening: true, port: address.port, ledger_db: config.ledgerDb, triage_db: config.triageDb || join(dirname(config.ledgerDb), 'visualizer.db'), crew_root: config.crewRoot, returns_readonly: true, readonly: true })}\n`)
  })
  return { server, feed }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) startServer(args(process.argv.slice(2)))
