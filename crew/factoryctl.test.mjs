import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { daemon } from './daemon.mjs'
import { attachVerb, connect, formatRows, main, parseArgs } from './factoryctl.mjs'

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

test('factoryctl usage lists send', async () => {
  const f = fixture()
  try {
    const result = await invoke(f, ['wat'])
    assert.equal(result.code, 2)
    assert.match(result.stderr, /usage: factoryctl <run\\|ls\\|attach\\|send>/)
  } finally { f.cleanup() }
})
