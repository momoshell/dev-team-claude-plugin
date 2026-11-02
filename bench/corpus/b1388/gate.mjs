import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Run from the checkout supplied by the outer loop; no git, suite, or real agent processes.
const repo = process.cwd()
const artifactDir = dirname(fileURLToPath(import.meta.url))
const ids = ['AC1', 'AC2', 'AC3', 'AC4', 'AC5']
const load = (file) => import(pathToFileURL(resolve(repo, file)).href)
const json = (path) => JSON.parse(readFileSync(path, 'utf8'))
const put = (path, value) => writeFileSync(path, JSON.stringify(value) + '\n')
const epoch = (value) => typeof value === 'number' ? value : Number.isFinite(Number(value)) ? Number(value) : Date.parse(value)
let scratch
let failures = 0

async function layoutEnv(lean, fn) {
  const before = process.env.CREW_CONTEXT_LAYOUT
  if (lean) process.env.CREW_CONTEXT_LAYOUT = 'lean'
  else delete process.env.CREW_CONTEXT_LAYOUT
  try { return await fn() } finally {
    if (before === undefined) delete process.env.CREW_CONTEXT_LAYOUT
    else process.env.CREW_CONTEXT_LAYOUT = before
  }
}

function fixture(name, lean = true) {
  const base = join(scratch, name)
  const cwd = join(base, 'checkout')
  const parent = join(base, 'lane')
  const taskDir = join(parent, 'task')
  const runtimeRoot = join(base, 'runtimes')
  for (const dir of [cwd, taskDir, runtimeRoot]) mkdirSync(dir, { recursive: true })
  const at = Date.now() - 120_000
  const runId = 'lane-gate-run'
  const journal = join(lean ? taskDir : parent, 'journal.jsonl')
  put(journal, { event: 'run-start', at, lane: runId, run_id: runId })
  writeFileSync(join(cwd, 'source.mjs'), 'export function ownSymbol() {\n  return "OWN_CITATION"\n}\n// fourth\n// fifth\n')
  writeFileSync(join(cwd, 'lane.test.mjs'), 'export {}\n')
  const planPath = join(taskDir, 'plan.md')
  const gatePath = join(taskDir, 'fixture-gate.mjs')
  writeFileSync(planPath, 'Own lane plan\nsource.mjs:2-3\n')
  writeFileSync(gatePath, 'process.exitCode = 0\n')
  const details = {
    subject: 'fix(crew): resolve lean arm context', plan_path: planPath, gate_path: gatePath,
    acceptance: ['AC1'], mutations: [{ check: 'AC1', file: 'source.mjs', find: 'OWN_CITATION', replace: 'BROKEN' }],
    files_in_scope: ['source.mjs', 'lane.test.mjs'], validation_lane: 'node --test lane.test.mjs',
    gate_cmd: `node ${gatePath}`,
  }
  const returnsDir = lean ? taskDir : join(parent, 'returns')
  mkdirSync(returnsDir, { recursive: true })
  if (!lean) mkdirSync(join(returnsDir, runId), { recursive: true })
  function planner(number, changes = {}, mtime = at + 30_000) {
    const envelope = { role: 'planner', id: `${runId}.planner.${number}`, status: 'done', summary: 'Context fixture', details: { ...details, ...changes } }
    const paths = lean ? [join(taskDir, `planner-${number}.json`)] : [join(returnsDir, `d${number}.planner.json`), join(returnsDir, runId, `d${number}.planner.json`)]
    for (const path of paths) { put(path, envelope); utimesSync(path, mtime / 1000, mtime / 1000) }
    return envelope
  }
  planner(2, { validation_lane: 'node --test older.test.mjs' })
  const envelope = planner(12)
  planner(99, { files_in_scope: ['STALE'], validation_lane: 'node --test stale.test.mjs' }, at - 10_000)
  const cell = { provider: 'openai', id: 'gpt-6.1-sol', agent: 'pi', effort: 'high', model: 'openai/gpt-6.1-sol' }
  if (!lean) put(join(taskDir, 'advisor-manifest.json'), { schema_version: 1, run_started_at: at, tripwires: ['lane.test.mjs'], cell })
  else {
    // Every old lookup has plausible foreign context: leaning on it must never pass.
    put(join(parent, 'journal.jsonl'), { event: 'run-start', at: at - 60_000, run_id: 'foreign-run' })
    for (const dir of [join(parent, 'returns'), join(parent, 'returns', 'foreign-run')]) {
      mkdirSync(dir, { recursive: true })
      put(join(dir, 'd88.planner.json'), { role: 'planner', status: 'done', details: { ...details, files_in_scope: ['FOREIGN'], validation_lane: 'node --test foreign.test.mjs' } })
    }
  }
  return { base, cwd, taskDir, parent, runtimeRoot, at, runId, journal, details, cell, envelope,
    env: { CREW_CONTEXT_LAYOUT: lean ? 'lean' : undefined, CREW_ROLE: 'builder', CREW_TASK_DIR: taskDir, CREW_ADVISOR: '1' } }
}

async function seat(f, arms) {
  const { runAcpSeat } = await load('crew/acp/seat.mjs')
  const created = []
  const definition = { role: 'builder', agent: 'pi', model: 'openai/gpt-6.1-sol', effort: 'high', writes: 'repo', skills: [], wait_s: 1, ...arms }
  const result = runAcpSeat({
    definition, cwd: f.cwd, taskDir: f.taskDir, prompt: 'fixture turn',
    briefText: 'Tripwire tests:\n- lane.test.mjs · own lane tripwire\nBroad keys\n',
    sessionFile: join(f.taskDir, 'seat-session.jsonl'), binaries: { pi: process.execPath },
    deps: { env: { PATH: process.env.PATH }, runtimeRoot: f.runtimeRoot,
      clientFactory({ launch }) {
        created.push(launch)
        return { start() {}, initialize() {}, newSession() {}, setMode() {}, beginPrompt() { return 1 },
          pollPrompt() { return { stopReason: 'end_turn', refusal: null } }, close() { return { outcome: 'proven' } } }
      },
    },
  })
  assert.equal(result?.stopReason, 'end_turn')
  assert.equal(created.length, 1, 'one recording client must actually be constructed')
  return created[0]
}
const advisorArm = { agent: 'pi', model: 'openai/gpt-6.1-sol', effort: 'high' }

const checks = {
  async AC1() {
    const mod = await load('crew/pi/extensions/builderloop.ts')
    await layoutEnv(true, async () => {
      const f = fixture('builder-lean')
      const { validateEnvelope } = await load('crew/protocols.mjs')
      assert.deepEqual(validateEnvelope('planner', f.envelope).defects, [], 'lean P2 must be able to carry the fields its readers require')
      const context = mod.loadPlannerContext({ taskDir: f.taskDir, env: f.env })
      assert.ok(context, 'builderloop must resolve its own lane return')
      assert.equal(context.validation_lane, f.details.validation_lane)
      assert.deepEqual(context.files_in_scope, f.details.files_in_scope)
      assert.equal(context.gate_cmd, f.details.gate_cmd)
      rmSync(f.journal)
      assert.equal(mod.loadPlannerContext({ taskDir: f.taskDir, env: f.env }), null, 'no fallback to foreign parent when lean anchor disappears')
    })
    await layoutEnv(false, () => {
      const f = fixture('builder-legacy', false)
      assert.equal(mod.loadPlannerContext({ taskDir: f.taskDir, env: f.env })?.validation_lane, f.details.validation_lane)
    })
  },
  async AC2() {
    // Exercise the producer only up to its first issued turn: all stage/check seams are forbidden.
    const { runLoop } = await load('crew/loop.mjs')
    const loopTask = join(scratch, 'anchor-producer')
    let observed = false
    const probeStart = Date.now()
    const forbidden = async () => { throw new Error('a context probe must not run checks or git stages') }
    await runLoop({ id: 'anchor-probe', shape: 'standard', tier: 'build', cwd: repo, taskDir: loopTask,
      brief: 'context probe', source: 'operator', branch: 'probe', base: 'main', acceptance: ['AC1'], suite: { command: process.execPath } }, {
      resolveAgents: () => ({ seats: Object.fromEntries(['planner', 'builder', 'reviewer'].map((role) => [role, { agent: 'pi', provider: 'openai', id: 'gpt-6.1-sol', effort: 'high' }])) }),
      runSeat() {
        const rows = readFileSync(join(loopTask, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
        const anchor = rows.find((row) => row.event === 'run-start')
        assert.ok(anchor, 'loop must emit run-start before first seat')
        assert.ok(epoch(anchor.at) >= probeStart && epoch(anchor.at) <= Date.now(), 'lane start carries wall-clock time')
        observed = true
        throw new Error('intentional stop before a seat process or check')
      },
      checkBaseline: forbidden, runGate: forbidden, proveMutations: forbidden, runSuite: forbidden,
      commitChanges: forbidden, rebaseBranch: forbidden, openPullRequest: forbidden, run: forbidden,
    })
    assert.ok(observed, 'lane anchor production was observed before its first seat')
    const mod = await load('crew/pi/extensions/advisor.ts')
    await layoutEnv(true, async () => {
      const f = fixture('advisor-lean')
      const plannerTime = statSync(join(f.taskDir, 'planner-12.json')).mtimeMs
      const seatStarted = Date.now()
      assert.ok(plannerTime < seatStarted, 'planner predates this seat')
      await seat(f, { advisor: advisorArm })
      const manifest = json(join(f.taskDir, 'advisor-manifest.json'))
      assert.equal(epoch(manifest.run_started_at), f.at, 'manifest anchor is lane start, never per-seat time')
      assert.deepEqual(manifest.cell, f.cell)
      assert.deepEqual(manifest.tripwires, ['lane.test.mjs'])
      const context = mod.loadContext({ taskDir: f.taskDir, env: f.env })
      assert.notEqual(context.scope_source, 'absent')
      assert.deepEqual(context.files_in_scope, f.details.files_in_scope)
      assert.equal(context.validation_lane, f.details.validation_lane)
      assert.deepEqual(context.cell, f.cell)
      assert.equal(epoch(context.run_started_at), f.at)
    })
    await layoutEnv(false, () => {
      const f = fixture('advisor-legacy', false)
      assert.deepEqual(mod.loadContext({ taskDir: f.taskDir }).files_in_scope, f.details.files_in_scope)
    })
  },
  async AC3() {
    const mod = await load('crew/pi/extensions/skeletonread.ts')
    for (const lean of [true, false]) await layoutEnv(lean, () => {
      const f = fixture(lean ? 'skeleton-lean' : 'skeleton-legacy', lean)
      const context = mod.loadAcceptedContext({ taskDir: f.taskDir, cwd: f.cwd, env: f.env })
      assert.ok(context, 'accepted planner context must exist')
      assert.equal(context.planner_number, 12)
      assert.equal(context.plan_path, f.details.plan_path)
      assert.deepEqual(context.ranges, [{ file: 'source.mjs', start: 2, end: 3 }])
      const hook = mod.createSkeletonRead({ taskDir: f.taskDir, cwd: f.cwd, env: { ...f.env, CREW_READGATE_MAX_LINES: '2' } })
      const result = hook.onToolResult({ toolName: 'read', input: { path: 'source.mjs' }, isError: false, content: [{ type: 'text', text: 'original' }] }, { cwd: f.cwd })
      assert.match(result?.content?.[0]?.text ?? '', /2:   return "OWN_CITATION"/)
      if (lean) {
        rmSync(f.journal)
        assert.equal(mod.loadAcceptedContext({ taskDir: f.taskDir, cwd: f.cwd, env: f.env }), null)
      }
    })
  },
  async AC4() {
    const mod = await load('crew/pi/extensions/subagent.ts')
    await layoutEnv(true, () => {
      const f = fixture('counter-lean')
      const foreign = join(f.parent, 'subagent-spawns.json')
      put(foreign, { spawns: 8 })
      const before = readFileSync(foreign, 'utf8')
      for (const count of [1, 2]) {
        const out = mod.reserveSpawn({ taskDir: f.taskDir, env: f.env, readFile: readFileSync, writeFile: writeFileSync })
        assert.equal(out.error, undefined)
        assert.equal(out.count, count)
        assert.deepEqual(json(join(f.taskDir, 'subagent-spawns.json')), { spawns: count })
        assert.equal(readFileSync(foreign, 'utf8'), before, 'parent spawn budget is foreign')
      }
    })
    await layoutEnv(false, () => {
      const f = fixture('counter-legacy', false)
      assert.equal(mod.reserveSpawn({ taskDir: f.taskDir, readFile: readFileSync, writeFile: writeFileSync }).count, 1)
      assert.deepEqual(json(join(f.parent, 'subagent-spawns.json')), { spawns: 1 })
      assert.equal(existsSync(join(f.taskDir, 'subagent-spawns.json')), false)
    })
  },
  async AC5() {
    await layoutEnv(true, async () => {
      const f = fixture('all-arms')
      const launch = await seat(f, { advisor: advisorArm, edit_assist: true, extensions: ['builderloop', 'skeletonread'] })
      assert.equal(launch.env.CREW_CONTEXT_LAYOUT, 'lean')
      assert.equal(launch.env.CREW_TASK_DIR, f.taskDir)
      assert.equal(launch.env.CREW_ADVISOR, '1')
      assert.equal(launch.env.CREW_EDIT_ASSIST, 'on')
      const extensions = launch.args.flatMap((arg, index, args) => arg === '-e' ? [args[index + 1]] : [])
      for (const name of ['advisor', 'builderloop', 'skeletonread']) assert.ok(extensions.some((path) => path.endsWith(`/crew/pi/extensions/${name}.ts`)), `${name} must be loaded`)
      const tools = launch.args[launch.args.indexOf('--tools') + 1].split(',')
      assert.ok(tools.includes('retrieve'), 'skeletonread tool must be activated')
      // The same declarations with only foreign context must refuse before constructing a client.
      const missing = fixture('missing-anchor')
      rmSync(missing.journal)
      const { runAcpSeat } = await load('crew/acp/seat.mjs')
      let clients = 0
      assert.throws(() => runAcpSeat({
        definition: { role: 'builder', agent: 'pi', model: 'openai/gpt-6.1-sol', effort: 'high', writes: 'repo', advisor: advisorArm, edit_assist: true, extensions: ['builderloop', 'skeletonread'] },
        cwd: missing.cwd, taskDir: missing.taskDir, prompt: 'missing own context', sessionFile: join(missing.taskDir, 'seat.jsonl'), binaries: { pi: process.execPath },
        deps: { runtimeRoot: missing.runtimeRoot, env: {}, clientFactory() { clients++; throw new Error('unexpected client construction') } },
      }))
      assert.equal(clients, 0, 'missing own context must refuse before launch')
    })
  },
}

try {
  scratch = mkdtempSync(join(artifactDir, '.arm-context-gate-'))
  for (const id of ids) {
    try { await checks[id]() } catch (error) {
      failures++
      const reason = String(error?.message ?? error).split('\n')[0].replaceAll(/\s+/g, ' ').slice(0, 220)
      console.log(`FAIL ${id}: ${reason}`)
    }
  }
} catch (error) {
  for (const id of ids) console.log(`FAIL ${id}: gate setup failed`)
  failures = ids.length
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
}
process.exitCode = failures ? 1 : 0
