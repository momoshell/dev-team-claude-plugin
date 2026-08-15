import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
  openSync, readSync, fstatSync, closeSync, statSync, utimesSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  daemon, deriveState, normalizeEvent, PANE_TRANSPORT, RUN_STATES, EVENT_KINDS, DAEMON_COMMANDS, DEFAULT_CONCURRENCY,
} from './daemon.mjs'
import { runChild } from './child.mjs'
import { DEFAULT_TRANSPORT } from './realio.mjs'
import { splitFrames } from './headless-rpc.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DAEMON_SOURCE = readFileSync(join(HERE, 'daemon.mjs'), 'utf8')
const CHILD_SOURCE = readFileSync(join(HERE, 'child.mjs'), 'utf8')
const sourceCode = (source) => source.split('\n').filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*')).join('\n')
const DAEMON_CODE = sourceCode(DAEMON_SOURCE)
const CHILD_CODE = sourceCode(CHILD_SOURCE)
const DRIVE_MODULE = ['drive', 'mjs'].join('.')
const REALIO_MODULE = ['realio', 'mjs'].join('.')

function fixture({ roles = ['planner', 'builder', 'reviewer'], transport = 'headless-json', agent, feedRetention, bootCrewDir, spawnSync: spawnImpl, concurrency } = {}) {
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
    setInterval: () => null,
    clearInterval: () => {},
    feedRetention,
  }
  const d = daemon({ root, concurrency, deps })
  return {
    dir, root, crewDir, taskDir, returnsDir, taskReturn, brief, reportedCrewDir, d, deps, forks, boots, alive,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
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
  // The allowlist admits two first-party modules: the server-side rpc helper,
  // and the slug leaf. A leaf is only safe while it stays a leaf, so the next
  // assertion pins that — otherwise allowlisting it would be a hole in the
  // firewall rather than an exception to it.
  assert.equal(
    imports.every((specifier) => specifier?.startsWith('node:') || specifier === './headless-rpc.mjs' || specifier === './slug.mjs'),
    true,
    'every daemon import, including side-effect imports, must be a node builtin, the server-side rpc helper, or the slug leaf',
  )
  // Mutation killed: someone adding an import to slug.mjs — which would pull
  // that dependency into the server process through the allowlisted edge.
  const slugCode = readFileSync(new URL('./slug.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(slugCode, /^\s*import[\s(]/m, 'crew/slug.mjs must stay import-free: the daemon allowlists it as a LEAF')
  assert.equal(DAEMON_CODE.includes(DRIVE_MODULE), false, 'daemon must not name the driver module')
  assert.equal(DAEMON_CODE.includes(REALIO_MODULE), false, 'daemon must not name the real io module')
  const dynamicImports = DAEMON_CODE.match(/\bimport\s*\(/g) || []
  const adapterImport = ['import', '(pathToFileURL(file).href)'].join('')
  assert.equal(DAEMON_CODE.includes(adapterImport), true, 'daemon must retain its existing computed adapter import')
  assert.equal(dynamicImports.length, 1, 'daemon must reject every dynamic import beyond its existing adapter loader')
  assert.doesNotMatch(DAEMON_CODE, /export\s+\*\s+from/, 'daemon must not re-export a runner through a barrel')
})

test('the child entry owns the runner imports', () => {
  assert.equal(CHILD_CODE.includes(`'./${DRIVE_MODULE}'`), true, 'child entry must import the driver')
  assert.equal(CHILD_CODE.includes(`'./${REALIO_MODULE}'`), true, 'child entry must import real io')
  assert.equal(CHILD_CODE.includes('--run-child'), true, 'child entry must own the run-child guard')
})

test('enqueue forks the child entry module', async () => {
  await each(async (f) => {
    await f.d.enqueue({ crew_dir: f.crewDir })
    assert.equal(f.forks[0][0].endsWith('child.mjs'), true, 'enqueue must fork crew/child.mjs')
    assert.equal(f.forks[0][1][0], '--run-child', 'child fork must retain the run-child argv flag')
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

test('the daemon pane constant does not drift from realio DEFAULT_TRANSPORT', () => {
  assert.equal(PANE_TRANSPORT, DEFAULT_TRANSPORT, 'daemon pane transport must stay pinned to realio DEFAULT_TRANSPORT')
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
    await new Promise((resolve) => setTimeout(resolve, 30))
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

test('re-enqueueing a settled crew dir refuses by name and forks nothing', async () => {
  await each(async (f) => {
    const first = f.d.enqueue({ crew_dir: f.crewDir }).run_id
    writeFileSync(f.taskReturn, JSON.stringify({ status: 'escalation' }))
    f.d.poll()
    const before = f.d.result({ run: first })
    const beforeBytes = readFileSync(f.taskReturn)
    assert.equal(before.outcome, 'escalation')
    assert.throws(() => f.d.enqueue({ crew_dir: f.crewDir }), (err) => {
      assert.equal(err.code, 'crew-settled')
      assert.match(err.message, /boot/i)
      assert.match(err.message, new RegExp(f.crewDir.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&')))
      return true
    })
    assert.equal(f.forks.length, 1)
    assert.equal(f.d.list().length, 1)
    assert.deepEqual(f.d.result({ run: first }), before)
    assert.equal(readFileSync(f.taskReturn).equals(beforeBytes), true)
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

test('the RV3-1 sequence leaves one child per crew dir', async () => {
  await each(async (f) => {
    const shared = join(f.dir, 'checkout-shared')
    const secondCrew = mintCrew(f, { name: 'crew-b', checkout: shared })
    const first = f.d.enqueue({ crew_dir: f.crewDir, checkout: shared }).run_id
    writeFileSync(f.taskReturn, JSON.stringify({ status: 'done' }))
    f.d.poll()
    assert.throws(() => f.d.enqueue({ crew_dir: f.crewDir }), (err) => err.code === 'crew-settled')
    const second = f.d.enqueue({ crew_dir: secondCrew.crewDir }).run_id
    assert.equal(f.forks.length, 2)
    const spec = JSON.parse(f.forks[1][1][1])
    assert.equal(spec.crew_dir, secondCrew.crewDir)
    assert.equal(f.d.state({ run: first }).state, 'done')
    assert.equal(f.d.state({ run: second }).state, 'working')
    const records = readFileSync(join(f.root, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(records.filter((record) => record.run_id === first && record.kind === 'started').length, 1)
  })
})

test('a queued run that acquires an envelope settles instead of forking', async () => {
  await each(async (f) => {
    const secondCrew = mintCrew(f, { name: 'crew-b', checkout: join(f.dir, 'checkout-b') })
    f.d.enqueue({ crew_dir: f.crewDir })
    const queued = f.d.enqueue({ crew_dir: secondCrew.crewDir }).run_id
    writeFileSync(secondCrew.taskReturn, JSON.stringify({ status: 'done' }))
    writeFileSync(f.taskReturn, JSON.stringify({ status: 'done' }))
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
    writeFileSync(f.taskReturn, JSON.stringify({ status: 'done' }))
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
    f.d.enqueue({ crew_dir: f.crewDir })
    const second = f.d.enqueue({ crew_dir: secondCrew.crewDir }).run_id
    const third = f.d.enqueue({ crew_dir: thirdCrew.crewDir }).run_id
    writeFileSync(f.taskReturn, JSON.stringify({ status: 'done' }))
    f.d.poll()
    assert.equal(f.d.state({ run: second }).state, 'working')
    assert.equal(f.d.state({ run: third }).state, 'queued')
  }, { concurrency: 1 })
})

test('at most one running run per checkout', async () => {
  await each(async (f) => {
    const shared = join(f.dir, 'checkout-shared')
    const secondCrew = mintCrew(f, { name: 'crew-b', checkout: shared })
    f.d.enqueue({ crew_dir: f.crewDir, checkout: shared })
    const queued = f.d.enqueue({ crew_dir: secondCrew.crewDir }).run_id
    assert.equal(f.forks.length, 1)
    assert.equal(f.d.state({ run: queued }).state, 'queued')
    writeFileSync(f.taskReturn, JSON.stringify({ status: 'done' }))
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
    writeFileSync(f.taskReturn, JSON.stringify({ status: 'escalation' }))
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
    writeFileSync(f.taskReturn, JSON.stringify(envelope)); f.d.poll()
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
    writeFileSync(join(dir, 'stream.jsonl'), `${JSON.stringify({ type: 'result', terminal_reason: 'done' })}\n`, { flag: 'a' }); writeFileSync(join(dir, 'exit'), '0')
    f.d.poll(); assert.equal(f.d.state({ run, worker: 'd1' }).state, 'done')
  })
})

// 11. A settled escalation is still state=done, not success.
test('idle is not success: escalation envelope still yields done only', async () => {
  await each(async (f) => {
    await f.d.start(); const { run_id: run } = await f.d.enqueue({ crew_dir: f.crewDir }); f.d.poll()
    writeFileSync(f.taskReturn, JSON.stringify({ status: 'escalation' })); f.d.poll()
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
    await new Promise((resolve) => setTimeout(resolve, 20)); socket.destroy(); await new Promise((resolve) => setTimeout(resolve, 20))
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

// 14. A dead child with no envelope is honestly orphaned.
test('restart orphans a dead child with no envelope', async () => {
  const f = fixture()
  try {
    await f.d.start(); const { run_id: run } = await f.d.enqueue({ crew_dir: f.crewDir }); await f.d.stop(); f.alive.delete(900)
    const next = daemon({ root: f.root, deps: f.deps }); await next.start(); next.poll()
    assert.equal(next.state({ run }).state, 'dead'); assert.deepEqual(next.result({ run }), { outcome: null, envelope: null, source: null, reason: 'orphaned-on-restart' }); assert.match(readFileSync(join(f.root, 'runs.jsonl'), 'utf8'), /"orphaned"/)
    await next.stop()
  } finally { f.cleanup() }
})

// 15. The durable envelope wins even when the driver pid is gone.
test('restart settles a dead child from its envelope', async () => {
  const f = fixture()
  try {
    await f.d.start(); const { run_id: run } = await f.d.enqueue({ crew_dir: f.crewDir }); await f.d.stop(); f.alive.delete(900)
    const envelope = { status: 'done', summary: 'survived' }; writeFileSync(f.taskReturn, JSON.stringify(envelope))
    const next = daemon({ root: f.root, deps: f.deps }); await next.start(); next.poll()
    assert.equal(next.state({ run }).state, 'done'); assert.equal(next.result({ run }).outcome, 'done'); await next.stop()
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
    assert.throws(() => runChild({ crew_dir: pane.crewDir, task: 'x' }, { driveTask: () => ({ status: 'done' }), realIo: () => ({}) }), /pane.*builder/)
  } finally { pane.cleanup() }
  const lead = fixture({ roles: ['lead', 'planner', 'builder', 'reviewer'] })
  try {
    let seen
    runChild({ crew_dir: lead.crewDir, task: 'x' }, { driveTask: (ctx) => { seen = ctx; return { status: 'done' } }, realIo: () => ({}), preflight: false })
    assert.ok(seen); assert.equal(seen.roles.includes('lead'), false)
  } finally { lead.cleanup() }
})

// ChildProcess errors are asynchronous and must remain inside the daemon.
test('asynchronous child spawn errors orphan only their run', async () => {
  await each(async (f) => {
    let onError
    f.deps.fork = () => ({ pid: 901, on(event, fn) { if (event === 'error') onError = fn }, unref() {} })
    f.d = daemon({ root: f.root, deps: f.deps })
    await f.d.start(); const { run_id: run } = f.d.enqueue({ crew_dir: f.crewDir });
    assert.equal(typeof onError, 'function'); onError(Error('EAGAIN'))
    assert.equal(f.d.state({ run }).state, 'dead'); assert.equal(f.d.result({ run }).reason.startsWith('child-spawn-error'), true)
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
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(typeof onError, 'function')
    onError(Error('EAGAIN'))
    await new Promise((resolve) => setTimeout(resolve, 20))
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
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(typeof onExit, 'function')
    onExit(1, null)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const observations = frames.filter((frame) => frame.event || frame.end)
    assert.equal(observations.at(-1)?.end?.reason, 'orphaned')
    const died = observations.findIndex((frame) => frame.event?.kind === 'died')
    assert.ok(died >= 0)
    assert.ok(died < observations.findIndex((frame) => frame.end))
    assert.equal(f.d.state({ run }).state, 'dead')
    socket.destroy()
  } finally { await f.d.stop(); f.cleanup() }
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
    await new Promise((resolve) => setTimeout(resolve, 20))
    f.alive.delete(900)
    f.d.poll()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const observations = frames.filter((frame) => frame.event || frame.end)
    assert.equal(observations.at(-1)?.end?.reason, 'orphaned')
    const died = observations.findIndex((frame) => frame.event?.kind === 'died')
    assert.ok(died >= 0)
    assert.ok(died < observations.findIndex((frame) => frame.end))
    assert.equal(f.d.state({ run }).state, 'dead')
    socket.destroy()
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
    writeFileSync(f.taskReturn, JSON.stringify({ status: 'done' }))
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
  try {
    f.deps.fork = () => ({ on() {}, unref() {} })
    f.d = daemon({ root: f.root, deps: f.deps })
    await f.d.start()
    const run = 'pidless-run'
    assert.throws(() => f.d.enqueue({ crew_dir: f.crewDir, run_id: run }), (err) => err.code === 'child-spawn-error')
    await f.d.stop()
    const next = daemon({ root: f.root, deps: f.deps }); await next.start(); next.poll()
    assert.equal(next.state({ run }).state, 'dead'); assert.equal(next.result({ run }).reason, 'orphaned-on-restart'); await next.stop()
  } finally { f.cleanup() }
})

test('runChild gives a task_return override precedence over crew.json', () => {
  const f = fixture(); const override = join(f.returnsDir, 'override.json')
  try {
    runChild({ crew_dir: f.crewDir, task_return: override, task: 'x' }, { driveTask: () => ({ status: 'done' }), realIo: () => ({}), preflight: false })
    assert.equal(JSON.parse(readFileSync(override, 'utf8')).status, 'done'); assert.equal(existsSync(f.taskReturn), false)
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
// runChild injected driveTask/realIo, which under the old polarity disabled
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

// The opt-out must be explicit, and must be the ONLY way to skip the block.
// Both arms are needed: the first distinguishes the fixed polarity from the
// original (`harness`-derived) one, under which injecting a driver silently
// disabled every guard. The second proves the opt-out still works.
test('injecting a driver does not skip preflight; only an explicit opt-out does', () => {
  const strict = fixture()
  try {
    // Driver injected, NO opt-out: preflight must still refuse the missing brief.
    assert.throws(
      () => runChild({ crew_dir: strict.crewDir, task: 'x' }, { driveTask: () => ({ status: 'done' }), realIo: () => ({}), execSync: () => '' }),
      /--brief-file/,
      'a caller that injects a driver must still be preflighted',
    )
  } finally { strict.cleanup() }

  const opted = fixture()
  try {
    runChild({ crew_dir: opted.crewDir, task: 'x' }, { driveTask: () => ({ status: 'done' }), realIo: () => ({}), preflight: false })
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
    writeFileSync(bounded.taskReturn, JSON.stringify({ status: 'done' }))
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
    writeFileSync(bounded.taskReturn, JSON.stringify({ status: 'done' }))
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
    writeFileSync(bounded.taskReturn, JSON.stringify({ status: 'done' }))
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
    await new Promise((resolve) => setTimeout(resolve, 20))
    writeFileSync(f.taskReturn, JSON.stringify({ status: 'done' }))
    f.d.poll()
    await new Promise((resolve) => setTimeout(resolve, 20))
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
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(f.d.subscribers(), [{ id: 'inspect', run_id: run }])
    socket.write(`${JSON.stringify({ id: 'untail', cmd: 'untail', params: { run } })}\n`)
    await new Promise((resolve) => setTimeout(resolve, 20))
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
    writeFileSync(f.taskReturn, JSON.stringify({ status: 'done' }))
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
