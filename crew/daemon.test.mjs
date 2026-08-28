import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, unlinkSync,
  openSync, readSync, fstatSync, closeSync, statSync, utimesSync, appendFileSync, symlinkSync, chmodSync, renameSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// node:module is not imported here: D1's node:sqlite probe lives in test/helpers.mjs.
import {
  daemon, deriveState, normalizeEvent, usageWindow, scopeEntryDefects, PANE_TRANSPORT, RUN_STATES, EVENT_KINDS, DAEMON_COMMANDS, DEFAULT_CONCURRENCY, DEFAULT_BUDGET_WINDOW_MS, LEDGER_NODE_FLOOR,
} from './daemon.mjs'
import { driveTask, PROTECTED_PATHS, validateScopeEntries } from './drive.mjs'
import { VARIANTS, VARIANT_NAMES } from './variants.mjs'
import { runChild } from './child.mjs'
import { DEFAULT_TRANSPORT, emitAdapter, seatIo, settleSeatTeardown } from './seat-io.mjs'
import { splitFrames } from './headless-rpc.mjs'
import { openRun } from '../scripts/factory/emit.mjs'
import { NODE_FLOOR, openLedger } from '../scripts/factory/ledger.mjs'
import { repoKeyFor } from '../scripts/factory/probe-repo.mjs'
import { scratchDir, sqliteAvailable, writeTornFile } from '../test/helpers.mjs'

// Quote characters inside a regex literal are ordinary here again: maskCode()
// in test/factory-env.test.mjs classifies every slash from the token before it
// and refuses the one case it cannot classify, so a quoted regex no longer
// masks everything BELOW it and no longer disarms the temp sandbox tripwire
// for the rest of this file. The hex-escape workaround it carried is retired;
// this block keeps the file's line count, which skills/backend-node pins.

// Ledger sandbox (#432): every ledger writer this file drives resolves its db
// through DEVTEAM_LEDGER_DIR (scripts/factory/ledger.mjs:2903), so this
// module-scope assignment — set before any test runs, not per call — is what
// keeps the operator's ~/.dev-team/factory/ledger.db out of reach. Restored,
// and the directory removed, in after().
const LEDGER_SANDBOX = mkdtempSync(join(tmpdir(), 'b117-ledger-sandbox-'))
const LEDGER_SANDBOX_PREVIOUS = process.env.DEVTEAM_LEDGER_DIR
process.env.DEVTEAM_LEDGER_DIR = LEDGER_SANDBOX
after(() => {
  if (LEDGER_SANDBOX_PREVIOUS === undefined) delete process.env.DEVTEAM_LEDGER_DIR
  else process.env.DEVTEAM_LEDGER_DIR = LEDGER_SANDBOX_PREVIOUS
  rmSync(LEDGER_SANDBOX, { recursive: true, force: true })
})

const HERE = dirname(fileURLToPath(import.meta.url))
const DAEMON_SOURCE = readFileSync(join(HERE, 'daemon.mjs'), 'utf8')
const CHILD_SOURCE = readFileSync(join(HERE, 'child.mjs'), 'utf8')
const sourceCode = (source) => source.split('\n').filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*')).join('\n')
const DAEMON_CODE = sourceCode(DAEMON_SOURCE)
const CHILD_CODE = sourceCode(CHILD_SOURCE)
const DRIVE_MODULE = ['drive', 'mjs'].join('.')
const SEAT_IO_MODULE = ['seat-io', 'mjs'].join('.')
// D1 (#591 tranche 2): the node:sqlite probe now comes from test/helpers.mjs.
// These six lines remain prose rather than deleted because
// skills/backend-node/anchors.json pins six line-keyed anchors in this file
// from crew/daemon.test.mjs:221 down. That skill is outside this lane's
// fence, so this conversion stays line-count neutral — the same device as
// the block at lines 25-30.
// The per-file SKIP message stays where it is.
const LEDGER_SQLITE_OK = Number.parseInt(process.versions.node, 10) >= Number.parseInt(NODE_FLOOR, 10) && sqliteAvailable()

// The rpc wrapper is spawned detached and unrefed, so this test cannot retain
// its ChildProcess object. Keep the cleanup scope to the recorded process
// group, never a process name.
const teardownPgidPaths = new Set()
function recordedPgid(path) {
  try {
    const value = Number(readFileSync(path, 'utf8').trim())
    return Number.isSafeInteger(value) && value > 0 ? value : null
  } catch { return null }
}
function killRecordedGroup(path) {
  const pgid = recordedPgid(path)
  if (pgid == null) return
  try { process.kill(-pgid, 'SIGKILL') } catch (err) { if (err?.code !== 'ESRCH') return }
}
after(() => { for (const path of teardownPgidPaths) killRecordedGroup(path) })

function fixture({ roles = ['planner', 'builder', 'reviewer'], transport = 'headless-json', agent, feedRetention, bootCrewDir, spawnSync: spawnImpl, concurrency, budget, usageWindow: usageWindowImpl, now: nowImpl, nodeVersion: nodeVersionImpl } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'daemon80-'))
  const root = join(dir, 'daemon')
  const crewDir = join(dir, 'crew')
  const taskDir = join(crewDir, 'task')
  const returnsDir = join(crewDir, 'returns')
  mkdirSync(taskDir, { recursive: true }); mkdirSync(returnsDir, { recursive: true })
  const members = Object.fromEntries(roles.map((role) => [role, { model: 'x', transport, ...(agent ? { agent } : {}) }]))
  const taskReturn = join(returnsDir, 'task.json')
  const brief = join(dir, 'brief.md')
  writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({ task: 'daemon80', checkout: dir, roles, members, task_return: taskReturn }))
  writeFileSync(join(crewDir, 'journal.jsonl'), '')
  writeFileSync(brief, '# brief\n')
  const alive = new Set([700, 900])
  const procStart = new Map()
  const forks = []
  const boots = []
  const reportedCrewDir = bootCrewDir || join(dir, 'reported-crew-state')
  const defaultSpawnSync = (_command, argv, options) => {
    const task = argv[argv.indexOf('--task') + 1]
    const checkout = argv[argv.indexOf('--checkout') + 1]
    const taskDir = join(reportedCrewDir, 'task')
    const returnsDir = join(reportedCrewDir, 'returns')
    mkdirSync(taskDir, { recursive: true }); mkdirSync(returnsDir, { recursive: true })
    const taskReturn = join(returnsDir, 'task.json')
    writeFileSync(join(reportedCrewDir, 'crew.json'), JSON.stringify({ task, checkout: checkout || options.cwd, roles, members, task_return: taskReturn }))
    writeFileSync(join(reportedCrewDir, 'journal.jsonl'), '')
    return { status: 0, stdout: JSON.stringify({ workspace_id: null, members: {}, task_dir: taskDir, crew_json: join(reportedCrewDir, 'crew.json') }), stderr: '' }
  }
  let clock = 1
  const deps = {
    pid: 700,
    now: () => clock++,
    uuid: (() => { let n = 0; return () => `run-${++n}` })(),
    fork(...args) { forks.push(args); return { pid: 900, on() {}, kill() {}, unref() {}, disconnect() {} } },
    spawnSync(...args) { boots.push(args); return (spawnImpl || defaultSpawnSync)(...args) },
    kill(pid, signal) {
      if (signal === 0 && !alive.has(pid)) { const err = Error('gone'); err.code = 'ESRCH'; throw err }
      return true
    },
    psSnapshot: () => ({ ok: true, rows: new Map([...alive].map((value) => [value, { pid: value, ppid: 1, pgid: value, start: procStart.get(value) ?? `start-${value}`, stat: 'S' }])) }),
    setInterval: () => null,
    clearInterval: () => {},
    feedRetention,
    ...(usageWindowImpl ? { usageWindow: usageWindowImpl } : {}),
    ...(nowImpl ? { now: nowImpl } : {}),
    ...(nodeVersionImpl ? { nodeVersion: nodeVersionImpl } : {}),
  }
  const d = daemon({ root, concurrency, ...(budget === undefined ? {} : { budget }), deps })
  return {
    dir, root, crewDir, taskDir, returnsDir, taskReturn, brief, reportedCrewDir, d, deps, forks, boots, alive, procStart,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const returnFor = (f, runId, attempt = 1) => attempt <= 1
  ? join(f.returnsDir, `${runId}.task.json`)
  : join(f.returnsDir, `${runId}.task.a${attempt}.json`)

function protectedProfile(factoryRoot, checkout, cell) {
  const repoKey = repoKeyFor({ checkout })
  const path = join(factoryRoot, 'profiles', `${repoKey}.json`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({
    schema: 1, profile_version: 1, repo_key: repoKey, fields: { protected_paths_candidates: cell }, meta: {},
  }))
  return path
}

function mintCrew(f, { name = 'crew-2', checkout = f.dir, task = 'daemon80' } = {}) {
  const crewDir = join(f.dir, name)
  const taskDir = join(crewDir, 'task')
  const returnsDir = join(crewDir, 'returns')
  mkdirSync(taskDir, { recursive: true }); mkdirSync(returnsDir, { recursive: true })
  const base = JSON.parse(readFileSync(join(f.crewDir, 'crew.json'), 'utf8'))
  const taskReturn = join(returnsDir, 'task.json')
  const brief = join(crewDir, 'brief.md')
  writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({ ...base, task, checkout, task_return: taskReturn }))
  writeFileSync(join(crewDir, 'journal.jsonl'), '')
  writeFileSync(brief, '# brief\n')
  return { crewDir, taskDir, returnsDir, taskReturn, brief, checkout }
}

async function each(fn, options) {
  const f = fixture(options)
  try { return await fn(f) } finally { await f.d.stop(); f.cleanup() }
}

function request(socketPath, requestLine, expected = 1) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath)
    const frames = []
    let rest = Buffer.alloc(0)
    const timer = setTimeout(() => { socket.destroy(); resolve(frames) }, 500)
    const finish = () => { clearTimeout(timer); socket.destroy(); resolve(frames) }
    socket.on('error', reject)
    socket.on('data', (chunk) => {
      const split = splitFrames(Buffer.concat([rest, chunk])); rest = split.rest
      frames.push(...split.lines)
      if (frames.length >= expected) finish()
    })
    socket.on('connect', () => socket.write(requestLine))
  })
}

// A wait observes the condition it asserts. A fixed sleep standing in for "the
// socket delivered, the poll ran, the feed emitted" turns host load into a
// wrong value: measured 2026-08-22 at load 20.6, the polling test below read
// `expected 'orphaned', actual undefined`. On the deadline this throws naming
// the elapsed time, so the failure reads as a timeout and not as a bad value.
async function waitFor(condition, what, { timeout = 5_000, interval = 2 } = {}) {
  const started = Date.now()
  for (;;) {
    const value = condition()
    if (value) return value
    const elapsed = Date.now() - started
    if (elapsed >= timeout) throw new Error(`timed out after ${elapsed}ms waiting for ${what}`)
    // FIXED SLEEP: the poll cadence of this waiter itself, not a stand-in for a
    // condition — the condition is re-read on every tick.
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

function jsonFrame(frame) { return JSON.parse(frame) }
function appendJournal(f, row) { writeFileSync(join(f.crewDir, 'journal.jsonl'), `${JSON.stringify(row)}\n`, { flag: 'a' }) }
function stageRpcSeat(f, role) {
  const dir = join(f.taskDir, 'headless-rpc', role)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'pgid'), '900')
  writeFileSync(join(dir, 'cmd.fifo'), '')
  return dir
}
function instrumentCursorReads(f, positions) {
  f.deps.openSync = (...args) => openSync(...args)
  f.deps.readSync = (fd, buffer, offset, length, position) => {
    positions.push({ position, length })
    return readSync(fd, buffer, offset, length, position)
  }
  f.deps.fstatSync = (...args) => fstatSync(...args)
  f.deps.closeSync = (...args) => closeSync(...args)
  f.d = daemon({ root: f.root, deps: f.deps })
}

test('IMPORT FIREWALL: daemon.mjs carries no top-level import of the runner', () => {
  // Someone re-adding the convenience runner import at the top of daemon.mjs
  // must trip this allowlist rather than quietly restoring the server coupling.
  const lines = DAEMON_CODE.split('\n')
  const imports = []
  const isImportStart = (line) => /^import(?:[ \t]|\/\*)/.test(line)
  const isDynamicStart = (line) => /^import[ \t]*(?:\/\*[\s\S]*?\*\/[ \t]*)*\(/.test(line)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!/^import\b/.test(line) || !isImportStart(line) || isDynamicStart(line)) continue
    const remainder = line.slice('import'.length).replace(/^(?:[ \t]*\/\*[\s\S]*?\*\/[ \t]*)+/, '').trimStart()
    const sideEffect = remainder.match(/^(['"])([^'"]+)\1/)
    if (sideEffect) { imports.push(sideEffect[2]); continue }
    let found = false
    for (let j = i; j < lines.length; j += 1) {
      if (j > i && isImportStart(lines[j].trim())) break
      const from = lines[j].match(/\bfrom\s+(['"])([^'"]+)\1/)
      if (from) { imports.push(from[2]); i = j; found = true; break }
    }
    if (!found) imports.push(null)
  }
  // The allowlist admits first-party leaves: the server-side rpc helper, the
  // slug leaf, escalation policy, variants, and the JSON reader. A leaf is
  // only safe while it stays a leaf, so the next assertions pin that posture.
  assert.equal(
    imports.every((specifier) => specifier?.startsWith('node:') || specifier === './headless-rpc.mjs' || specifier === './slug.mjs' || specifier === './escalation-policy.mjs' || specifier === './variants.mjs' || specifier === './json-leaf.mjs'),
    true,
    'every daemon import, including side-effect imports, must be a node builtin, the server-side rpc helper, the slug leaf, the escalation policy leaf, the variants leaf, or the JSON leaf',
  )
  // Mutation killed: someone adding an import to slug.mjs — which would pull
  // that dependency into the server process through the allowlisted edge.
  const slugCode = readFileSync(new URL('./slug.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(slugCode, /^\s*import\b/m, 'crew/slug.mjs must stay import-free: the daemon allowlists it as a LEAF')
  const policyCode = readFileSync(new URL('./escalation-policy.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(policyCode, /^\s*import\b/m, 'crew/escalation-policy.mjs must stay import-free: the daemon allowlists it as a LEAF')
  const variantsCode = readFileSync(new URL('./variants.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(variantsCode, /^\s*import\b/m, 'crew/variants.mjs must stay import-free: the daemon allowlists it as a LEAF')
  // The JSON leaf is the one allowlisted leaf that is NOT import-free — it
  // legitimately reads through node:fs — so the import-free shape above cannot
  // pin it. Its leaf posture is that every import is a BUILTIN: a first-party
  // import here would pull that module into the daemon server process through
  // the allowlisted edge, and nothing else would notice.
  const leafCode = readFileSync(new URL('./json-leaf.mjs', import.meta.url), 'utf8')
  // The specifier extraction reads the first quoted string on each import line
  // and is written with an ordinary quote character class. maskCode() in
  // test/factory-env.test.mjs is regex-literal-aware since b194, so a quote
  // inside a regex literal no longer desynchronises the temp and ledger
  // tripwires that both read this file (#592).
  const leafSpecifiers = [...leafCode.matchAll(/^\s*import\b[^'"]*['"]([^'"]+)['"]/gm)].map(([, specifier]) => specifier)
  assert.equal(leafSpecifiers.length > 0, true, 'crew/json-leaf.mjs must declare at least one import for this pin to be meaningful')
  assert.deepEqual(
    leafSpecifiers.filter((specifier) => !specifier.startsWith('node:')),
    [],
    'crew/json-leaf.mjs must import only node builtins: the daemon allowlists it as a LEAF',
  )
  assert.equal(DAEMON_CODE.includes(DRIVE_MODULE), false, 'daemon must not name the driver module')
  assert.equal(DAEMON_CODE.includes(SEAT_IO_MODULE), false, 'daemon must not name the real io module')
  const dynamicImports = DAEMON_CODE.match(/\bimport\s*\(/g) || []
  const adapterImport = ['import', '(pathToFileURL(file).href)'].join('')
  assert.equal(DAEMON_CODE.includes(adapterImport), true, 'daemon must retain its existing computed adapter import')
  assert.equal(dynamicImports.length, 1, 'daemon must reject every dynamic import beyond its existing adapter loader')
  assert.doesNotMatch(DAEMON_CODE, /export\s+\*\s+from/, 'daemon must not re-export a runner through a barrel')
})

test('the child entry owns the runner imports', () => {
  assert.equal(CHILD_CODE.includes(`'./${DRIVE_MODULE}'`), true, 'child entry must import the driver')
  assert.equal(CHILD_CODE.includes(`'./${SEAT_IO_MODULE}'`), true, 'child entry must import real io')
  assert.equal(CHILD_CODE.includes('--run-child'), true, 'child entry must own the run-child guard')
})

test('enqueue forks the child entry module', async () => {
  await each(async (f) => {
    const result = await f.d.enqueue({ crew_dir: f.crewDir })
    assert.equal(f.forks[0][0].endsWith('child.mjs'), true, 'enqueue must fork crew/child.mjs')
    assert.equal(f.forks[0][1][0], '--run-child', 'child fork must retain the run-child argv flag')
    const spec = JSON.parse(f.forks[0][1][1])
    assert.equal(spec.run_id, result.run_id, 'the child must receive the daemon run identity')
    assert.equal(spec.budget_enabled, false, 'a no-budget daemon must keep child instrumentation non-load-bearing')
    assert.equal(spec.task_return, returnFor(f, result.run_id), 'daemon runs must use a run-addressed return path')
    assert.equal(f.boots.length, 0, 'a crew_dir enqueue must not boot a tier')
  })
})

test('a tier enqueue boots through the spawn seam and forks the run child', async () => {
  await each(async (f) => {
    const result = f.d.enqueue({ tier: 'build', task: 'tier-task', checkout: f.dir, brief_file: f.brief })
    assert.ok(result.run_id)
    assert.equal(f.boots.length, 1)
    const [command, argv, options] = f.boots[0]
    const flat = [command, ...argv].map(String).join(' ')
    assert.match(flat, /crew\.mjs/)
    assert.match(flat, /\bboot\b/)
    assert.match(flat, /--tier build/)
    assert.match(flat, /--headless-all/)
    assert.match(flat, new RegExp(`--checkout ${f.dir.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&')}`))
    assert.match(flat, /--task tier-task/)
    assert.equal(options.cwd, f.dir)
    assert.equal(f.forks.length, 1)
    assert.equal(f.forks[0][0].endsWith('child.mjs'), true)
  })
})

test('scopeEntryDefects agrees with drive.mjs over good and bad entries', () => {
  const entries = ['crew/crew.mjs', 'tasks/x/captures/', 'lib/*.mjs', '/abs/path.mjs', '../up.mjs', 'crew/', '', 42, 'a{b}.mjs']
  for (const entry of entries) assert.deepEqual(scopeEntryDefects([entry]), validateScopeEntries([entry]), entry)
})

test('enqueue carries every shape in the closed set into the enqueue record and the child spec', async () => {
  for (const name of VARIANT_NAMES) {
    await each(async (f) => {
      const filesInScope = VARIANTS[name]?.sources?.scope === 'inherited' ? ['a.mjs'] : undefined
      const spec = { crew_dir: f.crewDir, variant: name, ...(filesInScope ? { files_in_scope: filesInScope } : {}) }
      assert.doesNotThrow(() => f.d.enqueue(spec))
      const records = readFileSync(join(f.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
      const enqueued = records.find((record) => record.kind === 'enqueued')
      assert.ok(enqueued)
      assert.equal(Object.prototype.hasOwnProperty.call(enqueued, 'variant'), true)
      assert.equal(enqueued.variant, name)
      const childSpec = JSON.parse(f.forks[0][1][1])
      assert.equal(childSpec.variant, name)
      if (filesInScope) {
        assert.deepEqual(enqueued.files_in_scope, filesInScope)
        assert.deepEqual(childSpec.files_in_scope, filesInScope)
      } else {
        assert.equal(Object.prototype.hasOwnProperty.call(enqueued, 'files_in_scope'), false)
        assert.equal(Object.prototype.hasOwnProperty.call(childSpec, 'files_in_scope'), false)
      }
    })
  }
})

test('enqueue refuses an inherited scope that is absent, empty, or unusable before admission', async () => {
  for (const files_in_scope of [undefined, [], ['lib/*.mjs']]) {
    await each(async (f) => {
      const spec = { crew_dir: f.crewDir, variant: 'repair', ...(files_in_scope === undefined ? {} : { files_in_scope }) }
      assert.throws(() => f.d.enqueue(spec), (err) => {
        assert.equal(err.code, 'invalid-spec')
        if (files_in_scope?.length === 1) assert.match(err.message, /lib\/\*\.mjs/)
        return true
      })
      assert.equal(f.boots.length, 0)
      assert.equal(f.forks.length, 0)
      assert.equal(existsSync(join(f.root, 'runs.jsonl')), false)
    })
  }
})

test('enqueue refuses an unknown variant and names the closed set', async () => {
  for (const name of VARIANT_NAMES) {
    await each(async (f) => {
      assert.throws(() => f.d.enqueue({ crew_dir: f.crewDir, variant: 'no-such-shape' }), (err) => {
        assert.equal(err.code, 'invalid-spec')
        assert.match(err.message, new RegExp(name))
        return true
      })
    })
  }
})

test('an unknown variant is refused before any tier boot, fork or registry record', async () => {
  await each(async (f) => {
    assert.throws(() => f.d.enqueue({ tier: 'build', task: 'tier-task', checkout: f.dir, brief_file: f.brief, variant: 'no-such-shape' }), (err) => err.code === 'invalid-spec')
    assert.equal(f.boots.length, 0)
    assert.equal(f.forks.length, 0)
    assert.equal(existsSync(join(f.root, 'runs.jsonl')), false)
    assert.deepEqual(f.d.list(), [])
  })
})

test('an absent variant leaves the enqueue record and the child spec untouched', async () => {
  await each(async (f) => {
    f.d.enqueue({ crew_dir: f.crewDir })
    const records = readFileSync(join(f.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
    const enqueued = records.find((record) => record.kind === 'enqueued')
    const spec = JSON.parse(f.forks[0][1][1])
    assert.equal(Object.prototype.hasOwnProperty.call(enqueued, 'variant'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(spec, 'variant'), false)
  })
})

test('a daemon-forked repair run makes the driver open the repair shape', async () => {
  const stagesFor = (ctx) => {
    const stages = []
    const io = {
      assign: ({ role }) => ({ id: role, returnPath: `${role}:1` }),
      wait: () => null,
      writeFile: () => {},
      readFile: () => null,
      run: () => ({ ok: true, output: '' }),
      changedFiles: () => [],
      commit: () => 'abc1234',
      log: (entry) => { if (entry && typeof entry.stage === 'string') stages.push(entry.stage) },
      now: () => 0,
    }
    try { driveTask(ctx, io) } catch { /* labels already recorded */ }
    return stages
  }
  await each(async (f) => {
    f.d.enqueue({ crew_dir: f.crewDir, task: 'daemon80', checkout: f.dir, brief_file: f.brief, lane: 'lane-cmd', variant: 'repair', files_in_scope: ['a.mjs', 'a.test.mjs'] })
    const spec = JSON.parse(f.forks[0][1][1])
    let seen
    runChild(spec, {
      preflight: false,
      driveTask: (ctx) => { seen = ctx; return { status: 'done' } },
      seatIo: () => ({}),
    })
    const stages = stagesFor(seen)
    assert.equal(stages[0], 'repair:r1')
    assert.equal(stages.includes('plan:r1'), false)
    assert.deepEqual(seen.files_in_scope, ['a.mjs', 'a.test.mjs'])
  })
  await each(async (f) => {
    f.d.enqueue({ crew_dir: f.crewDir, task: 'daemon80', checkout: f.dir, brief_file: f.brief, lane: 'lane-cmd' })
    const spec = JSON.parse(f.forks[0][1][1])
    let seen
    runChild(spec, {
      preflight: false,
      driveTask: (ctx) => { seen = ctx; return { status: 'done' } },
      seatIo: () => ({}),
    })
    const stages = stagesFor(seen)
    assert.equal(stages[0], 'plan:r1')
  })
})

test('a tier enqueue takes the crew dir from what boot reported', async () => {
  const reported = join(tmpdir(), 'crew-reported-neither-checkout-nor-task')
  const f = fixture({ bootCrewDir: reported })
  try {
    const result = f.d.enqueue({ tier: 'build', task: 'tier-task', checkout: f.dir, brief_file: f.brief })
    assert.equal(f.d.list()[0].run_id, result.run_id)
    assert.equal(f.d.list()[0].crew_dir, reported)
  } finally { await f.d.stop(); f.cleanup(); rmSync(reported, { recursive: true, force: true }) }
})

test('an active equivalent tier run refuses before rebooting its crew', async () => {
  await each(async (f) => {
    f.d.enqueue({ tier: 'build', task: 'Same Task', checkout: f.dir, brief_file: f.brief })
    const before = readFileSync(join(f.reportedCrewDir, 'crew.json'), 'utf8')
    assert.throws(() => f.d.enqueue({ tier: 'mechanical', task: 'same-task', checkout: f.dir, brief_file: f.brief }), (err) => err.code === 'run-active')
    assert.equal(f.boots.length, 1)
    assert.equal(readFileSync(join(f.reportedCrewDir, 'crew.json'), 'utf8'), before)
    assert.equal(f.d.list().length, 1)
  })
})

test('a tier boot does not reject a distinct manually supplied crew directory', async () => {
  await each(async (f) => {
    f.d.enqueue({ crew_dir: f.crewDir, task: 'same-task', checkout: f.dir, brief_file: f.brief })
    const result = f.d.enqueue({ tier: 'mechanical', task: 'same-task', checkout: f.dir, brief_file: f.brief })
    assert.ok(result.run_id)
    assert.equal(f.boots.length, 1)
    assert.equal(f.d.list().length, 2)
    assert.notEqual(f.d.list().find((run) => run.run_id === result.run_id).crew_dir, f.crewDir)
  })
})

test('a boot that exits non-zero refuses by name and registers no run', async () => {
  await each(async (f) => {
    f.deps.spawnSync = (...args) => { f.boots.push(args); return { status: 1, stderr: 'error: unknown tier "nope" — valid tiers: mechanical, build, judge\n' } }
    f.d = daemon({ root: f.root, deps: f.deps })
    assert.throws(() => f.d.enqueue({ tier: 'nope', task: 'tier-task', checkout: f.dir, brief_file: f.brief }), (err) => err.code === 'boot-failed' && /nope/.test(err.message) && /unknown tier/.test(err.message))
    assert.deepEqual(f.d.list(), [])
    assert.equal(f.forks.length, 0)
  })
})

test('a boot that prints no crew_json refuses', async () => {
  await each(async (f) => {
    f.deps.spawnSync = (...args) => { f.boots.push(args); return { status: 0, stdout: 'boot complete\n', stderr: '' } }
    f.d = daemon({ root: f.root, deps: f.deps })
    assert.throws(() => f.d.enqueue({ tier: 'build', task: 'tier-task', checkout: f.dir, brief_file: f.brief }), (err) => err.code === 'boot-failed' && /no crew_json/.test(err.message))
    assert.deepEqual(f.d.list(), [])
    assert.equal(f.forks.length, 0)
  })
})

test('enqueue refuses crew_dir with tier, and refuses neither', async () => {
  await each(async (f) => {
    assert.throws(() => f.d.enqueue({ crew_dir: f.crewDir, tier: 'build' }), (err) => err.code === 'invalid-spec')
    assert.throws(() => f.d.enqueue({}), (err) => err.code === 'invalid-spec')
    assert.equal(f.boots.length, 0)
    assert.equal(f.forks.length, 0)
  })
})

test('a tier enqueue refuses a missing brief file, task, or checkout', async () => {
  await each(async (f) => {
    const base = { tier: 'build', task: 'tier-task', checkout: f.dir, brief_file: f.brief }
    assert.throws(() => f.d.enqueue({ ...base, brief_file: join(f.dir, 'missing.md') }), (err) => err.code === 'invalid-spec')
    assert.throws(() => f.d.enqueue({ ...base, task: '' }), (err) => err.code === 'invalid-spec')
    assert.throws(() => f.d.enqueue({ ...base, checkout: '' }), (err) => err.code === 'invalid-spec')
    assert.equal(f.boots.length, 0)
    assert.equal(f.forks.length, 0)
  })
})

test('run_id rejects path traversal and slash characters before admission', async () => {
  await each(async (f) => {
    for (const run_id of ['../escape', 'with/slash']) {
      assert.throws(() => f.d.enqueue({ crew_dir: f.crewDir, run_id }), (err) => {
        assert.equal(err.code, 'invalid-spec')
        assert.match(err.message, /A-Za-z0-9/)
        return true
      })
    }
    assert.equal(f.forks.length, 0)
    assert.deepEqual(f.d.list(), [])
  })
})

test('the daemon pane constant does not drift from seat-io DEFAULT_TRANSPORT', () => {
  assert.equal(PANE_TRANSPORT, DEFAULT_TRANSPORT, 'daemon pane transport must stay pinned to seat-io DEFAULT_TRANSPORT')
})

// 1. The byte splitter, rather than readline, owns LF framing.
// Asserts OUR framing only. An earlier version also pinned readline's own
// record count at 2, which is Node-version-dependent \u2014 node 24 splits on
// U+2028, node 20 does not \u2014 and failed CI on the node 20 leg while passing
// on 24. The contract is that a U+2028 inside a JSON string never breaks a
// frame regardless of what readline would have done; `crew/headless-rpc.test.mjs`
// pins the same property the same way.
test('splitStream keeps U+2028 inside one JSON record', async () => {
  await each(async ({ d }) => {
    await d.start()
    const payload = `${JSON.stringify({ id: 'u', cmd: 'ping', params: { note: 'a\u2028b' } })}\n`
    const frames = await request(d.socketPath, payload)
    assert.equal(frames.length, 1)
    assert.equal(jsonFrame(frames[0]).ok, true)
    assert.equal(jsonFrame(frames[0]).id, 'u')
  })
})

// 2. Rest is carried as bytes across chunks, including a split UTF-8 scalar.
test('socket framing reassembles three chunks and a split multibyte character', async () => {
  await each(async ({ d }) => {
    await d.start()
    const payload = Buffer.from(`${JSON.stringify({ id: 'split', cmd: 'ping', params: { note: 'x☃y' } })}\n`)
    const socket = net.connect(d.socketPath)
    const frames = []
    let rest = Buffer.alloc(0)
    socket.on('data', (chunk) => { const split = splitFrames(Buffer.concat([rest, chunk])); rest = split.rest; frames.push(...split.lines) })
    await new Promise((resolve) => socket.on('connect', resolve))
    const snow = Buffer.from('☃')
    const at = payload.indexOf(snow)
    socket.write(payload.subarray(0, at + 1))
    socket.write(payload.subarray(at + 1, at + 2))
    socket.write(payload.subarray(at + 2))
    await waitFor(() => frames.length >= 1, 'the reassembled frame')
    socket.destroy()
    assert.equal(frames.length, 1)
    assert.equal(jsonFrame(frames[0]).id, 'split')
  })
})

// 3. A live pidfile is a legible double-start refusal.
test('double start names the live pid and socket', async () => {
  await each(async ({ d, root, deps }) => {
    await d.start()
    const second = daemon({ root, deps })
    await assert.rejects(() => second.start(), (err) => err.message.includes('700') && err.message.includes(d.socketPath))
  })
})

// 4. ESRCH is the only dead answer.
test('stale ESRCH pidfile does not block start', async () => {
  await each(async ({ d, root, deps, alive }) => {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'daemon.json'), JSON.stringify({ pid: 999, socket: join(root, 'daemon.sock') }))
    alive.delete(999)
    await d.start()
    assert.equal(existsSync(join(root, 'daemon.json')), true)
  })
})

// 5. stop removes both lifecycle markers and permits a fresh bind.
test('stop unlinks socket and pidfile and permits a subsequent start', async () => {
  const f = fixture()
  try {
    await f.d.start(); const socket = f.d.socketPath
    await f.d.stop()
    assert.equal(existsSync(socket), false); assert.equal(existsSync(join(f.root, 'daemon.json')), false)
    const second = daemon({ root: f.root, deps: f.deps })
    await second.start(); await second.stop()
  } finally { f.cleanup() }
})

// 6. Unknown verbs are explicit errors, never success-shaped responses.
test('unknown command carries command-named error and no result', async () => {
  await each(async ({ d }) => {
    await d.start()
    const frame = jsonFrame((await request(d.socketPath, '{"id":"x","cmd":"wat"}\n'))[0])
    assert.equal(frame.ok, false); assert.equal(frame.error.code, 'unknown-command'); assert.equal(frame.error.command, 'wat'); assert.equal('result' in frame, false)
  })
})

// 7. Every malformed request gets a parse response.
test('malformed requests are table-driven parse errors', async () => {
  await each(async ({ d }) => {
    await d.start()
    for (const line of ['{bad\n', '[1]\n', '{"id":"x"}\n', '{"id":7,"cmd":"ping"}\n']) {
      const frame = jsonFrame((await request(d.socketPath, line))[0])
      assert.equal(frame.ok, false); assert.equal(frame.error.code, 'parse'); assert.equal('result' in frame, false)
    }
  })
})

// 8. State is a closed, terminal-first query.
test('deriveState truth table is closed and terminal-first', () => {
  assert.deepEqual(RUN_STATES, ['queued', 'working', 'blocked', 'done', 'dead'])
  assert.deepEqual([
    deriveState({ terminal: false, alive: true, blocked: false }),
    deriveState({ terminal: false, alive: true, blocked: true }),
    deriveState({ terminal: false, alive: false, blocked: false }),
    deriveState({ terminal: true, alive: false, blocked: false }),
    deriveState({ terminal: true, alive: true, blocked: true }),
    deriveState({ terminal: false, alive: null, blocked: false }),
    deriveState({ terminal: false, alive: null, blocked: false, queued: true }),
    deriveState({ terminal: true, alive: null, blocked: false, queued: true }),
  ], ['working', 'blocked', 'dead', 'done', 'done', 'working', 'queued', 'done'])
})

test('over the limit, enqueue queues instead of forking', async () => {
  await each(async (f) => {
    const secondCrew = mintCrew(f, { name: 'crew-b', checkout: join(f.dir, 'checkout-b') })
    const first = f.d.enqueue({ crew_dir: f.crewDir })
    const second = f.d.enqueue({ crew_dir: secondCrew.crewDir })
    assert.ok(first.run_id); assert.ok(second.run_id)
    assert.equal(f.forks.length, 1)
    assert.equal(f.d.list().length, 2)
  }, { concurrency: 1 })
})

test('a crew dir holding an envelope refuses before admission', async () => {
  await each(async (f) => {
    writeFileSync(f.taskReturn, JSON.stringify({ status: 'done' }))
    assert.throws(() => f.d.enqueue({ crew_dir: f.crewDir }), (err) => {
      assert.equal(err.code, 'crew-settled')
      assert.match(err.message, new RegExp(f.crewDir.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&')))
      assert.match(err.message, /boot/i)
      return true
    })
    assert.equal(f.forks.length, 0)
    assert.equal(existsSync(join(f.root, 'runs.jsonl')), false)
    assert.deepEqual(f.d.list(), [])
  })
})

test('a settled daemon crew dir admits a second run without losing the first envelope', async () => {
  await each(async (f) => {
    const first = f.d.enqueue({ crew_dir: f.crewDir, run_id: 'first' }).run_id
    const envelope = JSON.stringify({ status: 'escalation', summary: 'first' })
    writeFileSync(returnFor(f, first), envelope)
    writeFileSync(f.taskReturn, envelope)
    f.d.poll()
    const before = f.d.result({ run: first })
    const beforeBytes = readFileSync(returnFor(f, first))
    const second = f.d.enqueue({ crew_dir: f.crewDir, run_id: 'second' }).run_id
    assert.equal(before.outcome, 'escalation')
    assert.equal(f.forks.length, 2)
    assert.notEqual(returnFor(f, first), returnFor(f, second))
    assert.deepEqual(f.d.result({ run: first }), before)
    assert.equal(readFileSync(returnFor(f, first)).equals(beforeBytes), true)
    assert.equal(f.d.state({ run: second }).state, 'working')
  })
})

test('a well-known task_return override cannot surrender the first run on re-enqueue', async () => {
  const f = fixture()
  let next
  try {
    const first = f.d.enqueue({ crew_dir: f.crewDir, run_id: 'mirror-owner', task_return: 'returns/task.json' }).run_id
    writeFileSync(f.taskReturn, JSON.stringify({ status: 'done', summary: 'first' }))
    f.d.poll()
    assert.equal(f.d.result({ run: first }).envelope.summary, 'first')
    assert.throws(() => f.d.enqueue({ crew_dir: f.crewDir, run_id: 'second' }), (err) => err.code === 'crew-settled')

    await f.d.stop()
    next = daemon({ root: f.root, deps: f.deps })
    assert.throws(() => next.enqueue({ crew_dir: f.crewDir, run_id: 'after-restart' }), (err) => err.code === 'crew-settled')
  } finally {
    await f.d.stop()
    await next?.stop()
    f.cleanup()
  }
})

test('a symlink alias of the mirror cannot claim separate return ownership', async () => {
  await each(async (f) => {
    symlinkSync('task.json', join(f.returnsDir, 'alias.json'))
    const first = f.d.enqueue({ crew_dir: f.crewDir, run_id: 'alias-owner', task_return: 'returns/alias.json' }).run_id
    writeFileSync(join(f.returnsDir, 'alias.json'), JSON.stringify({ status: 'done', summary: 'first' }))
    f.d.poll()
    assert.equal(f.d.result({ run: first }).envelope.summary, 'first')
    assert.throws(() => f.d.enqueue({ crew_dir: f.crewDir, run_id: 'alias-second' }), (err) => err.code === 'crew-settled')
  })
})

test('crew-settled refusal carries its code over the socket', async () => {
  const f = fixture()
  try {
    await f.d.start()
    writeFileSync(f.taskReturn, JSON.stringify({ status: 'done' }))
    const frame = jsonFrame((await request(f.d.socketPath, `${JSON.stringify({ id: 'settled', cmd: 'enqueue', params: { crew_dir: f.crewDir } })}\n`))[0])
    assert.equal(frame.ok, false)
    assert.equal(frame.error.code, 'crew-settled')
    assert.match(frame.error.message, /boot/i)
    assert.equal(f.forks.length, 0)
  } finally { await f.d.stop(); f.cleanup() }
})

test('the RV3-1 sequence keeps run-addressed envelopes distinct', async () => {
  await each(async (f) => {
    const shared = join(f.dir, 'checkout-shared')
    const secondCrew = mintCrew(f, { name: 'crew-b', checkout: shared })
    const first = f.d.enqueue({ crew_dir: f.crewDir, checkout: shared, run_id: 'first' }).run_id
    const envelope = JSON.stringify({ status: 'done' })
    writeFileSync(returnFor(f, first), envelope)
    writeFileSync(f.taskReturn, envelope)
    f.d.poll()
    const second = f.d.enqueue({ crew_dir: f.crewDir, checkout: shared, run_id: 'second' }).run_id
    const third = f.d.enqueue({ crew_dir: secondCrew.crewDir }).run_id
    assert.equal(f.forks.length, 2)
    assert.notEqual(returnFor(f, first), returnFor(f, second))
    assert.equal(f.d.state({ run: first }).state, 'done')
    assert.equal(f.d.state({ run: second }).state, 'working')
    assert.equal(f.d.state({ run: third }).state, 'queued')
    const records = readFileSync(join(f.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(records.filter((record) => record.run_id === first && record.kind === 'started').length, 1)
  })
})

test('a queued run that acquires an envelope settles instead of forking', async () => {
  await each(async (f) => {
    const secondCrew = mintCrew(f, { name: 'crew-b', checkout: join(f.dir, 'checkout-b') })
    f.d.enqueue({ crew_dir: f.crewDir })
    const queued = f.d.enqueue({ crew_dir: secondCrew.crewDir }).run_id
    const first = f.d.list().find((row) => row.crew_dir === f.crewDir).run_id
    writeFileSync(join(secondCrew.returnsDir, `${queued}.task.json`), JSON.stringify({ status: 'done' }))
    writeFileSync(returnFor(f, first), JSON.stringify({ status: 'done' }))
    f.d.poll()
    assert.equal(f.forks.length, 1)
    assert.equal(f.d.state({ run: queued }).state, 'done')
    const records = readFileSync(join(f.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(records.some((record) => record.run_id === queued && record.kind === 'started'), false)
  }, { concurrency: 1 })
})

test('a queued run never claims it started', async () => {
  await each(async (f) => {
    const secondCrew = mintCrew(f, { name: 'crew-b', checkout: join(f.dir, 'checkout-b') })
    f.d.enqueue({ crew_dir: f.crewDir })
    const queued = f.d.enqueue({ crew_dir: secondCrew.crewDir }).run_id
    assert.equal(f.d.state({ run: queued }).state, 'queued')
    assert.equal(f.d.list().find((row) => row.run_id === queued).state, 'queued')
    const records = readFileSync(join(f.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(records.some((record) => record.run_id === queued && record.kind === 'started'), false)
    assert.equal(f.d.feed(queued, 0).some((event) => event.kind === 'started'), false)
  }, { concurrency: 1 })
})

test('a settling run starts the next queued run, FIFO, exactly once', async () => {
  await each(async (f) => {
    const secondCrew = mintCrew(f, { name: 'crew-b', checkout: join(f.dir, 'checkout-b') })
    const first = f.d.enqueue({ crew_dir: f.crewDir }).run_id
    const second = f.d.enqueue({ crew_dir: secondCrew.crewDir }).run_id
    assert.equal(f.forks.length, 1)
    writeFileSync(returnFor(f, first), JSON.stringify({ status: 'done' }))
    f.d.poll()
    assert.equal(f.forks.length, 2)
    assert.equal(f.d.state({ run: second }).state, 'working')
    for (let i = 0; i < 4; i += 1) f.d.poll()
    assert.equal(f.forks.length, 2)
    const records = readFileSync(join(f.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(records.filter((record) => record.run_id === first && record.kind === 'started').length, 1)
    assert.equal(records.filter((record) => record.run_id === second && record.kind === 'started').length, 1)
  }, { concurrency: 1 })
})

test('queued work starts in FIFO order', async () => {
  await each(async (f) => {
    const secondCrew = mintCrew(f, { name: 'crew-b', checkout: join(f.dir, 'checkout-b') })
    const thirdCrew = mintCrew(f, { name: 'crew-c', checkout: join(f.dir, 'checkout-c') })
    const first = f.d.enqueue({ crew_dir: f.crewDir }).run_id
    const second = f.d.enqueue({ crew_dir: secondCrew.crewDir }).run_id
    const third = f.d.enqueue({ crew_dir: thirdCrew.crewDir }).run_id
    writeFileSync(returnFor(f, first), JSON.stringify({ status: 'done' }))
    f.d.poll()
    assert.equal(f.d.state({ run: second }).state, 'working')
    assert.equal(f.d.state({ run: third }).state, 'queued')
  }, { concurrency: 1 })
})

test('at most one running run per checkout', async () => {
  await each(async (f) => {
    const shared = join(f.dir, 'checkout-shared')
    const secondCrew = mintCrew(f, { name: 'crew-b', checkout: shared })
    const first = f.d.enqueue({ crew_dir: f.crewDir, checkout: shared }).run_id
    const queued = f.d.enqueue({ crew_dir: secondCrew.crewDir }).run_id
    assert.equal(f.forks.length, 1)
    assert.equal(f.d.state({ run: queued }).state, 'queued')
    writeFileSync(returnFor(f, first), JSON.stringify({ status: 'done' }))
    f.d.poll()
    assert.equal(f.forks.length, 2)
    assert.equal(f.d.state({ run: queued }).state, 'working')
  }, { concurrency: 3 })
})

test('a settled escalation frees the slot and is never re-forked', async () => {
  await each(async (f) => {
    const secondCrew = mintCrew(f, { name: 'crew-b', checkout: join(f.dir, 'checkout-b') })
    const parked = f.d.enqueue({ crew_dir: f.crewDir }).run_id
    const next = f.d.enqueue({ crew_dir: secondCrew.crewDir }).run_id
    writeFileSync(returnFor(f, parked), JSON.stringify({ status: 'escalation' }))
    f.d.poll()
    assert.equal(f.d.result({ run: parked }).outcome, 'escalation')
    assert.equal(f.d.state({ run: parked }).state, 'done')
    assert.equal(f.d.state({ run: next }).state, 'working')
    for (let i = 0; i < 5; i += 1) f.d.poll()
    assert.equal(f.forks.length, 2)
    const records = readFileSync(join(f.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(records.filter((record) => record.run_id === parked && record.kind === 'started').length, 1)
  }, { concurrency: 1 })
})

test('an eligible review escalation regrants once in place with a continuation brief', async () => {
  await each(async (f) => {
    const envelope = {
      status: 'escalation',
      details: {
        escalation: { where: 'review', why: 'close the remaining defect' },
        extra_rounds_granted: [{ where: 'review', round: 3 }],
        gate: { discrimination: 'proven' },
        commit: null,
      },
    }
    appendJournal(f, { review_outcome: { dispatch: 'd3', must_fix: 2, findings: [] } })
    appendJournal(f, { review_outcome: { dispatch: 'd5', must_fix: 1, findings: [{ id: 'RV3-1', severity: 'must-fix', location: 'crew/daemon.mjs:191', summary: 'close this defect' }] } })
    const run = f.d.enqueue({ crew_dir: f.crewDir }).run_id
    writeFileSync(returnFor(f, run), JSON.stringify(envelope, null, 2))
    f.d.poll()
    const records = readFileSync(join(f.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(records.filter((record) => record.run_id === run && record.kind === 'regrant').length, 1)
    assert.equal(records.some((record) => record.run_id === run && record.kind === 'settled'), false)
    assert.equal(existsSync(returnFor(f, run)), true)
    assert.equal(existsSync(returnFor(f, run, 2)), false)
    assert.equal(readdirSync(join(f.crewDir, 'returns')).some((name) => name.includes('regrant-1')), false)
    assert.equal(existsSync(join(f.taskDir, 'regrant-brief.md')), true)
    assert.notEqual(f.d.state({ run }).state, 'done')
    assert.equal(f.forks.length, 2)
    const spec = JSON.parse(f.forks[1][1][1])
    assert.equal(spec.brief_file, join(f.taskDir, 'regrant-brief.md'))
    assert.equal(spec.continuation, true)
    assert.equal(spec.task_return, returnFor(f, run, 2))

    writeFileSync(returnFor(f, run, 2), JSON.stringify(envelope, null, 2))
    f.d.poll()
    const after = readFileSync(join(f.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(after.filter((record) => record.run_id === run && record.kind === 'regrant').length, 1)
    assert.equal(after.filter((record) => record.run_id === run && record.kind === 'settled').length, 1)
  })
})

test('a regranted continuation gets a fresh unmeasured envelope budget', async () => {
  await each(async (f) => {
    const envelope = {
      status: 'escalation',
      details: {
        escalation: { where: 'review', why: 'close the remaining defect' },
        extra_rounds_granted: [{ where: 'review', round: 3 }],
        gate: { discrimination: 'proven' },
        commit: null,
      },
    }
    appendJournal(f, { review_outcome: { dispatch: 'd3', must_fix: 2, findings: [] } })
    appendJournal(f, { review_outcome: { dispatch: 'd5', must_fix: 1, findings: [{ id: 'RV3-1', severity: 'must-fix', location: 'crew/daemon.mjs:191', summary: 'close this defect' }] } })
    const run = f.d.enqueue({ crew_dir: f.crewDir }).run_id
    const first = writeTornFile({ file: returnFor(f, run), completeText: JSON.stringify(envelope, null, 2) })
    f.alive.delete(900)
    for (let i = 0; i < 5; i += 1) f.d.poll()
    let records = readFileSync(join(f.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(records.some((record) => record.run_id === run && record.kind === 'orphaned'), false)

    f.alive.add(900)
    first.complete()
    f.d.poll()
    records = readFileSync(join(f.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(records.filter((record) => record.run_id === run && record.kind === 'regrant').length, 1)
    assert.equal(records.some((record) => record.run_id === run && record.kind === 'orphaned'), false)

    writeTornFile({ file: returnFor(f, run, 2), completeText: JSON.stringify(envelope, null, 2) })
    f.alive.delete(900)
    f.d.poll()
    records = readFileSync(join(f.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(records.some((record) => record.run_id === run && record.kind === 'orphaned'), false)
  })
})

test('a stale child callback cannot orphan the regranted continuation', async () => {
  await each(async (f) => {
    const children = []
    f.deps.fork = (...args) => {
      const handlers = {}
      const child = {
        pid: 900,
        on(event, fn) { handlers[event] = fn; return this },
        unref() {},
      }
      children.push({ args, handlers })
      return child
    }
    f.d = daemon({ root: f.root, deps: f.deps })
    appendJournal(f, { review_outcome: { dispatch: 'd3', must_fix: 2, findings: [] } })
    appendJournal(f, { review_outcome: { dispatch: 'd5', must_fix: 1, findings: [] } })
    const run = f.d.enqueue({ crew_dir: f.crewDir }).run_id
    writeFileSync(returnFor(f, run), JSON.stringify({
      status: 'escalation',
      details: {
        escalation: { where: 'review', why: 'continue on the same checkout' },
        extra_rounds_granted: [{ where: 'review', round: 3 }],
        gate: { discrimination: 'proven' },
      },
    }))
    f.d.poll()
    assert.equal(children.length, 2)
    children[0].handlers.exit(1, null)
    const records = readFileSync(join(f.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(records.some((record) => record.run_id === run && record.kind === 'orphaned'), false)
    assert.equal(records.some((record) => record.run_id === run && record.kind === 'settled'), false)
    assert.equal(f.d.state({ run }).state, 'working')
  })
})

test('a failed regrant registry append restores the envelope before settlement', async () => {
  const f = fixture()
  try {
    let failRegrant = true
    const originalAppend = appendFileSync
    f.deps.appendFileSync = (path, data, options) => {
      if (failRegrant && String(data).includes('"kind":"regrant"')) {
        failRegrant = false
        throw new Error('registry append failed')
      }
      return originalAppend(path, data, options)
    }
    f.d = daemon({ root: f.root, deps: f.deps })
    appendJournal(f, { review_outcome: { dispatch: 'd3', must_fix: 1, findings: [] } })
    const run = f.d.enqueue({ crew_dir: f.crewDir }).run_id
    writeFileSync(returnFor(f, run), JSON.stringify({
      status: 'escalation',
      details: {
        escalation: { where: 'review', why: 'registry append fails' },
        extra_rounds_granted: [{ where: 'review', round: 3 }],
        gate: { discrimination: 'proven' },
      },
    }))
    f.d.poll()
    const records = readFileSync(join(f.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(existsSync(returnFor(f, run)), true)
    assert.equal(existsSync(returnFor(f, run, 2)), false)
    assert.equal(readdirSync(join(f.crewDir, 'returns')).some((name) => name.includes('regrant-1')), false)
    assert.equal(records.filter((record) => record.run_id === run && record.kind === 'regrant').length, 0)
    assert.equal(records.filter((record) => record.run_id === run && record.kind === 'settled').length, 1)
    assert.equal(f.d.result({ run }).outcome, 'escalation')
    assert.equal(f.d.state({ run }).state, 'done')
  } finally { await f.d.stop(); f.cleanup() }
})

test('a failed continuation fork restores the terminal escalation', async () => {
  const f = fixture()
  let next
  try {
    let forks = 0
    f.deps.fork = (...args) => {
      forks += 1
      if (forks === 2) throw new Error('EAGAIN')
      return { pid: 900, on() {}, unref() {} }
    }
    f.d = daemon({ root: f.root, deps: f.deps })
    appendJournal(f, { review_outcome: { dispatch: 'd3', must_fix: 1, findings: [] } })
    const run = f.d.enqueue({ crew_dir: f.crewDir }).run_id
    writeFileSync(returnFor(f, run), JSON.stringify({
      status: 'escalation',
      details: {
        escalation: { where: 'review', why: 'continuation fork fails' },
        extra_rounds_granted: [{ where: 'review', round: 3 }],
        gate: { discrimination: 'proven' },
      },
    }))
    f.d.poll()
    const records = readFileSync(join(f.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(existsSync(returnFor(f, run)), true)
    assert.equal(existsSync(returnFor(f, run, 2)), false)
    assert.equal(readdirSync(join(f.crewDir, 'returns')).some((name) => name.includes('regrant-1')), false)
    assert.equal(records.filter((record) => record.run_id === run && record.kind === 'regrant').length, 1)
    assert.equal(records.filter((record) => record.run_id === run && record.kind === 'settled').length, 1)
    assert.equal(records.some((record) => record.run_id === run && record.kind === 'orphaned'), false)
    assert.equal(f.d.result({ run }).outcome, 'escalation')
    assert.equal(f.d.state({ run }).state, 'done')

    await f.d.stop()
    next = daemon({ root: f.root, deps: f.deps })
    assert.equal(next.result({ run }).outcome, 'escalation')
    assert.equal(next.state({ run }).state, 'done')
  } finally {
    await f.d.stop()
    await next?.stop()
    f.cleanup()
  }
})

test('a post-record continuation launch failure settles the restored escalation', async () => {
  const f = fixture()
  try {
    let started = 0
    const originalAppend = appendFileSync
    f.deps.appendFileSync = (path, data, options) => {
      if (String(data).includes('"kind":"started"')) {
        started += 1
        if (started === 2) throw new Error('started record failed')
      }
      return originalAppend(path, data, options)
    }
    f.d = daemon({ root: f.root, deps: f.deps })
    appendJournal(f, { review_outcome: { dispatch: 'd3', must_fix: 1, findings: [] } })
    const run = f.d.enqueue({ crew_dir: f.crewDir }).run_id
    writeFileSync(returnFor(f, run), JSON.stringify({
      status: 'escalation',
      details: {
        escalation: { where: 'review', why: 'started record fails' },
        extra_rounds_granted: [{ where: 'review', round: 3 }],
        gate: { discrimination: 'proven' },
      },
    }))
    f.d.poll()
    const records = readFileSync(join(f.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(existsSync(returnFor(f, run)), true)
    assert.equal(existsSync(returnFor(f, run, 2)), false)
    assert.equal(records.filter((record) => record.run_id === run && record.kind === 'regrant').length, 1)
    assert.equal(records.filter((record) => record.run_id === run && record.kind === 'settled').length, 1)
    assert.equal(f.d.result({ run }).outcome, 'escalation')
    assert.equal(f.d.state({ run }).state, 'done')
  } finally { await f.d.stop(); f.cleanup() }
})

test('a post-record continuation launch reaps the child it already forked', async () => {
  const f = fixture()
  try {
    const children = []
    const kills = []
    f.deps.fork = (...args) => {
      const handlers = {}
      const child = {
        pid: 900,
        on(event, fn) { handlers[event] = fn; return this },
        unref() {},
      }
      children.push({ args, handlers })
      f.forks.push(args)
      return child
    }
    let started = 0
    const originalAppend = appendFileSync
    f.deps.appendFileSync = (path, data, options) => {
      if (String(data).includes('"kind":"started"')) {
        started += 1
        if (started === 2) throw new Error('started record failed')
      }
      return originalAppend(path, data, options)
    }
    const originalKill = f.deps.kill
    f.deps.kill = (pid, signal) => {
      kills.push([pid, signal])
      if (signal !== 0) f.alive.delete(Math.abs(pid))
      return originalKill(pid, signal)
    }
    f.d = daemon({ root: f.root, deps: f.deps })
    appendJournal(f, { review_outcome: { dispatch: 'd3', must_fix: 1, findings: [] } })
    const run = f.d.enqueue({ crew_dir: f.crewDir }).run_id
    writeFileSync(returnFor(f, run), JSON.stringify({
      status: 'escalation',
      details: {
        escalation: { where: 'review', why: 'started record fails after fork' },
        extra_rounds_granted: [{ where: 'review', round: 3 }],
        gate: { discrimination: 'proven' },
      },
    }))
    f.d.poll()
    const records = readFileSync(join(f.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(kills.some(([pid, signal]) => pid === -900 && signal !== 0), true)
    assert.equal(kills.some(([pid, signal]) => pid === 900 && signal !== 0), false)
    assert.equal(records.filter((record) => record.run_id === run && record.kind === 'regrant').length, 1)
    assert.equal(records.filter((record) => record.run_id === run && record.kind === 'settled').length, 1)
    assert.equal(records.filter((record) => record.run_id === run && record.kind === 'orphaned').length, 0)
    assert.equal(f.d.result({ run }).outcome, 'escalation')
    assert.equal(f.d.state({ run }).state, 'done')

    children[1].handlers.exit(0, null)
    f.d.poll()
    const after = readFileSync(join(f.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(after.filter((record) => record.run_id === run && record.kind === 'settled').length, 1)
    assert.equal(after.filter((record) => record.run_id === run && record.kind === 'orphaned').length, 0)
    assert.equal(f.forks.length, 2)

    assert.equal(f.alive.has(900), false)
    if (f.alive.has(900)) writeFileSync(returnFor(f, run), JSON.stringify({ status: 'done', details: {} }, null, 2))
    assert.equal(f.d.result({ run }).outcome, 'escalation')
  } finally { await f.d.stop(); f.cleanup() }
})

test('a reap never signals a pgid it must not own', async () => {
  const f = fixture()
  try {
    const kills = []
    f.deps.fork = (...args) => {
      const handlers = {}
      const child = {
        pid: 1,
        on(event, fn) { handlers[event] = fn; return this },
        unref() {},
      }
      f.forks.push(args)
      return child
    }
    f.alive.add(1)
    let started = 0
    const originalAppend = appendFileSync
    f.deps.appendFileSync = (path, data, options) => {
      if (String(data).includes('"kind":"started"')) {
        started += 1
        if (started === 2) throw new Error('started record failed')
      }
      return originalAppend(path, data, options)
    }
    const originalKill = f.deps.kill
    f.deps.kill = (pid, signal) => {
      kills.push([pid, signal])
      return originalKill(pid, signal)
    }
    f.d = daemon({ root: f.root, deps: f.deps })
    appendJournal(f, { review_outcome: { dispatch: 'd3', must_fix: 1, findings: [] } })
    const run = f.d.enqueue({ crew_dir: f.crewDir }).run_id
    writeFileSync(returnFor(f, run), JSON.stringify({
      status: 'escalation',
      details: {
        escalation: { where: 'review', why: 'started record fails after fork' },
        extra_rounds_granted: [{ where: 'review', round: 3 }],
        gate: { discrimination: 'proven' },
      },
    }))
    f.d.poll()
    assert.deepEqual(kills.filter(([, signal]) => signal !== 0), [])
    assert.equal(f.d.result({ run }).outcome, 'escalation')
    assert.equal(f.d.state({ run }).state, 'done')
  } finally { await f.d.stop(); f.cleanup() }
})

test('a rising must-fix sequence settles an escalation instead of regranting', async () => {
  await each(async (f) => {
    appendJournal(f, { review_outcome: { dispatch: 'd3', must_fix: 1, findings: [] } })
    appendJournal(f, { review_outcome: { dispatch: 'd5', must_fix: 2, findings: [] } })
    const run = f.d.enqueue({ crew_dir: f.crewDir }).run_id
    writeFileSync(returnFor(f, run), JSON.stringify({
      status: 'escalation',
      details: {
        escalation: { where: 'review', why: 'must-fix rose' },
        extra_rounds_granted: [{ where: 'review', round: 3 }],
        gate: { discrimination: 'proven' },
      },
    }))
    f.d.poll()
    const records = readFileSync(join(f.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(records.filter((record) => record.run_id === run && record.kind === 'regrant').length, 0)
    assert.equal(records.filter((record) => record.run_id === run && record.kind === 'settled').length, 1)
    assert.equal(f.forks.length, 1)
  })
})

test('a regrant dependency failure falls back to terminal settlement', async () => {
  const f = fixture()
  try {
    const originalWrite = writeFileSync
    f.deps.writeFileSync = (path, value, options) => {
      if (String(path).endsWith('/task/regrant-brief.md')) throw new Error('brief disk failure')
      return originalWrite(path, value, options)
    }
    f.d = daemon({ root: f.root, deps: f.deps })
    const run = f.d.enqueue({ crew_dir: f.crewDir }).run_id
    appendJournal(f, { review_outcome: { dispatch: 'd3', must_fix: 1, findings: [] } })
    writeFileSync(returnFor(f, run), JSON.stringify({
      status: 'escalation',
      details: {
        escalation: { where: 'review', why: 'brief write fails' },
        extra_rounds_granted: [{ where: 'review', round: 3 }],
        gate: { discrimination: 'proven' },
      },
    }))
    f.d.poll()
    const records = readFileSync(join(f.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(records.filter((record) => record.run_id === run && record.kind === 'regrant').length, 0)
    assert.equal(records.filter((record) => record.run_id === run && record.kind === 'settled').length, 1)
    assert.equal(f.d.state({ run }).state, 'done')
  } finally { await f.d.stop(); f.cleanup() }
})

test('restart folds a regrant into a queued continuation run', async () => {
  const f = fixture()
  let next
  try {
    appendJournal(f, { review_outcome: { dispatch: 'd3', must_fix: 1, findings: [] } })
    const run = f.d.enqueue({ crew_dir: f.crewDir }).run_id
    writeFileSync(returnFor(f, run), JSON.stringify({
      status: 'escalation',
      details: {
        escalation: { where: 'review', why: 'restart me' },
        extra_rounds_granted: [{ where: 'review', round: 3 }],
        gate: { discrimination: 'proven' },
      },
    }))
    f.d.poll()
    await f.d.stop()
    next = daemon({ root: f.root, deps: f.deps })
    await next.start()
    assert.notEqual(next.state({ run }).state, 'done')
    assert.equal(next.list().find((row) => row.run_id === run).state, 'working')
    assert.equal(f.forks.length, 2)
    const continuation = JSON.parse(f.forks[1][1][1])
    assert.equal(continuation.continuation, true)
    assert.equal(continuation.brief_file, join(f.taskDir, 'regrant-brief.md'))
    assert.equal(continuation.task_return, returnFor(f, run, 2))
    const regrant = readFileSync(join(f.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((record) => record.run_id === run && record.kind === 'regrant')
    assert.equal(regrant.attempt, 2)
  } finally {
    await next?.stop()
    await f.d.stop()
    f.cleanup()
  }
})

test('restart re-queues a run that never had a child', async () => {
  const f = fixture({ concurrency: 1 })
  const secondCrew = mintCrew(f, { name: 'crew-b', checkout: join(f.dir, 'checkout-b') })
  let next
  try {
    f.d.enqueue({ crew_dir: f.crewDir })
    const queued = f.d.enqueue({ crew_dir: secondCrew.crewDir }).run_id
    await f.d.start(); await f.d.stop()
    next = daemon({ root: f.root, concurrency: 1, deps: f.deps })
    await next.start(); next.poll()
    assert.equal(next.state({ run: queued }).state, 'queued')
    const records = readFileSync(join(f.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const kinds = records.filter((record) => record.run_id === queued).map((record) => record.kind)
    assert.equal(kinds.includes('requeued'), true)
    assert.equal(kinds.includes('orphaned'), false)
    assert.equal(kinds.includes('started'), false)
  } finally {
    await f.d.stop(); await next?.stop(); f.cleanup()
  }
})

test('invalid concurrency is refused at construction and the default is two', async () => {
  assert.throws(() => daemon({ concurrency: 0 }), Error)
  assert.throws(() => daemon({ concurrency: 1.5 }), Error)
  assert.equal(DEFAULT_CONCURRENCY, 2)
  await each(async (f) => {
    const secondCrew = mintCrew(f, { name: 'crew-b', checkout: join(f.dir, 'checkout-b') })
    const thirdCrew = mintCrew(f, { name: 'crew-c', checkout: join(f.dir, 'checkout-c') })
    f.d.enqueue({ crew_dir: f.crewDir })
    f.d.enqueue({ crew_dir: secondCrew.crewDir })
    f.d.enqueue({ crew_dir: thirdCrew.crewDir })
    assert.equal(f.forks.length, DEFAULT_CONCURRENCY)
  })
})

test('budget options validate at construction and admit under the ceiling', async () => {
  for (const bad of [0, -1, 1.5, '4000', null, new Date()]) {
    assert.throws(() => daemon({ budget: { max_tokens: bad } }), /budget(?:\.max_tokens)?/)
  }
  assert.throws(() => daemon({ budget: 42 }), /budget/)
  assert.throws(() => daemon({ budget: { max_tokens: 1, window_ms: 0 } }), /budget\.window_ms/)
  assert.throws(() => daemon({ budget: { max_tokens: 1, window_ms: Number.MAX_SAFE_INTEGER } }), /budget\.window_ms/)
  assert.throws(() => daemon({ budget: { max_tokens: 1, ledger_db: '' } }), /budget\.ledger_db/)
  assert.throws(() => daemon({ budget: 'lots' }), /budget/)
  assert.doesNotThrow(() => daemon({ budget: { max_tokens: 1 } }))
  assert.doesNotThrow(() => daemon({ budget: null }))
  assert.equal(DEFAULT_BUDGET_WINDOW_MS, 24 * 60 * 60 * 1000)
  let seen
  await each(async (f) => {
    f.d.enqueue({ crew_dir: f.crewDir })
    assert.equal(f.forks.length, 1, 'under-ceiling admission must still fork')
    assert.equal(typeof seen.dbPath, 'string')
    assert.match(seen.since, /Z$/)
    assert.equal(seen.nodeVersion, process.versions.node, 'an omitted nodeVersion must use the running runtime')
  }, {
    budget: { max_tokens: 100 },
    usageWindow: (args) => { seen = args; return { measured: true, total: 99, sessions: 1 } },
  })
})

test('budget exceeded refuses before boot, registration, queueing, and downgrade', () => {
  const f = fixture({ budget: { max_tokens: 4000000 }, usageWindow: () => ({ measured: true, total: 4812340, sessions: 7 }) })
  try {
    assert.throws(() => f.d.enqueue({ crew_dir: f.crewDir }), (err) => {
      assert.equal(err.code, 'budget-exceeded')
      assert.match(err.message, /4812340/)
      assert.match(err.message, /4000000/)
      assert.match(err.message, /since/)
      assert.match(err.message, /pane/i)
      assert.match(err.message, /not counted/i)
      return true
    })
    assert.equal(f.forks.length, 0)
    assert.equal(f.boots.length, 0)
    assert.equal(existsSync(join(f.root, 'runs.jsonl')), false)
    assert.deepEqual(f.d.list(), [])
    assert.throws(() => f.d.enqueue({ tier: 'build', task: 'tier-task', checkout: f.dir, brief_file: f.brief }), (err) => err.code === 'budget-exceeded')
    assert.equal(f.boots.length, 0, 'budget refusal must happen before crew boot')
  } finally { f.cleanup() }
})

test('an unmeasurable budget window refuses with its path and reason', () => {
  const ledgerPath = join(tmpdir(), `budget-unreadable-${process.pid}-${Date.now()}.db`)
  const f = fixture({ budget: { max_tokens: 10, ledger_db: ledgerPath }, usageWindow: () => ({ measured: false, total: null, sessions: 0, why: 'disk on fire' }) })
  try {
    assert.throws(() => f.d.enqueue({ crew_dir: f.crewDir }), (err) => {
      assert.equal(err.code, 'budget-unmeasurable')
      assert.match(err.message, /disk on fire/)
      assert.match(err.message, /ledger at/)
      return true
    })
  } finally { f.cleanup() }
})

test('an absent mirror beside a present ledger authority is unmeasured, an absent ledger dir is at the floor, and child specs carry budget state', async () => {
  const ledgerDir = scratchDir('daemon-missing-budget-')
  const ledgerPath = join(ledgerDir, 'ledger.db')
  const f = fixture({ budget: { max_tokens: 1, ledger_db: ledgerPath } })
  try {
    const usage = usageWindow({ dbPath: ledgerPath, since: '2026-01-01T00:00:00.000Z' })
    if (!LEDGER_SQLITE_OK) {
      assert.equal(usage.measured, false, 'an absent db cannot be called fresh when this runtime cannot read future rows')
      assert.equal(usage.total, null)
      assert.throws(() => f.d.enqueue({ crew_dir: f.crewDir }), (err) => err.code === 'budget-unmeasurable')
      assert.equal(f.forks.length, 0, 'an unmeasurable configured budget must not fork a JSONL-only child')
      return
    }
    // (a) an absent mirror with no authority beside it is a fresh ledger at the floor.
    assert.deepEqual(usage, { measured: true, total: 0, sessions: 0 })
    f.d.enqueue({ crew_dir: f.crewDir })
    assert.equal(f.forks.length, 1)
    const spec = JSON.parse(f.forks[0][1][1])
    assert.equal(typeof spec.ledger_db, 'string')
    assert.equal(spec.ledger_db, ledgerPath)
    assert.equal(spec.budget_enabled, true)

    // (b) the same absent mirror, now with the JSONL authority beside it. The spend
    // is on disk; a measured zero here is what one `rm` used to buy (#719).
    writeFileSync(join(ledgerDir, 'ledger.jsonl'), '{"kind":"agent_session"}\n')
    const deleted = usageWindow({ dbPath: ledgerPath, since: '2026-01-01T00:00:00.000Z' })
    assert.equal(deleted.measured, false, 'a deleted mirror beside a present authority hides spend, it does not prove there was none')
    assert.equal(deleted.total, null)
    assert.equal(deleted.sessions, 0)
    assert.match(deleted.why, /ledger\.jsonl/)
    assert.throws(() => f.d.enqueue({ crew_dir: f.crewDir, run_id: 'deleted-mirror' }), (err) => err.code === 'budget-unmeasurable')
    assert.equal(f.forks.length, 1, 'a run whose spend cannot be measured must not be forked')
  } finally { await f.d.stop(); f.cleanup() }
})

test('usageWindow fails closed below the emitter floor and keeps its at-floor fast path only when no ledger authority sits beside the mirror', () => {
  const dir = mkdtempSync(join(tmpdir(), 'daemon-budget-floor-'))
  const dbPath = join(dir, 'ledger.db')
  const since = '2026-01-02T00:00:00.000Z'
  try {
    assert.equal(LEDGER_NODE_FLOOR, '26.0.0')
    // The daemon's import firewall forbids importing the ledger, so the mirror is
    // a literal. Pin the equality here so a future half-move fails the suite
    // rather than only the lane's gate.
    assert.equal(LEDGER_NODE_FLOOR, NODE_FLOOR, 'crew/daemon.mjs LEDGER_NODE_FLOOR and scripts/factory/ledger.mjs NODE_FLOOR must move together')
    for (const nodeVersion of ['24.15.0', '22.13.0', 'not-a-version']) {
      const result = usageWindow({ dbPath, since, nodeVersion })
      assert.equal(result.measured, false, `node ${nodeVersion} must fail closed below the emitter floor`)
      assert.equal(result.total, null)
      assert.equal(result.sessions, 0)
      assert.match(result.why, /26\.0\.0/)
    }
    for (const nodeVersion of ['26.0.0', '26.5.1']) {
      const result = usageWindow({ dbPath, since, nodeVersion })
      if (sqliteAvailable()) {
        // The fast path survives, but only for what it can honestly claim: this dir
        // holds no ledger.jsonl, so there is no authority whose spend a zero hides.
        assert.deepEqual(result, { measured: true, total: 0, sessions: 0 })
      } else {
        assert.equal(result.measured, false, 'a simulated at-floor version cannot make this below-floor process require SQLite')
        assert.match(result.why, /node:sqlite/)
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a present but unreadable mirror is unmeasured and says so differently from a deleted mirror beside a ledger authority', () => {
  if (!LEDGER_SQLITE_OK) return
  const ledgerDir = scratchDir('daemon-mirror-cases-')
  const dbPath = join(ledgerDir, 'ledger.db')
  const since = '2026-01-01T00:00:00.000Z'
  writeFileSync(dbPath, 'not a sqlite database')
  const unreadable = usageWindow({ dbPath, since })
  assert.equal(unreadable.measured, false)
  assert.equal(unreadable.total, null)
  assert.equal(typeof unreadable.why, 'string')
  assert.notEqual(unreadable.why, '')
  rmSync(dbPath)
  writeFileSync(join(ledgerDir, 'ledger.jsonl'), '{"kind":"agent_session"}\n')
  const deleted = usageWindow({ dbPath, since })
  assert.equal(deleted.measured, false)
  assert.equal(deleted.total, null)
  assert.match(deleted.why, /ledger\.jsonl/)
  assert.notEqual(deleted.why, unreadable.why)
})

test('the ledger floor gates a configured budget but not a no-budget daemon', () => {
  const ledgerPath = join(tmpdir(), `floor-budget-${process.pid}-${Date.now()}.db`)
  const budgeted = fixture({ budget: { max_tokens: 1, ledger_db: ledgerPath }, nodeVersion: '22.13.0' })
  const free = fixture({ nodeVersion: '22.13.0' })
  try {
    assert.throws(() => budgeted.d.enqueue({ crew_dir: budgeted.crewDir }), (err) => {
      assert.equal(err.code, 'budget-unmeasurable')
      assert.match(err.message, /26\.0\.0/)
      return true
    })
    assert.equal(budgeted.forks.length, 0)
    assert.equal(existsSync(join(budgeted.root, 'runs.jsonl')), false)
    free.d.enqueue({ crew_dir: free.crewDir })
    assert.equal(free.forks.length, 1, 'the ledger floor must gate only configured budgets')
  } finally {
    budgeted.cleanup()
    free.cleanup()
  }
})

test('usageWindow sums in-window running totals and fails closed below the ledger floor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'daemon-budget-reader-'))
  const dbPath = join(dir, 'ledger.db')
  const since = '2026-01-02T00:00:00.000Z'
  try {
    if (!LEDGER_SQLITE_OK) {
      // The ledger intentionally leaves no SQLite mirror below NODE_FLOOR.
      // A ledger file that does exist is unmeasurable, never a fabricated zero.
      writeFileSync(dbPath, 'not a sqlite database')
      const result = usageWindow({ dbPath, since })
      assert.equal(result.measured, false, 'below-floor readers must fail closed for an existing ledger')
      assert.equal(result.total, null)
      assert.equal(result.sessions, 0)
      assert.equal(typeof result.why, 'string')
    } else {
      const ledger = openLedger({ dbPath, now: () => Date.parse('2026-01-02T00:00:02.000Z') })
      const add = (adwId, sessionId, startedAt, values) => {
        ledger.startAgentSession({
          adw_id: adwId, dispatch_id: `dispatch-${sessionId}`, role: 'builder', model: 'x',
          claude_session_id: sessionId, transcript_path: null, started_at: startedAt,
        })
        ledger.endAgentSession({
          adw_id: adwId, claude_session_id: sessionId,
          context_tokens: null, context_window: null, raw_read_tokens: null, raw_written_tokens: null,
          billed_input_tokens: values[0], billed_output_tokens: values[1],
          billed_cache_write_tokens: values[2], billed_cache_read_tokens: values[3],
        })
      }
      try {
        add('adw-a', 'session-boundary', since, [10, 20, 30, 40])
        add('adw-a', 'session-inside', '2026-01-02T00:00:01.000Z', [1, 2, 3, 4])
        add('adw-outside', 'session-outside', '2026-01-01T23:59:59.999Z', [100, 100, 100, 100])
      } finally { ledger.close() }
      assert.deepEqual(usageWindow({ dbPath, since }), { measured: true, total: 110, sessions: 2 })
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a budget window is recomputed from disk across fresh daemon construction', async () => {
  const f = fixture({ budget: { max_tokens: 10 }, usageWindow: () => ({ measured: true, total: 10, sessions: 1 }), now: () => 1000 })
  try {
    const first = (() => { try { f.d.enqueue({ crew_dir: f.crewDir }); return null } catch (err) { return err } })()
    assert.equal(first?.code, 'budget-exceeded')
    await f.d.stop()
    const fresh = daemon({ root: f.root, budget: { max_tokens: 10 }, deps: f.deps })
    const second = (() => { try { fresh.enqueue({ crew_dir: f.crewDir }); return null } catch (err) { return err } })()
    assert.equal(second?.code, 'budget-exceeded')
    assert.equal(second.message, first.message)
    await fresh.stop()
    const entries = existsSync(f.root) ? readdirSync(f.root) : []
    assert.equal(entries.some((name) => /budget|counter|usage/i.test(name)), false)
  } finally { await f.d.stop(); f.cleanup() }
})

test('send refuses a queued run', async () => {
  await each(async (f) => {
    const secondCrew = mintCrew(f, { name: 'crew-b', checkout: join(f.dir, 'checkout-b') })
    f.d.enqueue({ crew_dir: f.crewDir })
    const queued = f.d.enqueue({ crew_dir: secondCrew.crewDir }).run_id
    await assert.rejects(() => f.d.send({ run: queued, message: 'guidance' }), (err) => {
      assert.equal(err.code, 'not-live')
      assert.match(err.message, /queued/)
      return true
    })
  }, { concurrency: 1 })
})

// 9. The projection vocabulary is table-driven and drops unknown rows.
test('normalizeEvent maps the closed event table', () => {
  assert.deepEqual(EVENT_KINDS, ['started', 'tool-call', 'blocked', 'terminal-result', 'died', 'usage'])
  assert.deepEqual(normalizeEvent('daemon', { event: 'fork', run_id: 'r', pid: 1 }), { kind: 'started', scope: 'run', run_id: 'r', pid: 1 })
  assert.deepEqual(normalizeEvent('journal', { event: 'headless-spawn', role: 'builder', id: 'd1', pid: 2 }), { kind: 'started', scope: 'worker', role: 'builder', worker_id: 'd1', pid: 2 })
  assert.deepEqual(normalizeEvent('journal', { no_lead_escalation: 'mechanical' }), { kind: 'blocked', why: 'mechanical' })
  assert.deepEqual(normalizeEvent('journal', { headless_outcome: 'ok', role: 'builder', exit_code: 0, terminal_reason: 'done' }), { kind: 'terminal-result', role: 'builder', outcome: 'ok', exit_code: 0, terminal_reason: 'done' })
  assert.deepEqual(normalizeEvent('stream', { type: 'assistant', role: 'builder', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }), { kind: 'tool-call', role: 'builder', tool: 'Bash' })
  assert.deepEqual(normalizeEvent('stream', { type: 'usage', role: 'builder', usage: { input_tokens: 2, output_tokens: 3 } }), { kind: 'usage', role: 'builder', input_tokens: 2, output_tokens: 3 })
  assert.deepEqual(normalizeEvent('stream', { type: 'result', role: 'builder', terminal_reason: 'done' }), { kind: 'terminal-result', role: 'builder', terminal_reason: 'done' })
  assert.equal(normalizeEvent('journal', { irrelevant: true }), null)
})

// 10. Files, not the child IPC, drive the live feed and envelope outcome.
test('enqueue forks once and projects journal, stream, and envelope evidence', async () => {
  await each(async (f) => {
    await f.d.start()
    const { run_id: run } = await f.d.enqueue({ crew_dir: f.crewDir, task: 'daemon80', brief_file: join(f.dir, 'brief.md'), checkout: f.dir })
    f.d.poll()
    appendJournal(f, { event: 'headless-spawn', role: 'builder', id: 'd1', pid: 901, dir: join(f.taskDir, 'headless', 'd1') })
    mkdirSync(join(f.taskDir, 'headless', 'd1'), { recursive: true })
    writeFileSync(join(f.taskDir, 'headless', 'd1', 'stream.jsonl'), `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } })}\n${JSON.stringify({ type: 'usage', usage: { input_tokens: 1, output_tokens: 2 } })}\n`)
    f.d.poll()
    assert.equal(f.forks.length, 1)
    assert.ok(f.d.feed(run, 0).some((event) => event.kind === 'started'))
    assert.ok(f.d.feed(run, 0).some((event) => event.kind === 'tool-call'))
    assert.ok(f.d.feed(run, 0).some((event) => event.kind === 'usage'))
    const envelope = { status: 'done', summary: 'ok' }
    writeFileSync(returnFor(f, run), JSON.stringify(envelope)); f.d.poll()
    assert.equal(f.d.state({ run }).state, 'done')
    assert.equal(f.d.result({ run }).outcome, 'done')
  })
})

// Worker state is terminal only after both stream and exit evidence arrive.
test('worker state stays working until terminal result and exit marker', async () => {
  await each(async (f) => {
    await f.d.start(); const { run_id: run } = await f.d.enqueue({ crew_dir: f.crewDir });
    const dir = join(f.taskDir, 'headless', 'd1'); mkdirSync(dir, { recursive: true })
    appendJournal(f, { event: 'headless-spawn', role: 'builder', id: 'd1', pid: 901, dir })
    writeFileSync(join(dir, 'stream.jsonl'), `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } })}\n`)
    f.d.poll(); assert.equal(f.d.state({ run, worker: 'd1' }).state, 'working')
    writeFileSync(join(dir, 'stream.jsonl'), `${JSON.stringify({ type: 'result', terminal_reason: 'done' })}\n`, { flag: 'a' })
    f.d.poll(); assert.equal(f.d.state({ run, worker: 'd1' }).state, 'working', 'terminal without exit is still working')
    writeFileSync(join(dir, 'exit'), '0')
    f.d.poll(); assert.equal(f.d.state({ run, worker: 'd1' }).state, 'done')
  })
})

// 11. A settled escalation is still state=done, not success.
test('idle is not success: an ineligible escalation envelope still yields done only', async () => {
  await each(async (f) => {
    await f.d.start(); const { run_id: run } = await f.d.enqueue({ crew_dir: f.crewDir }); f.d.poll()
    writeFileSync(returnFor(f, run), JSON.stringify({
      status: 'escalation',
      details: {
        escalation: { where: 'plan', why: 'plan exhaustion is not regrantable' },
        extra_rounds_granted: [{ where: 'review', round: 3 }],
        gate: { discrimination: 'proven' },
      },
    })); f.d.poll()
    const answer = f.d.state({ run })
    assert.equal(answer.state, 'done'); assert.deepEqual(Object.keys(answer), ['state'])
    assert.equal(f.d.result({ run }).outcome, 'escalation')
  })
})

// 12. Subscribers are disposable views over the in-memory projection.
test('subscriber disconnect does not mutate registry and tail replays', async () => {
  await each(async (f) => {
    await f.d.start(); const { run_id: run } = await f.d.enqueue({ crew_dir: f.crewDir }); f.d.poll()
    const registry = join(f.root, 'runs.jsonl'); const before = readFileSync(registry, 'utf8')
    const socket = net.connect(f.d.socketPath); await new Promise((resolve) => socket.on('connect', resolve))
    socket.write(`${JSON.stringify({ id: 'tail-a', cmd: 'tail', params: { run, since: 0 } })}\n`)
    await waitFor(() => f.d.subscribers().length === 1, 'the tail-a subscription'); socket.destroy(); await waitFor(() => f.d.subscribers().length === 0, 'the daemon to drop the disconnected subscriber')
    f.d.poll(); assert.equal(readFileSync(registry, 'utf8'), before); assert.equal(f.d.state({ run }).state, 'working')
    const feed = f.d.feed(run, 0); assert.ok(feed.length >= 1)
    const frames = await request(f.d.socketPath, `${JSON.stringify({ id: 'tail-b', cmd: 'tail', params: { run, since: 0 } })}\n`, feed.length)
    const replay = frames.map(jsonFrame).filter((frame) => frame.event).map((frame) => frame.event.kind)
    assert.deepEqual(replay, feed.map((event) => event.kind))
  })
})

// 13. Adoption tails an existing run and never forks.
test('restart adopts a live child without forking', async () => {
  const f = fixture()
  try {
    await f.d.start(); const { run_id: run } = await f.d.enqueue({ crew_dir: f.crewDir }); f.d.poll(); await f.d.stop()
    const count = f.forks.length; const next = daemon({ root: f.root, deps: f.deps }); await next.start(); next.poll()
    assert.equal(f.forks.length, count); assert.equal(next.state({ run }).state, 'working'); assert.match(readFileSync(join(f.root, 'runs.jsonl'), 'utf8'), /"adopted"/)
    await next.stop()
  } finally { f.cleanup() }
})

// 14. A dead child with no envelope is settled by the daemon.
test('restart settles an escalation for a dead child with no envelope', async () => {
  const f = fixture()
  try {
    await f.d.start(); const { run_id: run } = await f.d.enqueue({ crew_dir: f.crewDir }); await f.d.stop(); f.alive.delete(900)
    const next = daemon({ root: f.root, deps: f.deps }); await next.start(); next.poll()
    assert.equal(next.state({ run }).state, 'done')
    assert.equal(next.result({ run }).outcome, 'escalation')
    assert.equal(next.result({ run }).envelope.details.escalation.why, 'orphaned-on-restart')
    assert.equal(next.result({ run }).envelope.details.escalation.where, 'signalled')
    assert.match(readFileSync(join(f.root, 'runs.jsonl'), 'utf8'), /"orphaned"/)
    await next.stop()
  } finally { f.cleanup() }
})

test('restart settles an escalation for a run with no recorded child pid', async () => {
  const f = fixture()
  let next = null
  const run = 'no-pid-restart'
  try {
    mkdirSync(f.root, { recursive: true })
    writeFileSync(join(f.root, 'runs.jsonl'), [
      JSON.stringify({ kind: 'enqueued', run_id: run, crew_dir: f.crewDir, task: 'daemon80', task_return: returnFor(f, run) }),
      JSON.stringify({ kind: 'started', run_id: run, child_pid: null }),
    ].join('\n') + '\n')
    next = daemon({ root: f.root, deps: f.deps })
    await next.start()
    const envelope = JSON.parse(readFileSync(returnFor(f, run), 'utf8'))
    assert.equal(envelope.details.escalation.why, 'orphaned-on-restart')
    assert.equal(envelope.details.escalation.where, 'signalled')
  } finally { await next?.stop(); f.cleanup() }
})

// 15. The durable envelope wins even when the driver pid is gone.
test('restart settles a dead child from its envelope', async () => {
  const f = fixture()
  try {
    await f.d.start(); const { run_id: run } = await f.d.enqueue({ crew_dir: f.crewDir }); await f.d.stop(); f.alive.delete(900)
    const envelope = { status: 'done', summary: 'survived' }; writeFileSync(returnFor(f, run), JSON.stringify(envelope))
    const next = daemon({ root: f.root, deps: f.deps }); await next.start(); next.poll()
    assert.equal(next.state({ run }).state, 'done'); assert.equal(next.result({ run }).outcome, 'done'); await next.stop()
  } finally { f.cleanup() }
})

test('a torn envelope on a dead child is unmeasured, not absent', async () => {
  const f = fixture()
  try {
    await f.d.start()
    const { run_id: run } = await f.d.enqueue({ crew_dir: f.crewDir })
    const envelope = JSON.stringify({ status: 'done', summary: 'torn', details: { commit: 'abc1234' } }, null, 2)
    writeTornFile({ file: returnFor(f, run), completeText: envelope })
    f.alive.delete(900)
    f.d.poll()
    const records = readFileSync(join(f.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
    assert.equal(records.some((record) => record.kind === 'orphaned'), false)
  } finally { await f.d.stop(); f.cleanup() }
})

test('the completed envelope settles the run with its own outcome', async () => {
  const f = fixture()
  try {
    await f.d.start()
    const { run_id: run } = await f.d.enqueue({ crew_dir: f.crewDir })
    const envelope = JSON.stringify({ status: 'done', summary: 'complete', details: { commit: 'abc1234' } }, null, 2)
    const torn = writeTornFile({ file: returnFor(f, run), completeText: envelope })
    f.alive.delete(900)
    f.d.poll()
    torn.complete()
    f.d.poll()
    const records = readFileSync(join(f.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
    const settled = records.find((record) => record.kind === 'settled')
    assert.ok(settled)
    assert.equal(settled.outcome_status, 'done')
    assert.equal(f.d.result({ run }).envelope.details.commit, 'abc1234')
  } finally { await f.d.stop(); f.cleanup() }
})

test('an absent envelope on a dead child still orphans', async () => {
  const f = fixture()
  try {
    await f.d.start()
    const { run_id: run } = await f.d.enqueue({ crew_dir: f.crewDir })
    f.alive.delete(900)
    f.d.poll()
    const records = readFileSync(join(f.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
    const orphaned = records.find((record) => record.kind === 'orphaned')
    assert.ok(orphaned)
    assert.equal(orphaned.reason, 'child-dead')
    assert.equal(f.d.result({ run }).envelope.details.escalation.why, 'child-dead')
  } finally { await f.d.stop(); f.cleanup() }
})

test('a restart does not resurrect the wrong verdict', async () => {
  const f = fixture()
  let next = null
  try {
    await f.d.start()
    const { run_id: run } = await f.d.enqueue({ crew_dir: f.crewDir })
    const envelope = JSON.stringify({ status: 'done', summary: 'restart', details: { commit: 'restart-123' } }, null, 2)
    const torn = writeTornFile({ file: returnFor(f, run), completeText: envelope })
    f.alive.delete(900)
    f.d.poll()
    await f.d.stop()
    next = daemon({ root: f.root, deps: f.deps })
    await next.start()
    torn.complete()
    next.poll()
    const records = readFileSync(join(f.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
    assert.equal(records.some((record) => record.kind === 'orphaned'), false)
    assert.equal(records.some((record) => record.kind === 'settled'), true)
    assert.equal(next.result({ run }).envelope.details.commit, 'restart-123')
  } finally { await f.d.stop(); await next?.stop(); f.cleanup() }
})

test('the unmeasured retry is bounded', async () => {
  const f = fixture()
  try {
    await f.d.start()
    const { run_id: run } = await f.d.enqueue({ crew_dir: f.crewDir })
    const envelope = JSON.stringify({ status: 'done', summary: 'never complete', details: {} }, null, 2)
    const torn = writeTornFile({ file: returnFor(f, run), completeText: envelope })
    const bytes = readFileSync(returnFor(f, run), 'utf8')
    f.alive.delete(900)
    for (let i = 0; i < 8; i += 1) f.d.poll()
    const records = readFileSync(join(f.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
    const orphaned = records.find((record) => record.kind === 'orphaned')
    assert.ok(orphaned)
    assert.equal(orphaned.reason, 'envelope-unreadable')
    assert.equal(readFileSync(returnFor(f, run), 'utf8'), bytes)
    assert.equal(typeof torn.tornBytes, 'number')
  } finally { await f.d.stop(); f.cleanup() }
})

test('the child publishes the envelope by rename', () => {
  const f = fixture()
  try {
    const own = join(f.returnsDir, 'rename.task.json')
    const writes = []
    const renames = []
    runChild({ crew_dir: f.crewDir, task_return: own, task: 'x' }, {
      driveTask: () => ({ status: 'done', summary: 'rename' }), seatIo: () => ({}), preflight: false,
      writeFileSync: (path, value, options) => { writes.push(String(path)); return writeFileSync(path, value, options) },
      renameSync: (from, to) => { renames.push(String(to)); return renameSync(from, to) },
    })
    assert.equal(writes.filter((path) => path === own).length, 0)
    assert.equal(writes.filter((path) => path === f.taskReturn).length, 0)
    assert.equal(renames.filter((path) => path === own).length, 1)
    assert.equal(renames.filter((path) => path === f.taskReturn).length, 1)
  } finally { f.cleanup() }
})

// 16. A crew directory is a single active session key.
test('enqueue twice for one crew is run-active and forks once', async () => {
  await each(async (f) => {
    await f.d.start(); await f.d.enqueue({ crew_dir: f.crewDir })
    assert.throws(() => f.d.enqueue({ crew_dir: f.crewDir }), (err) => err.code === 'run-active')
    assert.equal(f.forks.length, 1)
  })
})

test('enqueue refuses a pane crew before registering a run or forking', () => {
  const f = fixture({ roles: ['builder'], transport: 'pane' })
  try {
    assert.throws(() => f.d.enqueue({ crew_dir: f.crewDir }), /pane transport for seat builder/)
    assert.equal(f.forks.length, 0)
    assert.deepEqual(f.d.list(), [])
    assert.equal(existsSync(join(f.root, 'runs.jsonl')), false)
  } finally { f.cleanup() }
})

test('the enqueue refusal carries the daemon invalid-spec code over the socket', async () => {
  const f = fixture({ roles: ['builder'], transport: 'pane' })
  try {
    await f.d.start()
    const frames = await request(f.d.socketPath, `${JSON.stringify({ id: 'pane', cmd: 'enqueue', params: { crew_dir: f.crewDir } })}\n`)
    const frame = jsonFrame(frames[0])
    assert.equal(frame.ok, false)
    assert.equal(frame.error.code, 'invalid-spec')
  } finally { await f.d.stop(); f.cleanup() }
})

// 17/18. The runner has no pane fallback and removes lead from ctx roles.
test('runChild refuses pane seats and omits lead from the mechanical ctx', () => {
  const pane = fixture({ roles: ['builder'], transport: 'pane' })
  try {
    assert.throws(() => runChild({ crew_dir: pane.crewDir, task: 'x' }, { driveTask: () => ({ status: 'done' }), seatIo: () => ({}) }), /pane.*builder/)
  } finally { pane.cleanup() }
  const lead = fixture({ roles: ['lead', 'planner', 'builder', 'reviewer'] })
  try {
    let seen
    runChild({ crew_dir: lead.crewDir, task: 'x' }, { driveTask: (ctx) => { seen = ctx; return { status: 'done' } }, seatIo: () => ({}), preflight: false })
    assert.ok(seen); assert.equal(seen.roles.includes('lead'), false)
  } finally { lead.cleanup() }
})

test('runChild copies a declared scope and refuses an inherited spec without one', () => {
  const f = fixture()
  try {
    let seen
    runChild({ crew_dir: f.crewDir, task: 'x', variant: 'repair', files_in_scope: ['a.mjs'], lane: 'lane-cmd' }, {
      driveTask: (ctx) => { seen = ctx; return { status: 'done' } }, seatIo: () => ({}), preflight: false,
    })
    assert.deepEqual(seen.files_in_scope, ['a.mjs'])
    assert.throws(
      () => runChild({ crew_dir: f.crewDir, task: 'x', variant: 'repair', lane: 'lane-cmd' }, {
        driveTask: () => ({ status: 'done' }), seatIo: () => ({}), preflight: false,
      }),
      /files_in_scope/,
    )
  } finally { f.cleanup() }
})

test('runChild threads continuation and the unfiltered seated role list into ctx', () => {
  const f = fixture({ roles: ['lead', 'planner', 'builder', 'reviewer'] })
  try {
    const seen = []
    const driveTask = (ctx) => { seen.push(ctx); return { status: 'done' } }
    runChild({ crew_dir: f.crewDir, task: 'x', continuation: true }, { driveTask, seatIo: () => ({}), preflight: false })
    runChild({ crew_dir: f.crewDir, task: 'x' }, { driveTask, seatIo: () => ({}), preflight: false })
    assert.equal(seen[0].continuation, true)
    assert.equal(seen[1].continuation, false)
    assert.deepEqual(seen[0].seatedRoles, ['lead', 'planner', 'builder', 'reviewer'])
    assert.equal(seen[0].roles.includes('lead'), false)
  } finally { f.cleanup() }
})

test('the child entry resolves the repo protected paths and records them', () => {
  const f = fixture()
  const home = mkdtempSync(join(tmpdir(), 'daemon-protected-home-'))
  const factoryRoot = join(home, 'factory')
  const cell = {
    status: 'ratified', value: ['db/migrations/'], source: 'human',
    ratified_by: 'human', ratified_at: '2026-08-16T00:00:00.000Z',
  }
  protectedProfile(factoryRoot, f.dir, cell)
  const previousFactory = process.env.DEVTEAM_FACTORY_DIR
  process.env.DEVTEAM_FACTORY_DIR = factoryRoot
  const logged = []
  let seen
  try {
    runChild({ crew_dir: f.crewDir, task: 'protected-child', checkout: f.dir, ledger_db: join(home, 'ledger.db') }, {
      driveTask: (ctx) => { seen = ctx; return { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } } },
      seatIo: () => ({ log: (row) => logged.push(row) }),
      preflight: false,
    })
    assert.ok(seen.protectedPaths.includes('db/migrations/'))
    for (const path of PROTECTED_PATHS) assert.ok(seen.protectedPaths.includes(path), `${path} missing from ctx`)
    const row = logged.find((entry) => entry.event === 'protected-paths')
    assert.ok(row)
    assert.match(row.basis, /protected_paths_candidates/)
    assert.equal(row.count, seen.protectedPaths.length)
  } finally {
    if (previousFactory === undefined) delete process.env.DEVTEAM_FACTORY_DIR
    else process.env.DEVTEAM_FACTORY_DIR = previousFactory
    rmSync(home, { recursive: true, force: true })
    f.cleanup()
  }
})

test('the child entry escalates by name on an unusable ratified cell', { timeout: 20_000 }, () => {
  const f = fixture()
  const home = mkdtempSync(join(tmpdir(), 'daemon-protected-refusal-home-'))
  const factoryRoot = join(home, 'factory')
  protectedProfile(factoryRoot, f.dir, { status: 'ratified', value: ['db/migrations/'], source: 'human' })
  const previousFactory = process.env.DEVTEAM_FACTORY_DIR
  process.env.DEVTEAM_FACTORY_DIR = factoryRoot
  try {
    const result = runChild({ crew_dir: f.crewDir, task: 'protected-child-refusal', checkout: f.dir, ledger_db: join(home, 'ledger.db') }, { preflight: false })
    assert.equal(result.status, 'escalation')
    assert.equal(result.details.stages, null)
    assert.match(result.details.escalation.why, /protected-paths-invalid/)
    assert.match(readFileSync(f.taskReturn, 'utf8'), /protected-paths-invalid/)
  } finally {
    if (previousFactory === undefined) delete process.env.DEVTEAM_FACTORY_DIR
    else process.env.DEVTEAM_FACTORY_DIR = previousFactory
    rmSync(home, { recursive: true, force: true })
    f.cleanup()
  }
})

const withFence = (f, fence, laneName) => {
  const path = join(f.crewDir, 'crew.json')
  const base = JSON.parse(readFileSync(path, 'utf8'))
  writeFileSync(path, JSON.stringify({ ...base, lane_name: laneName, lane_fence: fence }))
}

function childFenceIo({ taskDir, planFiles, includeBuilder = false, includeReviewer = false, changed = [] }) {
  const envelopes = {
    'planner:1': {
      status: 'done', role: 'planner', summary: 'planned', artifacts: [`${taskDir}/plan.md`],
      details: {
        plan_path: `${taskDir}/plan.md`, files_in_scope: planFiles, validation_lane: 'lane-cmd',
        consult_questions: [], carve_verdict: 'proceed',
      },
    },
  }
  if (includeBuilder) {
    envelopes['builder:1'] = {
      status: 'done', role: 'builder', summary: 'built',
      details: { files_changed: planFiles, commit_message: 'feat: persisted fence child' },
    }
  }
  if (includeReviewer) {
    envelopes['reviewer:1'] = {
      status: 'done', role: 'reviewer', summary: 'reviewed',
      details: { verdict: 'pass', review_path: `${taskDir}/review.md`, must_fix: 0 },
    }
  }
  const calls = { assign: [], run: [], commits: [], writes: {} }
  const counts = {}
  const changedQueue = Array.isArray(changed[0]) ? [...changed] : [changed]
  return {
    calls,
    assign({ role }) {
      counts[role] = (counts[role] || 0) + 1
      const n = counts[role]
      calls.assign.push({ role, n })
      return { id: `${role}:${n}`, returnPath: `${role}:${n}` }
    },
    wait(returnPath) { return envelopes[returnPath] ?? null },
    writeFile(path, content) { calls.writes[path] = content },
    readFile() { return null },
    run(cmd) { calls.run.push(cmd); return { ok: true, output: '' } },
    changedFiles() { return changedQueue.length > 1 ? changedQueue.shift() : changedQueue[0] },
    commit(files, message) { calls.commits.push({ files, message }); return 'abc1234' },
    log() {},
    now: () => 0,
  }
}

test('the child entry rides the persisted lane fence into ctx and refuses at plan acceptance', () => {
  const f = fixture()
  const fence = [{ lane: 'intake-loop', files: ['scripts/factory/intake.mjs'] }]
  const logged = []
  let seen
  try {
    withFence(f, fence, 'fence-slice2')
    runChild({ crew_dir: f.crewDir, task: 'fence-plan', checkout: f.dir }, {
      driveTask: (ctx) => {
        seen = ctx
        return { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
      },
      seatIo: () => ({ log: (row) => logged.push(row) }),
      preflight: false,
    })
    assert.deepEqual(seen.laneFence, fence)
    assert.equal(seen.laneName, 'fence-slice2')
    assert.equal(seen.lane, null)
    const row = logged.find((entry) => entry.event === 'lane-fence')
    assert.ok(row)
    assert.equal(row.lane_name, 'fence-slice2')
    assert.equal(row.lanes, 1)
    assert.equal(row.files, 1)

    const io = childFenceIo({ taskDir: seen.taskDir, planFiles: ['scripts/factory/intake.mjs'] })
    const result = driveTask(seen, io)
    assert.equal(result.status, 'escalation')
    assert.equal(result.details.escalation.where, 'scope')
    assert.match(result.details.escalation.why, /intake-loop/)
    assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 0)
  } finally { f.cleanup() }
})

test("the child entry's persisted lane fence is caught again at the final scope-gate", () => {
  const f = fixture()
  const fence = [{ lane: 'intake-loop', files: ['scripts/factory/intake.mjs'] }]
  let seen
  try {
    withFence(f, fence, 'fence-slice2')
    runChild({ crew_dir: f.crewDir, task: 'fence-scope', checkout: f.dir }, {
      driveTask: (ctx) => {
        seen = ctx
        return { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
      },
      seatIo: () => ({ log() {} }),
      preflight: false,
    })
    const io = childFenceIo({
      taskDir: seen.taskDir,
      planFiles: ['a.mjs', 'a.test.mjs'],
      includeBuilder: true,
      changed: ['scripts/factory/intake.mjs'],
    })
    const result = driveTask(seen, io)
    assert.equal(result.status, 'escalation')
    assert.equal(result.details.escalation.where, 'scope')
    assert.match(result.details.escalation.why, /intake-loop/)
    assert.equal(io.calls.commits.length, 0)
  } finally { f.cleanup() }
})

test('a crew.json with no lane_fence leaves the child entry ctx exactly as today', () => {
  const f = fixture()
  const logged = []
  let seen
  try {
    runChild({ crew_dir: f.crewDir, task: 'unfenced-child', checkout: f.dir }, {
      driveTask: (ctx) => {
        seen = ctx
        return { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
      },
      seatIo: () => ({ log: (row) => logged.push(row) }),
      preflight: false,
    })
    assert.equal(Object.prototype.hasOwnProperty.call(seen, 'laneFence'), false)
    assert.equal(seen.laneName, undefined)
    assert.equal(logged.some((entry) => entry.event === 'lane-fence'), false)

    const io = childFenceIo({
      taskDir: seen.taskDir,
      planFiles: ['a.mjs', 'a.test.mjs'],
      includeBuilder: true,
      includeReviewer: true,
      changed: ['a.mjs', 'a.test.mjs'],
    })
    const result = driveTask(seen, io)
    assert.equal(result.status, 'done')
    assert.equal(io.calls.commits.length, 1)
  } finally { f.cleanup() }
})

// ChildProcess errors are asynchronous and must remain inside the daemon.
test('asynchronous child spawn errors orphan only their run', async () => {
  await each(async (f) => {
    let onError
    f.deps.fork = () => ({ pid: 901, on(event, fn) { if (event === 'error') onError = fn }, unref() {} })
    f.d = daemon({ root: f.root, deps: f.deps })
    await f.d.start(); const { run_id: run } = f.d.enqueue({ crew_dir: f.crewDir });
    assert.equal(typeof onError, 'function'); onError(Error('EAGAIN'))
    assert.equal(f.d.state({ run }).state, 'done')
    assert.equal(f.d.result({ run }).envelope.details.escalation.why.startsWith('child-spawn-error'), true)
    assert.equal(f.d.result({ run }).envelope.details.escalation.where, 'spawn-error')
    assert.match(readFileSync(join(f.root, 'runs.jsonl'), 'utf8'), /"orphaned"/)
  })
})

test('spawn errors send the died event before the terminal feed frame', async () => {
  const f = fixture()
  let onError
  try {
    f.deps.fork = () => ({ pid: 901, on(event, fn) { if (event === 'error') onError = fn; return this }, unref() {} })
    f.d = daemon({ root: f.root, deps: f.deps })
    await f.d.start()
    f.alive.add(901)
    const { run_id: run } = f.d.enqueue({ crew_dir: f.crewDir })
    const socket = net.connect(f.d.socketPath)
    const frames = []
    let rest = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      const split = splitFrames(Buffer.concat([rest, chunk])); rest = split.rest
      frames.push(...split.lines.map(jsonFrame))
    })
    await new Promise((resolve) => socket.on('connect', resolve))
    socket.write(`${JSON.stringify({ id: 'spawn-end', cmd: 'tail', params: { run, since: 0 } })}\n`)
    await waitFor(() => f.d.subscribers().some((s) => s.id === 'spawn-end'), 'the spawn-end subscription')
    assert.equal(typeof onError, 'function')
    onError(Error('EAGAIN'))
    await waitFor(() => frames.some((frame) => frame.end), 'the terminal feed frame')
    const observations = frames.filter((frame) => frame.event || frame.end)
    assert.equal(observations.at(-1)?.end?.reason, 'orphaned')
    assert.ok(observations.findIndex((frame) => frame.event?.kind === 'died') >= 0)
    assert.ok(observations.findIndex((frame) => frame.event?.kind === 'died') < observations.findIndex((frame) => frame.end))
    socket.destroy()
  } finally { await f.d.stop(); f.cleanup() }
})

test('a child exit without an envelope ends the live feed after died', async () => {
  const f = fixture()
  let onExit
  try {
    f.deps.fork = () => ({ pid: 901, on(event, fn) { if (event === 'exit') onExit = fn; return this }, unref() {} })
    f.d = daemon({ root: f.root, deps: f.deps })
    await f.d.start()
    f.alive.add(901)
    const { run_id: run } = f.d.enqueue({ crew_dir: f.crewDir })
    const socket = net.connect(f.d.socketPath)
    const frames = []
    let rest = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      const split = splitFrames(Buffer.concat([rest, chunk])); rest = split.rest
      frames.push(...split.lines.map(jsonFrame))
    })
    await new Promise((resolve) => socket.on('connect', resolve))
    socket.write(`${JSON.stringify({ id: 'exit-end', cmd: 'tail', params: { run, since: 0 } })}\n`)
    await waitFor(() => f.d.subscribers().some((s) => s.id === 'exit-end'), 'the exit-end subscription')
    assert.equal(typeof onExit, 'function')
    onExit(1, null)
    await waitFor(() => frames.some((frame) => frame.end), 'the terminal feed frame')
    const observations = frames.filter((frame) => frame.event || frame.end)
    assert.equal(observations.at(-1)?.end?.reason, 'orphaned')
    const died = observations.findIndex((frame) => frame.event?.kind === 'died')
    assert.ok(died >= 0)
    assert.ok(died < observations.findIndex((frame) => frame.end))
    assert.equal(f.d.state({ run }).state, 'done')
    assert.equal(f.d.result({ run }).envelope.details.escalation.why, 'child-exit:1')
    socket.destroy()
  } finally { await f.d.stop(); f.cleanup() }
})

test('a signalled child writes a SIGTERM escalation envelope', async () => {
  await each(async (f) => {
    let onExit
    f.deps.fork = () => ({ pid: 901, on(event, fn) { if (event === 'exit') onExit = fn; return this }, unref() {} })
    f.d = daemon({ root: f.root, deps: f.deps })
    await f.d.start()
    const { run_id: run } = f.d.enqueue({ crew_dir: f.crewDir })
    assert.equal(typeof onExit, 'function')
    onExit(null, 'SIGTERM')
    const envelope = JSON.parse(readFileSync(returnFor(f, run), 'utf8'))
    assert.equal(envelope.status, 'escalation')
    assert.equal(envelope.details.escalation.where, 'signalled')
    assert.equal(envelope.details.escalation.why, 'child-exit:SIGTERM')
  })
})

test('a signalled child writes a SIGKILL escalation envelope', async () => {
  await each(async (f) => {
    let onExit
    f.deps.fork = () => ({ pid: 901, on(event, fn) { if (event === 'exit') onExit = fn; return this }, unref() {} })
    f.d = daemon({ root: f.root, deps: f.deps })
    await f.d.start()
    const { run_id: run } = f.d.enqueue({ crew_dir: f.crewDir })
    assert.equal(typeof onExit, 'function')
    onExit(null, 'SIGKILL')
    const envelope = JSON.parse(readFileSync(returnFor(f, run), 'utf8'))
    assert.equal(envelope.status, 'escalation')
    assert.equal(envelope.details.escalation.where, 'signalled')
    assert.equal(envelope.details.escalation.why, 'child-exit:SIGKILL')
  })
})

test('a nonzero child exit writes its observed exit reason', async () => {
  await each(async (f) => {
    let onExit
    f.deps.fork = () => ({ pid: 901, on(event, fn) { if (event === 'exit') onExit = fn; return this }, unref() {} })
    f.d = daemon({ root: f.root, deps: f.deps })
    await f.d.start()
    const { run_id: run } = f.d.enqueue({ crew_dir: f.crewDir })
    assert.equal(typeof onExit, 'function')
    onExit(7, null)
    const envelope = JSON.parse(readFileSync(returnFor(f, run), 'utf8'))
    assert.equal(envelope.status, 'escalation')
    assert.equal(envelope.details.escalation.where, 'signalled')
    assert.equal(envelope.details.escalation.why, 'child-exit:7')
  })
})

test("a child's own envelope is never overwritten, including partial bytes", async () => {
  await each(async (f) => {
    let onExit
    f.deps.fork = () => ({ pid: 901, on(event, fn) { if (event === 'exit') onExit = fn; return this }, unref() {} })
    f.d = daemon({ root: f.root, deps: f.deps })
    await f.d.start()
    const { run_id: run } = f.d.enqueue({ crew_dir: f.crewDir })
    const original = JSON.stringify({ status: 'done', summary: 'child finished' })
    writeFileSync(returnFor(f, run), original)
    assert.equal(typeof onExit, 'function')
    onExit(null, 'SIGTERM')
    assert.equal(readFileSync(returnFor(f, run), 'utf8'), original)
    assert.equal(f.d.result({ run }).outcome, 'done')
  })
  await each(async (f) => {
    let onExit
    f.deps.fork = () => ({ pid: 901, on(event, fn) { if (event === 'exit') onExit = fn; return this }, unref() {} })
    f.d = daemon({ root: f.root, deps: f.deps })
    await f.d.start()
    const { run_id: run } = f.d.enqueue({ crew_dir: f.crewDir })
    const partial = '{"status":"done","summary":"cut off mid-w'
    writeFileSync(returnFor(f, run), partial)
    assert.equal(typeof onExit, 'function')
    onExit(null, 'SIGKILL')
    assert.equal(readFileSync(returnFor(f, run), 'utf8'), partial)
    assert.equal(f.d.result({ run }).reason, 'child-exit:SIGKILL')
  })
})

test('a signalled exit reason round-trips through the registry', async () => {
  const f = fixture()
  let next = null
  try {
    let onExit
    f.deps.fork = () => ({ pid: 901, on(event, fn) { if (event === 'exit') onExit = fn; return this }, unref() {} })
    f.d = daemon({ root: f.root, deps: f.deps })
    await f.d.start()
    const { run_id: run } = f.d.enqueue({ crew_dir: f.crewDir })
    assert.equal(typeof onExit, 'function')
    onExit(null, 'SIGTERM')
    const registry = readFileSync(join(f.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
    assert.equal(registry.find((record) => record.kind === 'orphaned' && record.run_id === run).reason, 'child-exit:SIGTERM')
    await f.d.stop()
    rmSync(returnFor(f, run))
    next = daemon({ root: f.root, deps: f.deps })
    await next.start(); next.poll()
    assert.equal(next.result({ run }).reason, 'child-exit:SIGTERM')
  } finally { await next?.stop(); await f.d.stop(); f.cleanup() }
})

test('a legacy orphaned registry record keeps its fallback reason', async () => {
  await each(async (f) => {
    const run = 'legacy-run'
    mkdirSync(f.root, { recursive: true })
    writeFileSync(join(f.root, 'runs.jsonl'), [
      JSON.stringify({ kind: 'enqueued', run_id: run, crew_dir: f.crewDir, task_return: returnFor(f, run) }),
      JSON.stringify({ kind: 'orphaned', run_id: run, at: 1 }),
    ].join('\n') + '\n')
    f.d = daemon({ root: f.root, deps: f.deps })
    await f.d.start(); f.d.poll()
    assert.equal(f.d.result({ run }).reason, 'orphaned-on-restart')
  })
})

test('a signalled envelope is written before its orphan registry record', async () => {
  await each(async (f) => {
    const operations = []
    const originalWrite = writeFileSync
    const originalAppend = appendFileSync
    f.deps.writeFileSync = (path, value, options) => {
      operations.push({ op: 'write', path: String(path) })
      return originalWrite(path, value, options)
    }
    f.deps.appendFileSync = (path, value, options) => {
      operations.push({ op: 'append', path: String(path), value: String(value) })
      return originalAppend(path, value, options)
    }
    let onExit
    f.deps.fork = () => ({ pid: 901, on(event, fn) { if (event === 'exit') onExit = fn; return this }, unref() {} })
    f.d = daemon({ root: f.root, deps: f.deps })
    await f.d.start()
    const { run_id: run } = f.d.enqueue({ crew_dir: f.crewDir })
    assert.equal(typeof onExit, 'function')
    onExit(null, 'SIGTERM')
    const writeIndex = operations.findIndex(({ op, path }) => op === 'write' && path === returnFor(f, run))
    const appendIndex = operations.findIndex(({ op, path, value }) => op === 'append' && path === join(f.root, 'runs.jsonl') && value.includes('"kind":"orphaned"'))
    assert.ok(writeIndex >= 0)
    assert.ok(appendIndex >= 0)
    assert.ok(writeIndex < appendIndex)
  })
})

test('a dead child found by polling ends the live feed after died', async () => {
  await each(async (f) => {
    await f.d.start()
    const { run_id: run } = f.d.enqueue({ crew_dir: f.crewDir })
    const socket = net.connect(f.d.socketPath)
    const frames = []
    let rest = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      const split = splitFrames(Buffer.concat([rest, chunk])); rest = split.rest
      frames.push(...split.lines.map(jsonFrame))
    })
    await new Promise((resolve) => socket.on('connect', resolve))
    socket.write(`${JSON.stringify({ id: 'poll-end', cmd: 'tail', params: { run, since: 0 } })}\n`)
    await waitFor(() => f.d.subscribers().some((s) => s.id === 'poll-end'), 'the poll-end subscription')
    f.alive.delete(900)
    f.d.poll()
    await waitFor(() => frames.some((frame) => frame.end), 'the terminal feed frame')
    const observations = frames.filter((frame) => frame.event || frame.end)
    assert.equal(observations.at(-1)?.end?.reason, 'orphaned')
    const died = observations.findIndex((frame) => frame.event?.kind === 'died')
    assert.ok(died >= 0)
    assert.ok(died < observations.findIndex((frame) => frame.end))
    assert.equal(f.d.state({ run }).state, 'done')
    assert.equal(f.d.result({ run }).envelope.details.escalation.why, 'child-dead')
    socket.destroy()
  })
})

// The converted waits are only an improvement if they still FAIL when the feed
// never ends. This is that arm: a live tail whose run never settles.
test('a bounded wait fails with its elapsed time when the condition never holds', async () => {
  await each(async (f) => {
    await f.d.start()
    const { run_id: run } = f.d.enqueue({ crew_dir: f.crewDir })
    const socket = net.connect(f.d.socketPath)
    const frames = []
    let rest = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      const split = splitFrames(Buffer.concat([rest, chunk])); rest = split.rest
      frames.push(...split.lines.map(jsonFrame))
    })
    await new Promise((resolve) => socket.on('connect', resolve))
    socket.write(`${JSON.stringify({ id: 'never-end', cmd: 'tail', params: { run, since: 0 } })}\n`)
    await waitFor(() => f.d.subscribers().some((s) => s.id === 'never-end'), 'the never-end subscription')
    const started = Date.now()
    await assert.rejects(
      () => waitFor(() => frames.some((frame) => frame.end), 'a terminal frame that never arrives', { timeout: 120 }),
      (err) => /^timed out after \d+ms waiting for a terminal frame that never arrives$/.test(err.message),
    )
    assert.ok(Date.now() - started >= 120)
    socket.destroy()
  })
})

test('a daemon-authored escalation is not a settle()', async () => {
  await each(async (f) => {
    await f.d.start()
    const { run_id: run } = f.d.enqueue({ crew_dir: f.crewDir })
    f.alive.delete(900)
    f.d.poll()
    const records = readFileSync(join(f.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
      .filter((record) => record.run_id === run)
    assert.equal(records.some((record) => record.kind === 'orphaned'), true)
    assert.equal(records.some((record) => record.kind === 'settled'), false)
    assert.equal(records.some((record) => record.kind === 'regrant'), false)
  })
})

// A late child error cannot grow a feed after the run has settled and compacted.
test('settled runs ignore late child spawn errors', async () => {
  await each(async (f) => {
    let onError
    f.deps.fork = () => ({
      pid: 901,
      on(event, fn) { if (event === 'error') onError = fn },
      unref() {},
    })
    f.d = daemon({ root: f.root, deps: f.deps })
    await f.d.start()
    f.alive.add(901)
    const { run_id: run } = f.d.enqueue({ crew_dir: f.crewDir })
    for (let i = 0; i < 5; i += 1) appendJournal(f, { headless_outcome: 'ok', role: 'builder' })
    f.d.poll()
    writeFileSync(returnFor(f, run), JSON.stringify({ status: 'done' }))
    f.d.poll()
    const retained = f.d.feed(run, 0)
    assert.equal(retained.length, 3)
    assert.equal(typeof onError, 'function')
    onError(Error('late EAGAIN'))
    onError(Error('later EAGAIN'))
    assert.deepEqual(f.d.feed(run, 0), retained)
  }, { feedRetention: 3 })
})

test('a fork with no pid is orphaned rather than adopted forever', async () => {
  const f = fixture()
  let next = null
  try {
    f.deps.fork = () => ({ on() {}, unref() {} })
    f.d = daemon({ root: f.root, deps: f.deps })
    await f.d.start()
    const run = 'pidless-run'
    assert.throws(() => f.d.enqueue({ crew_dir: f.crewDir, run_id: run }), (err) => err.code === 'child-spawn-error')
    await f.d.stop()
    next = daemon({ root: f.root, deps: f.deps }); await next.start(); next.poll()
    assert.equal(next.state({ run }).state, 'done')
    assert.equal(next.result({ run }).envelope.details.escalation.why, 'child-spawn-error: fork returned no pid')
  } finally { await next?.stop(); f.cleanup() }
})

test('runChild gives a task_return override precedence over crew.json', () => {
  const f = fixture(); const override = join(f.returnsDir, 'override.json')
  try {
    runChild({ crew_dir: f.crewDir, task_return: override, task: 'x' }, { driveTask: () => ({ status: 'done' }), seatIo: () => ({}), preflight: false })
    assert.equal(JSON.parse(readFileSync(override, 'utf8')).status, 'done'); assert.equal(JSON.parse(readFileSync(f.taskReturn, 'utf8')).status, 'done')
  } finally { f.cleanup() }
})

test('runChild mirrors per-run envelopes and writes the well-known path only once', () => {
  const f = fixture()
  try {
    const own = join(f.returnsDir, 'r1.task.json')
    const renames = []
    const result = runChild({ crew_dir: f.crewDir, task_return: own, task: 'x' }, {
      driveTask: () => ({ status: 'done', summary: 'per-run' }), seatIo: () => ({}), preflight: false,
      writeFileSync: (path, value, options) => writeFileSync(path, value, options),
      renameSync: (from, to) => { renames.push(String(to)); return renameSync(from, to) },
    })
    assert.equal(result.status, 'done')
    assert.deepEqual(JSON.parse(readFileSync(own, 'utf8')), JSON.parse(readFileSync(f.taskReturn, 'utf8')))
    assert.equal(renames.filter((path) => path === own).length, 1)
    assert.equal(renames.filter((path) => path === f.taskReturn).length, 1)
  } finally { f.cleanup() }

  const wellKnown = fixture()
  try {
    const renames = []
    runChild({ crew_dir: wellKnown.crewDir, task_return: wellKnown.taskReturn, task: 'x' }, {
      driveTask: () => ({ status: 'done', summary: 'well-known' }), seatIo: () => ({}), preflight: false,
      writeFileSync: (path, value, options) => writeFileSync(path, value, options),
      renameSync: (from, to) => { renames.push(String(to)); return renameSync(from, to) },
    })
    assert.equal(renames.filter((path) => path === wellKnown.taskReturn).length, 1)
  } finally { wellKnown.cleanup() }
})

test('runChild records to the explicit ledger and honors spec.ledger_db', () => {
  const f = fixture()
  const envDb = join(f.dir, 'env-ledger', 'ledger.db')
  const specDb = join(f.dir, 'spec-ledger', 'ledger.db')
  try {
    const result = runChild({
      crew_dir: f.crewDir, task: 'child-budget', checkout: f.dir,
      task_return: f.taskReturn, ledger_db: specDb,
    }, {
      preflight: false,
      env: { DEVTEAM_LEDGER_DB: envDb },
      driveTask: () => ({ status: 'done', summary: 'ok' }),
      seatIo: () => ({}),
    })
    assert.equal(result.status, 'done')
    assert.equal(existsSync(envDb), false)
    assert.equal(existsSync(join(f.crewDir, 'ledger', 'ledger.db')), false)
    const sidecar = JSON.parse(readFileSync(join(f.crewDir, 'ledger', 'run.json'), 'utf8'))
    assert.equal(sidecar.db_path, specDb)
    if (LEDGER_SQLITE_OK) {
      assert.equal(existsSync(specDb), true)
      const ledger = openLedger({ dbPath: specDb })
      try {
        assert.ok(ledger.listSessions().length >= 1)
        assert.deepEqual(ledger.dumpTable('run_links'), [])
      } finally { ledger.close() }
    } else {
      assert.equal(existsSync(specDb), false, 'below-floor emitters write JSONL but no SQLite mirror')
      assert.equal(existsSync(join(dirname(specDb), 'ledger.jsonl')), true)
    }
  } finally { f.cleanup() }
})

test('runChild wires the resolved brief into the session proposal without a crew.json brief_file', () => {
  if (!LEDGER_SQLITE_OK) return
  const f = fixture()
  const task = 'child-proposal'
  const dbPath = join(f.dir, 'proposal-ledger', 'ledger.db')
  try {
    writeFileSync(f.brief, '# proposal brief\n```proposal\n{"shape":"mechanical","strength":"workhorse"}\n```\n')
    const result = runChild({
      crew_dir: f.crewDir, task, checkout: f.dir,
      task_return: f.taskReturn, brief_file: f.brief, ledger_db: dbPath,
    }, {
      preflight: false,
      driveTask: () => ({ status: 'done', summary: '', artifacts: [], details: {} }),
      seatIo: () => ({}),
    })
    assert.equal(result.status, 'done')
    const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
    try {
      const row = ledger.dumpTable('sessions').find((candidate) => candidate.task_slug === task)
      assert.ok(row)
      assert.equal(row.proposed_shape, 'mechanical')
      assert.equal(row.proposed_strength, 'workhorse')
    } finally { ledger.close() }
  } finally { f.cleanup() }
})

test('runChild records null proposal fields for a blockless brief', () => {
  if (!LEDGER_SQLITE_OK) return
  const f = fixture()
  const task = 'child-blockless-proposal'
  const dbPath = join(f.dir, 'blockless-ledger', 'ledger.db')
  try {
    writeFileSync(f.brief, '# blockless brief\nno compiler proposal here\n')
    runChild({
      crew_dir: f.crewDir, task, checkout: f.dir,
      task_return: f.taskReturn, brief_file: f.brief, ledger_db: dbPath,
    }, {
      preflight: false,
      driveTask: () => ({ status: 'done', summary: '', artifacts: [], details: {} }),
      seatIo: () => ({}),
    })
    const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
    try {
      const row = ledger.dumpTable('sessions').find((candidate) => candidate.task_slug === task)
      assert.ok(row)
      assert.equal(row.proposed_shape, null)
      assert.equal(row.proposed_strength, null)
      assert.notDeepEqual(
        { shape: row.proposed_shape, strength: row.proposed_strength },
        { shape: 'mechanical', strength: 'workhorse' },
      )
    } finally { ledger.close() }
  } finally { f.cleanup() }
})

test('runChild records null proposal fields when no brief is supplied', () => {
  if (!LEDGER_SQLITE_OK) return
  const f = fixture()
  const task = 'child-no-proposal-brief'
  const dbPath = join(f.dir, 'no-brief-ledger', 'ledger.db')
  try {
    rmSync(f.brief, { force: true })
    const result = runChild({
      crew_dir: f.crewDir, task, checkout: f.dir,
      task_return: f.taskReturn, ledger_db: dbPath,
    }, {
      preflight: false,
      driveTask: () => ({ status: 'done', summary: '', artifacts: [], details: {} }),
      seatIo: () => ({}),
    })
    assert.equal(result.status, 'done')
    const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
    try {
      const row = ledger.dumpTable('sessions').find((candidate) => candidate.task_slug === task)
      assert.ok(row)
      assert.equal(row.proposed_shape, null)
      assert.equal(row.proposed_strength, null)
    } finally { ledger.close() }
  } finally { f.cleanup() }
})

test('runChild keeps the crew.json brief_file proposal fallback', () => {
  if (!LEDGER_SQLITE_OK) return
  const f = fixture()
  const task = 'child-crew-json-proposal'
  const dbPath = join(f.dir, 'crew-json-ledger', 'ledger.db')
  try {
    writeFileSync(f.brief, '# proposal brief\n```proposal\n{"shape":"mechanical","strength":"workhorse"}\n```\n')
    const crewPath = join(f.crewDir, 'crew.json')
    const crew = JSON.parse(readFileSync(crewPath, 'utf8'))
    crew.brief_file = f.brief
    writeFileSync(crewPath, JSON.stringify(crew))
    runChild({
      crew_dir: f.crewDir, task, checkout: f.dir,
      task_return: f.taskReturn, ledger_db: dbPath,
    }, {
      preflight: false,
      driveTask: () => ({ status: 'done', summary: '', artifacts: [], details: {} }),
      seatIo: () => ({}),
    })
    const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
    try {
      const row = ledger.dumpTable('sessions').find((candidate) => candidate.task_slug === task)
      assert.ok(row)
      assert.equal(row.proposed_shape, 'mechanical')
      assert.equal(row.proposed_strength, 'workhorse')
    } finally { ledger.close() }
  } finally { f.cleanup() }
})

test('runChild does not backfill a seeded session proposal', () => {
  if (!LEDGER_SQLITE_OK) return
  const f = fixture()
  const task = 'child-fresh-proposal'
  const historical = 'child-historical-proposal'
  const dbPath = join(f.dir, 'seeded-ledger', 'ledger.db')
  try {
    writeFileSync(f.brief, '# proposal brief\n```proposal\n{"shape":"mechanical","strength":"workhorse"}\n```\n')
    const seeded = openLedger({ dbPath, stderr: { write: () => {} } })
    try {
      seeded.startSession({ adw_id: historical, repo_slug: 'repo', task_slug: historical })
    } finally { seeded.close() }
    runChild({
      crew_dir: f.crewDir, task, checkout: f.dir,
      task_return: f.taskReturn, brief_file: f.brief, ledger_db: dbPath,
    }, {
      preflight: false,
      driveTask: () => ({ status: 'done', summary: '', artifacts: [], details: {} }),
      seatIo: () => ({}),
    })
    const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
    try {
      const rows = ledger.dumpTable('sessions')
      const oldRow = rows.find((candidate) => candidate.adw_id === historical)
      const newRow = rows.find((candidate) => candidate.task_slug === task)
      assert.ok(oldRow)
      assert.ok(newRow)
      assert.equal(oldRow.proposed_shape, null)
      assert.equal(oldRow.proposed_strength, null)
      assert.equal(newRow.proposed_shape, 'mechanical')
      assert.equal(newRow.proposed_strength, 'workhorse')
      const proposedRows = rows.filter((row) => row.proposed_shape !== null || row.proposed_strength !== null)
      assert.equal(proposedRows.length, 1)
      assert.equal(proposedRows[0].task_slug, task)
    } finally { ledger.close() }
  } finally { f.cleanup() }
})

test('runChild carries run_id into the ledger association and keeps it distinct from adw_id', () => {
  if (!LEDGER_SQLITE_OK) return
  const f = fixture()
  const dbPath = join(f.dir, 'run-identity-ledger', 'ledger.db')
  const runId = 'daemon-child-run-A'
  try {
    const result = runChild({
      crew_dir: f.crewDir, task: 'child-linked', checkout: f.dir,
      task_return: f.taskReturn, ledger_db: dbPath, run_id: runId,
    }, {
      preflight: false,
      driveTask: () => ({ status: 'done', summary: 'linked' }),
      seatIo: () => ({}),
    })
    assert.equal(result.status, 'done')
    const sidecar = JSON.parse(readFileSync(join(f.crewDir, 'ledger', 'run.json'), 'utf8'))
    const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
    try {
      assert.notEqual(sidecar.adw_id, runId)
      assert.deepEqual(ledger.dumpTable('run_links').map(({ run_id, adw_id }) => ({ run_id, adw_id })), [
        { run_id: runId, adw_id: sidecar.adw_id },
      ])
      assert.equal(ledger.taskReadout(runId).adw_id, sidecar.adw_id)
    } finally { ledger.close() }
  } finally { f.cleanup() }
})

test('two runChild calls against one crew dir append links to the adopted sidecar session', () => {
  if (!LEDGER_SQLITE_OK) return
  const f = fixture()
  const dbPath = join(f.dir, 'run-identity-shared', 'ledger.db')
  const first = 'daemon-child-run-one'
  const second = 'daemon-child-run-two'
  try {
    for (const runId of [first, second]) {
      runChild({
        crew_dir: f.crewDir, task: `child-${runId}`, checkout: f.dir,
        task_return: join(f.returnsDir, `${runId}.task.json`), ledger_db: dbPath, run_id: runId,
      }, {
        preflight: false,
        driveTask: () => ({ status: 'done', summary: runId }),
        seatIo: () => ({}),
      })
    }
    const sidecar = JSON.parse(readFileSync(join(f.crewDir, 'ledger', 'run.json'), 'utf8'))
    const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
    try {
      const rows = ledger.dumpTable('run_links')
      assert.equal(rows.length, 2)
      assert.deepEqual(rows.map(({ run_id }) => run_id), [first, second])
      assert.notEqual(sidecar.adw_id, first)
      assert.notEqual(sidecar.adw_id, second)
      for (const runId of [first, second]) {
        const readout = ledger.taskReadout(runId)
        assert.equal(readout.adw_id, sidecar.adw_id)
        assert.deepEqual(readout.run_ids, [first, second])
      }
    } finally { ledger.close() }
  } finally { f.cleanup() }
})

test('runChild without run_id writes no run_links row', () => {
  if (!LEDGER_SQLITE_OK) return
  const f = fixture()
  const dbPath = join(f.dir, 'run-identity-absent', 'ledger.db')
  try {
    runChild({
      crew_dir: f.crewDir, task: 'child-unlinked', checkout: f.dir,
      task_return: f.taskReturn, ledger_db: dbPath,
    }, {
      preflight: false,
      driveTask: () => ({ status: 'done' }),
      seatIo: () => ({}),
    })
    const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
    try { assert.deepEqual(ledger.dumpTable('run_links'), []) } finally { ledger.close() }
  } finally { f.cleanup() }
})

test('runChild rejects a budget ledger that conflicts with a stale crew-local sidecar', () => {
  const f = fixture()
  const staleDb = join(f.dir, 'stale-ledger', 'ledger.db')
  const budgetDb = join(f.dir, 'budget-ledger', 'ledger.db')
  try {
    const stale = openRun({ stateDir: f.crewDir, repoSlug: 'old', taskSlug: 'old', dbPath: staleDb })
    stale.startRun()
    stale.endRun({ status: 'ok' })
    let staleSessions = null
    if (LEDGER_SQLITE_OK) {
      const ledger = openLedger({ dbPath: staleDb })
      try { staleSessions = ledger.listSessions().length } finally { ledger.close() }
    }
    let drove = 0
    const result = runChild({
      crew_dir: f.crewDir, task: 'child-budget-isolated', checkout: f.dir,
      task_return: f.taskReturn, ledger_db: budgetDb, budget_enabled: true,
    }, {
      preflight: false,
      driveTask: () => { drove += 1; return { status: 'done', summary: 'must not run' } },
      seatIo: () => ({}),
    })
    assert.equal(result.status, 'escalation')
    assert.equal(result.details.escalation.where, 'ledger-sidecar')
    assert.match(result.details.escalation.why, /mismatched budget ledger/)
    assert.equal(drove, 0, 'a mismatched sidecar must refuse before task execution')
    const sidecar = JSON.parse(readFileSync(join(f.crewDir, 'ledger', 'run.json'), 'utf8'))
    assert.equal(sidecar.db_path, staleDb)
    assert.equal(existsSync(budgetDb), false)
    if (LEDGER_SQLITE_OK) {
      const staleLedger = openLedger({ dbPath: staleDb })
      try { assert.equal(staleLedger.listSessions().length, staleSessions) } finally { staleLedger.close() }
    } else {
      assert.equal(existsSync(join(dirname(budgetDb), 'ledger.jsonl')), false)
    }
  } finally { f.cleanup() }
})

test('runChild lets no-budget instrumentation adopt a stale crew-local sidecar', () => {
  const f = fixture()
  const staleDb = join(f.dir, 'stale-ledger', 'ledger.db')
  const requestedDb = join(f.dir, 'requested-ledger', 'ledger.db')
  try {
    const stale = openRun({ stateDir: f.crewDir, repoSlug: 'old', taskSlug: 'old', dbPath: staleDb })
    stale.startRun()
    stale.endRun({ status: 'ok' })
    let drove = 0
    let receivedEmitter = null
    const result = runChild({
      crew_dir: f.crewDir, task: 'child-no-budget-sidecar', checkout: f.dir,
      task_return: f.taskReturn, ledger_db: requestedDb, budget_enabled: false,
    }, {
      preflight: false,
      driveTask: () => { drove += 1; return { status: 'done', summary: 'must run' } },
      seatIo: (_crew, _dirs, _checkout, emitter) => { receivedEmitter = emitter; return {} },
    })
    assert.equal(result.status, 'done')
    assert.equal(drove, 1, 'a no-budget stale sidecar must not refuse task execution')
    assert.ok(receivedEmitter, 'feature-off runs should retain their optional emitter')
    const sidecar = JSON.parse(readFileSync(join(f.crewDir, 'ledger', 'run.json'), 'utf8'))
    assert.equal(sidecar.db_path, staleDb)
    assert.equal(existsSync(requestedDb), false)
  } finally { f.cleanup() }
})

test('a degraded child emitter never fails the run or suppresses task_return', () => {
  const f = fixture()
  const parentFile = join(f.dir, 'not-a-directory')
  const taskReturn = join(f.returnsDir, 'degraded.json')
  writeFileSync(parentFile, 'not a directory')
  try {
    const result = runChild({
      crew_dir: f.crewDir, task: 'child-budget-degraded', checkout: f.dir,
      task_return: taskReturn, ledger_db: join(parentFile, 'ledger.db'),
    }, {
      preflight: false,
      driveTask: () => ({ status: 'done', summary: 'still ran' }),
      seatIo: () => ({}),
    })
    assert.equal(result.status, 'done')
    assert.equal(JSON.parse(readFileSync(taskReturn, 'utf8')).status, 'done')
  } finally { f.cleanup() }
})

test('production child preflight writes an escalation envelope for pane seats', () => {
  const f = fixture({ roles: ['builder'], transport: 'pane' })
  try {
    const result = runChild({ crew_dir: f.crewDir, task: 'x' })
    assert.equal(result.status, 'escalation'); assert.equal(JSON.parse(readFileSync(f.taskReturn, 'utf8')).status, 'escalation')
  } finally { f.cleanup() }
})

test('headless-rpc workers are discovered from their role directories', async () => {
  await each(async (f) => {
    const rpc = fixture({ roles: ['builder'], transport: 'headless-rpc' })
    try {
      await rpc.d.start(); const { run_id: run } = rpc.d.enqueue({ crew_dir: rpc.crewDir });
      const dir = join(rpc.taskDir, 'headless-rpc', 'builder'); mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'stream.jsonl'), `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } })}\n`)
      rpc.d.poll(); assert.ok(rpc.d.feed(run, 0).some((event) => event.kind === 'tool-call' && event.role === 'builder'))
    } finally { await rpc.d.stop(); rpc.cleanup() }
  })
})

// All protocol verbs beyond ping/tail are exercised through the real socket.
test('socket dispatch covers enqueue, list, state, result, untail, and stop', async () => {
  const f = fixture()
  try {
    await f.d.start()
    const enqueue = jsonFrame((await request(f.d.socketPath, `${JSON.stringify({ id: 'e', cmd: 'enqueue', params: { crew_dir: f.crewDir } })}\n`))[0])
    const run = enqueue.result.run_id
    assert.equal(jsonFrame((await request(f.d.socketPath, `${JSON.stringify({ id: 'l', cmd: 'list' })}\n`))[0]).ok, true)
    assert.equal(jsonFrame((await request(f.d.socketPath, `${JSON.stringify({ id: 's', cmd: 'state', params: { run } })}\n`))[0]).result.state, 'working')
    assert.equal(jsonFrame((await request(f.d.socketPath, `${JSON.stringify({ id: 'r', cmd: 'result', params: { run } })}\n`))[0]).result.outcome, null)
    assert.equal(jsonFrame((await request(f.d.socketPath, '{"id":"u","cmd":"untail"}\n'))[0]).result.removed, false)
    assert.equal(jsonFrame((await request(f.d.socketPath, '{"id":"x","cmd":"stop"}\n'))[0]).result.stopped, true)
  } finally { await f.d.stop(); f.cleanup() }
})

// 19. The real net server is the protocol implementation, not just a fake.
test('real unix socket answers ping and unknown command', async () => {
  await each(async ({ d }) => {
    await d.start()
    const frames = await request(d.socketPath, '{"id":"p","cmd":"ping"}\n')
    assert.equal(jsonFrame(frames[0]).ok, true)
    const unknown = jsonFrame((await request(d.socketPath, '{"id":"u","cmd":"nope"}\n'))[0])
    assert.equal(unknown.ok, false); assert.equal(unknown.error.command, 'nope')
  })
})

// --- review round-2 residuals, 2026-08-14 -----------------------------------

// R2-S2: the preflight block had ZERO coverage — every test that reached
// runChild injected driveTask/seatIo, which under the old polarity disabled
// the block entirely. Deleting all seven guards left the suite and the gate
// green. These pin each branch, and would have caught R2-S1 below.
test('child preflight refuses a missing seat, a missing brief, and a foreign checkout', () => {
  const noReviewer = fixture({ roles: ['planner', 'builder'] })
  try {
    runChild({ crew_dir: noReviewer.crewDir, task: 'x', brief_file: join(noReviewer.crewDir, 'b.md') }, { execSync: () => '' })
    const env = JSON.parse(readFileSync(noReviewer.taskReturn, 'utf8'))
    assert.equal(env.status, 'escalation')
    assert.match(env.details.escalation.why, /requires a reviewer seat/)
  } finally { noReviewer.cleanup() }

  const noBrief = fixture()
  try {
    runChild({ crew_dir: noBrief.crewDir, task: 'x' }, { execSync: () => '' })
    assert.match(JSON.parse(readFileSync(noBrief.taskReturn, 'utf8')).details.escalation.why, /--brief-file/)
  } finally { noBrief.cleanup() }

  const foreign = fixture()
  try {
    const brief = join(foreign.crewDir, 'b.md'); writeFileSync(brief, '# brief')
    runChild({ crew_dir: foreign.crewDir, task: 'x', brief_file: brief, checkout: tmpdir() }, { execSync: () => '' })
    assert.match(JSON.parse(readFileSync(foreign.taskReturn, 'utf8')).details.escalation.why, /same directory name, different checkout/)
  } finally { foreign.cleanup() }
})

// R2-S1: the dirty listing was capped with split('\\n') inside a template
// literal — a literal backslash-n, so the array had one element and the cap
// never applied. A checkout with an untracked node_modules would embed
// thousands of lines in an envelope that is re-read on every result() call.
test('a dirty checkout refuses and its listing is capped at ten lines', () => {
  const f = fixture()
  try {
    const brief = join(f.crewDir, 'b.md'); writeFileSync(brief, '# brief')
    const dirty = Array.from({ length: 25 }, (_, i) => `?? file-${i}.txt`).join('\n')
    runChild({ crew_dir: f.crewDir, task: 'x', brief_file: brief }, { execSync: () => dirty })
    const why = JSON.parse(readFileSync(f.taskReturn, 'utf8')).details.escalation.why
    assert.match(why, /checkout is dirty/)
    assert.equal(why.split('\n').length - 1, 10, 'exactly ten listing lines survive the cap')
  } finally { f.cleanup() }
})

test('a continuation child resumes on top of a dirty checkout', () => {
  const f = fixture()
  try {
    const brief = join(f.crewDir, 'b.md'); writeFileSync(brief, '# brief')
    runChild(
      { crew_dir: f.crewDir, task: 'x', brief_file: brief, continuation: true },
      { execSync: () => ' M prior-round.js', driveTask: () => ({ status: 'done' }), seatIo: () => ({}) },
    )
    assert.equal(JSON.parse(readFileSync(f.taskReturn, 'utf8')).status, 'done')
  } finally { f.cleanup() }
})

// The opt-out must be explicit, and must be the ONLY way to skip the block.
// Both arms are needed: the first distinguishes the fixed polarity from the
// original (`harness`-derived) one, under which injecting a driver silently
// disabled every guard. The second proves the opt-out still works.
test('injecting a driver does not skip preflight; only an explicit opt-out does', () => {
  const strict = fixture()
  try {
    // Driver injected, NO opt-out: preflight must still refuse the missing brief.
    assert.throws(
      () => runChild({ crew_dir: strict.crewDir, task: 'x' }, { driveTask: () => ({ status: 'done' }), seatIo: () => ({}), execSync: () => '' }),
      /--brief-file/,
      'a caller that injects a driver must still be preflighted',
    )
  } finally { strict.cleanup() }

  const opted = fixture()
  try {
    runChild({ crew_dir: opted.crewDir, task: 'x' }, { driveTask: () => ({ status: 'done' }), seatIo: () => ({}), preflight: false })
    assert.equal(JSON.parse(readFileSync(opted.taskReturn, 'utf8')).status, 'done', 'the explicit opt-out still runs the task')
  } finally { opted.cleanup() }
})

// Settling evicts the live feed from the front while preserving sequence order.
test('settled feed compaction is structural and bounded', async () => {
  const retention = 3
  const bounded = fixture({ feedRetention: retention })
  try {
    await bounded.d.start()
    const { run_id: run } = bounded.d.enqueue({ crew_dir: bounded.crewDir })
    bounded.d.poll()
    for (let i = 0; i < 5; i += 1) appendJournal(bounded, { headless_outcome: 'ok', role: 'builder' })
    bounded.d.poll()
    const before = bounded.d.feed(run, 0)
    assert.ok(before.length > retention)
    const firstSeq = before[0].seq
    writeFileSync(returnFor(bounded, run), JSON.stringify({ status: 'done' }))
    bounded.d.poll()
    const after = bounded.d.feed(run, 0)
    assert.ok(after.length <= retention)
    assert.ok(after.length > 0)
    assert.ok(after[0].seq > firstSeq)
  } finally { await bounded.d.stop(); bounded.cleanup() }
})

// Feed eviction must not remove the run registry projection or its answers.
test('feed eviction costs the registry nothing', async () => {
  const bounded = fixture({ feedRetention: 3 })
  try {
    const { run_id: run } = bounded.d.enqueue({ crew_dir: bounded.crewDir })
    for (let i = 0; i < 6; i += 1) appendJournal(bounded, { headless_outcome: 'ok', role: 'builder' })
    bounded.d.poll()
    writeFileSync(returnFor(bounded, run), JSON.stringify({ status: 'done' }))
    bounded.d.poll()
    assert.equal(bounded.d.list().find((row) => row.run_id === run).state, 'done')
    assert.equal(bounded.d.state({ run }).state, 'done')
    assert.equal(bounded.d.result({ run }).outcome, 'done')
  } finally { await bounded.d.stop(); bounded.cleanup() }
})

// A post-settle tail still replays exactly the retained window.
test('tail after settle replays the retained feed window', async () => {
  const bounded = fixture({ feedRetention: 3 })
  try {
    await bounded.d.start()
    const { run_id: run } = bounded.d.enqueue({ crew_dir: bounded.crewDir })
    for (let i = 0; i < 6; i += 1) appendJournal(bounded, { headless_outcome: 'ok', role: 'builder' })
    bounded.d.poll()
    writeFileSync(returnFor(bounded, run), JSON.stringify({ status: 'done' }))
    bounded.d.poll()
    const retained = bounded.d.feed(run, 0)
    const frames = await request(
      bounded.d.socketPath,
      `${JSON.stringify({ id: 'tail-settled', cmd: 'tail', params: { run, since: 0 } })}\n`,
      retained.length + 1,
    )
    const replay = frames.map(jsonFrame).filter((frame) => frame.event).map((frame) => frame.event)
    assert.deepEqual(replay, retained)
  } finally { await bounded.d.stop(); bounded.cleanup() }
})

test('settle sends a subscriber an end frame that claims no outcome', async () => {
  await each(async (f) => {
    await f.d.start()
    const { run_id: run } = f.d.enqueue({ crew_dir: f.crewDir })
    const socket = net.connect(f.d.socketPath)
    const frames = []
    let rest = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      const split = splitFrames(Buffer.concat([rest, chunk])); rest = split.rest
      frames.push(...split.lines.map(jsonFrame))
    })
    await new Promise((resolve) => socket.on('connect', resolve))
    socket.write(`${JSON.stringify({ id: 'end', cmd: 'tail', params: { run, since: 0 } })}\n`)
    await waitFor(() => f.d.subscribers().some((s) => s.id === 'end'), 'the end subscription')
    writeFileSync(returnFor(f, run), JSON.stringify({ status: 'done' }))
    f.d.poll()
    await waitFor(() => frames.some((frame) => frame.end), 'the terminal feed frame')
    const end = frames.find((frame) => frame.end)
    assert.deepEqual(end?.end, { run_id: run, reason: 'settled' })
    assert.doesNotMatch(JSON.stringify(end), /status|outcome|success|escalation/)
    socket.destroy()
  })
})

test('subscribers projects the daemon subscriber set', async () => {
  await each(async (f) => {
    await f.d.start()
    const { run_id: run } = f.d.enqueue({ crew_dir: f.crewDir })
    const socket = net.connect(f.d.socketPath)
    await new Promise((resolve) => socket.on('connect', resolve))
    socket.write(`${JSON.stringify({ id: 'inspect', cmd: 'tail', params: { run, since: 0 } })}\n`)
    await waitFor(() => f.d.subscribers().length === 1, 'the inspect subscription')
    assert.deepEqual(f.d.subscribers(), [{ id: 'inspect', run_id: run }])
    socket.write(`${JSON.stringify({ id: 'untail', cmd: 'untail', params: { run } })}\n`)
    await waitFor(() => f.d.subscribers().length === 0, 'the untail to drop the subscriber')
    assert.deepEqual(f.d.subscribers(), [])
    socket.destroy()
  })
})

// Positional journal reads begin at the prior EOF rather than rereading history.
test('cursorLines reads only newly appended bytes', async () => {
  await each(async (f) => {
    const positions = []
    instrumentCursorReads(f, positions)
    const { run_id: run } = f.d.enqueue({ crew_dir: f.crewDir })
    const firstRows = Array.from({ length: 4 }, () => ({ headless_outcome: 'ok', role: 'builder' }))
    firstRows.forEach((row) => appendJournal(f, row))
    f.d.poll()
    const previousEof = statSync(join(f.crewDir, 'journal.jsonl')).size
    positions.length = 0
    const secondRows = Array.from({ length: 3 }, () => ({ headless_outcome: 'ok', role: 'builder' }))
    const secondText = secondRows.map((row) => `${JSON.stringify(row)}\n`).join('')
    writeFileSync(join(f.crewDir, 'journal.jsonl'), secondText, { flag: 'a' })
    f.d.poll()
    assert.ok(f.d.feed(run, 0).length > firstRows.length)
    assert.ok(positions.length > 0)
    assert.ok(positions.every(({ position }) => position === previousEof))
    assert.equal(positions.reduce((sum, { length }) => sum + length, 0), Buffer.byteLength(secondText))
  })
})

// A rotation that shrinks the file resets the cursor and projects fresh rows.
test('cursorLines resets after journal truncation', async () => {
  await each(async (f) => {
    const positions = []
    instrumentCursorReads(f, positions)
    const { run_id: run } = f.d.enqueue({ crew_dir: f.crewDir })
    for (let i = 0; i < 8; i += 1) appendJournal(f, { headless_outcome: 'ok', role: 'builder' })
    f.d.poll()
    const seen = f.d.feed(run, 0).length
    positions.length = 0
    const fresh = `${JSON.stringify({ no_lead_escalation: 'rotated' })}\n`
    writeFileSync(join(f.crewDir, 'journal.jsonl'), fresh)
    f.d.poll()
    const projected = f.d.feed(run, 0).slice(seen)
    assert.ok(projected.some((event) => event.kind === 'blocked'))
    assert.ok(positions.some(({ position }) => position === 0))
  })
})

// The per-run crew config parse is cached until its mtime/size stamp changes.
test('crew.json is parsed once per run and reread after an mtime change', async () => {
  await each(async (f) => {
    const crewPath = join(f.crewDir, 'crew.json')
    const realRead = readFileSync
    let crewReads = 0
    f.deps.readFileSync = (path, ...args) => {
      if (String(path) === crewPath) crewReads += 1
      return realRead(path, ...args)
    }
    f.d = daemon({ root: f.root, deps: f.deps })
    f.d.enqueue({ crew_dir: f.crewDir })
    const before = crewReads
    for (let i = 0; i < 5; i += 1) f.d.poll()
    assert.ok(crewReads - before <= 1)
    const mark = crewReads
    const crew = JSON.parse(realRead(crewPath, 'utf8'))
    crew.members.builder.transport = 'headless-rpc'
    writeFileSync(crewPath, JSON.stringify(crew))
    const future = new Date(Date.now() + 5000)
    utimesSync(crewPath, future, future)
    f.d.poll()
    assert.ok(crewReads - mark >= 1)
  })
})

// Membership alone is not evidence that an rpc seat ever spawned.
test('an rpc seat without spawn evidence is not reported working', async () => {
  const rpc = fixture({ roles: ['builder'], transport: 'headless-rpc' })
  try {
    const { run_id: run } = rpc.d.enqueue({ crew_dir: rpc.crewDir })
    rpc.d.poll()
    assert.throws(() => rpc.d.state({ run, worker: 'builder' }), (err) => err.code === 'not-found')
    const dir = join(rpc.taskDir, 'headless-rpc', 'builder')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'pgid'), '901\n')
    rpc.d.poll()
    assert.equal(rpc.d.state({ run, worker: 'builder' }).state, 'working')
  } finally { await rpc.d.stop(); rpc.cleanup() }
})

// A pidless fork is an error on the real protocol and carries no success result.
test('a pidless fork returns a socket error without a result', async () => {
  const f = fixture()
  try {
    f.deps.fork = () => ({ on() {}, unref() {} })
    f.d = daemon({ root: f.root, deps: f.deps })
    await f.d.start()
    const run = 'socket-pidless'
    const frames = await request(f.d.socketPath, `${JSON.stringify({ id: 'pidless', cmd: 'enqueue', params: { crew_dir: f.crewDir, run_id: run } })}\n`)
    const frame = jsonFrame(frames[0])
    assert.equal(frame.ok, false)
    assert.equal(frame.error.code, 'child-spawn-error')
    assert.equal('result' in frame, false)
    assert.match(readFileSync(join(f.root, 'runs.jsonl'), 'utf8'), /"orphaned"/)
  } finally { await f.d.stop(); f.cleanup() }
})

test('send delivers a steer frame to a steerable rpc seat', async () => {
  await each(async (f) => {
    const { run_id: run } = f.d.enqueue({ crew_dir: f.crewDir })
    const seat = stageRpcSeat(f, 'builder')
    const result = await f.d.send({ run, message: 'guidance', role: 'builder' })
    assert.equal(result.delivered, 'command-channel')
    assert.equal(result.run_id, run)
    const frame = JSON.parse(readFileSync(join(seat, 'cmd.fifo'), 'utf8').trim())
    assert.equal(frame.type, 'steer')
    assert.equal(frame.message, 'guidance')
    assert.equal(typeof frame.id, 'string')
  }, { roles: ['builder'], transport: 'headless-rpc', agent: 'pi' })
})

test('send refuses malformed or absent crew.json with the same invalid-spec', async () => {
  const refusals = []
  for (const state of ['malformed', 'absent']) {
    await each(async (f) => {
      const { run_id: run } = f.d.enqueue({ crew_dir: f.crewDir })
      stageRpcSeat(f, 'builder')
      const crewPath = join(f.crewDir, 'crew.json')
      if (state === 'malformed') writeFileSync(crewPath, '{not json')
      else unlinkSync(crewPath)
      await assert.rejects(() => f.d.send({ run, message: 'guidance', role: 'builder' }), (err) => {
        refusals.push({ code: err.code, message: err.message })
        return err.code === 'invalid-spec'
      })
    }, { roles: ['builder'], transport: 'headless-rpc', agent: 'pi' })
  }
  assert.equal(refusals.length, 2)
  assert.equal(refusals[0].code, refusals[1].code)
  assert.match(refusals[0].message, /^cannot read crew\.json at /)
  assert.match(refusals[1].message, /^cannot read crew\.json at /)
})

test('send refuses a transport that cannot be steered', async () => {
  await each(async (f) => {
    const { run_id: run } = f.d.enqueue({ crew_dir: f.crewDir })
    await assert.rejects(() => f.d.send({ run, message: 'guidance' }), (err) => {
      assert.equal(err.code, 'not-capable')
      assert.match(err.message, /interjection/)
      assert.match(err.message, /headless-json/)
      assert.match(err.message, /turn/)
      return true
    })
  }, { roles: ['builder'], transport: 'headless-json' })
})

test('send refuses an adapter with no profile for the transport', async () => {
  await each(async (f) => {
    const { run_id: run } = f.d.enqueue({ crew_dir: f.crewDir })
    await assert.rejects(() => f.d.send({ run, message: 'guidance', role: 'builder' }), (err) => err.code === 'not-capable')
  }, { roles: ['builder'], transport: 'headless-rpc', agent: 'claude' })
})

test('send refuses an unknown run and an unknown role', async () => {
  await each(async (f) => {
    const { run_id: run } = f.d.enqueue({ crew_dir: f.crewDir })
    stageRpcSeat(f, 'builder')
    await assert.rejects(() => f.d.send({ run: 'missing', message: 'guidance' }), (err) => err.code === 'not-found')
    await assert.rejects(() => f.d.send({ run, message: 'guidance', role: 'nobody' }), (err) => {
      assert.equal(err.code, 'not-found')
      assert.match(err.message, /seated roles: builder/)
      return true
    })
  }, { roles: ['builder'], transport: 'headless-rpc', agent: 'pi' })
})

test('send refuses a settled run', async () => {
  await each(async (f) => {
    const { run_id: run } = f.d.enqueue({ crew_dir: f.crewDir })
    stageRpcSeat(f, 'builder')
    writeFileSync(returnFor(f, run), JSON.stringify({ status: 'done' }))
    f.d.poll()
    await assert.rejects(() => f.d.send({ run, message: 'guidance', role: 'builder' }), (err) => err.code === 'not-live')
  }, { roles: ['builder'], transport: 'headless-rpc', agent: 'pi' })
})

test('send cannot settle a run or alter its outcome', async () => {
  await each(async (f) => {
    const { run_id: run } = f.d.enqueue({ crew_dir: f.crewDir })
    stageRpcSeat(f, 'builder')
    const beforeFeed = f.d.feed(run, 0).length
    const result = await f.d.send({ run, message: 'guidance', role: 'builder' })
    assert.equal(result.interjection, 'boundary')
    assert.deepEqual(f.d.result({ run }), { outcome: null, envelope: null, source: null, reason: 'pending' })
    assert.equal(f.d.state({ run }).state, 'working')
    assert.equal(f.d.feed(run, 0).length, beforeFeed)
    const records = readFileSync(join(f.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(records.some((record) => record.kind === 'settled'), false)
    assert.equal(records.some((record) => record.kind === 'sent'), true)
  }, { roles: ['builder'], transport: 'headless-rpc', agent: 'pi' })
})

test('send command set stays closed', async () => {
  assert.deepEqual(DAEMON_COMMANDS, ['ping', 'enqueue', 'list', 'state', 'result', 'tail', 'untail', 'stop', 'send'])
  const f = fixture({ roles: ['builder'], transport: 'headless-rpc', agent: 'pi' })
  try {
    await f.d.start()
    for (const cmd of DAEMON_COMMANDS.filter((value) => value !== 'stop')) {
      const params = cmd === 'enqueue' ? { crew_dir: f.crewDir } : {}
      const frame = jsonFrame((await request(f.d.socketPath, `${JSON.stringify({ id: `closed-${cmd}`, cmd, params })}\n`))[0])
      assert.notEqual(frame.error?.code, 'unknown-command', cmd)
    }
    const stop = jsonFrame((await request(f.d.socketPath, '{"id":"closed-stop","cmd":"stop"}\n'))[0])
    assert.notEqual(stop.error?.code, 'unknown-command')
  } finally { await f.d.stop(); f.cleanup() }
})

test('send with no role picks the single steerable seat and refuses when there are several', async () => {
  await each(async (single) => {
    const { run_id: run } = single.d.enqueue({ crew_dir: single.crewDir })
    const seat = stageRpcSeat(single, 'builder')
    const result = await single.d.send({ run, message: 'guidance' })
    assert.equal(result.role, 'builder')
    assert.equal(JSON.parse(readFileSync(join(seat, 'cmd.fifo'), 'utf8').trim()).message, 'guidance')
  }, { roles: ['builder'], transport: 'headless-rpc', agent: 'pi' })
  await each(async (multiple) => {
    const { run_id: run } = multiple.d.enqueue({ crew_dir: multiple.crewDir })
    stageRpcSeat(multiple, 'planner'); stageRpcSeat(multiple, 'builder')
    await assert.rejects(() => multiple.d.send({ run, message: 'guidance' }), (err) => {
      assert.equal(err.code, 'invalid-params')
      assert.match(err.message, /planner, builder/)
      assert.match(err.message, /--role/)
      return true
    })
  }, { roles: ['planner', 'builder'], transport: 'headless-rpc', agent: 'pi' })
})

test('run-end teardown kills a real piped seat and its recorded pgid is gone', { timeout: 20_000 }, async () => {
  const f = fixture({ roles: ['builder'], transport: 'headless-rpc', agent: 'pi' })
  const binDir = join(f.dir, 'worker-bin')
  const pgidPath = join(f.taskDir, 'headless-rpc', 'builder', 'pgid')
  const savedPath = process.env.PATH
  teardownPgidPaths.add(pgidPath)
  mkdirSync(binDir)
  writeFileSync(join(binDir, 'pi'), '#!/usr/bin/env node\nprocess.stdin.resume()\nsetInterval(() => {}, 1000)\n')
  chmodSync(join(binDir, 'pi'), 0o755)
  process.env.PATH = `${binDir}:${savedPath || ''}`
  try {
    const result = runChild({
      crew_dir: f.crewDir, task: 'real-teardown', checkout: f.dir,
      task_return: f.taskReturn, brief_file: f.brief, ledger_db: join(f.dir, 'ledger.db'),
    }, {
      preflight: false,
      driveTask: (ctx, io) => {
        io.assign({ role: 'builder', briefFile: ctx.briefFile })
        return { status: 'done', summary: 'real teardown', artifacts: [], details: {} }
      },
    })
    assert.equal(result.status, 'done')
    const pgid = recordedPgid(pgidPath)
    assert.ok(pgid)
    let gone = false
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      try { process.kill(-pgid, 0) } catch (err) {
        if (err?.code === 'ESRCH') { gone = true; break }
      }
      // FIXED SLEEP: poll cadence of a bounded while (Date.now() < deadline)
      // wait, not a stand-in for a condition.
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(gone, true, `recorded process group ${pgid} remained live`)

    const sidecar = JSON.parse(readFileSync(join(f.crewDir, 'ledger', 'run.json'), 'utf8'))
    const ledger = openLedger({ dbPath: sidecar.db_path, stderr: { write: () => {} } })
    try {
      const rows = ledger.dumpTable('seat_teardowns').filter((row) => row.role === 'builder')
      assert.equal(rows.length, 1)
      assert.equal(rows[0].adw_id, sidecar.adw_id)
      assert.equal(rows[0].pgid, pgid)
      assert.equal(rows[0].outcome, 'proven')
      assert.equal(rows[0].forced, 1)
    } finally { ledger.close() }
    assert.equal(JSON.parse(readFileSync(f.taskReturn, 'utf8')).status, 'done')
    const journal = readFileSync(join(f.crewDir, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
    assert.ok(journal.some((entry) => entry.event === 'seat-teardown' && entry.role === 'builder' && entry.outcome === 'proven'))
  } finally {
    if (savedPath === undefined) delete process.env.PATH
    else process.env.PATH = savedPath
    killRecordedGroup(pgidPath)
    f.cleanup()
  }
})

test('seatIo teardown sweeps every declared headless-rpc transport', () => {
  const members = {
    builder: { model: 'm', transport: 'headless-rpc' },
    reviewer: { model: 'm', transport: 'headless-rpc' },
    lead: { model: 'm', transport: 'pane' },
  }
  function sweep(factory) {
    const dir = mkdtempSync(join(tmpdir(), 'daemon-settle-transports-'))
    const paths = { dir, taskDir: join(dir, 'task'), returnsDir: join(dir, 'returns') }
    mkdirSync(paths.taskDir, { recursive: true }); mkdirSync(paths.returnsDir, { recursive: true })
    const logs = []
    try {
      const io = seatIo({ task: 'settle', members }, paths, dir, null, null, {}, {
        headlessRpcIo: factory, logLine: (_path, row) => logs.push(row),
      })
      return { rows: io.teardown(), logs }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
  let instantiated = 0
  const ok = sweep(() => {
    instantiated += 1
    return { teardown: () => ['builder', 'reviewer'].map((role) => ({
      role, transport: 'headless-rpc', outcome: 'unproven', reason: 'probe-unknown',
    })) }
  })
  assert.equal(instantiated, 1)
  assert.deepEqual(ok.rows.map(({ role }) => role).sort(), ['builder', 'reviewer'])
  assert.deepEqual(ok.logs.find(({ event }) => event === 'teardown-transports'), {
    at: ok.logs.find(({ event }) => event === 'teardown-transports').at,
    event: 'teardown-transports', channel: 'operational', declared: ['builder', 'reviewer'], transports: ['headless-rpc'],
    init_failed: [], seats: 2,
  })

  const failed = sweep(() => { throw new Error('rpc unavailable') })
  assert.deepEqual(failed.rows.map(({ role, transport, outcome, reason, why }) => ({ role, transport, outcome, reason, why })), [
    { role: 'builder', transport: 'headless-rpc', outcome: 'unproven', reason: 'teardown-threw', why: 'rpc unavailable' },
    { role: 'reviewer', transport: 'headless-rpc', outcome: 'unproven', reason: 'teardown-threw', why: 'rpc unavailable' },
  ])
  const failedLine = failed.logs.find(({ event }) => event === 'teardown-transports')
  assert.deepEqual(failedLine.init_failed, [{ transport: 'headless-rpc', why: 'rpc unavailable' }])
  assert.deepEqual(failedLine.declared, ['builder', 'reviewer'])
  assert.deepEqual(failedLine.transports, [])
})

test('settleSeatTeardown accounts for every record verdict', () => {
  const rows = () => [
    { role: 'planner', outcome: 'proven', reason: 'exit-marker' },
    { role: 'builder', outcome: 'proven', reason: 'exit-marker' },
  ]
  const logs = []
  const falseVerdict = settleSeatTeardown({ teardown: rows, log: (row) => logs.push(row), emit: (event) => event.role !== 'builder' })
  assert.deepEqual({ seats: falseVerdict.seats, recorded: falseVerdict.recorded, record_failed: falseVerdict.record_failed },
    { seats: 2, recorded: 1, record_failed: 1 })
  assert.ok(logs.some(({ event, role }) => event === 'seat-teardown-record-failed' && role === 'builder'))
  assert.equal(logs.find(({ event }) => event === 'seat-teardown-sweep').record_failed, 1)

  const undefinedVerdict = settleSeatTeardown({ teardown: rows, log: () => {}, emit: () => undefined })
  assert.deepEqual({ recorded: undefinedVerdict.recorded, record_failed: undefinedVerdict.record_failed }, { recorded: 0, record_failed: 2 })
  const throwingVerdict = settleSeatTeardown({ teardown: rows, log: () => {}, emit: () => { throw new Error('ledger down') } })
  assert.deepEqual({ recorded: throwingVerdict.recorded, record_failed: throwingVerdict.record_failed }, { recorded: 0, record_failed: 2 })
  const noEmitter = settleSeatTeardown({ teardown: rows, log: () => {} })
  assert.deepEqual({ seats: noEmitter.seats, recorded: noEmitter.recorded, record_failed: noEmitter.record_failed }, { seats: 2, recorded: 0, record_failed: 0 })
})

test('emitAdapter returns a dropped seat-teardown verdict', () => {
  const emitter = { adwId: 'adw-settle', phaseTransition: () => ({ phase_id: null }), emit: () => false }
  const adapter = emitAdapter(emitter, { members: { builder: { transport: 'headless-rpc' } } })
  assert.equal(adapter({ kind: 'seat-teardown', role: 'builder', outcome: 'proven', reason: 'exit-marker' }), false)
})

test('one settle path is shared by both run entrypoints', () => {
  const child = readFileSync(join(HERE, 'child.mjs'), 'utf8')
  const crew = readFileSync(join(HERE, 'crew.mjs'), 'utf8')
  const seatIoSrc = readFileSync(join(HERE, 'seat-io.mjs'), 'utf8')
  const calls = (source) => /settleSeatTeardown\s*\(/.test(source)
  const sweeps = (source) => (source.match(/seat-teardown-sweep/g) || []).length
  assert.equal(calls(child), true)
  assert.equal(calls(crew), true)
  assert.equal(sweeps(seatIoSrc), 1)
  assert.equal(sweeps(child), 0)
  assert.equal(sweeps(crew), 0)
})

test('restart refuses to adopt a live pid that is not this daemon\'s child', async () => {
  const f = fixture()
  let next = null
  try {
    await f.d.start()
    const { run_id: run } = await f.d.enqueue({ crew_dir: f.crewDir })
    f.d.poll()
    await f.d.stop()
    f.procStart.set(900, 'Thu Jan  1 00:00:00 2099')
    next = daemon({ root: f.root, deps: f.deps })
    await next.start()
    next.poll()
    const records = readFileSync(join(f.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(records.some((record) => record.run_id === run && record.kind === 'adopted'), false)
    assert.equal(next.state({ run }).state, 'done')
    assert.equal(next.result({ run }).envelope.details.escalation.why, 'orphaned-on-restart')
  } finally {
    await f.d.stop()
    await next?.stop()
    f.cleanup()
  }
})

test('restart still adopts the child it can identify', async () => {
  const f = fixture()
  let next = null
  try {
    await f.d.start()
    const { run_id: run } = await f.d.enqueue({ crew_dir: f.crewDir })
    f.d.poll()
    await f.d.stop()
    const count = f.forks.length
    next = daemon({ root: f.root, deps: f.deps })
    await next.start()
    next.poll()
    const records = readFileSync(join(f.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(f.forks.length, count)
    assert.equal(next.state({ run }).state, 'working')
    assert.equal(records.some((record) => record.run_id === run && record.kind === 'adopted'), true)
  } finally {
    await f.d.stop()
    await next?.stop()
    f.cleanup()
  }
})

test('enqueue refuses while the daemon is stopping', async () => {
  const f = fixture()
  try {
    await f.d.start()
    const forkCount = f.forks.length
    const stopping = f.d.stop()
    assert.throws(() => f.d.enqueue({ crew_dir: f.crewDir }), (err) => err.code === 'daemon-stopped')
    await stopping
    assert.throws(() => f.d.enqueue({ crew_dir: f.crewDir }), (err) => err.code === 'daemon-stopped')
    assert.equal(f.forks.length, forkCount)
    const registry = join(f.root, 'runs.jsonl')
    if (existsSync(registry)) {
      const records = readFileSync(registry, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
      assert.equal(records.some((record) => record.kind === 'enqueued'), false)
    }
  } finally {
    await f.d.stop()
    f.cleanup()
  }
})

test('a never-started daemon still admits an enqueue', async () => {
  const f = fixture()
  try {
    const result = f.d.enqueue({ crew_dir: f.crewDir })
    assert.equal(typeof result.run_id, 'string')
    assert.equal(f.forks.length, 1)
  } finally {
    await f.d.stop()
    f.cleanup()
  }
})
