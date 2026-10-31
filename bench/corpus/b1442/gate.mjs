import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Never resolve the checkout from this artifact's directory or a lane spec.
const checkout = process.cwd()
let finishLane
let loadError
try {
  ;({ finishLane } = await import(pathToFileURL(join(checkout, 'crew/finish.mjs')).href))
} catch (error) { loadError = error }

const validBuilder = (status) => ({
  role: 'builder', id: 'gatefi.builder.2', status,
  summary: 'Uncommitted implementation remains', details: { summary: 'Gate needs repair' },
})
const row = (status) => ({
  event: 'envelope', role: 'builder', id: 'gatefi.builder.2',
  parsed: validBuilder(status), defects: [], error: null,
})

function fixture(builderRows, stopStage = null) {
  const root = join(checkout, '.gate-fixture-crew')
  const cwd = join(checkout, '.gate-fixture-worktree')
  const taskDir = join(root, 'dt-gatefi', 'gatefi', 'task')
  const spec = { id: 'gatefi', cwd, taskDir, shape: 'standard', tier: 'build', branch: 'gatefi', base: 'main' }
  const planner = {
    role: 'planner', id: 'gatefi.planner.1', status: 'done', summary: 'Planned',
    details: {
      subject: 'fix(crew): finish insufficient builds',
      plan_path: join(taskDir, 'plan.md'), gate_path: join(taskDir, 'gate.mjs'), acceptance: ['A1'],
      mutations: [{ check: 'A1', file: 'lib.mjs', find: 'before', replace: 'after' }],
    },
  }
  const journal = [
    { event: 'run-start' },
    { event: 'envelope', role: 'planner', parsed: planner, defects: [], error: null },
    { event: 'stage-start', stage: 'build' },
    ...builderRows,
    { event: 'verdict', status: 'stopped', stage: stopStage, reason: 'lead-escalated' },
  ]
  const files = new Map([
    [join(taskDir, 'lean.json'), JSON.stringify(spec)],
    [join(taskDir, 'planner-1.json'), JSON.stringify(planner)],
    [join(taskDir, 'journal.jsonl'), journal.map((r) => JSON.stringify(r)).join('\n') + '\n'],
    [join(cwd, 'uncommitted.txt'), 'implementation remains\n'],
  ])
  const before = [...files]
  const spawned = []
  const effects = []
  const deps = {
    readFileSync: (path) => {
      if (!files.has(path)) throw Object.assign(new Error(`Missing fixture file: ${path}`), { code: 'ENOENT' })
      return files.get(path)
    },
    readdirSync: () => ['lean.json', 'journal.jsonl', 'planner-1.json'],
    statSync: (path) => ({ isDirectory: () => path === cwd }),
    existsSync: (path) => files.has(path) || path === cwd || path === taskDir,
    mkdirSync: (...args) => { effects.push(['mkdir', ...args]) },
    writeFileSync: (path, text, options) => {
      effects.push(['write', path])
      if (options?.flag === 'wx' && files.has(path)) throw Object.assign(new Error('claimed'), { code: 'EEXIST' })
      files.set(path, String(text))
    },
    appendFileSync: () => { throw new Error('Unexpected append') },
    rmSync: (path) => { effects.push(['remove', path]); files.delete(path) },
    spawnDetached: (...args) => { spawned.push(args); return 4242 },
    log: () => {},
  }
  return { files, before, spawned, effects, cwd, taskDir, go: () => finishLane({ lane: 'gatefi', root, deps }) }
}

const checks = {
  FI1() {
    for (const stage of [null, 'build']) {
      const f = fixture([row('insufficient')], stage)
      const result = f.go()
      assert.equal(result.pid, 4242)
      assert.equal(f.spawned.length, 1)
      assert.equal(f.spawned[0][2].cwd, f.cwd)
      const finished = JSON.parse(f.files.get(join(f.taskDir, 'finish.json')))
      assert.equal(finished.shape, 'finish')
      assert.equal(finished.finish.stop.reason, 'lead-escalated')
      assert.equal(f.files.get(join(f.cwd, 'uncommitted.txt')), 'implementation remains\n')
      assert.equal(f.files.get(join(f.taskDir, 'lean.json')), new Map(f.before).get(join(f.taskDir, 'lean.json')))
    }
  },
  FI2() {
    const invalid = [
      [{ ...row('insufficient'), defects: ['details.summary is required'] }],
      [{ ...row('done'), defects: ['missing summary'] }],
      [{ ...row('insufficient'), parsed: null, defects: ['envelope is a JSON object'] }],
      [{ ...row('insufficient'), defects: undefined }],
      [{ ...row('insufficient'), defects: 'not an array' }],
      [{ ...row('insufficient'), role: 'reviewer' }],
      [row('escalate')],
      [],
    ]
    for (const rows of invalid) {
      const f = fixture(rows)
      assert.throws(f.go, (error) => error?.reason === 'finish-no-build')
      assert.equal(f.spawned.length, 0)
      assert.deepEqual(f.effects, [])
      assert.deepEqual([...f.files], f.before)
    }
  },
}
let failures = 0
for (const [id, check] of Object.entries(checks)) {
  try {
    if (loadError) throw loadError
    check()
  } catch (error) {
    failures++
    console.log(`FAIL ${id}: ${String(error?.message ?? error).replace(/\s+/g, ' ')}`)
  }
}
process.exitCode = failures ? 1 : 0
