import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { daemon } from './daemon.mjs'
import {
  attachVerb, commitIssues, completionLogPath, connect, ESCALATION_BOUND_MS, formatRows, main,
  parseArgs, pendingVerb, readCompletionLog, runVerb, terminalRunLine, waitingVerb,
} from './factoryctl.mjs'
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

function pendingUnit({ specs, branches = {}, merged = new Set(), remoteBranches = new Set(), messages = {}, gh = {}, completionLog = null } = {}) {
  const root = scratchDir('factoryctl-pending-')
  const laneRoot = join(root, 'lanes')
  const repo = join(root, 'repo')
  mkdirSync(laneRoot, { recursive: true }); mkdirSync(repo, { recursive: true })
  const lanes = (specs || []).map((spec) => pendingLane(laneRoot, spec.name, spec.text, spec.options))
  if (completionLog !== null) writeFileSync(completionLogPath({ root, env: {} }), completionLog)
  const d = pendingSpawn({ branches, merged, remoteBranches, messages, gh })
  const run = () => {
    let stdout = ''
    const result = pendingVerb({ _: ['pending'], json: true, 'crew-root': root, repo }, {
      lanes: () => lanes,
      readFileSync: (...args) => readFileSync(...args),
      statSync: () => ({ mtime: new Date('2026-08-26T00:00:00.000Z') }),
      spawnSync: d.spawnSync,
      stdout: (text) => { stdout += text },
      cwd: () => repo,
      env: {},
    })
    return { result, output: JSON.parse(stdout) }
  }
  const first = run()
  return { root, laneRoot, repo, lanes, result: first.result, output: first.output, run, calls: d.calls }
}

function completionLine({ lane, outcome = 'done', commit = null, at = '2026-08-26T00:00:00.000Z' }) {
  return `${JSON.stringify({ at, lane, run: null, outcome, commit, checkout: '/fixture/checkout', crew_dir: '/fixture/crew', archived: null, task_return: '/fixture/returns/task.json' })}\n`
}

function withoutSource(rows) {
  return rows.map(({ source, ...row }) => row)
}

function pendingRowsFixture() {
  return {
    specs: [
      { name: 'reused-lane', text: `${JSON.stringify({ status: 'done', commit: 'stalecommit' })}\n` },
      { name: 'plain-lane', text: `${JSON.stringify({ status: 'done', commit: 'plaincommit' })}\n` },
    ],
    branches: { stalecommit: 'reused-lane', plaincommit: 'plain-lane' },
  }
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
    assert.ok(result.stderr.includes('usage: factoryctl <run|ls|attach|send|pending|waiting>'), result.stderr)
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
    completionLog: completionLine({ lane: 'escalated-lane', commit: sha, outcome: 'escalation' }),
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

test('the completion log lists a run whose crew directory is gone', () => {
  const sha = 'gone-completion'
  const f = pendingUnit({
    specs: [],
    branches: { [sha]: 'vanished-lane' },
    completionLog: completionLine({ lane: 'vanished-lane', commit: sha }),
  })
  assert.equal(f.output.rows.length, 1)
  assert.deepEqual(f.output.rows[0], {
    lane: 'vanished-lane', commit: sha, branch: 'vanished-lane', issue: 'unknown',
    done_at: '2026-08-26T00:00:00.000Z', remote: 'no', pr: 'none', state: 'pending', reason: null,
    source: 'completion-log',
  })
})

test('the completion log keeps a reused lane completion under its own commit', () => {
  const f = pendingUnit({
    specs: [{ name: 'reused-lane', text: `${JSON.stringify({ status: 'done', commit: 'later-commit' })}\n` }],
    branches: { 'later-commit': 'reused-lane', 'earlier-commit': 'reused-lane' },
    completionLog: completionLine({ lane: 'reused-lane', commit: 'earlier-commit' }),
  })
  const row = f.output.rows.find((candidate) => candidate.commit === 'earlier-commit')
  assert.ok(row)
  assert.equal(row.lane, 'reused-lane')
  assert.equal(row.source, 'completion-log')
  assert.equal(f.output.rows.filter((candidate) => candidate.lane === 'reused-lane').length, 2)
})

test('a completion record agreeing with run.log produces one row and confirms both sources', () => {
  const sha = 'agreed-completion'
  const f = pendingUnit({
    specs: [{ name: 'agreed-lane', text: `${JSON.stringify({ status: 'done', commit: sha })}\n` }],
    branches: { [sha]: 'agreed-lane' },
    completionLog: completionLine({ lane: 'agreed-lane', commit: sha }),
  })
  assert.equal(f.output.rows.length, 1)
  assert.equal(f.output.rows[0].source, 'both')
  assert.equal(f.output.counts.completion_confirmed, 1)
})

test('deleting the completion log changes reach but not the crew-dir rows or scan counters', () => {
  const fixture = pendingRowsFixture()
  const completion = completionLine({ lane: 'reused-lane', commit: 'owncommit' })
    + completionLine({ lane: 'vanished-lane', commit: 'gonecommit' })
  const f = pendingUnit({ ...fixture, branches: { ...fixture.branches, owncommit: 'reused-lane', gonecommit: 'vanished-lane' }, completionLog: completion })
  const present = f.output
  rmSync(completionLogPath({ root: f.root, env: {} }), { force: true })
  const absent = f.run().output
  assert.equal(absent.counts.completion_log, 'absent')
  for (const key of ['completion_records', 'completion_added', 'completion_confirmed', 'completion_malformed']) assert.equal(absent.counts[key], 0)
  assert.deepEqual(withoutSource(absent.rows), [
    {
      lane: 'plain-lane', commit: 'plaincommit', branch: 'plain-lane', issue: 'unknown',
      done_at: '2026-08-26T00:00:00.000Z', remote: 'no', pr: 'none', state: 'pending', reason: null,
    },
    {
      lane: 'reused-lane', commit: 'stalecommit', branch: 'reused-lane', issue: 'unknown',
      done_at: '2026-08-26T00:00:00.000Z', remote: 'no', pr: 'none', state: 'pending', reason: null,
    },
  ])
  assert.ok(present.rows.length > absent.rows.length)
  for (const row of absent.rows) assert.equal(row.source, 'run.log')
  for (const key of ['scanned', 'running', 'not_done', 'no_run_log', 'published']) assert.equal(present.counts[key], absent.counts[key])
})

test('completion log absences and malformed lines are typed and counted', () => {
  const completion = 'not json\n'
    + completionLine({ lane: 'kept-lane', commit: 'kept-completion' })
    + '{"lane":"truncated\n'
  const f = pendingUnit({
    specs: [], branches: { 'kept-completion': 'kept-lane' }, completionLog: completion,
  })
  assert.equal(f.output.counts.completion_log, 'ok')
  assert.equal(f.output.counts.completion_malformed, 2)
  assert.equal(f.output.rows.some((row) => row.lane === 'kept-lane' && row.commit === 'kept-completion'), true)
  const unreadable = readCompletionLog('/missing/completions.jsonl', {
    readFileSync: () => { const error = new Error('permission denied'); error.code = 'EACCES'; throw error },
  })
  assert.deepEqual(unreadable, { state: 'unknown', records: [], malformed: 0 })
  const absent = readCompletionLog('/missing/completions.jsonl', {
    readFileSync: () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error },
  })
  assert.deepEqual(absent, { state: 'absent', records: [], malformed: 0 })
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
  writeFileSync(completionLogPath({ root, env: {} }), completionLine({ lane: 'gone-readonly-lane', commit: 'gone-readonly-commit' }))
  const d = pendingSpawn({ branches: { [sha]: 'readonly-lane', 'gone-readonly-commit': 'gone-readonly-lane' } })
  const before = treeSnapshot(root)
  pendingVerb({ _: ['pending'], 'crew-root': root, repo, json: true }, {
    lanes: () => [lane],
    readFileSync: (...args) => readFileSync(...args),
    statSync: (...args) => statSync(...args),
    spawnSync: d.spawnSync,
    stdout: () => {},
    env: {},
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

const WAITING_AT = '2026-08-24T00:00:00.000Z'
const WAITING_HOUR = 60 * 60 * 1000

function waitingRecord(over = {}) {
  return {
    at: WAITING_AT, lane: 'waiting-lane', run: 'waiting-run', outcome: 'escalation', commit: null,
    checkout: '/fixture/checkout', crew_dir: '/fixture/crew', archived: null,
    task_return: '/fixture/returns/task.json', ...over,
  }
}

function writeWaitingLog(root, textOrRecords) {
  const text = Array.isArray(textOrRecords) ? `${textOrRecords.map((record) => JSON.stringify(record)).join('\n')}\n` : textOrRecords
  writeFileSync(completionLogPath({ root, env: {} }), text)
}

function runWaiting(root, args = {}, deps = {}) {
  let stdout = ''
  const result = waitingVerb({ _: ['waiting'], json: true, 'crew-root': root, ...args }, {
    readFileSync: (...args) => readFileSync(...args),
    now: () => Date.parse(WAITING_AT) + WAITING_HOUR,
    spawnSync: () => ({ status: 0, stdout: '', stderr: '' }),
    teardown: () => ({ ok: true, archived: null, reason: null }),
    stdout: (text) => { stdout += text },
    env: {},
    ...deps,
  })
  return { result, stdout, output: args.json === false ? null : JSON.parse(stdout) }
}

test('waiting lists an escalated lane whose crew directory is gone', () => {
  // Pins completion-log reach even when the live crew directory and task return are absent.
  const root = scratchDir('factoryctl-waiting-gone-')
  const record = waitingRecord({
    lane: 'gone-human', run: 'run-gone-human',
    crew_dir: join(root, 'gone-crew'), task_return: join(root, 'gone-crew', 'returns', 'task.json'),
  })
  writeWaitingLog(root, [record])
  const { output } = runWaiting(root)
  assert.equal(output.rows.length, 1)
  assert.equal(output.rows[0].workspace_present, false)
  assert.equal(output.rows[0].where, 'unknown')
  assert.equal(output.rows[0].reason, 'task-return-unreadable')
})

test('waiting reads escalation detail, run id and time from the completion record run', () => {
  // Pins the row to its own durable task return rather than a reused lane's current state.
  const root = scratchDir('factoryctl-waiting-detail-')
  const crewDir = join(root, 'crew')
  const taskReturn = join(crewDir, 'returns', 'task.json')
  const checkout = join(root, 'checkout')
  mkdirSync(join(crewDir, 'returns'), { recursive: true })
  mkdirSync(checkout, { recursive: true })
  writeFileSync(taskReturn, JSON.stringify({ details: { escalation: { where: 'gate', why: 'gate output is red' } } }))
  writeWaitingLog(root, [waitingRecord({
    lane: 'detail-lane', run: 'run-detail', crew_dir: crewDir, checkout, task_return: taskReturn,
  })])
  const { output } = runWaiting(root, {}, { now: () => Date.parse(WAITING_AT) + 1.5 * WAITING_HOUR })
  assert.deepEqual(output.rows[0], {
    run: 'run-detail', lane: 'detail-lane', where: 'gate', why: 'gate output is red',
    escalated_at: WAITING_AT, age_h: 1.5, workspace: crewDir, workspace_present: true,
    checkout, state: 'waiting', resolutions: ['repair', 'plan-rounds', 'park'], reason: null,
    preserved: null, archived: null, action: null, source: 'completion-log',
  })
})

test('47h is waiting and 49h is expired with a faked clock', () => {
  // Pins the injectable read-time bound and its strict greater-than comparison.
  const root = scratchDir('factoryctl-waiting-bound-')
  const crewDir = join(root, 'crew')
  const taskReturn = join(crewDir, 'returns', 'task.json')
  mkdirSync(join(crewDir, 'returns'), { recursive: true })
  writeFileSync(taskReturn, JSON.stringify({ details: { escalation: { where: 'scope', why: 'fence crossed' } } }))
  writeWaitingLog(root, [waitingRecord({ crew_dir: crewDir, task_return: taskReturn })])
  const at = Date.parse(WAITING_AT)
  assert.equal(ESCALATION_BOUND_MS, 48 * WAITING_HOUR)
  assert.equal(runWaiting(root, {}, { now: () => at + 47 * WAITING_HOUR }).output.rows[0].state, 'waiting')
  assert.equal(runWaiting(root, {}, { now: () => at + 49 * WAITING_HOUR }).output.rows[0].state, 'expired')
})

test('the default waiting invocation mutates nothing', () => {
  // Pins the safe-by-construction default: no preservation or teardown without an action flag.
  const root = scratchDir('factoryctl-waiting-default-')
  const crewDir = join(root, 'crew')
  const taskReturn = join(crewDir, 'returns', 'task.json')
  mkdirSync(join(crewDir, 'returns'), { recursive: true })
  writeFileSync(taskReturn, JSON.stringify({ details: { escalation: { where: 'scope', why: 'old escalation' } } }))
  writeWaitingLog(root, [waitingRecord({ crew_dir: crewDir, task_return: taskReturn })])
  const before = treeSnapshot(root)
  const calls = []
  const teardowns = []
  const { output } = runWaiting(root, {}, {
    now: () => Date.parse(WAITING_AT) + 400 * WAITING_HOUR,
    spawnSync: (...args) => { calls.push(args); return { status: 0, stdout: '', stderr: '' } },
    teardown: (info) => { teardowns.push(info); return { ok: true, archived: null, reason: null } },
  })
  assert.equal(output.rows[0].state, 'expired')
  assert.deepEqual(treeSnapshot(root), before)
  assert.equal(teardowns.length, 0)
  const tokens = calls.flatMap(([, argv]) => argv.map(String))
  for (const token of ['commit', 'add', 'push', 'checkout', 'branch']) assert.equal(tokens.includes(token), false)
})

test('--dry-run wins over --expire in either order', () => {
  // Pins explicit dry-run precedence regardless of command-line flag order.
  for (const args of [{ 'dry-run': true, expire: true }, { expire: true, 'dry-run': true }]) {
    const root = scratchDir('factoryctl-waiting-dry-run-')
    const crewDir = join(root, 'crew')
    const taskReturn = join(crewDir, 'returns', 'task.json')
    mkdirSync(join(crewDir, 'returns'), { recursive: true })
    writeFileSync(taskReturn, JSON.stringify({ details: { escalation: { where: 'scope', why: 'old escalation' } } }))
    const record = waitingRecord({ crew_dir: crewDir, task_return: taskReturn })
    writeWaitingLog(root, [record])
    const before = treeSnapshot(root)
    const calls = []
    const teardowns = []
    const { output } = runWaiting(root, args, {
      now: () => Date.parse(WAITING_AT) + 400 * WAITING_HOUR,
      spawnSync: (...call) => { calls.push(call); return { status: 0, stdout: '', stderr: '' } },
      teardown: (info) => { teardowns.push(info); return { ok: true, archived: null, reason: null } },
    })
    assert.equal(output.counts.dry_run, true)
    assert.equal(output.rows[0].state, 'expired')
    assert.equal(teardowns.length, 0)
    assert.deepEqual(treeSnapshot(root), before)
    assert.equal(calls.some(([, argv]) => argv.includes('commit')), false)
  }
})

test('--expire preserves before teardown and carries the verified ref', () => {
  // Pins git cat-file verification and preservation ordering before teardown.
  const root = scratchDir('factoryctl-waiting-expire-')
  const crewDir = join(root, 'crew')
  const taskReturn = join(crewDir, 'returns', 'task.json')
  mkdirSync(join(crewDir, 'returns'), { recursive: true })
  writeFileSync(taskReturn, JSON.stringify({ details: { escalation: { where: 'scope', why: 'old escalation' } } }))
  const record = waitingRecord({ checkout: join(root, 'checkout'), crew_dir: crewDir, task_return: taskReturn })
  writeWaitingLog(root, [record])
  const events = []
  const spawnSync = (command, argv, options) => {
    events.push({ kind: 'git', command, argv: [...argv], options })
    const args = argv.slice(2)
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'preserved-sha\n', stderr: '' }
    return { status: 0, stdout: '', stderr: '' }
  }
  const teardown = (info) => {
    events.push({ kind: 'teardown', info })
    return { ok: true, archived: join(root, 'archive'), reason: null }
  }
  const { output } = runWaiting(root, { expire: true }, {
    now: () => Date.parse(WAITING_AT) + 400 * WAITING_HOUR, spawnSync, teardown,
  })
  const row = output.rows[0]
  const verifyIndex = events.findIndex((event) => event.kind === 'git' && event.argv.slice(2)[0] === 'cat-file')
  const teardownIndex = events.findIndex((event) => event.kind === 'teardown')
  assert.ok(verifyIndex >= 0)
  assert.ok(verifyIndex < teardownIndex)
  assert.equal(events[teardownIndex].info.preserved, 'preserved-sha')
  assert.equal(row.preserved, 'preserved-sha')
  assert.equal(row.state, 'expired')
})

test('--expire refuses teardown when preservation add fails', () => {
  // Pins the preservation failure guard so an expired workspace is never torn down without a ref.
  const root = scratchDir('factoryctl-waiting-preserve-fail-')
  const crewDir = join(root, 'crew')
  const taskReturn = join(crewDir, 'returns', 'task.json')
  mkdirSync(join(crewDir, 'returns'), { recursive: true })
  writeFileSync(taskReturn, JSON.stringify({ details: { escalation: { where: 'scope', why: 'old escalation' } } }))
  writeWaitingLog(root, [waitingRecord({ crew_dir: crewDir, task_return: taskReturn })])
  const calls = []
  const teardowns = []
  const spawnSync = (command, argv) => {
    calls.push({ command, argv: [...argv] })
    if (argv.slice(2)[0] === 'add') return { status: 1, stdout: '', stderr: 'permission denied' }
    return { status: 0, stdout: '', stderr: '' }
  }
  const { output } = runWaiting(root, { expire: true }, {
    now: () => Date.parse(WAITING_AT) + 400 * WAITING_HOUR,
    spawnSync, teardown: (info) => { teardowns.push(info); return { ok: true, archived: null, reason: null } },
  })
  assert.equal(teardowns.length, 0)
  assert.equal(output.rows[0].reason, 'preserve-add-failed')
  assert.equal(output.rows[0].preserved, null)
  assert.equal(calls.some(({ argv }) => argv.includes('commit')), false)
})

test('--expire refuses teardown when preservation commit fails', () => {
  // Pins a failed commit as a preservation failure, never as a clean no-op with a stale ref.
  const root = scratchDir('factoryctl-waiting-commit-fail-')
  const checkout = join(root, 'checkout')
  const crewDir = join(root, 'crew')
  const taskReturn = join(crewDir, 'returns', 'task.json')
  mkdirSync(checkout, { recursive: true })
  mkdirSync(join(crewDir, 'returns'), { recursive: true })
  writeFileSync(taskReturn, JSON.stringify({ details: { escalation: { where: 'scope', why: 'old escalation' } } }))
  writeWaitingLog(root, [waitingRecord({ checkout, crew_dir: crewDir, task_return: taskReturn })])
  const calls = []
  const teardowns = []
  const spawnSync = (command, argv) => {
    calls.push({ command, argv: [...argv] })
    const args = argv.slice(2)
    if (args[0] === 'add') return { status: 0, stdout: '', stderr: '' }
    if (args[0] === 'diff') return { status: 1, stdout: '', stderr: '' }
    if (args[0] === 'commit') return { status: 1, stdout: '', stderr: 'signing failed' }
    return { status: 0, stdout: 'stale-head\\n', stderr: '' }
  }
  const { output } = runWaiting(root, { expire: true }, {
    now: () => Date.parse(WAITING_AT) + 400 * WAITING_HOUR,
    spawnSync, teardown: (info) => { teardowns.push(info); return { ok: true, archived: null, reason: null } },
  })
  assert.equal(output.rows[0].reason, 'preserve-commit-failed')
  assert.equal(output.rows[0].preserved, null)
  assert.equal(output.rows[0].action, null)
  assert.equal(teardowns.length, 0)
  assert.equal(calls.some(({ argv }) => argv.includes('commit')), true)
  assert.equal(calls.some(({ argv }) => argv.includes('rev-parse')), false)
})

test('--expire refuses absent, empty, and relative checkout paths', () => {
  // Pins expiry as non-actionable unless the recorded checkout is an absolute path.
  for (const checkout of [undefined, '', 'relative-checkout']) {
    const root = scratchDir('factoryctl-waiting-checkout-')
    const crewDir = join(root, 'crew')
    const taskReturn = join(crewDir, 'returns', 'task.json')
    mkdirSync(join(crewDir, 'returns'), { recursive: true })
    writeFileSync(taskReturn, JSON.stringify({ details: { escalation: { where: 'scope', why: 'old escalation' } } }))
    writeWaitingLog(root, [waitingRecord({ lane: `bad-checkout-${String(checkout)}`, checkout, crew_dir: crewDir, task_return: taskReturn })])
    const before = treeSnapshot(root)
    const calls = []
    const teardowns = []
    const { output } = runWaiting(root, { expire: true }, {
      now: () => Date.parse(WAITING_AT) + 400 * WAITING_HOUR,
      spawnSync: (...call) => { calls.push(call); return { status: 0, stdout: '', stderr: '' } },
      teardown: (info) => { teardowns.push(info); return { ok: true, archived: null, reason: null } },
    })
    assert.equal(output.rows[0].state, 'expired')
    assert.equal(output.rows[0].reason, 'checkout-unusable')
    assert.equal(output.rows[0].action, null)
    assert.equal(output.rows[0].preserved, null)
    assert.equal(calls.length, 0)
    assert.equal(teardowns.length, 0)
    assert.deepEqual(treeSnapshot(root), before)
  }
})

test('--resolve tears down and archives only the named lane', () => {
  // Pins explicit lane resolution and leaves every other escalation untouched.
  const root = scratchDir('factoryctl-waiting-resolve-')
  const first = waitingRecord({ lane: 'resolve-me', run: 'run-resolve' })
  const second = waitingRecord({ lane: 'leave-me', run: 'run-leave' })
  writeWaitingLog(root, [first, second])
  const teardowns = []
  const { output } = runWaiting(root, { resolve: 'resolve-me' }, {
    teardown: (info) => { teardowns.push(info); return { ok: true, archived: `${info.lane}.archive`, reason: null } },
  })
  assert.equal(teardowns.length, 1)
  assert.equal(teardowns[0].lane, 'resolve-me')
  const resolved = output.rows.find((row) => row.lane === 'resolve-me')
  const untouched = output.rows.find((row) => row.lane === 'leave-me')
  assert.equal(resolved.action, 'resolved')
  assert.equal(resolved.archived, 'resolve-me.archive')
  assert.equal(output.counts.resolved, 1)
  assert.equal(untouched.action, null)
})

test('--resolve with no value refuses before reading the completion log', async () => {
  // Pins parseArgs boolean handling as a usage error before any file or daemon access.
  const root = scratchDir('factoryctl-waiting-resolve-arg-')
  let read = false
  let stderr = ''
  const code = await main(['waiting', '--resolve', '--crew-root', root], {
    readFileSync: () => { read = true; throw new Error('must not read') },
    stdout: () => {}, stderr: (text) => { stderr += text }, env: {},
  })
  assert.equal(code, 1)
  assert.match(stderr, /waiting --resolve requires <lane>/)
  assert.equal(read, false)
})

test('waiting filters completion records to escalations in both directions', () => {
  // Pins waiting as the escalation queue, excluding done records reserved for pending.
  const root = scratchDir('factoryctl-waiting-outcomes-')
  writeWaitingLog(root, [
    waitingRecord({ lane: 'done-lane', run: 'run-done', outcome: 'done' }),
    waitingRecord({ lane: 'escalated-lane', run: 'run-escalated' }),
  ])
  const { output } = runWaiting(root)
  assert.equal(output.rows.length, 1)
  assert.equal(output.rows[0].lane, 'escalated-lane')
  assert.equal(output.counts.escalations, 1)
})

test('an unreadable completion log is unknown, never an empty queue', () => {
  // Pins an I/O failure as a typed unknown result rather than a false empty result.
  const root = scratchDir('factoryctl-waiting-unreadable-')
  let stdout = ''
  const result = waitingVerb({ _: ['waiting'], json: true, 'crew-root': root }, {
    readFileSync: () => { const error = new Error('I/O failure'); error.code = 'EIO'; throw error },
    spawnSync: () => ({ status: 0, stdout: '', stderr: '' }),
    now: () => Date.parse(WAITING_AT), teardown: () => ({ ok: true, archived: null, reason: null }),
    stdout: (text) => { stdout += text }, env: {},
  })
  const output = JSON.parse(stdout)
  assert.equal(result.counts.log, 'unknown')
  assert.equal(output.rows.length, 1)
  assert.equal(output.rows[0].state, 'unknown')
  assert.equal(output.rows[0].reason, 'completion-log-unreadable')
  assert.doesNotMatch(stdout, /no lane is waiting on a human/)
})

test('an absent completion log prints an explicit empty result and summary', () => {
  // Pins absent and unreadable logs as distinct operator-visible states.
  const root = scratchDir('factoryctl-waiting-empty-')
  const { result, stdout } = runWaiting(root, { json: false })
  assert.equal(result.counts.log, 'absent')
  assert.equal(result.rows.length, 0)
  assert.match(stdout, /no lane is waiting on a human — no escalation record in this crew root is unresolved/)
  assert.match(stdout, /waiting: 0 .* completion-log: absent/)
})

test('malformed completion lines are skipped and counted', () => {
  // Pins malformed-line accounting while retaining valid escalation records.
  const root = scratchDir('factoryctl-waiting-malformed-')
  const good = waitingRecord({ lane: 'good-lane' })
  writeWaitingLog(root, `${JSON.stringify(good)}\nnot json\n{"lane":"truncated\n`)
  const { output } = runWaiting(root)
  assert.equal(output.counts.malformed, 2)
  assert.equal(output.rows.length, 1)
  assert.equal(output.rows[0].lane, 'good-lane')
})

test('a task return without an escalation block is typed unknown', () => {
  // Pins a thin return envelope as a visible unknown row rather than silently dropping it.
  const root = scratchDir('factoryctl-waiting-thin-return-')
  const taskReturn = join(root, 'crew', 'returns', 'task.json')
  mkdirSync(join(root, 'crew', 'returns'), { recursive: true })
  writeFileSync(taskReturn, JSON.stringify({ status: 'escalation' }))
  writeWaitingLog(root, [waitingRecord({ crew_dir: join(root, 'crew'), task_return: taskReturn })])
  const { output } = runWaiting(root)
  assert.equal(output.rows[0].state, 'unknown')
  assert.equal(output.rows[0].reason, 'escalation-absent')
  assert.equal(output.rows[0].where, 'unknown')
})

test('waiting makes no gh or network call', () => {
  // Pins the daemon-free, network-free default path for the escalation queue.
  const root = scratchDir('factoryctl-waiting-no-network-')
  writeWaitingLog(root, [waitingRecord()])
  const calls = []
  let network = false
  runWaiting(root, {}, {
    spawnSync: (...call) => { calls.push(call); return { status: 0, stdout: '', stderr: '' } },
    net: { connect: () => { network = true; throw new Error('network should not be touched') } },
  })
  assert.equal(network, false)
  assert.equal(calls.some(([command]) => command === 'gh'), false)
})

test('main routes waiting without connecting to a daemon', async () => {
  // Pins waiting beside pending on the daemon-free route.
  const root = scratchDir('factoryctl-waiting-no-daemon-')
  let touched = false
  let stdout = ''
  const code = await main(['waiting', '--crew-root', root], {
    env: { CREW_DAEMON_ROOT: join(root, 'nobody-listens') },
    net: { connect: () => { touched = true; throw new Error('daemon should not be touched') } },
    stdout: (text) => { stdout += text }, stderr: () => {},
  })
  assert.equal(code, 0)
  assert.equal(touched, false)
  assert.match(stdout, /no lane is waiting on a human/)
})
