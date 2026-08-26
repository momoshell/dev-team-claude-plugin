import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { daemon } from './daemon.mjs'
import { attachVerb, commitIssues, connect, formatRows, main, parseArgs, pendingVerb, runVerb, terminalRunLine } from './factoryctl.mjs'
import { scratchDir } from '../test/helpers.mjs'

const LEDGER_SANDBOX = mkdtempSync(join(tmpdir(), 'b136-factoryctl-ledger-'))
const LEDGER_SANDBOX_PREVIOUS = process.env.DEVTEAM_LEDGER_DIR
process.env.DEVTEAM_LEDGER_DIR = LEDGER_SANDBOX // #477: module scope, before any test runs
after(() => {
  if (LEDGER_SANDBOX_PREVIOUS === undefined) delete process.env.DEVTEAM_LEDGER_DIR
  else process.env.DEVTEAM_LEDGER_DIR = LEDGER_SANDBOX_PREVIOUS
  rmSync(LEDGER_SANDBOX, { recursive: true, force: true })
})

function mintCrew(root, name) {
  const crewDir = join(root, name)
  const returnsDir = join(crewDir, 'returns')
  mkdirSync(returnsDir, { recursive: true })
  writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({
    task: 'demo-task', checkout: process.cwd(), task_return: 'returns/task.json',
    roles: ['builder'], members: { builder: { transport: 'headless-json' } },
  }))
  writeFileSync(join(crewDir, 'journal.jsonl'), '')
  return { crewDir }
}

function fixture({ fork: forkImpl = null, spawnSync: spawnImpl = null, bootCrewDir = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'factoryctl-'))
  const { crewDir } = mintCrew(root, 'crew')
  const brief = join(root, 'brief.md')
  const reportedCrewDir = bootCrewDir || join(root, 'reported-tier-crew')
  writeFileSync(brief, '# brief\n')
  const boots = []
  const defaultSpawnSync = (_command, argv, options) => {
    const task = argv[argv.indexOf('--task') + 1]
    const checkout = argv[argv.indexOf('--checkout') + 1]
    const taskDir = join(reportedCrewDir, 'task')
    const returns = join(reportedCrewDir, 'returns')
    mkdirSync(taskDir, { recursive: true }); mkdirSync(returns, { recursive: true })
    const returnedTask = join(returns, 'task.json')
    writeFileSync(join(reportedCrewDir, 'crew.json'), JSON.stringify({
      task, checkout: checkout || options.cwd, task_return: returnedTask,
      roles: ['builder'], members: { builder: { transport: 'headless-json' } },
    }))
    writeFileSync(join(reportedCrewDir, 'journal.jsonl'), '')
    return { status: 0, stdout: JSON.stringify({ workspace_id: null, members: {}, task_dir: taskDir, crew_json: join(reportedCrewDir, 'crew.json') }), stderr: '' }
  }
  let uuid = 0
  const d = daemon({
    root,
    deps: {
      fork: forkImpl || (() => ({ pid: 4242, on() { return this }, unref() {} })),
      spawnSync(...args) { boots.push(args); return (spawnImpl || defaultSpawnSync)(...args) },
      kill: (_pid, signal) => { if (signal !== 0) return true },
      now: () => Date.now(), uuid: () => `run-${++uuid}`,
      setInterval: () => null, clearInterval: () => {},
    },
  })
  return { root, crewDir, brief, boots, reportedCrewDir, daemon: d, mintCrew: (name) => mintCrew(root, name), cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

async function withDaemon(name, fn, options = {}) {
  test(name, async () => {
    const f = fixture(options)
    try {
      await f.daemon.start()
      await fn(f)
    } finally {
      await f.daemon.stop()
      f.cleanup()
    }
  })
}

async function invoke(f, argv, extra = {}) {
  let stdout = ''
  let stderr = ''
  const code = await main([...argv, '--root', f.root], {
    ...extra,
    stdout: (text) => { stdout += text },
    stderr: (text) => { stderr += text },
  })
  return { code, stdout, stderr }
}

async function waitFor(check, timeout = 1000) {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for factoryctl condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function enqueue(f, crewDir = f.crewDir) {
  const result = await invoke(f, ['run', '--crew-dir', crewDir, '--brief', f.brief])
  assert.equal(result.code, 0)
  return { result, runId: JSON.parse(result.stdout).run_id }
}

function returnFor(f, runId, crewDir = f.crewDir) { return join(crewDir, 'returns', `${runId}.task.json`) }

function pendingLane(root, name, text, { task = name, archived = false, settled = true } = {}) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'crew.json'), '{}')
  writeFileSync(join(dir, 'journal.jsonl'), '')
  if (text !== null) writeFileSync(join(dir, 'run.log'), text)
  return { id: `repo/${name}`, repo: 'repo', task, dir, journal: join(dir, 'journal.jsonl'), taskDir: join(dir, 'task'), settled, archived, archivedAt: archived ? 'stamp' : null }
}

function pendingSpawn({ branches = {}, merged = new Set(), remoteBranches = new Set(), messages = {}, gh = {} } = {}) {
  const calls = []
  const spawnSync = (command, argv, options) => {
    calls.push({ command, argv: [...argv], options })
    if (command === 'gh') {
      const branch = argv[argv.indexOf('--head') + 1]
      const response = gh[branch] ?? []
      if (typeof response === 'function') return response(command, argv, options)
      if (response && typeof response === 'object' && !Array.isArray(response)) return response
      return { status: 0, stdout: JSON.stringify(response), stderr: '' }
    }
    if (command !== 'git') return { status: 127, stdout: '', stderr: 'unknown command' }
    const args = argv.slice(2)
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'origin/main', stderr: '' }
    if (args[0] === 'remote') return { status: 0, stdout: 'origin', stderr: '' }
    if (args[0] === 'cat-file') {
      const commit = String(args[2] || '').replace(/\^\{commit\}$/, '')
      return { status: Object.prototype.hasOwnProperty.call(branches, commit) || merged.has(commit) ? 0 : 1, stdout: '', stderr: '' }
    }
    if (args[0] === 'for-each-ref') {
      const commit = args[2]
      const branch = branches[commit]
      return { status: 0, stdout: branch ? `${branch}\nmain\n` : 'main\n', stderr: '' }
    }
    if (args[0] === 'merge-base') return { status: merged.has(args[2]) ? 0 : 1, stdout: '', stderr: '' }
    if (args[0] === 'show-ref') {
      const ref = args.at(-1) || ''
      const branch = ref.replace(/^refs\/remotes\/origin\//, '')
      return { status: remoteBranches.has(branch) ? 0 : 1, stdout: '', stderr: '' }
    }
    if (args[0] === 'log') return { status: 0, stdout: messages[args.at(-1)] || '', stderr: '' }
    return { status: 1, stdout: '', stderr: 'unhandled git fixture call' }
  }
  return { spawnSync, calls }
}

function pendingUnit({ specs, branches = {}, merged = new Set(), remoteBranches = new Set(), messages = {}, gh = {} } = {}) {
  const root = scratchDir('factoryctl-pending-')
  const laneRoot = join(root, 'lanes')
  const repo = join(root, 'repo')
  mkdirSync(laneRoot, { recursive: true }); mkdirSync(repo, { recursive: true })
  const lanes = (specs || []).map((spec) => pendingLane(laneRoot, spec.name, spec.text, spec.options))
  const d = pendingSpawn({ branches, merged, remoteBranches, messages, gh })
  let stdout = ''
  const result = pendingVerb({ _: ['pending'], json: true, 'crew-root': root, repo }, {
    lanes: () => lanes,
    readFileSync: (...args) => readFileSync(...args),
    statSync: () => ({ mtime: new Date('2026-08-26T00:00:00.000Z') }),
    spawnSync: d.spawnSync,
    stdout: (text) => { stdout += text },
    cwd: () => repo,
  })
  return { root, laneRoot, repo, lanes, result, output: JSON.parse(stdout), calls: d.calls }
}

function treeSnapshot(root) {
  const entries = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { entries.push([path, 'directory']); walk(path) }
      else entries.push([path, `file:${readFileSync(path).toString('base64')}`])
    }
  }
  walk(root)
  return entries
}

test('run forwards --variant, --files-in-scope, and --lane to enqueue and omits them when absent', async () => {
  const f = fixture()
  try {
    const sent = []
    const deps = { call: (cmd, params) => { sent.push({ cmd, params }); return { run_id: 'run-1' } }, stdout: () => {}, cwd: () => f.root }
    await runVerb(parseArgs(['run', '--crew-dir', f.crewDir, '--brief', f.brief, '--variant', 'repair', '--files-in-scope', 'a.mjs, b.mjs', '--lane', 'lane-cmd']), deps)
    assert.equal(sent.at(-1).params.variant, 'repair')
    assert.deepEqual(sent.at(-1).params.files_in_scope, ['a.mjs', 'b.mjs'])
    assert.equal(sent.at(-1).params.lane, 'lane-cmd')
    await runVerb(parseArgs(['run', '--crew-dir', f.crewDir, '--brief', f.brief]), deps)
    assert.equal(Object.prototype.hasOwnProperty.call(sent.at(-1).params, 'variant'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(sent.at(-1).params, 'files_in_scope'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(sent.at(-1).params, 'lane'), false)
  } finally { f.cleanup() }
})

test('run refuses an inherited variant without --files-in-scope before calling the daemon', async () => {
  const f = fixture()
  try {
    const sent = []
    const deps = { call: (cmd, params) => { sent.push({ cmd, params }); return { run_id: 'run-1' } }, stdout: () => {}, cwd: () => f.root }
    await assert.rejects(
      runVerb(parseArgs(['run', '--crew-dir', f.crewDir, '--brief', f.brief, '--variant', 'repair', '--lane', 'lane-cmd']), deps),
      /files-in-scope/,
    )
    assert.equal(sent.length, 0)
  } finally { f.cleanup() }
})

test('run refuses a --variant with no value', async () => {
  const f = fixture()
  try {
    let touched = false
    const net = { connect: () => { touched = true; throw new Error('socket should not be touched') } }
    const result = await invoke(f, ['run', '--crew-dir', f.crewDir, '--brief', f.brief, '--variant'], { net })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /--variant/)
    assert.equal(touched, false)
  } finally { f.cleanup() }
})

withDaemon('run enqueues against the daemon and prints the run id', async (f) => {
  // Pins run as a socket enqueue and not as a locally invented run record.
  const { runId } = await enqueue(f)
  assert.ok(runId)
  const row = f.daemon.list().find((run) => run.run_id === runId)
  assert.ok(row)
  assert.equal(row.crew_dir, f.crewDir)
})

withDaemon("run surfaces the daemon's refusal verbatim", async (f) => {
  // Pins the daemon's invalid-spec and run-active vocabulary instead of client aliases.
  const missingCrew = join(f.root, 'missing-crew')
  mkdirSync(missingCrew)
  const invalid = await invoke(f, ['run', '--crew-dir', missingCrew, '--brief', f.brief])
  assert.equal(invalid.code, 1)
  assert.match(invalid.stderr, new RegExp(`cannot read crew\\.json at ${missingCrew.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}`))
  assert.doesNotMatch(invalid.stderr, /conflict|duplicate|busy/i)

  await enqueue(f)
  const duplicate = await invoke(f, ['run', '--crew-dir', f.crewDir, '--brief', f.brief])
  assert.equal(duplicate.code, 1)
  assert.match(duplicate.stderr, new RegExp(`is already active for ${f.crewDir.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}`))
  assert.doesNotMatch(duplicate.stderr, /conflict|duplicate|busy/i)
})

withDaemon('run rejects a missing --crew-dir/--brief before touching the socket', async (f) => {
  // Pins client-side argument checks before connect, leaving the daemon untouched.
  let touched = false
  const net = { connect: () => { touched = true; throw new Error('socket should not be touched') } }
  const noCrew = await invoke(f, ['run', '--brief', f.brief], { net })
  assert.equal(noCrew.code, 1)
  assert.match(noCrew.stderr, /--crew-dir/)
  const noBrief = await invoke(f, ['run', '--crew-dir', f.crewDir], { net })
  assert.equal(noBrief.code, 1)
  assert.match(noBrief.stderr, /--brief/)
  assert.equal(touched, false)
})

withDaemon('run --tier sends tier, checkout, task and brief_file and prints the booted crew dir', async (f) => {
  const result = await invoke(f, ['run', '--brief', f.brief, '--tier', 'build', '--checkout', f.root, '--task', 'tier-task'])
  assert.equal(result.code, 0)
  const output = JSON.parse(result.stdout)
  assert.ok(output.run_id)
  assert.equal(output.crew_dir, f.reportedCrewDir)
  const row = f.daemon.list().find((run) => run.run_id === output.run_id)
  assert.equal(row?.crew_dir, f.reportedCrewDir)
  assert.equal(f.boots.length, 1)
  const [command, argv] = f.boots[0]
  const flat = [command, ...argv].map(String).join(' ')
  assert.match(flat, /--tier build/)
  assert.match(flat, /--checkout/)
  assert.match(flat, /--task tier-task/)
  assert.match(flat, /crew\.mjs/)
})

withDaemon('run --task defaults to the brief filename', async (f) => {
  const result = await invoke(f, ['run', '--brief', f.brief, '--tier', 'build', '--checkout', f.root])
  assert.equal(result.code, 0)
  assert.equal(f.boots.length, 1)
  const argv = f.boots[0][1]
  assert.equal(argv[argv.indexOf('--task') + 1], 'brief')
})

withDaemon('run refuses --crew-dir with --tier before touching the socket', async (f) => {
  let touched = false
  const net = { connect: () => { touched = true; throw new Error('socket should not be touched') } }
  const result = await invoke(f, ['run', '--brief', f.brief, '--crew-dir', f.crewDir, '--tier', 'build'], { net })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /--crew-dir/)
  assert.match(result.stderr, /--tier/)
  assert.equal(touched, false)
})

withDaemon('run --tier surfaces the daemon boot refusal verbatim', async (f) => {
  const result = await invoke(f, ['run', '--brief', f.brief, '--tier', 'nope', '--checkout', f.root, '--task', 'tier-task'])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /nope/)
  assert.match(result.stderr, /unknown tier/)
  assert.deepEqual(f.daemon.list(), [])
}, { spawnSync: () => ({ status: 1, stderr: 'error: unknown tier "nope" — valid tiers: mechanical, build, judge\n' }) })

withDaemon("ls lists the daemon's runs with their daemon-derived state", async (f) => {
  // Pins STATE to the daemon's list projection rather than a client lifecycle guess.
  const { runId } = await enqueue(f)
  const listed = await invoke(f, ['ls'])
  assert.equal(listed.code, 0)
  assert.match(listed.stdout, new RegExp(runId))
  assert.match(listed.stdout, /working/)
})

withDaemon('ls never reports an outcome for an unsettled run', async (f) => {
  // Pins an unsettled result to a visibly empty outcome cell, never an implied success.
  const { runId } = await enqueue(f)
  const json = await invoke(f, ['ls', '--json'])
  assert.equal(json.code, 0)
  const rows = JSON.parse(json.stdout)
  assert.equal(rows.find((row) => row.run_id === runId).outcome, null)
  const table = await invoke(f, ['ls'])
  const row = table.stdout.split('\n').find((line) => line.includes(runId))
  const residue = row.replace(runId, '').replace('demo-task', '').replace('working', '')
  assert.doesNotMatch(residue, /[A-Za-z]/)
})

withDaemon('a settled ESCALATION shows as done with no success implied', async (f) => {
  // Pins settled escalation as done plus result-derived escalation, not success from state.
  const { runId } = await enqueue(f)
  writeFileSync(returnFor(f, runId), JSON.stringify({ status: 'escalation' }))
  f.daemon.poll()
  const listed = await invoke(f, ['ls'])
  assert.equal(listed.code, 0)
  assert.match(listed.stdout, new RegExp(`${runId}.*done.*escalation`))
  assert.equal(f.daemon.state({ run: runId }).state, 'done')
  assert.doesNotMatch(listed.stdout, /success|succeeded|\bok\b|passed|complete/i)
})

test('both verbs fail clearly with no daemon listening', async () => {
  // Pins absent-daemon guidance for both verbs without silently starting one.
  const f = fixture()
  try {
    const run = await invoke(f, ['run', '--crew-dir', f.crewDir, '--brief', f.brief])
    const ls = await invoke(f, ['ls'])
    for (const result of [run, ls]) {
      assert.equal(result.code, 1)
      assert.match(result.stderr, /no crew daemon is listening/)
      assert.match(result.stderr, new RegExp(f.root.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&') + '/daemon\\.sock'))
      assert.match(result.stderr, /crew\/daemon\.mjs/)
    }
  } finally { f.cleanup() }
})

test('a stale socket file is the same clear refusal, not a stack trace', async () => {
  // Pins ENOTSOCK/ECONNREFUSED normalization instead of exposing a transport stack trace.
  const f = fixture()
  try {
    writeFileSync(join(f.root, 'daemon.sock'), 'not a socket')
    const result = await invoke(f, ['ls'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /no crew daemon is listening/)
    assert.match(result.stderr, /crew\/daemon\.mjs/)
    assert.doesNotMatch(result.stderr, /Error:\s+(?:ENOTSOCK|ECONNREFUSED)/)
  } finally { f.cleanup() }
})

test('formatRows renders an absent outcome as an empty cell', () => {
  // Pins the pure table renderer's null outcome as padding, not idle or success.
  const text = formatRows([
    { run_id: 'runalpha', task: 'demotask', state: 'working', outcome: null },
    { run_id: 'runbeta', task: 'demotask', state: 'done', outcome: 'escalation' },
  ])
  const lines = text.split('\n')
  assert.match(lines[0], /^RUN\s+STATE\s+OUTCOME\s+TASK$/)
  assert.match(lines[1], /runalpha/)
  assert.match(lines[2], /runbeta.*done.*escalation/)
  const residue = lines[1].replace(/runalpha|demotask|working/g, '')
  assert.doesNotMatch(residue, /[A-Za-z]/)
})

withDaemon("attach streams a live run's normalized events", async (f) => {
  const { runId } = await enqueue(f)
  const session = await connect(join(f.root, 'daemon.sock'))
  const controller = new AbortController()
  let stdout = ''
  let stderr = ''
  const running = attachVerb(parseArgs(['attach', runId]), {
    connection: session,
    signal: controller.signal,
    stdout: (text) => { stdout += text },
    stderr: (text) => { stderr += text },
  })
  try {
    await waitFor(() => f.daemon.subscribers().length === 1)
    writeFileSync(join(f.crewDir, 'journal.jsonl'), `${JSON.stringify({ headless_outcome: 'ok', role: 'builder' })}\n`, { flag: 'a' })
    f.daemon.poll()
    await waitFor(() => stdout.includes('"kind":"terminal-result"'))
    controller.abort()
    const result = await running
    assert.equal(result.reason, 'interrupted')
    const events = stdout.trim().split('\n').map((line) => JSON.parse(line))
    assert.ok(events.some((event) => event.kind === 'started'))
    assert.ok(events.some((event) => event.kind === 'terminal-result'))
    assert.match(stderr, /attach ended: interrupted/)
  } finally { await session.close() }
})

withDaemon('attach on a settled run prints the retained window and returns', async (f) => {
  const { runId } = await enqueue(f)
  writeFileSync(returnFor(f, runId), JSON.stringify({ status: 'done' }))
  f.daemon.poll()
  const result = await invoke(f, ['attach', runId])
  assert.equal(result.code, 0)
  const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
  assert.ok(events.some((event) => event.kind === 'started'))
  assert.match(result.stderr, /attach ended: run .* settled/)
})

withDaemon('attach projects pending terminal input before the state exit', async (f) => {
  const { runId } = await enqueue(f)
  writeFileSync(join(f.crewDir, 'journal.jsonl'), `${JSON.stringify({ headless_outcome: 'ok', role: 'builder' })}\n`, { flag: 'a' })
  writeFileSync(returnFor(f, runId), JSON.stringify({ status: 'done' }))
  const result = await invoke(f, ['attach', runId])
  assert.equal(result.code, 0)
  const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
  assert.ok(events.some((event) => event.kind === 'started'))
  assert.ok(events.some((event) => event.kind === 'terminal-result'))
})

test('attach on an unknown run refuses in the daemon vocabulary', async () => {
  const f = fixture()
  try {
    await f.daemon.start()
    const result = await invoke(f, ['attach', 'no-such-run'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /unknown run "no-such-run"/)
    assert.doesNotMatch(result.stderr, /missing|not attached|invalid/i)
  } finally { await f.daemon.stop(); f.cleanup() }
})

withDaemon('every attach exit path unsubscribes', async (f) => {
  const { runId } = await enqueue(f)
  const interrupted = await connect(join(f.root, 'daemon.sock'))
  const controller = new AbortController()
  const running = attachVerb(parseArgs(['attach', runId]), { connection: interrupted, signal: controller.signal, stdout: () => {}, stderr: () => {} })
  await waitFor(() => f.daemon.subscribers().length === 1)
  controller.abort()
  await running
  assert.deepEqual(f.daemon.subscribers(), [])
  await interrupted.close()

  writeFileSync(returnFor(f, runId), JSON.stringify({ status: 'done' }))
  f.daemon.poll()
  const settled = await connect(join(f.root, 'daemon.sock'))
  await attachVerb(parseArgs(['attach', runId]), { connection: settled, stdout: () => {}, stderr: () => {} })
  assert.deepEqual(f.daemon.subscribers(), [])
  await settled.close()

  // A settled crew dir is refused at admission (terminal-first), and this scenario only needs A run — not that crew dir again: what it is about
  // is attach unsubscribing when stdout throws EPIPE.
  const epipeCrew = f.mintCrew('crew-epipe')
  const { runId: pipeRun } = await enqueue(f, epipeCrew.crewDir)
  const pipe = await connect(join(f.root, 'daemon.sock'))
  const epipe = () => { const error = Error('closed'); error.code = 'EPIPE'; throw error }
  const closed = await attachVerb(parseArgs(['attach', pipeRun]), { connection: pipe, stdout: epipe, stderr: () => {} })
  assert.equal(closed.reason, 'stream-closed')
  assert.deepEqual(f.daemon.subscribers(), [])
  await pipe.close()
})

withDaemon('attach never implies an outcome for an unsettled run', async (f) => {
  const { runId } = await enqueue(f)
  const session = await connect(join(f.root, 'daemon.sock'))
  const controller = new AbortController()
  let text = ''
  const running = attachVerb(parseArgs(['attach', runId]), {
    connection: session,
    signal: controller.signal,
    stdout: (value) => { text += value },
    stderr: (value) => { text += value },
  })
  try {
    await waitFor(() => text.length > 0)
    controller.abort()
    await running
    const banned = /\bidle\b|\bok\b|success|succeeded|passed|complete/i
    assert.doesNotMatch(text, banned)
  } finally { await session.close() }
})

withDaemon('run refuses a pane-transport crew through the CLI', async (f) => {
  const paneDir = join(f.root, 'pane-crew')
  mkdirSync(join(paneDir, 'returns'), { recursive: true })
  writeFileSync(join(paneDir, 'crew.json'), JSON.stringify({
    task: 'pane-task', checkout: process.cwd(), task_return: 'returns/task.json',
    roles: ['builder'], members: { builder: { transport: 'pane' } },
  }))
  writeFileSync(join(paneDir, 'journal.jsonl'), '')
  const result = await invoke(f, ['run', '--crew-dir', paneDir, '--brief', f.brief])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /daemon run refuses pane transport for seat builder/)
  assert.deepEqual(f.daemon.list(), [])
})

test('attach receives a died event before spawn-error stream end', async () => {
  let onError = null
  const f = fixture({
    fork: () => ({
      pid: 4242,
      on(event, fn) { if (event === 'error') onError = fn; return this },
      unref() { return this },
    }),
  })
  try {
    await f.daemon.start()
    const { runId } = await enqueue(f)
    const session = await connect(join(f.root, 'daemon.sock'))
    let stdout = ''
    const running = attachVerb(parseArgs(['attach', runId]), {
      connection: session,
      stdout: (text) => { stdout += text },
      stderr: () => {},
    })
    await waitFor(() => f.daemon.subscribers().length === 1)
    assert.equal(typeof onError, 'function')
    onError(Error('EAGAIN'))
    const result = await running
    assert.equal(result.reason, 'orphaned')
    const events = stdout.trim().split('\n').map((line) => JSON.parse(line))
    const died = events.findIndex((event) => event.kind === 'died')
    assert.ok(died >= 0)
    assert.ok(events.some((event) => event.kind === 'started'))
    assert.deepEqual(f.daemon.subscribers(), [])
    await session.close()
  } finally { await f.daemon.stop(); f.cleanup() }
})

test('attach ends a live run when its child exits without an envelope', async () => {
  let onExit = null
  const f = fixture({
    fork: () => ({
      pid: 4242,
      on(event, fn) { if (event === 'exit') onExit = fn; return this },
      unref() { return this },
    }),
  })
  try {
    await f.daemon.start()
    const { runId } = await enqueue(f)
    const session = await connect(join(f.root, 'daemon.sock'))
    let stdout = ''
    const running = attachVerb(parseArgs(['attach', runId]), {
      connection: session,
      stdout: (text) => { stdout += text },
      stderr: () => {},
    })
    await waitFor(() => f.daemon.subscribers().length === 1)
    assert.equal(typeof onExit, 'function')
    onExit(1, null)
    const result = await running
    assert.equal(result.reason, 'orphaned')
    const events = stdout.trim().split('\n').map((line) => JSON.parse(line))
    assert.ok(events.some((event) => event.kind === 'started'))
    assert.ok(events.some((event) => event.kind === 'died'))
    assert.deepEqual(f.daemon.subscribers(), [])
    await session.close()
  } finally { await f.daemon.stop(); f.cleanup() }
})

test('send prints the daemon refusal and exits 1', async () => {
  const f = fixture()
  try {
    await f.daemon.start()
    const { runId } = await enqueue(f)
    const result = await invoke(f, ['send', runId, 'guidance'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /interjection/)
    assert.match(result.stderr, /headless-json/)
    assert.equal(result.stdout, '')
  } finally { await f.daemon.stop(); f.cleanup() }
})

test('send requires a run id and a message before connecting', async () => {
  const f = fixture()
  try {
    await f.daemon.start()
    let touched = false
    const net = { connect: () => { touched = true; throw new Error('socket should not be touched') } }
    const result = await invoke(f, ['send'], { net })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /send requires <run-id> and <message>/)
    assert.equal(touched, false)
  } finally { await f.daemon.stop(); f.cleanup() }
})

test('factoryctl usage lists every verb', async () => {
  const f = fixture()
  try {
    const result = await invoke(f, ['wat'])
    assert.equal(result.code, 2)
    assert.ok(result.stderr.includes('usage: factoryctl <run|ls|attach|send|pending>'), result.stderr)
  } finally { f.cleanup() }
})

test('terminalRunLine returns the last parseable status frame', () => {
  const text = `${JSON.stringify({ status: 'escalation', commit: null })}\nseat output that is not JSON\n${JSON.stringify({ status: 'done', commit: 'abc123' })}\n`
  assert.deepEqual(terminalRunLine(text), { status: 'done', commit: 'abc123' })
})

test('terminalRunLine returns null without a JSON status frame', () => {
  assert.equal(terminalRunLine('seat output\nnot json\n'), null)
  assert.equal(terminalRunLine('{"status": 1}\n{"status": null}\n'), null)
})

test('commitIssues reads Refs trailers and otherwise returns unknown', () => {
  assert.equal(commitIssues('feat: work\n\nRefs: #267, #268'), '#267 #268')
  assert.equal(commitIssues('feat: work\n\nReviewed-by: crew'), 'unknown')
})

test('pending lists a done lane with its branch, issue, done time and remote', () => {
  const sha = 'pending-commit'
  const f = pendingUnit({
    specs: [{ name: 'pending-lane', text: `${JSON.stringify({ status: 'done', commit: sha })}\n` }],
    branches: { [sha]: 'pending-lane' },
    remoteBranches: new Set(['pending-lane']),
    messages: { [sha]: 'feat: pending work\n\nRefs: #267, #268' },
  })
  const row = f.output.rows[0]
  assert.equal(f.output.rows.length, 1)
  assert.equal(row.lane, 'pending-lane')
  assert.equal(row.commit, sha)
  assert.equal(row.branch, 'pending-lane')
  assert.equal(row.issue, '#267 #268')
  assert.equal(row.done_at, '2026-08-26T00:00:00.000Z')
  assert.equal(row.remote, 'yes')
  assert.equal(row.pr, 'none')
  assert.equal(row.state, 'pending')
  assert.equal(row.reason, null)
})

test('an escalated lane naming a commit is not listed', () => {
  const sha = 'escalated-commit'
  const f = pendingUnit({
    specs: [{ name: 'escalated-lane', text: `${JSON.stringify({ status: 'escalation', commit: sha })}\n` }],
    branches: { [sha]: 'escalated-lane' },
  })
  assert.deepEqual(f.output.rows, [])
  assert.equal(f.output.counts.not_done, 1)
})

test('merged and open-PR lanes are published and not listed', () => {
  const mergedSha = 'merged-commit'
  const prSha = 'pr-commit'
  const f = pendingUnit({
    specs: [
      { name: 'merged-lane', text: `${JSON.stringify({ status: 'done', commit: mergedSha })}\n` },
      { name: 'pr-lane', text: `${JSON.stringify({ status: 'done', commit: prSha })}\n` },
    ],
    branches: { [mergedSha]: 'merged-lane', [prSha]: 'pr-lane' },
    merged: new Set([mergedSha]),
    gh: { 'pr-lane': [{ number: 42, state: 'OPEN' }] },
  })
  assert.deepEqual(f.output.rows, [])
  assert.equal(f.output.counts.published, 2)
})

test('an unavailable gh query leaves the pending row with an unknown PR', () => {
  const responses = [
    () => { throw new Error('gh interrupted') },
    { status: 1, stdout: '', stderr: 'gh unavailable' },
    { status: 0, stdout: 'not json', stderr: '' },
  ]
  for (const response of responses) {
    const sha = `gh-error-${responses.indexOf(response)}`
    const f = pendingUnit({
      specs: [{ name: 'pending-lane', text: `${JSON.stringify({ status: 'done', commit: sha })}\n` }],
      branches: { [sha]: 'pending-lane' },
      gh: { 'pending-lane': response },
    })
    assert.equal(f.output.rows.length, 1)
    assert.equal(f.output.rows[0].pr, 'unknown')
    assert.equal(f.output.rows[0].state, 'pending')
  }
})

test('an archived unreadable run is unknown while a live unsettled one is running', () => {
  const f = pendingUnit({
    specs: [
      { name: 'archived-lane', text: 'not a JSON frame\n', options: { task: 'archived-lane', archived: true, settled: true } },
      { name: 'running-lane', text: 'seat output\n', options: { settled: false } },
    ],
  })
  assert.equal(f.output.rows.length, 1)
  assert.equal(f.output.rows[0].lane, 'archived-lane')
  assert.equal(f.output.rows[0].state, 'unknown')
  assert.equal(f.output.rows[0].reason, 'run-log-unreadable')
  assert.equal(f.output.counts.unknown, 1)
  assert.equal(f.output.counts.running, 1)
})

test('a done commit with no containing branch is unknown, not pending', () => {
  const sha = 'branch-gone-commit'
  const f = pendingUnit({
    specs: [{ name: 'gone-lane', text: `${JSON.stringify({ status: 'done', commit: sha })}\n` }],
    branches: { [sha]: null },
    messages: { [sha]: 'feat: gone work\n\nRefs: #444' },
  })
  assert.equal(f.output.rows.length, 1)
  assert.equal(f.output.rows[0].state, 'unknown')
  assert.equal(f.output.rows[0].reason, 'branch-gone')
  assert.equal(f.output.rows[0].branch, 'unknown')
})

test('an empty crew root prints an explicit empty result and exits 0', async () => {
  const root = scratchDir('factoryctl-empty-')
  const repo = scratchDir('factoryctl-empty-repo-')
  let stdout = ''
  let stderr = ''
  const code = await main(['pending', '--crew-root', root, '--repo', repo], {
    lanes: () => [],
    spawnSync: () => ({ status: 1, stdout: '', stderr: '' }),
    stdout: (text) => { stdout += text },
    stderr: (text) => { stderr += text },
  })
  assert.equal(code, 0)
  assert.match(stdout, /no lanes are pending publication/)
  assert.match(stdout, /pending: 0 .* scanned: 0/)
  assert.equal(stderr, '')
})

test('pending uses only read-only git and gh calls and changes no crew files', () => {
  const root = scratchDir('factoryctl-readonly-')
  const laneRoot = join(root, 'crew')
  const repo = join(root, 'repo')
  mkdirSync(laneRoot, { recursive: true }); mkdirSync(repo, { recursive: true })
  const sha = 'readonly-commit'
  const lane = pendingLane(laneRoot, 'readonly-lane', `${JSON.stringify({ status: 'done', commit: sha })}\n`)
  const d = pendingSpawn({ branches: { [sha]: 'readonly-lane' } })
  const before = treeSnapshot(root)
  pendingVerb({ _: ['pending'], 'crew-root': root, repo, json: true }, {
    lanes: () => [lane],
    readFileSync: (...args) => readFileSync(...args),
    statSync: (...args) => statSync(...args),
    spawnSync: d.spawnSync,
    stdout: () => {},
  })
  const after = treeSnapshot(root)
  assert.deepEqual(after, before)
  const forbidden = new Set(['push', 'fetch', 'pr', 'create', 'commit', 'update-ref', 'checkout', 'branch'])
  const tokens = d.calls.flatMap(({ command, argv }) => [command, ...argv].map(String))
  for (const token of ['push', 'fetch', 'commit', 'update-ref', 'checkout', 'branch']) assert.equal(tokens.includes(token), false, `unexpected ${token} call`)
  assert.equal(tokens.includes('create'), false)
  assert.equal(d.calls.some(({ command, argv }) => command === 'gh' && argv.includes('pr') && argv.includes('create')), false)
  assert.equal([...forbidden].includes('pr') && d.calls.some(({ command }) => command === 'gh'), true)
})

test('main routes pending without connecting to a daemon', async () => {
  const root = scratchDir('factoryctl-no-daemon-')
  const d = pendingSpawn()
  let touched = false
  const code = await main(['pending', '--crew-root', root, '--repo', root], {
    env: { CREW_DAEMON_ROOT: join(root, 'nobody-listens') },
    lanes: () => [],
    spawnSync: d.spawnSync,
    net: { connect: () => { touched = true; throw new Error('daemon should not be touched') } },
    stdout: () => {},
    stderr: () => {},
  })
  assert.equal(code, 0)
  assert.equal(touched, false)
})
