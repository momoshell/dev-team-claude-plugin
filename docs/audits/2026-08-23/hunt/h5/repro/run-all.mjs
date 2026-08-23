// h5-http — every reproduction, in severity order. Nothing here writes to the
// checkout; everything runs against `git archive HEAD` in a temp dir.
//
//   CHECKOUT=/Users/x/Development/dt-h5 node run-all.mjs
//
import { boot, hit, raw, portFree, setup, teardown, banner, CRLF } from './harness.mjs'
import { execFileSync, spawn } from 'node:child_process'
import { connect } from 'node:net'
import { symlinkSync, existsSync, rmSync, realpathSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const s = await setup()
console.log('scratch tree :', s.root)
console.log('server under test:', join(s.repo, 'visualizer/server/server.mjs'))

const kill = (c) => { try { c.kill('SIGKILL') } catch {} }
const raced = (p, ms, fallback) => Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))])

/* ------------------------------------------------------------------ D1 */
banner(1, 'a request for the path "//" kills the server (server.mjs:178, outside the try)')
{
  for (const target of ['/', '//', '///', '//a', '//?x=1', '/a//b']) {
    const { child, port } = await boot()
    const exited = new Promise((r) => child.once('exit', (c) => r(`DIED exit ${c}`)))
    const got = raw(port, `GET ${target} HTTP/1.1${CRLF}Host: 127.0.0.1${CRLF}Connection: close${CRLF}${CRLF}`, 500)
    const verdict = await raced(exited, 800, 'survived')
    console.log(`  GET ${target.padEnd(8)} -> ${String(verdict).padEnd(14)} client saw: ${((await got).split(CRLF)[0]) || '(nothing at all)'}`)
    kill(child)
  }
  const { child, base, port } = await boot()
  const exited = new Promise((r) => child.once('exit', (c) => r(`DIED exit ${c}`)))
  let stderr = ''; child.stderr.on('data', (c) => { stderr += c })
  let curl = ''
  try { curl = execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', `${base}//`], { encoding: 'utf8' }) }
  catch (e) { curl = `curl: ${(e.stderr || e.message).toString().trim().split('\n')[0]}` }
  console.log(`\n  through an ordinary client: curl ${base}//  ->  ${curl || '(nothing)'}`)
  console.log('  server:', await raced(exited, 800, 'survived'))
  console.log('  port after the crash:', await portFree(port))
  console.log('  stderr:\n' + stderr.split('\n').slice(0, 8).map((l) => '    ' + l).join('\n'))
  kill(child)
}

/* ------------------------------------------------------------------ D2 */
banner(2, 'a malformed Host header kills the server — same line, same cause')
{
  for (const h of ['127.0.0.1:1', ']bad[', 'a:b:c', '%', 'ho st', '[::1', '@', 'x:99999999', 'a b']) {
    const { child, port } = await boot()
    const exited = new Promise((r) => child.once('exit', (c) => r(`DIED exit ${c}`)))
    const got = raw(port, `GET /api/health HTTP/1.1${CRLF}Host: ${h}${CRLF}Connection: close${CRLF}${CRLF}`, 500)
    const verdict = await raced(exited, 800, 'survived')
    console.log(`  Host: ${JSON.stringify(h).padEnd(16)} -> ${String(verdict).padEnd(14)} client saw: ${((await got).split(CRLF)[0]) || '(nothing at all)'}`)
    kill(child)
  }
  console.log('\n  an in-flight client during the crash:')
  const { child, base, port } = await boot()
  const exited = new Promise((r) => child.once('exit', (c) => r(`DIED exit ${c}`)))
  const ka = connect(port, '127.0.0.1')
  await new Promise((r) => ka.once('connect', r))
  ka.write(`GET /api/health HTTP/1.1${CRLF}Host: x${CRLF}${CRLF}`)
  await new Promise((r) => ka.once('data', r))
  ka.on('close', () => console.log('    the innocent keep-alive client was dropped'))
  raw(port, `GET /api/health HTTP/1.1${CRLF}Host: ]bad[${CRLF}Connection: close${CRLF}${CRLF}`, 400)
  console.log('   ', await raced(exited, 1500, 'survived'))
  try { console.log('    a later request:', (await fetch(base + '/api/health')).status) }
  catch (e) { console.log('    a later request:', e.cause?.code || e.message) }
  ka.destroy(); kill(child)
}

/* ------------------------------------------------------------------ D3 */
banner(3, 'invoking the CLI through a symlinked path is a silent no-op (server.mjs:419)')
{
  const LINKDIR = join(s.root, 'repo-link')
  const LINKFILE = join(s.root, 'server-link.mjs')
  for (const [p, t] of [[LINKDIR, s.repo], [LINKFILE, join(s.repo, 'visualizer/server/server.mjs')]]) {
    if (existsSync(p)) rmSync(p)
    symlinkSync(t, p)
  }
  const ARGS = ['--port', '0', '--ledger-db', s.ledgerDb, '--triage-db', s.triageDb]
  const run = (script, args, cwd) => new Promise((res) => {
    const c = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'], cwd })
    let o = '', e = ''
    c.stdout.on('data', (x) => { o += x }); c.stderr.on('data', (x) => { e += x })
    const t = setTimeout(() => { c.kill('SIGKILL'); res({ exit: 'RUNNING (a server started)', o, e }) }, 2200)
    c.once('exit', (code) => { clearTimeout(t); res({ exit: `exit ${code}`, o, e }) })
  })
  const cases = [
    ['A real absolute path  + valid flags', join(s.repo, 'visualizer/server/server.mjs'), ARGS, undefined],
    ['B symlinked DIRECTORY + valid flags', join(LINKDIR, 'visualizer/server/server.mjs'), ARGS, undefined],
    ['C symlinked FILE      + valid flags', LINKFILE, ARGS, undefined],
    ['D real absolute path  + BAD flag   ', join(s.repo, 'visualizer/server/server.mjs'), ['--untill', 'x'], undefined],
    ['E symlinked DIRECTORY + BAD flag   ', join(LINKDIR, 'visualizer/server/server.mjs'), ['--untill', 'x'], undefined],
    ['F symlinked FILE      + BAD flag   ', LINKFILE, ['--untill', 'x'], undefined],
    ['G symlinked CWD, RELATIVE argv[1]  ', 'visualizer/server/server.mjs', ['--untill', 'x'], LINKDIR],
    ['H real CWD,      RELATIVE argv[1]  ', 'visualizer/server/server.mjs', ['--untill', 'x'], s.repo],
  ]
  for (const [label, script, args, cwd] of cases) {
    const r = await run(script, args, cwd)
    console.log(`  ${label} -> ${r.exit}`)
    console.log(`     stdout: ${(r.o.trim().split('\n')[0] || '(empty)').slice(0, 90)}`)
    console.log(`     stderr: ${(r.e.trim().split('\n')[0] || '(empty)').slice(0, 110)}`)
  }
  console.log('\n  why: server.mjs:419 compares resolve(argv[1]) with resolve(fileURLToPath(import.meta.url)).')
  console.log('    argv[1]                :', join(LINKDIR, 'visualizer/server/server.mjs'))
  console.log('    import.meta.url (realpathed by the ESM loader):', realpathSync(join(LINKDIR, 'visualizer/server/server.mjs')))
  console.log('  G vs H is the answer to "does a symlinked CWD change behaviour": NO — process.cwd()')
  console.log('  is already the realpath, so both sides agree. Only a symlink INSIDE argv[1] breaks it.')
  console.log('  On macOS /tmp is a symlink to /private/tmp, so a checkout under /tmp reproduces D3 with')
  console.log('  no hand-made link at all.')
}

/* ------------------------------------------------------------------ D4 */
banner(4, 'the window routes validate with Date.parse but query with a STRING compare')
{
  const { child, base } = await boot()
  const rows = []
  for (const since of ['2020-01-01T00:00:00.000Z', 'Jan 1 2020', 'Wed, 01 Jan 2020 00:00:00 GMT']) {
    const rs = await hit(base, `/api/run-set?since=${encodeURIComponent(since)}`)
    const ch = await hit(base, `/api/cell-health?since=${encodeURIComponent(since)}`)
    const recorded = (ch.body.cells || []).filter((c) => c.state === 'recorded')
    rows.push(`  since=${JSON.stringify(since).padEnd(34)} run-set: HTTP ${rs.status} runs=${rs.body.runs} absent=${JSON.stringify(rs.body.absent)}  |  cell-health: cells=${(ch.body.cells || []).length} recorded=${recorded.length}`)
  }
  console.log(rows.join('\n'))
  console.log('\n  All three name the SAME instant. The ISO one answers the data; the two')
  console.log('  Date.parse-valid non-ISO ones answer a MEASURED ZERO (absent: null) because')
  console.log("  'J'/'W' sort above '2' in the SQL string comparison at ledger-feed.mjs:148/187/314.")
  console.log('\n  and /api/sessions does not validate at all:')
  for (const q of ['', '?since=-1', '?since=1e309', '?since=zzz', '?since=2030-01-01T00:00:00.000Z&until=2020-01-01T00:00:00.000Z']) {
    const r = await hit(base, `/api/sessions${q}`)
    console.log(`    /api/sessions${(q || ' (none)').padEnd(62)} HTTP ${r.status} runs=${(r.body.runs || []).length}`)
  }
  console.log('    the same since=1e309 on a sibling route:')
  const sib = await hit(base, '/api/cell-health?since=1e309')
  console.log(`    /api/cell-health?since=1e309${''.padEnd(48)} HTTP ${sib.status} ${JSON.stringify(sib.body.error)}`)
  kill(child)
}

/* ------------------------------------------------------------------ D5 */
banner(5, 'no route refuses an unknown query parameter — the --untill typo class')
{
  const { child, base } = await boot()
  // an `until` INSIDE the default window, so the intended request is a clean 200.
  const UNTIL = new Date(Date.now() - 1800e3).toISOString()
  for (const route of ['/api/cell-health', '/api/run-set', '/api/intake', '/api/seat-teardowns', '/api/cell-attribution']) {
    const good = `${route}?until=${UNTIL}`, typo = `${route}?untill=${UNTIL}`
    const a = await hit(base, good), b = await hit(base, typo)
    console.log(`  intended ${good}`)
    console.log(`     -> HTTP ${a.status} window.until=${JSON.stringify(a.body.window?.until ?? a.body.error)}`)
    console.log(`  typo     ${typo}`)
    console.log(`     -> HTTP ${b.status} window.until=${JSON.stringify(b.body.window?.until ?? b.body.error)}   <-- the bound was silently dropped`)
  }
  const e1 = await hit(base, `/api/events?adw_id=${s.DONE}&limit=1`)
  const e2 = await hit(base, `/api/events?adw_id=${s.DONE}&limitt=1`)
  console.log(`\n  /api/events?limit=1  -> ${(e1.body.events || []).length} events`)
  console.log(`  /api/events?limitt=1 -> ${(e2.body.events || []).length} events   <-- the cap was silently dropped`)
  kill(child)
}

/* ------------------------------------------------------------------ D6 */
banner(6, '/api/events cannot tell "no events" from "the ledger cannot be opened"')
{
  const a = await boot()
  console.log('  healthy ledger, a run with no events after id 999999:')
  console.log('   ', (await hit(a.base, `/api/events?adw_id=${s.DONE}&after=999999`)).text)
  console.log('    control /api/sessions degraded:', (await hit(a.base, '/api/sessions')).body.degraded)
  kill(a.child)
  const b = await boot(['--ledger-db', join(s.state, 'no-such.db')])
  console.log('  UNOPENABLE ledger, the identical request:')
  console.log('   ', (await hit(b.base, `/api/events?adw_id=${s.DONE}&after=999999`)).text)
  console.log('    control /api/sessions degraded:', (await hit(b.base, '/api/sessions')).body.degraded)
  console.log('    control /api/cell-health absent:', JSON.stringify((await hit(b.base, '/api/cell-health')).body.absent))
  console.log('  ^ the two /api/events bodies are byte-identical. ledger-feed.mjs:102 returns')
  console.log('    { events: [], cursor: after } with no degraded and no absent.')
  kill(b.child)
}

/* ------------------------------------------------------------------ D7 */
banner(7, 'state-writing routes take a CORS simple request — no Origin, no content-type check')
{
  const stopDir = join(s.checkout, '.factory')
  rmSync(stopDir, { recursive: true, force: true })
  const { child, base } = await boot()
  console.log('  GET /api/intake/brake ->', JSON.parse((await hit(base, '/api/intake/brake')).text).state)
  const r = await fetch(base + '/api/intake/brake', {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=UTF-8', origin: 'https://evil.example', referer: 'https://evil.example/page' },
    body: JSON.stringify({ engaged: true, actor: 'evil.example' }),
  })
  const body = JSON.parse(await r.text())
  console.log('  POST with content-type: text/plain and Origin: https://evil.example')
  console.log(`    -> HTTP ${r.status} ok=${body.ok} state=${body.state} recorded=${body.recorded}`)
  console.log('  stop switch on disk:', existsSync(join(stopDir, 'STOP')) ? 'ENGAGED' : 'clear')
  if (existsSync(join(stopDir, 'STOP'))) console.log('    ', readFileSync(join(stopDir, 'STOP'), 'utf8').trim())
  const t = await fetch(base + '/api/triage', { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8', origin: 'https://evil.example' }, body: JSON.stringify({ adw_id: 'csrf', reviewed: true }) })
  console.log('  POST /api/triage from the same origin ->', t.status, (await t.text()).slice(0, 120))
  console.log('  (a no-cors POST never needs to READ the reply — the write has already happened)')
  kill(child)
}

/* ------------------------------------------------------------------ D8 */
banner(8, 'SIGTERM never returns while one request is in flight')
{
  async function scenario(name, prepare) {
    const { child, base, port } = await boot()
    const cleanup = await prepare(base, port)
    const t0 = Date.now()
    child.kill('SIGTERM')
    const outcome = await raced(new Promise((r) => child.once('exit', (c, sig) => r(`exit ${c}/${sig} after ${Date.now() - t0}ms`))), 5000, 'STILL RUNNING after 5000ms')
    console.log(`  ${name.padEnd(44)} ${String(outcome).padEnd(34)} port: ${await portFree(port)}`)
    try { cleanup?.() } catch {}
    kill(child)
    await new Promise((r) => setTimeout(r, 120))
  }
  await scenario('1. no connections', async () => {})
  await scenario('2. one IDLE keep-alive socket', async (base, port) => {
    const sock = connect(port, '127.0.0.1')
    await new Promise((r) => sock.once('connect', r))
    sock.write(`GET /api/health HTTP/1.1${CRLF}Host: x${CRLF}${CRLF}`)
    await new Promise((r) => sock.once('data', r))
    return () => sock.destroy()
  })
  await scenario('3. socket open, no bytes sent', async (base, port) => {
    const sock = connect(port, '127.0.0.1')
    await new Promise((r) => sock.once('connect', r))
    return () => sock.destroy()
  })
  await scenario('4. IN-FLIGHT request (dribbled POST body)', async (base, port) => {
    const sock = connect(port, '127.0.0.1')
    await new Promise((r) => sock.once('connect', r))
    sock.write(`POST /api/triage HTTP/1.1${CRLF}Host: x${CRLF}content-type: application/json${CRLF}content-length: 40${CRLF}${CRLF}{"adw`)
    await new Promise((r) => setTimeout(r, 300))
    return () => sock.destroy()
  })
  console.log('\n  the port frees but the PROCESS lives on holding the ledger + triage handles,')
  console.log('  so a restart rebinds while an orphan still holds the sqlite files.')
  console.log('  a second SIGTERM does kill it (process.once removed the listener, restoring')
  console.log('  the default disposition) — but then nothing ever calls feed.close().')
  const { child, port } = await boot()
  const sock = connect(port, '127.0.0.1')
  await new Promise((r) => sock.once('connect', r))
  sock.write(`POST /api/triage HTTP/1.1${CRLF}Host: x${CRLF}content-length: 40${CRLF}${CRLF}{"adw`)
  await new Promise((r) => setTimeout(r, 250))
  const dead = new Promise((r) => child.once('exit', (c, sig) => r(`exit ${c}/${sig}`)))
  child.kill('SIGTERM'); console.log('  after 1st SIGTERM:', await raced(dead, 1200, 'alive'))
  child.kill('SIGTERM'); console.log('  after 2nd SIGTERM:', await raced(dead, 1200, 'alive'))
  sock.destroy(); kill(child)
}

/* ------------------------------------------------------------------ D9 */
banner(9, '/api/triage 500s on a JSON null body; /api/events 500s on a big limit')
{
  const { child, base } = await boot()
  for (const [label, path, body] of [
    ['triage null  ', '/api/triage', 'null'],
    ['triage []    ', '/api/triage', '[]'],
    ['triage 5     ', '/api/triage', '5'],
    ['brake  null  ', '/api/intake/brake', 'null'],
    ['propose null ', '/api/roster/propose', 'null'],
    ['stage  null  ', '/api/roster/ladder/stage', 'null'],
    ['compose null ', '/api/roster/ladder/compose', 'null'],
  ]) {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    console.log(`  ${label} -> ${r.status} ${(await r.text()).slice(0, 110)}`)
  }
  const big = await hit(base, `/api/events?adw_id=${s.DONE}&limit=99999999999999999999999`)
  console.log(`\n  /api/events?limit=99999999999999999999999 -> ${big.status} ${big.text.slice(0, 110)}`)
  const after = await hit(base, `/api/events?adw_id=${s.DONE}&after=99999999999999999999999`)
  console.log(`  /api/events?after=99999999999999999999999 -> ${after.status} ${after.text.slice(0, 110)}`)
  const replay = await hit(base, `/api/events?adw_id=${s.DONE}&after=${after.body.cursor}`)
  console.log(`  replaying the cursor it just handed back (after=${after.body.cursor}) -> ${replay.status} ${replay.text.slice(0, 110)}`)
  kill(child)
}

/* ----------------------------------------------------------------- D10 */
banner(10, 'a symlink inside web/dist escapes the DIST fence (resolve, not realpath)')
{
  mkdirSync(join(s.repo, 'visualizer/web/dist/assets'), { recursive: true })
  writeFileSync(join(s.repo, 'visualizer/web/dist/index.html'), '<!doctype html><title>real index</title>')
  writeFileSync(join(s.repo, 'visualizer/web/dist/assets/app.js'), 'console.log("app")')
  writeFileSync(join(s.root, 'secret.txt'), 'TOP SECRET')
  mkdirSync(join(s.root, 'outside'), { recursive: true })
  writeFileSync(join(s.root, 'outside/x.txt'), 'OUTSIDE FILE')
  for (const [link, target] of [['visualizer/web/dist/leak.txt', join(s.root, 'secret.txt')], ['visualizer/web/dist/out', join(s.root, 'outside')]]) {
    const p = join(s.repo, link)
    if (existsSync(p)) rmSync(p)
    symlinkSync(target, p)
  }
  const { child, base } = await boot()
  for (const p of ['/', '/assets/app.js', '/nope.js', '/../../../etc/passwd', '/%2e%2e%2f%2e%2e%2fetc%2fpasswd', '/..%2f..%2fetc%2fpasswd', '/leak.txt', '/out/x.txt']) {
    const r = await hit(base, p)
    console.log(`  ${String(r.status).padEnd(4)} ${p.padEnd(34)} ${JSON.stringify(String(r.text).slice(0, 46))}`)
  }
  console.log('  ^ lexical traversal is correctly refused; a SYMLINK inside dist is not.')
  console.log('    server.mjs:159 compares resolve()d strings, which never follow a symlink.')
  kill(child)
}

/* ----------------------------------------------------------------- D11 */
banner(11, '/api/returns says "no task directory" about a directory that exists')
{
  const { child, base } = await boot()
  for (const q of ['', `&adw_id=${s.DONE}`, '&adw_id=wrong-id']) {
    const r = await hit(base, `/api/returns?repo_slug=repo&task_slug=finished${q}`)
    const b = r.body
    console.log(`  adw_id=${JSON.stringify(q.split('=')[1] ?? '(omitted)').padEnd(38)} HTTP ${r.status} error=${JSON.stringify(b.error)} dir=${b.dir ? 'present' : 'null'} envelopes=${(b.envelopes || []).length}`)
  }
  console.log(`  the directory really is there: ${join(s.crewRoot, 'repo/finished')}`)
  console.log('  returns-source.mjs:36-45 — when a candidate HAS a run.json whose adw_id does not')
  console.log('  match, hasRun is true, so the "unverified fallback" branch is skipped and the')
  console.log('  answer becomes a claim of absence that is simply false.')
  kill(child)
}

/* ----------------------------------------------------------------- D12 */
banner(12, 'HEAD is 405 on every /api route; no 405 carries an Allow header')
{
  const { child, port } = await boot()
  for (const r of ['/api/health', '/api/sessions', '/api/triage', '/']) {
    const line = []
    for (const m of ['HEAD', 'OPTIONS', 'DELETE']) {
      const out = await raw(port, `${m} ${r} HTTP/1.1${CRLF}Host: x${CRLF}Connection: close${CRLF}${CRLF}`, 400)
      line.push(`${m}=${(out.split(CRLF)[0] || '?').replace('HTTP/1.1 ', '')}${/^allow:/im.test(out) ? ' +Allow' : ''}`)
    }
    console.log(`  ${r.padEnd(16)} ${line.join(' | ')}`)
  }
  console.log('  RFC 9110: HEAD must be supported wherever GET is, and a 405 must send Allow.')
  kill(child)
}

/* ------------------------------------------------------- negative results */
banner('N', 'attacks the code SURVIVED (do not re-run these)')
{
  const { child, base, port } = await boot()
  const alive = async () => { try { return (await fetch(base + '/api/health')).status } catch (e) { return 'DEAD ' + (e.cause?.code || e.message) } }
  for (let i = 0; i < 20; i += 1) {
    const s2 = connect(port, '127.0.0.1', () => { s2.write(`GET /api/sessions HTTP/1.1${CRLF}Host: x${CRLF}${CRLF}`); setImmediate(() => (s2.resetAndDestroy?.() ?? s2.destroy())) })
    s2.on('error', () => {})
  }
  await new Promise((r) => setTimeout(r, 600))
  console.log('  20 connections reset mid-response      ->', await alive())
  for (let i = 0; i < 10; i += 1) { const ac = new AbortController(); fetch(base + '/api/triage', { method: 'POST', body: '{"adw_id":"x","reviewed":true}', signal: ac.signal }).catch(() => {}); setTimeout(() => ac.abort(), 1) }
  await new Promise((r) => setTimeout(r, 600))
  console.log('  10 POSTs aborted mid-body              ->', await alive())
  const panels = ['/api/sessions', '/api/cell-health', '/api/run-set', '/api/intake', '/api/seat-teardowns', '/api/cell-attribution', '/api/roster', '/api/roster/ladder', '/api/health']
  const rs = await Promise.all(panels.flatMap((p) => Array.from({ length: 40 }, () => hit(base, p).then((r) => r.status).catch(() => 'ERR'))))
  console.log(`  360 concurrent panel reads (2 clients) -> statuses: ${[...new Set(rs)].join(',')}`)
  const ws = await Promise.all(Array.from({ length: 60 }, (_, i) => fetch(base + '/api/triage', { method: 'POST', body: JSON.stringify({ adw_id: `race-${i % 3}`, reviewed: i % 2 === 0 }) }).then((r) => r.status).catch(() => 'ERR')))
  console.log(`  60 concurrent triage WRITES            -> statuses: ${[...new Set(ws)].join(',')}`)
  for (const size of [8000, 20000]) {
    const out = await raw(port, `GET /api/health HTTP/1.1${CRLF}Host: x${CRLF}X-Big: ${'a'.repeat(size)}${CRLF}Connection: close${CRLF}${CRLF}`, 600)
    console.log(`  ${String(size).padStart(6)}-byte header             -> ${(out.split(CRLF)[0] || '(no response)')}`)
  }
  for (const p of ['/api/sessions', '/api/health', '/']) {
    const out = await raw(port, `GET ${p} HTTP/1.1${CRLF}Host: x${CRLF}Content-Length: 7${CRLF}Connection: close${CRLF}${CRLF}{"x":1}`, 600)
    console.log(`  GET ${p.padEnd(14)} with a body        -> ${(out.split(CRLF)[0] || '(no response)')}`)
  }
  console.log(`  "' OR 1=1 --" as status/mode/type      -> ${(await hit(base, "/api/sessions?status=' OR 1=1 --")).status} (parameterised; 0 rows)`)
  console.log('  --port -1 / 1e309 / 99999 / 0x50       -> exit 2 refusals (parsePort, #474)')
  console.log('  DEVTEAM_VIZ_PORT=-1 / 99999            -> exit 2 refusals (portFromEnv, #474)')
  console.log('  unknown/short/positional CLI args      -> exit 2 refusals (parseCliArgs, #443)')
  console.log('  panelReadLoop (panels.js:43-50)        -> a plain setInterval; a rejected read sets')
  console.log('                                            `error` and leaves read_at alone, so a bounce')
  console.log('                                            shows the failure AND goes visibly stale, and')
  console.log('                                            the next tick recovers. Truthful.')
  kill(child)
}

console.log(`\nscratch tree left at ${s.root} (delete it when you are done)`)
if (process.env.KEEP !== '1') teardown()
