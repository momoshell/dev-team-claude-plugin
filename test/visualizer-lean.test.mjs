import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { startServer } from '../visualizer/server/server.mjs'
import { tmpdir } from 'node:os'
import { scratchDir } from './helpers.mjs'

process.env.DEVTEAM_LEDGER_DIR = scratchDir('viz-ledger-', { parent: tmpdir() })

const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) }
const members = { planner: { agent: 'pi' }, builder: { agent: 'pi' } }

function lane(root, name, rows, suffix = '') {
  const dir = join(root, `dt-${name}`, `${name}${suffix}`)
  put(join(dir, 'crew.json'), JSON.stringify({ members }))
  put(join(dir, 'task', 'lean.json'), JSON.stringify({ id: name, tier: 'build' }))
  put(join(dir, 'task', 'journal.jsonl'), jsonl(rows))
  put(join(dir, 'journal.jsonl'), jsonl([{ event: 'decoy' }]))
  return dir
}

async function withServer(work) {
  const sandbox = scratchDir('lean-viz-')
  const crewRoot = join(sandbox, '.crew'), archiveRoot = join(sandbox, '.crew-journal-archive')
  mkdirSync(crewRoot); mkdirSync(archiveRoot)
  const handles = startServer({ port: 0, host: '127.0.0.1', crewRoot, home: sandbox, checkout: sandbox, ledgerDb: join(sandbox, 'none', 'ledger.db'), triageDb: join(sandbox, 'side', 'v.db'), shipState: { resolve: async () => new Map() } })
  await new Promise((ok) => handles.server.once('listening', ok))
  const base = `http://127.0.0.1:${handles.server.address().port}`
  const get = async (path, options) => { const r = await fetch(base + path, options); return { status: r.status, body: await r.json() } }
  try { await work({ crewRoot, archiveRoot, get }) } finally {
    handles.server.closeAllConnections?.()
    await new Promise((ok) => handles.server.close(ok))
    handles.feed.close?.()
    rmSync(sandbox, { recursive: true, force: true })
  }
}
const q = (name, extra = {}) => `repo_slug=dt-${name}&task_slug=${name}&adw_id=lean%3A${name}` + Object.entries(extra).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join('')

test('LV1 lists live, archived and sibling-archive lanes with their latest stage; reread on append', async () => {
  await withServer(async ({ crewRoot, archiveRoot, get }) => {
    const dir = lane(crewRoot, 'a-open', [{ event: 'stage-start', stage: 'plan' }, { event: 'verdict', stage: 'review', status: 'reviewed' }, { event: 'stage-start', stage: 'build' }])
    lane(archiveRoot, 'a-open', [{ event: 'verdict', stage: 'build', status: 'stopped', reason: 'archive' }])
    lane(crewRoot, 'b-sib', [{ event: 'stage-start', stage: 'old' }], '.archive-2026-10-01')
    lane(crewRoot, 'b-sib', [{ event: 'stage-start', stage: 'new' }], '.archive-2026-10-02')
    lane(archiveRoot, 'c-arch', [{ event: 'stage-start', stage: 'gate' }])
    put(join(crewRoot, 'dt-bad', 'bad', 'task', 'lean.json'), JSON.stringify({ id: 'other' }))
    const runs = (await get('/api/sessions')).body.runs
    const byId = Object.fromEntries(runs.map((run) => [run.adw_id, run]))
    assert.equal(byId['lean:a-open'].latest_stage, 'build'); assert.equal(byId['lean:a-open'].status, 'running')
    assert.equal(byId['lean:a-open'].started_at, null); assert.ok(byId['lean:a-open'].pending.started_at)
    assert.equal(byId['lean:b-sib'].latest_stage, 'new'); assert.equal(byId['lean:c-arch'].latest_stage, 'gate')
    assert.ok(!byId['lean:bad'])
    appendFileSync(join(dir, 'task', 'journal.jsonl'), jsonl([{ event: 'stage-start', stage: 'again' }]))
    assert.equal((await get('/api/sessions')).body.runs.find((run) => run.adw_id === 'lean:a-open').latest_stage, 'again')
    assert.ok((await get('/api/sessions?mode=x')).body.runs.every((run) => run.source !== 'lean'))
    assert.ok((await get('/api/sessions?since=2026-01-01T00%3A00%3A00.000Z')).body.runs.every((run) => run.source !== 'lean'))
  })
})

test('LV2 terminal verdicts and pr rows settle a lane; empty journals are unknown', async () => {
  await withServer(async ({ crewRoot, get }) => {
    lane(crewRoot, 'stopped', [{ event: 'stage-start', stage: 'build' }, { event: 'verdict', stage: 'build', status: 'stopped', reason: 'runner-threw' }])
    lane(crewRoot, 'pub', [{ event: 'verdict', stage: 'review', status: 'reviewed' }, { event: 'stage-start', stage: 'publish' }, { event: 'pr', stage: 'start', pr: { number: 3, url: 'u' } }])
    lane(crewRoot, 'empty', [])
    const byId = Object.fromEntries((await get('/api/sessions')).body.runs.map((run) => [run.adw_id, run]))
    assert.deepEqual([byId['lean:stopped'].status, byId['lean:stopped'].reason, byId['lean:stopped'].running], ['stopped', 'runner-threw', false])
    assert.deepEqual([byId['lean:pub'].status, byId['lean:pub'].reason], ['done', null]); assert.notEqual(byId['lean:pub'].ship.state, 'merged')
    assert.equal(byId['lean:empty'].status, 'unknown'); assert.ok(byId['lean:empty'].reason)
    assert.equal((await get('/api/sessions?status=stopped')).body.runs.length, 1)
  })
})

test('LV3 journal route reads task/journal.jsonl and refuses identity mismatches', async () => {
  await withServer(async ({ crewRoot, get }) => {
    const dir = lane(crewRoot, 'j', [{ event: 'stage-start', stage: 'plan' }])
    appendFileSync(join(dir, 'task', 'journal.jsonl'), '{torn\n' + jsonl([{ event: 'stage-end', stage: 'plan' }]))
    const { body } = await get(`/api/journal?${q('j')}`)
    assert.equal(body.verified, true); assert.deepEqual(body.rows.map((row) => row.event), ['stage-start', 'stage-end'])
    assert.deepEqual(body.skipped_line_numbers, [2]); assert.equal(body.rows[1].line_number, 3); assert.ok(!('at' in body.rows[0]))
    const wrong = await get(`/api/journal?${q('j').replace('lean%3Aj', 'lean%3Aother')}`)
    assert.equal(wrong.body.rows.length, 0)
    assert.equal((await get(`/api/journal?${q('j')}`, { method: 'POST' })).status, 405)
  })
})

test('LV4 seat sessions are served by role in numeric turn order, confined to the lane', async () => {
  await withServer(async ({ crewRoot, get }) => {
    const dir = lane(crewRoot, 's', [{ event: 'stage-start', stage: 'plan' }])
    for (const stem of ['10', '2', '1', '1.repair']) put(join(dir, 'task', 'lean', 'planner', `s.planner.${stem}.jsonl`), `raw ${stem}\n`)
    put(join(dir, 'task', 'lean', 'builder', 's.builder.1.jsonl'), 'BUILDER\n')
    put(join(crewRoot, 'secret.jsonl'), 'SECRET\n')
    symlinkSync(join(crewRoot, 'secret.jsonl'), join(dir, 'task', 'lean', 'planner', 's.planner.3.jsonl'))
    const { body } = await get(`/api/seat-sessions?${q('s', { role: 'planner' })}`)
    assert.deepEqual(body.sessions.map((session) => session.raw), ['raw 1\n', 'raw 1.repair\n', 'raw 2\n', 'raw 10\n'])
    assert.ok(!JSON.stringify(body).includes('SECRET') && !JSON.stringify(body).includes('BUILDER'))
    assert.match(body.sessions[0].file, /^task\/lean\/planner\//)
    for (const role of ['../planner', 'outsider']) assert.equal((await get(`/api/seat-sessions?${q('s', { role })}`)).status, 400)
    assert.equal((await get(`/api/seat-sessions?${q('s', { role: 'planner' }).replace('lean%3As', 'lean%3Ax')}`)).body.sessions.length, 0)
    const none = await get(`/api/seat-sessions?${q('s', { role: 'builder' })}`)
    assert.equal(none.body.sessions.length, 1)
    rmSync(join(dir, 'task', 'lean', 'builder'), { recursive: true })
    assert.ok((await get(`/api/seat-sessions?${q('s', { role: 'builder' })}`)).body.absent)
  })
})

test('a lane stopped inside a stage reads as stopped though its stage-end rows follow the verdict', async () => {
  await withServer(async ({ crewRoot, get }) => {
    lane(crewRoot, 'mid', [{ event: 'stage-start', stage: 'build' }, { event: 'verdict', stage: 'build', status: 'stopped', reason: 'seat-unmeasured' }, { event: 'stage-end', stage: 'build', outcome: null }])
    const [run] = (await get('/api/sessions')).body.runs
    assert.deepEqual([run.status, run.reason, run.running], ['stopped', 'seat-unmeasured', false])
  })
})

test('a lane journal that symlinks out of the lane is never read', async () => {
  await withServer(async ({ crewRoot, get }) => {
    const dir = lane(crewRoot, 'leak', [])
    put(join(crewRoot, 'outside.jsonl'), jsonl([{ event: 'stage-start', stage: 'OUTSIDE' }]))
    rmSync(join(dir, 'task', 'journal.jsonl'))
    symlinkSync(join(crewRoot, 'outside.jsonl'), join(dir, 'task', 'journal.jsonl'))
    const { body } = await get(`/api/journal?${q('leak')}`)
    assert.deepEqual(body.rows, [])
    assert.ok(!JSON.stringify((await get('/api/sessions')).body).includes('OUTSIDE'))
  })
})

test('a lane is dated by its run-start and placed in the time window by it', async () => {
  await withServer(async ({ crewRoot, get }) => {
    const at = Date.now() - 10_000
    lane(crewRoot, 'dated', [{ event: 'run-start', at, run_id: 'dated' }, { event: 'stage-start', stage: 'plan' }])
    lane(crewRoot, 'undated', [{ event: 'stage-start', stage: 'plan' }])
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString()
    const { runs } = (await get(`/api/sessions?since=${encodeURIComponent(since)}`)).body
    assert.deepEqual(runs.map((run) => [run.adw_id, run.started_at]), [['lean:dated', new Date(at).toISOString()]])
    const undated = (await get('/api/sessions')).body.runs.find((run) => run.adw_id === 'lean:undated')
    assert.equal(undated.started_at, null); assert.ok(undated.pending.started_at)
  })
})
