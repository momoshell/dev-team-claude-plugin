import assert from 'node:assert/strict'
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Executed by the loop from the repository root; all fixtures are task artifacts.
const ids = ['LV1', 'LV2', 'LV3', 'LV4']
const failures = new Map()
const artifactDir = dirname(fileURLToPath(import.meta.url))
const repo = resolve(process.cwd())
const synthetic = lane => `lean:${lane}`
const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) }
const putJson = (file, value) => put(file, JSON.stringify(value))
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
const message = error => String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 750)

function digest(root) {
  const hash = createHash('sha256')
  function walk(path, relative = '') {
    const st = lstatSync(path)
    hash.update(JSON.stringify([relative, st.mode, st.mtimeMs]))
    if (st.isSymbolicLink()) hash.update(readlinkSync(path))
    else if (st.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name), `${relative}/${name}`)
    else hash.update(readFileSync(path))
  }
  walk(root)
  return hash.digest('hex')
}

function fixture(sandbox) {
  const crewRoot = join(sandbox, '.crew')
  const archiveRoot = join(sandbox, '.crew-journal-archive')
  mkdirSync(crewRoot); mkdirSync(archiveRoot)
  const members = Object.fromEntries(['planner', 'builder', 'lead'].map(role => [role, { agent: 'pi', model: 'fixture/model', transport: 'lean-acp' }]))
  const lane = (name, rows, { root = crewRoot, suffix = '', torn = false } = {}) => {
    const dir = join(root, `dt-${name}`, `${name}${suffix}`)
    putJson(join(dir, 'crew.json'), { members })
    putJson(join(dir, 'task', 'lean.json'), {
      id: name, tier: 'build', shape: 'standard', acceptance: ids,
      cwd: '/stale-checkout-must-not-be-read', taskDir: '/stale-task-must-not-be-read',
      branch: name, base: 'main', source: 'gate fixture', brief: 'fixture',
      suite: { command: 'node', args: ['--test'] },
    })
    put(join(dir, 'task', 'journal.jsonl'), torn ? jsonl(rows.slice(0, 1)) + '{torn\n' + jsonl(rows.slice(1)) : jsonl(rows))
    put(join(dir, 'journal.jsonl'), jsonl([{ event: 'decoy-root-journal', stage: 'wrong-layout' }]))
    return { name, dir, rows }
  }
  const open = lane('lv-open', [
    { event: 'stage-start', lane: 'lv-open', stage: 'plan' },
    { event: 'stage-end', lane: 'lv-open', stage: 'plan', outcome: { status: 'done' } },
    { event: 'verdict', lane: 'lv-open', stage: 'review', status: 'reviewed', verdict: 'pass' },
    { event: 'stage-start', lane: 'lv-open', stage: 'build' },
    { event: 'check', lane: 'lv-open', stage: 'build', check: 'smoke', result: { status: 'green' } },
  ], { torn: true })
  const stoppedRows = name => [
    { event: 'stage-start', lane: name, stage: 'build' },
    { event: 'stage-end', lane: name, stage: 'build', outcome: { code: 1 } },
    { event: 'verdict', lane: name, stage: 'build', status: 'stopped', reason: 'runner-threw' },
  ]
  const stopped = lane('lv-stopped', stoppedRows('lv-stopped'))
  const done = lane('lv-done', [
    { event: 'stage-start', lane: 'lv-done', stage: 'publish' },
    { event: 'stage-end', lane: 'lv-done', stage: 'publish' },
    { event: 'verdict', lane: 'lv-done', stage: 'publish', status: 'done', reason: 'recorded-terminal-reason' },
  ])
  const published = lane('lv-pr', [
    { event: 'verdict', lane: 'lv-pr', stage: 'review', status: 'reviewed', verdict: 'pass' },
    { event: 'stage-start', lane: 'lv-pr', stage: 'publish' },
    { event: 'stage-end', lane: 'lv-pr', stage: 'publish' },
    { event: 'pr', lane: 'lv-pr', stage: 'start', pr: { number: 17, url: 'https://github.com/example/fixture/pull/17' } },
  ])
  const archived = lane('lv-archived', stoppedRows('lv-archived'), { root: archiveRoot })
  lane('lv-open', stoppedRows('lv-open'), { root: archiveRoot }) // Live must win.
  lane('lv-open', stoppedRows('lv-open'), { suffix: '.archive-2026-10-31T00-00-00-000Z' })
  lane('lv-sibling', [{ event: 'stage-start', lane: 'lv-sibling', stage: 'old-stage' }], { suffix: '.archive-2026-10-01T00-00-00-000Z' })
  const sibling = lane('lv-sibling', [{ event: 'stage-start', lane: 'lv-sibling', stage: 'gate' }], { suffix: '.archive-2026-10-02T00-00-00-000Z' })
  const recordings = new Map()
  for (const stem of ['10', '2', '1', '1.repair', '1.retry-1']) {
    const file = `lv-open.planner.${stem}.jsonl`
    const raw = jsonl([{ type: 'prompt', text: `planner prompt ${stem}` }, { sessionId: `session-${stem}`, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `planner response ${stem}` } } }])
    put(join(open.dir, 'task', 'lean', 'planner', file), raw)
    recordings.set(`task/lean/planner/${file}`, raw)
  }
  const builderRaw = jsonl([{ type: 'prompt', text: 'BUILDER_ONLY_RECORDING' }])
  put(join(open.dir, 'task', 'lean', 'builder', 'lv-open.builder.1.jsonl'), builderRaw)
  // A listed .jsonl symlink must not be allowed to escape the resolved lane.
  const secret = join(sandbox, 'outside-lane.jsonl')
  put(secret, 'OUTSIDE_LANE_SECRET\n')
  symlinkSync(secret, join(open.dir, 'task', 'lean', 'planner', 'lv-open.planner.11.jsonl'))
  put(join(open.dir, 'task', 'lean', 'planner', 'not-a-recording.txt'), 'IGNORE_NON_JSONL')
  const archiveRaw = jsonl([{ type: 'prompt', text: 'archived planner session' }])
  put(join(archived.dir, 'task', 'lean', 'planner', 'lv-archived.planner.1.jsonl'), archiveRaw)
  const oldDir = join(crewRoot, 'old-repo', 'old-task')
  putJson(join(oldDir, 'ledger', 'run.json'), { adw_id: 'ledger-sentinel', repo_slug: 'old-repo', task_slug: 'old-task' })
  put(join(oldDir, 'journal.jsonl'), jsonl([{ at: 10, event: 'old-layout-kept', stage: 'old-stage' }]))
  return { crewRoot, archiveRoot, open, stopped, done, published, archived, sibling, recordings, builderRaw, archiveRaw }
}

let startServer
async function serve(fx, sandbox, realFeed = false) {
  const ledger = { adw_id: 'ledger-sentinel', goal: 'old-task', repo_slug: 'old-repo', status: 'ok', running: false, mode: 'legacy-mode', phases: [{ id: 11, name: 'old-phase', status: 'ok' }], pending: {}, sentinel: { keep: ['all', 'values'] } }
  const oldShip = { state: 'unmeasured', reason: 'injected ledger ship state', stale: false }
  const feed = {
    listRuns(filters = {}) {
      const wanted = (!filters.mode || filters.mode === ledger.mode) && (!filters.status || filters.status === ledger.status) && !filters.since && !filters.until
      return { runs: wanted ? [structuredClone(ledger)] : [], degraded: false, probe: { sentinel: 'original-feed-metadata' } }
    },
    close() {},
  }
  const handles = startServer({
    port: 0, host: '127.0.0.1', crewRoot: fx.crewRoot, home: sandbox, checkout: repo,
    ledgerDb: join(sandbox, 'missing-ledger', 'ledger.db'), triageDb: join(sandbox, 'sidecar', 'visualizer.db'),
    ...(realFeed ? {} : { feed }),
    shipState: { resolve: async runs => new Map(runs.map(run => [run.adw_id, oldShip])) },
  })
  await new Promise((ok, no) => {
    const timer = setTimeout(() => no(new Error('server did not listen within 5s')), 5000)
    handles.server.once('listening', () => { clearTimeout(timer); ok() })
    handles.server.once('error', error => { clearTimeout(timer); no(error) })
  })
  const base = `http://127.0.0.1:${handles.server.address().port}`
  return {
    ledger: { ...ledger, ship: oldShip },
    async request(path, options = {}) {
      const response = await fetch(base + path, { signal: AbortSignal.timeout(5000), ...options })
      const text = await response.text()
      let body
      try { body = JSON.parse(text) } catch { throw new Error(`${path}: HTTP ${response.status} did not serve JSON`) }
      return { status: response.status, body, allow: response.headers.get('allow') }
    },
    async close() {
      handles.server.closeIdleConnections?.(); handles.server.closeAllConnections?.()
      await new Promise(ok => handles.server.close(ok))
      handles.feed.close?.()
    },
  }
}

const query = (lane, extra = {}) => new URLSearchParams({ repo_slug: `dt-${lane}`, task_slug: lane, adw_id: synthetic(lane), ...extra })
function findRun(body, name) {
  const hits = body.runs?.filter(run => run.adw_id === synthetic(name)) ?? []
  assert.equal(hits.length, 1, `expected exactly one lean row for ${name}`)
  return hits[0]
}
async function readOnly(fx, work) {
  const before = [digest(fx.crewRoot), digest(fx.archiveRoot)]
  try { return await work() } finally {
    assert.deepEqual([digest(fx.crewRoot), digest(fx.archiveRoot)], before, 'visualizer wrote into a lane/archive')
  }
}

const checks = {
  async LV1(api, fx, sandbox) {
    await readOnly(fx, async () => {
      const result = await api.request('/api/sessions')
      assert.equal(result.status, 200)
      const run = findRun(result.body, fx.open.name)
      assert.equal(run.source, 'lean'); assert.equal(run.goal, fx.open.name)
      assert.equal(run.repo_slug, `dt-${fx.open.name}`); assert.equal(run.latest_stage, 'build')
      assert.equal(run.status, 'running', 'an earlier reviewed verdict must not settle an open stage')
      assert.equal(run.phases.at(-1).name, 'build')
      for (const field of ['started_at', 'duration_ms', 'last_heartbeat_at']) {
        assert.equal(run[field], null, `${field} was not recorded`)
        assert.ok(typeof run.pending?.[field] === 'string' && run.pending[field].length, `${field} needs an absence reason`)
      }
      assert.deepEqual(result.body.runs.find(row => row.adw_id === 'ledger-sentinel'), api.ledger, 'ledger row changed')
      assert.deepEqual(result.body.probe, { sentinel: 'original-feed-metadata' })
      findRun(result.body, fx.archived.name)
      assert.equal(findRun(result.body, fx.sibling.name).latest_stage, 'gate', 'newest sibling archive must win')
      const filtered = await api.request('/api/sessions?status=stopped')
      assert.ok(filtered.body.runs.some(row => row.adw_id === synthetic(fx.stopped.name)))
      assert.ok(!filtered.body.runs.some(row => row.adw_id === synthetic(fx.open.name)))
      const dated = await api.request('/api/sessions?since=2026-01-01T00%3A00%3A00.000Z')
      assert.ok(!dated.body.runs.some(row => row.source === 'lean'), 'unknown start dates must not satisfy a time filter')
      const mode = await api.request('/api/sessions?mode=legacy-mode')
      assert.ok(!mode.body.runs.some(row => row.source === 'lean'), 'mode must not be invented for lean rows')
      const real = await serve(fx, sandbox, true)
      try {
        const missingLedger = await real.request('/api/sessions')
        assert.equal(missingLedger.status, 200)
        assert.equal(findRun(missingLedger.body, fx.open.name).latest_stage, 'build', 'missing ledger hid lean lane')
      } finally { await real.close() }
    })
    const appended = { event: 'stage-start', lane: fx.open.name, stage: 'reverify' }
    appendFileSync(join(fx.open.dir, 'task', 'journal.jsonl'), jsonl([appended]))
    fx.open.rows.push(appended)
    await readOnly(fx, async () => {
      const fresh = await api.request('/api/sessions')
      assert.equal(findRun(fresh.body, fx.open.name).latest_stage, 'reverify', 'list did not reread the journal')
    })
  },
  async LV2(api, fx) {
    await readOnly(fx, async () => {
      const { body, status } = await api.request('/api/sessions')
      assert.equal(status, 200)
      for (const [lane, terminal, reason] of [[fx.stopped, 'stopped', 'runner-threw'], [fx.done, 'done', 'recorded-terminal-reason'], [fx.archived, 'stopped', 'runner-threw']]) {
        const run = findRun(body, lane.name)
        assert.equal(run.status, terminal, `wrong verdict status for ${lane.name}`)
        assert.equal(run.reason, reason, `wrong verdict reason for ${lane.name}`)
        assert.equal(run.running, false)
      }
      const published = findRun(body, fx.published.name)
      assert.equal(published.status, 'done', 'actual successful lean journal ends in pr')
      assert.equal(published.reason, null, 'a pr row did not record a terminal reason')
      assert.notEqual(published.ship?.state, 'merged', 'published does not mean merged')
    })
  },
  async LV3(api, fx) {
    await readOnly(fx, async () => {
      for (const lane of [fx.open, fx.archived, fx.sibling]) {
        const result = await api.request(`/api/journal?${query(lane.name)}`)
        assert.equal(result.status, 200)
        assert.equal(result.body.verified, true, 'lean spec identity should verify its synthetic run')
        assert.equal(result.body.rows.length, lane.rows.length, 'did not read task/journal.jsonl')
        result.body.rows.forEach((row, index) => {
          for (const [key, value] of Object.entries(lane.rows[index])) assert.deepEqual(row[key], value)
          assert.equal(row.index, index)
          assert.equal(row.line_number, index + 1 + (lane === fx.open && index >= 1 ? 1 : 0))
          assert.equal(row.channel, null)
          assert.ok(!Object.hasOwn(row, 'at'), 'reader fabricated a timestamp')
        })
        assert.equal(result.body.skipped_malformed, lane === fx.open ? 1 : 0)
        if (lane === fx.open) assert.deepEqual(result.body.skipped_line_numbers, [2])
      }
      const wrong = await api.request(`/api/journal?${query(fx.open.name, { adw_id: 'lean:someone-else' })}`)
      assert.ok(!wrong.body.rows?.length, 'wrong lean identity borrowed an unverified journal')
      const old = await api.request('/api/journal?repo_slug=old-repo&task_slug=old-task&adw_id=ledger-sentinel')
      assert.equal(old.status, 200); assert.equal(old.body.verified, true)
      assert.deepEqual(old.body.rows.map(row => row.event), ['old-layout-kept'])
      const post = await api.request(`/api/journal?${query(fx.open.name)}`, { method: 'POST' })
      assert.equal(post.status, 405); assert.equal(post.allow, 'GET')
    })
  },
  async LV4(api, fx) {
    await readOnly(fx, async () => {
      const result = await api.request(`/api/seat-sessions?${query(fx.open.name, { role: 'planner' })}`)
      assert.equal(result.status, 200); assert.equal(result.body.role, 'planner')
      assert.ok(Array.isArray(result.body.sessions), 'seat sessions array absent')
      const safeSessions = result.body.sessions
      assert.deepEqual(new Map(safeSessions.map(session => [session.file, session.raw])), fx.recordings, 'raw planner/repair/retry recordings not served exactly')
      const plain = safeSessions.filter(session => /\.planner\.\d+\.jsonl$/.test(session.file))
      assert.deepEqual(plain.map(session => session.file.split('.').at(-2)), ['1', '2', '10'], 'turn order must be numeric')
      assert.ok(!JSON.stringify(result.body).includes('BUILDER_ONLY_RECORDING'), 'role recordings mixed')
      assert.ok(!JSON.stringify(result.body).includes('OUTSIDE_LANE_SECRET'), 'symlink escaped lane')
      const builder = await api.request(`/api/seat-sessions?${query(fx.open.name, { role: 'builder' })}`)
      assert.equal(builder.status, 200)
      assert.deepEqual(builder.body.sessions.map(session => session.raw), [fx.builderRaw])
      const archived = await api.request(`/api/seat-sessions?${query(fx.archived.name, { role: 'planner' })}`)
      assert.equal(archived.status, 200)
      assert.deepEqual(archived.body.sessions.map(session => session.raw), [fx.archiveRaw])
      const absent = await api.request(`/api/seat-sessions?${query(fx.open.name, { role: 'lead' })}`)
      assert.equal(absent.status, 200); assert.deepEqual(absent.body.sessions, [])
      assert.ok(typeof absent.body.absent === 'string' && absent.body.absent.length, 'unrecorded seat needs a reason')
      for (const role of ['../planner', 'planner/../../builder', 'outsider']) {
        const unsafe = await api.request(`/api/seat-sessions?${query(fx.open.name, { role })}`)
        assert.equal(unsafe.status, 400, `unsafe or nonmember role ${role} was accepted`)
        assert.ok(!unsafe.body.sessions?.length)
      }
      const wrong = await api.request(`/api/seat-sessions?${query(fx.open.name, { role: 'planner', adw_id: 'lean:someone-else' })}`)
      assert.ok(!wrong.body.sessions?.length, 'wrong lane identity served recordings')
      const post = await api.request(`/api/seat-sessions?${query(fx.open.name, { role: 'planner' })}`, { method: 'POST' })
      assert.equal(post.status, 405); assert.equal(post.allow, 'GET')
    })
  },
}

let sandbox, api
try {
  ;({ startServer } = await import(pathToFileURL(join(repo, 'visualizer/server/server.mjs')).href))
  sandbox = mkdtempSync(join(artifactDir, '.lv-gate-'))
  const fx = fixture(sandbox)
  api = await serve(fx, sandbox)
  for (const id of ids) {
    try { await checks[id](api, fx, sandbox) } catch (error) { failures.set(id, message(error)) }
  }
} catch (error) {
  for (const id of ids) if (!failures.has(id)) failures.set(id, message(error))
} finally {
  try { await api?.close() } catch (error) { for (const id of ids) if (!failures.has(id)) failures.set(id, message(error)) }
  if (sandbox) rmSync(sandbox, { recursive: true, force: true })
}
for (const id of ids) if (failures.has(id)) console.log(`FAIL ${id}: ${failures.get(id)}`)
process.exitCode = failures.size ? 1 : 0
