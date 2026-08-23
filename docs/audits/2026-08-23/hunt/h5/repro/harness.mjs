// Self-contained harness for the h5-http defect reproductions.
//
// Builds a THROWAWAY tree: `git archive HEAD` from the checkout into a fresh
// mkdtemp directory, plus a throwaway ledger.db / triage db / crew root /
// stop-switch checkout. Nothing here ever writes to the real checkout — the
// only thing it reads from it is `git archive HEAD`.
//
//   CHECKOUT=/path/to/dt-h5 node run-all.mjs
//
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, connect } from 'node:net'

export const CHECKOUT = process.env.CHECKOUT || '/Users/x/Development/dt-h5'
export const CRLF = '\r\n'

let scratch = null

/** git archive HEAD into a fresh temp dir, seed a throwaway ledger, return the paths. */
export async function setup() {
  if (scratch) return scratch
  // realpathSync is REQUIRED here, and that is itself evidence for D3: os.tmpdir()
  // on macOS is /var/folders/... and /var is a symlink to /private/var, so an
  // un-realpathed argv[1] makes every boot below a silent exit-0 no-op.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'h5-http-')))
  const repo = join(root, 'repo')
  const state = join(root, 'state')
  mkdirSync(repo, { recursive: true })
  mkdirSync(state, { recursive: true })
  const tar = execFileSync('git', ['archive', 'HEAD'], { cwd: CHECKOUT, maxBuffer: 1 << 28, encoding: 'buffer' })
  execFileSync('tar', ['-x', '-C', repo], { input: tar, maxBuffer: 1 << 28 })

  const { openLedger } = await import(join(repo, 'scripts/factory/ledger.mjs'))
  const ledgerDb = join(state, 'ledger.db')
  const ledger = openLedger({ dbPath: ledgerDb })
  const DONE = 'hunt-done-0000-0000-000000000001'
  const LIVE = 'hunt-live-0000-0000-000000000002'
  ledger.startSession({ adw_id: DONE, repo_slug: 'repo', task_slug: 'finished' })
  ledger.startPhase({ adw_id: DONE, seq: 1, name: 'plan' })
  ledger.endPhase({ adw_id: DONE, seq: 1, status: 'ok' })
  ledger.recordEvent({ adw_id: DONE, type: 'agent_start', phase_id: 1, payload: { role: 'planner', dispatch_id: 'd1' } })
  ledger.recordEvent({ adw_id: DONE, type: 'agent_end', phase_id: 1, payload: { role: 'planner', dispatch_id: 'd1', outcome: 'done' } })
  for (let i = 0; i < 25; i += 1) ledger.recordEvent({ adw_id: DONE, type: 'log', payload: { level: 'info', message: `filler ${i}` } })
  ledger.startAgentSession({ adw_id: DONE, dispatch_id: 'd1', role: 'planner', model: 'test-model', claude_session_id: 'c1', transcript_path: '/tmp/c1.jsonl' })
  ledger.endAgentSession({ adw_id: DONE, claude_session_id: 'c1', context_tokens: 10, context_window: 20, raw_read_tokens: 1, raw_written_tokens: 1, billed_input_tokens: 10, billed_output_tokens: 4, billed_cache_write_tokens: 2, billed_cache_read_tokens: 1 })
  const recent = new Date(Date.now() - 3600e3).toISOString()
  ledger.recordCellFailure({ provider: 'anthropic', model_id: 'hunt-cell', agent: 'claude', effort: 'high', role: 'planner', kind: 'timeout', adw_id: DONE, created_at: recent })
  ledger.recordSeatTeardown?.({ adw_id: DONE, phase_id: 1, role: 'planner', transport: 'pane', outcome: 'proven', reason: 'done', forced: 0, evidence_kind: 'pane-gone', created_at: recent })
  ledger.recordIntakeSweep?.({ outcome: 'picked', reason: null, considered: 1, pages: 1, picked_issue: 1, board_owner: 'o', board_project: 'p', created_at: recent })
  ledger.endSession({ adw_id: DONE, status: 'ok' })
  ledger.startSession({ adw_id: LIVE, repo_slug: 'repo', task_slug: 'live' })
  ledger.startPhase({ adw_id: LIVE, seq: 1, name: 'plan' })
  ledger.close()

  const crewRoot = join(state, 'crew')
  const taskDir = join(crewRoot, 'repo', 'finished')
  mkdirSync(join(taskDir, 'ledger'), { recursive: true })
  mkdirSync(join(taskDir, 'returns'), { recursive: true })
  writeFileSync(join(taskDir, 'ledger', 'run.json'), JSON.stringify({ adw_id: DONE, repo_slug: 'repo', task_slug: 'finished' }))
  writeFileSync(join(taskDir, 'returns', 'd1.planner.json'), JSON.stringify({ assignment_id: 'd1', role: 'planner', status: 'done', summary: 's', artifacts: [], details: {} }))
  mkdirSync(join(state, 'checkout'), { recursive: true })

  scratch = { root, repo, state, ledgerDb, crewRoot, DONE, LIVE, checkout: join(state, 'checkout'), triageDb: join(state, 'visualizer.db') }
  return scratch
}

export function teardown() { if (scratch) { rmSync(scratch.root, { recursive: true, force: true }); scratch = null } }

/** Spawn the archived server on an EPHEMERAL port (0) against the throwaway state. */
export async function boot(extra = [], env = {}) {
  const s = await setup()
  const args = [join(s.repo, 'visualizer/server/server.mjs'), '--port', '0',
    '--ledger-db', s.ledgerDb, '--triage-db', s.triageDb,
    '--crew-root', s.crewRoot, '--checkout', s.checkout, ...extra]
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } })
  return new Promise((res, rej) => {
    let out = '', err = ''
    const t = setTimeout(() => rej(new Error('server never announced a port: ' + err)), 10000)
    child.stdout.on('data', (c) => {
      out += c
      for (const line of out.split('\n')) {
        try { const v = JSON.parse(line); if (v.listening) { clearTimeout(t); res({ child, base: `http://127.0.0.1:${v.port}`, port: v.port, announce: v }); return } } catch {}
      }
    })
    child.stderr.on('data', (c) => { err += c })
    child.once('exit', (code) => { clearTimeout(t); rej(new Error(`server exited ${code}: ${err}`)) })
  })
}

export async function hit(base, path, options) {
  const r = await fetch(base + path, options)
  const text = await r.text()
  let body; try { body = JSON.parse(text) } catch { body = text }
  return { status: r.status, headers: Object.fromEntries(r.headers), body, text }
}

/** Send a raw request line + headers and return whatever comes back. */
export function raw(port, text, wait = 700) {
  return new Promise((res) => {
    const sock = connect(port, '127.0.0.1', () => sock.write(text))
    let buf = ''
    sock.on('data', (c) => { buf += c })
    const t = setTimeout(() => { sock.destroy(); res(buf) }, wait)
    sock.on('close', () => { clearTimeout(t); res(buf) })
    sock.on('error', (e) => { clearTimeout(t); res(`SOCKET-ERROR ${e.code}`) })
  })
}

export function portFree(port) {
  return new Promise((res) => {
    const s = createServer()
    s.once('error', (e) => res(`still bound (${e.code})`))
    s.once('listening', () => s.close(() => res('free')))
    s.listen(port, '127.0.0.1')
  })
}

export const banner = (n, title) => console.log(`\n${'='.repeat(72)}\nD${n} — ${title}\n${'='.repeat(72)}`)
